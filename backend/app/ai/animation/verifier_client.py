"""Client for the verifier Lambda: one synchronous invoke, classified, never raising.

Why: the agent must tell "the code is wrong" (repair it) apart from "the verifier is not
available" (stop, do not burn Gemini tokens), so every call to the Lambda ends in one of four
outcomes (design 6.7, Requirement 14):

- `result`: the Lambda answered and the payload is a valid `VerifierResult` (ok or not);
- `function_error`: the response carries `FunctionError`, i.e. the handler crashed or timed out.
  The body (`errorMessage`, `stackTrace`) is never read or kept (Requirement 14.4);
- `unavailable`: the call raised after the client's own retries, or the payload is empty, not
  JSON, not a `VerifierResult`, or the status is not 200 (Requirements 14.3, 14.5);
- `timeout`: the run's remaining time was used up before the answer came (Requirement 14.9).

Rules this module keeps, and where:

- No `boto3`/`botocore` import at module level and none at construction. They are imported only
  in `_default_client_factory`, which runs on first use inside the worker thread, so the heavy
  import never blocks the event loop and an api with the feature off never pays for it
  (Requirement 41.1). The Lambda client is created once and reused (Requirement 14.1); a lock
  makes concurrent first calls create it once.
- The client can be injected (`client=`) or built by an injected `client_factory`, so tests use
  a fake that only needs an `invoke(**kwargs)` method.
- Errors are classified by duck typing, never with `except botocore...`: an exception that has
  `.response["Error"]["Code"]` is a service error, anything else is judged by its class name.
  All of them are `unavailable`; the label only goes to the log so an operator can tell
  throttling from access denied (a closed set, see `REASONS`).
- `invoke` runs `invoke_sync` in a worker thread (`asyncio.to_thread`) and waits at most
  `remaining_ms` (Requirement 14.2). It does not start when no time is left. If the run is
  cancelled or times out, the awaiting coroutine returns at once and the thread is left to finish
  inside the function's own timeout; its answer is dropped (Requirements 14.7, 14.13). Because the
  coroutine returns at once, a caller's `finally` that releases its `AiLimiter` slot runs at once.
- The payload has exactly five keys (`PAYLOAD_KEYS`). `build_payload` makes it and
  `invoke_sync` refuses anything else, so nothing but those five reach the Lambda (Requirement
  14.12). Required and forbidden tokens come from the caller once per run, so they are the same on
  every attempt.
- The log (logger `lore.animation`, one JSON object per line) holds only the endpoint name, the
  attempt number, the outcome, a reason label, counts, the `tool` and `code` of Diagnostics and
  the milliseconds (Requirement 14.8). Never the source, tokens, a Diagnostic message, the
  response body or an exception's text. The logger is the shared `lore.animation` logger of
  `logging_.py` and the line is made by its `json_line`, the same function that writes the
  `animation.start`, `animation.attempt` and `animation.end` lines of a run, so the feature has
  one log format (design 6.15).

Calls follow the boto3 documentation as remembered while offline [belum diverifikasi against the
real botocore]: `client.invoke(FunctionName=..., InvocationType="RequestResponse",
Payload=<bytes>)` returns a dict with `StatusCode`, optional `FunctionError`, and `Payload`, a
`StreamingBody` whose `.read()` gives bytes. `Config(retries={"max_attempts": 2})` means up to
two retries after the first try in botocore's own wording, the value the spec fixes; the run's
deadline is what bounds the total time.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from collections.abc import Callable, Mapping
from contextlib import suppress
from dataclasses import dataclass
from typing import Any, Literal, Protocol, runtime_checkable

from pydantic import ValidationError

from app.ai.animation.logging_ import json_line, logger
from app.ai.animation.models import VerifierResult

# Name written in the log for this endpoint (Requirement 14.8).
ENDPOINT_NAME = "animations"
LOG_EVENT = "animation.verifier"

# Client settings fixed by Requirement 14.1. The read timeout is longer than the function's own
# 60 s timeout so a slow verifier answers with a `FunctionError` instead of a read timeout.
CONNECT_TIMEOUT_S = 5
READ_TIMEOUT_S = 75
RETRY_MODE = "standard"
RETRY_MAX_ATTEMPTS = 2

# The five keys of the Lambda payload, in the order the verifier documents them.
PAYLOAD_KEYS: tuple[str, ...] = (
    "source",
    "kind",
    "required_tokens",
    "forbidden_tokens",
    "contract_version",
)

# A result lists at most 50 Diagnostics (contract limit); the log keeps the first ten.
LOG_ITEMS_MAX = 10

OutcomeKind = Literal["result", "function_error", "unavailable", "timeout"]

# Closed set of reasons an `unavailable` outcome can carry; they go to the log, not the user.
REASONS: tuple[str, ...] = (
    "bad_payload",
    "client_unavailable",
    "throttled",
    "access_denied",
    "not_found",
    "service_error",
    "client_error",
    "network",
    "credentials",
    "config",
    "bad_response",
    "bad_status",
    "empty_payload",
    "not_json",
    "bad_shape",
    "error",
)

_THROTTLED_CODES = frozenset(
    {
        "TooManyRequestsException",
        "ThrottlingException",
        "Throttling",
        "EC2ThrottledException",
        "RequestLimitExceeded",
    }
)
_ACCESS_DENIED_CODES = frozenset(
    {
        "AccessDeniedException",
        "AccessDenied",
        "UnrecognizedClientException",
        "InvalidSignatureException",
        "ExpiredTokenException",
        "InvalidClientTokenId",
    }
)
_NOT_FOUND_CODES = frozenset({"ResourceNotFoundException"})
_SERVICE_ERROR_CODES = frozenset(
    {"ServiceException", "ServiceUnavailableException", "ServiceUnavailable", "InternalFailure"}
)
# Class-name hints for exceptions without a `.response`, checked in this order.
_NAME_HINTS: tuple[tuple[str, str], ...] = (
    ("Credential", "credentials"),
    ("NoRegion", "config"),
    ("Timeout", "network"),
    ("Connect", "network"),
    ("Endpoint", "network"),
    ("Stream", "network"),
    ("SSL", "network"),
)


@dataclass(frozen=True)
class LambdaOutcome:
    """What one invocation came to. `result` is set only for `kind == "result"`.

    `reason` is a label from `REASONS` for `unavailable` and is only meant for logs.
    """

    kind: OutcomeKind
    result: VerifierResult | None = None
    reason: str | None = None


@runtime_checkable
class VerifierPort(Protocol):
    """What the agent needs from a verifier; the real client and test doubles both fit.

    `attempt` is the number of the Gemini call being checked, used only for the log. A double
    that does not log may ignore it.
    """

    async def invoke(
        self, payload: dict[str, Any], *, remaining_ms: float, attempt: int = 1
    ) -> LambdaOutcome: ...


def build_payload(
    *,
    source: str,
    kind: str,
    required_tokens: list[str],
    forbidden_tokens: list[str],
    contract_version: int,
) -> dict[str, Any]:
    """The Lambda payload: exactly `PAYLOAD_KEYS`, with the token lists copied.

    Call it with the same token lists on every attempt of a run so the Lambda sees identical
    tokens each time (Requirement 14.12). `contract_version` is the Backend's own copy.
    """
    return {
        "source": source,
        "kind": kind,
        "required_tokens": list(required_tokens),
        "forbidden_tokens": list(forbidden_tokens),
        "contract_version": contract_version,
    }


def _default_client_factory(region: str) -> Any:
    """Build the boto3 Lambda client. The only place `boto3` and `botocore` are imported.

    The region is explicit because boto3 does not read `AWS_REGION` (only
    `AWS_DEFAULT_REGION`), so the value from SSM goes in through `Config(region_name=...)`.
    """
    if not region.strip():
        raise ValueError("a region is required")
    import boto3
    from botocore.config import Config

    config = Config(
        region_name=region,
        connect_timeout=CONNECT_TIMEOUT_S,
        read_timeout=READ_TIMEOUT_S,
        retries={"mode": RETRY_MODE, "max_attempts": RETRY_MAX_ATTEMPTS},
    )
    return boto3.client("lambda", config=config)


def _error_code(exc: Exception) -> str | None:
    """`exc.response["Error"]["Code"]` when the exception has that shape, else None."""
    response = getattr(exc, "response", None)
    if not isinstance(response, Mapping):
        return None
    error = response.get("Error")
    if not isinstance(error, Mapping):
        return None
    code = error.get("Code")
    return code if isinstance(code, str) else None


def reason_for_exception(exc: Exception) -> str:
    """A label from `REASONS` for an exception, from `.response` or the class name only."""
    code = _error_code(exc)
    if code is not None:
        if code in _THROTTLED_CODES:
            return "throttled"
        if code in _ACCESS_DENIED_CODES:
            return "access_denied"
        if code in _NOT_FOUND_CODES:
            return "not_found"
        if code in _SERVICE_ERROR_CODES:
            return "service_error"
        return "client_error"
    name = type(exc).__name__
    for needle, label in _NAME_HINTS:
        if needle in name:
            return label
    return "error"


def _unavailable(reason: str) -> LambdaOutcome:
    return LambdaOutcome("unavailable", reason=reason)


def _close(stream: object) -> None:
    close = getattr(stream, "close", None)
    if callable(close):
        with suppress(Exception):
            close()


def _classify_response(response: object) -> LambdaOutcome:
    """Turn the dict `invoke` returned into an outcome. Raises only what reading may raise."""
    if not isinstance(response, Mapping):
        return _unavailable("bad_response")
    stream = response.get("Payload")
    try:
        if response.get("FunctionError"):
            return LambdaOutcome("function_error")
        status = response.get("StatusCode")
        if status is not None and status != 200:
            return _unavailable("bad_status")
        read = getattr(stream, "read", None)
        if not callable(read):
            return _unavailable("bad_response")
        raw = read()
    finally:
        _close(stream)
    if not isinstance(raw, bytes | bytearray | str):
        return _unavailable("not_json")
    if not raw.strip():
        return _unavailable("empty_payload")
    try:
        data = json.loads(raw)
    except (ValueError, RecursionError):
        return _unavailable("not_json")
    try:
        return LambdaOutcome("result", result=VerifierResult.model_validate(data))
    except ValidationError:
        return _unavailable("bad_shape")


class LambdaVerifierClient:
    """Invokes the verifier Lambda and classifies the answer. Safe to share between runs.

    Construction does nothing but store settings. The boto3 client is made on the first call,
    in the worker thread, by `client_factory(region)` (default `_default_client_factory`), or
    taken from `client` when a test supplies one. `clock` measures milliseconds for the log.
    """

    def __init__(
        self,
        function_name: str,
        region: str,
        *,
        client: Any | None = None,
        client_factory: Callable[[str], Any] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._function_name = function_name
        self._region = region
        self._client = client
        self._factory = client_factory or _default_client_factory
        self._clock = clock
        self._lock = threading.Lock()

    def _get_client(self) -> Any:
        """The shared client, created at most once even when threads race to the first call."""
        with self._lock:
            if self._client is None:
                self._client = self._factory(self._region)
            return self._client

    def invoke_sync(self, payload: dict[str, Any], attempt: int = 1) -> LambdaOutcome:
        """Call the Lambda and classify the answer. Blocks, so use `invoke` from async code.

        Never raises. Logs one line with the outcome.
        """
        started = self._clock()
        outcome = self._call(payload)
        self._log(attempt, outcome, started)
        return outcome

    async def invoke(
        self, payload: dict[str, Any], *, remaining_ms: float, attempt: int = 1
    ) -> LambdaOutcome:
        """`invoke_sync` in a worker thread, waiting at most `remaining_ms`.

        Returns `timeout` without starting when no time is left. On timeout the thread is left to
        finish and its answer is dropped. Cancelling the caller returns at once and re-raises
        `CancelledError`; the thread is not waited for.
        """
        started = self._clock()
        if not remaining_ms > 0:  # also true for NaN
            outcome = LambdaOutcome("timeout")
            self._log(attempt, outcome, started)
            return outcome
        try:
            return await asyncio.wait_for(
                asyncio.to_thread(self.invoke_sync, payload, attempt), remaining_ms / 1000
            )
        except TimeoutError:
            outcome = LambdaOutcome("timeout")
            self._log(attempt, outcome, started)
            return outcome

    def _call(self, payload: dict[str, Any]) -> LambdaOutcome:
        if not isinstance(payload, Mapping) or set(payload) != set(PAYLOAD_KEYS):
            return _unavailable("bad_payload")
        try:
            # ASCII-only JSON: a lone surrogate in the source becomes an escape, never an error.
            body = json.dumps(payload, separators=(",", ":")).encode("ascii")
        except (TypeError, ValueError):
            return _unavailable("bad_payload")
        try:
            client = self._get_client()
        except Exception:
            return _unavailable("client_unavailable")
        try:
            response = client.invoke(
                FunctionName=self._function_name,
                InvocationType="RequestResponse",
                Payload=body,
            )
        except Exception as exc:
            return _unavailable(reason_for_exception(exc))
        try:
            return _classify_response(response)
        except Exception as exc:  # reading the response stream can fail too
            return _unavailable(reason_for_exception(exc))

    def _log(self, attempt: int, outcome: LambdaOutcome, started: float) -> None:
        fields: dict[str, Any] = {
            "event": LOG_EVENT,
            "endpoint": ENDPOINT_NAME,
            "attempt": attempt,
            "outcome": outcome.kind,
            "latency_ms": max(0, round((self._clock() - started) * 1000)),
        }
        if outcome.reason is not None:
            fields["reason"] = outcome.reason
        result = outcome.result
        if result is not None:
            errors = sum(1 for item in result.diagnostics if item.severity == "error")
            fields["ok"] = result.ok
            fields["error_count"] = errors
            fields["warning_count"] = len(result.diagnostics) - errors
            fields["items"] = [
                {"tool": item.tool, "code": item.code}
                for item in result.diagnostics[:LOG_ITEMS_MAX]
            ]
        level = logging.WARNING if outcome.kind == "unavailable" else logging.INFO
        logger.log(level, json_line(fields))
