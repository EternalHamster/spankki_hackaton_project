import json
from unittest.mock import patch

import httpx2
import pytest

from money_coach.client import create_client
from money_coach import smoke


def response_body():
    return {"id": "msg_test", "type": "message", "role": "assistant", "model": "claude-sonnet-5-5",
            "stop_reason": "end_turn", "stop_sequence": None,
            "usage": {"input_tokens": 8, "output_tokens": 2},
            "content": [{"type": "text", "text": "Hi!"}]}


def test_missing_key_never_uses_other_credentials(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "unrelated-token")
    assert create_client() is None
    assert create_client(api_key="   ") is None


def test_direct_api_key_and_endpoint(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://obsolete.example")
    captured = []

    def handle(request):
        captured.append(request)
        return httpx2.Response(200, json=response_body())

    with create_client(http_client=httpx2.Client(transport=httpx2.MockTransport(handle))) as client:
        client.messages.create(model="claude-sonnet-5-5", max_tokens=32,
                               messages=[{"role": "user", "content": "hi"}])
    assert len(captured) == 1
    assert str(captured[0].url) == "https://api.anthropic.com/v1/messages"
    assert captured[0].headers["x-api-key"] == "test-key"


@pytest.mark.parametrize("status", [200, 401, 429, 500])
def test_smoke_uses_one_small_request_and_redacts_errors(monkeypatch, capsys, status):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test-secret")
    requests = []

    def handle(request):
        requests.append(request)
        body = response_body() if status == 200 else {
            "type": "error", "error": {"type": "api_error", "message": "do not print test-secret"}}
        return httpx2.Response(status, json=body)

    client = create_client(max_retries=0, http_client=httpx2.Client(transport=httpx2.MockTransport(handle)))
    with patch("money_coach.smoke.create_client", return_value=client) as factory:
        assert smoke.main([]) == (0 if status == 200 else 1)
    factory.assert_called_once_with(api_key="sk-ant-test-secret", max_retries=0)
    assert len(requests) == 1
    body = json.loads(requests[0].content)
    assert body["messages"] == [{"role": "user", "content": "hi"}]
    assert body["max_tokens"] == 32
    assert body["thinking"] == {"type": "between_tools"}
    assert "tools" not in body and "system" not in body
    output = capsys.readouterr()
    assert "test-secret" not in output.out + output.err
    if status == 200:
        assert "Hi!" in output.out and "8 input, 2 output" in output.out


def test_smoke_without_key_in_noninteractive_shell(monkeypatch, capsys):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)
    assert smoke.main([]) == 1
    assert "ANTHROPIC_API_KEY" in capsys.readouterr().err


@pytest.mark.parametrize("key", ["sk-ant-usr-short...mask", "sk-ant-usr-short\u2026mask", "\x16", "apikey_identifier", "sk-ant-invalid\ntext"])
def test_clipboard_rejects_incomplete_keys_without_request(monkeypatch, capsys, key):
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    monkeypatch.setattr("builtins.input", lambda _: "")
    monkeypatch.setattr(smoke, "read_clipboard", lambda: key)
    with patch("money_coach.smoke.create_client") as factory:
        assert smoke.main(["--clipboard"]) == 1
        factory.assert_not_called()
    assert "No request sent" in capsys.readouterr().err


def test_clipboard_reads_after_prompt_and_overrides_stale_environment(monkeypatch, capsys):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "stale-key")
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    events = []
    monkeypatch.setattr("builtins.input", lambda _: events.append("prompt"))

    def clipboard():
        events.append("clipboard")
        return "sk-ant-test-clipboard-secret"

    monkeypatch.setattr(smoke, "read_clipboard", clipboard)
    requests = []

    def handle(request):
        requests.append(request)
        return httpx2.Response(200, json=response_body())

    def factory(**kwargs):
        return create_client(**kwargs, http_client=httpx2.Client(transport=httpx2.MockTransport(handle)))

    monkeypatch.setattr(smoke, "create_client", factory)
    assert smoke.main(["--clipboard"]) == 0
    assert events == ["prompt", "clipboard"]
    assert len(requests) == 1
    assert requests[0].headers["x-api-key"] == "sk-ant-test-clipboard-secret"
    output = capsys.readouterr()
    assert "clipboard-secret" not in output.out + output.err


def test_clipboard_unavailable_fails_without_request(monkeypatch, capsys):
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    monkeypatch.setattr("builtins.input", lambda _: "")
    with patch("money_coach.smoke.read_clipboard", side_effect=RuntimeError("Cannot read clipboard text.")):
        with patch("money_coach.smoke.create_client") as factory:
            assert smoke.main(["--clipboard"]) == 1
            factory.assert_not_called()
    assert "Cannot read clipboard" in capsys.readouterr().err
