"""Three-insights feature. Mocked HTTP only: these tests never make a paid request."""
import json
import re
import sys
from pathlib import Path

import anthropic
import httpx2
import pytest
from fastapi.testclient import TestClient

from money_coach import insights as module
from money_coach.api import Settings, create_app
from money_coach.insights import InsightError, InsightWriter, default_context_provider, unknown_numbers

CONTEXT = ("Safe to spend on extras this week: €270, limited by the usual monthly budget.\n"
           "- restaurants & cafés: €190 | €120 a month; 3.4 payments a month of €55 | 3.8 of €30\n"
           "Surprise fund target: €5,200; chance the salary is late 24 %.")
GOOD = {"insights": [
    {"title": "Your weekly room", "headline_number": "€270 a week",
     "explanation": "You can spend €270 a week on extras. Your monthly budget sets this limit.",
     "action": "Keep this week's extras under €270."},
    {"title": "Eating out costs more", "headline_number": "€190 a month",
     "explanation": "You spend €190 a month against €120 for people like you. You pay €55 each time, they pay €30.",
     "action": "Pick a cheaper place every second time."},
    {"title": "Your surprise fund", "headline_number": "€5,200",
     "explanation": "A fund of €5,200 covers a bad year of repairs and doctor bills.",
     "action": "Keep €5,200 untouched."},
]}


def sdk_client(body, requests):
    def handle(request):
        requests.append(json.loads(request.content))
        return httpx2.Response(200, json={"id": "msg_test", "type": "message", "role": "assistant",
            "model": "claude-sonnet-5-5", "stop_sequence": None, "stop_reason": "end_turn",
            "usage": {"input_tokens": 900, "output_tokens": 300}, **body})
    return anthropic.Anthropic(api_key="test-key", max_retries=0,
        http_client=httpx2.Client(transport=httpx2.MockTransport(handle)))


def answer(payload):
    return {"content": [{"type": "text", "text": json.dumps(payload)}]}


def test_dry_run_is_default_and_sends_nothing():
    requests = []
    with sdk_client(answer(GOOD), requests) as client:
        result = InsightWriter(client).run(CONTEXT)
    assert requests == []                                   # no network call
    assert result["dry_run"] is True and result["estimated_input_tokens"] > 0
    assert result["request"]["messages"] == [{"role": "user", "content": CONTEXT}]
    assert "tools" not in result["request"]                 # the model gets no way to look anything up
    assert InsightWriter(None).run(CONTEXT)["dry_run"] is True      # works without any API key


def test_live_request_shape_and_verified_numbers():
    requests = []
    with sdk_client(answer(GOOD), requests) as client:
        result = InsightWriter(client, live=True).run(CONTEXT)
    assert len(requests) == 1
    sent = requests[0]
    assert sent["output_config"]["format"]["type"] == "json_schema"
    assert sent["messages"][0]["content"] == CONTEXT and "tools" not in sent
    assert [i["title"] for i in result["insights"]] == [i["title"] for i in GOOD["insights"]]
    assert all(i["numbers_verified"] and i["unverified_numbers"] == [] for i in result["insights"])
    assert result["usage"] == {"input_tokens": 900, "output_tokens": 300}


def test_invented_numbers_are_flagged():
    bad = json.loads(json.dumps(GOOD))
    bad["insights"][1]["explanation"] = "Cutting it would save €840 a year, or about 37 % of it."
    with sdk_client(answer(bad), []) as client:
        result = InsightWriter(client, live=True).run(CONTEXT)
    assert result["insights"][0]["numbers_verified"] is True
    assert result["insights"][1]["numbers_verified"] is False
    assert result["insights"][1]["unverified_numbers"] == ["37", "840"]
    assert unknown_numbers({"headline_number": "€5,200", "explanation": "3.4 payments, 12 months.", "action": ""},
                           CONTEXT) == []


@pytest.mark.parametrize("body", [
    answer({"insights": GOOD["insights"][:2]}),                         # two, not three
    {"content": [{"type": "text", "text": "Here are your insights: ..."}]},   # not JSON
    {"stop_reason": "max_tokens", **answer(GOOD)},
    {"stop_reason": "refusal", "content": []},
])
def test_unusable_answers_are_rejected(body):
    with sdk_client(body, []) as client, pytest.raises(InsightError):
        InsightWriter(client, live=True).run(CONTEXT)


def test_live_without_key_fails_clearly():
    with pytest.raises(InsightError, match="ANTHROPIC_API_KEY"):
        InsightWriter(None, live=True).run(CONTEXT)


class Repo:
    def check(self): pass
    def latest_date(self): return None


def provider(customer_id):
    if customer_id not in ("A", "B"):
        raise KeyError(customer_id)
    return f"context of {customer_id}: €270"


def test_endpoint_dry_run_auth_and_customer_scope(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    settings = Settings(demo_mode=True, demo_tokens={"secret-a": "A", "secret-b": "B", "secret-x": "nobody"})
    with TestClient(create_app(settings, repository=Repo(), insight_context=provider)) as client:
        assert client.post("/v1/insights").status_code == 401
        a = client.post("/v1/insights", headers={"Authorization": "Bearer secret-a"})
        assert a.status_code == 200 and a.json()["dry_run"] is True       # no key needed for a dry run
        assert a.json()["request"]["messages"][0]["content"] == "context of A: €270"
        b = client.post("/v1/insights", headers={"Authorization": "Bearer secret-b"}).json()
        assert b["request"]["messages"][0]["content"] == "context of B: €270"
        # the customer comes from the session; a body or query cannot switch it
        c = client.post("/v1/insights?customer_id=B", headers={"Authorization": "Bearer secret-a"}, json={"customer_id": "B"})
        assert "context of A" in c.json()["request"]["messages"][0]["content"]
        assert client.post("/v1/insights", headers={"Authorization": "Bearer secret-x"}).status_code == 404


def test_endpoint_live_uses_writer_and_budget():
    requests = []
    settings = Settings(demo_mode=True, demo_tokens={"secret-a": "A"}, insights_live=True, requests_per_minute=1)
    with sdk_client(answer(GOOD), requests) as sdk:
        app = create_app(settings, repository=Repo(), insight_context=lambda _: CONTEXT,
                         insight_writer=InsightWriter(sdk, live=True))
        with TestClient(app) as client:
            headers = {"Authorization": "Bearer secret-a"}
            body = client.post("/v1/insights", headers=headers).json()
            assert body["dry_run"] is False and len(body["insights"]) == 3 and body["request_id"]
            assert client.post("/v1/insights", headers=headers).status_code == 429     # rate limit applies
    assert len(requests) == 1
    assert "secret-a" not in json.dumps(requests) and '"A"' not in json.dumps(requests)


def test_endpoint_without_engine_output_is_503(monkeypatch):
    def missing():
        raise module.ContextUnavailable("no output")
    monkeypatch.setattr("money_coach.api.default_context_provider", missing)
    settings = Settings(demo_mode=True, demo_tokens={"secret-a": "A"})
    with TestClient(create_app(settings, repository=Repo())) as client:
        assert client.post("/v1/insights", headers={"Authorization": "Bearer secret-a"}).status_code == 503


REPO = Path(__file__).resolve().parents[2]


@pytest.mark.skipif(not (REPO / "BDA" / "output" / "customer_summary.csv").is_file(),
                    reason="spending-model output not in this checkout")
def test_real_context_end_to_end_dry_run():
    """The real engine output through the real provider: no customer ID, no other customer, no request."""
    text = default_context_provider()("CUST00042")
    assert not re.search(r"CUST\d", text)
    result = InsightWriter(None).run(text)
    assert result["dry_run"] is True and 1000 < result["estimated_input_tokens"] < 5000
    assert not re.search(r"CUST\d", json.dumps(result))
    assert str(REPO) in sys.path or "coach_context" in sys.modules
