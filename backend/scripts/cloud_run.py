"""Update the configured Cloud Run backend or check it without manual credentials."""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

from money_coach.repository import DuckDBRepository
from prepare_cloud_run import prepare_source

BACKEND = Path(__file__).resolve().parents[1]


class DeploymentError(RuntimeError):
    pass


def find_gcloud() -> str:
    candidate = shutil.which("gcloud.cmd" if os.name == "nt" else "gcloud")
    if candidate:
        return candidate
    # A fresh shell need not have the SDK on PATH. No PowerShell scripts are used.
    roots = [Path(os.environ.get("LOCALAPPDATA", "")), Path.home() / "AppData/Local"]
    roots += [Path(os.environ[n]) for n in ("ProgramFiles", "ProgramFiles(x86)") if n in os.environ]
    for root in roots:
        candidate = root / "Google/Cloud SDK/google-cloud-sdk/bin/gcloud.cmd"
        if candidate.is_file():
            return str(candidate)
    raise DeploymentError("Google Cloud CLI not found. Open Google Cloud SDK Shell and rerun this command.")


class Gcloud:
    def __init__(self, executable: str):
        self.executable = executable

    def run(self, args: list[str], *, stream=False) -> str:
        # In particular, never log describe responses (demo credentials) or identity tokens.
        result = subprocess.run([self.executable, *args], capture_output=not stream, text=True)
        if result.returncode:
            raise DeploymentError(
                f"Google Cloud command failed: {' '.join(args[:3])}. "
                "Check project access and run gcloud auth login if your login has expired. "
                "For deployment errors, see the build output above."
            )
        return "" if stream else result.stdout.strip()


def load_config(path: Path) -> dict:
    config = json.loads(path.read_text(encoding="utf-8"))
    for name in ("project", "region", "service", "build_account"):
        if not isinstance(config.get(name), str) or not re.fullmatch(r"[a-z][a-z0-9-]+", config[name]):
            raise DeploymentError(f"Missing or invalid {name} in {path.name}")
    if not isinstance(config.get("snapshot"), str) or not config["snapshot"]:
        raise DeploymentError("A snapshot path is required in the deployment config.")
    return config


def describe(cli: Gcloud, config: dict) -> dict:
    return json.loads(cli.run([
        "run", "services", "describe", config["service"],
        f"--project={config['project']}", f"--region={config['region']}", "--format=json",
    ]))


def runtime(service: dict) -> tuple[dict, dict]:
    containers = service["spec"]["template"]["spec"]["containers"]
    if len(containers) != 1:
        raise DeploymentError("This updater expects the existing single-container money-coach service.")
    entries = {entry["name"]: entry for entry in containers[0].get("env", [])}
    env = {name: entry["value"] for name, entry in entries.items() if "value" in entry}
    secret = entries.get("ANTHROPIC_API_KEY", {}).get("valueFrom", {}).get("secretKeyRef")
    if not secret or not secret.get("name") or not secret.get("key"):
        raise DeploymentError("The service needs its ANTHROPIC_API_KEY Secret Manager binding. See DEPLOYMENT.md for initial setup.")
    return env, secret


def demo_tokens(env: dict) -> dict:
    if env.get("DEMO_MODE", "").lower() != "true":
        raise DeploymentError("This synthetic-data deployment requires the existing demo authentication configuration.")
    try:
        tokens = json.loads(env.get("DEMO_TOKENS_JSON", "{}"))
    except json.JSONDecodeError:
        raise DeploymentError("The deployed demo authentication configuration is invalid.") from None
    if not isinstance(tokens, dict) or not tokens or any(
        not isinstance(token, str) or len(token) < 24 or not isinstance(customer, str) or not customer
        for token, customer in tokens.items()
    ):
        raise DeploymentError("The deployed demo authentication configuration is missing or invalid.")
    return tokens


def validate_snapshot(snapshot: Path, env: dict):
    if env.get("DUCKDB_PATH") != "/app/data/finance.duckdb":
        raise DeploymentError("The service's DUCKDB_PATH differs from the demo image path; deployment stopped.")
    repository = DuckDBRepository(snapshot)
    repository.check()
    for customer in set(demo_tokens(env).values()):
        if not repository.describe(customer)["transaction_count"]:
            raise DeploymentError("The new snapshot has no data for a configured demo customer; deployment stopped.")


def deploy_args(config: dict, source: Path, secret: dict, secret_version: str | None) -> list[str]:
    args = [
        "run", "deploy", config["service"],
        f"--project={config['project']}", f"--region={config['region']}", f"--source={source}",
        f"--build-service-account=projects/{config['project']}/serviceAccounts/{config['build_account']}@{config['project']}.iam.gserviceaccount.com",
        "--startup-probe=httpGet.path=/readyz,httpGet.port=8080,initialDelaySeconds=0,timeoutSeconds=5,periodSeconds=5,failureThreshold=24",
        "--liveness-probe=httpGet.path=/healthz,httpGet.port=8080,initialDelaySeconds=0,timeoutSeconds=2,periodSeconds=30,failureThreshold=3",
        "--quiet",
    ]
    # Omitting env/secrets/service-account flags preserves the working Cloud Run settings.
    if secret_version is not None:
        if not re.fullmatch(r"[1-9][0-9]*", secret_version):
            raise DeploymentError("Use a numeric Secret Manager version, for example --secret-version 2.")
        args.append(f"--update-secrets=ANTHROPIC_API_KEY={secret['name']}:{secret_version}")
    return args


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Authentication headers must never follow an unexpected redirect.
        return None


def api_request(url: str, identity: str, *, message: str | None = None, demo_token: str | None = None) -> dict:
    headers = {"X-Serverless-Authorization": f"Bearer {identity}"}
    data = None
    if message is not None:
        headers.update({"Authorization": f"Bearer {demo_token}", "Content-Type": "application/json"})
        data = json.dumps({"message": message}).encode("utf-8")
    request = Request(url, headers=headers, data=data)
    try:
        with build_opener(NoRedirects).open(request, timeout=180) as response:
            return json.load(response)
    except HTTPError as exc:
        hints = {
            401: "Check the deployed demo authentication configuration.",
            403: "Your Google account needs roles/run.invoker on this service.",
            422: "Check the message or model output limits.",
            429: "The demo request budget was reached; retry later.",
            502: "Check the Anthropic key's validity, expiry and API credits.",
            503: "Check the snapshot, model key binding and readiness configuration.",
        }
        raise DeploymentError(f"Backend returned HTTP {exc.code}. {hints.get(exc.code, 'Check Cloud Run logs.')}") from None
    except (URLError, TimeoutError):
        raise DeploymentError("Could not reach the backend. Check connectivity and Cloud Run status.") from None


def check_service(cli: Gcloud, service: dict, message: str | None = None):
    status = service["status"]
    if (status.get("latestCreatedRevisionName") != status.get("latestReadyRevisionName")
            or not any(c.get("type") == "Ready" and c.get("status") == "True" for c in status.get("conditions", []))):
        raise DeploymentError("The latest Cloud Run revision is not ready. Check its logs.")
    url = status.get("url", "")
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname or not parsed.hostname.endswith(".run.app") or parsed.username or parsed.port:
        raise DeploymentError("Expected an HTTPS Cloud Run service URL.")
    identity = cli.run(["auth", "print-identity-token"])
    if not identity:
        raise DeploymentError("No Google identity token returned. Run gcloud auth login.")
    if api_request(url + "/readyz", identity).get("status") != "ready":
        raise DeploymentError("Backend did not report ready.")
    print(f"Ready: {url}")
    print(f"Revision: {status['latestReadyRevisionName']}")
    if message is not None:
        env, _ = runtime(service)
        token = next(iter(demo_tokens(env)))
        result = api_request(url + "/v1/chat", identity, message=message, demo_token=token)
        if not isinstance(result.get("answer"), str) or not result["answer"].strip():
            raise DeploymentError("Chat returned no answer.")
        print(result["answer"])
        print("Usage:", json.dumps(result.get("usage", {})))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=BACKEND / "deploy/cloud-run.json")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="Only check the existing deployment; no model call")
    mode.add_argument("--chat", metavar="MESSAGE", help="Test the existing deployment with one billable chat; no deploy")
    mode.add_argument("--plan", action="store_true", help="Read configuration and validate the snapshot, without deploying")
    parser.add_argument("--secret-version", help="On deployment, explicitly rotate to this numeric secret version")
    args = parser.parse_args(argv)
    if args.secret_version and (args.check or args.chat is not None):
        parser.error("--secret-version is only used when deploying")
    if args.chat is not None and not 1 <= len(args.chat.strip()) <= 4000:
        parser.error("--chat requires a message between 1 and 4000 characters")
    try:
        config = load_config(args.config)
        cli = Gcloud(find_gcloud())
        service = describe(cli, config)
        env, secret = runtime(service)
        if not args.check and args.chat is None:
            snapshot = (BACKEND / config["snapshot"]).resolve()
            validate_snapshot(snapshot, env)
            # Validate rotation before building or mutating anything.
            deploy_args(config, BACKEND, secret, args.secret_version)
            print(f"Target: {config['project']} / {config['region']} / {config['service']}")
            print("Reusing deployed environment, demo tokens, runtime account and secret bindings.")
            if args.plan:
                print("Plan validated. No upload, deployment or model call performed.")
                return 0
            destination = prepare_source(BACKEND, snapshot)
            print("Building and deploying the latest source and validated synthetic snapshot...")
            cli.run(deploy_args(config, destination / "source", secret, args.secret_version), stream=True)
            service = describe(cli, config)
            updated_env, updated_secret = runtime(service)
            expected_secret = {**secret, "key": args.secret_version or secret["key"]}
            if updated_env != env or updated_secret != expected_secret:
                raise DeploymentError("Deployed settings changed unexpectedly. Inspect the revision before using it.")
        check_service(cli, service, args.chat)
        return 0
    except (DeploymentError, OSError, ValueError, KeyError) as exc:
        # Do not echo arbitrary cloud response bodies or authentication values.
        message = str(exc) if isinstance(exc, DeploymentError) else f"Local configuration or data check failed ({type(exc).__name__})."
        print(message, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
