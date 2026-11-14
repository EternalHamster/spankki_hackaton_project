"""Deployment regression checks use fake cloud state; no credentials or network."""
import json
import sys
from pathlib import Path
from unittest.mock import Mock

import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
import cloud_run


@pytest.fixture
def cloud(monkeypatch, tmp_path):
    config = {"project": "example-project", "region": "europe-north1", "service": "money-coach",
              "build_account": "money-coach-build", "snapshot": "data/finance.duckdb"}
    (tmp_path / "deploy").mkdir()
    (tmp_path / "deploy/cloud-run.json").write_text(json.dumps(config))
    service = {
        "spec": {"template": {"spec": {"serviceAccountName": "runtime@example-project.iam.gserviceaccount.com", "containers": [{"env": [
            {"name": "ANTHROPIC_API_KEY", "valueFrom": {"secretKeyRef": {"name": "existing-key", "key": "3"}}},
            {"name": "DEMO_MODE", "value": "true"},
            {"name": "DEMO_TOKENS_JSON", "value": json.dumps({"secret-demo-token-do-not-print": "A"})},
            {"name": "DUCKDB_PATH", "value": "/app/data/finance.duckdb"},
            {"name": "CORS_ORIGINS", "value": "https://existing-ui.example"},
        ]}]}}},
        "status": {"url": "https://money-coach.example.run.app", "latestReadyRevisionName": "revision-1",
                   "latestCreatedRevisionName": "revision-1", "conditions": [{"type": "Ready", "status": "True"}]},
    }
    calls = []

    def run(args, *, stream=False):
        calls.append(args)
        if args[:3] == ["run", "services", "describe"]:
            return json.dumps(service)
        if args == ["auth", "print-identity-token"]:
            return "secret-identity-do-not-print"
        return ""

    cli = Mock()
    cli.run.side_effect = run
    monkeypatch.setattr(cloud_run, "Gcloud", lambda _: cli)
    monkeypatch.setattr(cloud_run, "find_gcloud", lambda: "gcloud")
    monkeypatch.setattr(cloud_run, "BACKEND", tmp_path)
    prepare = Mock(return_value=tmp_path / "prepared")
    validate = Mock()
    request = Mock(return_value={"status": "ready"})
    monkeypatch.setattr(cloud_run, "prepare_source", prepare)
    monkeypatch.setattr(cloud_run, "validate_snapshot", validate)
    monkeypatch.setattr(cloud_run, "api_request", request)
    return service, calls, cli, prepare, validate, request


def test_update_preserves_existing_configuration_and_does_not_call_model(cloud, capsys):
    service, calls, cli, prepare, validate, request = cloud
    assert cloud_run.main([]) == 0
    validate.assert_called_once()
    prepare.assert_called_once()
    deploy = next(call for call in calls if call[:2] == ["run", "deploy"])
    assert not any(arg.startswith(("--set-env", "--env-vars", "--update-env", "--set-secrets", "--update-secrets", "--service-account")) for arg in deploy)
    assert any(arg.startswith("--startup-probe=httpGet.path=/readyz") for arg in deploy)
    request.assert_called_once_with(service["status"]["url"] + "/readyz", "secret-identity-do-not-print")
    output = capsys.readouterr()
    assert "do-not-print" not in output.out + output.err


def test_check_works_without_local_snapshot_or_shell_tokens(cloud):
    service, calls, cli, prepare, validate, request = cloud
    assert cloud_run.main(["--check"]) == 0
    prepare.assert_not_called()
    validate.assert_not_called()
    assert ["auth", "print-identity-token"] in calls
    assert not any(call[:2] == ["run", "deploy"] for call in calls)


def test_chat_fetches_current_demo_and_google_tokens_without_deploy(cloud, capsys):
    service, calls, cli, prepare, validate, request = cloud
    request.side_effect = [{"status": "ready"}, {"answer": "Hi!", "usage": {"input_tokens": 10}}]
    assert cloud_run.main(["--chat", "hi"]) == 0
    request.assert_called_with(service["status"]["url"] + "/v1/chat", "secret-identity-do-not-print",
                               message="hi", demo_token="secret-demo-token-do-not-print")
    prepare.assert_not_called()
    assert not any(call[:2] == ["run", "deploy"] for call in calls)
    output = capsys.readouterr()
    assert "Hi!" in output.out and "do-not-print" not in output.out + output.err


def test_plan_is_read_only(cloud):
    service, calls, cli, prepare, validate, request = cloud
    assert cloud_run.main(["--plan"]) == 0
    validate.assert_called_once()
    prepare.assert_not_called()
    request.assert_not_called()
    assert len(calls) == 1 and calls[0][:3] == ["run", "services", "describe"]


@pytest.mark.parametrize("version", ["latest", "0", "2,OTHER=bad", "-1"])
def test_invalid_rotation_stops_before_upload(cloud, version):
    service, calls, cli, prepare, validate, request = cloud
    assert cloud_run.main([f"--secret-version={version}"]) == 1
    prepare.assert_not_called()
    request.assert_not_called()


def test_rotation_changes_only_requested_secret_reference(cloud):
    service, calls, cli, prepare, validate, request = cloud
    original_run = cli.run.side_effect

    def run(args, *, stream=False):
        result = original_run(args, stream=stream)
        if args[:2] == ["run", "deploy"]:
            assert "--update-secrets=ANTHROPIC_API_KEY=existing-key:4" in args
            service["spec"]["template"]["spec"]["containers"][0]["env"][0]["valueFrom"]["secretKeyRef"]["key"] = "4"
        return result

    cli.run.side_effect = run
    assert cloud_run.main(["--secret-version", "4"]) == 0


def test_failed_build_does_not_report_success(cloud, capsys):
    service, calls, cli, prepare, validate, request = cloud
    original_run = cli.run.side_effect

    def run(args, *, stream=False):
        if args[:2] == ["run", "deploy"]:
            raise cloud_run.DeploymentError("Build failed")
        return original_run(args, stream=stream)

    cli.run.side_effect = run
    assert cloud_run.main([]) == 1
    request.assert_not_called()
    assert "Build failed" in capsys.readouterr().err


def test_snapshot_failure_stops_before_build(cloud):
    service, calls, cli, prepare, validate, request = cloud
    validate.side_effect = cloud_run.DeploymentError("Missing data")
    assert cloud_run.main([]) == 1
    prepare.assert_not_called()
    assert not any(call[:2] == ["run", "deploy"] for call in calls)


def test_missing_secret_binding_stops_without_credentials_prompt(cloud):
    service, calls, cli, prepare, validate, request = cloud
    service["spec"]["template"]["spec"]["containers"][0]["env"].pop(0)
    assert cloud_run.main([]) == 1
    prepare.assert_not_called()
    request.assert_not_called()


def test_unready_revision_never_reports_old_service_as_success(cloud, capsys):
    service, calls, cli, prepare, validate, request = cloud
    service["status"]["latestCreatedRevisionName"] = "failed-revision"
    assert cloud_run.main(["--check"]) == 1
    request.assert_not_called()
    assert "not ready" in capsys.readouterr().err


def test_unexpected_environment_change_is_detected(cloud):
    service, calls, cli, prepare, validate, request = cloud
    original_run = cli.run.side_effect

    def run(args, *, stream=False):
        result = original_run(args, stream=stream)
        if args[:2] == ["run", "deploy"]:
            service["spec"]["template"]["spec"]["containers"][0]["env"].pop()
        return result

    cli.run.side_effect = run
    assert cloud_run.main([]) == 1
    request.assert_not_called()
