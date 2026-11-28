"""Tests for `pipeline.entry_guard`, the check shared by the JSON and the streaming handlers.

Why: the lesson-animation endpoint streams SSE, but it must pass the same door as the JSON AI
endpoints: per-minute rate -> bounded body (413) -> JSON (400) -> model (400) -> provider ready
(503) (Requirement 15.4, 15.6). The check lives in one function, `entry_guard`, so the two cannot
drift apart (Requirement 39.2). These tests pin three things:

- the JSON handler (`_handle`) goes through `pipeline.entry_guard`, passing its own limiter,
  request model and body limit, then takes the slot and the daily quota exactly as before;
- the guard answers in the fixed order for every combination of failing checks, and uses only
  the limiter its caller gives it (Requirement 15.14);
- the guard itself takes no concurrency slot and no daily quota.

The streaming handler (`app/ai/animation/endpoint.py`) does not exist yet. `add_stream_stand_in`
below is a minimal route that calls the guard the way design 6.10 prescribes (animation limiter,
`ANIMATION_BODY_BYTES`); it exercises the guard with a second limiter and body limit. When the real
handler lands, its own spy test belongs in that task's test file. The tests that only describe
behaviour that already existed before the extraction (limiter call order, error mapping) pass
both before and after the refactor.
"""

from __future__ import annotations

import dataclasses
import itertools
import json
import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import httpx2
import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from pydantic import BaseModel

import app.ai.routes as routes
from app.ai import pipeline
from app.ai.envelope import NOT_CONFIGURED_MESSAGE, AiError, AiOk, AiResult, to_response
from app.ai.limits import ANALYZE_MATERIAL_BODY_BYTES, ANIMATION_BODY_BYTES, AiLimiter, AiLimits
from app.ai.pipeline import AiEndpoint
from app.ai.runtime import AiContext
from app.ai.settings import GeminiConfig
from app.owner import COOKIE_NAME
from tests.ai_support import ENDPOINT, FakeGemini, build_app, gemini_reply, load_fixture

TEST_IP = "testclient"  # what Starlette's TestClient reports as the client address
JSON = {"content-type": "application/json"}
STREAM_PATH = "/api/v1/animations/entry-guard-probe"  # under a PROTECTED_PREFIX (cookie issued)
JSON_PROBE_PATH = "/api/v1/ai/entry-guard-probe"
PROBE_BODY_LIMIT = 4096
REQUEST = load_fixture("analyze-material.request.json")
GEMINI_OUTPUT = load_fixture("analyze-material.gemini-output.json")
GUARD_ORDER = ("rate", "body", "json", "model", "provider")


class ProbeRequest(BaseModel):
    """A tiny request model for the two probe routes."""

    value: int


def ok_handler(_request: httpx2.Request) -> httpx2.Response:
    return gemini_reply(GEMINI_OUTPUT)


# --- test wiring --------------------------------------------------------------------------------


@dataclass
class World:
    """One app with a second limiter and two probe routes next to the real AI routes."""

    app: FastAPI
    client: TestClient
    ai: AiLimiter  # app.state.ai_limiter: used by the JSON handler
    anim: AiLimiter  # app.state.animation_limiter: used by the streaming stand-in
    gemini: FakeGemini
    accepted: list[Any]  # what the guard accepted on the stream stand-in


def add_stream_stand_in(app: FastAPI) -> None:
    """A route that calls the guard like the streaming handler will (design 6.10)."""

    @app.post(STREAM_PATH, include_in_schema=False)
    async def stream_probe(request: Request) -> JSONResponse:
        accepted = await pipeline.entry_guard(
            request,
            limiter=request.app.state.animation_limiter,
            request_model=ProbeRequest,
            body_limit=ANIMATION_BODY_BYTES,
        )
        if isinstance(accepted, AiError):
            return to_response(accepted)
        request.app.state.accepted.append(accepted)
        return JSONResponse({"ok": True})


def add_json_probe(app: FastAPI, run: Callable[[ProbeRequest, AiContext], Any]) -> None:
    """A JSON endpoint over `handle_ai_request` whose `run` the test supplies."""
    endpoint = AiEndpoint(
        name="entry-guard-probe",
        request_model=ProbeRequest,
        body_limit=PROBE_BODY_LIMIT,
        run=run,
    )

    @app.post(JSON_PROBE_PATH, include_in_schema=False)
    async def json_probe(request: Request) -> JSONResponse:
        return await pipeline.handle_ai_request(request, endpoint)


async def _unused_run(_model: ProbeRequest, _ctx: AiContext) -> AiResult:
    return AiOk({})


def make_world(
    monkeypatch: pytest.MonkeyPatch,
    *,
    handler: Callable[[httpx2.Request], httpx2.Response] = ok_handler,
    ai_limits: AiLimits | None = None,
    anim_limits: AiLimits | None = None,
    configured: bool = True,
    probe_run: Callable[[ProbeRequest, AiContext], Any] = _unused_run,
) -> World:
    app, gemini, ai, clock = build_app(
        monkeypatch, handler, limits=ai_limits, configured=configured
    )
    anim = AiLimiter(anim_limits or AiLimits(), monotonic=clock, wall=clock)
    app.state.animation_limiter = anim
    app.state.accepted = []
    add_stream_stand_in(app)
    add_json_probe(app, probe_run)
    return World(app, TestClient(app), ai, anim, gemini, app.state.accepted)


def post(world: World, path: str, body: bytes | dict[str, Any]) -> httpx2.Response:
    raw = body if isinstance(body, bytes) else json.dumps(body).encode()
    return world.client.post(path, content=raw, headers=JSON)


@dataclass
class GuardCall:
    path: str
    limiter: AiLimiter
    request_model: type[BaseModel]
    body_limit: int


def spy_on_entry_guard(monkeypatch: pytest.MonkeyPatch) -> list[GuardCall]:
    """Replace `pipeline.entry_guard` with a recorder that still runs the real guard."""
    real = pipeline.entry_guard
    calls: list[GuardCall] = []

    async def spy(
        request: Request, *, limiter: AiLimiter, request_model: type[BaseModel], body_limit: int
    ) -> Any:
        calls.append(GuardCall(request.url.path, limiter, request_model, body_limit))
        return await real(
            request, limiter=limiter, request_model=request_model, body_limit=body_limit
        )

    monkeypatch.setattr(pipeline, "entry_guard", spy)
    return calls


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


def names(calls: list[tuple[str, tuple[Any, ...]]]) -> list[str]:
    return [name for name, _ in calls]


def error_of(response: httpx2.Response) -> dict[str, Any]:
    body = response.json()
    assert body["ok"] is False
    return body["error"]


# --- Accepted -----------------------------------------------------------------------------------


def test_accepted_is_a_frozen_dataclass_with_the_designed_fields() -> None:
    assert dataclasses.is_dataclass(pipeline.Accepted)
    assert [f.name for f in dataclasses.fields(pipeline.Accepted)] == [
        "model",
        "config",
        "ip",
        "owner",
    ]
    accepted = pipeline.Accepted(
        model=ProbeRequest(value=1),
        config=GeminiConfig(api_key="k", models=("m",), timeout_ms=1.0),
        ip="198.51.100.1",
        owner=uuid.UUID(int=1),
    )
    with pytest.raises(dataclasses.FrozenInstanceError):
        accepted.ip = "other"  # type: ignore[misc]


# --- both handlers go through the same function ---------------------------------------------------


@pytest.mark.parametrize(
    ("path", "endpoint"),
    [
        ("/api/v1/ai/analyze-material", routes.ANALYZE_MATERIAL),
        ("/api/v1/ai/plan-campaign", routes.PLAN_CAMPAIGN),
        ("/api/v1/ai/generate-story", routes.GENERATE_STORY),
    ],
)
def test_json_handler_calls_the_guard_with_its_own_limiter_model_and_limit(
    monkeypatch: pytest.MonkeyPatch, path: str, endpoint: AiEndpoint[Any]
) -> None:
    world = make_world(monkeypatch)
    calls = spy_on_entry_guard(monkeypatch)
    response = post(world, path, {})
    assert response.status_code == 400
    assert len(calls) == 1
    assert calls[0].path == path
    assert calls[0].limiter is world.ai
    assert calls[0].request_model is endpoint.request_model
    assert calls[0].body_limit == endpoint.body_limit


def test_streaming_stand_in_calls_the_same_function_with_different_arguments(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world = make_world(monkeypatch)
    calls = spy_on_entry_guard(monkeypatch)  # one spy replaces the one function both use
    assert post(world, ENDPOINT, {}).status_code == 400
    assert post(world, STREAM_PATH, {}).status_code == 400
    assert [c.path for c in calls] == [ENDPOINT, STREAM_PATH]
    json_call, stream_call = calls
    assert json_call.limiter is world.ai
    assert stream_call.limiter is world.anim
    assert json_call.limiter is not stream_call.limiter
    assert json_call.request_model is not stream_call.request_model
    assert (json_call.body_limit, stream_call.body_limit) == (
        ANALYZE_MATERIAL_BODY_BYTES,
        ANIMATION_BODY_BYTES,
    )


# --- order of checks: rate -> body -> JSON -> model -> provider ----------------------------------


@dataclass(frozen=True)
class Target:
    name: str
    path: str
    body_limit: int
    valid_body: bytes


JSON_TARGET = Target("json", ENDPOINT, ANALYZE_MATERIAL_BODY_BYTES, json.dumps(REQUEST).encode())
STREAM_TARGET = Target("stream", STREAM_PATH, ANIMATION_BODY_BYTES, b'{"value": 1}')
TARGETS = {"json": JSON_TARGET, "stream": STREAM_TARGET}

# (status, code, message). The rate answer has a fixed shape but its text is the limiter's.
EXPECTED: dict[str, tuple[int, str, str | None]] = {
    "rate": (429, "RATE_LIMITED", None),
    "body": (413, "INVALID_REQUEST", "Request body is too large"),
    "json": (400, "INVALID_REQUEST", "Request body must be valid JSON"),
    "model": (400, "INVALID_REQUEST", "Invalid request body"),
    "provider": (503, "PROVIDER_NOT_CONFIGURED", NOT_CONFIGURED_MESSAGE),
}


def body_failing(target: Target, failing: frozenset[str]) -> bytes:
    """A body that fails every body-related check named in `failing`.

    An oversized body also fails the model (it cannot be a valid request), which is harmless:
    the expected answer is always the earliest failing check.
    """
    if "body" in failing:
        padding = b"x" * (target.body_limit + 1)
        closing = b"" if "json" in failing else b'"}'
        return b'{"pad":"' + padding + closing
    if "json" in failing:
        return b"{not json"
    if "model" in failing:
        return b"{}"
    return target.valid_body


def all_failure_sets() -> list[frozenset[str]]:
    return [
        frozenset(combo)
        for size in range(1, len(GUARD_ORDER) + 1)
        for combo in itertools.combinations(GUARD_ORDER, size)
    ]


@pytest.mark.parametrize("target_name", ["json", "stream"])
@pytest.mark.parametrize("failing", all_failure_sets(), ids=lambda s: "+".join(sorted(s)))
def test_guard_answers_with_the_earliest_failing_check(
    monkeypatch: pytest.MonkeyPatch, target_name: str, failing: frozenset[str]
) -> None:
    target = TARGETS[target_name]
    limits = AiLimits(per_minute_ip=1, daily_per_ip=1)
    world = make_world(
        monkeypatch,
        ai_limits=limits,
        anim_limits=limits,
        configured="provider" not in failing,
    )
    limiter = world.ai if target_name == "json" else world.anim
    if "rate" in failing:
        assert limiter.check_rate(TEST_IP, "another-owner") is None  # fills the one-request window

    response = post(world, target.path, body_failing(target, failing))

    earliest = next(stage for stage in GUARD_ORDER if stage in failing)
    status, code, message = EXPECTED[earliest]
    error = error_of(response)
    assert (response.status_code, error["code"]) == (status, code)
    if message is not None:
        assert error["message"] == message
    if earliest == "rate":
        assert int(response.headers["retry-after"]) >= 1
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["content-type"].startswith("application/json")
    # A refused request never reaches Gemini, holds a slot or spends the daily quota.
    assert world.gemini.requests == []
    assert (world.ai.in_flight(), world.anim.in_flight()) == (0, 0)
    assert limiter.check_daily(TEST_IP) is None


# --- the limiter is the caller's ------------------------------------------------------------------


@pytest.mark.parametrize("first", ["json", "stream"])
def test_each_handler_spends_only_the_rate_window_of_its_own_limiter(
    monkeypatch: pytest.MonkeyPatch, first: str
) -> None:
    limits = AiLimits(per_minute_ip=2, per_minute_owner=2)
    world = make_world(monkeypatch, ai_limits=limits, anim_limits=limits)
    order = [TARGETS[first], TARGETS["stream" if first == "json" else "json"]]
    for target in order:
        for _ in range(2):  # a body of {} passes the rate check and fails the model (400)
            assert post(world, target.path, {}).status_code == 400
    for target in order:  # each window is now full, but only its own
        response = post(world, target.path, {})
        assert (response.status_code, error_of(response)["code"]) == (429, "RATE_LIMITED")
    assert (world.ai.in_flight(), world.anim.in_flight()) == (0, 0)


def test_json_handler_holds_its_slot_on_the_ai_limiter_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    limiters: list[AiLimiter] = []
    seen: list[tuple[int, ...]] = []

    def handler(_request: httpx2.Request) -> httpx2.Response:
        seen.append(tuple(limiter.in_flight() for limiter in limiters))
        return gemini_reply(GEMINI_OUTPUT)

    world = make_world(monkeypatch, handler=handler)
    limiters.extend([world.ai, world.anim])
    assert post(world, ENDPOINT, REQUEST).status_code == 200
    assert seen == [(1, 0)]
    assert (world.ai.in_flight(), world.anim.in_flight()) == (0, 0)


def test_guard_accepts_a_valid_request_without_taking_a_slot_or_the_daily_quota(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    limits = AiLimits(daily_per_ip=1)
    world = make_world(monkeypatch, anim_limits=limits)
    response = post(world, STREAM_PATH, {"value": 1})
    assert response.status_code == 200
    (accepted,) = world.accepted
    assert isinstance(accepted, pipeline.Accepted)
    assert accepted.model == ProbeRequest(value=1)
    assert isinstance(accepted.config, GeminiConfig)
    assert accepted.ip == TEST_IP
    assert str(accepted.owner) == world.client.cookies.get(COOKIE_NAME)
    assert world.anim.in_flight() == 0
    assert world.anim.check_daily(TEST_IP) is None  # the one daily request is still unspent
    assert world.anim.check_daily(TEST_IP) is not None


# --- the JSON handler keeps its behaviour after the guard ----------------------------------------


def test_json_success_takes_rate_slot_daily_and_release_once_each_in_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world = make_world(monkeypatch)
    calls = record_limiter_calls(monkeypatch, world.ai)
    assert post(world, ENDPOINT, REQUEST).status_code == 200
    assert names(calls) == ["check_rate", "try_acquire", "check_daily", "release"]
    owner = world.client.cookies.get(COOKIE_NAME)
    assert calls[0][1] == (TEST_IP, owner)
    assert [args for _, args in calls[1:]] == [(TEST_IP,)] * 3
    assert len(world.gemini.requests) == 1


def test_json_daily_quota_refusal_still_releases_the_slot(monkeypatch: pytest.MonkeyPatch) -> None:
    world = make_world(monkeypatch, ai_limits=AiLimits(daily_per_ip=1))
    assert world.ai.check_daily(TEST_IP) is None  # today's only request is already spent
    calls = record_limiter_calls(monkeypatch, world.ai)
    response = post(world, ENDPOINT, REQUEST)
    assert (response.status_code, error_of(response)["detail"]["scope"]) == (429, "daily")
    assert names(calls) == ["check_rate", "try_acquire", "check_daily", "release"]
    assert world.ai.in_flight() == 0
    assert world.gemini.requests == []


def test_json_concurrency_refusal_does_not_release_a_slot_it_never_took(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world = make_world(monkeypatch, ai_limits=AiLimits(max_concurrent_per_ip=1))
    assert world.ai.try_acquire(TEST_IP) is None  # someone else holds the only slot
    calls = record_limiter_calls(monkeypatch, world.ai)
    response = post(world, ENDPOINT, REQUEST)
    assert (response.status_code, error_of(response)["detail"]["scope"]) == (429, "concurrency-ip")
    assert response.headers["retry-after"] == "5"
    assert names(calls) == ["check_rate", "try_acquire"]
    assert world.ai.in_flight() == 1  # still only the other holder's slot
    assert world.gemini.requests == []


def test_json_guard_refusal_stops_before_slot_and_daily_quota(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world = make_world(monkeypatch, configured=False)
    calls = record_limiter_calls(monkeypatch, world.ai)
    response = post(world, ENDPOINT, REQUEST)
    assert (response.status_code, error_of(response)["code"]) == (503, "PROVIDER_NOT_CONFIGURED")
    assert names(calls) == ["check_rate"]


def test_json_service_exception_is_a_500_and_the_slot_is_released(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    async def boom(_model: ProbeRequest, _ctx: AiContext) -> AiResult:
        raise RuntimeError("secret-from-the-service")

    world = make_world(monkeypatch, probe_run=boom)
    calls = record_limiter_calls(monkeypatch, world.ai)
    with caplog.at_level(logging.ERROR, logger="lore.ai"):
        response = post(world, JSON_PROBE_PATH, {"value": 1})
    assert response.status_code == 500
    assert error_of(response) == {"code": "UNKNOWN", "message": "Internal server error"}
    assert "secret-from-the-service" not in response.text + caplog.text
    assert names(calls) == ["check_rate", "try_acquire", "check_daily", "release"]
    assert world.ai.in_flight() == 0


# --- `_handle` uses exactly what the guard returns -----------------------------------------------


def test_json_handler_returns_a_guard_error_untouched_and_takes_no_slot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ran: list[ProbeRequest] = []

    async def run(model: ProbeRequest, _ctx: AiContext) -> AiResult:
        ran.append(model)
        return AiOk({})

    world = make_world(monkeypatch, probe_run=run)
    refusal = AiError("RATE_LIMITED", "stub", {"scope": "stub"}, status=429, headers={"X-A": "1"})

    async def refusing_guard(_request: Request, **_kwargs: Any) -> AiError:
        return refusal

    monkeypatch.setattr(pipeline, "entry_guard", refusing_guard)
    calls = record_limiter_calls(monkeypatch, world.ai)
    response = post(world, JSON_PROBE_PATH, {"value": 1})
    assert response.status_code == 429
    assert response.headers["x-a"] == "1"
    assert error_of(response) == {
        "code": "RATE_LIMITED",
        "message": "stub",
        "detail": {"scope": "stub"},
    }
    assert ran == []
    assert calls == []


def test_json_handler_runs_the_service_with_the_guards_model_config_and_ip(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = GeminiConfig(api_key="k", models=("forged",), timeout_ms=1.0)
    forged = pipeline.Accepted(
        model=ProbeRequest(value=7), config=config, ip="203.0.113.9", owner=uuid.UUID(int=7)
    )
    ran: list[tuple[ProbeRequest, AiContext]] = []

    async def run(model: ProbeRequest, ctx: AiContext) -> AiResult:
        ran.append((model, ctx))
        return AiOk({"echo": model.value})

    world = make_world(monkeypatch, probe_run=run)

    async def fixed_guard(_request: Request, **_kwargs: Any) -> pipeline.Accepted[ProbeRequest]:
        return forged

    monkeypatch.setattr(pipeline, "entry_guard", fixed_guard)
    calls = record_limiter_calls(monkeypatch, world.ai)
    response = post(world, JSON_PROBE_PATH, {"value": 1})  # the real body is ignored by the stub
    assert response.status_code == 200
    assert response.json() == {"ok": True, "data": {"echo": 7}}
    assert len(ran) == 1
    model, ctx = ran[0]
    assert model == ProbeRequest(value=7)
    assert ctx.config is config
    assert ctx.runtime is world.app.state.ai_runtime
    # The slot and the daily quota are taken for the guard's IP, and `_handle` adds no rate check.
    assert calls == [
        ("try_acquire", ("203.0.113.9",)),
        ("check_daily", ("203.0.113.9",)),
        ("release", ("203.0.113.9",)),
    ]


def test_json_handler_turns_a_guard_exception_into_a_500_without_leaking_it(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    world = make_world(monkeypatch)

    async def exploding_guard(_request: Request, **_kwargs: Any) -> Any:
        raise RuntimeError("secret-from-the-guard")

    monkeypatch.setattr(pipeline, "entry_guard", exploding_guard)
    calls = record_limiter_calls(monkeypatch, world.ai)
    with caplog.at_level(logging.ERROR, logger="lore.ai"):
        response = post(world, ENDPOINT, REQUEST)
    assert response.status_code == 500
    assert error_of(response) == {"code": "UNKNOWN", "message": "Internal server error"}
    assert "secret-from-the-guard" not in response.text + caplog.text
    assert calls == []
    assert world.ai.in_flight() == 0
