import json
import os
import secrets
import threading
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Callable
from uuid import uuid4

import anthropic
import duckdb
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field

from .agent import AgentLimitError, CoachAgent
from .repository import DuckDBRepository
from .client import DEFAULT_MODEL, create_client
from .tools import FinanceTools


@dataclass
class Settings:
    database: Path = Path("data/finance.duckdb")
    model: str = DEFAULT_MODEL
    demo_mode: bool = False
    # Secret bearer token -> customer ID; never sent to the model.
    demo_tokens: dict[str, str] = field(default_factory=dict)
    origins: list[str] = field(default_factory=list)
    requests_per_minute: int = 10
    process_chat_limit: int = 500
    # The coach's "today". None = last transaction date in the snapshot (falls back to the real date).
    as_of: date | None = None

    @classmethod
    def from_env(cls):
        value = cls(
            database=Path(os.getenv("DUCKDB_PATH", "data/finance.duckdb")),
            model=os.getenv("CLAUDE_MODEL", DEFAULT_MODEL),
            demo_mode=os.getenv("DEMO_MODE", "false").lower() == "true",
            demo_tokens=json.loads(os.getenv("DEMO_TOKENS_JSON", "{}")),
            origins=[o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()],
            requests_per_minute=int(os.getenv("REQUESTS_PER_MINUTE", "10")),
            process_chat_limit=int(os.getenv("PROCESS_CHAT_LIMIT", "500")),
            as_of=date.fromisoformat(os.environ["COACH_AS_OF"]) if os.getenv("COACH_AS_OF") else None,
        )
        if not isinstance(value.demo_tokens, dict) or any(
            not isinstance(k, str) or len(k) < 24 or not isinstance(v, str) or not v
            for k, v in value.demo_tokens.items()
        ):
            raise ValueError("Demo tokens must map random bearer secrets (24+ characters) to customer IDs")
        if value.requests_per_minute <= 0 or value.process_chat_limit <= 0:
            raise ValueError("Request limits must be positive")
        if "*" in value.origins:
            raise ValueError("Use explicit CORS origins")
        return value


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    message: str = Field(min_length=1, max_length=4000)


class ChatResponse(BaseModel):
    answer: str
    model: str
    usage: dict[str, int]
    tools_used: list[str]
    request_id: str


class RequestBudget:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.lock = threading.Lock()
        self.events = defaultdict(deque)
        self.total = 0

    def claim(self, customer: str):
        with self.lock:
            now = time.monotonic()
            if self.total >= self.settings.process_chat_limit:
                raise HTTPException(429, "Process demo budget reached")
            events = self.events[customer]
            while events and events[0] <= now - 60:
                events.popleft()
            if len(events) >= self.settings.requests_per_minute:
                raise HTTPException(429, "Too many requests", headers={"Retry-After": "60"})
            events.append(now)
            self.total += 1


def create_app(settings: Settings | None = None, *, repository=None, agent=None,
               authenticate: Callable[[str], str | None] | None = None):
    """authenticate must verify a real banking/identity session and map its subject server-side.

    No production authentication implementation is assumed. Default is deny-all.
    The callback is a trusted integration seam, never a frontend customer ID.
    """
    settings = settings or Settings.from_env()
    repository = repository or DuckDBRepository(settings.database)
    budget = RequestBudget(settings)
    slots = threading.BoundedSemaphore(4)

    def coach_as_of() -> date | None:
        if settings.as_of:
            return settings.as_of
        try:
            return repository.latest_date()
        except (duckdb.Error, ValueError, OSError, AttributeError):
            return None  # snapshot missing at startup: agent falls back to the real date

    @asynccontextmanager
    async def lifespan(app):
        client = None
        app.state.agent = agent
        if agent is None:
            client = create_client()
            if client:
                app.state.agent = CoachAgent(client, model=settings.model, as_of=coach_as_of())
        try:
            yield
        finally:
            if client:
                client.close()

    app = FastAPI(title="Personal Economic Trainer API", version="0.1.0", lifespan=lifespan)
    if settings.origins:
        app.add_middleware(CORSMiddleware, allow_origins=settings.origins,
                           allow_methods=["GET", "POST"], allow_headers=["Authorization", "Content-Type"])
    bearer = HTTPBearer(auto_error=False)

    def customer(credentials: HTTPAuthorizationCredentials | None = Depends(bearer)) -> str:
        if credentials is None or credentials.scheme.lower() != "bearer":
            raise HTTPException(401, "Authentication required", headers={"WWW-Authenticate": "Bearer"})
        token = credentials.credentials
        identity = None
        if authenticate:
            identity = authenticate(token)
        elif settings.demo_mode:
            for configured, candidate in settings.demo_tokens.items():
                if secrets.compare_digest(token.encode(), configured.encode()):
                    identity = candidate
                    break
        if not identity:
            raise HTTPException(401, "Invalid session", headers={"WWW-Authenticate": "Bearer"})
        return identity

    @app.get("/healthz")
    def health():
        return {"status": "ok"}

    @app.get("/readyz")
    def ready():
        try:
            repository.check()
        except (duckdb.Error, ValueError, OSError):
            raise HTTPException(503, "Database snapshot unavailable") from None
        if not app.state.agent or not (authenticate or (settings.demo_mode and settings.demo_tokens)):
            raise HTTPException(503, "Model or authentication not configured")
        return {"status": "ready"}

    @app.get("/v1/data-context")
    def context(customer_id: str = Depends(customer)):
        try:
            return repository.describe(customer_id)
        except (duckdb.Error, ValueError, OSError):
            raise HTTPException(503, "Database snapshot unavailable") from None

    @app.post("/v1/chat", response_model=ChatResponse)
    def chat(body: ChatRequest, customer_id: str = Depends(customer)):
        if not app.state.agent:
            raise HTTPException(503, "ANTHROPIC_API_KEY is not configured on the server")
        if not slots.acquire(blocking=False):
            raise HTTPException(429, "Agent busy; retry shortly", headers={"Retry-After": "5"})
        try:
            repository.check()
            budget.claim(customer_id)
            result = app.state.agent.run(body.message, FinanceTools(repository, customer_id))
            return {**result, "request_id": uuid4().hex}
        except AgentLimitError as exc:
            raise HTTPException(422, str(exc)) from None
        except anthropic.RateLimitError:
            raise HTTPException(503, "Model provider busy; retry later") from None
        except anthropic.APIError:
            raise HTTPException(502, "Model provider request failed") from None
        except (duckdb.Error, ValueError, OSError):
            raise HTTPException(503, "Database snapshot unavailable") from None
        finally:
            slots.release()

    return app


app = create_app()
