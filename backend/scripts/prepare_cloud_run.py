"""Prepare a private synthetic-data demo build locally; does not deploy or call Claude."""
import argparse
import json
import secrets
import shutil
import tempfile
from pathlib import Path

from money_coach.client import DEFAULT_MODEL
from money_coach.repository import DuckDBRepository


# Only the synthetic model outputs used by the insights endpoint enter its image.
CONTEXT_FILES = (
    "coach_context/__init__.py", "coach_context/profile_card.py", "coach_context/insight_context.py",
    "BDA/engine/config.py", "BDA/output/customer_summary.csv", "BDA/output/customer_line.csv",
    "BDA/output/insights.csv", "BDA/output/spender_type.csv", "BDA/output/model_hyper.csv",
)


def prepare_source(backend: Path, snapshot: Path) -> Path:
    """Build only the upload directory; credentials/configuration stay in Cloud Run."""
    snapshot = snapshot.resolve()
    DuckDBRepository(snapshot).check()
    for name in CONTEXT_FILES:
        if not (backend.parent / name).is_file():
            raise ValueError(f"Required insight context file is missing: {name}. Update the full repository before deploying.")
    deployment_root = backend / ".deploy"
    deployment_root.mkdir(exist_ok=True)
    destination = Path(tempfile.mkdtemp(prefix="demo-", dir=deployment_root)).resolve()
    source = destination / "source"
    source.mkdir()
    for filename in ("pyproject.toml", "constraints.txt"):
        shutil.copyfile(backend / filename, source / filename)
    # Only application Python sources enter the build; no .env, tests, raw data or credentials.
    for module in (backend / "src").rglob("*.py"):
        target = source / module.relative_to(backend)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(module, target)
    for name in CONTEXT_FILES:
        target = source / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(backend.parent / name, target)
    (source / "data").mkdir()
    shutil.copyfile(snapshot, source / "data" / "finance.duckdb")
    docker = (backend / "Dockerfile").read_text(encoding="utf-8")
    docker += "\nCOPY --chown=coach:coach data/finance.duckdb /app/data/finance.duckdb\n"
    docker += "COPY --chown=coach:coach coach_context /app/coach_context\n"
    docker += "COPY --chown=coach:coach BDA /app/BDA\nENV PYTHONPATH=/app\n"
    (source / "Dockerfile").write_text(docker, encoding="utf-8")
    (source / ".gcloudignore").write_text("**/__pycache__/**\n", encoding="utf-8")
    return destination


def prepare(backend: Path, snapshot: Path, customer: str) -> Path:
    repository = DuckDBRepository(snapshot.resolve())
    repository.check()
    if not repository.describe(customer)["transaction_count"]:
        raise ValueError("Demo customer has no data in the selected snapshot")
    destination = prepare_source(backend, snapshot)
    token = secrets.token_urlsafe(32)
    environment = {
        "CLAUDE_MODEL": DEFAULT_MODEL,
        "DUCKDB_PATH": "/app/data/finance.duckdb",
        "DEMO_MODE": "true",
        "DEMO_TOKENS_JSON": json.dumps({token: customer}),
        "REQUESTS_PER_MINUTE": "5",
        "PROCESS_CHAT_LIMIT": "50",
    }
    # JSON is valid YAML for --env-vars-file. Both files stay outside the uploaded source.
    (destination / "runtime-env.yaml").write_text(json.dumps(environment, indent=2), encoding="utf-8")
    (destination / "demo-token.txt").write_text(token + "\n", encoding="utf-8")
    (backend / ".deploy" / "latest.txt").write_text(str(destination) + "\n", encoding="utf-8")
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--demo-snapshot", type=Path, required=True,
                        help="Synthetic snapshot to include in the private demo image")
    parser.add_argument("--customer", default="CUST00207")
    args = parser.parse_args()
    destination = prepare(Path(__file__).resolve().parents[1], args.demo_snapshot, args.customer)
    print(f"Prepared: {destination}")
    print("No deployment performed. Follow DEPLOYMENT.md to inject the API key from Secret Manager.")


if __name__ == "__main__":
    main()
