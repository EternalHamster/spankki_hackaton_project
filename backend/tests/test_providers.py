from unittest.mock import patch

import anthropic
import httpx2
import pytest

from money_coach.providers import ProviderSettings, create_model_client


def test_google_managed_has_no_api_key_or_workspace():
    with patch("money_coach.providers.anthropic.AnthropicVertex") as constructor:
        create_model_client(ProviderSettings(provider="vertex", project="project-test", region="eu"))
        constructor.assert_called_once_with(project_id="project-test", region="eu", timeout=30.0, max_retries=1)


def test_anthropic_managed_uses_workspace_and_global_location():
    with patch("money_coach.providers.anthropic.AnthropicGoogleCloud") as constructor:
        create_model_client(ProviderSettings(provider="google_cloud", project="project-test", workspace_id="wrkspc_test"))
        constructor.assert_called_once_with(project="project-test", location="global", workspace_id="wrkspc_test", timeout=30.0, max_retries=1)


@pytest.mark.parametrize("settings", [ProviderSettings(provider="vertex"), ProviderSettings(provider="google_cloud", project="p")])
def test_cloud_missing_config_does_not_fall_back_to_paid_direct_key(settings, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-unused")
    with patch("money_coach.providers.anthropic.Anthropic") as direct, pytest.raises(ValueError):
        create_model_client(settings)
    direct.assert_not_called()


def test_direct_provider_and_invalid_selection(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert create_model_client(ProviderSettings()) is None
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    with patch("money_coach.providers.anthropic.Anthropic") as direct:
        create_model_client(ProviderSettings())
        direct.assert_called_once_with(api_key="test-key", timeout=30.0, max_retries=1)
    monkeypatch.setenv("CLAUDE_PROVIDER", "typo")
    with pytest.raises(ValueError):
        ProviderSettings.from_env()


@pytest.mark.parametrize("provider", ["vertex", "google_cloud"])
def test_cloud_sdk_request_routing_without_network(provider):
    credentials_module = pytest.importorskip("google.oauth2.credentials")
    captured = []

    def handle(request):
        captured.append(request)
        return httpx2.Response(200, json={"id": "msg_test", "type": "message", "role": "assistant",
            "model": "claude-haiku-5-5", "stop_reason": "end_turn", "stop_sequence": None,
            "usage": {"input_tokens": 10, "output_tokens": 5},
            "content": [{"type": "text", "text": "Test answer"}]})

    transport = httpx2.Client(transport=httpx2.MockTransport(handle))
    if provider == "vertex":
        client = anthropic.AnthropicVertex(project_id="project-test", region="global",
            credentials=credentials_module.Credentials(token="test-google-token"), http_client=transport)
    else:
        client = anthropic.AnthropicGoogleCloud(project="project-test", workspace_id="wrkspc_test",
            token_provider=lambda: "test-google-token", http_client=transport)
    with client:
        result = client.messages.create(model="claude-haiku-5-5", max_tokens=100,
            messages=[{"role": "user", "content": "test"}],
            tools=[{"name": "get_data_context", "description": "Read context", "input_schema": {"type": "object", "properties": {}}}])
    assert result.content[0].text == "Test answer"
    request = captured[0]
    assert request.headers["Authorization"] == "Bearer test-google-token"
    assert "x-api-key" not in request.headers
    if provider == "vertex":
        assert request.url.host == "aiplatform.googleapis.com"
        assert "/publishers/anthropic/models/claude-haiku-5-5:rawPredict" in str(request.url)
    else:
        assert request.url.host == "claude.googleapis.com"
        assert "/workspaces/wrkspc_test/invoke/v1/messages" in str(request.url)
