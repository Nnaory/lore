"""Test doubles and builders for the Animation_Agent (no network, no boto3, no langgraph).

Why: the agent talks to four things (Gemini, the verifier Lambda, S3 and the registry) and to two
clocks, and every one of them must be replaceable so a test can script any order of results and
move time exactly where it needs to (Requirement 13.12, design 6.6). One definition here keeps the
agent tests short and makes them agree on what a fake does. Nothing here patches a module global:
the doubles go into `RunContext` the way production objects will.

What is real: `AiContext` and the Gemini client (the fake is an `httpx2.MockTransport`, so
`generate_text`, the config limits and the request body are the real ones), `S3AnimationStore` (on
the in-memory `FakeS3`), the prompts, the tokens, the models and the event schema. What is fake:
`FakeGemini` (a script of replies), `ScriptedVerifier` (a script of `LambdaOutcome`) and
`MemoryRegistry` (the rules of `registry.register` without a database).

Typical use:

    rig = make_rig(gemini=[fenced(source(1))], verifier=[verified()])
    result = asyncio.run(run_agent(rig.run))
    assert result.ok and rig.event_names() == [...]

`Rig.clock` is the run's monotonic clock; a fake can move it (`rig.clock.advance_ms(...)`) from
inside a Gemini or verifier step to put the deadline at an exact point. Each test makes its own
rig and runs it in one `asyncio.run`, because the HTTP client is not shared between event loops.
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import uuid
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import httpx2
import pytest

from app.ai.animation.agent import RunContext
from app.ai.animation.contract import AnimationContract, ContractOk, load_contract
from app.ai.animation.models import (
    AnimationRow,
    CreateAnimationRequest,
    DiagnosticsEvent,
    SseEvent,
    StageEvent,
    VerifierResult,
    canonical_hash,
)
from app.ai.animation.registry import NewRow, QuotaExceeded, Registered
from app.ai.animation.store import S3AnimationStore
from app.ai.animation.verifier_client import LambdaOutcome
from app.ai.runtime import AiContext, AiRuntime
from app.ai.settings import GeminiConfig
from tests.fake_s3 import FakeS3

KEY = "AIza-agent-test-key"
MODEL = "fake-model"
OWNER = uuid.UUID("11111111-2222-4333-8444-555555555555")
FIXED_NOW = datetime(2026, 11, 27, 9, 41, 3, tzinfo=UTC)


def contract() -> AnimationContract:
    loaded = load_contract()
    assert isinstance(loaded, ContractOk), loaded
    return loaded.contract


# --- requests ---------------------------------------------------------------------------------


def lesson_request(**overrides: Any) -> CreateAnimationRequest:
    raw: dict[str, Any] = {
        "kind": "lesson",
        "title": "Adding vectors",
        "text": "Add two vectors tip to tail.",
        "concepts": ["vector addition"],
        "visual": {
            "kind": "vectors",
            "vectors": [{"from": [0, 0], "to": [3, 1], "label": "A"}],
            "points": [{"at": [3, 1], "label": "target"}],
            "caption": "Place B at the tip of A.",
        },
        "language": "en",
    }
    raw.update(overrides)
    return CreateAnimationRequest.model_validate(raw)


def puzzle_request(**overrides: Any) -> CreateAnimationRequest:
    raw: dict[str, Any] = {
        "kind": "puzzle",
        "title": "Which option fits?",
        "text": "Pick the option that completes the table.",
        "concepts": ["tables"],
        "visual": {
            "kind": "table",
            "headers": ["Option", "Result"],
            "rows": [["A", "3"], ["B", "?"]],
            "caption": "Which option fits?",
        },
        "language": "en",
        "forbidden_tokens": ["seven"],
    }
    raw.update(overrides)
    return CreateAnimationRequest.model_validate(raw)


# --- clocks and events ------------------------------------------------------------------------


class Clock:
    """A settable monotonic clock in seconds."""

    def __init__(self, now: float = 1_000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance_ms(self, milliseconds: float) -> None:
        self.now += milliseconds / 1000


def event_name(event: SseEvent) -> str:
    """A short label for asserting order: `stage:verifying:2`, `diagnostics:1:False:2`."""
    if isinstance(event, StageEvent):
        return f"stage:{event.stage}:{event.attempt}"
    if isinstance(event, DiagnosticsEvent):
        return f"diagnostics:{event.attempt}:{event.ok}:{event.error_count}"
    return type(event).__name__


# --- Gemini -----------------------------------------------------------------------------------

GeminiReply = str | int | Callable[[httpx2.Request], httpx2.Response | Awaitable[httpx2.Response]]


def source(number: int = 1) -> str:
    """A distinct, already normalized source per `number` (the agent hashes and forwards it)."""
    return f"// attempt {number}\nexport default function Main() {{ return null; }}\n"


def fenced(text: str, label: str = "ts") -> str:
    """A Gemini reply that holds `text` in a fenced code block."""
    return f"```{label}\n{text}```"


def _gemini_body(text: str) -> dict[str, Any]:
    return {
        "candidates": [{"content": {"parts": [{"text": text}]}, "finishReason": "STOP"}],
        "usageMetadata": {
            "promptTokenCount": 10,
            "candidatesTokenCount": 20,
            "totalTokenCount": 30,
        },
    }


@dataclass
class FakeGemini:
    """A script of Gemini replies. A `str` is the reply text, an `int` an HTTP error status, a
    callable builds the response itself (it may move the clock, and may be `async` to wait).

    A call past the end of the script is answered with 500 and counted in `extra_calls`, so a test
    that must see no more calls asserts `len(requests)` instead of hunting a hidden exception.
    """

    replies: list[GeminiReply] = field(default_factory=list)
    requests: list[httpx2.Request] = field(default_factory=list)
    bodies: list[dict[str, Any]] = field(default_factory=list)
    extra_calls: int = 0

    def handler(self, request: httpx2.Request) -> httpx2.Response | Awaitable[httpx2.Response]:
        self.requests.append(request)
        self.bodies.append(json.loads(request.content))
        if not self.replies:
            self.extra_calls += 1
            return httpx2.Response(500, json={"error": {"message": "no reply scripted"}})
        reply = self.replies.pop(0)
        if callable(reply):
            return reply(request)
        if isinstance(reply, int):
            return httpx2.Response(reply, json={"error": {"message": "scripted error"}})
        return httpx2.Response(200, json=_gemini_body(reply))

    def prompts(self) -> list[tuple[str, str]]:
        """`(system, prompt)` of every request seen, in order."""
        return [
            (
                body["systemInstruction"]["parts"][0]["text"],
                body["contents"][0]["parts"][0]["text"],
            )
            for body in self.bodies
        ]

    def generation_configs(self) -> list[dict[str, Any]]:
        return [body["generationConfig"] for body in self.bodies]


def make_ai(
    gemini: FakeGemini,
    clock: Clock,
    *,
    timeout_ms: float = 300_000,
    deadline_ms: float = 300_000,
    models: tuple[str, ...] = (MODEL,),
) -> AiContext:
    """The real `AiContext` over a `MockTransport`; one attempt per model and no backoff."""
    config = GeminiConfig(
        api_key=KEY,
        models=models,
        timeout_ms=timeout_ms,
        attempts_per_model=1,
        backoff_ms=0,
        deadline_ms=deadline_ms,
    )

    async def no_sleep(_seconds: float) -> None:
        return None

    client = httpx2.AsyncClient(transport=httpx2.MockTransport(gemini.handler))
    return AiContext(config, AiRuntime(http_client=client, sleep=no_sleep, monotonic=clock))


# --- verifier ---------------------------------------------------------------------------------

SUMMARY: dict[str, Any] = {
    "verifier_version": "0.1.0",
    "contract_version": 1,
    "runtime_version": {"react": "19.3.0", "remotion": "4.0.543"},
    "checks": [{"name": "size", "ok": True, "ms": 1}, {"name": "render", "ok": True, "ms": 5}],
    "truncated": False,
}

_TOOL_OF_PREFIX = {
    "SIZE": "size",
    "ENCODING": "size",
    "POLICY": "policy",
    "META": "policy",
    "ESLINT": "eslint",
    "TSC": "tsc",
    "BUNDLE": "esbuild",
    "RENDER": "render",
    "FIDELITY": "fidelity",
    "VERIFIER": "verifier",
}


def diagnostic(
    code: str, *, severity: str = "error", line: int | None = 3, message: str | None = None
) -> dict[str, Any]:
    raw: dict[str, Any] = {
        "tool": _TOOL_OF_PREFIX[code.split("_", 1)[0]],
        "code": code,
        "severity": severity,
        "message": message if message is not None else f"message of {code}",
    }
    if line is not None:
        raw["line"] = line
    return raw


def verified(
    bundle: str = "export default function Main() { return null; }",
    *,
    kind: str = "lesson",
    warnings: Sequence[str] = (),
    message: str | None = None,
) -> LambdaOutcome:
    """An `ok` verifier result; a puzzle gets `pauseAtFrame`, as the contract demands.

    `message` replaces the text of every warning (to put a sentinel in it).
    """
    meta: dict[str, Any] = {"width": 1280, "height": 720, "fps": 30, "durationInFrames": 120}
    if kind == "puzzle":
        meta["pauseAtFrame"] = 90
    raw = {
        "ok": True,
        "diagnostics": [diagnostic(code, severity="warning", message=message) for code in warnings],
        "bundle": bundle,
        "meta": meta,
        "summary": SUMMARY,
    }
    return LambdaOutcome("result", result=VerifierResult.model_validate(raw))


def rejected(
    *codes: str, warnings: Sequence[str] = (), message: str | None = None
) -> LambdaOutcome:
    """A failed verifier result with one error per code (and warnings first, to test ordering).

    `message` replaces the text of every Diagnostic (to put a sentinel in it).
    """
    items = [diagnostic(code, severity="warning", message=message) for code in warnings]
    items += [diagnostic(code, message=message) for code in codes]
    raw = {"ok": False, "diagnostics": items, "summary": SUMMARY}
    return LambdaOutcome("result", result=VerifierResult.model_validate(raw))


def crashed() -> LambdaOutcome:
    return LambdaOutcome("function_error")


def unavailable(reason: str = "throttled") -> LambdaOutcome:
    return LambdaOutcome("unavailable", reason=reason)


VerifierStep = LambdaOutcome | BaseException | Callable[[dict[str, Any], float], Awaitable[Any]]


@dataclass
class ScriptedVerifier:
    """A `VerifierPort` that answers from a script and records what it was asked.

    A step is a `LambdaOutcome`, an exception to raise, or an async callable
    `(payload, remaining_ms) -> LambdaOutcome` (to wait, or to move the clock). A call past the end
    of the script is answered `unavailable` and counted in `extra_calls`.
    """

    script: list[VerifierStep] = field(default_factory=list)
    payloads: list[dict[str, Any]] = field(default_factory=list)
    remaining: list[float] = field(default_factory=list)
    attempts: list[int] = field(default_factory=list)
    extra_calls: int = 0

    async def invoke(
        self, payload: dict[str, Any], *, remaining_ms: float, attempt: int = 1
    ) -> LambdaOutcome:
        self.payloads.append(payload)
        self.remaining.append(remaining_ms)
        self.attempts.append(attempt)
        if not self.script:
            self.extra_calls += 1
            return unavailable("no step scripted")
        step = self.script.pop(0)
        if isinstance(step, BaseException):
            raise step
        if isinstance(step, LambdaOutcome):
            return step
        return await step(payload, remaining_ms)


# --- registry ---------------------------------------------------------------------------------


@dataclass
class MemoryRegistry:
    """The rules of `registry.register` without a database: a repeat wins, then the quota.

    `fail` is raised by `register` (use `RegistryError`); `rows` holds what was recorded; `calls`
    every `NewRow` it was given. `seed(row)` records a row before the run, which is how a test
    makes another run "win the race".
    """

    limit: int = 200
    fail: Exception | None = None
    rows: list[AnimationRow] = field(default_factory=list)
    calls: list[NewRow] = field(default_factory=list)

    def seed(self, row: NewRow) -> AnimationRow:
        stored = AnimationRow(**{**dataclasses.asdict(row), "created_at": 1_700_000_000_000})
        self.rows.append(stored)
        return stored

    def register(self, row: NewRow) -> Registered | QuotaExceeded:
        self.calls.append(row)
        if self.fail is not None:
            raise self.fail
        for existing in self.rows:
            if (existing.owner_id, existing.request_hash) == (row.owner_id, row.request_hash):
                return Registered(existing, created=False)
        if sum(1 for item in self.rows if item.owner_id == row.owner_id) >= self.limit:
            return QuotaExceeded()
        return Registered(self.seed(row), created=True)


# --- the rig ----------------------------------------------------------------------------------


@dataclass
class Rig:
    """A `RunContext` with every double that went into it."""

    run: RunContext
    clock: Clock
    gemini: FakeGemini
    verifier: ScriptedVerifier
    s3: FakeS3
    registry: MemoryRegistry
    events: list[SseEvent]

    def event_names(self) -> list[str]:
        return [event_name(event) for event in self.events]


def make_rig(
    *,
    kind: str = "lesson",
    gemini: Sequence[GeminiReply] = (),
    verifier: Sequence[VerifierStep] = (),
    max_attempts: int = 4,
    deadline_ms: float = 240_000,
    registry_limit: int = 200,
    registry_error: Exception | None = None,
    request: CreateAnimationRequest | None = None,
    cancelled: asyncio.Event | None = None,
    ai_timeout_ms: float = 300_000,
    ai_deadline_ms: float = 300_000,
    s3: FakeS3 | None = None,
) -> Rig:
    """Build a run whose Gemini, verifier, S3 and registry follow the given scripts.

    Pass `s3` to share one bucket between two rigs (a second run that finds the first one's files).
    """
    clock = Clock()
    fake_gemini = FakeGemini(list(gemini))
    fake_verifier = ScriptedVerifier(list(verifier))
    s3 = s3 if s3 is not None else FakeS3()
    registry = MemoryRegistry(limit=registry_limit, fail=registry_error)
    events: list[SseEvent] = []
    animation_contract = contract()
    req = request or (puzzle_request() if kind == "puzzle" else lesson_request())
    run = RunContext.create(
        req,
        contract=animation_contract,
        owner_id=OWNER,
        request_hash=canonical_hash(req, animation_contract.contract_version),
        ai=make_ai(fake_gemini, clock, timeout_ms=ai_timeout_ms, deadline_ms=ai_deadline_ms),
        models=(MODEL,),
        verifier=fake_verifier,
        store=S3AnimationStore(s3.bucket, s3.region, client=s3, now=lambda: FIXED_NOW),
        registry=registry,
        max_attempts=max_attempts,
        deadline_ms=deadline_ms,
        clock=clock,
        emit=events.append,
        cancelled=cancelled,
    )
    return Rig(run, clock, fake_gemini, fake_verifier, s3, registry, events)


# --- logs -------------------------------------------------------------------------------------


def animation_log_lines(caplog: pytest.LogCaptureFixture) -> list[dict[str, Any]]:
    """The JSON lines of the `lore.animation` logger, parsed, in order."""
    return [
        json.loads(record.getMessage())
        for record in caplog.records
        if record.name == "lore.animation" and record.getMessage().startswith("{")
    ]


def all_log_text(caplog: pytest.LogCaptureFixture) -> str:
    """Every captured record as one string, for asserting a sentinel is nowhere in it."""
    return "\n".join(record.getMessage() for record in caplog.records)
