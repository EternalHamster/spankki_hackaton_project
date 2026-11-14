#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z][a-z0-9-]{4,28}[a-z0-9]$')]
    [string]$ProjectId,
    [string]$ConfigPath,
    [switch]$Setup,
    [switch]$Public,
    [switch]$Plan
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $PSScriptRoot 'cloud-run.psd1'
}
$config = Import-PowerShellDataFile -LiteralPath $ConfigPath
$sourceRoot = Split-Path $PSScriptRoot -Parent
foreach ($key in @('Service', 'Region', 'RuntimeAccount', 'BuildAccount', 'Cpu', 'Memory', 'MinInstances', 'MaxInstances', 'Concurrency', 'TimeoutSeconds')) {
    if (-not $config.ContainsKey($key)) { throw "Missing deployment setting: $key" }
}
foreach ($key in @('Service', 'RuntimeAccount', 'BuildAccount')) {
    if ($config[$key] -notmatch '^[a-z][a-z0-9-]{4,28}[a-z0-9]$') { throw "Invalid deployment setting: $key" }
}
if ($config.MinInstances -lt 0 -or $config.MaxInstances -lt 1 -or $config.MinInstances -gt $config.MaxInstances) {
    throw 'Instance limits must satisfy 0 <= MinInstances <= MaxInstances, with MaxInstances >= 1'
}
if ($config.RuntimeAccount -eq $config.BuildAccount) { throw 'Use separate build and runtime service accounts' }
$runtimeEmail = "$($config.RuntimeAccount)@$ProjectId.iam.gserviceaccount.com"
$buildEmail = "$($config.BuildAccount)@$ProjectId.iam.gserviceaccount.com"

function Invoke-Gcloud {
    param([string[]]$Arguments)
    Write-Host ('gcloud ' + ($Arguments -join ' '))
    if ($Plan) { return }
    & gcloud @Arguments
    if ($LASTEXITCODE -ne 0) { throw "gcloud command failed (exit $LASTEXITCODE). See the error above and DEPLOYMENT.md." }
}

function Ensure-ServiceAccount {
    param([string]$AccountId, [string]$Email)
    if ($Plan) {
        Write-Host "# Create $Email only if it does not already exist."
    } else {
        $existing = Invoke-Gcloud -Arguments @('iam', 'service-accounts', 'list', "--project=$ProjectId", "--filter=email=$Email", '--format=value(email)')
        if ($existing) { return }
    }
    Invoke-Gcloud -Arguments @('iam', 'service-accounts', 'create', $AccountId, "--project=$ProjectId", '--quiet')
}

function Grant-BuildRole {
    $arguments = @('projects', 'add-iam-policy-binding', $ProjectId, "--member=serviceAccount:$buildEmail", '--role=roles/run.builder', '--condition=None', '--quiet', '--format=none')
    if ($Plan) {
        Invoke-Gcloud -Arguments $arguments
        return
    }
    # Newly created accounts can take over a minute to become visible to project IAM.
    for ($attempt = 0; $attempt -lt 7; $attempt++) {
        Write-Host ('gcloud ' + ($arguments -join ' '))
        $previousPreference = $ErrorActionPreference
        try {
            # Windows PowerShell 5.1 treats redirected native stderr as ErrorRecords.
            $ErrorActionPreference = 'Continue'
            $output = & gcloud @arguments 2>&1
            $exitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousPreference
        }
        $output | ForEach-Object { Write-Host "$_" }
        if ($exitCode -eq 0) { return }
        $missingAccount = 'Service account ' + [regex]::Escape($buildEmail) + ' does not exist'
        if (($output -join "`n") -notmatch $missingAccount -or $attempt -eq 6) {
            throw "Build role grant failed (exit $exitCode). See the error above. Rerun with -Setup after resolving it."
        }
        $delaySeconds = [int][Math]::Min(32, [Math]::Pow(2, $attempt + 1))
        Write-Host "Waiting $delaySeconds seconds for the build account to propagate (attempt $($attempt + 1)/7)."
        Start-Sleep -Seconds $delaySeconds
    }
}

Push-Location -LiteralPath $sourceRoot
try {
    if ($Plan) {
        Write-Host 'node scripts/check.mjs'
    } else {
        if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 24 LTS to validate the package.' }
        if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) { throw 'Install the Google Cloud CLI and run gcloud init first.' }
        & node scripts/check.mjs
        if ($LASTEXITCODE -ne 0) { throw 'Local validation failed; deployment stopped.' }
    }

    if ($Setup) {
        Invoke-Gcloud -Arguments @('services', 'enable', 'run.googleapis.com', 'cloudbuild.googleapis.com', 'artifactregistry.googleapis.com', 'iam.googleapis.com', "--project=$ProjectId", '--quiet')
        Ensure-ServiceAccount -AccountId $config.RuntimeAccount -Email $runtimeEmail
        Ensure-ServiceAccount -AccountId $config.BuildAccount -Email $buildEmail
        Grant-BuildRole
        # The runtime account needs no project roles: this UI does not call cloud APIs.
    }

    $accessFlag = '--no-allow-unauthenticated'
    if ($Public) { $accessFlag = '--allow-unauthenticated' }
    $deployArguments = @(
        'run', 'deploy', $config.Service, '--source=.', "--project=$ProjectId", "--region=$($config.Region)",
        "--service-account=$runtimeEmail", "--build-service-account=projects/$ProjectId/serviceAccounts/$buildEmail",
        '--port=8080', "--cpu=$($config.Cpu)", "--memory=$($config.Memory)",
        "--min-instances=$($config.MinInstances)", "--max-instances=$($config.MaxInstances)",
        "--concurrency=$($config.Concurrency)", "--timeout=$($config.TimeoutSeconds)",
        '--set-env-vars=NODE_ENV=production,HOST=0.0.0.0', '--cpu-throttling', '--ingress=all',
        '--startup-probe=httpGet.path=/readyz,httpGet.port=8080,initialDelaySeconds=0,timeoutSeconds=2,periodSeconds=5,failureThreshold=6',
        '--liveness-probe=httpGet.path=/healthz,httpGet.port=8080,initialDelaySeconds=0,timeoutSeconds=2,periodSeconds=30,failureThreshold=3',
        '--invoker-iam-check', $accessFlag, '--quiet'
    )
    Invoke-Gcloud -Arguments $deployArguments
    Invoke-Gcloud -Arguments @('run', 'services', 'describe', $config.Service, "--project=$ProjectId", "--region=$($config.Region)", '--format=value(status.url)')
} finally {
    Pop-Location
}
