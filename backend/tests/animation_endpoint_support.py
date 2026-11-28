"""Builders and doubles for the animation endpoint tests (no network, no Postgres, no AWS).

Why: `POST /api/v1/ai/animations` is a wiring of the entry guard, the registry, two limiters, the
agent and the stream, and its tests need the whole application with every outside system replaced
at the seam the production code already has (task 18.3, design 6.10). One definition here keeps the
endpoint tests short and makes them agree on what each double does. Nothing patches a module global:

- Gemini: `FakeGemini` from `animation_agent_support` behind `app.state.ai_runtime`, the same point
  the JSON endpoint tests use, so the real `AiContext`, config and request body are exercised;
- verifier and S3: `ScriptedVerifier` and the in-memory `FakeS3` inside `S3AnimationStore`, both in
  an `AnimationRuntime` put on `app.state.animation_runtime`;
- registry: `FakeRegistryApi`, with the four functions of `app.ai.animation.registry` the endpoint
  uses (`find`, `count`, `get`, `register`) and the rules of `register`, plus scripted delay and
  failure per operation
  and a record of which thread each call ran on. It is given the engine and limits the endpoint
  passes, so a test can check that they are `app.state.db_engine` and `app.state.animation_limits`;
- the graph: the runtime's `graph` factory returns `None`, so `run_agent` walks its plain driver and
  no test needs `langgraph`; the factory also counts how often a run asked for it;
- limiters: a second `AiLimiter` on a fake clock in `app.state.animation_limiter`, next to the real
  `app.state.ai_limiter`;
- the database: a throwaway SQLite engine object, because the endpoint only needs "an engine
  exists"; the fake registry never uses it.

`Exchange` drives one HTTP request straight into the ASGI application on the current event loop.
`TestClient` runs the app in another thread and cannot hold a stream open or hang up on it, which
the slot and disconnect tests need; the exchange can: it answers `receive()` with the request body
and then blocks until the test sets `disconnect`, and it records every message the app sends. It is
also what lets a ticker on the same loop measure how long the loop is blocked.

Typical use:

    world = build_world(monkeypatch, gemini=[fenced(source(1))], verifier=[verified()])
    response = world.client().post(PATH, json=lesson_body())
    assert events_of(response)[-1][0] == "done"
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import threading
import time
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx2
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine

from app.ai.animation.endpoint import AnimationRuntime
from app.ai.animation.limits import AnimationLimits
from app.ai.animation.models import AnimationRow, CreateAnimationRequest, canonical_hash
from app.ai.animation.registry import NewRow, QuotaExceeded, Registered
from app.ai.animation.store import S3AnimationStore
from app.ai.limits import AiLimiter, AiLimits
from app.ai.runtime import AiRuntime
from app.main import create_app
from app.owner import COOKIE_NAME
from tests.ai_support import FakeClock, configure_env
from tests.animation_agent_support import (
    FIXED_NOW,
    OWNER,
    FakeGemini,
    GeminiReply,
    ScriptedVerifier,
    VerifierStep,
    contract,
)
from tests.animation_sse_support import parse_stream
from tests.fake_s3 import FakeS3

PATH = "/api/v1/ai/animations"
IP = "203.0.113.7"  # the client address an `Exchange` reports
TEST_IP = "testclient"  # what Starlette's `TestClient` reports as the client address
OTHER_OWNER = uuid.UUID("99999999-8888-4777-8666-555555555555")
FIXTURES = Path(__file__).parent / "fixtures" / "animation"

ANIMATION_ENV = (
    "ANIMATION_ENABLED",
    "ANIMATION_BUCKET",
    "ANIMATION_VERIFIER_FUNCTION",
    "AWS_REGION",
    "ANIMATION_RATE_PER_MINUTE_IP",
    "ANIMATION_DAILY_PER_IP",
    "ANIMATION_MAX_CONCURRENT_PER_IP",
    "ANIMATION_MAX_CONCURRENT_GLOBAL",
    "ANIMATION_MAX_ATTEMPTS",
    "ANIMATION_DEADLINE_MS",
    "AI_ANIMATION_MODEL",
)

# Roomy limits for tests that are not about a limit: nothing here refuses by accident.
ROOMY = AiLimits(
    per_minute_ip=100,
    per_minute_owner=100,
    daily_per_ip=100,
    max_concurrent_per_ip=5,
    max_concurrent_global=5,
)

REGISTRY_OPERATIONS = ("find", "count", "get", "register")


# --- request bodies and rows ---------------------------------------------------------------------


def request_body(name: str = "request-valid-lesson-minimal.json") -> dict[str, Any]:
    """A valid request body from the shared fixtures (the one the frontend tests also read)."""
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def puzzle_body() -> dict[str, Any]:
    return request_body("request-valid-puzzle-full.json")


def hash_of(body: dict[str, Any]) -> str:
    """The Request_Hash the endpoint computes for `body`."""
    request = CreateAnimationRequest.model_validate(body)
    return canonical_hash(request, contract().contract_version)


def make_row(
    owner: uuid.UUID,
    request_hash: str,
    *,
    row_id: str = "3f8e2b1c-6d4a-4e5f-9a7b-0c1d2e3f4a5b",
    attempts: int = 3,
    kind: str = "lesson",
    model: str = "recorded-model",
) -> AnimationRow:
    """A registry row as the Idempotent_Hit reads it. `attempts` is the recorded value."""
    meta: dict[str, Any] = {"width": 1280, "height": 720, "fps": 30, "durationInFrames": 150}
    if kind == "puzzle":
        meta["pauseAtFrame"] = 120
    source_sha = "a27321c1c0f1407c835394676fb809e185474ec0c0ce213e0c7cffedfa857750"
    return AnimationRow(
        id=row_id,
        owner_id=owner,
        request_hash=request_hash,
        source_sha256=source_sha,
        bundle_sha256="9aecee4acec55281859c57184dec790783d3c59b71aaf923de28e1d8b0dc9b73",
        s3_prefix=f"animations/v1/{source_sha[:2]}/{source_sha}/",
        kind=kind,  # type: ignore[arg-type]
        meta=meta,
        attempts=attempts,
        model=model,
        verifier_version="0.1.0",
        contract_version=contract().contract_version,
        runtime_version={"react": "19.3.0", "remotion": "4.0.543"},
        source_bytes=120,
        bundle_bytes=240,
        created_at=1_700_000_000_000,
    )


# --- registry ------------------------------------------------------------------------------------


@dataclass
class FakeRegistryApi:
    """`find`, `count`, `get` and `register` of `app.ai.animation.registry`, in memory.

    `register` follows the real rules: a repeat of `(owner, request_hash)` returns the stored row
    (`created=False`) without looking at the quota, then the quota (`>= owner_max_animations`),
    then the insert. `get` returns a row only for the owner it belongs to, like the real SQL.
    `delay_s[op]` blocks the calling thread with `time.sleep`; `fail[op]` raises. Every call is
    recorded with the thread it ran on, so a test can show that it left the loop.
    """

    rows: list[AnimationRow] = field(default_factory=list)
    delay_s: dict[str, float] = field(default_factory=dict)
    fail: dict[str, Exception] = field(default_factory=dict)
    calls: list[tuple[str, int]] = field(default_factory=list)
    registered: list[tuple[Engine, NewRow, AnimationLimits]] = field(default_factory=list)
    found: list[tuple[Engine, uuid.UUID, str]] = field(default_factory=list)
    fetched: list[tuple[Engine, uuid.UUID, str]] = field(default_factory=list)

    def ops(self) -> list[str]:
        return [op for op, _ in self.calls]

    def threads(self) -> set[int]:
        return {thread for _, thread in self.calls}

    def _enter(self, op: str) -> None:
        self.calls.append((op, threading.get_ident()))
        if op in self.delay_s:
            time.sleep(self.delay_s[op])
        if op in self.fail:
            raise self.fail[op]

    def find(self, engine: Engine, owner: uuid.UUID, request_hash: str) -> AnimationRow | None:
        self._enter("find")
        self.found.append((engine, owner, request_hash))
        for row in self.rows:
            if (row.owner_id, row.request_hash) == (owner, request_hash):
                return row
        return None

    def count(self, engine: Engine, owner: uuid.UUID) -> int:
        self._enter("count")
        return sum(1 for row in self.rows if row.owner_id == owner)

    def get(self, engine: Engine, owner: uuid.UUID, animation_id: str) -> AnimationRow | None:
        self._enter("get")
        self.fetched.append((engine, owner, animation_id))
        for row in self.rows:
            if (row.id, row.owner_id) == (animation_id, owner):
                return row
        return None

    def register(
        self, engine: Engine, row: NewRow, limits: AnimationLimits
    ) -> Registered | QuotaExceeded:
        self._enter("register")
        self.registered.append((engine, row, limits))
        for existing in self.rows:
            if (existing.owner_id, existing.request_hash) == (row.owner_id, row.request_hash):
                return Registered(existing, created=False)
        if sum(1 for item in self.rows if item.owner_id == row.owner_id) >= (
            limits.owner_max_animations
        ):
            return QuotaExceeded()
        stored = AnimationRow(**{**dataclasses.asdict(row), "created_at": 1_700_000_000_000})
        self.rows.append(stored)
        return Registered(stored, created=True)


# --- the world -----------------------------------------------------------------------------------


@dataclass
class World:
    """One application with every outside system replaced, and the doubles for assertions."""

    app: FastAPI
    gemini: FakeGemini
    verifier: ScriptedVerifier
    s3: FakeS3
    registry: FakeRegistryApi
    limiter: AiLimiter  # app.state.animation_limiter
    ai_limiter: AiLimiter  # app.state.ai_limiter
    clock: FakeClock
    graph_requests: list[int]

    def client(self, owner: uuid.UUID | None = OWNER) -> TestClient:
        """A test client that already carries the `lore_device` cookie of `owner`."""
        client = TestClient(self.app)
        if owner is not None:
            client.cookies.set(COOKIE_NAME, str(owner))
        return client

    def untouched_outside(self) -> bool:
        """True when no Gemini call, verifier call or S3 call happened."""
        return not (self.gemini.requests or self.verifier.payloads or self.s3.calls)


async def _no_sleep(_seconds: float) -> None:
    return None


def build_world(
    monkeypatch: pytest.MonkeyPatch,
    *,
    enabled: bool = True,
    bucket: str | None = None,
    function: str = "lore-verifier",
    region: str = "ap-southeast-3",
    provider: bool = True,
    with_engine: bool = True,
    gemini: Sequence[GeminiReply] = (),
    verifier: Sequence[VerifierStep] = (),
    limits: AiLimits = ROOMY,
    animation_limits: AnimationLimits | None = None,
    rows: Sequence[AnimationRow] = (),
    env: dict[str, str] | None = None,
) -> World:
    """An application whose animation endpoint runs on the doubles above.

    `enabled` and the three AWS settings go to the environment (the endpoint reads it on every
    request); `with_engine=False` leaves the application without a database engine; `provider`
    False removes the Gemini key. `env` adds or overrides environment variables.
    """
    configure_env(monkeypatch, configured=provider)
    for name in ANIMATION_ENV:
        monkeypatch.delenv(name, raising=False)
    s3 = FakeS3()
    monkeypatch.setenv("ANIMATION_ENABLED", "true" if enabled else "false")
    monkeypatch.setenv("ANIMATION_BUCKET", s3.bucket if bucket is None else bucket)
    monkeypatch.setenv("ANIMATION_VERIFIER_FUNCTION", function)
    monkeypatch.setenv("AWS_REGION", region)
    for name, value in (env or {}).items():
        monkeypatch.setenv(name, value)

    clock = FakeClock()
    fake_gemini = FakeGemini(list(gemini))
    fake_verifier = ScriptedVerifier(list(verifier))
    registry = FakeRegistryApi(rows=list(rows))
    graph_requests: list[int] = []

    def graph() -> None:  # `None` makes `run_agent` use its plain driver
        graph_requests.append(1)

    application = create_app(create_engine("sqlite:///:memory:") if with_engine else None)
    limiter = AiLimiter(limits, monotonic=clock, wall=clock)
    application.state.animation_limiter = limiter
    if animation_limits is not None:
        application.state.animation_limits = animation_limits
    application.state.ai_runtime = AiRuntime(
        http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(fake_gemini.handler)),
        sleep=_no_sleep,
    )
    application.state.animation_runtime = AnimationRuntime(
        store=S3AnimationStore(s3.bucket, s3.region, client=s3, now=lambda: FIXED_NOW),
        verifier=fake_verifier,
        registry=registry,
        graph=graph,
    )
    return World(
        app=application,
        gemini=fake_gemini,
        verifier=fake_verifier,
        s3=s3,
        registry=registry,
        limiter=limiter,
        ai_limiter=application.state.ai_limiter,
        clock=clock,
        graph_requests=graph_requests,
    )


# --- reading a response --------------------------------------------------------------------------


def events_of(response: httpx2.Response) -> list[tuple[str, dict[str, Any]]]:
    """The `(name, data)` events of a finished stream, read with the reference parser."""
    return [(event.event, json.loads(event.data)) for event in parse_stream(response.content)]


def event_names(response: httpx2.Response) -> list[str]:
    return [name for name, _ in events_of(response)]


def error_of(response: httpx2.Response) -> dict[str, Any]:
    """The `error` object of a pre-stream refusal (a JSON envelope)."""
    body = response.json()
    assert body["ok"] is False, body
    return body["error"]


# --- a request driven straight into the ASGI app -------------------------------------------------


class Exchange:
    """One request sent to the ASGI application on the running loop, with a client that can hang up.

    The method is POST unless `method` says otherwise (a GET takes `b""` as its body).
    `receive()` returns the body and then blocks until `disconnect` is set, like a server that has
    a client still connected; `send()` records every message. Use `start()` inside a coroutine,
    `await exchange.wait_for(...)` to look at the stream while it runs, `hang_up()` to leave, and
    `await exchange.finished()` for the end of the application call.
    """

    def __init__(
        self,
        application: FastAPI,
        body: bytes | dict[str, Any],
        *,
        path: str = PATH,
        owner: uuid.UUID | None = OWNER,
        ip: str = IP,
        method: str = "POST",
    ) -> None:
        raw = body if isinstance(body, bytes) else json.dumps(body).encode()
        headers = [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(raw)).encode()),
        ]
        if owner is not None:
            headers.append((b"cookie", f"{COOKIE_NAME}={owner}".encode()))
        self._application = application
        self._body = raw
        self._scope: dict[str, Any] = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "method": method,
            "scheme": "http",
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"",
            "root_path": "",
            "headers": headers,
            "client": (ip, 50_000),
            "server": ("testserver", 80),
            "state": {},
        }
        self._body_given = False
        self.disconnect = asyncio.Event()
        self.messages: list[dict[str, Any]] = []
        self._changed = asyncio.Event()
        self._task: asyncio.Task[None] | None = None

    async def _receive(self) -> dict[str, Any]:
        if not self._body_given:
            self._body_given = True
            return {"type": "http.request", "body": self._body, "more_body": False}
        await self.disconnect.wait()
        return {"type": "http.disconnect"}

    async def _send(self, message: dict[str, Any]) -> None:
        self.messages.append(message)
        self._changed.set()

    def start(self) -> asyncio.Task[None]:
        self._task = asyncio.create_task(
            self._application(self._scope, self._receive, self._send), name="exchange"
        )
        return self._task

    async def run(self) -> None:
        """Send the request and wait until the application call returns."""
        await self.start()

    def hang_up(self) -> None:
        self.disconnect.set()

    async def finished(self, timeout: float = 5.0) -> None:
        assert self._task is not None
        await asyncio.wait_for(asyncio.shield(self._task), timeout)

    async def wait_for(self, condition: Callable[[], bool], timeout: float = 5.0) -> None:
        """Wait until `condition()` is true, looking again after every message sent."""
        async with asyncio.timeout(timeout):
            while not condition():
                self._changed.clear()
                if condition():
                    break
                await self._changed.wait()

    @property
    def status(self) -> int:
        for message in self.messages:
            if message["type"] == "http.response.start":
                return int(message["status"])
        raise AssertionError("no response has started")

    @property
    def headers(self) -> dict[str, str]:
        for message in self.messages:
            if message["type"] == "http.response.start":
                return {k.decode().lower(): v.decode() for k, v in message["headers"]}
        raise AssertionError("no response has started")

    @property
    def body(self) -> bytes:
        return b"".join(
            message.get("body", b"")
            for message in self.messages
            if message["type"] == "http.response.body"
        )

    def events(self) -> list[tuple[str, dict[str, Any]]]:
        return [(e.event, json.loads(e.data)) for e in parse_stream(self.body)]

    def event_names(self) -> list[str]:
        return [name for name, _ in self.events()]


def record_limiter_calls(
    monkeypatch: pytest.MonkeyPatch, limiter: AiLimiter
) -> list[tuple[str, tuple[Any, ...]]]:
    """Record every call on the limiter, in order, and still run the real method."""
    calls: list[tuple[str, tuple[Any, ...]]] = []
    for name in ("check_rate", "try_acquire", "check_daily", "release"):
        real = getattr(limiter, name)

        def wrapper(*args: Any, _name: str = name, _real: Any = real) -> Any:
            calls.append((_name, args))
            return _real(*args)

        monkeypatch.setattr(limiter, name, wrapper)
    return calls


async def ticker(stop: asyncio.Event, interval: float = 0.01) -> float:
    """Tick on the running loop until `stop`; return the longest delay beyond `interval`.

    A loop that is blocked for 500 ms shows up as a delay of about 0.5 s, so this measures how
    long the loop could not run other tasks (Requirement 15.17).
    """
    loop = asyncio.get_running_loop()
    worst = 0.0
    last = loop.time()
    while not stop.is_set():
        await asyncio.sleep(interval)
        now = loop.time()
        worst = max(worst, now - last - interval)
        last = now
    return worst
