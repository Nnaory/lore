"""Matrix tests of the Animation_Agent (`app.ai.animation.agent`, task 17.2).

Why: `test_animation_agent_core.py` is a smoke layer (one run per path) and
`test_animation_agent_graph.py` proves how the agent is assembled. This file is the full matrix of
design 6.6 and Requirements 13, 14 and 32.4. Everything runs through the real code: the real
`run_agent` driver and nodes, the real Gemini client over `httpx2.MockTransport` (so the request
config, status mapping and per-call time limit are the production ones), the real
`S3AnimationStore` over the in-memory `FakeS3`, the real `LambdaVerifierClient` where a thread has
to block, and the real `AiLimiter` for `in_flight()`. The fakes only decide what each outside
system answers (`tests/animation_agent_support.py`). Time is the injected `Clock`: a test moves it
to the exact point it needs and nothing sleeps for it. No `langgraph`, `boto3`, network or
database is used; the driver and the graph share nodes and edge table, and the parity of the two is
`test_animation_agent_graph.py`.

What is covered, by section:

1. `decide_after_verify`: every combination of `ok`, `calls`, `max_attempts` 1 to 4, `remaining_ms`
   (negative, zero, NaN, infinite) and `terminal` against the five rows of the design table. The
   check is that exactly one row applies to each combination and that the function returns that
   row, so the table itself is shown to be a partition. Out-of-range inputs never raise.
2. Attempts: for `max_attempts` 1 to 4, every sequence of failed attempts (`bad` source, reply
   with `none` code, repair `same` as before) with and without a verified attempt at the end. Each
   run is checked for the Gemini calls (never more than `max_attempts`), the verifier calls (none
   for a skipped attempt, the same tokens each time), the exact event order, the node order, the
   log lines and the repair prompt of the next attempt. Plus normalisation, the 50 Diagnostics
   limit, the model of the call that wrote the published source, and the clamp of `max_attempts`.
3. Verifier outcomes: `unavailable`, an invocation that raises, the three infrastructure
   Diagnostics at every position, `timeout`, `FunctionError` as `VERIFIER_CRASH`, and
   `VERIFIER_DEADLINE` as an ordinary failed attempt; also the real `LambdaVerifierClient` feeding
   the agent from Lambda-shaped responses.
4. Gemini failures: each `GeminiFailure` code, from the real client (429, 5xx, 4xx, timeout,
   network, empty reply) and from a stub (`OUTPUT_PARSE_FAILED`, an unknown code), at the first,
   a repair and the last attempt; and the time limit given to each call.
5. Time and cancellation: the deadline moved to each point of a run (before the start, inside every
   Gemini and verifier call, between every pair of steps, around each S3 call) and a cancel flag
   set at the same points, each ending without a write that should not happen; `task.cancel()`
   while a Gemini call (first and repair) and a verifier call are blocked.
6. Blocked threads: a verifier thread that blocks (the event loop stays free, a cancel or the
   deadline returns at once, the late answer is dropped), a blocked S3 call and a blocked registry
   call, with `AiLimiter.in_flight()` back to its value before the run (Requirement 14.13).
7. Publish failures and unexpected exceptions: each ends in one code with no further Gemini or
   verifier call, and no message of an exception reaches the log.
8. Sentinels (Requirement 32.4): strings in the source, the prompt, the tokens, the key, a
   presigned URL and a Diagnostic message, on runs that succeed, fail and are cancelled, must not
   appear in the captured log, the result or any event. Each test first proves that the sentinel
   was really live inside the run (it reached Gemini, the verifier or an exception), so a pass is
   not an empty one.

What is not covered here: the property test of task 17.3, the endpoint (18.3) that builds the
`done` and `error` events from the result, and the real LangGraph (see
`test_animation_agent_graph.py`).

Facts about the agent that these tests pin and that the next reader may not expect:

- `AgentFailed.diagnostics` keeps tool, code, severity and place but not the message; a message is
  written by the verifier or the model and may quote the source (Requirement 32.4).
- After a repair that changed nothing, the state holds only `AGENT_REPAIR_UNCHANGED`, so the next
  repair prompt carries that one Diagnostic and not the earlier findings (design 6.6 says so).
- A deadline that passes during `emit` (between two steps) stops the next step: the Gemini client
  refuses to send a request with no time left, and the verifier client returns `timeout` without
  calling Lambda.
"""

from __future__ import annotations

import asyncio
import io
import itertools
import json
import logging
import math
import threading
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, replace
from typing import Any, NamedTuple

import httpx2
import pytest

from app.ai.animation import agent
from app.ai.animation.agent import (
    ROUTES,
    VERIFIER_CRASH_MESSAGE,
    AgentFailed,
    AgentPublished,
    AgentResult,
    decide_after_verify,
    run_agent,
)
from app.ai.animation.logging_ import END_CANCELLED
from app.ai.animation.models import AnimationManifest, DiagnosticsEvent, StageEvent
from app.ai.animation.prompts import NO_PREVIOUS_SOURCE
from app.ai.animation.registry import NewRow, QuotaExceeded, Registered, RegistryError
from app.ai.animation.store import S3AnimationStore, TimedOut
from app.ai.animation.verifier_client import LambdaOutcome, LambdaVerifierClient
from app.ai.gemini_client import (
    GeminiFailure,
    GeminiRequest,
    GeminiTextOk,
    GeminiUsage,
)
from app.ai.limits import AiLimiter, AiLimits
from app.ai.runtime import AiContext
from app.ai.settings import GeminiConfig
from tests.animation_agent_support import (
    MODEL,
    Rig,
    all_log_text,
    animation_log_lines,
    crashed,
    event_name,
    fenced,
    make_rig,
    puzzle_request,
    rejected,
    source,
    unavailable,
    verified,
)

VERIFICATION_FAILED = "ANIMATION_VERIFICATION_FAILED"
TIMEOUT = "ANIMATION_TIMEOUT"
UNAVAILABLE = "ANIMATION_VERIFIER_UNAVAILABLE"
STORAGE_FAILED = "ANIMATION_STORAGE_FAILED"
IP = "203.0.113.9"

START_FIELDS = {"event", "kind", "cached"}
ATTEMPT_FIELDS = {"event", "attempt", "outcome", "error_count", "warning_count", "latency_ms"}
END_FIELDS = {"event", "code", "attempts", "total_ms", "model", "cached"}


# --- helpers ----------------------------------------------------------------------------------


def run(rig: Rig) -> AgentResult:
    return asyncio.run(run_agent(rig.run))


def published(result: AgentResult) -> AgentPublished:
    assert isinstance(result, AgentPublished), result
    return result


def failed(result: AgentResult, code: str) -> AgentFailed:
    assert isinstance(result, AgentFailed), result
    assert result.code == code, result
    return result


def stage_name(attempt: int) -> str:
    return "generating" if attempt == 1 else "repairing"


def failed_attempt_events(attempt: int) -> list[str]:
    """The events of an attempt that was generated, verified and rejected."""
    return [
        f"stage:{stage_name(attempt)}:{attempt}",
        f"stage:verifying:{attempt}",
        f"diagnostics:{attempt}:False:1",
    ]


def at_event(rig: Rig, label: str, action: Callable[[], None]) -> None:
    """Run `action` right after the event named `label` is emitted (it may move the clock)."""
    original = rig.run.emit

    def emit(event: Any) -> None:
        original(event)
        if event_name(event) == label:
            action()

    rig.run.emit = emit


def reply_after(action: Callable[[], None], text: str) -> Callable[[httpx2.Request], Any]:
    """A Gemini reply that runs `action` first (move the clock, set the flag) and then answers."""

    def handler(_request: httpx2.Request) -> httpx2.Response:
        action()
        body = {"candidates": [{"content": {"parts": [{"text": text}]}}]}
        return httpx2.Response(200, json=body)

    return handler


def verifier_after(action: Callable[[], None], outcome: LambdaOutcome) -> Any:
    """A verifier step that runs `action` first and then answers `outcome`."""

    async def step(_payload: dict[str, Any], _remaining: float) -> LambdaOutcome:
        action()
        return outcome

    return step


RUN_EVENTS = {"animation.start", "animation.attempt", "animation.end"}


def end_line(caplog: pytest.LogCaptureFixture) -> dict[str, Any]:
    """The `animation.end` line, after checking it is the last line the run itself wrote.

    A verifier thread that was left running when the run ended may still write its own
    `animation.verifier` line later (it holds counts and codes only), so that line is not part of
    the run's start, attempt and end lines that Requirement 33.11 orders.
    """
    lines = [line for line in animation_log_lines(caplog) if line["event"] in RUN_EVENTS]
    assert lines[0]["event"] == "animation.start"
    assert lines[-1]["event"] == "animation.end"
    assert sum(1 for line in lines if line["event"] == "animation.end") == 1
    return lines[-1]


def diagnostics_events(rig: Rig) -> list[DiagnosticsEvent]:
    return [event for event in rig.events if isinstance(event, DiagnosticsEvent)]


def wait_thread(event: threading.Event, seconds: float = 5.0) -> Awaitable[bool]:
    """Wait for a `threading.Event` without blocking the event loop."""
    return asyncio.to_thread(event.wait, seconds)


# --- 1. decide_after_verify: the whole table --------------------------------------------------

REMAINING = (-math.inf, -1.0, -0.001, 0.0, 0.001, 1.0, 240_000.0, math.inf, math.nan)
TERMINALS = (
    None,
    "UNKNOWN",
    "RATE_LIMITED",
    "PROVIDER_UNAVAILABLE",
    UNAVAILABLE,
    TIMEOUT,
    STORAGE_FAILED,
)


class Row(NamedTuple):
    """One row of the table of design 6.6: when it applies and what it answers."""

    name: str
    applies: Callable[[bool, int, int, float, str | None], bool]
    answer: Callable[[bool, int, int, float, str | None], tuple[str, str | None]]


TABLE = (
    Row(
        "no time left",
        lambda ok, calls, mx, rem, term: not rem > 0,
        lambda ok, calls, mx, rem, term: ("fail", TIMEOUT),
    ),
    Row(
        "a node decided a code",
        lambda ok, calls, mx, rem, term: rem > 0 and term is not None,
        lambda ok, calls, mx, rem, term: ("fail", term),
    ),
    Row(
        "verified",
        lambda ok, calls, mx, rem, term: rem > 0 and term is None and ok,
        lambda ok, calls, mx, rem, term: ("publish", None),
    ),
    Row(
        "failed and attempts are left",
        lambda ok, calls, mx, rem, term: rem > 0 and term is None and not ok and calls < mx,
        lambda ok, calls, mx, rem, term: ("repair", None),
    ),
    Row(
        "failed and no attempt is left",
        lambda ok, calls, mx, rem, term: rem > 0 and term is None and not ok and calls >= mx,
        lambda ok, calls, mx, rem, term: ("fail", VERIFICATION_FAILED),
    ),
)


@pytest.mark.parametrize("max_attempts", [1, 2, 3, 4])
@pytest.mark.parametrize("ok", [False, True])
def test_decide_after_verify_is_the_table_for_every_combination(
    ok: bool, max_attempts: int
) -> None:
    checked = 0
    for calls in range(0, max_attempts + 2):
        for remaining, terminal in itertools.product(REMAINING, TERMINALS):
            where = f"ok={ok} calls={calls} max={max_attempts} rem={remaining} term={terminal}"
            rows = [r for r in TABLE if r.applies(ok, calls, max_attempts, remaining, terminal)]
            assert len(rows) == 1, f"the table is not a partition for {where}: {rows}"
            expected = rows[0].answer(ok, calls, max_attempts, remaining, terminal)
            got = decide_after_verify(
                ok=ok,
                calls=calls,
                max_attempts=max_attempts,
                remaining_ms=remaining,
                terminal=terminal,
            )
            assert got == expected, f"{where}: {rows[0].name}"
            assert got[0] in ROUTES
            assert (got[1] is None) == (got[0] != "fail")
            checked += 1
    assert checked == (max_attempts + 2) * len(REMAINING) * len(TERMINALS)


def test_decide_after_verify_never_raises_on_inputs_outside_the_expected_range() -> None:
    odd_calls = (-5, 0, 1, 10**9)
    odd_max = (0, -1, 1, 4, 10**9)
    for ok, calls, mx, remaining, terminal in itertools.product(
        (False, True), odd_calls, odd_max, REMAINING, (None, "UNKNOWN")
    ):
        route, code = decide_after_verify(
            ok=ok, calls=calls, max_attempts=mx, remaining_ms=remaining, terminal=terminal
        )
        assert route in ("publish", "repair", "fail")
        assert (code is None) == (route != "fail")


def test_the_routing_order_is_time_then_terminal_then_ok_then_attempts() -> None:
    """Each earlier row beats every later one (Requirement 13.13)."""

    def decide(**kwargs: Any) -> tuple[str, str | None]:
        base: dict[str, Any] = {
            "ok": True,
            "calls": 1,
            "max_attempts": 4,
            "remaining_ms": 5.0,
            "terminal": None,
        }
        return decide_after_verify(**{**base, **kwargs})

    assert decide(remaining_ms=0, terminal="UNKNOWN", ok=True) == ("fail", TIMEOUT)
    assert decide(terminal="RATE_LIMITED", ok=True) == ("fail", "RATE_LIMITED")
    assert decide(ok=True, calls=4) == ("publish", None)
    assert decide(ok=False, calls=3) == ("repair", None)
    assert decide(ok=False, calls=4) == ("fail", VERIFICATION_FAILED)


# --- 2a. the max_attempts clamp ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("given", "effective"),
    [(0, 1), (-5, 1), (1, 1), (2, 2), (3, 3), (4, 4), (5, 4), (99, 4)],
)
def test_max_attempts_is_clamped_to_one_to_four_and_bounds_the_gemini_calls(
    given: int, effective: int
) -> None:
    rig = make_rig(
        gemini=[fenced(source(n)) for n in range(1, 10)],
        verifier=[rejected("TSC_2304")] * 9,
        max_attempts=given,
    )
    assert rig.run.max_attempts == effective
    result = failed(run(rig), VERIFICATION_FAILED)
    assert result.calls == effective
    assert len(rig.gemini.requests) == effective
    assert len(rig.verifier.payloads) == effective
    assert rig.gemini.extra_calls == 0
    assert rig.s3.calls == [] and rig.registry.calls == []


# --- 2b. the attempt matrix -------------------------------------------------------------------
#
# An attempt is one Gemini call and what the agent does with its reply:
#   bad   a new source that the verifier rejects (one error, TSC_2304)
#   none  a reply with no code block (AGENT_EXTRACT_NO_CODE, the verifier is not called)
#   same  a repair that gives back the source it was given (AGENT_REPAIR_UNCHANGED, no verifier)
#   good  a new source that the verifier accepts (the run publishes)
# `same` needs a source to repeat, so it cannot be first and cannot follow `none` (after `none` the
# agent holds no source).

OUTCOME_OF = {
    "bad": "verify_failed",
    "none": "extract_failed",
    "same": "repair_unchanged",
    "good": "verified",
}
CODES_OF = {
    "bad": ["TSC_2304"],
    "none": ["AGENT_EXTRACT_NO_CODE"],
    "same": ["AGENT_REPAIR_UNCHANGED"],
}


@dataclass
class Plan:
    """What the scripted run must look like, worked out from the kinds alone."""

    replies: list[str] = field(default_factory=list)
    script: list[LambdaOutcome] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)  # sent to the verifier, in order
    verified_attempts: list[int] = field(default_factory=list)
    events: list[str] = field(default_factory=list)
    visits: list[str] = field(default_factory=list)
    outcomes: list[str] = field(default_factory=list)
    prompt_needs: list[tuple[list[str], str]] = field(default_factory=list)  # per repair prompt
    last_codes: list[str] = field(default_factory=list)


def plan_for(kinds: tuple[str, ...]) -> Plan:
    plan = Plan()
    number = 0
    current = ""  # the last source Gemini wrote
    held = ""  # the source the agent holds (empty after a reply with no code)
    codes: list[str] = []
    for index, kind in enumerate(kinds, start=1):
        if index > 1:
            needs = held if held else NO_PREVIOUS_SOURCE
            plan.prompt_needs.append((codes, needs))
        plan.visits += ["generate" if index == 1 else "repair", "verify"]
        plan.events.append(f"stage:{stage_name(index)}:{index}")
        plan.outcomes.append(OUTCOME_OF[kind])
        if kind in ("bad", "good"):
            number += 1
            current = held = source(number)
            plan.replies.append(fenced(current))
            plan.sources.append(current)
            plan.verified_attempts.append(index)
            plan.events.append(f"stage:verifying:{index}")
            if kind == "bad":
                plan.script.append(rejected("TSC_2304"))
                plan.events.append(f"diagnostics:{index}:False:1")
            else:
                plan.script.append(verified())
                plan.events += [f"diagnostics:{index}:True:0", f"stage:publishing:{index}"]
        elif kind == "none":
            plan.replies.append("I cannot write that animation.")
            held = ""
            plan.events.append(f"diagnostics:{index}:False:1")
        else:
            plan.replies.append(fenced(current))
            plan.events.append(f"diagnostics:{index}:False:1")
        if kind != "good":
            codes = CODES_OF[kind]
            plan.last_codes = codes
    plan.visits.append("publish" if kinds[-1] == "good" else "fail")
    return plan


def failing_sequences(length: int) -> list[tuple[str, ...]]:
    found = []
    for kinds in itertools.product(("bad", "none", "same"), repeat=length):
        if kinds and kinds[0] == "same":
            continue
        if any(a == "none" and b == "same" for a, b in zip(kinds, kinds[1:], strict=False)):
            continue
        found.append(kinds)
    return found


def attempt_cases() -> list[tuple[int, tuple[str, ...]]]:
    cases: list[tuple[int, tuple[str, ...]]] = []
    for max_attempts in range(1, 5):
        cases += [(max_attempts, kinds) for kinds in failing_sequences(max_attempts)]
        for length in range(1, max_attempts + 1):
            cases += [(max_attempts, (*kinds, "good")) for kinds in failing_sequences(length - 1)]
    return cases


ATTEMPT_CASES = attempt_cases()


def test_the_attempt_matrix_has_the_size_worked_out_by_hand() -> None:
    """54 runs that never verify and 33 that end verified, so no sequence is lost silently."""
    assert len(ATTEMPT_CASES) == 54 + 33
    assert sum(1 for _, kinds in ATTEMPT_CASES if kinds[-1] == "good") == 33
    assert {max_attempts for max_attempts, _ in ATTEMPT_CASES} == {1, 2, 3, 4}


@pytest.fixture
def visits(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Record the order of the nodes the driver runs, without changing what they do."""
    seen: list[str] = []
    for name, node in dict(agent.NODES).items():

        async def wrapper(state: Any, run_: Any, _name: str = name, _node: Any = node) -> Any:
            seen.append(_name)
            return await _node(state, run_)

        monkeypatch.setitem(agent.NODES, name, wrapper)
    return seen


@pytest.mark.parametrize(
    ("max_attempts", "kinds"),
    ATTEMPT_CASES,
    ids=[f"max{m}-{'-'.join(k)}" for m, k in ATTEMPT_CASES],
)
def test_every_attempt_sequence_ends_in_one_state_within_max_attempts(
    max_attempts: int,
    kinds: tuple[str, ...],
    visits: list[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO)
    plan = plan_for(kinds)
    rig = make_rig(gemini=plan.replies, verifier=plan.script, max_attempts=max_attempts)
    result = run(rig)
    calls = len(kinds)
    assert calls <= max_attempts

    # Gemini and the verifier were called exactly as often as the sequence says, and no more.
    assert len(rig.gemini.requests) == calls
    assert rig.gemini.extra_calls == 0 and rig.verifier.extra_calls == 0
    assert [payload["source"] for payload in rig.verifier.payloads] == plan.sources
    assert rig.verifier.attempts == plan.verified_attempts
    for payload in rig.verifier.payloads:
        assert payload["required_tokens"] == rig.run.required
        assert payload["forbidden_tokens"] == rig.run.forbidden
        assert payload["contract_version"] == rig.run.contract.contract_version
    temperatures = [config["temperature"] for config in rig.gemini.generation_configs()]
    assert temperatures == [0.3] + [0.2] * (calls - 1)

    assert rig.event_names() == plan.events
    assert visits == plan.visits

    # The repair prompt of attempt n+1 carries what attempt n left behind.
    prompts = rig.gemini.prompts()
    for index, (codes, held) in enumerate(plan.prompt_needs, start=1):
        _, prompt = prompts[index]
        assert all(code in prompt for code in codes), (index, codes)
        assert held in prompt, index

    lines = animation_log_lines(caplog)
    assert [line["event"] for line in lines] == ["animation.start"] + ["animation.attempt"] * (
        calls
    ) + ["animation.end"]
    assert [line["outcome"] for line in lines[1:-1]] == plan.outcomes
    assert [line["attempt"] for line in lines[1:-1]] == list(range(1, calls + 1))
    assert set(lines[0]) == START_FIELDS and set(lines[-1]) == END_FIELDS
    assert all(set(line) == ATTEMPT_FIELDS for line in lines[1:-1])
    assert lines[-1]["attempts"] == calls and lines[-1]["cached"] is False

    if kinds[-1] == "good":
        won = published(result)
        assert won.calls == calls and won.row.attempts == calls and won.model == MODEL
        assert won.reference.animation_id == won.row.id
        assert lines[-1]["code"] == "OK"
        assert len(rig.s3.calls_of("put_object")) == 3 and len(rig.registry.calls) == 1
        manifest_key = won.row.s3_prefix + "manifest.json"
        assert AnimationManifest.model_validate_json(rig.s3.objects[manifest_key]).attempts == calls
    else:
        lost = failed(result, VERIFICATION_FAILED)
        assert calls == max_attempts and lost.calls == calls
        assert [item.code for item in lost.diagnostics] == plan.last_codes
        assert all(item.message == "" for item in lost.diagnostics)
        assert lines[-1]["code"] == VERIFICATION_FAILED
        assert rig.s3.calls == [] and rig.registry.calls == []


def test_a_diagnostic_event_of_a_skipped_verification_is_exactly_the_agent_item() -> None:
    """Requirement 13.17: one event, ok false, one error, no warning, `[{tool: agent, code}]`."""
    rig = make_rig(gemini=["nothing", fenced(source(1)), fenced(source(1))], max_attempts=3)
    rig.verifier.script.append(rejected("TSC_2304"))
    failed(run(rig), VERIFICATION_FAILED)
    skipped_first, rejected_second, skipped_third = diagnostics_events(rig)
    for event, code in (
        (skipped_first, "AGENT_EXTRACT_NO_CODE"),
        (skipped_third, "AGENT_REPAIR_UNCHANGED"),
    ):
        assert (event.ok, event.error_count, event.warning_count) == (False, 1, 0)
        assert [item.model_dump(exclude_none=True) for item in event.items] == [
            {"tool": "agent", "code": code}
        ]
    assert rejected_second.items[0].model_dump(exclude_none=True) == {
        "tool": "tsc",
        "code": "TSC_2304",
        "line": 3,
    }
    assert [event.attempt for event in diagnostics_events(rig)] == [1, 2, 3]


def test_a_repair_that_differs_only_by_normalisation_counts_as_unchanged() -> None:
    """The comparison is on the normalised source: a BOM, CRLF line ends and trailing blank lines
    do not make a new file (Requirement 13.8)."""
    reworded = "\ufeff" + source(1).replace("\n", "\r\n") + "\r\n\r\n"
    rig = make_rig(
        gemini=[fenced(source(1)), fenced(reworded), fenced(source(2))],
        verifier=[rejected("TSC_2304"), verified()],
    )
    won = published(run(rig))
    assert won.calls == 3
    assert len(rig.verifier.payloads) == 2
    assert rig.verifier.payloads[0]["source"] == source(1)
    assert diagnostics_events(rig)[1].items[0].code == "AGENT_REPAIR_UNCHANGED"


def test_after_an_unchanged_repair_the_prompt_holds_only_the_agent_item() -> None:
    """Design 6.6 sets `diagnostics = [AGENT_REPAIR_UNCHANGED]`; earlier findings are not kept."""
    rig = make_rig(
        gemini=[fenced(source(1)), fenced(source(1)), fenced(source(2))],
        verifier=[rejected("TSC_2304"), verified()],
    )
    published(run(rig))
    _, third = rig.gemini.prompts()[2]
    assert "AGENT_REPAIR_UNCHANGED" in third
    assert "TSC_2304" not in third


def test_the_published_model_is_the_one_that_wrote_the_published_source() -> None:
    """Two Gemini calls and three HTTP requests: the second call falls back to the next model
    and that model's name goes to the result, the registry row and the manifest (13.16)."""
    first_ok = fenced(source(1))
    second_ok = fenced(source(2))
    rig = make_rig(
        gemini=[first_ok, 404, second_ok],
        verifier=[rejected("TSC_2304"), verified()],
    )
    rig.run.models = ("model-a", "model-b")
    won = published(run(rig))
    paths = [request.url.path for request in rig.gemini.requests]
    assert [("model-a" in path, "model-b" in path) for path in paths] == [
        (True, False),
        (True, False),
        (False, True),
    ]
    assert won.calls == 2 and won.model == "model-b" and won.row.model == "model-b"
    manifest = AnimationManifest.model_validate_json(
        rig.s3.objects[won.row.s3_prefix + "manifest.json"]
    )
    assert (manifest.model, manifest.attempts) == ("model-b", 2)


def test_fifty_diagnostics_are_kept_errors_first_and_ten_are_sent() -> None:
    """Requirement 13.10 and 17.3: all 50 stay in the result, the event shows ten without text."""
    outcome = rejected(*["TSC_2304"] * 30, warnings=["ESLINT_LORE_X"] * 20)
    assert outcome.result is not None
    assert [d.severity for d in outcome.result.diagnostics][:20] == ["warning"] * 20
    rig = make_rig(gemini=[fenced(source(1))], verifier=[outcome], max_attempts=1)
    lost = failed(run(rig), VERIFICATION_FAILED)
    assert [d.severity for d in lost.diagnostics] == ["error"] * 30 + ["warning"] * 20
    (event,) = diagnostics_events(rig)
    assert (event.error_count, event.warning_count, len(event.items)) == (30, 20, 10)
    assert {item.code for item in event.items} == {"TSC_2304"}


def test_a_verified_run_with_warnings_reports_them_and_keeps_them_in_the_manifest() -> None:
    rig = make_rig(gemini=[fenced(source(1))], verifier=[verified(warnings=["ESLINT_LORE_X"] * 3)])
    won = published(run(rig))
    (event,) = diagnostics_events(rig)
    assert (event.ok, event.error_count, event.warning_count) == (True, 0, 3)
    manifest = AnimationManifest.model_validate_json(
        rig.s3.objects[won.row.s3_prefix + "manifest.json"]
    )
    assert [w.code for w in manifest.verification.warnings] == ["ESLINT_LORE_X"] * 3


def test_a_puzzle_sends_its_forbidden_tokens_and_a_lesson_sends_none() -> None:
    puzzle = make_rig(kind="puzzle", gemini=[fenced(source(1))], verifier=[verified(kind="puzzle")])
    published(run(puzzle))
    assert puzzle.verifier.payloads[0]["forbidden_tokens"] == ["seven"]
    assert puzzle.verifier.payloads[0]["kind"] == "puzzle"
    lesson = make_rig(gemini=[fenced(source(1))], verifier=[verified()])
    published(run(lesson))
    assert lesson.verifier.payloads[0]["forbidden_tokens"] == []


# --- 3. verifier outcomes ---------------------------------------------------------------------

INFRASTRUCTURE_OUTCOMES: dict[str, Callable[[], Any]] = {
    "unavailable-throttled": lambda: unavailable("throttled"),
    "unavailable-bad-shape": lambda: unavailable("bad_shape"),
    "invoke-raises-runtime-error": lambda: RuntimeError("boom"),
    "invoke-raises-os-error": lambda: OSError("network is down"),
    "invoke-raises-timeout-error": lambda: TimeoutError(),
    "internal": lambda: rejected("VERIFIER_INTERNAL"),
    "contract-mismatch": lambda: rejected("VERIFIER_CONTRACT_MISMATCH"),
    "bad-input": lambda: rejected("VERIFIER_BAD_INPUT"),
    "internal-among-other-findings": lambda: rejected(
        "TSC_2304", "VERIFIER_INTERNAL", warnings=["ESLINT_LORE_X"]
    ),
}
# (attempt that meets the problem, max_attempts): the last attempt must not turn into
# ANIMATION_VERIFICATION_FAILED, and the problem must stop the run at any position.
POSITIONS = [(1, 1), (1, 4), (2, 2), (2, 4), (3, 4)]


@pytest.mark.parametrize(("position", "max_attempts"), POSITIONS)
@pytest.mark.parametrize("make", INFRASTRUCTURE_OUTCOMES.values(), ids=INFRASTRUCTURE_OUTCOMES)
def test_a_verifier_that_is_not_available_ends_the_run_without_another_gemini_call(
    make: Callable[[], Any],
    position: int,
    max_attempts: int,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO)
    rig = make_rig(
        gemini=[fenced(source(n)) for n in range(1, position + 2)],
        verifier=[*[rejected("TSC_2304")] * (position - 1), make(), verified()],
        max_attempts=max_attempts,
    )
    lost = failed(run(rig), UNAVAILABLE)
    assert lost.calls == position
    assert len(rig.gemini.requests) == position
    assert len(rig.verifier.payloads) == position
    expected = [e for n in range(1, position) for e in failed_attempt_events(n)]
    expected += [f"stage:{stage_name(position)}:{position}", f"stage:verifying:{position}"]
    assert rig.event_names() == expected  # no `diagnostics` event for the unavailable attempt
    assert rig.s3.calls == [] and rig.registry.calls == []
    lines = animation_log_lines(caplog)
    assert [line["outcome"] for line in lines if line["event"] == "animation.attempt"] == [
        "verify_failed"
    ] * (position - 1)
    assert (lines[-1]["code"], lines[-1]["attempts"]) == (UNAVAILABLE, position)


@pytest.mark.parametrize(("position", "max_attempts"), POSITIONS)
def test_a_verifier_that_timed_out_is_a_timeout_not_unavailable(
    position: int, max_attempts: int
) -> None:
    rig = make_rig(
        gemini=[fenced(source(n)) for n in range(1, position + 2)],
        verifier=[*[rejected("TSC_2304")] * (position - 1), LambdaOutcome("timeout"), verified()],
        max_attempts=max_attempts,
    )
    lost = failed(run(rig), TIMEOUT)
    assert lost.calls == position and len(rig.gemini.requests) == position
    assert rig.s3.calls == [] and rig.registry.calls == []


def test_the_verifier_gets_the_time_left_and_the_attempt_number() -> None:
    rig = make_rig(gemini=[fenced(source(1)), fenced(source(2))], deadline_ms=10_000)
    rig.verifier.script += [
        verifier_after(lambda: rig.clock.advance_ms(4_000), rejected("TSC_2304")),
        verified(),
    ]
    published(run(rig))
    assert rig.verifier.remaining == [10_000, 6_000]
    assert rig.verifier.attempts == [1, 2]


@pytest.mark.parametrize("max_attempts", [1, 2, 3, 4])
def test_a_verifier_that_crashes_on_every_attempt_fails_after_max_attempts(
    max_attempts: int,
) -> None:
    rig = make_rig(
        gemini=[fenced(source(n)) for n in range(1, 6)],
        verifier=[crashed()] * 5,
        max_attempts=max_attempts,
    )
    lost = failed(run(rig), VERIFICATION_FAILED)
    assert lost.calls == max_attempts == len(rig.verifier.payloads)
    (item,) = lost.diagnostics
    assert (item.tool, item.code, item.severity) == ("verifier", "VERIFIER_CRASH", "error")
    assert item.line is None and item.column is None
    for event in diagnostics_events(rig):
        assert (event.ok, event.error_count, event.warning_count) == (False, 1, 0)
        (shown,) = event.items
        assert (shown.tool, shown.code, shown.line) == ("verifier", "VERIFIER_CRASH", None)


def test_a_crash_is_repaired_with_a_fixed_message_that_holds_nothing_from_the_lambda() -> None:
    rig = make_rig(gemini=[fenced(source(1)), fenced(source(2))], verifier=[crashed(), verified()])
    published(run(rig))
    _, repair_prompt = rig.gemini.prompts()[1]
    assert VERIFIER_CRASH_MESSAGE in repair_prompt
    assert "errorMessage" not in repair_prompt and "stackTrace" not in repair_prompt


@pytest.mark.parametrize(("max_attempts", "ends"), [(1, "failed"), (2, "repaired")])
def test_a_verifier_deadline_diagnostic_is_a_failed_attempt_not_an_outage(
    max_attempts: int, ends: str
) -> None:
    rig = make_rig(
        gemini=[fenced(source(1)), fenced(source(2))],
        verifier=[rejected("VERIFIER_DEADLINE"), verified()],
        max_attempts=max_attempts,
    )
    result = run(rig)
    if ends == "failed":
        lost = failed(result, VERIFICATION_FAILED)
        assert [item.code for item in lost.diagnostics] == ["VERIFIER_DEADLINE"]
    else:
        assert published(result).calls == 2
        assert "VERIFIER_DEADLINE" in rig.gemini.prompts()[1][1]


# --- 3b. the real verifier client feeds the agent ---------------------------------------------


class ThrottlingError(Exception):
    """Has the `response` shape of a botocore `ClientError`, and nothing else."""

    def __init__(self) -> None:
        super().__init__("Rate exceeded")
        self.response = {"Error": {"Code": "TooManyRequestsException", "Message": "Rate exceeded"}}


def lambda_response(outcome: LambdaOutcome, *, status: int = 200) -> dict[str, Any]:
    """The dict `client.invoke` returns for a verifier result."""
    assert outcome.result is not None
    body = outcome.result.model_dump_json(by_alias=True, exclude_none=True).encode()
    return {"StatusCode": status, "Payload": io.BytesIO(body)}


def lambda_crash_response(message: str = "crash") -> dict[str, Any]:
    body = json.dumps({"errorMessage": message, "stackTrace": [message]}).encode()
    return {"StatusCode": 200, "FunctionError": "Unhandled", "Payload": io.BytesIO(body)}


def lambda_raw(body: bytes) -> dict[str, Any]:
    return {"StatusCode": 200, "Payload": io.BytesIO(body)}


class ScriptedLambda:
    """A boto3 Lambda client double: `invoke(**kwargs)` answers from a script.

    A step is a response dict, an exception to raise, or a callable that gets the call. The call
    can block in its own thread on `gate` (closed at construction when `blocked`), which is how a
    verifier that does not answer is made: `entered` is set when the call starts and `finished`
    when it returns, so a test knows where the thread is without sleeping.
    """

    def __init__(self, script: list[Any] | None = None, *, blocked: bool = False) -> None:
        self.script = list(script or [])
        self.calls = 0
        self.kwargs: list[dict[str, Any]] = []
        self.gate = threading.Event()
        if not blocked:
            self.gate.set()
        self.entered = threading.Event()
        self.finished = threading.Event()

    def invoke(self, **kwargs: Any) -> Any:
        self.calls += 1
        self.kwargs.append(kwargs)
        self.entered.set()
        try:
            if not self.gate.wait(30):
                raise TimeoutError("the test never opened the gate")
            step = self.script.pop(0)
            if isinstance(step, BaseException):
                raise step
            return step(kwargs) if callable(step) else step
        finally:
            self.finished.set()


def real_verifier(rig: Rig, lambda_client: ScriptedLambda) -> LambdaVerifierClient:
    client = LambdaVerifierClient("lore-verifier", "ap-southeast-3", client=lambda_client)
    rig.run.verifier = client
    return client


def test_the_real_verifier_client_sends_five_keys_and_the_agent_reads_the_result() -> None:
    rig = make_rig(gemini=[fenced(source(1))])
    boto = ScriptedLambda([lambda_response(verified())])
    real_verifier(rig, boto)
    won = published(run(rig))
    (call,) = boto.kwargs
    assert call["FunctionName"] == "lore-verifier" and call["InvocationType"] == "RequestResponse"
    sent = json.loads(call["Payload"])
    assert set(sent) == {
        "source",
        "kind",
        "required_tokens",
        "forbidden_tokens",
        "contract_version",
    }
    assert sent["source"] == source(1) and sent["required_tokens"] == rig.run.required
    assert won.calls == 1


@pytest.mark.parametrize(
    ("script", "code", "gemini_calls"),
    [
        pytest.param([lambda_crash_response()] * 2, VERIFICATION_FAILED, 2, id="crash-twice"),
        pytest.param([ThrottlingError()], UNAVAILABLE, 1, id="throttled"),
        pytest.param([PermissionError("denied")], UNAVAILABLE, 1, id="refused"),
        pytest.param([lambda_raw(b"not json")], UNAVAILABLE, 1, id="not-json"),
        pytest.param([lambda_raw(b"")], UNAVAILABLE, 1, id="empty"),
        pytest.param([lambda_raw(b'{"ok": true}')], UNAVAILABLE, 1, id="wrong-shape"),
        pytest.param(
            [lambda_response(rejected("VERIFIER_INTERNAL"))], UNAVAILABLE, 1, id="internal"
        ),
        pytest.param(
            [lambda_response(rejected("VERIFIER_CONTRACT_MISMATCH"))],
            UNAVAILABLE,
            1,
            id="contract-mismatch",
        ),
    ],
)
def test_what_the_real_client_classifies_decides_the_run(
    script: list[Any], code: str, gemini_calls: int
) -> None:
    rig = make_rig(gemini=[fenced(source(n)) for n in (1, 2, 3)], max_attempts=2)
    boto = ScriptedLambda(script)
    real_verifier(rig, boto)
    lost = failed(run(rig), code)
    assert lost.calls == gemini_calls == len(rig.gemini.requests)
    assert boto.calls == gemini_calls
    assert rig.s3.calls == [] and rig.registry.calls == []


def test_a_crash_then_a_verified_repair_publishes_through_the_real_client() -> None:
    rig = make_rig(gemini=[fenced(source(1)), fenced(source(2))])
    boto = ScriptedLambda([lambda_crash_response(), lambda_response(verified())])
    real_verifier(rig, boto)
    assert published(run(rig)).calls == 2


# --- 4. Gemini failures -----------------------------------------------------------------------


def _read_timeout(_request: httpx2.Request) -> httpx2.Response:
    raise httpx2.ReadTimeout("slow")


def _network_down(_request: httpx2.Request) -> httpx2.Response:
    raise httpx2.ConnectError("no route")


def _empty_reply(_request: httpx2.Request) -> httpx2.Response:
    body = {"candidates": [{"content": {"parts": [{"text": "   "}]}, "finishReason": "STOP"}]}
    return httpx2.Response(200, json=body)


# What the real client turns each provider answer into, and what the agent makes of it
# (Requirement 13.9: RATE_LIMITED, TIMEOUT -> ANIMATION_TIMEOUT, PROVIDER_UNAVAILABLE; the rest
# is not a closed code of its own).
REAL_GEMINI_FAILURES: dict[str, tuple[Any, str]] = {
    "http-429": (429, "RATE_LIMITED"),
    "http-500": (500, "PROVIDER_UNAVAILABLE"),
    "http-503": (503, "PROVIDER_UNAVAILABLE"),
    "http-401": (401, "PROVIDER_UNAVAILABLE"),
    "http-403": (403, "PROVIDER_UNAVAILABLE"),
    "http-400": (400, "PROVIDER_UNAVAILABLE"),
    "http-404": (404, "PROVIDER_UNAVAILABLE"),
    "read-timeout": (_read_timeout, TIMEOUT),
    "network-error": (_network_down, "PROVIDER_UNAVAILABLE"),
    "empty-reply": (_empty_reply, "PROVIDER_UNAVAILABLE"),
}
GEMINI_POSITIONS = [(1, 1), (1, 4), (2, 2), (2, 4), (4, 4)]


@pytest.mark.parametrize(("position", "max_attempts"), GEMINI_POSITIONS)
@pytest.mark.parametrize(
    ("reply", "code"), REAL_GEMINI_FAILURES.values(), ids=list(REAL_GEMINI_FAILURES)
)
def test_a_gemini_failure_ends_the_run_with_the_matching_code_and_no_more_calls(
    reply: Any,
    code: str,
    position: int,
    max_attempts: int,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO)
    good = [fenced(source(n)) for n in range(1, position)]
    rig = make_rig(
        gemini=[*good, reply, fenced(source(9))],
        verifier=[*[rejected("TSC_2304")] * (position - 1), verified()],
        max_attempts=max_attempts,
    )
    lost = failed(run(rig), code)
    assert lost.calls == position
    assert len(rig.gemini.requests) == position  # the failed call, and nothing after it
    assert len(rig.verifier.payloads) == position - 1
    expected = [e for n in range(1, position) for e in failed_attempt_events(n)]
    assert rig.event_names() == [*expected, f"stage:{stage_name(position)}:{position}"]
    assert rig.s3.calls == [] and rig.registry.calls == []
    lines = animation_log_lines(caplog)
    outcomes = [line["outcome"] for line in lines if line["event"] == "animation.attempt"]
    assert outcomes == ["verify_failed"] * (position - 1) + ["gemini_failed"]
    assert (lines[-1]["code"], lines[-1]["attempts"]) == (code, position)


@dataclass(frozen=True)
class StubAi(AiContext):
    """An `AiContext` whose `generate_text` answers from a list of ready-made results.

    This is for the failure codes the real text client cannot produce (`OUTPUT_PARSE_FAILED`
    needs JSON mode) and for a code that does not exist yet. The agent still builds the
    per-call config with `replace`, so `configs` shows what it asked for.
    """

    results: list[Any] = field(default_factory=list)
    requests: list[GeminiRequest] = field(default_factory=list)
    configs: list[GeminiConfig] = field(default_factory=list)

    async def generate_text(self, request: GeminiRequest) -> Any:
        self.requests.append(request)
        self.configs.append(self.config)
        return self.results.pop(0)


def text_ok(text: str) -> GeminiTextOk:
    return GeminiTextOk(
        text=text,
        model=MODEL,
        usage=GeminiUsage(1, 1, 2),
        latency_ms=1.0,
        finish_reason="STOP",
    )


def stub_ai(rig: Rig, *results: Any) -> StubAi:
    stub = StubAi(rig.run.ai.config, rig.run.ai.runtime, results=list(results))
    rig.run.ai = stub
    return stub


@pytest.mark.parametrize("code", ["OUTPUT_PARSE_FAILED", "SOMETHING_THE_CLIENT_DOES_NOT_HAVE"])
@pytest.mark.parametrize(("position", "max_attempts"), GEMINI_POSITIONS)
def test_a_gemini_failure_that_has_no_code_of_its_own_is_unknown(
    code: str, position: int, max_attempts: int, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO)
    rig = make_rig(
        verifier=[*[rejected("TSC_2304")] * (position - 1), verified()], max_attempts=max_attempts
    )
    stub = stub_ai(
        rig,
        *[text_ok(fenced(source(n))) for n in range(1, position)],
        GeminiFailure(code, "failed", [{"model": MODEL, "reason": "x"}]),  # type: ignore[arg-type]
        text_ok(fenced(source(9))),
    )
    lost = failed(run(rig), "UNKNOWN")
    assert lost.calls == position == len(stub.requests)
    assert len(rig.verifier.payloads) == position - 1
    assert end_line(caplog)["code"] == "UNKNOWN"
    assert rig.s3.calls == [] and rig.registry.calls == []


@pytest.mark.parametrize(
    ("timeout_ms", "gemini_deadline_ms", "run_deadline_ms", "spent_ms", "expected_s"),
    [
        (300_000, 300_000, 240_000, 100_000, (240.0, 140.0)),
        (100_000, 300_000, 240_000, 100_000, (100.0, 100.0)),
        (300_000, 50_000, 240_000, 100_000, (50.0, 50.0)),
        (5_000, 5_000, 2_000, 1_000, (2.0, 1.0)),
        (300_000, 300_000, 1_500, 1_499, (1.5, 0.001)),
    ],
)
def test_each_gemini_call_is_limited_by_the_time_left_of_the_run(
    timeout_ms: float,
    gemini_deadline_ms: float,
    run_deadline_ms: float,
    spent_ms: float,
    expected_s: tuple[float, float],
) -> None:
    """`timeout_ms` and `deadline_ms` become the smallest of the configured value and the time
    left, so a call cannot outlive the run (Requirement 4.7)."""
    rig = make_rig(
        gemini=[fenced(source(1)), fenced(source(2))],
        deadline_ms=run_deadline_ms,
        ai_timeout_ms=timeout_ms,
        ai_deadline_ms=gemini_deadline_ms,
    )
    rig.verifier.script += [
        verifier_after(lambda: rig.clock.advance_ms(spent_ms), rejected("TSC_2304")),
        verified(),
    ]
    published(run(rig))
    read_timeouts = [r.extensions["timeout"]["read"] for r in rig.gemini.requests]
    assert read_timeouts == pytest.approx(list(expected_s))


def test_the_configuration_of_the_run_is_not_changed_by_the_per_call_limit() -> None:
    rig = make_rig(gemini=[fenced(source(1))], verifier=[verified()], deadline_ms=1_000)
    before = rig.run.ai.config
    published(run(rig))
    assert rig.run.ai.config is before and before.timeout_ms == 300_000


def test_a_call_that_starts_with_one_millisecond_left_is_still_made() -> None:
    rig = make_rig(gemini=[fenced(source(1))], verifier=[verified()], deadline_ms=240_000)
    rig.clock.advance_ms(239_999)
    assert published(run(rig)).calls == 1


# --- 5a. the deadline at every point ----------------------------------------------------------


@dataclass
class Expect:
    """What a run stopped by the deadline or by a cancel may have done before it stopped."""

    events: list[str]
    calls: int  # Gemini calls started
    gemini_requests: int  # HTTP requests that really left (a call can be refused with no time)
    verifier_calls: int
    s3_ops: list[str] = field(default_factory=list)
    code: str = TIMEOUT
    log_code: str = TIMEOUT
    verifier_counter: Callable[[], int] | None = None  # default: calls seen by the scripted one
    manifest_written: bool = False  # a manifest put that had already started cannot be undone


FIRST = ["stage:generating:1"]
VERIFYING = [*FIRST, "stage:verifying:1"]
REJECTED = [*VERIFYING, "diagnostics:1:False:1"]
REPAIRING = [*REJECTED, "stage:repairing:2"]
ACCEPTED = [*VERIFYING, "diagnostics:1:True:0"]
PUBLISHING = [*ACCEPTED, "stage:publishing:1"]
S3_GET = "get_object manifest.json"
S3_TS = "put_object main.ts"
S3_JS = "put_object main.js"


def passes(rig: Rig) -> Callable[[], None]:
    """Move the clock past the deadline."""
    return lambda: rig.clock.advance_ms(rig.run.deadline_ms + 1)


def case_before_the_start() -> tuple[Rig, Expect]:
    rig = make_rig(gemini=[fenced(source(1))], verifier=[verified()])
    passes(rig)()
    return rig, Expect([], 0, 0, 0)


def case_after_the_generating_event() -> tuple[Rig, Expect]:
    rig = make_rig(gemini=[fenced(source(1))], verifier=[verified()])
    at_event(rig, "stage:generating:1", passes(rig))
    return rig, Expect(FIRST, 1, 0, 0)  # the client sends nothing with no time left


def case_inside_the_generate_call() -> tuple[Rig, Expect]:
    rig = make_rig(verifier=[verified()])
    rig.gemini.replies.append(reply_after(passes(rig), fenced(source(1))))
    return rig, Expect(FIRST, 1, 1, 0)


def case_after_the_verifying_event_with_the_real_client() -> tuple[Rig, Expect]:
    rig = make_rig(gemini=[fenced(source(1))])
    boto = ScriptedLambda([lambda_response(verified())])
    real_verifier(rig, boto)
    at_event(rig, "stage:verifying:1", passes(rig))
    return rig, Expect(VERIFYING, 1, 1, 0, verifier_counter=lambda: boto.calls)  # no Lambda call


def case_inside_the_verifier_with_an_accepting_answer() -> tuple[Rig, Expect]:
    rig = make_rig(gemini=[fenced(source(1))])
    rig.verifier.script.append(verifier_after(passes(rig), verified()))
    return rig, Expect(VERIFYING, 1, 1, 1)


def case_inside_the_verifier_with_a_rejecting_answer() -> tuple[Rig, Expect]:
    rig = make_rig(gemini=[fenced(source(1)), fenced(source(2))])
    rig.verifier.script += [verifier_after(passes(rig), rejected("TSC_2304")), verified()]
    return rig, Expect(VERIFYING, 1, 1, 1)  # not repaired: there is no time


def case_after_a_rejection() -> tuple[Rig, Expect]:
    rig = make_rig(gemini=[fenced(source(1)), fenced(source(2))])
    rig.verifier.script += [rejected("TSC_2304"), verified()]
    at_event(rig, "diagnostics:1:False:1", passes(rig))
    return rig, Expect(REJECTED, 1, 1, 1)


def case_after_the_repairing_event() -> tuple[Rig, Expect]:
    rig = make_rig(gemini=[fenced(source(1)), fenced(source(2))])
    rig.verifier.script += [rejected("TSC_2304"), verified()]
    at_event(rig, "stage:repairing:2", passes(rig))
    return rig, Expect(REPAIRING, 2, 1, 1)


def case_inside_the_repair_call() -> tuple[Rig, Expect]:
    rig = make_rig(gemini=[fenced(source(1))])
    rig.gemini.replies.append(reply_after(passes(rig), fenced(source(2))))
    rig.verifier.script += [rejected("TSC_2304"), verified()]
    return rig, Expect(REPAIRING, 2, 2, 1)


def case_after_an_accepting_result() -> tuple[Rig, Expect]:
    rig = make_rig(gemini=[fenced(source(1))], verifier=[verified()])
    at_event(rig, "diagnostics:1:True:0", passes(rig))
    return rig, Expect(ACCEPTED, 1, 1, 1)


def case_after_the_publishing_event() -> tuple[Rig, Expect]:
    rig = make_rig(gemini=[fenced(source(1))], verifier=[verified()])
    at_event(rig, "stage:publishing:1", passes(rig))
    return rig, Expect(PUBLISHING, 1, 1, 1)  # no S3 call is started


def case_during_the_manifest_read() -> tuple[Rig, Expect]:
    rig = make_rig(gemini=[fenced(source(1))], verifier=[verified()])
    rig.s3.before("get_object", "manifest.json", passes(rig))
    return rig, Expect(PUBLISHING, 1, 1, 1, [S3_GET])


def case_during_the_source_write() -> tuple[Rig, Expect]:
    rig = make_rig(gemini=[fenced(source(1))], verifier=[verified()])
    rig.s3.before("put_object", "main.ts", passes(rig))
    return rig, Expect(PUBLISHING, 1, 1, 1, [S3_GET, S3_TS])


def case_during_the_bundle_write() -> tuple[Rig, Expect]:
    rig = make_rig(gemini=[fenced(source(1))], verifier=[verified()])
    rig.s3.before("put_object", "main.js", passes(rig))
    return rig, Expect(PUBLISHING, 1, 1, 1, [S3_GET, S3_TS, S3_JS])


def case_during_the_manifest_write() -> tuple[Rig, Expect]:
    rig = make_rig(gemini=[fenced(source(1))], verifier=[verified()])
    rig.s3.before("put_object", "manifest.json", passes(rig))
    every_put = [S3_GET, S3_TS, S3_JS, "put_object manifest.json"]
    return rig, Expect(PUBLISHING, 1, 1, 1, every_put, manifest_written=True)


DEADLINE_CASES = [
    case_before_the_start,
    case_after_the_generating_event,
    case_inside_the_generate_call,
    case_after_the_verifying_event_with_the_real_client,
    case_inside_the_verifier_with_an_accepting_answer,
    case_inside_the_verifier_with_a_rejecting_answer,
    case_after_a_rejection,
    case_after_the_repairing_event,
    case_inside_the_repair_call,
    case_after_an_accepting_result,
    case_after_the_publishing_event,
    case_during_the_manifest_read,
    case_during_the_source_write,
    case_during_the_bundle_write,
    case_during_the_manifest_write,
]


def check_stopped(rig: Rig, expect: Expect, caplog: pytest.LogCaptureFixture) -> AgentFailed:
    lost = failed(run(rig), expect.code)
    assert lost.calls == expect.calls
    assert rig.event_names() == expect.events
    assert len(rig.gemini.requests) == expect.gemini_requests and rig.gemini.extra_calls == 0
    counter = expect.verifier_counter or (lambda: len(rig.verifier.payloads))
    assert counter() == expect.verifier_calls
    assert rig.s3.ops() == expect.s3_ops
    wrote = any(key.endswith("manifest.json") for key in rig.s3.objects)
    assert wrote == expect.manifest_written
    assert rig.registry.calls == [] and rig.registry.rows == []
    assert end_line(caplog)["code"] == expect.log_code
    assert end_line(caplog)["attempts"] == expect.calls
    return lost


@pytest.mark.parametrize(
    "make_case", DEADLINE_CASES, ids=lambda f: f.__name__.removeprefix("case_")
)
def test_a_deadline_that_passes_at_any_point_ends_as_a_timeout_without_a_late_write(
    make_case: Callable[[], tuple[Rig, Expect]], caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO)
    rig, expect = make_case()
    check_stopped(rig, expect, caplog)


def test_a_deadline_during_the_manifest_write_keeps_the_row_out_of_the_registry() -> None:
    """The manifest put had already started when the time ran out, so the object exists; no row is
    written and the run is a timeout. A later request finds the manifest and adopts it."""
    rig = make_rig(gemini=[fenced(source(1))], verifier=[verified()])
    rig.s3.before("put_object", "manifest.json", passes(rig))
    failed(run(rig), TIMEOUT)
    assert rig.s3.ops() == [S3_GET, S3_TS, S3_JS, "put_object manifest.json"]
    assert rig.registry.calls == []
    again = make_rig(gemini=[fenced(source(1))], verifier=[verified()], s3=rig.s3)
    assert published(run(again)).calls == 1
    assert len(rig.s3.calls_of("put_object")) == 3  # adopted, nothing written the second time


def test_a_timeout_ends_the_run_in_the_same_state_as_the_table_says() -> None:
    """The failure code of a deadline never depends on what the last step answered."""
    for answer in (verified(), rejected("TSC_2304"), unavailable(), crashed()):
        rig = make_rig(gemini=[fenced(source(1))])
        rig.verifier.script.append(verifier_after(passes(rig), answer))
        failed(run(rig), TIMEOUT)


# --- 5b. a cancel flag at every point ---------------------------------------------------------
#
# The endpoint sets `RunContext.cancelled` when the client leaves. From that moment nothing may
# start (no Gemini call, no verification, no S3 write, no registry row, no event) and the run ends
# as the internal `UNKNOWN` that is never sent (Requirement 13.15).


def flagged(rig: Rig) -> Callable[[], None]:
    return rig.run.cancelled.set


def stopped(events: list[str], calls: int, requests: int, verifier: int, s3: list[str]) -> Expect:
    return Expect(events, calls, requests, verifier, s3, code="UNKNOWN", log_code=END_CANCELLED)


def flag_before_the_start() -> tuple[Rig, Expect]:
    rig = make_rig(gemini=[fenced(source(1))], verifier=[verified()])
    flagged(rig)()
    return rig, stopped([], 0, 0, 0, [])


def flag_inside_the_generate_call() -> tuple[Rig, Expect]:
    rig = make_rig(verifier=[verified()])
    rig.gemini.replies.append(reply_after(flagged(rig), fenced(source(1))))
    return rig, stopped(FIRST, 1, 1, 0, [])


def flag_inside_the_verifier() -> tuple[Rig, Expect]:
    rig = make_rig(gemini=[fenced(source(1))])
    rig.verifier.script.append(verifier_after(flagged(rig), verified()))
    return rig, stopped(VERIFYING, 1, 1, 1, [])


def flag_after_a_rejection() -> tuple[Rig, Expect]:
    rig = make_rig(gemini=[fenced(source(1)), fenced(source(2))])
    rig.verifier.script += [rejected("TSC_2304"), verified()]
    at_event(rig, "diagnostics:1:False:1", flagged(rig))
    return rig, stopped(REJECTED, 1, 1, 1, [])


def flag_inside_the_repair_call() -> tuple[Rig, Expect]:
    rig = make_rig(gemini=[fenced(source(1))])
    rig.gemini.replies.append(reply_after(flagged(rig), fenced(source(2))))
    rig.verifier.script += [rejected("TSC_2304"), verified()]
    return rig, stopped(REPAIRING, 2, 2, 1, [])


def flag_after_the_publishing_event() -> tuple[Rig, Expect]:
    rig = make_rig(gemini=[fenced(source(1))], verifier=[verified()])
    at_event(rig, "stage:publishing:1", flagged(rig))
    return rig, stopped(PUBLISHING, 1, 1, 1, [])


def flag_during_the_manifest_read() -> tuple[Rig, Expect]:
    rig = make_rig(gemini=[fenced(source(1))], verifier=[verified()])
    rig.s3.before("get_object", "manifest.json", flagged(rig))
    return rig, stopped(PUBLISHING, 1, 1, 1, [S3_GET])


def flag_during_the_bundle_write() -> tuple[Rig, Expect]:
    rig = make_rig(gemini=[fenced(source(1))], verifier=[verified()])
    rig.s3.before("put_object", "main.js", flagged(rig))
    return rig, stopped(PUBLISHING, 1, 1, 1, [S3_GET, S3_TS, S3_JS])


def flag_during_the_manifest_write() -> tuple[Rig, Expect]:
    rig = make_rig(gemini=[fenced(source(1))], verifier=[verified()])
    rig.s3.before("put_object", "manifest.json", flagged(rig))
    expect = stopped(PUBLISHING, 1, 1, 1, [S3_GET, S3_TS, S3_JS, "put_object manifest.json"])
    expect.manifest_written = True
    return rig, expect


FLAG_CASES = [
    flag_before_the_start,
    flag_inside_the_generate_call,
    flag_inside_the_verifier,
    flag_after_a_rejection,
    flag_inside_the_repair_call,
    flag_after_the_publishing_event,
    flag_during_the_manifest_read,
    flag_during_the_bundle_write,
    flag_during_the_manifest_write,
]


@pytest.mark.parametrize("make_case", FLAG_CASES, ids=lambda f: f.__name__.removeprefix("flag_"))
def test_a_cancel_flag_at_any_point_starts_nothing_and_ends_as_unknown(
    make_case: Callable[[], tuple[Rig, Expect]], caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO)
    rig, expect = make_case()
    check_stopped(rig, expect, caplog)


def test_nothing_is_emitted_once_the_cancel_flag_is_set() -> None:
    """The guard in `_emit` is the last line of Requirement 13.15. Every node checks the flag
    before it starts, so no run reaches it through the nodes alone; it is checked here directly."""
    rig = make_rig()
    event = StageEvent(stage="generating", attempt=1)
    agent._emit(rig.run, event)
    assert rig.events == [event]
    rig.run.cancelled.set()
    agent._emit(rig.run, event)
    assert rig.events == [event]


# --- 5c. task.cancel() while a step is blocked ------------------------------------------------


async def cancel_run(rig: Rig, entered: Callable[[], Awaitable[Any]]) -> float:
    """Run the agent the way the endpoint does (a concurrency slot held for the whole run), cancel
    the task once `entered` says the run is blocked, and return how long the cancel took.

    The `finally` that gives the slot back is the one in the SSE generator; it runs as soon as the
    run returns control, so `in_flight()` is back at its old value only if the run did not wait for
    whatever it was blocked on (Requirements 14.7, 14.13).
    """
    limiter = AiLimiter(AiLimits(max_concurrent_per_ip=1, max_concurrent_global=2))
    baseline = limiter.in_flight()

    async def serve() -> AgentResult:
        assert limiter.try_acquire(IP) is None
        try:
            return await run_agent(rig.run)
        finally:
            limiter.release(IP)

    task = asyncio.create_task(serve())
    assert await asyncio.wait_for(entered(), 5)
    assert limiter.in_flight() == baseline + 1
    started = time.monotonic()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    elapsed = time.monotonic() - started
    assert limiter.in_flight() == baseline
    assert limiter.try_acquire(IP) is None  # the slot is really free again
    limiter.release(IP)
    return elapsed


def blocked_reply(entered: asyncio.Event) -> Callable[[httpx2.Request], Any]:
    async def handler(_request: httpx2.Request) -> httpx2.Response:
        entered.set()
        await asyncio.sleep(60)
        raise AssertionError("a cancelled request must not get here")

    return handler


def blocked_verifier(entered: asyncio.Event) -> Any:
    async def step(_payload: dict[str, Any], _remaining: float) -> LambdaOutcome:
        entered.set()
        await asyncio.sleep(60)
        raise AssertionError("a cancelled verification must not get here")

    return step


async def cancel_at(point: str) -> tuple[Rig, float]:
    entered = asyncio.Event()
    rig = make_rig(gemini=[fenced(source(1))], verifier=[verified()])
    if point == "generate":
        rig.gemini.replies[:] = [blocked_reply(entered)]
    elif point == "verifier":
        rig.verifier.script[:] = [blocked_verifier(entered)]
    else:  # the second Gemini call, after a rejection
        rig.verifier.script[:] = [rejected("TSC_2304"), verified()]
        rig.gemini.replies.append(blocked_reply(entered))
    return rig, await cancel_run(rig, entered.wait)


@pytest.mark.parametrize(
    ("point", "events", "requests", "verifier_calls", "calls"),
    [
        ("generate", FIRST, 1, 0, 1),
        ("verifier", VERIFYING, 1, 1, 1),
        ("repair", REPAIRING, 2, 1, 2),
    ],
)
def test_cancelling_the_task_stops_the_run_at_once_and_releases_the_slot(
    point: str,
    events: list[str],
    requests: int,
    verifier_calls: int,
    calls: int,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO)
    rig, elapsed = asyncio.run(cancel_at(point))
    assert elapsed < 1.0
    assert rig.run.cancelled.is_set()
    assert rig.event_names() == events
    assert len(rig.gemini.requests) == requests
    assert len(rig.verifier.payloads) == verifier_calls
    assert rig.s3.calls == [] and rig.registry.calls == []
    line = end_line(caplog)
    assert (line["code"], line["attempts"]) == (END_CANCELLED, calls)


# --- 6. threads that block ---------------------------------------------------------------------
#
# The verifier call, the S3 writes and the registry write are synchronous, so each one runs in a
# worker thread (`asyncio.to_thread`). A thread cannot be interrupted: a run that is cancelled or
# out of time must come back at once, leave the thread to finish alone, and drop whatever it
# answers. The doubles below block in their own thread on a `threading.Event` that the test opens,
# so the test knows where each thread is without sleeping, and no thread outlives its test.


async def serve_with_slot(rig: Rig, limiter: AiLimiter) -> AgentResult:
    """What the SSE generator does: hold a concurrency slot for the life of the run."""
    assert limiter.try_acquire(IP) is None
    try:
        return await run_agent(rig.run)
    finally:
        limiter.release(IP)


def test_the_event_loop_stays_free_while_the_verifier_thread_blocks() -> None:
    """Requirement 14.2: other tasks keep running while `invoke` blocks a thread."""
    rig = make_rig(gemini=[fenced(source(1))])
    boto = ScriptedLambda([lambda_response(verified())], blocked=True)
    real_verifier(rig, boto)

    async def scenario() -> tuple[AgentResult, int]:
        ticks = 0

        async def ticker() -> None:
            nonlocal ticks
            while True:
                ticks += 1
                await asyncio.sleep(0.001)

        task = asyncio.create_task(run_agent(rig.run))
        spinner = asyncio.create_task(ticker())
        try:
            assert await wait_thread(boto.entered)
            seen = ticks
            while ticks < seen + 20:  # the loop keeps turning while the thread is stuck
                await asyncio.sleep(0.001)
            assert not task.done() and not boto.finished.is_set()
        finally:
            boto.gate.set()
            spinner.cancel()
        return await task, ticks

    result, ticks = asyncio.run(asyncio.wait_for(scenario(), 20))
    assert published(result).calls == 1
    assert ticks >= 20


def test_cancelling_while_the_verifier_thread_blocks_returns_at_once_and_drops_its_answer(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Requirement 14.13: the slot is back within a second, the thread is not waited for, and
    when it finally answers `ok` nothing is written to S3 or the registry."""
    caplog.set_level(logging.INFO)
    rig = make_rig(gemini=[fenced(source(1))])
    boto = ScriptedLambda([lambda_response(verified())], blocked=True)
    real_verifier(rig, boto)

    async def scenario() -> float:
        try:
            elapsed = await cancel_run(rig, lambda: wait_thread(boto.entered))
            assert not boto.finished.is_set()  # the run did not wait for the thread
        finally:
            boto.gate.set()
        assert await wait_thread(boto.finished)
        for _ in range(5):  # let anything the late answer might schedule run
            await asyncio.sleep(0)
        return elapsed

    assert asyncio.run(asyncio.wait_for(scenario(), 20)) < 1.0
    assert rig.run.cancelled.is_set()
    assert rig.event_names() == VERIFYING
    assert rig.s3.calls == [] and rig.registry.calls == []
    assert len(rig.gemini.requests) == 1
    line = end_line(caplog)
    assert (line["code"], line["attempts"]) == (END_CANCELLED, 1)


def test_a_deadline_that_passes_while_the_verifier_thread_blocks_is_a_timeout(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Requirement 14.9: ANIMATION_TIMEOUT (not unavailable), the thread is left alone, and the
    slot is free as soon as the run returns."""
    caplog.set_level(logging.INFO)
    rig = make_rig(gemini=[fenced(source(1)), fenced(source(2))], deadline_ms=250)
    boto = ScriptedLambda([lambda_response(verified())], blocked=True)
    real_verifier(rig, boto)
    limiter = AiLimiter(AiLimits(max_concurrent_per_ip=1, max_concurrent_global=2))

    async def scenario() -> tuple[AgentResult, float]:
        try:
            started = time.monotonic()
            result = await serve_with_slot(rig, limiter)
            elapsed = time.monotonic() - started
            assert limiter.in_flight() == 0
            assert boto.entered.is_set() and not boto.finished.is_set()
        finally:
            boto.gate.set()
        assert await wait_thread(boto.finished)
        for _ in range(5):
            await asyncio.sleep(0)
        return result, elapsed

    result, elapsed = asyncio.run(asyncio.wait_for(scenario(), 20))
    lost = failed(result, TIMEOUT)
    assert elapsed < 2.0 and lost.calls == 1
    assert len(rig.gemini.requests) == 1  # no repair after the timeout
    assert rig.s3.calls == [] and rig.registry.calls == []
    assert end_line(caplog)["code"] == TIMEOUT


class SpyStore:
    """Wraps the real store: records the result of `publish` and when its thread returned."""

    def __init__(self, inner: S3AnimationStore) -> None:
        self.inner = inner
        self.result: Any = None
        self.finished = threading.Event()

    def publish(self, *args: Any, **kwargs: Any) -> Any:
        try:
            self.result = self.inner.publish(*args, **kwargs)
            return self.result
        finally:
            self.finished.set()


def block_s3_write(rig: Rig, name: str) -> tuple[threading.Event, threading.Event]:
    """Make the put of `name` wait in its thread; returns `(entered, gate)`."""
    entered, gate = threading.Event(), threading.Event()

    def block() -> None:
        entered.set()
        assert gate.wait(30), "the test never opened the gate"

    rig.s3.before("put_object", name, block)
    return entered, gate


def test_cancelling_while_s3_blocks_stops_the_store_at_its_next_call(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The write in flight finishes, `run.cancelled` is set before the run returns, and the
    store then refuses its next call: no `main.js`, no `manifest.json`, no registry row."""
    caplog.set_level(logging.INFO)
    rig = make_rig(gemini=[fenced(source(1))], verifier=[verified()])
    spy = SpyStore(rig.run.store)  # type: ignore[arg-type]
    rig.run.store = spy
    entered, gate = block_s3_write(rig, "main.ts")

    async def scenario() -> float:
        try:
            elapsed = await cancel_run(rig, lambda: wait_thread(entered))
            assert not spy.finished.is_set()
        finally:
            gate.set()
        assert await wait_thread(spy.finished)
        return elapsed

    assert asyncio.run(asyncio.wait_for(scenario(), 20)) < 1.0
    assert spy.result == TimedOut(cancelled=True)
    assert rig.s3.ops() == [S3_GET, S3_TS]
    assert set(rig.s3.objects) and not any(k.endswith("manifest.json") for k in rig.s3.objects)
    assert rig.registry.calls == []
    assert rig.event_names() == PUBLISHING
    assert end_line(caplog)["code"] == END_CANCELLED


def test_a_deadline_while_s3_blocks_is_a_timeout_and_the_store_never_writes_the_manifest() -> None:
    rig = make_rig(gemini=[fenced(source(1))], verifier=[verified()], deadline_ms=250)
    spy = SpyStore(rig.run.store)  # type: ignore[arg-type]
    rig.run.store = spy
    entered, gate = block_s3_write(rig, "main.ts")
    limiter = AiLimiter(AiLimits(max_concurrent_per_ip=1, max_concurrent_global=2))

    async def scenario() -> AgentResult:
        try:
            result = await serve_with_slot(rig, limiter)
            assert limiter.in_flight() == 0
            assert entered.is_set() and not spy.finished.is_set()
            rig.clock.advance_ms(rig.run.deadline_ms + 1)  # the time the thread spent blocked
        finally:
            gate.set()
        assert await wait_thread(spy.finished)
        return result

    failed(asyncio.run(asyncio.wait_for(scenario(), 20)), TIMEOUT)
    assert spy.result == TimedOut(cancelled=False)
    assert rig.s3.ops() == [S3_GET, S3_TS]
    assert not any(k.endswith("manifest.json") for k in rig.s3.objects)
    assert rig.registry.calls == []


class BlockingRegistry:
    """A registry whose `register` waits in its thread, then behaves like the memory registry."""

    def __init__(self, inner: Any) -> None:
        self.inner = inner
        self.entered = threading.Event()
        self.gate = threading.Event()
        self.finished = threading.Event()

    def register(self, row: NewRow) -> Registered | QuotaExceeded:
        self.entered.set()
        try:
            assert self.gate.wait(30), "the test never opened the gate"
            return self.inner.register(row)
        finally:
            self.finished.set()


def test_a_deadline_while_the_registry_blocks_is_a_timeout_and_the_slot_is_free() -> None:
    rig = make_rig(gemini=[fenced(source(1))], verifier=[verified()], deadline_ms=250)
    blocking = BlockingRegistry(rig.registry)
    rig.run.registry = blocking
    limiter = AiLimiter(AiLimits(max_concurrent_per_ip=1, max_concurrent_global=2))

    async def scenario() -> AgentResult:
        try:
            result = await serve_with_slot(rig, limiter)
            assert limiter.in_flight() == 0
            assert blocking.entered.is_set() and not blocking.finished.is_set()
        finally:
            blocking.gate.set()
        assert await wait_thread(blocking.finished)
        return result

    failed(asyncio.run(asyncio.wait_for(scenario(), 20)), TIMEOUT)
    assert len(rig.s3.calls_of("put_object")) == 3  # the files were written before the row
    # The write that was already running finishes: one row, which makes a retry a cache hit.
    assert len(rig.registry.rows) == 1


# --- 7. publish failures and unexpected exceptions --------------------------------------------


def after_two_repairs(**kwargs: Any) -> Rig:
    """A run whose third attempt is accepted, so it reaches `publish` with attempts used."""
    return make_rig(
        gemini=[fenced(source(n)) for n in (1, 2, 3, 4)],
        verifier=[rejected("TSC_2304"), rejected("TSC_2304"), verified(), verified()],
        **kwargs,
    )


def s3_down(
    name: str, op: str = "put_object", status: int = 500, code: str = "InternalError"
) -> Rig:
    rig = after_two_repairs()
    rig.s3.fail(op, name, status, code, times=5)
    return rig


PUBLISH_FAILURES: dict[str, tuple[Callable[[], Rig], str]] = {
    "source-write": (lambda: s3_down("main.ts"), STORAGE_FAILED),
    "bundle-write": (lambda: s3_down("main.js"), STORAGE_FAILED),
    "manifest-write": (lambda: s3_down("manifest.json"), STORAGE_FAILED),
    "manifest-read-denied": (
        lambda: s3_down("manifest.json", "get_object", 403, "AccessDenied"),
        STORAGE_FAILED,
    ),
    "registry-down": (
        lambda: after_two_repairs(registry_error=RegistryError("down")),
        STORAGE_FAILED,
    ),
    "quota-full": (lambda: after_two_repairs(registry_limit=0), "ANIMATION_QUOTA_EXCEEDED"),
}


@pytest.mark.parametrize(("make", "code"), PUBLISH_FAILURES.values(), ids=list(PUBLISH_FAILURES))
def test_a_publish_failure_ends_the_run_and_makes_no_more_gemini_or_verifier_calls(
    make: Callable[[], Rig], code: str, caplog: pytest.LogCaptureFixture
) -> None:
    """Requirement 13.14: after attempts were spent, a failed `publish` is final."""
    caplog.set_level(logging.INFO)
    rig = make()
    lost = failed(run(rig), code)
    assert lost.calls == 3
    assert len(rig.gemini.requests) == 3 and len(rig.verifier.payloads) == 3
    assert rig.gemini.extra_calls == 0
    assert rig.event_names()[-3:] == [
        "stage:verifying:3",
        "diagnostics:3:True:0",
        "stage:publishing:3",
    ]
    assert rig.registry.rows == []
    line = end_line(caplog)
    assert (line["code"], line["attempts"]) == (code, 3)


class RaisingStore:
    """A store whose `publish` raises: the real one never does, so this is a defect elsewhere."""

    def publish(self, *args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("the store broke")


class RaisingRegistry:
    def register(self, row: NewRow) -> Any:
        raise ValueError("the registry broke")


@pytest.mark.parametrize(
    ("store", "registry", "s3_puts"),
    [(RaisingStore(), None, 0), (None, RaisingRegistry(), 3)],
    ids=["store-raises", "registry-raises-a-plain-exception"],
)
def test_an_exception_from_a_publish_thread_ends_the_run_as_unknown(
    store: Any, registry: Any, s3_puts: int
) -> None:
    rig = make_rig(gemini=[fenced(source(1))], verifier=[verified()])
    if store is not None:
        rig.run.store = store
    if registry is not None:
        rig.run.registry = registry
    failed(run(rig), "UNKNOWN")
    assert len(rig.s3.calls_of("put_object")) == s3_puts
    assert rig.registry.rows == []


UNEXPECTED = [
    ("build_generate_prompt", 1),
    ("extract_main_ts", 1),
    ("build_payload", 1),
    ("build_repair_prompt", 2),
]


@pytest.mark.parametrize(("name", "position"), UNEXPECTED, ids=[n for n, _ in UNEXPECTED])
def test_an_unexpected_exception_in_a_node_ends_the_run_as_unknown_without_its_message(
    name: str,
    position: int,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    def explode(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("EXCEPTION-MESSAGE-SENTINEL")

    monkeypatch.setattr(agent, name, explode)
    caplog.set_level(logging.DEBUG)
    rig = make_rig(
        gemini=[fenced(source(1)), fenced(source(2))],
        verifier=[rejected("TSC_2304"), verified()],
    )
    lost = failed(run(rig), "UNKNOWN")
    assert lost.calls <= position
    assert "EXCEPTION-MESSAGE-SENTINEL" not in all_log_text(caplog)
    assert "RuntimeError" in all_log_text(caplog)  # the class and the place are logged
    assert end_line(caplog)["code"] == "UNKNOWN"
    assert rig.s3.calls == [] and rig.registry.calls == []


def test_an_emit_that_raises_does_not_stop_the_run() -> None:
    rig = make_rig(gemini=[fenced(source(1))], verifier=[verified()])

    def broken(_event: Any) -> None:
        raise RuntimeError("the queue is gone")

    rig.run.emit = broken
    assert published(run(rig)).calls == 1


# --- 8. sentinels in every input (Requirement 32.4) --------------------------------------------
#
# Each sentinel is a distinct string put where a real secret or piece of user data would be. After
# a run that succeeds, fails or is cancelled, none of them may be in the captured log (every
# logger, every level, with arguments and exception text), in the result the agent returns or in
# any event it emitted. The places that hold a sentinel by design are not scanned: Gemini's
# prompt and the verifier payload (they are the inputs), and the three S3 objects (the source, the
# bundle and the manifest, whose warnings keep their message).

SRC = "SRC-SENTINEL-4f1a"
TITLE = "TITLE-SENTINEL-9b2c"
TEXT = "TEXT-SENTINEL-7d3e"
CONCEPT = "CONCEPT-SENTINEL-5a6b"
TOKEN = "TOKEN-SENTINEL-2c8d"
FORBIDDEN = "FORBIDDEN-SENTINEL-6e1f"
KEY = "KEY-SENTINEL-3a9c"
URL = "URL-SENTINEL-8b4d"
MSG = "MSG-SENTINEL-1d7e"
SENTINELS = (SRC, TITLE, TEXT, CONCEPT, TOKEN, FORBIDDEN, KEY, URL, MSG)

PRESIGNED = (
    "https://lore-bucket.s3.ap-southeast-3.amazonaws.com/animations/v1/ab/" + "ab" * 32 + "/main.js"
    f"?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=300&X-Amz-Signature={URL}"
)


def sentinel_source(number: int) -> str:
    return f"// {SRC} {number}\nexport default function Main() {{ return null; }}\n"


def sentinel_bundle() -> str:
    return f"/* {SRC} */ export default function Main() {{ return null; }}"


def sentinel_rig(**kwargs: Any) -> Rig:
    """A puzzle run whose title, text, concept, token, forbidden token and key are sentinels."""
    request = puzzle_request(
        title=f"Title {TITLE}",
        text=f"Material {TEXT}",
        concepts=[f"concept {CONCEPT}"],
        visual={
            "kind": "table",
            "headers": ["Option", "Result"],
            "rows": [[f"A {TOKEN}", "3"], ["B", "?"]],
            "caption": "Which option fits?",
        },
        forbidden_tokens=[f"seven {FORBIDDEN}"],
    )
    rig = make_rig(request=request, **kwargs)
    rig.run.ai = replace(rig.run.ai, config=replace(rig.run.ai.config, api_key=KEY))
    return rig


def sentinel_verified(**kwargs: Any) -> LambdaOutcome:
    return verified(sentinel_bundle(), kind="puzzle", **kwargs)


def sinks(
    rig: Rig,
    caplog: pytest.LogCaptureFixture,
    capsys: pytest.CaptureFixture[str],
    result: AgentResult | None,
) -> dict[str, str]:
    """Everything the run let out: the log, the events, the result and the console."""
    records: list[str] = []
    for record in caplog.records:
        records += [
            record.getMessage(),
            repr(record.args),
            record.exc_text or "",
            record.stack_info or "",
            repr(record.__dict__.get("exc_info")),
        ]
    captured = capsys.readouterr()
    found = {
        "log": "\n".join(records),
        "events": "\n".join(event.model_dump_json() for event in rig.events),
        "console": captured.out + captured.err,
    }
    if result is not None:
        found["result"] = repr(result)
        if isinstance(result, AgentPublished):
            found["result"] += json.dumps(result.reference.dump()) + repr(result.row)
    return found


def assert_clean(found: dict[str, str]) -> None:
    for name, text in found.items():
        for sentinel in SENTINELS:
            assert sentinel not in text, f"{sentinel} leaked into the {name}"


def assert_live(rig: Rig, *, verified_once: bool = True, repaired: bool = False) -> None:
    """The sentinels really were inside the run: the pass is not an empty one."""
    system, prompt = rig.gemini.prompts()[0]
    assert all(s in prompt for s in (TITLE, TEXT, CONCEPT, TOKEN, FORBIDDEN))
    assert rig.gemini.requests[0].headers["x-goog-api-key"] == KEY
    if verified_once:
        payload = rig.verifier.payloads[0]
        assert SRC in payload["source"]
        assert any(TOKEN in token for token in payload["required_tokens"])
        assert any(FORBIDDEN in token for token in payload["forbidden_tokens"])
    if repaired:
        _, repair_prompt = rig.gemini.prompts()[1]
        assert SRC in repair_prompt and MSG in repair_prompt


def scan(
    rig: Rig, caplog: pytest.LogCaptureFixture, capsys: pytest.CaptureFixture[str], result: Any
) -> None:
    assert_clean(sinks(rig, caplog, capsys, result))


def provider_echo(_request: httpx2.Request) -> httpx2.Response:
    """A provider error that repeats the key and a presigned URL in its message."""
    message = f"denied for {KEY}: {PRESIGNED}"
    return httpx2.Response(500, json={"error": {"message": message}})


def sentinel_success() -> tuple[Rig, str]:
    rig = sentinel_rig(
        gemini=[fenced(sentinel_source(1)), fenced(sentinel_source(2))],
        verifier=[
            rejected("TSC_2304", warnings=["ESLINT_LORE_X"], message=MSG),
            sentinel_verified(warnings=["ESLINT_LORE_X"], message=MSG),
        ],
    )
    return rig, "published"


def sentinel_verification_failed() -> tuple[Rig, str]:
    rig = sentinel_rig(
        gemini=[fenced(sentinel_source(1)), fenced(sentinel_source(2))],
        verifier=[rejected("TSC_2304", message=MSG), rejected("POLICY_URL_LITERAL", message=MSG)],
        max_attempts=2,
    )
    return rig, VERIFICATION_FAILED


def sentinel_infrastructure_message() -> tuple[Rig, str]:
    rig = sentinel_rig(
        gemini=[fenced(sentinel_source(1))],
        verifier=[rejected("VERIFIER_INTERNAL", message=MSG)],
    )
    return rig, UNAVAILABLE


def sentinel_verifier_exception() -> tuple[Rig, str]:
    rig = sentinel_rig(
        gemini=[fenced(sentinel_source(1))],
        verifier=[RuntimeError(f"{PRESIGNED} {MSG} {SRC}")],
    )
    return rig, UNAVAILABLE


def sentinel_provider_echo() -> tuple[Rig, str]:
    rig = sentinel_rig(
        gemini=[fenced(sentinel_source(1)), provider_echo],
        verifier=[rejected("TSC_2304", message=MSG)],
    )
    return rig, "PROVIDER_UNAVAILABLE"


def sentinel_storage_exception() -> tuple[Rig, str]:
    rig = sentinel_rig(gemini=[fenced(sentinel_source(1))], verifier=[sentinel_verified()])
    rig.s3.fail("put_object", "main.js", exc=RuntimeError(f"{PRESIGNED} {MSG}"), times=5)
    return rig, STORAGE_FAILED


def sentinel_registry_exception() -> tuple[Rig, str]:
    rig = sentinel_rig(
        gemini=[fenced(sentinel_source(1))],
        verifier=[sentinel_verified()],
        registry_error=RegistryError(f"{PRESIGNED} {MSG}"),
    )
    return rig, STORAGE_FAILED


def sentinel_late_answer() -> tuple[Rig, str]:
    rig = sentinel_rig(gemini=[fenced(sentinel_source(1))])
    rig.verifier.script.append(verifier_after(passes(rig), rejected("TSC_2304", message=MSG)))
    return rig, TIMEOUT


def sentinel_cancel_flag() -> tuple[Rig, str]:
    rig = sentinel_rig(
        gemini=[fenced(sentinel_source(1))],
        verifier=[rejected("TSC_2304", message=MSG), sentinel_verified()],
    )
    rig.gemini.replies.append(reply_after(flagged(rig), fenced(sentinel_source(2))))
    return rig, "UNKNOWN"


SENTINEL_RUNS: dict[str, Callable[[], tuple[Rig, str]]] = {
    "success-after-a-repair": sentinel_success,
    "verification-failed": sentinel_verification_failed,
    "verifier-says-internal": sentinel_infrastructure_message,
    "verifier-raises": sentinel_verifier_exception,
    "provider-echoes-key-and-url": sentinel_provider_echo,
    "s3-raises-with-a-url": sentinel_storage_exception,
    "registry-raises-with-a-url": sentinel_registry_exception,
    "deadline-passes-in-the-verifier": sentinel_late_answer,
    "cancel-flag-in-the-repair-call": sentinel_cancel_flag,
}


@pytest.mark.parametrize("make", SENTINEL_RUNS.values(), ids=list(SENTINEL_RUNS))
def test_no_sentinel_reaches_the_log_the_result_or_an_event(
    make: Callable[[], tuple[Rig, str]],
    caplog: pytest.LogCaptureFixture,
    capsys: pytest.CaptureFixture[str],
) -> None:
    caplog.set_level(logging.DEBUG)
    rig, outcome = make()
    result = run(rig)
    if outcome == "published":
        published(result)
    else:
        failed(result, outcome)
    assert_live(rig, repaired=len(rig.gemini.requests) > 1 and len(rig.verifier.payloads) > 0)
    scan(rig, caplog, capsys, result)
    assert end_line(caplog)["code"] in ("OK", outcome, END_CANCELLED)


def test_a_published_run_keeps_its_sentinels_only_in_s3() -> None:
    """The control for the test above: the source, the bundle and the warning text are in S3
    (that is what is stored), so the scan really has something to find."""
    rig, _ = sentinel_success()
    won = published(run(rig))
    stored = rig.s3.objects
    assert SRC.encode() in stored[won.row.s3_prefix + "main.ts"]
    assert SRC.encode() in stored[won.row.s3_prefix + "main.js"]
    assert MSG.encode() in stored[won.row.s3_prefix + "manifest.json"]


def test_a_cancelled_task_leaks_no_sentinel(
    caplog: pytest.LogCaptureFixture, capsys: pytest.CaptureFixture[str]
) -> None:
    caplog.set_level(logging.DEBUG)

    async def scenario() -> Rig:
        entered = asyncio.Event()
        rig = sentinel_rig(
            gemini=[fenced(sentinel_source(1)), blocked_reply(entered)],
            verifier=[rejected("TSC_2304", message=MSG), sentinel_verified()],
        )
        await cancel_run(rig, entered.wait)
        return rig

    rig = asyncio.run(scenario())
    assert_live(rig, repaired=True)
    scan(rig, caplog, capsys, None)
    assert end_line(caplog)["code"] == END_CANCELLED


def test_a_cancelled_task_with_a_blocked_verifier_thread_leaks_no_sentinel(
    caplog: pytest.LogCaptureFixture, capsys: pytest.CaptureFixture[str]
) -> None:
    """The real verifier client logs from its own thread, and does so after the run is gone."""
    caplog.set_level(logging.DEBUG)
    rig = sentinel_rig(gemini=[fenced(sentinel_source(1))])
    boto = ScriptedLambda(
        [lambda_response(sentinel_verified(warnings=["ESLINT_LORE_X"], message=MSG))], blocked=True
    )
    real_verifier(rig, boto)

    async def scenario() -> None:
        try:
            await cancel_run(rig, lambda: wait_thread(boto.entered))
        finally:
            boto.gate.set()
        assert await wait_thread(boto.finished)

    asyncio.run(asyncio.wait_for(scenario(), 20))
    assert SRC in json.loads(boto.kwargs[0]["Payload"])["source"]
    assert any("animation.verifier" in r.getMessage() for r in caplog.records)  # the late line
    scan(rig, caplog, capsys, None)


@pytest.mark.parametrize(
    "script",
    [
        pytest.param([lambda_crash_response(f"{MSG} {SRC} {PRESIGNED}"), "ok"], id="crash-body"),
        pytest.param([PermissionError(f"{PRESIGNED} {MSG}")], id="access-denied-text"),
        pytest.param([lambda_raw(f'{{"note": "{MSG} {SRC}"}}'.encode())], id="wrong-shape-body"),
        pytest.param([lambda_raw(f"{MSG} {SRC} not json".encode())], id="not-json-body"),
    ],
)
def test_what_the_lambda_says_never_reaches_the_log_the_result_or_an_event(
    script: list[Any], caplog: pytest.LogCaptureFixture, capsys: pytest.CaptureFixture[str]
) -> None:
    caplog.set_level(logging.DEBUG)
    rig = sentinel_rig(gemini=[fenced(sentinel_source(1)), fenced(sentinel_source(2))])
    steps = [lambda_response(sentinel_verified()) if step == "ok" else step for step in script]
    boto = ScriptedLambda(steps)
    real_verifier(rig, boto)
    result = run(rig)
    assert boto.calls >= 1
    scan(rig, caplog, capsys, result)
