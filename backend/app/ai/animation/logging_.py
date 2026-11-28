"""Structured logging for the animation feature: one JSON object per line, never user data.

Why: an operator must be able to follow an animation run (did it start, how many attempts, how it
ended, how long it took) without the log ever holding what the player or Gemini wrote (design 6.15,
Requirements 33.1, 33.11, 33.12, 32.4, 21.6, 13.16). The module keeps that promise by shape, not by
filtering:

- Every line is made by one function, `json_line(fields)`, and written to the logger
  `lore.animation` (`emit(level, fields)` does both). `verifier_client.py` uses the same
  `json_line` and the same logger for its `animation.verifier` line (Requirement 14.8), so the
  feature has one log format: a JSON object on one line, keys sorted, no spaces, `event` in every
  line.
- The three run events have fixed signatures. There is no `**extra` and no free-text argument, so
  a source, a prompt, a token, a key, a presigned URL or a Diagnostic message has no way in:

  | event               | fields                                                              |
  |---------------------|---------------------------------------------------------------------|
  | `animation.start`   | `kind`, `cached`                                                    |
  | `animation.attempt` | `attempt`, `outcome`, `error_count`, `warning_count`, `latency_ms`  |
  | `animation.end`     | `code`, `attempts`, `total_ms`, `model`, `cached`                   |

  Values are sanitised on the way in: `kind`, `outcome` and `code` must belong to a closed set
  (anything else is written as `unknown` or `UNKNOWN`), counts and milliseconds become whole
  numbers of 0 or more, and `model` must look like a model name (letters, digits and `._:/@+-`,
  at most 100 characters) or it is written as `unknown`. The model comes from the `AI_MODEL`
  setting, never from user input, so text that looks like a name is written as given. A bug in a
  caller therefore cannot turn into a leak of a source, a URL or a message. Exceptions are never
  logged with a traceback (no `exc_info`).
- `RunLog` holds the per-run rules of Requirement 33.11 so the agent and the endpoint cannot get
  them wrong: `animation.start` is the first line and `animation.end` the last one, each exactly
  once (a second call is ignored, and `end` writes the missing `start` first); no
  `animation.attempt` when the run is cached; `attempts` is 0 for a cached run (Idempotent_Hit).
  `attempts` is the number of Gemini_Calls started in this run, which is not the recorded
  `attempts` of the animation (G13); the caller passes the first one.
- `code` of `animation.end` is `OK` for a `done` event, one of the error codes of Requirement 13.11
  for an `error` event, and `CANCELLED` when the client left. `CANCELLED` is a log value only,
  not an error code.
- Logging never changes how a run ends: `RunLog` swallows an error raised while writing a line.

This module does not add handlers and does not set the level of `lore.animation`. Where INFO
lines go is decided by whoever starts the process: uvicorn only configures its own loggers, so
with no logging configuration the INFO lines of this feature would be dropped. The application
closes that gap at startup with `configure_animation_logging()` in `logconfig.py`, a separate
module so this one stays free of process-wide side effects (a test pins that it never adds a
handler).

`configure_boto_logging()` raises the level of `boto3`, `botocore`, `urllib3` and `s3transfer` to
`WARNING` (Requirements 32.15, 21.6): at DEBUG botocore logs request parameters and headers, and a
presigned URL or a payload could end up in the log. It sets the level by logger name only, so it
never imports `boto3` or `botocore`, and it never lowers a level that is already higher. The caller
runs it when the animation runtime is created, before the first AWS call. The level is set on the
logger itself (not left to the root logger), so a later `logging.getLogger().setLevel(DEBUG)` does
not undo it.

This module imports only the standard library and `app.ai.animation.models`.
"""

from __future__ import annotations

import json
import logging
import math
import re
import time
from collections.abc import Callable, Mapping
from contextlib import suppress
from typing import Any, get_args

from app.ai.animation.models import ERROR_CODES, Kind

LOGGER_NAME = "lore.animation"
logger = logging.getLogger(LOGGER_NAME)

EVENT_START = "animation.start"
EVENT_ATTEMPT = "animation.attempt"
EVENT_END = "animation.end"

KINDS: tuple[str, ...] = get_args(Kind)

# Requirement 33.12: the only values `animation.attempt.outcome` may take.
ATTEMPT_OUTCOMES: tuple[str, ...] = (
    "verified",
    "verify_failed",
    "extract_failed",
    "repair_unchanged",
    "gemini_failed",
)

# Requirement 33.12: `OK` for `done`, an error-event code for a failure, `CANCELLED` for a client
# that left (a log value only, never sent to a client).
END_OK = "OK"
END_CANCELLED = "CANCELLED"
END_CODES: tuple[str, ...] = (END_OK, END_CANCELLED, *ERROR_CODES)

# Loggers whose DEBUG output can carry request data (Requirement 32.15).
BOTO_LOGGERS: tuple[str, ...] = ("boto3", "botocore", "urllib3", "s3transfer")

_UNKNOWN_LABEL = "unknown"
_UNKNOWN_CODE = "UNKNOWN"
_MODEL_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}")


# -- the one line former ------------------------------------------------------------------------


def json_line(fields: Mapping[str, Any]) -> str:
    """The text of one log line: a JSON object with sorted keys and no spaces or newlines.

    Newlines inside a value are escaped by `json.dumps`, so one call is always one line.
    """
    return json.dumps(fields, sort_keys=True, separators=(",", ":"))


def emit(level: int, fields: Mapping[str, Any]) -> None:
    """Write `fields` as one JSON line to the `lore.animation` logger at `level`."""
    logger.log(level, json_line(fields))


# -- value sanitising ---------------------------------------------------------------------------


def _whole(value: object) -> int:
    """A whole number of 0 or more. Not a number, NaN, infinity, a bool or negative gives 0."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return 0
    if isinstance(value, float) and not math.isfinite(value):
        return 0
    return max(0, round(value))


def _choice(value: object, allowed: tuple[str, ...], fallback: str) -> str:
    return value if isinstance(value, str) and value in allowed else fallback


def _model(value: object) -> str | None:
    """`None` stays `None` (no Gemini_Call happened); a string must look like a model name."""
    if value is None:
        return None
    if isinstance(value, str) and _MODEL_NAME.fullmatch(value) is not None:
        return value
    return _UNKNOWN_LABEL


# -- one run ------------------------------------------------------------------------------------


class RunLog:
    """The log lines of one animation run, with the ordering rules of Requirement 33.11.

    `kind` and `cached` are fixed for the run. `clock` returns seconds (monotonic) and is
    injected by tests; `total_ms` is measured from `start()` to `end()`.

    Not thread-safe by design: one run is one asyncio task and calls these methods from the event
    loop, with no `await` between a check and the change it guards.
    """

    def __init__(
        self,
        kind: str,
        cached: bool,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._kind = _choice(kind, KINDS, _UNKNOWN_LABEL)
        self._cached = cached is True
        self._clock = clock
        self._started_at: float | None = None
        self._ended = False

    @property
    def started(self) -> bool:
        return self._started_at is not None

    @property
    def ended(self) -> bool:
        return self._ended

    def start(self) -> None:
        """Write `animation.start`. Ignored when the run already started or ended."""
        if self._started_at is not None or self._ended:
            return
        self._started_at = self._clock()
        self._write({"event": EVENT_START, "kind": self._kind, "cached": self._cached})

    def attempt(
        self,
        *,
        attempt: int,
        outcome: str,
        error_count: int,
        warning_count: int,
        latency_ms: float,
    ) -> None:
        """Write `animation.attempt` (after `start`, written first if missing).

        Not written for a cached run (nothing was attempted) or after the run ended.
        """
        if self._cached or self._ended:
            return
        self.start()
        self._write(
            {
                "event": EVENT_ATTEMPT,
                "attempt": _whole(attempt),
                "outcome": _choice(outcome, ATTEMPT_OUTCOMES, _UNKNOWN_LABEL),
                "error_count": _whole(error_count),
                "warning_count": _whole(warning_count),
                "latency_ms": _whole(latency_ms),
            }
        )

    def end(self, *, code: str, attempts: int, model: str | None) -> None:
        """Write `animation.end`, the last line of the run. A second call is ignored.

        `attempts` is the number of Gemini_Calls started in this run; a cached run always writes
        0. `model` is the model of the call that produced the published source, or `None`.
        """
        if self._ended:
            return
        self.start()
        started_at = self._started_at if self._started_at is not None else self._clock()
        total_ms = (self._clock() - started_at) * 1000
        self._ended = True
        self._write(
            {
                "event": EVENT_END,
                "code": _choice(code, END_CODES, _UNKNOWN_CODE),
                "attempts": 0 if self._cached else _whole(attempts),
                "total_ms": _whole(total_ms),
                "model": _model(model),
                "cached": self._cached,
            }
        )

    @staticmethod
    def _write(fields: Mapping[str, Any]) -> None:
        """INFO line; a failing log handler or filter must not change how the run ends."""
        with suppress(Exception):
            emit(logging.INFO, fields)


# -- third-party loggers ------------------------------------------------------------------------


def configure_boto_logging() -> None:
    """Keep `boto3`, `botocore`, `urllib3` and `s3transfer` at `WARNING` or higher.

    Safe to call many times. Imports nothing from AWS: the loggers are found by name.
    """
    for name in BOTO_LOGGERS:
        target = logging.getLogger(name)
        if target.level < logging.WARNING:  # NOTSET is 0, so an unset level is raised too
            target.setLevel(logging.WARNING)
