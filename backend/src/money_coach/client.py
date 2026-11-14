"""Direct Anthropic API connection shared by the backend and smoke test."""
import os

from anthropic import Anthropic


DEFAULT_MODEL = "claude-sonnet-5-5"


def create_client(*, api_key: str | None = None, max_retries: int = 1, http_client=None):
    key = (api_key if api_key is not None else os.getenv("ANTHROPIC_API_KEY", "")).strip()
    if not key:
        return None
    return Anthropic(
        api_key=key,
        # Keep the key on the direct API even if an old base URL exists in the shell.
        base_url="https://api.anthropic.com",
        timeout=30.0,
        max_retries=max_retries,
        http_client=http_client,
    )
