"""Property tests: the agent always stops, in one state, in its attempts and time (Property 6).

Why: the agent spends money (Gemini, Lambda) in a loop, so Requirement 13 asks for three things
that must hold for every order of results, not only for the cases someone thought of:

1. Routing after `verify` is total: any `(ok, calls, max_attempts, remaining_ms, terminal)`,
   including the edges (negative or NaN time, `calls == max_attempts`, a `max_attempts` outside
   1 to 4), gives exactly one of `publish`, `repair`, `fail` and never raises (13.3, 13.13).
2. A whole run, with any scripted sequence of Gemini replies and verifier results (success,
   rejection, crash, outage, a slow step that moves the clock past the deadline), ends in exactly
   one state, makes at most `max_attempts` Gemini calls, and never starts a step once
   `remaining_ms <= 0` (13.3, 13.12, 13.13).
3. The end state is the one the rules give. For runs without clock moves a small reference model
   of design 6.6 (written here from the requirements, not from `agent.py`) predicts the code, the
   number of Gemini and verifier calls and the event order, and the real agent must agree.

`hypothesis` is not a dependency, so scenarios come from seeded `random.Random` instances: 40
seeds, five scenarios each, once without time moves ("untimed", checked against the model) and
once with them ("timed", checked against the invariants that hold whatever the timing is). The
doubles are the shared ones (`tests/animation_agent_support.py`: the real `AiContext` over
`httpx2.MockTransport`, the real `S3AnimationStore` over `FakeS3`, a scripted verifier, a memory
registry, a settable clock) with a probe added at the start of every outside call, which records
the time left at that moment. That is what "never starts a step after the deadline" is measured
with. No `langgraph`, `boto3`, network or database is used; the driver and the LangGraph shell
share the nodes and the edge table (`test_animation_agent_graph.py` compares the two).
"""

from __future__ import annotations

import asyncio
import logging
import math
import random
from collections.abc import Callable
from dataclasses import dataclass, field
from functools import cache
from typing import Any

import httpx2
import pytest

from app.ai.animation.agent import (
    ROUTES,
    AgentFailed,
    AgentPublished,
    AgentResult,
    decide_after_verify,
    run_agent,
)
from app.ai.animation.limits import MAX_ATTEMPTS_CAP
from app.ai.animation.logging_ import END_OK
from app.ai.animation.models import ERROR_CODES, DiagnosticsEvent, StageEvent
from app.ai.animation.registry import NewRow, QuotaExceeded, Registered, RegistryError
from app.ai.animation.verifier_client import LambdaOutcome
from tests.animation_agent_support import (
    MemoryRegistry,
    Rig,
    animation_log_lines,
    crashed,
    event_name,
    fenced,
    make_rig,
    rejected,
    source,
    unavailable,
    verified,
)
from tests.fake_s3 import FakeS3

SEEDS = 40
SCENARIOS_PER_SEED = 5
VERIFICATION_FAILED = "ANIMATION_VERIFICATION_FAILED"
TIMEOUT = "ANIMATION_TIMEOUT"
UNAVAILABLE = "ANIMATION_VERIFIER_UNAVAILABLE"
STORAGE_FAILED = "ANIMATION_STORAGE_FAILED"
QUOTA = "ANIMATION_QUOTA_EXCEEDED"


# --- 1. routing ---------------------------------------------------------------------------

REMAINING_VALUES = (
    -math.inf,
    -1e9,
    -240_001.0,
    -1.0,
    -1e-9,
    -0.0,
    0.0,
    1e-9,
    0.5,
    1.0,
    2000.0,
    239_999.0,
    240_000.0,
    1e12,
    math.inf,
    math.nan,
)
TERMINAL_VALUES: tuple[str | None, ...] = (
    None,
    None,
    None,
    None,
    "UNKNOWN",
    "RATE_LIMITED",
    "PROVIDER_UNAVAILABLE",
    UNAVAILABLE,
    TIMEOUT,
    STORAGE_FAILED,
    QUOTA,
    "",
    "not a code at all",
)
CALLS_VALUES = (-3, -1, 0, 1, 2, 3, 4, 5, 6, 50)
MAX_ATTEMPT_VALUES = (-5, -1, 0, 1, 2, 3, 4, 5, 9, 100)


def reference_route(
    ok: bool, calls: int, max_attempts: int, remaining_ms: float, terminal: str | None
) -> tuple[str, str | None]:
    """Requirement 13.13 in its own words: time, a code from a node, ok, then attempts."""
    if not remaining_ms > 0:  # false for NaN too: no usable time is no time
        return "fail", TIMEOUT
    if terminal is not None:
        return "fail", terminal
    if ok:
        return "publish", None
    if calls < max_attempts:
        return "repair", None
    return "fail", VERIFICATION_FAILED


@pytest.mark.parametrize("seed", range(SEEDS))
def test_routing_gives_exactly_one_route_and_matches_the_requirement(seed: int) -> None:
    rng = random.Random(f"routing-{seed}")
    for _ in range(500):
        args = (
            rng.random() < 0.5,
            rng.choice(CALLS_VALUES) if rng.random() < 0.7 else rng.randint(-100, 100),
            rng.choice(MAX_ATTEMPT_VALUES),
            rng.choice(REMAINING_VALUES) if rng.random() < 0.7 else rng.uniform(-1e6, 1e6),
            rng.choice(TERMINAL_VALUES),
        )
        ok, calls, max_attempts, remaining, terminal = args
        route, code = decide_after_verify(
            ok=ok, calls=calls, max_attempts=max_attempts, remaining_ms=remaining, terminal=terminal
        )
        assert route in {"publish", "repair", "fail"}
        assert route in ROUTES
        assert (code is None) == (route != "fail")
        assert (route, code) == reference_route(*args), args


def test_routing_inputs_reach_every_route_and_every_edge() -> None:
    reached: set[tuple[str, str | None]] = set()
    edges = {"nan": 0, "negative": 0, "zero": 0, "calls==max": 0, "calls>max": 0, "max<1": 0}
    for seed in range(SEEDS):
        rng = random.Random(f"routing-{seed}")
        for _ in range(500):
            ok = rng.random() < 0.5
            calls = rng.choice(CALLS_VALUES) if rng.random() < 0.7 else rng.randint(-100, 100)
            max_attempts = rng.choice(MAX_ATTEMPT_VALUES)
            remaining = (
                rng.choice(REMAINING_VALUES) if rng.random() < 0.7 else rng.uniform(-1e6, 1e6)
            )
            terminal = rng.choice(TERMINAL_VALUES)
            reached.add(reference_route(ok, calls, max_attempts, remaining, terminal))
            edges["nan"] += math.isnan(remaining)
            edges["negative"] += remaining < 0
            edges["zero"] += remaining == 0
            edges["calls==max"] += calls == max_attempts
            edges["calls>max"] += calls > max_attempts
            edges["max<1"] += max_attempts < 1
    assert {route for route, _ in reached} == {"publish", "repair", "fail"}
    assert {code for route, code in reached if route == "fail"} >= {TIMEOUT, VERIFICATION_FAILED}
    assert all(count >= 100 for count in edges.values()), edges


@pytest.mark.parametrize("seed", range(SEEDS))
def test_no_time_always_means_a_timeout_and_a_retry_loop_always_ends(seed: int) -> None:
    rng = random.Random(f"loop-{seed}")
    for _ in range(100):
        max_attempts = rng.randint(1, MAX_ATTEMPTS_CAP)
        # A run that keeps failing verification: each repair adds one call. It must stop after
        # at most `max_attempts` calls, with the failed-verification code.
        calls, steps = 1, 0
        while True:
            route, code = decide_after_verify(
                ok=False,
                calls=calls,
                max_attempts=max_attempts,
                remaining_ms=rng.uniform(1.0, 240_000.0),
                terminal=None,
            )
            steps += 1
            if route != "repair":
                break
            calls += 1
            assert steps <= max_attempts
        assert (route, code) == ("fail", VERIFICATION_FAILED)
        assert calls == max_attempts

        # Time running out at any point of the same loop ends it at once, whatever else is true.
        late = rng.choice([0.0, -1.0, -1e-9, math.nan, -math.inf])
        for ok in (True, False):
            for terminal in (None, "UNKNOWN", UNAVAILABLE):
                assert decide_after_verify(
                    ok=ok,
                    calls=rng.randint(0, 8),
                    max_attempts=max_attempts,
                    remaining_ms=late,
                    terminal=terminal,
                ) == ("fail", TIMEOUT)


# --- 2 and 3. whole runs ------------------------------------------------------------------

GEMINI_SPECS = ("src_new", "src_same", "prose", "status_429", "status_500")
VERIFIER_SPECS = ("ok", "bad", "bad2", "crash", "unavailable", "infra", "raise", "timeout")
PUBLISH_SPECS = ("ok", "ok", "ok", "s3fail", "regfail", "quota")
# Moves of the fake clock, in milliseconds. Only whole seconds (exact in floating point) so that
# "to the deadline" lands on exactly 0, and "just before" leaves three seconds: `publish` waits
# for its threads in real time with the fake time left (`asyncio.wait_for`), so a run that is left
# a few milliseconds would end as a timeout or not depending on the speed of the machine.
ADVANCES: tuple[Any, ...] = (0,) * 30 + (1_000, 30_000, 100_000, "deadline", "just_before")
JUST_BEFORE_LEAVES_MS = 3_000.0
S3_HOOKS = (
    ("get_object", "manifest.json"),
    ("put_object", "main.ts"),
    ("put_object", "main.js"),
    ("put_object", "manifest.json"),
)
DEADLINES_TIMED = (0.0, 2_000.0, 3_000.0, 60_000.0, 240_000.0, 240_000.0, 240_000.0, 240_000.0)
MAX_ATTEMPTS_PASSED = (1, 2, 3, 4, 4, 3, 2, 0, -1, 5, 9)

# What the real Gemini client makes of a scripted HTTP status with one attempt per model.
GEMINI_FAILURE_CODE = {429: "RATE_LIMITED", 500: "PROVIDER_UNAVAILABLE"}


@dataclass(frozen=True)
class Scenario:
    """One run: what each outside system answers, in order, and when time moves."""

    seed: int
    index: int
    timed: bool
    kind: str
    max_attempts: int  # as passed to the run, possibly outside 1 to 4
    deadline_ms: float
    gemini: tuple[tuple[str, int], ...]  # (spec, source number or HTTP status)
    verifier: tuple[str, ...]
    publish: str
    gemini_advance: tuple[Any, ...] = ()
    verifier_advance: tuple[Any, ...] = ()
    s3_hooks: tuple[tuple[str, str, Any], ...] = ()
    registry_advance: Any = 0

    @property
    def effective_max(self) -> int:
        return max(1, min(self.max_attempts, MAX_ATTEMPTS_CAP))


def make_scenario(seed: int, index: int, *, timed: bool) -> Scenario:
    rng = random.Random(f"agent-{seed}-{index}-{timed}")
    kind = rng.choice(["lesson", "puzzle"])
    max_attempts = rng.choice(MAX_ATTEMPTS_PASSED)
    effective = max(1, min(max_attempts, MAX_ATTEMPTS_CAP))
    gemini: list[tuple[str, int]] = []
    last_number = 0
    next_number = 0
    for _ in range(effective):
        spec = rng.choices(GEMINI_SPECS, weights=[45, 15, 12, 4, 4])[0]
        if spec == "src_new" or (spec == "src_same" and last_number == 0):
            next_number += 1
            last_number = next_number
            gemini.append(("src", last_number))
        elif spec == "src_same":
            gemini.append(("src", last_number))
        elif spec == "prose":
            gemini.append(("prose", 0))
        else:
            gemini.append(("status", int(spec.split("_")[1])))
    verifier = tuple(
        rng.choices(VERIFIER_SPECS, weights=[28, 30, 8, 8, 5, 4, 4, 4])[0] for _ in range(effective)
    )
    publish = rng.choice(PUBLISH_SPECS)
    if not timed:
        return Scenario(
            seed, index, False, kind, max_attempts, 240_000.0, tuple(gemini), verifier, publish
        )
    deadline = rng.choice(DEADLINES_TIMED)
    if rng.random() < 0.4 and deadline > 0:
        # A run that reaches `publish` and loses the deadline in the middle of it.
        hooks = tuple(
            (op, name, rng.choice(("deadline", "deadline", 100_000, 1_000)))
            for op, name in rng.sample(S3_HOOKS, rng.randint(1, 2))
        )
        return Scenario(
            seed,
            index,
            True,
            kind,
            max_attempts,
            deadline,
            (("src", 1), *gemini[1:]),
            ("ok", *verifier[1:]),
            "ok",
            gemini_advance=(0,) * effective,
            verifier_advance=(0,) * effective,
            s3_hooks=hooks,
            registry_advance=rng.choice(ADVANCES),
        )
    return Scenario(
        seed,
        index,
        True,
        kind,
        max_attempts,
        deadline,
        tuple(gemini),
        verifier,
        publish,
        gemini_advance=tuple(rng.choice(ADVANCES) for _ in range(effective)),
        verifier_advance=tuple(rng.choice(ADVANCES) for _ in range(effective)),
        s3_hooks=tuple(
            (op, name, rng.choice(ADVANCES)) for op, name in S3_HOOKS if rng.random() < 0.25
        ),
        registry_advance=rng.choice(ADVANCES),
    )


# --- the probe: the time left at the start of every outside call ---------------------------


@dataclass
class ProbeS3(FakeS3):
    """`FakeS3` that notes the time left when each call starts, before any scripted hook."""

    starts: list[tuple[str, float]] = field(default_factory=list)
    watch: Callable[[], float] = field(default=lambda: math.inf)

    def _enter(self, op: str, params: dict[str, Any]) -> str:
        name = str(params.get("Key", "")).rsplit("/", 1)[-1]
        self.starts.append((f"{op} {name}", self.watch()))
        return super()._enter(op, params)


@dataclass
class ProbeRegistry(MemoryRegistry):
    """`MemoryRegistry` that notes the time left when `register` starts, then may move the clock."""

    starts: list[float] = field(default_factory=list)
    watch: Callable[[], float] = field(default=lambda: math.inf)
    before: Callable[[], None] = field(default=lambda: None)

    def register(self, row: NewRow) -> Registered | QuotaExceeded:
        self.starts.append(self.watch())
        self.before()
        return super().register(row)


@dataclass
class Probe:
    """Time left when each Gemini or verifier call started and when its step finished."""

    gemini_starts: list[float] = field(default_factory=list)
    gemini_ends: list[float] = field(default_factory=list)
    verifier_starts: list[tuple[float, float]] = field(default_factory=list)
    verifier_ends: list[tuple[int, float]] = field(default_factory=list)  # (attempt, time left)


@dataclass
class Outcome:
    scenario: Scenario
    result: AgentResult
    rig: Rig
    probe: Probe
    s3: ProbeS3
    registry: ProbeRegistry
    events: list[str]
    log_lines: list[dict[str, Any]]
    effective_max: int


class _Collect(logging.Handler):
    def __init__(self) -> None:
        super().__init__(logging.DEBUG)
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


class _Lines:
    """Just enough of `caplog` for `animation_log_lines`."""

    def __init__(self, records: list[logging.LogRecord]) -> None:
        self.records = records


def _gemini_body(text: str) -> dict[str, Any]:
    return {
        "candidates": [{"content": {"parts": [{"text": text}]}, "finishReason": "STOP"}],
        "usageMetadata": {"promptTokenCount": 1, "candidatesTokenCount": 1, "totalTokenCount": 2},
    }


VERIFIER_OUTCOMES: dict[str, Callable[[str], LambdaOutcome]] = {
    "ok": lambda kind: verified(kind=kind),
    "bad": lambda kind: rejected("TSC_2322"),
    "bad2": lambda kind: rejected("TSC_2322", "POLICY_URL_LITERAL"),
    "crash": lambda kind: crashed(),
    "unavailable": lambda kind: unavailable(),
    "infra": lambda kind: rejected("VERIFIER_INTERNAL"),
    "timeout": lambda kind: LambdaOutcome("timeout"),
}


def execute(scenario: Scenario) -> Outcome:
    """Build the rig for `scenario`, run the agent to its end and collect what was seen."""
    holder: dict[str, Rig] = {}
    probe = Probe()

    def remaining() -> float:
        return holder["rig"].run.remaining_ms()

    def advance(action: Any) -> None:
        clock = holder["rig"].clock
        if action == "deadline":
            clock.advance_ms(max(remaining(), 0.0))
        elif action == "just_before":
            clock.advance_ms(max(remaining() - JUST_BEFORE_LEAVES_MS, 0.0))
        elif isinstance(action, int | float) and action:
            clock.advance_ms(action)

    def gemini_step(
        spec: tuple[str, int], action: Any
    ) -> Callable[[httpx2.Request], httpx2.Response]:
        def reply(_request: httpx2.Request) -> httpx2.Response:
            probe.gemini_starts.append(remaining())
            advance(action)
            probe.gemini_ends.append(remaining())
            kind, value = spec
            if kind == "src":
                return httpx2.Response(200, json=_gemini_body(fenced(source(value))))
            if kind == "prose":
                return httpx2.Response(200, json=_gemini_body("I am not able to write that."))
            return httpx2.Response(value, json={"error": {"message": "scripted"}})

        return reply

    def verifier_step(spec: str, action: Any) -> Callable[[dict[str, Any], float], Any]:
        async def step(_payload: dict[str, Any], remaining_ms: float) -> LambdaOutcome:
            probe.verifier_starts.append((remaining_ms, remaining()))
            advance(action)
            probe.verifier_ends.append((holder["rig"].verifier.attempts[-1], remaining()))
            if spec == "raise":
                raise RuntimeError("scripted outage")
            return VERIFIER_OUTCOMES[spec](scenario.kind)

        return step

    gemini_actions = scenario.gemini_advance or (0,) * len(scenario.gemini)
    verifier_actions = scenario.verifier_advance or (0,) * len(scenario.verifier)
    s3 = ProbeS3()
    if scenario.publish == "s3fail":
        s3.fail("put_object", "main.js", 500, times=3)
    rig = make_rig(
        kind=scenario.kind,
        gemini=[
            gemini_step(spec, a) for spec, a in zip(scenario.gemini, gemini_actions, strict=True)
        ],
        verifier=[
            verifier_step(spec, a)
            for spec, a in zip(scenario.verifier, verifier_actions, strict=True)
        ],
        max_attempts=scenario.max_attempts,
        deadline_ms=scenario.deadline_ms,
        s3=s3,
    )
    holder["rig"] = rig
    s3.watch = remaining
    for op, name, action in scenario.s3_hooks:
        s3.before(op, name, lambda action=action: advance(action))
    registry = ProbeRegistry(
        limit=0 if scenario.publish == "quota" else 200,
        fail=RegistryError("scripted") if scenario.publish == "regfail" else None,
    )
    registry.watch = remaining
    registry.before = lambda: advance(scenario.registry_advance)
    rig.run.registry = registry

    logger = logging.getLogger("lore.animation")
    collector = _Collect()
    previous_level = logger.level
    logger.addHandler(collector)
    logger.setLevel(logging.INFO)
    try:
        result = asyncio.run(run_agent(rig.run))
    finally:
        logger.removeHandler(collector)
        logger.setLevel(previous_level)
    lines = animation_log_lines(_Lines(collector.records))  # type: ignore[arg-type]
    return Outcome(
        scenario=scenario,
        result=result,
        rig=rig,
        probe=probe,
        s3=s3,
        registry=registry,
        events=[event_name(event) for event in rig.events],
        log_lines=lines,
        effective_max=rig.run.max_attempts,
    )


@cache
def outcome_of(seed: int, index: int, timed: bool) -> Outcome:
    return execute(make_scenario(seed, index, timed=timed))


def result_code(result: AgentResult) -> str:
    return END_OK if isinstance(result, AgentPublished) else result.code


# --- the reference model of design 6.6 (runs without clock moves) --------------------------


@dataclass
class Expected:
    code: str  # END_OK or an error code
    calls: int
    verifier_calls: int
    events: list[str] = field(default_factory=list)


def simulate(scenario: Scenario) -> Expected:
    """What the agent must do for a scenario without time moves, from the requirements alone.

    Each attempt asks Gemini once; a failed Gemini call ends the run; a reply without code, or a
    repair that gives the same source again, skips the verifier and counts as a failed attempt;
    otherwise the verifier decides (ok: publish; findings, crash: failed attempt; outage or
    infrastructure Diagnostic: unavailable; timeout: timeout). A failed attempt with attempts left
    is repaired, otherwise the run fails with `ANIMATION_VERIFICATION_FAILED`.
    """
    limit = scenario.effective_max
    events: list[str] = []
    calls = verifier_calls = 0
    previous_sha: str | None = None
    while True:
        calls += 1
        stage = "generating" if calls == 1 else "repairing"
        events.append(f"stage:{stage}:{calls}")
        kind, value = scenario.gemini[calls - 1]
        if kind == "status":
            return Expected(GEMINI_FAILURE_CODE[value], calls, verifier_calls, events)
        failed_attempt = False
        if kind == "prose":
            previous_sha = ""
            events.append(f"diagnostics:{calls}:False:1")
            failed_attempt = True
        else:
            sha = source(value)
            unchanged = calls > 1 and sha == previous_sha
            previous_sha = sha
            if unchanged:
                events.append(f"diagnostics:{calls}:False:1")
                failed_attempt = True
            else:
                verdict = scenario.verifier[verifier_calls]
                verifier_calls += 1
                events.append(f"stage:verifying:{calls}")
                if verdict == "ok":
                    events.append(f"diagnostics:{calls}:True:0")
                    events.append(f"stage:publishing:{calls}")
                    code = {
                        "ok": END_OK,
                        "s3fail": STORAGE_FAILED,
                        "regfail": STORAGE_FAILED,
                        "quota": QUOTA,
                    }[scenario.publish]
                    return Expected(code, calls, verifier_calls, events)
                if verdict in {"unavailable", "infra", "raise"}:
                    return Expected(UNAVAILABLE, calls, verifier_calls, events)
                if verdict == "timeout":
                    return Expected(TIMEOUT, calls, verifier_calls, events)
                errors = 2 if verdict == "bad2" else 1  # "bad", "crash": one error each
                events.append(f"diagnostics:{calls}:False:{errors}")
                failed_attempt = True
        assert failed_attempt
        if calls >= limit:
            return Expected(VERIFICATION_FAILED, calls, verifier_calls, events)


UNTIMED = [(seed, index) for seed in range(SEEDS) for index in range(SCENARIOS_PER_SEED)]
TIMED = list(UNTIMED)


@pytest.mark.parametrize("seed", range(SEEDS))
def test_an_untimed_run_ends_exactly_as_the_reference_model_says(seed: int) -> None:
    for index in range(SCENARIOS_PER_SEED):
        out = outcome_of(seed, index, False)
        expected = simulate(out.scenario)
        label = f"seed={seed} index={index} {out.scenario}"
        assert result_code(out.result) == expected.code, label
        assert out.result.calls == expected.calls, label
        assert len(out.rig.gemini.requests) == expected.calls, label
        assert len(out.rig.verifier.payloads) == expected.verifier_calls, label
        assert out.events == expected.events, label
        assert out.rig.gemini.extra_calls == 0, label
        assert out.rig.verifier.extra_calls == 0, label


# --- invariants that hold for every run, timed or not -------------------------------------


def assert_invariants(out: Outcome) -> None:
    scenario, result, rig = out.scenario, out.result, out.rig
    label = f"seed={scenario.seed} index={scenario.index} timed={scenario.timed} {scenario}"

    # One end state, and for a failure one code of the closed set (Requirement 13.11).
    assert isinstance(result, AgentPublished | AgentFailed), label
    if isinstance(result, AgentFailed):
        assert result.code in ERROR_CODES, label
        if not scenario.timed:
            assert result.code != "UNKNOWN", label  # nothing in an untimed run is unexpected
    # Attempts: effective limit in 1 to 4, and no more Gemini calls than that (Requirement 13.4).
    assert 1 <= out.effective_max <= MAX_ATTEMPTS_CAP, label
    assert 0 <= result.calls <= out.effective_max, label
    assert len(rig.gemini.requests) <= result.calls, label
    assert len(rig.verifier.payloads) <= result.calls, label
    assert rig.gemini.extra_calls == 0 and rig.verifier.extra_calls == 0, label

    # No step starts with no time left (Requirement 13.5): Gemini, verifier, S3, registry.
    assert all(left > 0 for left in out.probe.gemini_starts), (label, out.probe.gemini_starts)
    for passed, actual in out.probe.verifier_starts:
        assert passed > 0 and actual > 0, (label, passed, actual)
        assert abs(passed - actual) < 1e-6, label
    assert all(left > 0 for _, left in out.s3.starts), (label, out.s3.starts)
    assert all(left > 0 for left in out.registry.starts), (label, out.registry.starts)

    # The stream: attempts in order, `verifying` and `diagnostics` inside their attempt,
    # `publishing` only after an ok and last (Requirement 17.12).
    stages = [event for event in rig.events if isinstance(event, StageEvent)]
    asks = [event for event in stages if event.stage in {"generating", "repairing"}]
    assert [event.attempt for event in asks] == list(range(1, len(asks) + 1)), label
    assert len(asks) == result.calls, label
    assert all(
        event.stage == ("generating" if event.attempt == 1 else "repairing") for event in asks
    ), label
    for event in stages:
        if event.stage == "verifying":
            assert 1 <= event.attempt <= result.calls, label
    publishing = [event for event in stages if event.stage == "publishing"]
    assert len(publishing) <= 1, label
    if publishing:
        # `publishing` is the last event, and it follows an ok `diagnostics` of the same attempt.
        assert rig.events[-1] is publishing[0], label
        previous = rig.events[-2]
        assert isinstance(previous, DiagnosticsEvent) and previous.ok, label
        assert previous.attempt == publishing[0].attempt == result.calls, label
    diag = [event for event in rig.events if isinstance(event, DiagnosticsEvent)]
    assert len({event.attempt for event in diag}) == len(diag), label
    assert len(diag) <= result.calls, label
    assert all(event.attempt <= result.calls for event in diag), label
    # The agent never sends a terminal event: the endpoint owns `done` and `error`.
    assert all(isinstance(event, StageEvent | DiagnosticsEvent) for event in rig.events), label

    # Registry and S3 agree with the end state (Requirement 18.5, 19.14).
    if isinstance(result, AgentPublished):
        assert len(out.registry.rows) == 1, label
        assert result.row in out.registry.rows, label
        assert result.reference.animation_id == result.row.id, label
        prefix = result.row.s3_prefix
        assert {prefix + name for name in ("main.ts", "main.js", "manifest.json")} <= out.s3.keys()
        assert out.s3.unexpected == [], label
    else:
        assert out.registry.rows == [], label
        # Never a delete or a listing, whatever happened (Requirement 19.9).
        assert out.s3.unexpected == [], label
        if scenario.publish == "s3fail":  # `main.js` was refused, so the manifest never went out
            assert not out.s3.calls_of("put_object", "manifest.json"), label

    # A Gemini reply or a verifier answer that arrives after the deadline is dropped: the run ends
    # as a timeout, no `diagnostics` event describes it, and nothing more is written
    # (Requirements 13.5, 14.9).
    late_gemini = {n for n, left in enumerate(out.probe.gemini_ends, start=1) if left <= 0}
    late_verifier = {attempt for attempt, left in out.probe.verifier_ends if left <= 0}
    late = late_gemini | late_verifier
    if late:
        assert result_code(result) == TIMEOUT, label
        assert out.registry.rows == [], label
        assert not {event.attempt for event in diag} & late, label
        assert not set(rig.verifier.attempts) & late_gemini, label
        assert all(
            line["event"] != "animation.attempt" or line["attempt"] not in late
            for line in out.log_lines
        ), label

    # The verifier always got the same five keys and the same tokens (Requirement 14.12).
    payloads = rig.verifier.payloads
    assert all(set(p) == set(payloads[0]) and len(p) == 5 for p in payloads), label
    assert all(
        p["required_tokens"] == payloads[0]["required_tokens"]
        and p["forbidden_tokens"] == payloads[0]["forbidden_tokens"]
        and p["contract_version"] == payloads[0]["contract_version"]
        for p in payloads
    ), label

    # The log: one start first, one end last, and the end names this result (Requirement 33.11).
    run_lines = [
        line
        for line in out.log_lines
        if line["event"] in {"animation.start", "animation.attempt", "animation.end"}
    ]
    assert run_lines[0]["event"] == "animation.start", label
    assert run_lines[-1]["event"] == "animation.end", label
    assert sum(1 for line in run_lines if line["event"] == "animation.start") == 1, label
    assert sum(1 for line in run_lines if line["event"] == "animation.end") == 1, label
    assert run_lines[-1]["code"] == result_code(result), label
    assert run_lines[-1]["attempts"] == result.calls, label
    attempts = [line for line in run_lines if line["event"] == "animation.attempt"]
    assert len(attempts) <= result.calls, label


@pytest.mark.parametrize("seed", range(SEEDS))
def test_every_untimed_run_keeps_the_invariants(seed: int) -> None:
    for index in range(SCENARIOS_PER_SEED):
        assert_invariants(outcome_of(seed, index, False))


@pytest.mark.parametrize("seed", range(SEEDS))
def test_every_timed_run_stops_in_one_state_and_never_starts_a_step_late(seed: int) -> None:
    for index in range(SCENARIOS_PER_SEED):
        out = outcome_of(seed, index, True)
        assert_invariants(out)
        # A run that was out of time before it began did no work at all.
        if out.scenario.deadline_ms <= 0:
            assert isinstance(out.result, AgentFailed)
            assert out.result.code == TIMEOUT
            assert out.result.calls == 0
            assert out.rig.events == []
            assert out.rig.gemini.requests == [] and out.s3.calls == []


@pytest.mark.parametrize("seed", range(0, SEEDS, 4))
def test_the_same_scenario_gives_the_same_end_state(seed: int) -> None:
    for index in range(SCENARIOS_PER_SEED):
        for timed in (False, True):
            first = outcome_of(seed, index, timed)
            second = execute(make_scenario(seed, index, timed=timed))
            assert result_code(first.result) == result_code(second.result)
            assert first.result.calls == second.result.calls
            assert first.events == second.events


# --- guards: the scenarios reach what the properties are about ------------------------------


def test_the_scenarios_reach_every_end_state_and_every_hard_case() -> None:
    codes: dict[str, int] = {}
    for seed, index in UNTIMED:
        code = result_code(outcome_of(seed, index, False).result)
        codes[code] = codes.get(code, 0) + 1
    assert set(codes) >= {
        END_OK,
        VERIFICATION_FAILED,
        TIMEOUT,
        UNAVAILABLE,
        STORAGE_FAILED,
        QUOTA,
        "RATE_LIMITED",
        "PROVIDER_UNAVAILABLE",
    }, codes
    assert codes[END_OK] >= 20, codes

    timed_codes: dict[str, int] = {}
    for seed, index in TIMED:
        code = result_code(outcome_of(seed, index, True).result)
        timed_codes[code] = timed_codes.get(code, 0) + 1
    assert timed_codes.get(TIMEOUT, 0) >= 30, timed_codes
    assert timed_codes.get(END_OK, 0) >= 10, timed_codes
    assert len(timed_codes) >= 5, timed_codes

    untimed = [outcome_of(seed, index, False) for seed, index in UNTIMED]
    # Runs reach every attempt count, and use all four attempts.
    assert {out.result.calls for out in untimed} >= {1, 2, 3, 4}
    # The effective limit covers 1 to 4 and values outside the range were passed.
    assert {out.effective_max for out in untimed} == {1, 2, 3, 4}
    passed = {out.scenario.max_attempts for out in untimed}
    assert any(value < 1 for value in passed) and any(value > 4 for value in passed)
    # Repairs happen, with and without the verifier: unchanged sources and replies without code.
    assert any(out.events and any("repairing" in event for event in out.events) for out in untimed)
    assert any(
        out.scenario.gemini[i][0] == "prose"
        for out in untimed
        for i in range(len(out.scenario.gemini))
    )
    sources = [[value for kind, value in out.scenario.gemini if kind == "src"] for out in untimed]
    assert any(len(values) != len(set(values)) for values in sources), "no repeated source"
    # Both kinds of request, and every verifier answer, occur.
    assert {out.scenario.kind for out in untimed} == {"lesson", "puzzle"}
    used = {
        spec for out in untimed for spec in out.scenario.verifier[: len(out.rig.verifier.payloads)]
    }
    assert used >= set(VERIFIER_SPECS)

    # Timing: deadlines and moves of every kind, and runs that crossed the deadline mid-step.
    timed = [outcome_of(seed, index, True) for seed, index in TIMED]
    assert {out.scenario.deadline_ms for out in timed} == set(DEADLINES_TIMED)
    moves = {
        a for out in timed for a in out.scenario.gemini_advance + out.scenario.verifier_advance
    }
    assert {"deadline", "just_before", 1_000, 100_000} <= moves
    assert any(out.scenario.s3_hooks for out in timed)
    assert any(out.registry.starts for out in timed), "no run reached the registry"
    assert any(out.s3.starts for out in timed), "no run reached S3"
    assert any(out.scenario.deadline_ms <= 0 for out in timed)
    # Steps that finished after the deadline (a dropped reply or answer), and S3 hooks that moved
    # the clock past it while `publish` was running.
    late_steps = [
        out
        for out in timed
        if any(left <= 0 for left in out.probe.gemini_ends)
        or any(left <= 0 for _, left in out.probe.verifier_ends)
    ]
    assert len(late_steps) >= 10
    assert any(any(left <= 0 for _, left in out.probe.verifier_ends) for out in timed)
    assert any(any(left <= 0 for left in out.probe.gemini_ends) for out in timed)
    in_publish = [out for out in timed if out.s3.calls_of("put_object") and out.scenario.s3_hooks]
    assert len(in_publish) >= 10


def scenario_of(**changes: Any) -> Scenario:
    base: dict[str, Any] = {
        "seed": 0,
        "index": 0,
        "timed": False,
        "kind": "lesson",
        "max_attempts": 3,
        "deadline_ms": 240_000.0,
        "gemini": (("src", 1), ("src", 2), ("src", 3)),
        "verifier": ("bad", "bad", "ok"),
        "publish": "ok",
    }
    return Scenario(**{**base, **changes})


def test_the_reference_model_gives_the_hand_worked_answers() -> None:
    """The model is its own small spec: three runs worked out by hand."""
    first_try = simulate(scenario_of(verifier=("ok",), gemini=(("src", 1),)))
    assert first_try == Expected(
        END_OK,
        1,
        1,
        ["stage:generating:1", "stage:verifying:1", "diagnostics:1:True:0", "stage:publishing:1"],
    )

    repaired_twice = simulate(scenario_of())
    assert repaired_twice.code == END_OK
    assert (repaired_twice.calls, repaired_twice.verifier_calls) == (3, 3)
    assert repaired_twice.events[:6] == [
        "stage:generating:1",
        "stage:verifying:1",
        "diagnostics:1:False:1",
        "stage:repairing:2",
        "stage:verifying:2",
        "diagnostics:2:False:1",
    ]

    one_shot = simulate(scenario_of(max_attempts=1, gemini=(("prose", 0),), verifier=()))
    assert one_shot == Expected(
        VERIFICATION_FAILED, 1, 0, ["stage:generating:1", "diagnostics:1:False:1"]
    )

    unchanged = simulate(
        scenario_of(gemini=(("src", 1), ("src", 1), ("src", 2)), verifier=("bad", "ok"))
    )
    assert unchanged.verifier_calls == 2  # the repeated source never reached the verifier
    assert unchanged.events[3:6] == [
        "stage:repairing:2",
        "diagnostics:2:False:1",
        "stage:repairing:3",
    ]
