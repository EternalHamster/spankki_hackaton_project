# Cloud Run hosting + direct Anthropic API

The backend calls `https://api.anthropic.com` with `ANTHROPIC_API_KEY`.
Google Cloud hosts FastAPI and the synthetic DuckDB snapshot. Anthropic bills model usage against
the API key's workspace and its available credits. Google Cloud bills hosting/build/storage separately.
The webapp remains a separate deployment; this guide deploys the backend API only.

All commands below are for **Google Cloud SDK Shell on Windows (CMD syntax)**. Keep the same window
open throughout. These commands use `gcloud` as provided by that shell.

## Everyday updates: one command

Your initial deployment is now configured. For future code or synthetic snapshot updates, run:

```cmd
cd /d "C:\Users\nikik\Documents\hackathon_project\spankki_hackaton_project\backend"
deploy.cmd
```

This finds Python and the Google CLI, reads `deploy/cloud-run.json`, validates the snapshot for
the deployed demo customers, builds fresh source, deploys it and checks readiness. It preserves
the existing Cloud Run environment, demo tokens, runtime account and Secret Manager binding.
No shell variables, copied keys or manual authorization headers are needed. It adds HTTP startup
and liveness probes: `/readyz` checks the snapshot/configuration; `/healthz` checks process health.
Neither probe makes a billable Claude call.

Cloud Run keeps the configuration between restarts and injects the saved key on every startup.
You do not need to run the deploy command merely because an instance restarts or scales from zero.
The key stays in Secret Manager; the updater never fetches its value. Keep your Google CLI signed in;
if that login expires, run `gcloud auth login` once.

Useful commands, also usable from a fresh SDK Shell:

```cmd
deploy.cmd --check
deploy.cmd --chat "hi"
deploy.cmd --plan
```

`--check` only checks the deployed service and prints its URL. `--chat` automatically gets fresh
Google authentication and the current demo token, then sends one billable chat without deploying.
`--plan` reads cloud configuration and validates local data without uploading or changing anything.
These commands never print authentication tokens. The normal update does not run a paid model test.

If an Anthropic key expires or is revoked, create a replacement and add it as a new version of the
same Secret Manager secret. Activate that numeric version with `deploy.cmd --secret-version 2`
(replace `2` with the new version). Routine deployments preserve the currently selected version.

The commands below document initial setup and manual recovery. They do not need repeating for
ordinary updates. The one-command updater requires the existing single-container demo service.

## 1. Open the backend and verify Claude locally

```cmd
cd /d "C:\Users\nikik\Documents\hackathon_project\spankki_hackaton_project\backend"
set "PYTHON_EXE=C:\Users\nikik\Documents\hackathon_project\.venv\Scripts\python.exe"
set "PROJECT_ID=junctionhackathonspankki"
set "REGION=europe-north1"
set "SERVICE_NAME=money-coach"

"%PYTHON_EXE%" -m pip install -c constraints.txt -e ".[test]"
"%PYTHON_EXE%" -m money_coach.smoke
```

The smoke test uses `ANTHROPIC_API_KEY` if set; otherwise it prompts for the key without echoing or
saving it. Get the key from your [Anthropic Console](https://platform.claude.com/settings/keys)
in the workspace with your credits. Don't paste it into chat or frontend code.
The test sends exactly one `hi` request, allows at most 32 output tokens and has no tools, database,
system prompt or automatic retries. It prints the greeting and token usage. The hidden prompt only
authenticates this test; Cloud Run receives its key through Secret Manager in step 3.

If pasting into the hidden prompt fails, run `"%PYTHON_EXE%" -m money_coach.smoke --clipboard`.
Start the command first, then copy the full key from the Console, return to the terminal and press
Enter without pasting. The test reads the clipboard locally, without printing or saving the key.
The shortened key shown later in Console details is unusable; if you did not save the full key
at creation, create a new one. Incomplete or masked keys are rejected before any API request.

## 2. Set up Google Cloud hosting

Use an account with project administration permissions and a linked billing account.

```cmd
gcloud auth login
gcloud config set project %PROJECT_ID%
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com iam.googleapis.com

gcloud iam service-accounts create money-coach-runtime --display-name="Money Coach runtime"
gcloud iam service-accounts create money-coach-build --display-name="Money Coach build"

set "RUNTIME_SA=money-coach-runtime@%PROJECT_ID%.iam.gserviceaccount.com"
set "BUILD_SA=money-coach-build@%PROJECT_ID%.iam.gserviceaccount.com"

gcloud projects add-iam-policy-binding %PROJECT_ID% --member="serviceAccount:%BUILD_SA%" --role="roles/run.builder" --condition=None
```

If a service account already exists, reuse it. Stop on other errors. IAM changes may take several
minutes to propagate. No model activation, Google model quota or local ADC login is needed.

## 3. Put the API key in Secret Manager

Open [Secret Manager for this project](https://console.cloud.google.com/security/secret-manager?project=junctionhackathonspankki).
Create a secret named **money-coach-anthropic-key**. Paste the Anthropic API key as its value and
create it. If it already exists, add a version only when rotating the key. Note the numeric version.

Grant only the runtime account access to this specific secret:

```cmd
set "KEY_VERSION=1"
gcloud secrets add-iam-policy-binding money-coach-anthropic-key --project=%PROJECT_ID% --member="serviceAccount:%RUNTIME_SA%" --role="roles/secretmanager.secretAccessor" --condition=None
```

Replace `1` with the version you created if different. Cloud Run injects the value at startup;
the API key is not written into source code, deployment settings or the image. Numeric versions
make rotations explicit. See [Cloud Run secrets](https://docs.cloud.google.com/run/docs/configuring/services/secrets).

## 4. Prepare the synthetic demo snapshot

The normal Dockerfile excludes data. The following helper validates the selected snapshot/customer
and creates a separate demo build containing the snapshot, Python source and dependency files.
It generates a demo-customer token outside the uploaded source directory. It never reads the API key.
The prepared image also includes the `coach_context` modules, `BDA/engine/config.py`, and only the five
synthetic model-output CSVs required by `/v1/insights`. Raw source CSVs, BDA databases, plots, tests and
credentials are excluded. Keep the full repository available when preparing a deployment; missing
context files stop the build. The insights endpoint stays in dry-run mode by default and makes no model call.

```cmd
"%PYTHON_EXE%" scripts\prepare_cloud_run.py --demo-snapshot data\finance.duckdb --customer CUST00207
set /p DEPLOY_DIR=<.deploy\latest.txt
set /p DEMO_TOKEN=<"%DEPLOY_DIR%\demo-token.txt"
```

If the snapshot doesn't exist, import it first:

```cmd
"%PYTHON_EXE%" -m money_coach.ingest --source ..\Data\tx_junction_transactions.csv --mapping config\s-pankki.json --output data\finance.duckdb
```

Then rerun preparation. Existing snapshots are never overwritten. Prepared folders are gitignored
under `.deploy/`; their `runtime-env.yaml` and `demo-token.txt` are local demo credentials, not public assets.
Only use this image-packaging approach for the supplied synthetic data. A real integration should
supply a private versioned snapshot to local instance storage at startup.

## 5. Deploy or update the backend

```cmd
gcloud run deploy %SERVICE_NAME% ^
  --project=%PROJECT_ID% ^
  --region=%REGION% ^
  --source="%DEPLOY_DIR%\source" ^
  --build-service-account="projects/%PROJECT_ID%/serviceAccounts/%BUILD_SA%" ^
  --service-account=%RUNTIME_SA% ^
  --env-vars-file="%DEPLOY_DIR%\runtime-env.yaml" ^
  --set-secrets="ANTHROPIC_API_KEY=money-coach-anthropic-key:%KEY_VERSION%" ^
  --no-allow-unauthenticated ^
  --memory=1Gi ^
  --cpu=1 ^
  --concurrency=4 ^
  --min-instances=0 ^
  --max-instances=1 ^
  --timeout=180
```

Paste the whole block; `^` must be the last character on its line. Accept repository creation if
prompted. Google builds the image remotely. The generated environment replaces the old plain
environment variables on an existing service, and the API key comes from the secret binding.
Preparation creates a new demo token on each run: use that token after deploying the new revision.
If this service was previously public, also remove its existing `allUsers` invoker binding before
treating it as private; the flag above is not a substitute for auditing previous IAM grants.

## 6. Test the deployed API

```cmd
for /f "delims=" %A in ('gcloud config get-value account 2^>nul') do set "USER_EMAIL=%A"
gcloud run services add-iam-policy-binding %SERVICE_NAME% --project=%PROJECT_ID% --region=%REGION% --member="user:%USER_EMAIL%" --role="roles/run.invoker"

for /f "delims=" %U in ('gcloud run services describe %SERVICE_NAME% --project=%PROJECT_ID% --region=%REGION% --format="value(status.url)"') do set "SERVICE_URL=%U"
for /f "delims=" %T in ('gcloud auth print-identity-token') do set "ID_TOKEN=%T"

curl.exe -sS "%SERVICE_URL%/healthz" -H "X-Serverless-Authorization: Bearer %ID_TOKEN%"
curl.exe -sS "%SERVICE_URL%/readyz" -H "X-Serverless-Authorization: Bearer %ID_TOKEN%"

curl.exe -sS "%SERVICE_URL%/v1/chat" ^
  -H "X-Serverless-Authorization: Bearer %ID_TOKEN%" ^
  -H "Authorization: Bearer %DEMO_TOKEN%" ^
  -H "Content-Type: application/json" ^
  --data "{\"message\":\"hi\"}"
```

Expect `ok`, `ready`, then JSON containing `answer` and `usage`. The deployed chat includes the coach
prompt/tools; step 1 is the smaller model-only test. Readiness checks local configuration and the
snapshot, not remote model access or available credit. Refresh `ID_TOKEN` when it expires.
The `for` commands are for the interactive SDK Shell; use double percent signs in a batch file.

To inspect a failed deployment/request:

```cmd
gcloud run services logs read %SERVICE_NAME% --project=%PROJECT_ID% --region=%REGION% --limit=50
```

## Replacing an earlier cloud-model deployment

Rebuild from the current source using step 4, then redeploy with step 5; do not reuse an old temporary
build folder. Provider-selection code and model-specific Google settings have been removed.
Cloud Run's service account now needs access to the Anthropic key secret, not model-inference roles.
Existing cloud IAM grants/APIs have not been modified by this code change. If the dedicated runtime
account was granted a model-inference role solely for the old backend, remove that obsolete grant
after verifying the new deployment. Do not remove shared project roles used by other services.

This demo remains private and uses synthetic customer authentication. Production user/session
verification and connecting the frontend chat button are separate integration tasks.
