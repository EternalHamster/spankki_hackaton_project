import csv
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from decimal import Decimal
from pathlib import Path

import anthropic
import duckdb
import httpx2
import pytest
from fastapi.testclient import TestClient

from money_coach.agent import AgentLimitError, CoachAgent
from money_coach.api import Settings, create_app
from money_coach.ingest import Mapping, build_snapshot
from money_coach.repository import DuckDBRepository
from money_coach.tools import FinanceTools


@pytest.fixture
def mapping():
    return Mapping(customer_id="owner", date="booked", category="group", amount="amount",
                   amount_convention="negative_debits", expense_categories=["Food", "Rent"],
                   income_categories=["Salary"], baskets={"Rent": "regular_needs"})


@pytest.fixture
def source(tmp_path):
    path = tmp_path / "source.csv"
    with path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream)
        writer.writerow(["owner", "booked", "group", "amount"])
        writer.writerows([
            ["A", "2026-10-01", "Food", "-10.01"],
            ["A", "2026-10-05", "Food", "-20.04"],
            ["A", "2026-10-06", "Food", "5.00"],  # refund is excluded, not income
            ["A", "2026-10-08", "Rent", "-500.00"],
            ["A", "2026-10-09", "Invest Deposit", "-1000"],
            ["A", "2026-10-10", "Salary", "2000"],
            ["A", "2026-11-01", "Food", "-7"],
            ["B", "2026-10-01", "Food", "-999.00"],
        ])
    return path


@pytest.fixture
def repository(tmp_path, source, mapping):
    target = tmp_path / "snapshot.duckdb"
    build_snapshot(source, target, mapping)
    return DuckDBRepository(target)


def period(**extra):
    return {"start_date": "2026-10-01", "end_date": "2026-11-01", **extra}


def test_money_transfers_refunds_boundaries_and_isolation(repository):
    tools = FinanceTools(repository, "A")
    result = tools.execute("get_spending", period())
    assert Decimal(result["total_eur"]) == Decimal("530.05")
    assert result["transaction_count"] == 3
    assert "A" not in result.values()
    result = tools.execute("get_spending", period(category="food"))
    assert result["total_eur"] == "30.05"
    assert tools.execute("simulate_savings", period(category="Food", reduction_percent=20))["savings_eur"] == "6.01"
    assert FinanceTools(repository, "B").execute("get_spending", period())["total_eur"] == "999.00"
    assert FinanceTools(repository, "absent").execute("get_spending", period())["status"] == "no_customer_data"
    assert tools.execute("get_three_baskets", period())["baskets"]["unclassified"] == "30.05"
    assert tools.execute("calculate_safe_to_spend", {})["safe_to_spend_eur"] is None


def test_daily_and_precomputed_paths_reconcile(repository):
    with repository.connection() as con:
        direct = con.execute("SELECT SUM(expense_eur) FROM transactions WHERE customer_id='A' AND tx_date < '2026-11-01'").fetchone()[0]
    monthly = repository.spending("A", date(2026, 10, 1), date(2026, 11, 1), None)
    daily = repository.spending("A", date(2026, 10, 2), date(2026, 10, 7), None)
    assert Decimal(monthly["total_eur"]) == direct
    assert daily["total_eur"] == "20.04"


@pytest.mark.parametrize("arguments", [period(customer_id="B"), period(end_date="2026-10-01"),
    period(start_date="2020-01-01"), period(start_date="not-date")])
def test_invalid_tool_inputs(repository, arguments):
    assert FinanceTools(repository, "A").execute("get_spending", arguments)["error"] == "invalid_arguments"


def test_injection_and_customer_scope(repository):
    tools = FinanceTools(repository, "A")
    assert tools.execute("run_sql", {"sql": "SELECT * FROM transactions"})["error"] == "unknown_tool"
    assert tools.execute("get_spending", period(category="Food' OR 1=1 --"))["total_eur"] == "0.00"
    assert repository.describe("A' OR 1=1 --")["transaction_count"] == 0
    with ThreadPoolExecutor(max_workers=4) as pool:
        totals = list(pool.map(lambda c: FinanceTools(repository, c).execute("get_spending", period())["total_eur"], ["A", "B"] * 6))
    assert totals == ["530.05", "999.00"] * 6
    with repository.connection() as con, pytest.raises(duckdb.Error):
        con.execute("DELETE FROM transactions")


def test_different_duckdb_schema_positive_debits_and_date_format(tmp_path):
    source = tmp_path / "upstream.duckdb"
    with duckdb.connect(str(source)) as con:
        con.execute('CREATE SCHEMA analytics')
        con.execute('CREATE TABLE analytics.ledger("client key" VARCHAR, day VARCHAR, kind VARCHAR, debit DECIMAL(18,2))')
        con.execute("INSERT INTO analytics.ledger VALUES ('A', '05/10/2026', 'Food', 42.15)")
    mapping = Mapping(table="analytics.ledger", customer_id="client key", date="day", category="kind", amount="debit",
                      date_format="%d/%m/%Y", amount_convention="positive_debits", expense_categories=["Food"])
    for convention in ["positive_debits", "expense_only"]:
        output = tmp_path / f"{convention}.duckdb"
        build_snapshot(source, output, mapping.model_copy(update={"amount_convention": convention}), "duckdb")
        assert FinanceTools(DuckDBRepository(output), "A").execute("get_spending", period())["total_eur"] == "42.15"
    with duckdb.connect(str(source), read_only=True) as con:
        assert con.execute("SELECT COUNT(*) FROM analytics.ledger").fetchone()[0] == 1


def test_invalid_import_is_atomic_and_snapshot_not_overwritten(tmp_path, source, mapping):
    out = tmp_path / "new.duckdb"
    bad = mapping.model_copy(update={"amount": "missing"})
    with pytest.raises(ValueError, match="Missing mapped"):
        build_snapshot(source, out, bad)
    assert not out.exists()
    source.write_text("owner,booked,group,amount\nA,invalid,Food,12\n", encoding="utf-8")
    with pytest.raises(ValueError, match="invalid rows"):
        build_snapshot(source, out, mapping)
    assert not out.exists()
    out.write_text("untouched", encoding="utf-8")
    with pytest.raises(ValueError, match="new path"):
        build_snapshot(source, out, mapping)
    assert out.read_text() == "untouched"


def test_mixed_currency_rejected(tmp_path, mapping):
    source = tmp_path / "currencies.csv"
    source.write_text("owner,booked,group,amount,currency\nA,2026-10-01,Food,-10,USD\n")
    with pytest.raises(ValueError, match="invalid rows"):
        build_snapshot(source, tmp_path / "out.duckdb", mapping.model_copy(update={"currency_column": "currency"}))


def sdk_client(responses, requests):
    def handle(request):
        requests.append(json.loads(request.content))
        body = responses.pop(0)
        return httpx2.Response(200, json={"id": "msg_test", "type": "message", "role": "assistant",
            "model": "claude-haiku-5-5", "stop_sequence": None,
            "usage": {"input_tokens": 20, "output_tokens": 10}, **body})
    return anthropic.Anthropic(api_key="test-key", max_retries=0,
        http_client=httpx2.Client(transport=httpx2.MockTransport(handle)))


def tool_call(name="get_spending", arguments=None, tool_id="t1"):
    return {"type": "tool_use", "id": tool_id, "name": name, "input": arguments if arguments is not None else period()}


def test_real_sdk_mock_transport_tool_protocol(repository):
    requests = []
    responses = [
        {"stop_reason": "tool_use", "content": [tool_call(), tool_call("run_sql", {}, "t2")]},
        {"stop_reason": "end_turn", "content": [{"type": "text", "text": "Spending was EUR 530.05."}]},
    ]
    with sdk_client(responses, requests) as client:
        result = CoachAgent(client).run("How much did I spend?", FinanceTools(repository, "A"))
    assert result["usage"] == {"input_tokens": 40, "output_tokens": 20}
    results = requests[1]["messages"][-1]["content"]
    assert results[0]["tool_use_id"] == "t1"
    assert json.loads(results[0]["content"])["total_eur"] == "530.05"
    assert results[1]["is_error"] is True
    assert "customer_id" not in json.dumps(requests)
    assert "999.00" not in json.dumps(requests)


@pytest.mark.parametrize("response", [
    {"stop_reason": "max_tokens", "content": [{"type": "text", "text": "partial"}]},
    {"stop_reason": "tool_use", "content": [tool_call()]},
    {"stop_reason": "pause_turn", "content": []},
])
def test_agent_stops_at_limits(repository, response):
    with sdk_client([response], []) as client, pytest.raises(AgentLimitError):
        CoachAgent(client, max_rounds=1).run("question", FinanceTools(repository, "A"))


class LocalAgent:
    def run(self, message, tools):
        return {"answer": tools.execute("get_spending", period())["total_eur"], "model": "fake",
                "usage": {"input_tokens": 0, "output_tokens": 0}, "tools_used": ["get_spending"]}


def test_api_auth_scope_request_validation_and_budget(repository):
    settings = Settings(demo_mode=True, demo_tokens={"secret-a": "A", "secret-b": "B"}, requests_per_minute=1)
    with TestClient(create_app(settings, repository=repository, agent=LocalAgent())) as client:
        assert client.get("/healthz").status_code == 200
        assert client.get("/readyz").status_code == 200
        assert client.post("/v1/chat", json={"message": "hi"}).status_code == 401
        assert client.get("/v1/data-context", headers={"Authorization": "Bearer unknown"}).status_code == 401
        headers = {"Authorization": "Bearer secret-a"}
        assert client.post("/v1/chat", headers=headers, json={"message": "hi", "customer_id": "B"}).status_code == 422
        assert client.post("/v1/chat", headers=headers, json={"message": " "}).status_code == 422
        assert client.post("/v1/chat", headers=headers, json={"message": "x" * 4001}).status_code == 422
        assert client.post("/v1/chat", headers=headers, json={"message": "hi"}).json()["answer"] == "530.05"
        assert client.post("/v1/chat", headers=headers, json={"message": "hi"}).status_code == 429
        assert client.post("/v1/chat", headers={"Authorization": "Bearer secret-b"}, json={"message": "hi"}).json()["answer"] == "999.00"


def test_default_auth_fails_closed_and_missing_key(repository, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with TestClient(create_app(Settings(), repository=repository)) as client:
        assert client.get("/readyz").status_code == 503
        assert client.post("/v1/chat", headers={"Authorization": "Bearer A"}, json={"message": "hi"}).status_code == 401
    with TestClient(create_app(Settings(), repository=repository, authenticate=lambda token: "A")) as client:
        response = client.post("/v1/chat", headers={"Authorization": "Bearer verified"}, json={"message": "hi"})
        assert response.status_code == 503
        assert "ANTHROPIC_API_KEY" in response.json()["detail"]


def test_api_lifespan_uses_direct_client(repository, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    requests = []
    with sdk_client([{"stop_reason": "end_turn", "content": [{"type": "text", "text": "Hi!"}]}], requests) as sdk:
        from unittest.mock import patch
        with patch("money_coach.api.create_client", return_value=sdk) as factory:
            with TestClient(create_app(Settings(), repository=repository, authenticate=lambda _: "A")) as client:
                response = client.post("/v1/chat", headers={"Authorization": "Bearer session"}, json={"message": "hi"})
                assert response.status_code == 200
                assert response.json()["answer"] == "Hi!"
            factory.assert_called_once_with()
            assert sdk.is_closed()


def test_demo_build_excludes_secrets_and_checks_customer(repository, tmp_path):
    import importlib.util
    spec = importlib.util.spec_from_file_location("prepare_cloud_run", Path(__file__).parents[1] / "scripts" / "prepare_cloud_run.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    backend = tmp_path / "backend"
    (backend / "src" / "money_coach").mkdir(parents=True)
    (backend / "src" / "money_coach" / "api.py").write_text("# app code")
    (backend / "src" / ".env").write_text("SECRET=do-not-package")
    for name in ("pyproject.toml", "constraints.txt", "Dockerfile"):
        (backend / name).write_text("# fixture")
    with pytest.raises(ValueError, match="no data"):
        module.prepare(backend, repository.path, "absent")
    assert not (backend / ".deploy").exists()
    deployment = module.prepare(backend, repository.path, "A")
    files = {str(f.relative_to(deployment / "source")).replace('\\', '/') for f in (deployment / "source").rglob('*') if f.is_file()}
    assert files == {"pyproject.toml", "constraints.txt", "Dockerfile", "src/money_coach/api.py", "data/finance.duckdb", ".gcloudignore"}
    environment = json.loads((deployment / "runtime-env.yaml").read_text())
    assert "ANTHROPIC_API_KEY" not in environment
    token = (deployment / "demo-token.txt").read_text().strip()
    assert json.loads(environment["DEMO_TOKENS_JSON"]) == {token: "A"}
