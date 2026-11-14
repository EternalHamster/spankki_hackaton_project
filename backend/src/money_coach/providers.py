"""Explicit provider selection: never silently change credentials or billing route."""
import os
from dataclasses import dataclass
from typing import Literal

import anthropic


@dataclass(frozen=True)
class ProviderSettings:
    provider: Literal["anthropic", "vertex", "google_cloud"] = "anthropic"
    project: str | None = None
    region: str = "global"
    workspace_id: str | None = None

    @classmethod
    def from_env(cls):
        provider = os.getenv("CLAUDE_PROVIDER", "anthropic")
        if provider not in {"anthropic", "vertex", "google_cloud"}:
            raise ValueError("CLAUDE_PROVIDER must be anthropic, vertex or google_cloud")
        return cls(provider=provider,
                   project=os.getenv("GOOGLE_CLOUD_PROJECT") or os.getenv("ANTHROPIC_GOOGLE_CLOUD_PROJECT"),
                   region=os.getenv("GOOGLE_CLOUD_REGION", "global"),
                   workspace_id=os.getenv("ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID"))


def create_model_client(settings: ProviderSettings):
    options = {"timeout": 30.0, "max_retries": 1}
    if settings.provider == "anthropic":
        key = os.getenv("ANTHROPIC_API_KEY")
        return anthropic.Anthropic(api_key=key, **options) if key else None
    if settings.provider not in {"vertex", "google_cloud"}:
        raise ValueError("Unknown Claude provider")
    if not settings.project:
        raise ValueError("Set GOOGLE_CLOUD_PROJECT for Google Cloud inference")
    # Google clients use ADC: local gcloud application-default login, or Cloud Run service identity.
    # Never pass the direct Anthropic API key or fall back to it after a cloud failure.
    if settings.provider == "vertex":
        return anthropic.AnthropicVertex(project_id=settings.project, region=settings.region, **options)
    if not settings.workspace_id:
        raise ValueError("Set ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID for Anthropic-managed Google Cloud")
    return anthropic.AnthropicGoogleCloud(project=settings.project, location="global",
                                          workspace_id=settings.workspace_id, **options)
