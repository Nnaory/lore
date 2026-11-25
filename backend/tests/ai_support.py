"""Shared helpers for the AI endpoint tests (no network, no database).

Why: every AI endpoint test needs the same wiring: Gemini env vars, a MockTransport standing in
for Google, fake sleep and clock, and a limiter on fake clocks. One definition keeps the tests
short. `build_app` injects through `app.state.ai_runtime` and `app.state.ai_limiter`, the same
points production uses, so nothing is patched at module level.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx2
import pytest
from fastapi import FastAPI

from app.ai.limits import AiLimiter, AiLimits
from app.ai.runtime import AiRuntime
from app.main import create_app

KEY = "AIza-super-secret-key"
FIXTURES = Path(__file__).parent / "fixtures" / "ai"
ENDPOINT = "/api/v1/ai/analyze-material"

Handler = Callable[[httpx2.Request], httpx2.Response]


def load_fixture(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def gemini_reply(
    payload: Any, *, prompt_tokens: int = 321, output_tokens: int = 654
) -> httpx2.Response:
    """A successful generateContent response whose text is `payload` as JSON."""
    return httpx2.Response(
        200,
        json={
            "candidates": [
                {
                    "content": {"parts": [{"text": json.dumps(payload)}]},
                    "finishReason": "STOP",
                }
            ],
            "usageMetadata": {
                "promptTokenCount": prompt_tokens,
                "candidatesTokenCount": output_tokens,
                "totalTokenCount": prompt_tokens + output_tokens,
            },
        },
    )


def gemini_error(status: int, message: str = "boom") -> httpx2.Response:
    return httpx2.Response(status, json={"error": {"message": message}})


@dataclass
class FakeClock:
    """A settable clock used for both monotonic and wall time."""

    now: float = 1_000_000.0

    def __call__(self) -> float:
        return self.now


@dataclass
class FakeGemini:
    """Scripted stand-in for Google: records requests, answers with `handler`."""

    handler: Handler
    requests: list[httpx2.Request] = field(default_factory=list)

    def __post_init__(self) -> None:
        def wrapped(request: httpx2.Request) -> httpx2.Response:
            self.requests.append(request)
            return self.handler(request)

        self.transport = httpx2.MockTransport(wrapped)

    def sent_json(self, index: int = 0) -> dict[str, Any]:
        return json.loads(self.requests[index].content)


def configure_env(monkeypatch: pytest.MonkeyPatch, *, configured: bool = True) -> None:
    monkeypatch.delenv("PGHOST", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    for name in ("AI_MODEL", "AI_TIMEOUT_MS", "AI_DEADLINE_MS"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("AI_MODEL", "test-model")
    if configured:
        monkeypatch.setenv("AI_PROVIDER", "google")
        monkeypatch.setenv("GOOGLE_API_KEY", KEY)
    else:
        monkeypatch.setenv("AI_PROVIDER", "google")
        monkeypatch.delenv("GOOGLE_API_KEY", raising=False)


async def _no_sleep(_seconds: float) -> None:
    return None


def build_app(
    monkeypatch: pytest.MonkeyPatch,
    handler: Handler | None = None,
    *,
    limits: AiLimits | None = None,
    clock: FakeClock | None = None,
    configured: bool = True,
) -> tuple[FastAPI, FakeGemini, AiLimiter, FakeClock]:
    """An app with fake Gemini, fake sleep, a fake clock and a limiter on that clock."""
    configure_env(monkeypatch, configured=configured)
    clock = clock or FakeClock()
    gemini = FakeGemini(handler or (lambda _r: gemini_error(500)))
    application = create_app()
    limiter = AiLimiter(limits or AiLimits(), monotonic=clock, wall=clock)
    application.state.ai_limiter = limiter
    ticks = iter([0.0])

    def monotonic() -> float:
        # First call is the start of the Gemini call; later calls report 1.234 s elapsed.
        return next(ticks, 1.234)

    application.state.ai_runtime = AiRuntime(
        http_client=httpx2.AsyncClient(transport=gemini.transport),
        sleep=_no_sleep,
        monotonic=monotonic,
    )
    return application, gemini, limiter, clock
