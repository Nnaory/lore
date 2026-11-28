"""Tests for `POST /api/v1/ai/animations` as a whole (task 18.3; Requirements 15, 16, 17.11, 18).

Why: the endpoint is the one place where the entry guard, the registry, two limiters, the agent and
the stream meet, and a wrong order or a leaked slot there costs money or blocks a user. These tests
drive the real application (middleware, router, entry guard, limiter, agent, stream, S3 store) with
Gemini, the verifier, S3 and the registry replaced at the seams the production code already has
(see `animation_endpoint_support.py`), so no network, AWS package, `langgraph` or Postgres is
needed. They pin:

1. the order of the checks for every single and every pair of failing checks, and the answer each
   refusal gives (status, code, scope, `Retry-After`, `no-store`, never `text/event-stream`);
2. the flag and every other cause of `ANIMATION_NOT_CONFIGURED`, answered after the door checks and
   before anything is looked up, counted or called;
3. the Idempotent_Hit: only `started` and `done`, from the row, with no slot, no daily quota, no
   Gemini, no verifier, no S3, no graph;
4. the per-owner quota (422) and that it does not touch the project limits;
5. the slot: held for the whole run, given back exactly once whatever the end, and the two limiters
   do not share anything;
6. a client that hangs up: the agent is cancelled and the slot is back within one second, through
   the real `device_token_middleware` (finding T-14);
7. that the registry and the compilation of the graph run off the event loop;
8. that the real handler calls `pipeline.entry_guard` with keyword arguments;
9. that an unexpected failure before the stream is a 500 with a fixed message.

Streams are read with the reference parser of `animation_sse_support.py`. Tests that need to hold a
stream open or hang up use `Exchange`, which drives the ASGI app on the test's own event loop.
"""

from __future__ import annotations

import asyncio
import dataclasses
import itertools
import json
import logging
import threading
import time
from typing import Any

import httpx2
import pytest

import app.ai.animation.contract as contract_module
import app.ai.animation.endpoint as endpoint_module
from app import projects
from app.ai import pipeline
from app.ai.animation.agent import RunContext, build_graph
from app.ai.animation.endpoint import AnimationRuntime
from app.ai.animation.limits import AnimationLimits
from app.ai.animation.logging_ import BOTO_LOGGERS, RunLog
from app.ai.animation.models import CreateAnimationRequest, reference_from_row
from app.ai.animation.registry import RegistryError
from app.ai.animation.sse import RunHandle, SlotLease
from app.ai.animation.store import S3AnimationStore
from app.ai.animation.verifier_client import LambdaVerifierClient
from app.ai.contracts.requests import AnalyzeMaterialRequest
from app.ai.limits import ANALYZE_MATERIAL_BODY_BYTES, ANIMATION_BODY_BYTES, AiLimiter, AiLimits
from app.owner import COOKIE_NAME
from tests.animation_agent_support import (
    OWNER,
    all_log_text,
    animation_log_lines,
    fenced,
    rejected,
    source,
    verified,
)
from tests.animation_endpoint_support import (
    FIXTURES,
    OTHER_OWNER,
    PATH,
    TEST_IP,
    Exchange,
    World,
    build_world,
    error_of,
    event_names,
    events_of,
    hash_of,
    make_row,
    puzzle_body,
    record_limiter_calls,
    request_body,
    ticker,
)

ANALYZE_PATH = "/api/v1/ai/analyze-material"
NOT_CONFIGURED = {
    "code": "ANIMATION_NOT_CONFIGURED",
    "message": "Animations are not available on this server.",
}
FULL_RUN = ["started", "stage", "stage", "diagnostics", "stage", "done"]


def good_run(world_kwargs: dict[str, Any] | None = None) -> dict[str, Any]:
    """Keyword arguments of `build_world` for a run that verifies at once and publishes."""
    return {"gemini": [fenced(source(1))], "verifier": [verified()], **(world_kwargs or {})}


def post(world: World, body: Any = None, *, owner: Any = OWNER) -> httpx2.Response:
    return world.client(owner).post(PATH, json=request_body() if body is None else body)


def assert_json_refusal(response: httpx2.Response) -> None:
    """A pre-stream refusal is a JSON envelope that is never cached and never an event stream."""
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["content-type"].startswith("application/json")


# --- a run from start to end ---------------------------------------------------------------------


def test_a_valid_request_streams_one_run_and_publishes_the_animation(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    world = build_world(monkeypatch, **good_run())
    with caplog.at_level(logging.INFO, logger="lore.animation"):
        response = post(world)

    assert response.status_code == 200
    assert response.headers["content-type"] == "text/event-stream; charset=utf-8"
    assert response.headers["cache-control"] == "no-store, no-transform"
    assert response.headers["x-accel-buffering"] == "no"
    events = events_of(response)
    assert [name for name, _ in events] == FULL_RUN
    assert events[0][1] == {"max_attempts": 4, "deadline_ms": 240000, "cached": False}
    assert [data["stage"] for name, data in events if name == "stage"] == [
        "generating",
        "verifying",
        "publishing",
    ]
    (stored,) = world.registry.rows
    assert events[-1][1] == {
        "animation": reference_from_row(stored).dump(),
        "cached": False,
        "attempts": 1,
    }
    assert sorted(key.rsplit("/", 1)[1] for key in world.s3.objects) == [
        "main.js",
        "main.ts",
        "manifest.json",
    ]
    # The registry saw this application's engine and limits, not copies or defaults.
    ((engine, new_row, limits),) = world.registry.registered
    assert engine is world.app.state.db_engine
    assert limits is world.app.state.animation_limits
    assert new_row.owner_id == OWNER
    assert world.registry.ops() == ["find", "count", "register"]
    assert world.graph_requests == [1]
    assert len(world.gemini.requests) == 1
    assert (world.limiter.in_flight(), world.ai_limiter.in_flight()) == (0, 0)

    lines = animation_log_lines(caplog)
    assert [line["event"] for line in lines] == [
        "animation.start",
        "animation.attempt",
        "animation.end",
    ]
    assert lines[0]["kind"] == "lesson" and lines[0]["cached"] is False
    assert lines[1]["outcome"] == "verified"
    assert (lines[2]["code"], lines[2]["attempts"], lines[2]["model"]) == ("OK", 1, "test-model")


def test_a_puzzle_run_publishes_a_reference_with_its_pause_frame(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world = build_world(monkeypatch, gemini=[fenced(source(1))], verifier=[verified(kind="puzzle")])
    events = events_of(post(world, puzzle_body()))
    assert [name for name, _ in events] == FULL_RUN
    assert events[-1][1]["animation"]["pause_at_frame"] == 90


def test_the_started_event_and_the_models_follow_the_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world = build_world(
        monkeypatch,
        **good_run(
            {
                "env": {
                    "ANIMATION_MAX_ATTEMPTS": "2",
                    "ANIMATION_DEADLINE_MS": "120000",
                    "AI_ANIMATION_MODEL": "animation-model",
                }
            }
        ),
    )
    events = events_of(post(world))
    assert events[0] == ("started", {"max_attempts": 2, "deadline_ms": 120000, "cached": False})
    assert "animation-model" in str(world.gemini.requests[0].url)


def test_a_first_visitor_gets_the_device_cookie_and_owns_the_animation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world = build_world(monkeypatch, **good_run())
    response = post(world, owner=None)
    assert event_names(response) == FULL_RUN
    cookie = response.cookies.get(COOKIE_NAME)
    assert cookie is not None
    assert str(world.registry.rows[0].owner_id) == cookie


def test_a_failed_run_ends_in_one_error_event_and_writes_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world = build_world(
        monkeypatch,
        gemini=[fenced(source(1))],
        verifier=[rejected("TSC_2322")],
        env={"ANIMATION_MAX_ATTEMPTS": "1"},
    )
    events = events_of(post(world))
    assert [name for name, _ in events] == ["started", "stage", "stage", "diagnostics", "error"]
    assert events[-1][1] == {
        "code": "ANIMATION_VERIFICATION_FAILED",
        "message": "The animation could not be verified. The standard drawing will be used.",
        "attempts": 1,
    }
    assert world.s3.calls == [] and world.registry.registered == []
    assert world.limiter.in_flight() == 0


# --- the order of the checks ---------------------------------------------------------------------

CHECKS = (
    "rate",
    "body",
    "json",
    "model",
    "provider",
    "config",
    "quota",
    "concurrency",
    "daily",
)
# (status, code, scope of the limiter's answer or None)
EXPECTED: dict[str, tuple[int, str, str | None]] = {
    "rate": (429, "RATE_LIMITED", "ip"),
    "body": (413, "INVALID_REQUEST", None),
    "json": (400, "INVALID_REQUEST", None),
    "model": (400, "INVALID_REQUEST", None),
    "provider": (503, "PROVIDER_NOT_CONFIGURED", None),
    "config": (503, "ANIMATION_NOT_CONFIGURED", None),
    "quota": (422, "ANIMATION_QUOTA_EXCEEDED", None),
    "concurrency": (429, "RATE_LIMITED", "concurrency-ip"),
    "daily": (429, "RATE_LIMITED", "daily"),
}
# Checks that come before the registry is looked at.
BEFORE_THE_REGISTRY = ("rate", "body", "json", "model", "provider", "config")


def failing_sets() -> list[frozenset[str]]:
    """Every single check, every pair of checks, and all of them at once (Requirement 15.16)."""
    sets = [frozenset(c) for size in (1, 2) for c in itertools.combinations(CHECKS, size)]
    return [*sets, frozenset(CHECKS)]


def body_failing(failing: frozenset[str]) -> bytes:
    """A body that fails the body, JSON and model checks named in `failing` (else valid)."""
    if "body" in failing:
        padding = b"x" * (ANIMATION_BODY_BYTES + 1)
        closing = b"" if "json" in failing else b'"}'
        return b'{"pad":"' + padding + closing
    if "json" in failing:
        return b"{not json"
    if "model" in failing:
        return b"{}"
    return json.dumps(request_body()).encode()


@pytest.mark.parametrize("failing", failing_sets(), ids=lambda s: "+".join(sorted(s)))
def test_the_earliest_failing_check_answers(
    monkeypatch: pytest.MonkeyPatch, failing: frozenset[str]
) -> None:
    limits = AiLimits(
        per_minute_ip=1,
        per_minute_owner=100,
        daily_per_ip=1,
        max_concurrent_per_ip=1,
        max_concurrent_global=5,
    )
    other_hash = "f" * 64  # a row of this owner that is not the request: counts, is no hit
    world = build_world(
        monkeypatch,
        provider="provider" not in failing,
        enabled="config" not in failing,
        limits=limits,
        animation_limits=AnimationLimits(owner_max_animations=1) if "quota" in failing else None,
        rows=[make_row(OWNER, other_hash)] if "quota" in failing else [],
    )
    if "rate" in failing:
        assert world.limiter.check_rate(TEST_IP, "someone-else") is None  # fills the one slot
    if "concurrency" in failing:
        assert world.limiter.try_acquire(TEST_IP) is None
    if "daily" in failing:
        assert world.limiter.check_daily(TEST_IP) is None

    response = world.client().post(
        PATH, content=body_failing(failing), headers={"content-type": "application/json"}
    )

    earliest = next(check for check in CHECKS if check in failing)
    status, code, scope = EXPECTED[earliest]
    error = error_of(response)
    assert (response.status_code, error["code"]) == (status, code)
    if scope is not None:
        assert error["detail"]["scope"] == scope
        assert int(response.headers["retry-after"]) >= 1
    assert_json_refusal(response)
    # A refusal never reaches Gemini, the verifier or S3, writes no row, and keeps no slot.
    assert world.untouched_outside()
    assert world.registry.registered == []
    assert world.graph_requests == []
    assert world.limiter.in_flight() == (1 if "concurrency" in failing else 0)
    assert world.ai_limiter.in_flight() == 0
    if earliest in BEFORE_THE_REGISTRY:
        assert world.registry.calls == []
    else:
        assert world.registry.ops() == ["find", "count"]


def test_a_body_of_exactly_the_limit_passes_the_size_check(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world = build_world(monkeypatch)
    prefix, suffix = b'{"pad":"', b'"}'
    raw = prefix + b"x" * (ANIMATION_BODY_BYTES - len(prefix) - len(suffix)) + suffix
    assert len(raw) == ANIMATION_BODY_BYTES == 65536
    response = world.client().post(PATH, content=raw, headers={"content-type": "application/json"})
    assert (response.status_code, error_of(response)["message"]) == (400, "Invalid request body")


@pytest.mark.parametrize(
    "fixture",
    [
        "request-invalid-lone-surrogate-in-title.json",
        "request-invalid-lesson-with-forbidden-tokens.json",
    ],
)
def test_a_request_the_model_refuses_is_a_400_before_any_lookup(
    monkeypatch: pytest.MonkeyPatch, fixture: str
) -> None:
    world = build_world(monkeypatch)
    raw = (FIXTURES / fixture).read_bytes()
    response = world.client().post(PATH, content=raw, headers={"content-type": "application/json"})
    assert (response.status_code, error_of(response)["code"]) == (400, "INVALID_REQUEST")
    assert world.registry.calls == []  # refused before the Request_Hash is computed
    assert world.limiter.in_flight() == 0


# --- ANIMATION_NOT_CONFIGURED --------------------------------------------------------------------


def assert_not_configured_and_inert(world: World, response: httpx2.Response) -> None:
    assert response.status_code == 503
    assert error_of(response) == NOT_CONFIGURED
    assert_json_refusal(response)
    assert world.registry.calls == []  # not even the lookup
    assert world.untouched_outside()
    assert world.graph_requests == []
    assert (world.limiter.in_flight(), world.ai_limiter.in_flight()) == (0, 0)


def test_the_flag_off_answers_503_after_the_door_checks_and_does_nothing_else(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world = build_world(monkeypatch, enabled=False)
    calls = record_limiter_calls(monkeypatch, world.limiter)
    response = post(world)
    assert_not_configured_and_inert(world, response)
    # The door ran (the rate was counted) but no slot and no daily unit were taken.
    assert [name for name, _ in calls] == ["check_rate"]


def test_the_flag_off_still_waits_for_the_door_checks(monkeypatch: pytest.MonkeyPatch) -> None:
    world = build_world(monkeypatch, enabled=False)
    for body, status in ((b"{not json", 400), (b"{}", 400)):
        response = world.client().post(
            PATH, content=body, headers={"content-type": "application/json"}
        )
        assert response.status_code == status
    assert error_of(post(world)) == NOT_CONFIGURED
    unconfigured = build_world(monkeypatch, enabled=False, provider=False)
    assert error_of(post(unconfigured))["code"] == "PROVIDER_NOT_CONFIGURED"


@pytest.mark.parametrize(
    "overrides",
    [
        {"bucket": ""},
        {"bucket": "   "},
        {"function": ""},
        {"region": ""},
        {"with_engine": False},
        {"env": {"ANIMATION_ENABLED": "yes"}},
        {"env": {"ANIMATION_ENABLED": "1"}},
        {"env": {"ANIMATION_ENABLED": ""}},
    ],
    ids=lambda o: ",".join(f"{k}={v!r}" for k, v in o.items()),
)
def test_every_missing_setting_is_not_configured(
    monkeypatch: pytest.MonkeyPatch, overrides: dict[str, Any]
) -> None:
    world = build_world(monkeypatch, **overrides)
    assert_not_configured_and_inert(world, post(world))


def test_the_flag_accepts_any_letter_case_and_surrounding_spaces(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world = build_world(monkeypatch, **good_run({"env": {"ANIMATION_ENABLED": " True "}}))
    assert event_names(post(world)) == FULL_RUN


@pytest.fixture
def invalid_contract(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> Any:
    """Point the contract reader at a file that breaks the schema, and forget the cached result.

    The cache is cleared again after the patch is undone: clearing it while the patch is still in
    place would store the invalid result for the rest of the test run.
    """
    broken = tmp_path / "animation-contract.json"
    broken.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(contract_module, "CONTRACT_PATH", broken)
    contract_module.load_contract.cache_clear()
    yield
    monkeypatch.undo()
    contract_module.load_contract.cache_clear()


def test_an_invalid_contract_is_not_configured_and_spends_nothing(
    monkeypatch: pytest.MonkeyPatch, invalid_contract: None
) -> None:
    world = build_world(monkeypatch)
    calls = record_limiter_calls(monkeypatch, world.limiter)
    assert_not_configured_and_inert(world, post(world))
    assert [name for name, _ in calls] == ["check_rate"]  # no slot, no daily quota (Req. 2.15)


def test_the_runtime_is_built_lazily_and_holds_the_real_collaborators(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With nothing injected, the first request that passes the checks builds the runtime.

    The real registry module meets an in-memory SQLite engine that has no `animations` table, so
    the lookup fails with a database error, which must come out as `ANIMATION_STORAGE_FAILED`.
    """
    world = build_world(monkeypatch, enabled=False)
    world.app.state.animation_runtime = None
    assert error_of(post(world)) == NOT_CONFIGURED
    assert world.app.state.animation_runtime is None  # a refusal builds nothing

    enabled = build_world(monkeypatch)
    enabled.app.state.animation_runtime = None
    for name in BOTO_LOGGERS:
        logging.getLogger(name).setLevel(logging.NOTSET)
    response = post(enabled)
    runtime = enabled.app.state.animation_runtime
    assert isinstance(runtime, AnimationRuntime)
    assert isinstance(runtime.store, S3AnimationStore)
    assert isinstance(runtime.verifier, LambdaVerifierClient)
    assert runtime.graph is build_graph
    assert runtime.registry.__name__ == "app.ai.animation.registry"
    assert all(logging.getLogger(name).level >= logging.WARNING for name in BOTO_LOGGERS)
    assert response.status_code == 503
    assert error_of(response)["code"] == "ANIMATION_STORAGE_FAILED"
    assert enabled.limiter.in_flight() == 0


# --- Idempotent_Hit ------------------------------------------------------------------------------


def test_an_idempotent_hit_sends_started_and_done_from_the_row_and_nothing_else(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    body = request_body()
    row = make_row(OWNER, hash_of(body), attempts=3)
    world = build_world(monkeypatch, rows=[row])
    calls = record_limiter_calls(monkeypatch, world.limiter)
    with caplog.at_level(logging.INFO, logger="lore.animation"):
        response = post(world, body)

    assert response.status_code == 200
    assert response.headers["content-type"] == "text/event-stream; charset=utf-8"
    assert events_of(response) == [
        ("started", {"max_attempts": 4, "deadline_ms": 240000, "cached": True}),
        (
            "done",
            {"animation": reference_from_row(row).dump(), "cached": True, "attempts": 3},
        ),
    ]
    # No Gemini, no verifier, no S3, no graph, no slot, no daily quota, no quota count.
    assert world.untouched_outside()
    assert world.graph_requests == []
    assert world.registry.ops() == ["find"]
    assert [name for name, _ in calls] == ["check_rate"]
    assert world.limiter.in_flight() == 0

    start, end = animation_log_lines(caplog)
    assert (start["event"], start["cached"]) == ("animation.start", True)
    assert (end["event"], end["code"], end["attempts"], end["cached"]) == (
        "animation.end",
        "OK",
        0,
        True,
    )
    assert end["model"] == "recorded-model"


def test_an_idempotent_hit_of_a_puzzle_carries_its_pause_frame(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    body = puzzle_body()
    world = build_world(monkeypatch, rows=[make_row(OWNER, hash_of(body), kind="puzzle")])
    events = events_of(post(world, body))
    assert [name for name, _ in events] == ["started", "done"]
    assert events[1][1]["animation"]["pause_at_frame"] == 120


def test_an_idempotent_hit_needs_no_slot_no_daily_unit_and_no_free_quota(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    body = request_body()
    limits = AiLimits(
        per_minute_ip=100,
        per_minute_owner=100,
        daily_per_ip=1,
        max_concurrent_per_ip=1,
        max_concurrent_global=1,
    )
    world = build_world(
        monkeypatch,
        rows=[make_row(OWNER, hash_of(body))],
        limits=limits,
        animation_limits=AnimationLimits(owner_max_animations=1),
    )
    assert world.limiter.try_acquire(TEST_IP) is None  # the only slot is taken
    assert world.limiter.check_daily(TEST_IP) is None  # the only daily unit is spent
    response = post(world, body)
    assert event_names(response) == ["started", "done"]  # owner at quota 1 of 1 as well
    assert world.limiter.in_flight() == 1  # still only the slot the test took
    assert world.registry.ops() == ["find"]


def test_the_same_request_twice_runs_once_and_is_then_answered_from_the_registry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world = build_world(monkeypatch, **good_run())
    client = world.client()
    first = events_of(client.post(PATH, json=request_body()))
    second = events_of(client.post(PATH, json=request_body()))
    assert [name for name, _ in first] == FULL_RUN
    assert [name for name, _ in second] == ["started", "done"]
    assert second[0][1]["cached"] is True and second[1][1]["cached"] is True
    assert second[1][1]["animation"] == first[-1][1]["animation"]
    assert second[1][1]["attempts"] == first[-1][1]["attempts"] == 1
    assert len(world.gemini.requests) == 1 and len(world.verifier.payloads) == 1
    assert len(world.registry.rows) == 1
    assert world.limiter.in_flight() == 0


def test_a_row_of_another_owner_is_not_a_hit(monkeypatch: pytest.MonkeyPatch) -> None:
    body = request_body()
    world = build_world(monkeypatch, rows=[make_row(OTHER_OWNER, hash_of(body))], **good_run())
    events = events_of(post(world, body))
    assert [name for name, _ in events] == FULL_RUN
    assert events[0][1]["cached"] is False and events[-1][1]["cached"] is False
    assert len(world.gemini.requests) == 1
    assert {row.owner_id for row in world.registry.rows} == {OTHER_OWNER, OWNER}


# --- the per-owner quota -------------------------------------------------------------------------


def test_an_owner_at_quota_gets_422_before_a_slot_is_taken(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world = build_world(
        monkeypatch,
        rows=[make_row(OWNER, "f" * 64)],
        animation_limits=AnimationLimits(owner_max_animations=1),
    )
    calls = record_limiter_calls(monkeypatch, world.limiter)
    response = post(world)
    assert response.status_code == 422
    assert error_of(response) == {
        "code": "ANIMATION_QUOTA_EXCEEDED",
        "message": "The animation limit for this device has been reached.",
    }
    assert_json_refusal(response)
    assert [name for name, _ in calls] == ["check_rate"]  # no slot, no daily quota
    assert world.untouched_outside() and world.graph_requests == []
    assert world.registry.ops() == ["find", "count"]


def test_the_animation_cap_is_apart_from_the_project_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    world = build_world(monkeypatch, animation_limits=AnimationLimits(owner_max_animations=1))
    assert world.app.state.animation_limits.owner_max_animations == 1
    assert projects.get_limits(_request_of(world)).owner_max_projects == 100
    assert AnimationLimits().owner_max_animations == 200
    assert world.app.state.animation_limits is not projects.DEFAULT_LIMITS


def _request_of(world: World) -> Any:
    class _Request:
        app = world.app

    return _Request()


def test_the_rows_of_other_owners_do_not_count_towards_the_quota(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world = build_world(
        monkeypatch,
        rows=[make_row(OTHER_OWNER, "f" * 64)],
        animation_limits=AnimationLimits(owner_max_animations=1),
        **good_run(),
    )
    assert event_names(post(world)) == FULL_RUN


# --- registry failures and unexpected failures before the stream ---------------------------------


@pytest.mark.parametrize("operation", ["find", "count"])
def test_a_registry_failure_before_the_stream_is_503_and_takes_no_slot(
    monkeypatch: pytest.MonkeyPatch, operation: str
) -> None:
    world = build_world(monkeypatch)
    world.registry.fail[operation] = RegistryError(f"animation registry {operation} failed")
    calls = record_limiter_calls(monkeypatch, world.limiter)
    response = post(world)
    assert response.status_code == 503
    assert error_of(response) == {
        "code": "ANIMATION_STORAGE_FAILED",
        "message": "The animation could not be saved.",
    }
    assert_json_refusal(response)
    assert [name for name, _ in calls] == ["check_rate"]
    assert world.untouched_outside() and world.registry.registered == []


def test_an_unexpected_failure_before_the_stream_is_a_500_with_a_fixed_message(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    world = build_world(monkeypatch)
    world.registry.fail["find"] = RuntimeError("secret-from-the-registry")
    with caplog.at_level(logging.ERROR, logger="lore.ai"):
        response = post(world)
    assert response.status_code == 500
    assert error_of(response) == {"code": "UNKNOWN", "message": "Internal server error"}
    assert_json_refusal(response)
    assert "secret-from-the-registry" not in response.text + all_log_text(caplog)
    assert "RuntimeError" in all_log_text(caplog)  # the class and place are logged
    assert world.limiter.in_flight() == 0


def test_a_stored_row_that_breaks_the_contract_is_a_500_not_a_stream(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    body = request_body()
    broken = dataclasses.replace(make_row(OWNER, hash_of(body)), meta={"width": 1280})
    world = build_world(monkeypatch, rows=[broken])
    with caplog.at_level(logging.ERROR, logger="lore.ai"):
        response = post(world, body)
    assert response.status_code == 500
    assert error_of(response) == {"code": "UNKNOWN", "message": "Internal server error"}
    assert_json_refusal(response)
    assert world.limiter.in_flight() == 0 and world.untouched_outside()


def test_a_graph_that_cannot_be_built_is_a_500_and_the_slot_comes_back(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    world = build_world(monkeypatch)

    def broken() -> None:
        raise ImportError("secret-langgraph-location")

    world.app.state.animation_runtime.graph = broken
    calls = record_limiter_calls(monkeypatch, world.limiter)
    with caplog.at_level(logging.INFO):
        response = post(world)
    assert response.status_code == 500
    assert error_of(response) == {"code": "UNKNOWN", "message": "Internal server error"}
    assert "secret-langgraph-location" not in response.text + all_log_text(caplog)
    assert [name for name, _ in calls] == ["check_rate", "try_acquire", "check_daily", "release"]
    assert world.limiter.in_flight() == 0
    assert animation_log_lines(caplog) == []  # no run began, so no animation.* line
    assert world.untouched_outside() and world.registry.registered == []


def test_a_response_that_cannot_be_built_gives_the_slot_back_and_closes_the_run_log(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    world = build_world(monkeypatch)

    def broken(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("secret-response")

    # The one patch of a module global in this file: nothing else makes this constructor fail.
    monkeypatch.setattr(endpoint_module, "AnimationStreamResponse", broken)
    calls = record_limiter_calls(monkeypatch, world.limiter)
    with caplog.at_level(logging.INFO):
        response = post(world)
    assert response.status_code == 500
    assert "secret-response" not in response.text + all_log_text(caplog)
    assert [name for name, _ in calls] == ["check_rate", "try_acquire", "check_daily", "release"]
    assert world.limiter.in_flight() == 0
    start, end = animation_log_lines(caplog)
    assert (start["event"], end["event"], end["code"]) == (
        "animation.start",
        "animation.end",
        "CANCELLED",
    )
    assert world.untouched_outside()


# --- the slot ------------------------------------------------------------------------------------

OUTCOMES: dict[str, dict[str, Any]] = {
    "done": {"gemini": [fenced(source(1))], "verifier": [verified()]},
    "verification-failed": {
        "gemini": [fenced(source(1))],
        "verifier": [rejected("TSC_2322")],
        "env": {"ANIMATION_MAX_ATTEMPTS": "1"},
    },
    "provider-failed": {"gemini": [500, 500], "verifier": []},
}


@pytest.mark.parametrize("outcome", list(OUTCOMES))
def test_one_slot_is_taken_and_given_back_exactly_once_for_every_end_of_a_run(
    monkeypatch: pytest.MonkeyPatch, outcome: str
) -> None:
    world = build_world(monkeypatch, **OUTCOMES[outcome])
    calls = record_limiter_calls(monkeypatch, world.limiter)
    events = events_of(post(world))
    assert events[0][0] == "started"
    assert events[-1][0] == ("done" if outcome == "done" else "error")
    slot_calls = [name for name, _ in calls if name in ("try_acquire", "release")]
    assert slot_calls == ["try_acquire", "release"]
    assert world.limiter.in_flight() == 0


def test_the_daily_quota_refusal_gives_the_slot_back(monkeypatch: pytest.MonkeyPatch) -> None:
    world = build_world(monkeypatch, limits=AiLimits(daily_per_ip=1))
    assert world.limiter.check_daily(TEST_IP) is None
    calls = record_limiter_calls(monkeypatch, world.limiter)
    response = post(world)
    assert (response.status_code, error_of(response)["detail"]["scope"]) == (429, "daily")
    assert [name for name, _ in calls] == ["check_rate", "try_acquire", "check_daily", "release"]
    assert world.limiter.in_flight() == 0
    assert world.registry.ops() == ["find", "count"] and world.untouched_outside()


def test_the_slot_is_held_for_the_whole_run_and_freed_when_it_ends(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def go() -> tuple[World, Exchange, dict[str, int]]:
        seen: dict[str, int] = {}
        in_call = asyncio.Event()
        release = asyncio.Event()

        async def slow_verify(_payload: dict[str, Any], _remaining: float) -> Any:
            seen["animation"] = world.limiter.in_flight()
            seen["json"] = world.ai_limiter.in_flight()
            in_call.set()
            await release.wait()
            return verified()

        world = build_world(monkeypatch, gemini=[fenced(source(1))], verifier=[slow_verify])
        exchange = Exchange(world.app, request_body())
        exchange.start()
        await asyncio.wait_for(in_call.wait(), 5)
        seen["during"] = world.limiter.in_flight()
        release.set()
        await exchange.finished()
        seen["after"] = world.limiter.in_flight()
        return world, exchange, seen

    _, exchange, seen = asyncio.run(go())
    assert seen == {"animation": 1, "json": 0, "during": 1, "after": 0}
    assert exchange.event_names() == FULL_RUN


def test_the_concurrency_limit_refuses_a_second_run_while_the_first_holds_the_slot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def go() -> tuple[Exchange, Exchange, World]:
        in_call = asyncio.Event()
        release = asyncio.Event()

        async def slow_verify(_payload: dict[str, Any], _remaining: float) -> Any:
            in_call.set()
            await release.wait()
            return verified()

        world = build_world(
            monkeypatch,
            gemini=[fenced(source(1))],
            verifier=[slow_verify],
            limits=AiLimits(
                per_minute_ip=100,
                per_minute_owner=100,
                daily_per_ip=100,
                max_concurrent_per_ip=1,
                max_concurrent_global=5,
            ),
        )
        first = Exchange(world.app, request_body())
        first.start()
        await asyncio.wait_for(in_call.wait(), 5)
        second = Exchange(world.app, puzzle_body())
        await second.run()
        release.set()
        await first.finished()
        return first, second, world

    first, second, world = asyncio.run(go())
    assert second.status == 429
    assert json.loads(second.body)["error"]["detail"]["scope"] == "concurrency-ip"
    assert second.headers["retry-after"] == "5"
    assert second.headers["content-type"].startswith("application/json")
    assert first.event_names() == FULL_RUN
    assert world.limiter.in_flight() == 0


# --- a client that hangs up ----------------------------------------------------------------------


def test_a_client_that_hangs_up_cancels_the_run_and_frees_the_slot_within_a_second(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Requirement 15.9, through the real `BaseHTTPMiddleware` (finding T-14).

    The verifier double blocks forever, like an invocation that takes five seconds, so the agent
    is inside a step when the client leaves. The exchange hangs up with `http.disconnect`.
    """

    async def go() -> tuple[World, Exchange, dict[str, Any], float]:
        seen: dict[str, Any] = {"cancelled": False}
        in_call = asyncio.Event()

        async def hang(_payload: dict[str, Any], _remaining: float) -> Any:
            in_call.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                seen["cancelled"] = True
                raise

        world = build_world(monkeypatch, gemini=[fenced(source(1))], verifier=[hang])
        exchange = Exchange(world.app, request_body())
        exchange.start()
        await asyncio.wait_for(in_call.wait(), 5)
        assert world.limiter.in_flight() == 1
        began = time.monotonic()
        exchange.hang_up()
        await exchange.finished(timeout=1.0)
        # Look at the state inside the loop: `asyncio.run` cancels what is left when it ends, which
        # would make a run that was never cancelled look cancelled.
        while time.monotonic() - began < 1.0 and not (
            seen["cancelled"] and world.limiter.in_flight() == 0
        ):
            await asyncio.sleep(0.005)
        seen["in_flight"] = world.limiter.in_flight()
        seen["lines"] = [line["event"] for line in animation_log_lines(caplog)]
        return world, exchange, seen, time.monotonic() - began

    with caplog.at_level(logging.INFO, logger="lore.animation"):
        world, exchange, seen, elapsed = asyncio.run(go())

    assert elapsed < 1.0
    assert seen["in_flight"] == 0
    assert seen["cancelled"] is True  # the agent really stopped, not just the response
    assert seen["lines"] == ["animation.start", "animation.end"]  # written before the loop ended
    assert exchange.event_names() == ["started", "stage", "stage"]  # no done, no error
    assert world.s3.calls == [] and world.registry.registered == []
    assert animation_log_lines(caplog)[-1]["code"] == "CANCELLED"


# --- off the event loop --------------------------------------------------------------------------

BLOCKING_STEPS = ["find", "count", "register", "s3-put", "graph"]


@pytest.mark.parametrize("blocking", BLOCKING_STEPS)
def test_a_blocking_step_does_not_stall_the_event_loop(
    monkeypatch: pytest.MonkeyPatch, blocking: str
) -> None:
    """Requirement 15.17: blocking 500 ms delays a ticker on the same loop by at most 100 ms."""
    world = build_world(monkeypatch, **good_run())
    if blocking in ("find", "count", "register"):
        world.registry.delay_s[blocking] = 0.5
    elif blocking == "s3-put":
        world.s3.before("put_object", "main.ts", lambda: time.sleep(0.5))
    else:
        world.app.state.animation_runtime.graph = lambda: time.sleep(0.5)

    async def go() -> tuple[Exchange, float]:
        stop = asyncio.Event()
        tick = asyncio.create_task(ticker(stop))
        exchange = Exchange(world.app, request_body())
        await exchange.run()
        stop.set()
        return exchange, await tick

    exchange, worst = asyncio.run(go())
    assert exchange.event_names() == FULL_RUN
    assert worst <= 0.1
    if blocking in ("find", "count", "register"):
        assert threading.get_ident() not in world.registry.threads()


# --- how the run is wired ------------------------------------------------------------------------


def test_the_run_and_its_handle_share_one_cancel_flag_one_log_and_the_emit_queue(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One `asyncio.Event` and one `RunLog` for both, and `run.emit` is the handle's queue.

    Two flags would let a thread inside `store.publish` miss the client leaving, and two logs would
    write `animation.start` and `animation.end` twice. Nothing outside shows which object was
    passed, so the constructors are spied on (they still run).
    """
    world = build_world(monkeypatch, **good_run())
    created: dict[str, Any] = {}
    real_create = RunContext.create

    def spy_create(*args: Any, **kwargs: Any) -> RunContext:
        created["kwargs"] = kwargs
        created["run"] = real_create(*args, **kwargs)
        return created["run"]

    class SpyHandle(RunHandle):
        def __init__(self, **kwargs: Any) -> None:
            created["handle_kwargs"] = kwargs
            created["handle"] = self
            super().__init__(**kwargs)

    monkeypatch.setattr(RunContext, "create", staticmethod(spy_create))
    monkeypatch.setattr(endpoint_module, "RunHandle", SpyHandle)
    assert event_names(post(world)) == FULL_RUN

    run_kwargs, handle_kwargs = created["kwargs"], created["handle_kwargs"]
    assert isinstance(run_kwargs["cancelled"], asyncio.Event)
    assert run_kwargs["cancelled"] is handle_kwargs["cancelled"]
    assert isinstance(run_kwargs["log"], RunLog)
    assert run_kwargs["log"] is handle_kwargs["log"]
    assert created["run"].emit == created["handle"].emit
    assert isinstance(handle_kwargs["lease"], SlotLease)
    assert run_kwargs["registry"].engine is world.app.state.db_engine
    assert run_kwargs["registry"].limits is world.app.state.animation_limits
    assert run_kwargs["models"] == ("test-model",)
    assert (run_kwargs["max_attempts"], run_kwargs["deadline_ms"]) == (4, 240000)
    assert run_kwargs["owner_id"] == OWNER
    assert run_kwargs["request_hash"] == hash_of(request_body())


# --- two limiters, one door ----------------------------------------------------------------------


def test_the_real_handler_calls_the_shared_entry_guard_with_keyword_arguments(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world = build_world(monkeypatch)
    real = pipeline.entry_guard
    calls: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []

    async def spy(request: Any, *args: Any, **kwargs: Any) -> Any:
        calls.append((request.url.path, args, kwargs))
        return await real(request, *args, **kwargs)

    monkeypatch.setattr(pipeline, "entry_guard", spy)
    client = world.client()
    assert client.post(PATH, json={}).status_code == 400
    assert client.post(ANALYZE_PATH, json={}).status_code == 400

    assert [path for path, _, _ in calls] == [PATH, ANALYZE_PATH]
    (_, args, animation), (_, json_args, json_call) = calls
    assert args == () and json_args == ()  # keyword arguments only
    assert set(animation) == {"limiter", "request_model", "body_limit"} == set(json_call)
    assert animation["limiter"] is world.limiter
    assert animation["request_model"] is CreateAnimationRequest
    assert animation["body_limit"] == ANIMATION_BODY_BYTES == 65536
    assert json_call["limiter"] is world.ai_limiter
    assert json_call["request_model"] is AnalyzeMaterialRequest
    assert json_call["body_limit"] == ANALYZE_MATERIAL_BODY_BYTES
    assert world.limiter is not world.ai_limiter


def test_each_endpoint_spends_only_the_rate_window_of_its_own_limiter(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    limits = AiLimits(per_minute_ip=2, per_minute_owner=2)
    world = build_world(monkeypatch, limits=limits)
    world.app.state.ai_limiter = AiLimiter(limits, monotonic=world.clock, wall=world.clock)
    client = world.client()
    for path in (PATH, PATH, ANALYZE_PATH, ANALYZE_PATH):
        assert client.post(path, json={}).status_code == 400  # passes the rate check, fails model
    for path in (PATH, ANALYZE_PATH):  # both windows are full now, each by its own two requests
        response = client.post(path, json={})
        assert (response.status_code, error_of(response)["code"]) == (429, "RATE_LIMITED")


SCOPES = ["ip", "owner", "daily", "concurrency-ip", "concurrency-global"]


@pytest.mark.parametrize("scope", SCOPES)
def test_a_limiter_refusal_names_its_scope_and_says_when_to_retry(
    monkeypatch: pytest.MonkeyPatch, scope: str
) -> None:
    limits = {
        "ip": AiLimits(per_minute_ip=1),
        "owner": AiLimits(per_minute_owner=1),
        "daily": AiLimits(daily_per_ip=1),
        "concurrency-ip": AiLimits(max_concurrent_per_ip=1),
        "concurrency-global": AiLimits(max_concurrent_global=1),
    }[scope]
    world = build_world(monkeypatch, limits=limits)
    limiter = world.limiter
    if scope == "ip":
        assert limiter.check_rate(TEST_IP, "someone-else") is None
    elif scope == "owner":
        assert limiter.check_rate("another-ip", str(OWNER)) is None
    elif scope == "daily":
        assert limiter.check_daily(TEST_IP) is None
    elif scope == "concurrency-ip":
        assert limiter.try_acquire(TEST_IP) is None
    else:
        assert limiter.try_acquire("another-ip") is None

    response = post(world)
    error = error_of(response)
    assert (response.status_code, error["code"], error["detail"]["scope"]) == (
        429,
        "RATE_LIMITED",
        scope,
    )
    retry_after = int(response.headers["retry-after"])
    assert retry_after >= 1
    assert error["detail"]["retryAfterSeconds"] == retry_after
    if scope.startswith("concurrency"):
        assert retry_after == 5
    assert_json_refusal(response)
    assert limiter.in_flight() == (1 if scope.startswith("concurrency") else 0)
    assert world.untouched_outside() and world.registry.registered == []
