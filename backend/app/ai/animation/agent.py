"""Animation_Agent: generate, verify, repair and publish one AI-written `main.ts` (design 6.6).

Why: one request asks Gemini for a Remotion file, a verifier Lambda checks it, and a failed check
sends the findings back to Gemini for a repair, a bounded number of times. The loop must always
stop, spend Gemini and Lambda calls only while time is left, and end in exactly one state:
`published` (an `AnimationReference`) or `failed` (one code from the closed set of Requirement
13.11). The module is split so the parts that decide things can be tested without any AI package:

1. Pure state and routing: `AgentState`, `RunContext`, `decide_after_verify` (the table of design
   6.6), `route_after_verify`, `next_node` and the edge table `STATIC_EDGES`.
2. The five nodes as plain coroutines of `(state, run)`: `generate_node`, `verify_node`,
   `repair_node`, `publish_node`, `fail_node`. Each returns a partial state, never raises for an
   expected failure, and checks the deadline and the cancel flag before it starts any work.
3. Two runners over the same nodes and the same routing:
   - `run_agent(run)` is the driver loop: it walks `next_node` and merges each node's update into
     the state. It needs nothing but the standard library and is what the tests drive.
   - `run_agent(run, graph=build_graph())` hands the walk to LangGraph. `build_graph()` is a thin
     shell: it registers the same nodes and the same edge table with `StateGraph`, and it is the
     only place that imports `langgraph` (Requirement 41.1). The module itself never loads it.
   Both runners end in the same `_conclude`, so their results cannot differ except through a bug
   in the shell, which a test compares against the driver on the same scripted run.

The rules, in short (Requirements 13 and 14, design 6.6, 6.7):

- `calls` counts Gemini calls started. `decide_after_verify` routes: no time left is
  `ANIMATION_TIMEOUT`; a `terminal` code decided by a node stops the run with that code; `ok` goes
  to `publish`; `calls < max_attempts` goes to `repair`; anything else is
  `ANIMATION_VERIFICATION_FAILED`. At most `max_attempts` (1 to 4) Gemini calls are made.
- `generate` and `repair` ask Gemini (text mode, temperature and `max_output_tokens` set here) and
  read the file with `extract_main_ts`. No code in the reply, or a repair whose source hashes like
  the previous one, skips the verifier: the verify node emits one `diagnostics` event with an
  `AGENT_EXTRACT_NO_CODE` or `AGENT_REPAIR_UNCHANGED` item and the attempt counts as failed. After
  `AGENT_EXTRACT_NO_CODE` the previous source is empty, so the repair asks for the whole file.
- A `GeminiFailure` ends the run without another call: `RATE_LIMITED` stays `RATE_LIMITED`,
  `TIMEOUT` is `ANIMATION_TIMEOUT`, `PROVIDER_UNAVAILABLE` stays itself, anything else (such as
  `OUTPUT_PARSE_FAILED`) is `UNKNOWN`.
- The verifier is called with the same five-key payload and the same tokens on every attempt. An
  invocation that failed, a payload that is not a `VerifierResult`, or a Diagnostic of
  `VERIFIER_INTERNAL`, `VERIFIER_CONTRACT_MISMATCH` or `VERIFIER_BAD_INPUT` ends the run with
  `ANIMATION_VERIFIER_UNAVAILABLE` and no `diagnostics` event. A `FunctionError` becomes one
  `VERIFIER_CRASH` Diagnostic with a fixed message and counts as a failed attempt.
  `VERIFIER_DEADLINE` is an ordinary failed attempt. A verifier call that ran out of time ends the
  run with `ANIMATION_TIMEOUT` and its answer is dropped.
- Diagnostics are put errors first (stable) before they go into the repair prompt and the event.
  The `AgentFailed` result keeps them without their `message` (the state keeps the text for the
  repair prompt; the result is safe to print, Requirement 32.4).
- `publish` writes S3 (`store.publish`) and then the registry (`registry.register`), each through
  `asyncio.to_thread` under `asyncio.wait_for` with the time left. Neither starts when the run was
  cancelled or the deadline has passed, so a late run never writes `manifest.json` or a row.
  `Adopted` and `Published` are treated alike: the registry records the manifest's values
  (Requirement 19.15), and the reference comes from the row `register` returns, which may belong
  to a run that won a race (Requirement 18.9). `QuotaExceeded` is `ANIMATION_QUOTA_EXCEEDED`;
  `StorageFailed` and `RegistryError` are `ANIMATION_STORAGE_FAILED`.
- Cancellation: `run_agent` sets `run.cancelled` (so a thread inside `store.publish` stops at its
  next S3 call), writes `animation.end` with `CANCELLED` and re-raises `CancelledError`. Nodes start
  nothing and emit nothing once the flag is set. A run that finds the flag set ends as `UNKNOWN`,
  which the endpoint does not send to a client (Requirement 13.15).
- Safety net: the whole run is under `asyncio.timeout(remaining + 5 s)`; when that fires the run
  ends as `ANIMATION_TIMEOUT` (design 6.6, Requirement 17.14). Any other unexpected exception ends
  as `UNKNOWN`; only the class and the place are logged, never the message (Requirement 32.4).

What the agent does not do: it sends no terminal event (`done` or `error`), because the endpoint's
run handle owns the single terminal event; it returns `AgentPublished` or `AgentFailed` for it to
map. It logs `animation.start` (idempotent), one `animation.attempt` per attempt that reached an
outcome, and `animation.end`, through `RunContext.log`, and never a source, prompt, token, key,
URL or Diagnostic message (Requirement 14.8, 33). `attempts` in the result is the number of Gemini
calls started in this run; `AgentPublished.row.attempts` is the recorded value for `done`.

Ports: `StorePort` and `RegistryPort` are what the nodes need from storage; `S3AnimationStore`
fits `StorePort` as it is, and the endpoint wraps `registry.register(engine, row, limits)` in an
object with `register(row)`. `VerifierPort` comes from `verifier_client.py`. Tests pass fakes.

`[belum diverifikasi]`: `build_graph()` was written from the LangGraph API as remembered
(`StateGraph(AgentState)`, `add_node`, `add_edge`, `add_conditional_edges`, `START`, `END`,
`compile`, `ainvoke(..., config={"configurable": ..., "recursion_limit": ...})`) and checked only
against a stub of that API in `tests/test_animation_agent_graph.py`; the test against the real
package is skipped where `langgraph` is not installed. Node wrappers have no annotations on
purpose: LangGraph reads type hints of a node, and a name that is imported only for type checking
would fail there.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
import traceback
import uuid
from collections.abc import Awaitable, Callable, Mapping
from contextlib import suppress
from dataclasses import dataclass, field, replace
from functools import lru_cache
from typing import Any, Literal, Protocol, TypedDict

from app.ai.animation.contract import AnimationContract
from app.ai.animation.limits import DEADLINE_MS_CAP, MAX_ATTEMPTS_CAP
from app.ai.animation.logging_ import END_CANCELLED, END_OK, RunLog, configure_boto_logging
from app.ai.animation.models import (
    ATTEMPTS_MAX,
    DIAGNOSTICS_EVENT_ITEMS_MAX,
    ERROR_CODES,
    AnimationReference,
    AnimationRow,
    CreateAnimationRequest,
    Diagnostic,
    DiagnosticItem,
    DiagnosticsEvent,
    ErrorCode,
    MainMeta,
    ManifestVerification,
    SseEvent,
    StageEvent,
    VerifierResult,
    reference_from_row,
)
from app.ai.animation.prompts import (
    EXTRACT_NO_CODE,
    GENERATE_MAX_TOKENS,
    GENERATE_TEMPERATURE,
    REPAIR_TEMPERATURE,
    ExtractFail,
    build_generate_prompt,
    build_repair_prompt,
    extract_main_ts,
)
from app.ai.animation.registry import NewRow, QuotaExceeded, Registered, RegistryError
from app.ai.animation.store import (
    Adopted,
    ManifestFields,
    Published,
    PublishResult,
    StorageFailed,
    TimedOut,
    animation_prefix,
)
from app.ai.animation.tokens import derive_tokens, effective_forbidden_tokens
from app.ai.animation.verifier_client import LambdaOutcome, VerifierPort, build_payload
from app.ai.gemini_client import GeminiFailure, GeminiRequest, GeminiTextResult
from app.ai.runtime import AiContext

# The agent's own Diagnostic code for a repair that changed nothing (design 5.2).
REPAIR_UNCHANGED = "AGENT_REPAIR_UNCHANGED"
# The code of a crashed verifier handler (`FunctionError`), written by the agent (Requirement 14.4).
VERIFIER_CRASH = "VERIFIER_CRASH"

# Fixed messages of the Diagnostics the agent writes. They go to the model in the repair prompt, so
# they say what to do; none holds a value from the verifier (no `errorMessage`, no `stackTrace`).
EXTRACT_NO_CODE_MESSAGE = (
    "No code block labelled ts was found in the reply. "
    "Reply with one fenced ts code block that holds the whole file."
)
REPAIR_UNCHANGED_MESSAGE = (
    "The file is identical to the previous one. Change the code to fix the diagnostics."
)
VERIFIER_CRASH_MESSAGE = (
    "The checker crashed on this file. Simplify the code and avoid unusual constructs."
)

# Diagnostics that mean the deployment is wrong, not the file (Requirements 14.6, 14.10).
VERIFIER_INFRA_CODES = frozenset(
    {"VERIFIER_INTERNAL", "VERIFIER_CONTRACT_MISMATCH", "VERIFIER_BAD_INPUT"}
)

# How a `GeminiFailure.code` becomes the code of the run (Requirement 13.9, 13.18).
GEMINI_FAILURE_CODES: Mapping[str, str] = {
    "RATE_LIMITED": "RATE_LIMITED",
    "TIMEOUT": "ANIMATION_TIMEOUT",
    "PROVIDER_UNAVAILABLE": "PROVIDER_UNAVAILABLE",
}

# generate, verify, (repair, verify) x 3, publish is 9 steps; the margin is for a changed table.
RECURSION_LIMIT = 25
# The outer guard waits this long past the deadline before it cancels the run (design 6.6).
GUARD_MARGIN_MS = 5_000

Route = Literal["publish", "repair", "fail"]
NodeName = Literal["generate", "verify", "repair", "publish", "fail"]
AttemptOutcome = Literal[
    "verified", "verify_failed", "extract_failed", "repair_unchanged", "gemini_failed"
]

FIRST_NODE: NodeName = "generate"

# The edges that do not depend on the state; `None` is the end of the run. The conditional edge
# after `verify` is `route_after_verify`. `build_graph` and `next_node` both read these.
STATIC_EDGES: Mapping[str, str | None] = {
    "generate": "verify",
    "repair": "verify",
    "publish": None,
    "fail": None,
}
ROUTES: Mapping[str, str] = {"publish": "publish", "repair": "repair", "fail": "fail"}

failure_logger = logging.getLogger("lore.ai")


class AgentState(TypedDict, total=False):
    """The state of one run, in memory for one request (no checkpointer, Requirement 13.1)."""

    source: str  # last normalized source; "" after AGENT_EXTRACT_NO_CODE
    source_sha: str  # sha256 of `source` in UTF-8; "" when there is no source
    calls: int  # Gemini calls started, 0 to max_attempts
    model: str | None  # model of the latest Gemini call that answered
    skip_verify: bool  # extract failed or repair unchanged: the verifier is not called
    diagnostics: list[Diagnostic]  # last attempt's Diagnostics, errors first, at most 50
    verification: VerifierResult | None
    terminal: str | None  # code decided by a node (Gemini failed, verifier unavailable, ...)
    next: Route
    failure_code: str | None
    reference: AnimationReference | None
    row: AnimationRow | None
    outcome: Literal["published", "failed"]
    attempt_started: float  # run.clock() when the current attempt began, for latency_ms


class StorePort(Protocol):
    """What the endpoint needs from S3; `S3AnimationStore` fits as it is (synchronous).

    `publish` is the only method the agent calls. `presign` is for the Animation_Reader, which
    shares the runtime's store; it makes no S3 request and raises `StoreError` when it cannot sign.
    """

    def publish(
        self,
        source: str,
        bundle: str,
        fields: ManifestFields,
        *,
        remaining_ms: Callable[[], float] | None = None,
        cancelled: Callable[[], bool] | None = None,
    ) -> PublishResult: ...

    def presign(self, source_sha256: str) -> dict[str, str]: ...


class RegistryPort(Protocol):
    """What `publish_node` needs from the registry: `registry.register` bound to engine and limits.

    Synchronous; raises `RegistryError` on a database failure.
    """

    def register(self, row: NewRow) -> Registered | QuotaExceeded: ...


def _discard(event: SseEvent) -> None:
    """Default `emit`: drop the event (tests and Idempotent_Hit paths that need no stream)."""


@dataclass
class RunContext:
    """Everything one run needs, passed to every node (design 6.6).

    `required`, `forbidden` and `skipped` are derived once from the request (see `create`), so the
    prompts, the verifier payload and the manifest all see the same tokens (Requirement 14.12).
    `clock` is monotonic seconds and injectable; `t0` is `clock()` when the run began, and the
    deadline counts from it. `emit` is synchronous and must not block (the endpoint puts the event
    on a queue). `cancelled` is set by `run_agent` when the run is cancelled, and by the endpoint
    when the client leaves. `calls_started` and `source_model` mirror the state for the log lines
    of a run that is cancelled or timed out, whose state is gone.
    """

    request: CreateAnimationRequest
    required: list[str]
    forbidden: list[str]
    skipped: list[str]
    request_hash: str
    owner_id: uuid.UUID
    ai: AiContext
    models: tuple[str, ...]
    contract: AnimationContract
    verifier: VerifierPort
    store: StorePort
    registry: RegistryPort
    t0: float
    max_attempts: int = MAX_ATTEMPTS_CAP
    deadline_ms: float = DEADLINE_MS_CAP
    clock: Callable[[], float] = time.monotonic
    emit: Callable[[SseEvent], None] = _discard
    cancelled: asyncio.Event = field(default_factory=asyncio.Event)
    log: RunLog | None = None
    calls_started: int = 0
    source_model: str | None = None

    def __post_init__(self) -> None:
        # The event schema allows 1 to 4 attempts, so a larger value would fail on its first event.
        self.max_attempts = max(1, min(self.max_attempts, ATTEMPTS_MAX))

    @property
    def kind(self) -> str:
        return self.request.kind

    def remaining_ms(self) -> float:
        """Milliseconds left before the deadline; zero or less means nothing may start."""
        return self.deadline_ms - (self.clock() - self.t0) * 1000

    @classmethod
    def create(
        cls,
        request: CreateAnimationRequest,
        *,
        contract: AnimationContract,
        owner_id: uuid.UUID,
        request_hash: str,
        ai: AiContext,
        models: tuple[str, ...],
        verifier: VerifierPort,
        store: StorePort,
        registry: RegistryPort,
        max_attempts: int = MAX_ATTEMPTS_CAP,
        deadline_ms: float = DEADLINE_MS_CAP,
        clock: Callable[[], float] = time.monotonic,
        emit: Callable[[SseEvent], None] = _discard,
        cancelled: asyncio.Event | None = None,
        log: RunLog | None = None,
    ) -> RunContext:
        """A context with the tokens derived from `request` and the clock started now."""
        tokens = derive_tokens(request, contract)
        return cls(
            request=request,
            required=tokens.required,
            forbidden=effective_forbidden_tokens(request, tokens.required),
            skipped=tokens.skipped,
            request_hash=request_hash,
            owner_id=owner_id,
            ai=ai,
            models=models,
            contract=contract,
            verifier=verifier,
            store=store,
            registry=registry,
            t0=clock(),
            max_attempts=max_attempts,
            deadline_ms=deadline_ms,
            clock=clock,
            emit=emit,
            cancelled=cancelled if cancelled is not None else asyncio.Event(),
            log=log,
        )


@dataclass(frozen=True)
class AgentPublished:
    """The run published an animation. `row` is the registry row that stands for the request.

    `reference` is built from that row, so it is the one to put in `done` (Requirement 18.9).
    `calls` is the Gemini calls started by this run (for the log); `row.attempts` is the recorded
    value for `done.attempts` (Requirement 13.16, design G13).
    """

    reference: AnimationReference
    row: AnimationRow
    calls: int
    model: str | None
    ok: Literal[True] = True


@dataclass(frozen=True)
class AgentFailed:
    """The run failed with one code of the closed set; `calls` is `attempts` of the `error` event.

    `diagnostics` is the last verification's list (at most 50, errors first) with every `message`
    emptied: tool, code, severity and place stay, the text does not. A message is written by the
    verifier or the model and may quote the source, so a result that is printed, logged or
    serialized by mistake cannot leak it (Requirement 32.4). The state keeps the messages for the
    repair prompt; only this result drops them.
    """

    code: ErrorCode
    calls: int
    diagnostics: tuple[Diagnostic, ...] = ()
    model: str | None = None
    ok: Literal[False] = False


AgentResult = AgentPublished | AgentFailed


# ---------------------------------------------------------------------------------------------
# Pure routing
# ---------------------------------------------------------------------------------------------


def decide_after_verify(
    *,
    ok: bool,
    calls: int,
    max_attempts: int,
    remaining_ms: float,
    terminal: str | None,
) -> tuple[Route, str | None]:
    """The route after `verify` and the failure code, exactly the table of design 6.6.

    Pure and total: every input gives one route and never raises. The order of the checks is the
    order of the table: no time left, then a node's terminal code, then success, then a repair if
    attempts remain, else a failed verification (Requirement 13.13).
    """
    if not remaining_ms > 0:  # also true for NaN: no usable time means no time
        return "fail", "ANIMATION_TIMEOUT"
    if terminal is not None:
        return "fail", terminal
    if ok:
        return "publish", None
    if calls < max_attempts:
        return "repair", None
    return "fail", "ANIMATION_VERIFICATION_FAILED"


def route_after_verify(state: Mapping[str, Any]) -> Route:
    """The conditional edge after `verify`: the route `verify_node` stored. Total.

    A state without a usable `next` goes to `fail`, which ends the run as `UNKNOWN`.
    """
    route = state.get("next")
    if isinstance(route, str) and route in ROUTES:
        return route  # type: ignore[return-value]
    return "fail"


def next_node(node: str, state: Mapping[str, Any]) -> str | None:
    """The node that follows `node`, or `None` at the end. The driver walks this."""
    if node == "verify":
        return route_after_verify(state)
    return STATIC_EDGES.get(node)


# ---------------------------------------------------------------------------------------------
# Helpers shared by the nodes
# ---------------------------------------------------------------------------------------------


def _runlog(run: RunContext) -> RunLog:
    if run.log is None:
        run.log = RunLog(run.kind, False, clock=run.clock)
    return run.log


def _emit(run: RunContext, event: SseEvent) -> None:
    """Hand `event` to the stream unless the run was cancelled; a failing `emit` is ignored."""
    if run.cancelled.is_set():
        return
    with suppress(Exception):
        run.emit(event)


def _stop_code(run: RunContext) -> str | None:
    """Why no step may start now: `UNKNOWN` if cancelled, `ANIMATION_TIMEOUT` past the deadline."""
    if run.cancelled.is_set():
        return "UNKNOWN"
    if not run.remaining_ms() > 0:
        return "ANIMATION_TIMEOUT"
    return None


def _closed_code(code: str | None) -> ErrorCode:
    """`code` when it is in the closed set of Requirement 13.11, else `UNKNOWN`."""
    return code if code in ERROR_CODES else "UNKNOWN"  # type: ignore[return-value]


def _sha(source: str) -> str:
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def _agent_diagnostic(tool: Literal["agent", "verifier"], code: str, message: str) -> Diagnostic:
    """A Diagnostic written by the agent: error severity, no line and no column."""
    return Diagnostic(tool=tool, code=code, severity="error", message=message)


def _errors_first(items: list[Diagnostic], limit: int) -> list[Diagnostic]:
    """Errors before warnings, each group in the order given, at most `limit` (stable sort)."""
    return sorted(items, key=lambda item: item.severity != "error")[:limit]


def _diagnostics_event(attempt: int, ok: bool, items: list[Diagnostic]) -> DiagnosticsEvent:
    """The `diagnostics` event: counts of all items, the first ten as tool, code and line only."""
    errors = sum(1 for item in items if item.severity == "error")
    shown: list[DiagnosticItem] = []
    for item in items[:DIAGNOSTICS_EVENT_ITEMS_MAX]:
        line = {} if item.line is None else {"line": item.line}
        shown.append(DiagnosticItem(tool=item.tool, code=item.code, **line))
    return DiagnosticsEvent(
        attempt=attempt, ok=ok, error_count=errors, warning_count=len(items) - errors, items=shown
    )


def _log_attempt(
    run: RunContext, attempt: int, outcome: AttemptOutcome, items: list[Diagnostic], started: float
) -> None:
    errors = sum(1 for item in items if item.severity == "error")
    _runlog(run).attempt(
        attempt=attempt,
        outcome=outcome,
        error_count=errors,
        warning_count=len(items) - errors,
        latency_ms=(run.clock() - started) * 1000,
    )


async def _call_gemini(
    run: RunContext, system: str, prompt: str, temperature: float
) -> GeminiTextResult:
    """One Gemini call in text mode, limited by the time left (Requirement 4.7).

    `timeout_ms` and `deadline_ms` both become the smallest of the configured timeout, the
    configured deadline and the milliseconds left before the animation deadline, so a call cannot
    outlive the run. The models are the animation models of the run.
    """
    config = run.ai.config
    limit = min(config.timeout_ms, config.deadline_ms, max(run.remaining_ms(), 0.0))
    limited = replace(config, models=run.models, timeout_ms=limit, deadline_ms=limit)
    request = GeminiRequest(
        system=system,
        prompt=prompt,
        max_output_tokens=GENERATE_MAX_TOKENS,
        temperature=temperature,
        response_format="text",
    )
    return await replace(run.ai, config=limited).generate_text(request)


# ---------------------------------------------------------------------------------------------
# Nodes
# ---------------------------------------------------------------------------------------------


async def _gemini_step(state: AgentState, run: RunContext, *, repair: bool) -> AgentState:
    """The shared body of `generate_node` and `repair_node` (they differ in prompt and stage)."""
    stop = _stop_code(run)
    if stop is None and state.get("calls", 0) >= run.max_attempts:
        stop = "ANIMATION_VERIFICATION_FAILED"  # the router never sends a run here; belt and braces
    if stop is not None:
        return {"terminal": stop, "skip_verify": False}

    calls = state.get("calls", 0) + 1
    run.calls_started = calls
    started = run.clock()
    _emit(run, StageEvent(stage="repairing" if repair else "generating", attempt=calls))
    if repair:
        system, prompt = build_repair_prompt(
            run.request, state.get("source", ""), state.get("diagnostics", []), run.contract
        )
        temperature = REPAIR_TEMPERATURE
    else:
        system, prompt = build_generate_prompt(run.request, run.contract)
        temperature = GENERATE_TEMPERATURE

    reply = await _call_gemini(run, system, prompt, temperature)
    if isinstance(reply, GeminiFailure):
        _log_attempt(run, calls, "gemini_failed", [], started)
        code = GEMINI_FAILURE_CODES.get(reply.code, "UNKNOWN")
        return {"calls": calls, "terminal": code, "skip_verify": False, "attempt_started": started}

    run.source_model = reply.model
    extracted = extract_main_ts(reply.text)
    if isinstance(extracted, ExtractFail):
        return {
            "calls": calls,
            "model": reply.model,
            "source": "",
            "source_sha": "",
            "skip_verify": True,
            "diagnostics": [_agent_diagnostic("agent", EXTRACT_NO_CODE, EXTRACT_NO_CODE_MESSAGE)],
            "verification": None,
            "terminal": None,
            "attempt_started": started,
        }
    source = extracted.source
    digest = _sha(source)
    update: AgentState = {
        "calls": calls,
        "model": reply.model,
        "source": source,
        "source_sha": digest,
        "skip_verify": False,
        "verification": None,
        "terminal": None,
        "attempt_started": started,
    }
    if repair and digest == state.get("source_sha"):
        update["skip_verify"] = True
        update["diagnostics"] = [
            _agent_diagnostic("agent", REPAIR_UNCHANGED, REPAIR_UNCHANGED_MESSAGE)
        ]
    return update


async def generate_node(state: AgentState, run: RunContext) -> AgentState:
    """First Gemini call: ask for `main.ts` and read it from the reply (Requirement 13.2)."""
    return await _gemini_step(state, run, repair=False)


async def repair_node(state: AgentState, run: RunContext) -> AgentState:
    """Another Gemini call: send the last source and its Diagnostics back for a fix."""
    return await _gemini_step(state, run, repair=True)


@dataclass(frozen=True)
class _Verdict:
    """What one verifier call came to, before routing."""

    terminal: str | None = None
    ok: bool = False
    diagnostics: tuple[Diagnostic, ...] = ()
    verification: VerifierResult | None = None


async def _verify_source(state: AgentState, run: RunContext, calls: int) -> _Verdict:
    """Call the verifier for the current source and classify the outcome (design 6.6, 6.7)."""
    _emit(run, StageEvent(stage="verifying", attempt=calls))
    payload = build_payload(
        source=state.get("source", ""),
        kind=run.request.kind,
        required_tokens=run.required,
        forbidden_tokens=run.forbidden,
        contract_version=run.contract.contract_version,
    )
    try:
        outcome: LambdaOutcome = await run.verifier.invoke(
            payload, remaining_ms=run.remaining_ms(), attempt=calls
        )
    except Exception:  # Requirement 14.5: an invocation that raised is "unavailable"
        return _Verdict(terminal=_stop_code(run) or "ANIMATION_VERIFIER_UNAVAILABLE")

    # An answer that arrives after the deadline (or after a cancel) is dropped unread (14.9).
    stop = _stop_code(run)
    if stop is not None:
        return _Verdict(terminal=stop)
    if outcome.kind == "timeout":
        return _Verdict(terminal="ANIMATION_TIMEOUT")
    if outcome.kind == "function_error":
        crash = _agent_diagnostic("verifier", VERIFIER_CRASH, VERIFIER_CRASH_MESSAGE)
        return _Verdict(diagnostics=(crash,))
    result = outcome.result
    if outcome.kind != "result" or result is None:
        return _Verdict(terminal="ANIMATION_VERIFIER_UNAVAILABLE")
    if any(item.code in VERIFIER_INFRA_CODES for item in result.diagnostics):
        return _Verdict(terminal="ANIMATION_VERIFIER_UNAVAILABLE")
    ordered = _errors_first(list(result.diagnostics), run.contract.limits.diagnostics_max)
    return _Verdict(ok=result.ok, diagnostics=tuple(ordered), verification=result)


async def verify_node(state: AgentState, run: RunContext) -> AgentState:
    """Check the source (or record why it is not checked) and decide the route.

    A run that already has a `terminal` code, was cancelled or has no time left calls nothing. A
    skipped verification emits one `diagnostics` event for the agent's own Diagnostic. The route
    and the failure code come from one `decide_after_verify` call, so `fail_node` never measures
    the time again.
    """
    calls = state.get("calls", 0)
    started = state.get("attempt_started", run.clock())
    terminal = state.get("terminal") or _stop_code(run)
    items: list[Diagnostic] = list(state.get("diagnostics", []))
    verification: VerifierResult | None = None
    ok = False

    if terminal is None and state.get("skip_verify"):
        _emit(run, _diagnostics_event(calls, False, items))
        no_code = any(item.code == EXTRACT_NO_CODE for item in items)
        _log_attempt(
            run, calls, "extract_failed" if no_code else "repair_unchanged", items, started
        )
    elif terminal is None:
        verdict = await _verify_source(state, run, calls)
        terminal = verdict.terminal
        if terminal is None:
            items, verification, ok = list(verdict.diagnostics), verdict.verification, verdict.ok
            _emit(run, _diagnostics_event(calls, ok, items))
            _log_attempt(run, calls, "verified" if ok else "verify_failed", items, started)

    route, code = decide_after_verify(
        ok=ok,
        calls=calls,
        max_attempts=run.max_attempts,
        remaining_ms=run.remaining_ms(),
        terminal=terminal,
    )
    return {
        "diagnostics": items,
        "verification": verification,
        "terminal": terminal,
        "next": route,
        "failure_code": code,
    }


def _published_failed(code: str) -> AgentState:
    return {"outcome": "failed", "failure_code": code, "reference": None, "row": None}


def _manifest_fields(
    run: RunContext, verification: VerifierResult, meta: MainMeta, model: str, calls: int
) -> ManifestFields:
    """The manifest values the store cannot compute: they come from the verified result."""
    summary = verification.summary
    warnings = [item for item in verification.diagnostics if item.severity == "warning"]
    return ManifestFields(
        contract_version=run.contract.contract_version,
        runtime_version=summary.runtime_version,
        meta=meta,
        verification=ManifestVerification(
            verifier_version=summary.verifier_version, checks=summary.checks, warnings=warnings
        ),
        skipped_tokens=tuple(run.skipped),
        model=model,
        attempts=calls,
        request_hash=run.request_hash,
    )


def _new_row(run: RunContext, stored: Published | Adopted) -> NewRow:
    """The registry row for the manifest in S3, written now or adopted (Requirement 19.15)."""
    manifest = stored.manifest
    return NewRow(
        id=str(uuid.uuid4()),
        owner_id=run.owner_id,
        request_hash=run.request_hash,
        source_sha256=manifest.source_sha256,
        bundle_sha256=manifest.bundle_sha256,
        s3_prefix=animation_prefix(manifest.source_sha256),
        kind=run.request.kind,
        meta=manifest.meta.dump(),
        attempts=manifest.attempts,
        model=manifest.model,
        verifier_version=manifest.verification.verifier_version,
        contract_version=manifest.contract_version,
        runtime_version=manifest.runtime_version.dump(),
        source_bytes=manifest.source_bytes,
        bundle_bytes=manifest.bundle_bytes,
    )


def _seconds_left(run: RunContext) -> float:
    return max(run.remaining_ms(), 0.0) / 1000


def _store_failure_code(result: PublishResult) -> str:
    """The run's code for a publish result that wrote nothing usable (not `Published`/`Adopted`)."""
    if isinstance(result, TimedOut):
        return "UNKNOWN" if result.cancelled else "ANIMATION_TIMEOUT"
    if isinstance(result, StorageFailed):
        return "ANIMATION_STORAGE_FAILED"
    return "UNKNOWN"


async def publish_node(state: AgentState, run: RunContext) -> AgentState:
    """Write the three S3 objects, then the registry row, and return the reference.

    Starts nothing when the run is cancelled or out of time (Requirements 13.15, 14.9, 19.14). The
    S3 call and the registry call run in worker threads under `wait_for` with the time left; a
    thread that outlives its wait is not waited for, and `store.publish` checks the deadline and
    the cancel flag before each S3 call, so it cannot write `manifest.json` late.
    """
    calls = state.get("calls", 0)
    stop = _stop_code(run)
    if stop is not None:
        return _published_failed(stop)
    verification, model = state.get("verification"), state.get("model")
    if verification is None or not verification.ok or not model:
        return _published_failed("UNKNOWN")
    bundle, meta = verification.bundle, verification.meta
    if bundle is None or meta is None:  # an ok result always carries both (VerifierResult)
        return _published_failed("UNKNOWN")

    _emit(run, StageEvent(stage="publishing", attempt=calls))
    fields = _manifest_fields(run, verification, meta, model, calls)
    try:
        stored = await asyncio.wait_for(
            asyncio.to_thread(
                run.store.publish,
                state.get("source", ""),
                bundle,
                fields,
                remaining_ms=run.remaining_ms,
                cancelled=run.cancelled.is_set,
            ),
            _seconds_left(run),
        )
    except TimeoutError:
        return _published_failed("ANIMATION_TIMEOUT")
    if not isinstance(stored, Published | Adopted):
        return _published_failed(_store_failure_code(stored))

    stop = _stop_code(run)
    if stop is not None:
        return _published_failed(stop)
    try:
        registered = await asyncio.wait_for(
            asyncio.to_thread(run.registry.register, _new_row(run, stored)), _seconds_left(run)
        )
    except TimeoutError:
        return _published_failed("ANIMATION_TIMEOUT")
    except RegistryError:
        return _published_failed("ANIMATION_STORAGE_FAILED")
    if isinstance(registered, QuotaExceeded):
        return _published_failed("ANIMATION_QUOTA_EXCEEDED")
    row = registered.row
    return {
        "outcome": "published",
        "failure_code": None,
        "reference": reference_from_row(row),
        "row": row,
    }


async def fail_node(state: AgentState, run: RunContext) -> AgentState:
    """End in `failed` with the code `verify_node` stored (or the node's `terminal` code)."""
    code = state.get("failure_code") or state.get("terminal")
    return {"outcome": "failed", "failure_code": _closed_code(code)}


NODES: Mapping[str, Callable[[AgentState, RunContext], Awaitable[AgentState]]] = {
    "generate": generate_node,
    "verify": verify_node,
    "repair": repair_node,
    "publish": publish_node,
    "fail": fail_node,
}


# ---------------------------------------------------------------------------------------------
# Runners
# ---------------------------------------------------------------------------------------------


async def _drive(run: RunContext) -> AgentState:
    """Walk the nodes with `next_node` and merge each update into the state (the driver loop)."""
    state: AgentState = {"calls": 0}
    node: str | None = FIRST_NODE
    steps = 0
    while node is not None:
        steps += 1
        if steps > RECURSION_LIMIT:
            raise RuntimeError("the agent did not reach an end state")
        update = await NODES[node](state, run)
        state = {**state, **update}  # type: ignore[typeddict-item]
        node = next_node(node, state)
    return state


def _bind(node: Callable[[AgentState, RunContext], Awaitable[AgentState]]) -> Any:
    """Adapt a node to LangGraph's `(state, config)` call, taking the run from `configurable`.

    The wrapper has no annotations on purpose: LangGraph reads the type hints of a node, and a
    name that is not a module global would fail there.
    """

    async def call(state, config):
        return await node(state, config["configurable"]["run"])

    call.__name__ = node.__name__
    return call


@lru_cache(maxsize=1)
def build_graph() -> Any:
    """Compile the LangGraph shell over the same nodes and edge table, once per process.

    The only place that imports `langgraph` (Requirement 41.1); the endpoint calls it when the
    first run needs it, never when the feature flag is off. No checkpointer: the state lives in
    memory for one request. Building the graph is the moment the animation runtime comes into
    being, so the AWS loggers are held at `WARNING` here, before the first AWS call.

    Topology (design 6.6): START to `generate`; `generate` and `repair` to `verify`; `verify` to
    `publish`, `repair` or `fail` by `route_after_verify`; `publish` and `fail` to END.
    """
    from langgraph.graph import END, START, StateGraph

    configure_boto_logging()
    graph = StateGraph(AgentState)
    for name, node in NODES.items():
        graph.add_node(name, _bind(node))
    graph.add_edge(START, FIRST_NODE)
    for source, target in STATIC_EDGES.items():
        graph.add_edge(source, END if target is None else target)
    graph.add_conditional_edges("verify", route_after_verify, dict(ROUTES))
    return graph.compile()


async def _invoke_graph(graph: Any, run: RunContext) -> AgentState:
    """Run the compiled graph for `run`; the run travels in `config["configurable"]["run"]`."""
    final = await graph.ainvoke(
        {"calls": 0},
        config={"configurable": {"run": run}, "recursion_limit": RECURSION_LIMIT},
    )
    return final  # type: ignore[no-any-return]


def _where(exc: BaseException) -> str:
    """`ExceptionClass at file:line in function`; never the message (it may quote user data)."""
    frames = traceback.extract_tb(exc.__traceback__)
    if not frames:
        return type(exc).__name__
    last = frames[-1]
    return f"{type(exc).__name__} at {last.filename}:{last.lineno} in {last.name}"


def _without_message(item: Diagnostic) -> Diagnostic:
    """`item` with an empty message (`Diagnostic.message` may be empty; the rest is unchanged)."""
    return item.model_copy(update={"message": ""})


def _failed(run: RunContext, state: AgentState | None, code: str) -> AgentFailed:
    """Log the end of a failed run and describe it."""
    closed = _closed_code(code)
    calls = state.get("calls", run.calls_started) if state else run.calls_started
    model = state.get("model") if state else run.source_model
    items = tuple(_without_message(item) for item in state.get("diagnostics", [])) if state else ()
    _runlog(run).end(code=closed, attempts=calls, model=model)
    return AgentFailed(code=closed, calls=calls, diagnostics=items, model=model)


def _conclude(run: RunContext, state: AgentState) -> AgentResult:
    """Turn the final state into the result and write `animation.end`."""
    reference, row = state.get("reference"), state.get("row")
    if state.get("outcome") == "published" and reference is not None and row is not None:
        calls, model = state.get("calls", run.calls_started), state.get("model")
        _runlog(run).end(code=END_OK, attempts=calls, model=model)
        return AgentPublished(reference=reference, row=row, calls=calls, model=model)
    code = state.get("failure_code") or state.get("terminal")
    if run.cancelled.is_set():  # a cancelled run is logged as such, whatever code it carries
        calls, model = state.get("calls", run.calls_started), state.get("model")
        _runlog(run).end(code=END_CANCELLED, attempts=calls, model=model)
        return AgentFailed(code="UNKNOWN", calls=calls, model=model)
    return _failed(run, state, code or "UNKNOWN")


async def run_agent(run: RunContext, *, graph: Any | None = None) -> AgentResult:
    """Run the agent to one end state and return it. Cancellation is the only exception.

    Without `graph` the driver loop runs the nodes; with `graph=build_graph()` LangGraph does. The
    result is `AgentPublished` or `AgentFailed`; an unexpected exception becomes `UNKNOWN` (only
    its class and place are logged). `asyncio.CancelledError` sets `run.cancelled`, writes
    `animation.end` with `CANCELLED` and is raised again; nothing starts after that, and no event is
    emitted. The whole run is under a guard of the time left plus `GUARD_MARGIN_MS`.
    """
    configure_boto_logging()
    _runlog(run).start()
    guard = asyncio.timeout(max(run.remaining_ms() + GUARD_MARGIN_MS, 0.0) / 1000)
    try:
        async with guard:
            state = await (_drive(run) if graph is None else _invoke_graph(graph, run))
    except asyncio.CancelledError:
        run.cancelled.set()
        _runlog(run).end(code=END_CANCELLED, attempts=run.calls_started, model=run.source_model)
        raise
    except TimeoutError as exc:
        if not guard.expired():
            failure_logger.error("animation agent failed: %s", _where(exc))
            return _failed(run, None, "UNKNOWN")
        result = _failed(run, None, "ANIMATION_TIMEOUT")
        run.cancelled.set()  # a thread still in `store.publish` stops at its next S3 call
        return result
    except Exception as exc:  # the last line of defence: one end state, no leak
        failure_logger.error("animation agent failed: %s", _where(exc))
        return _failed(run, None, "UNKNOWN")
    return _conclude(run, state)
