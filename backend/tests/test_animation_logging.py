"""Tests for the animation log (`app.ai.animation.logging_`).

Why: the log is how an operator follows an animation run, and it is the one place where a source, a
prompt, a token, a key, a presigned URL or a Diagnostic message could leak by accident (Requirements
33.1, 33.11, 33.12, 32.4, 32.15, 21.6, 13.16, design 6.15). These tests check:

- the three run events carry exactly the documented fields, as JSON on one line, at INFO;
- the ordering rules of Requirement 33.11: `animation.start` is the first line and `animation.end`
  the last one, each exactly once, no `animation.attempt` for a cached run, `attempts` 0 for an
  Idempotent_Hit;
- the closed sets of Requirement 33.12 and the clamping of every value, so a bug in a caller cannot
  put free text in a line;
- sentinel strings given to every parameter, and held by the run around the log calls, never reach
  the captured output (Requirement 32.4);
- the verifier client and `RunLog` share one logger and one line former (one format, not two);
- `configure_boto_logging()` keeps `boto3`, `botocore`, `urllib3` and `s3transfer` at `WARNING`
  even when the root logger is at `DEBUG`, and imports no AWS SDK (Requirements 32.15, 21.6, 41.1).

Everything runs against fakes: no boto3, no network, no Postgres. The complete agent run with
sentinels in the source and the prompt (Requirement 32.4) belongs to the agent tests, once the
agent exists; here the logger is driven the way the agent will drive it.
"""

from __future__ import annotations

import ast
import inspect
import json
import logging
import subprocess
import sys
import textwrap
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from app.ai.animation import logging_, verifier_client
from app.ai.animation.logging_ import (
    ATTEMPT_OUTCOMES,
    BOTO_LOGGERS,
    END_CODES,
    KINDS,
    RunLog,
    configure_boto_logging,
    emit,
    json_line,
)
from app.ai.animation.models import ERROR_CODES

BACKEND_DIR = Path(__file__).resolve().parent.parent
MODULE_PATH = BACKEND_DIR / "app" / "ai" / "animation" / "logging_.py"

MODEL = "gemini-3.5-flash-lite"

SOURCE_SENTINEL = "SOURCE-SENTINEL-1a2b"
PROMPT_SENTINEL = "PROMPT-SENTINEL-3c4d"
TOKEN_SENTINEL = "TOKEN-SENTINEL-5e6f"
KEY_SENTINEL = "KEY-SENTINEL-7a8b"
URL_SENTINEL = "URL-SENTINEL-9c0d"
MESSAGE_SENTINEL = "MESSAGE-SENTINEL-1e2f"
SENTINELS = (
    SOURCE_SENTINEL,
    PROMPT_SENTINEL,
    TOKEN_SENTINEL,
    KEY_SENTINEL,
    URL_SENTINEL,
    MESSAGE_SENTINEL,
)

START_FIELDS = {"event", "kind", "cached"}
ATTEMPT_FIELDS = {"event", "attempt", "outcome", "error_count", "warning_count", "latency_ms"}
END_FIELDS = {"event", "code", "attempts", "total_ms", "model", "cached"}


class Clock:
    """A settable monotonic clock in seconds."""

    def __init__(self, now: float = 0.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


def lines(caplog: pytest.LogCaptureFixture) -> list[dict[str, Any]]:
    """The parsed JSON lines written to `lore.animation`, in order."""
    return [
        json.loads(record.getMessage())
        for record in caplog.records
        if record.name == "lore.animation"
    ]


def events(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [line["event"] for line in lines(caplog)]


def attempt_line(log: RunLog, **override: Any) -> None:
    values: dict[str, Any] = {
        "attempt": 1,
        "outcome": "verified",
        "error_count": 0,
        "warning_count": 0,
        "latency_ms": 10,
    }
    log.attempt(**{**values, **override})


@pytest.fixture
def restore_levels() -> Iterator[None]:
    """Put the root logger and the AWS loggers back to their levels after a test."""
    names = ("", *BOTO_LOGGERS, *(f"{name}.child" for name in BOTO_LOGGERS))
    saved = {name: logging.getLogger(name).level for name in names}
    yield
    for name, level in saved.items():
        logging.getLogger(name).setLevel(level)


# --- the three run events --------------------------------------------------------------------


def test_a_run_writes_the_three_events_with_exactly_the_documented_fields(
    caplog: pytest.LogCaptureFixture,
) -> None:
    clock = Clock(10.0)
    log = RunLog("lesson", False, clock=clock)
    with caplog.at_level(logging.DEBUG):
        log.start()
        clock.now = 10.4
        log.attempt(
            attempt=1, outcome="verify_failed", error_count=2, warning_count=1, latency_ms=380
        )
        clock.now = 11.5
        log.attempt(attempt=2, outcome="verified", error_count=0, warning_count=1, latency_ms=410)
        clock.now = 12.346
        log.end(code="OK", attempts=2, model=MODEL)
    assert lines(caplog) == [
        {"event": "animation.start", "kind": "lesson", "cached": False},
        {
            "event": "animation.attempt",
            "attempt": 1,
            "outcome": "verify_failed",
            "error_count": 2,
            "warning_count": 1,
            "latency_ms": 380,
        },
        {
            "event": "animation.attempt",
            "attempt": 2,
            "outcome": "verified",
            "error_count": 0,
            "warning_count": 1,
            "latency_ms": 410,
        },
        {
            "event": "animation.end",
            "code": "OK",
            "attempts": 2,
            "total_ms": 2346,
            "model": MODEL,
            "cached": False,
        },
    ]
    for record in caplog.records:
        assert record.name == "lore.animation"
        assert record.levelno == logging.INFO
        assert record.exc_info is None


def test_every_line_is_one_canonical_json_object_with_an_event_key(
    caplog: pytest.LogCaptureFixture,
) -> None:
    log = RunLog("puzzle", False)
    with caplog.at_level(logging.DEBUG):
        log.start()
        attempt_line(log)
        log.end(code="ANIMATION_TIMEOUT", attempts=1, model=None)
    assert len(caplog.records) == 3
    for record in caplog.records:
        message = record.getMessage()
        assert "\n" not in message and "\r" not in message
        parsed = json.loads(message)
        assert isinstance(parsed["event"], str)
        assert message == json_line(parsed)  # sorted keys, compact separators
        assert message == json.dumps(parsed, sort_keys=True, separators=(",", ":"))


def test_the_fields_of_each_event_are_exactly_the_ones_in_requirement_33_1(
    caplog: pytest.LogCaptureFixture,
) -> None:
    log = RunLog("lesson", False)
    with caplog.at_level(logging.DEBUG):
        log.start()
        attempt_line(log)
        log.end(code="OK", attempts=1, model=MODEL)
    start, attempt, end = lines(caplog)
    assert set(start) == START_FIELDS
    assert set(attempt) == ATTEMPT_FIELDS
    assert set(end) == END_FIELDS


def test_latency_and_total_are_whole_numbers_of_zero_or_more(
    caplog: pytest.LogCaptureFixture,
) -> None:
    clock = Clock(5.0)
    log = RunLog("lesson", False, clock=clock)
    with caplog.at_level(logging.DEBUG):
        log.start()
        attempt_line(log, latency_ms=12.6)
        clock.now = 5.0123
        log.end(code="OK", attempts=1, model=MODEL)
    _, attempt, end = lines(caplog)
    assert attempt["latency_ms"] == 13 and type(attempt["latency_ms"]) is int
    assert end["total_ms"] == 12 and type(end["total_ms"]) is int


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (0, 0),
        (7, 7),
        (1000, 1000),
        (2345.6, 2346),
        (2.4, 2),
        (-3, 0),
        (-0.4, 0),
        (float("nan"), 0),
        (float("inf"), 0),
        (float("-inf"), 0),
        (True, 0),
        (False, 0),
        ("12", 0),
        (None, 0),
        ([3], 0),
    ],
)
def test_counts_and_milliseconds_are_clamped_to_whole_numbers(
    raw: Any, expected: int, caplog: pytest.LogCaptureFixture
) -> None:
    log = RunLog("lesson", False)
    with caplog.at_level(logging.DEBUG):
        log.attempt(
            attempt=raw, outcome="verified", error_count=raw, warning_count=raw, latency_ms=raw
        )
        log.end(code="OK", attempts=raw, model=MODEL)
    _, attempt, end = lines(caplog)
    assert attempt["attempt"] == attempt["error_count"] == expected
    assert attempt["warning_count"] == attempt["latency_ms"] == expected
    assert end["attempts"] == expected


def test_a_clock_that_goes_backwards_never_gives_a_negative_total(
    caplog: pytest.LogCaptureFixture,
) -> None:
    clock = Clock(100.0)
    log = RunLog("lesson", False, clock=clock)
    with caplog.at_level(logging.DEBUG):
        log.start()
        clock.now = 99.0
        log.end(code="OK", attempts=1, model=MODEL)
        clock.now = float("nan")
        other = RunLog("lesson", False, clock=clock)
        other.end(code="OK", attempts=1, model=MODEL)
    totals = [line["total_ms"] for line in lines(caplog) if line["event"] == "animation.end"]
    assert totals == [0, 0]


# --- ordering rules of Requirement 33.11 -----------------------------------------------------


def test_start_is_the_first_line_and_end_the_last_one_each_exactly_once(
    caplog: pytest.LogCaptureFixture,
) -> None:
    log = RunLog("puzzle", False)
    with caplog.at_level(logging.DEBUG):
        log.start()
        log.start()
        attempt_line(log)
        log.end(code="ANIMATION_TIMEOUT", attempts=1, model=MODEL)
        log.end(code="OK", attempts=3, model="other-model")
        attempt_line(log)  # after the end
        log.start()  # after the end
    assert events(caplog) == ["animation.start", "animation.attempt", "animation.end"]
    assert lines(caplog)[-1]["code"] == "ANIMATION_TIMEOUT"
    assert lines(caplog)[-1]["model"] == MODEL
    assert log.started and log.ended


def test_end_without_a_start_writes_the_missing_start_first(
    caplog: pytest.LogCaptureFixture,
) -> None:
    log = RunLog("lesson", False, clock=Clock(3.0))
    with caplog.at_level(logging.DEBUG):
        log.end(code="CANCELLED", attempts=0, model=None)
    first, last = lines(caplog)
    assert first == {"event": "animation.start", "kind": "lesson", "cached": False}
    assert last == {
        "event": "animation.end",
        "code": "CANCELLED",
        "attempts": 0,
        "total_ms": 0,
        "model": None,
        "cached": False,
    }


def test_an_attempt_before_the_start_writes_the_start_first(
    caplog: pytest.LogCaptureFixture,
) -> None:
    log = RunLog("lesson", False)
    with caplog.at_level(logging.DEBUG):
        attempt_line(log)
    assert events(caplog) == ["animation.start", "animation.attempt"]


def test_a_new_run_log_has_not_started_and_has_not_ended() -> None:
    log = RunLog("lesson", False)
    assert not log.started and not log.ended


def test_a_cached_run_writes_start_and_end_but_no_attempt_and_attempts_is_zero(
    caplog: pytest.LogCaptureFixture,
) -> None:
    log = RunLog("lesson", True)
    with caplog.at_level(logging.DEBUG):
        log.start()
        attempt_line(log, outcome="verified")  # must be ignored
        log.end(code="OK", attempts=3, model=MODEL)  # even if the caller passes 3
    start, end = lines(caplog)
    assert start == {"event": "animation.start", "kind": "lesson", "cached": True}
    assert end["event"] == "animation.end"
    assert end["attempts"] == 0
    assert end["cached"] is True
    assert end["code"] == "OK"


def test_a_cached_run_that_is_cancelled_still_writes_start_and_end(
    caplog: pytest.LogCaptureFixture,
) -> None:
    log = RunLog("puzzle", True)
    with caplog.at_level(logging.DEBUG):
        log.end(code="CANCELLED", attempts=0, model=None)
    assert events(caplog) == ["animation.start", "animation.end"]


def test_cached_is_true_only_for_the_boolean_true(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.DEBUG):
        for raw in (1, "yes", None, [True]):
            RunLog("lesson", raw).start()  # type: ignore[arg-type]
    assert [line["cached"] for line in lines(caplog)] == [False, False, False, False]


def test_each_run_log_keeps_its_own_state(caplog: pytest.LogCaptureFixture) -> None:
    first, second = RunLog("lesson", False), RunLog("puzzle", True)
    with caplog.at_level(logging.DEBUG):
        first.start()
        second.start()
        first.end(code="OK", attempts=1, model=MODEL)
    assert [line["event"] for line in lines(caplog)] == [
        "animation.start",
        "animation.start",
        "animation.end",
    ]
    assert first.ended and not second.ended


# --- closed sets of Requirement 33.12 --------------------------------------------------------


def test_the_closed_sets_are_the_ones_the_requirements_name() -> None:
    assert ATTEMPT_OUTCOMES == (
        "verified",
        "verify_failed",
        "extract_failed",
        "repair_unchanged",
        "gemini_failed",
    )
    assert set(KINDS) == {"lesson", "puzzle"}
    assert set(END_CODES) == {
        "OK",
        "CANCELLED",
        "ANIMATION_VERIFICATION_FAILED",
        "ANIMATION_TIMEOUT",
        "ANIMATION_VERIFIER_UNAVAILABLE",
        "ANIMATION_STORAGE_FAILED",
        "ANIMATION_QUOTA_EXCEEDED",
        "PROVIDER_UNAVAILABLE",
        "RATE_LIMITED",
        "UNKNOWN",
    }
    assert set(ERROR_CODES) <= set(END_CODES)
    assert "CANCELLED" not in ERROR_CODES  # a log value, never an error code


@pytest.mark.parametrize("outcome", ATTEMPT_OUTCOMES)
def test_each_attempt_outcome_is_written_as_given(
    outcome: str, caplog: pytest.LogCaptureFixture
) -> None:
    log = RunLog("lesson", False)
    with caplog.at_level(logging.DEBUG):
        attempt_line(log, outcome=outcome)
    assert lines(caplog)[1]["outcome"] == outcome


@pytest.mark.parametrize(
    "outcome", ["", "VERIFIED", "ok", SOURCE_SENTINEL, "verified ", None, 3, ["verified"]]
)
def test_an_attempt_outcome_outside_the_set_is_written_as_unknown(
    outcome: Any, caplog: pytest.LogCaptureFixture
) -> None:
    log = RunLog("lesson", False)
    with caplog.at_level(logging.DEBUG):
        attempt_line(log, outcome=outcome)
    assert lines(caplog)[1]["outcome"] == "unknown"


@pytest.mark.parametrize("code", END_CODES)
def test_each_end_code_is_written_as_given(code: str, caplog: pytest.LogCaptureFixture) -> None:
    log = RunLog("lesson", False)
    with caplog.at_level(logging.DEBUG):
        log.end(code=code, attempts=1, model=MODEL)
    assert lines(caplog)[-1]["code"] == code


@pytest.mark.parametrize(
    "code",
    ["", "ok", "done", "ANIMATION_NOT_CONFIGURED", "INVALID_REQUEST", URL_SENTINEL, None, 500],
)
def test_an_end_code_outside_the_set_is_written_as_unknown(
    code: Any, caplog: pytest.LogCaptureFixture
) -> None:
    log = RunLog("lesson", False)
    with caplog.at_level(logging.DEBUG):
        log.end(code=code, attempts=1, model=MODEL)
    assert lines(caplog)[-1]["code"] == "UNKNOWN"


@pytest.mark.parametrize("kind", ["lesson", "puzzle"])
def test_each_kind_is_written_as_given(kind: str, caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.DEBUG):
        RunLog(kind, False).start()
    assert lines(caplog)[0]["kind"] == kind


@pytest.mark.parametrize("kind", ["", "Lesson", "visual", PROMPT_SENTINEL, None, 2])
def test_a_kind_outside_the_set_is_written_as_unknown(
    kind: Any, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.DEBUG):
        RunLog(kind, False).start()
    assert lines(caplog)[0]["kind"] == "unknown"


@pytest.mark.parametrize(
    "model",
    [
        "gemini-3.5-flash-lite",
        "models/gemini-3.5-flash",
        "gemini-3.5:flash@v1+x",
        "a",
        "a" * 100,
    ],
)
def test_a_model_name_is_written_as_given(model: str, caplog: pytest.LogCaptureFixture) -> None:
    log = RunLog("lesson", False)
    with caplog.at_level(logging.DEBUG):
        log.end(code="OK", attempts=1, model=model)
    assert lines(caplog)[-1]["model"] == model


@pytest.mark.parametrize(
    "model",
    [
        "",
        "a" * 101,
        "has space",
        "line\nbreak",
        "name\n",
        "-leading-dash",
        "const secret = 'x';",
        f"https://bucket.s3.amazonaws.com/main.js?X-Amz-Signature={URL_SENTINEL}",
        f"{SOURCE_SENTINEL} {PROMPT_SENTINEL}",
        42,
        ["gemini"],
    ],
)
def test_a_model_that_does_not_look_like_a_model_name_is_written_as_unknown(
    model: Any, caplog: pytest.LogCaptureFixture
) -> None:
    log = RunLog("lesson", False)
    with caplog.at_level(logging.DEBUG):
        log.end(code="OK", attempts=1, model=model)
    assert lines(caplog)[-1]["model"] == "unknown"


def test_a_missing_model_is_written_as_null(caplog: pytest.LogCaptureFixture) -> None:
    log = RunLog("lesson", False)
    with caplog.at_level(logging.DEBUG):
        log.end(code="PROVIDER_UNAVAILABLE", attempts=1, model=None)
    assert lines(caplog)[-1]["model"] is None


# --- nothing but the allowed fields can get in -----------------------------------------------


def test_the_run_log_methods_take_only_fixed_keyword_parameters() -> None:
    """No `**extra` and no free-text slot: the signature is the allowlist."""
    expected = {
        "attempt": {"attempt", "outcome", "error_count", "warning_count", "latency_ms"},
        "end": {"code", "attempts", "model"},
        "start": set(),
    }
    for name, parameters in expected.items():
        signature = inspect.signature(getattr(RunLog, name))
        kinds = {p.kind for p in signature.parameters.values() if p.name != "self"}
        assert inspect.Parameter.VAR_KEYWORD not in kinds, name
        assert inspect.Parameter.VAR_POSITIONAL not in kinds, name
        assert {p for p in signature.parameters if p != "self"} == parameters, name
        for param in signature.parameters.values():
            if param.name != "self":
                assert param.kind is inspect.Parameter.KEYWORD_ONLY, (name, param.name)
    init = inspect.signature(RunLog.__init__).parameters
    assert [name for name in init if name != "self"] == ["kind", "cached", "clock"]


def test_sentinels_in_every_parameter_and_around_the_run_never_reach_the_log(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Success, failure, cancellation and a run fed only with sentinels (Requirement 32.4)."""
    # What a real run holds in memory while it logs. None of it is passed to the log.
    held = {
        "source": f"export default function Main() {{ return '{SOURCE_SENTINEL}'; }}",
        "prompt": f"Write an animation about {PROMPT_SENTINEL}",
        "required_tokens": [TOKEN_SENTINEL],
        "api_key": KEY_SENTINEL,
        "presigned_url": f"https://b.s3.ap-southeast-3.amazonaws.com/x?sig={URL_SENTINEL}",
        "diagnostic_message": MESSAGE_SENTINEL,
    }
    assert held  # kept alive for the duration of the test on purpose

    with caplog.at_level(logging.DEBUG):
        ok = RunLog("lesson", False)
        ok.start()
        attempt_line(ok, outcome="verify_failed", error_count=1)
        attempt_line(ok, attempt=2, outcome="verified")
        ok.end(code="OK", attempts=2, model=MODEL)

        failed = RunLog("puzzle", False)
        failed.start()
        attempt_line(failed, outcome="gemini_failed")
        failed.end(code="PROVIDER_UNAVAILABLE", attempts=1, model=None)

        cancelled = RunLog("lesson", False)
        cancelled.start()
        cancelled.end(code="CANCELLED", attempts=0, model=None)

        hostile = RunLog(SOURCE_SENTINEL, True)  # type: ignore[arg-type]
        hostile.start()
        # `model` is the one string that is written as given when it looks like a model name (it
        # comes from the AI_MODEL setting, never from user input), so the hostile value here is
        # one that does not look like a name: a presigned URL.
        hostile.end(
            code=PROMPT_SENTINEL,
            attempts=TOKEN_SENTINEL,  # type: ignore[arg-type]
            model=f"https://b.s3.amazonaws.com/main.js?X-Amz-Signature={URL_SENTINEL}",
        )
        hostile_attempt = RunLog(KEY_SENTINEL, False)  # type: ignore[arg-type]
        hostile_attempt.attempt(
            attempt=MESSAGE_SENTINEL,  # type: ignore[arg-type]
            outcome=SOURCE_SENTINEL,
            error_count=PROMPT_SENTINEL,  # type: ignore[arg-type]
            warning_count=TOKEN_SENTINEL,  # type: ignore[arg-type]
            latency_ms=KEY_SENTINEL,  # type: ignore[arg-type]
        )
        hostile_attempt.end(
            code=MESSAGE_SENTINEL,
            attempts=URL_SENTINEL,  # type: ignore[arg-type]
            model=f"{SOURCE_SENTINEL} {KEY_SENTINEL}",
        )

    assert caplog.records
    for record in caplog.records:
        assert record.exc_info is None
        assert record.args in (None, ())
        for sentinel in SENTINELS:
            assert sentinel not in record.getMessage()
            assert sentinel not in record.name
    for sentinel in SENTINELS:
        assert sentinel not in caplog.text
    # The hostile runs still produced well formed lines made only of safe values.
    for line in lines(caplog):
        assert set(line) in (START_FIELDS, ATTEMPT_FIELDS, END_FIELDS)


def test_a_failing_log_handler_does_not_change_how_a_run_ends(
    caplog: pytest.LogCaptureFixture,
) -> None:
    class Exploding(logging.Filter):
        def filter(self, record: logging.LogRecord) -> bool:
            raise RuntimeError("the log is broken")

    log = RunLog("lesson", False)
    broken = Exploding()
    logging_.logger.addFilter(broken)
    try:
        log.start()
        attempt_line(log)
        log.end(code="OK", attempts=1, model=MODEL)
    finally:
        logging_.logger.removeFilter(broken)
    assert log.started and log.ended
    with caplog.at_level(logging.DEBUG):
        log.end(code="OK", attempts=1, model=MODEL)  # still one end only
    assert lines(caplog) == []


# --- one logger, one line former -------------------------------------------------------------


def test_json_line_is_compact_sorted_and_always_one_line() -> None:
    assert json_line({"b": 1, "a": "x"}) == '{"a":"x","b":1}'
    text = json_line({"event": "e", "note": "two\nlines\r\nand \u2028 more"})
    assert "\n" not in text and "\r" not in text
    assert json.loads(text)["note"] == "two\nlines\r\nand \u2028 more"


def test_emit_writes_to_the_animation_logger_at_the_given_level(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.DEBUG):
        emit(logging.WARNING, {"event": "x.y", "n": 1})
    (record,) = caplog.records
    assert record.name == "lore.animation" == logging_.LOGGER_NAME
    assert record.levelno == logging.WARNING
    assert record.getMessage() == '{"event":"x.y","n":1}'


class _Stream:
    def __init__(self, body: bytes) -> None:
        self._body = body

    def read(self) -> bytes:
        return self._body

    def close(self) -> None:
        return None


class _Lambda:
    """The one method of the boto3 Lambda client that the verifier client calls."""

    def invoke(self, **_: Any) -> dict[str, Any]:
        result = {
            "ok": False,
            "diagnostics": [
                {
                    "tool": "policy",
                    "code": "POLICY_FORBIDDEN_IDENTIFIER",
                    "severity": "error",
                    "line": 3,
                    "message": MESSAGE_SENTINEL,
                }
            ],
            "summary": {
                "verifier_version": "0.1.0",
                "contract_version": 1,
                "runtime_version": {"react": "19.3.0", "remotion": "4.0.543"},
                "checks": [{"name": "policy", "ok": False, "ms": 3}],
                "truncated": False,
            },
        }
        return {"StatusCode": 200, "Payload": _Stream(json.dumps(result).encode("utf-8"))}


def test_the_verifier_client_and_the_run_log_share_one_logger_and_one_line_former(
    caplog: pytest.LogCaptureFixture,
) -> None:
    assert verifier_client.logger is logging_.logger
    assert verifier_client.json_line is logging_.json_line
    assert verifier_client.logger.name == "lore.animation"

    client = verifier_client.LambdaVerifierClient("fn", "ap-southeast-3", client=_Lambda())
    payload = verifier_client.build_payload(
        source=f"// {SOURCE_SENTINEL}",
        kind="lesson",
        required_tokens=[TOKEN_SENTINEL],
        forbidden_tokens=[],
        contract_version=1,
    )
    log = RunLog("lesson", False)
    with caplog.at_level(logging.DEBUG):
        log.start()
        outcome = client.invoke_sync(payload, 1)
        log.attempt(
            attempt=1, outcome="verify_failed", error_count=1, warning_count=0, latency_ms=5
        )
        log.end(code="ANIMATION_VERIFICATION_FAILED", attempts=1, model=MODEL)
    assert outcome.kind == "result"
    assert events(caplog) == [
        "animation.start",
        "animation.verifier",
        "animation.attempt",
        "animation.end",
    ]
    for record in caplog.records:
        message = record.getMessage()
        assert record.name == "lore.animation"
        assert "\n" not in message
        assert message == json_line(json.loads(message))  # the same canonical form for all four
    for sentinel in (SOURCE_SENTINEL, TOKEN_SENTINEL, MESSAGE_SENTINEL):
        assert sentinel not in caplog.text


# --- configure_boto_logging ------------------------------------------------------------------


def test_the_loggers_to_quiet_are_the_four_aws_ones() -> None:
    assert BOTO_LOGGERS == ("boto3", "botocore", "urllib3", "s3transfer")


@pytest.mark.parametrize("name", BOTO_LOGGERS)
def test_the_aws_loggers_stay_at_warning_when_the_root_logger_is_at_debug(
    name: str, caplog: pytest.LogCaptureFixture, restore_levels: None
) -> None:
    root = logging.getLogger()
    target = logging.getLogger(name)
    child = logging.getLogger(f"{name}.child")
    root.setLevel(logging.DEBUG)
    target.setLevel(logging.NOTSET)
    child.setLevel(logging.NOTSET)
    assert target.getEffectiveLevel() == logging.DEBUG  # the problem, before the fix

    configure_boto_logging()

    assert target.getEffectiveLevel() >= logging.WARNING
    assert child.getEffectiveLevel() >= logging.WARNING
    with caplog.at_level(logging.DEBUG):  # the root goes (back) to DEBUG, the logger must hold
        assert target.getEffectiveLevel() >= logging.WARNING
        assert not target.isEnabledFor(logging.DEBUG)
        assert not child.isEnabledFor(logging.INFO)
        target.debug("request parameters %s", URL_SENTINEL)
        child.info("headers %s", URL_SENTINEL)
        assert not caplog.records
        target.warning("kept")
    assert [r.getMessage() for r in caplog.records] == ["kept"]


def test_botocore_and_boto3_are_at_warning_or_higher_even_with_the_root_at_debug(
    restore_levels: None,
) -> None:
    """Requirement 32.15, worded as the requirement words it."""
    logging.getLogger().setLevel(logging.DEBUG)
    for name in ("boto3", "botocore"):
        logging.getLogger(name).setLevel(logging.DEBUG)
    configure_boto_logging()
    for name in ("boto3", "botocore"):
        assert logging.getLogger(name).getEffectiveLevel() >= logging.WARNING


def test_a_level_that_is_already_higher_is_kept_and_a_lower_one_is_raised(
    restore_levels: None,
) -> None:
    logging.getLogger("botocore").setLevel(logging.ERROR)
    logging.getLogger("boto3").setLevel(logging.DEBUG)
    logging.getLogger("urllib3").setLevel(logging.INFO)
    logging.getLogger("s3transfer").setLevel(logging.CRITICAL)
    configure_boto_logging()
    assert logging.getLogger("botocore").level == logging.ERROR
    assert logging.getLogger("boto3").level == logging.WARNING
    assert logging.getLogger("urllib3").level == logging.WARNING
    assert logging.getLogger("s3transfer").level == logging.CRITICAL


def test_configure_boto_logging_can_run_many_times(restore_levels: None) -> None:
    logging.getLogger().setLevel(logging.DEBUG)
    for name in BOTO_LOGGERS:
        logging.getLogger(name).setLevel(logging.NOTSET)
    configure_boto_logging()
    after_first = {name: logging.getLogger(name).level for name in BOTO_LOGGERS}
    configure_boto_logging()
    configure_boto_logging()
    assert {name: logging.getLogger(name).level for name in BOTO_LOGGERS} == after_first
    assert set(after_first.values()) == {logging.WARNING}


def test_configure_boto_logging_does_not_touch_the_animation_logger_or_the_root(
    restore_levels: None,
) -> None:
    logging.getLogger().setLevel(logging.DEBUG)
    before = logging_.logger.level
    handlers = list(logging.getLogger().handlers)
    configure_boto_logging()
    assert logging.getLogger().level == logging.DEBUG
    assert logging_.logger.level == before
    assert logging.getLogger().handlers == handlers
    assert logging_.logger.handlers == []


# --- no SDK, no side effects -----------------------------------------------------------------


def _imported_roots(tree: ast.AST) -> set[str]:
    roots: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            roots.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            roots.add((node.module or "").split(".")[0])
    return roots


def test_the_module_imports_no_aws_sdk_and_no_langgraph() -> None:
    tree = ast.parse(MODULE_PATH.read_text(encoding="utf-8"))
    assert not _imported_roots(tree) & {
        "boto3",
        "botocore",
        "urllib3",
        "s3transfer",
        "langgraph",
        "httpx2",
        "sqlalchemy",
    }
    from_app = [
        node.module
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom) and (node.module or "").startswith("app")
    ]
    assert from_app == ["app.ai.animation.models"]


def test_importing_the_module_and_configuring_the_loggers_loads_no_sdk() -> None:
    """Fresh interpreter with a blocker: any attempt to import an SDK fails the run."""
    code = textwrap.dedent(
        """
        import logging
        import sys

        BLOCKED = ("boto3", "botocore", "urllib3", "s3transfer", "langgraph")

        class Blocker:
            def find_spec(self, name, path=None, target=None):
                if name.split(".")[0] in BLOCKED:
                    raise AssertionError("imported " + name)
                return None

        sys.meta_path.insert(0, Blocker())
        logging.getLogger().setLevel(logging.DEBUG)
        from app.ai.animation import logging_

        logging_.configure_boto_logging()
        run = logging_.RunLog("lesson", False)
        run.start()
        run.end(code="OK", attempts=1, model="gemini-3.5-flash-lite")
        loaded = [name for name in BLOCKED if name in sys.modules]
        assert not loaded, loaded
        assert logging.getLogger("botocore").getEffectiveLevel() >= logging.WARNING
        assert logging.getLogger("boto3").getEffectiveLevel() >= logging.WARNING
        """
    )
    done = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, cwd=BACKEND_DIR, check=False
    )
    assert done.returncode == 0, done.stderr


def test_the_module_never_adds_handlers_prints_or_logs_a_traceback() -> None:
    tree = ast.parse(MODULE_PATH.read_text(encoding="utf-8"))
    attributes = {node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute)}
    names = {node.id for node in ast.walk(tree) if isinstance(node, ast.Name)}
    keywords = {
        keyword.arg
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        for keyword in node.keywords
    }
    assert not attributes & {"addHandler", "basicConfig", "exception", "exc_info", "environ"}
    assert "print" not in names
    assert "exc_info" not in keywords and "stack_info" not in keywords
    assert "extra" not in keywords


def test_the_module_starts_with_a_docstring_and_the_future_import() -> None:
    tree = ast.parse(MODULE_PATH.read_text(encoding="utf-8"))
    first, second = tree.body[0], tree.body[1]
    assert isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant)
    assert isinstance(first.value.value, str) and len(first.value.value) > 200
    assert isinstance(second, ast.ImportFrom) and second.module == "__future__"
