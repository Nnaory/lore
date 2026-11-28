"""Tests for `app/ai/animation/sse.py`: wire format, slot lease, run handle, stream, response.

Why: the stream is the only way the browser learns how an animation run is going, and it holds a
concurrency slot for up to four minutes, so its rules are pinned here without Gemini, AWS or a
database (task 18.1; Requirements 17.1 to 17.8, 17.10, 17.12 to 17.14, 15.7):

1. the wire format of every event, byte for byte, and its 8192-byte cap;
2. the shared fixture `fixtures/animation/sse-stream.txt` (also read by Vitest): a small reference
   reader (`animation_sse_support.py`) parses it, every event is rebuilt as a model and written
   again by `sse.py`, and a run that tells the same story writes the same bytes (the fixture is
   CRLF in places on purpose, so the comparison is on the LF form; the fixture is never changed);
3. `started` first and exactly one final event last, nothing after it, `: ping` on an injected
   clock, and nothing that could hold source code, a prompt or a Diagnostic message;
4. the slot: given back exactly once on every way a stream can end, including a generator that is
   never iterated and a client that leaves while the agent runs;
5. one run of the real agent through `RunHandle`, with the fakes of `animation_agent_support.py`.

Streams are driven by hand (`anext`) where timing matters, with `Clock` as the injected clock.
"""

from __future__ import annotations

import ast
import asyncio
import dataclasses
import json
import logging
import threading
import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import ClientDisconnect

import app.ai.animation.sse as sse
from app.ai.animation.agent import AgentFailed, AgentPublished, AgentResult, run_agent
from app.ai.animation.logging_ import RunLog
from app.ai.animation.models import (
    ERROR_CODES,
    AnimationRow,
    Diagnostic,
    DiagnosticItem,
    DiagnosticsEvent,
    DoneEvent,
    ErrorEvent,
    SseEvent,
    StageEvent,
    StartedEvent,
    reference_from_row,
)
from app.ai.animation.sse import (
    ERROR_MESSAGES,
    MAX_EVENT_BYTES,
    PING,
    PING_INTERVAL_S,
    AnimationStreamResponse,
    RunHandle,
    SlotLease,
    encode,
    format_event,
    stream,
)
from app.ai.envelope import INTERNAL_ERROR_MESSAGE
from app.ai.limits import AiLimiter, AiLimits
from tests.animation_agent_support import (
    Clock,
    animation_log_lines,
    fenced,
    make_rig,
    rejected,
    source,
    verified,
)
from tests.animation_sse_support import FIXTURE, RawEvent, parse_stream, read_fixture

IP = "203.0.113.7"
SENTINEL = "SECRET-SENTINEL-4f9a"

STARTED = StartedEvent(max_attempts=4, deadline_ms=240000, cached=False)
CACHED_STARTED = StartedEvent(max_attempts=4, deadline_ms=240000, cached=True)

# The `done` event of the shared fixture: its animation, as registry columns.
FIXTURE_ROW = AnimationRow(
    id="3f8e2b1c-6d4a-4e5f-9a7b-0c1d2e3f4a5b",
    owner_id=uuid.UUID("11111111-2222-4333-8444-555555555555"),
    request_hash="c" * 64,
    source_sha256="a27321c1c0f1407c835394676fb809e185474ec0c0ce213e0c7cffedfa857750",
    bundle_sha256="9aecee4acec55281859c57184dec790783d3c59b71aaf923de28e1d8b0dc9b73",
    s3_prefix=(
        "animations/v1/a2/a27321c1c0f1407c835394676fb809e185474ec0c0ce213e0c7cffedfa857750/"
    ),
    kind="lesson",
    meta={"width": 1280, "height": 720, "fps": 30, "durationInFrames": 150},
    attempts=2,
    model="fake-model",
    verifier_version="0.1.0",
    contract_version=1,
    runtime_version={"react": "19.3.0", "remotion": "4.0.543"},
    source_bytes=120,
    bundle_bytes=240,
    created_at=1_700_000_000_000,
)


# --- helpers ----------------------------------------------------------------------------------


def published(row: AnimationRow = FIXTURE_ROW, *, calls: int = 2) -> AgentPublished:
    return AgentPublished(reference=reference_from_row(row), row=row, calls=calls, model=row.model)


def make_limiter(**overrides: int) -> AiLimiter:
    values = {
        "per_minute_ip": 100,
        "per_minute_owner": 100,
        "daily_per_ip": 100,
        "max_concurrent_per_ip": 5,
        "max_concurrent_global": 5,
    }
    values.update(overrides)
    return AiLimiter(AiLimits(**values))


class CountingLimiter(AiLimiter):
    """An `AiLimiter` that counts how often a slot is acquired and given back."""

    def __init__(self) -> None:
        super().__init__(
            AiLimits(
                per_minute_ip=100,
                per_minute_owner=100,
                daily_per_ip=100,
                max_concurrent_per_ip=5,
                max_concurrent_global=5,
            )
        )
        self.acquired = 0
        self.released = 0

    def try_acquire(self, ip: str) -> Any:
        denied = super().try_acquire(ip)
        if denied is None:
            self.acquired += 1
        return denied

    def release(self, ip: str) -> None:
        self.released += 1
        super().release(ip)


def leased(limiter: AiLimiter, ip: str = IP) -> SlotLease:
    """Take one slot and wrap it, the way the endpoint does."""
    assert limiter.try_acquire(ip) is None
    return SlotLease(limiter, ip)


def handle_for(
    work: Callable[[], Awaitable[AgentResult]],
    *,
    started: StartedEvent = STARTED,
    lease: SlotLease | None = None,
    log: RunLog | None = None,
) -> RunHandle:
    return RunHandle(started=started, work=work, lease=lease, log=log)


def instant(result: AgentResult) -> Callable[[], Awaitable[AgentResult]]:
    async def work() -> AgentResult:
        return result

    return work


async def collect(handle: RunHandle, **options: Any) -> bytes:
    """Everything the stream writes for `handle`, joined."""
    return b"".join([chunk async for chunk in stream(handle, **options)])


def names(raw: bytes) -> list[str]:
    return [event.event for event in parse_stream(raw)]


def payloads(raw: bytes) -> list[dict[str, Any]]:
    return [json.loads(event.data) for event in parse_stream(raw)]


def stage(name: str, attempt: int = 1) -> StageEvent:
    return StageEvent(stage=name, attempt=attempt)  # type: ignore[arg-type]


def fixture_item(tool: str, code: str, line: int) -> DiagnosticItem:
    """A diagnostics item built through the real `DiagnosticItem` validators.

    The shared fixture uses real verifier codes (`TSC_2322`, `POLICY_IMPORT_DISALLOWED`), so a
    code that the contract would reject makes this helper, and the byte comparison, fail.
    """
    return DiagnosticItem(tool=tool, code=code, line=line)


def lf(raw: bytes) -> bytes:
    """The fixture in LF form. It has no bare CR, which is asserted where it matters."""
    return raw.replace(b"\r\n", b"\n")


async def settle(rounds: int = 5) -> None:
    for _ in range(rounds):
        await asyncio.sleep(0)


# --- the wire format --------------------------------------------------------------------------


def test_encode_writes_event_then_one_line_of_json_then_a_blank_line() -> None:
    assert encode(STARTED) == (
        b'event: started\ndata: {"max_attempts":4,"deadline_ms":240000,"cached":false}\n\n'
    )
    assert encode(stage("verifying", 2)) == (
        b'event: stage\ndata: {"stage":"verifying","attempt":2}\n\n'
    )
    diagnostics = DiagnosticsEvent(
        attempt=1,
        ok=False,
        error_count=3,
        warning_count=1,
        items=[
            DiagnosticItem(tool="policy", code="POLICY_COLOR_LITERAL", line=41),
            DiagnosticItem(tool="agent", code="AGENT_REPAIR_UNCHANGED"),
        ],
    )
    assert encode(diagnostics) == (
        b'event: diagnostics\ndata: {"attempt":1,"ok":false,"error_count":3,"warning_count":1,'
        b'"items":[{"tool":"policy","code":"POLICY_COLOR_LITERAL","line":41},'
        b'{"tool":"agent","code":"AGENT_REPAIR_UNCHANGED"}]}\n\n'
    )
    error = ErrorEvent(code="ANIMATION_TIMEOUT", message="It took too long.", attempts=3)
    assert encode(error) == (
        b'event: error\ndata: {"code":"ANIMATION_TIMEOUT","message":"It took too long.",'
        b'"attempts":3}\n\n'
    )


def test_every_event_is_written_with_lf_only_and_the_json_has_no_spaces() -> None:
    for event in (STARTED, stage("generating"), sse.unknown_error_event()):
        raw = encode(event)
        assert raw is not None
        assert b"\r" not in raw
        assert raw.count(b"\n") == 3  # event line, data line, blank line
        data_line = raw.split(b"data: ", 1)[1]
        assert b", " not in data_line and b": " not in data_line


def test_non_ascii_text_and_u2028_are_written_raw_and_control_characters_are_escaped() -> None:
    text = "caf\u00e9 na\u00efve \u65e5\u672c\u8a9e \U0001f600 line\u2028break"
    raw = format_event("notice", {"text": text})
    assert raw is not None
    assert text.encode("utf-8") in raw
    assert b"\\u" not in raw  # nothing was escaped to \\uXXXX
    # Control characters cannot start a new SSE line: JSON escapes them.
    tricky = format_event("notice", {"text": "a\nb\r\nc\rd"})
    assert tricky is not None
    assert tricky.count(b"\n") == 3 and b"\r" not in tricky
    assert tricky == b'event: notice\ndata: {"text":"a\\nb\\r\\nc\\rd"}\n\n'


def test_format_event_refuses_bad_names_and_unencodable_text_without_raising() -> None:
    assert format_event("two\nlines", {"a": 1}) is None
    assert format_event("Stage", {"a": 1}) is None
    assert format_event("", {"a": 1}) is None
    assert format_event("notice", {"text": "\ud800"}) is None  # a lone surrogate has no UTF-8


def test_the_ping_is_a_comment_line_followed_by_a_blank_line() -> None:
    assert PING == b": ping\n\n"
    assert parse_stream(PING) == []


def test_a_stream_header_set_matches_requirement_17_1() -> None:
    assert sse.MEDIA_TYPE == "text/event-stream; charset=utf-8"
    assert sse.STREAM_HEADERS == {
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
    }
    assert PING_INTERVAL_S == 15.0


# --- size cap ---------------------------------------------------------------------------------


def _notice(chars: int, filler: str = "x") -> bytes | None:
    return format_event("notice", {"text": filler * chars})


def test_an_event_of_exactly_8192_bytes_is_sent_and_one_byte_more_is_not() -> None:
    overhead = len(format_event("notice", {"text": ""}) or b"")
    exact = _notice(MAX_EVENT_BYTES - overhead)
    assert exact is not None and len(exact) == MAX_EVENT_BYTES == 8192
    assert _notice(MAX_EVENT_BYTES - overhead + 1) is None


def test_the_cap_counts_bytes_not_characters() -> None:
    overhead = len(format_event("notice", {"text": ""}) or b"")
    fits = (MAX_EVENT_BYTES - overhead) // 2  # two bytes per character
    ok = _notice(fits, "\u00e9")
    assert ok is not None and len(ok) <= MAX_EVENT_BYTES
    assert _notice(fits + 1, "\u00e9") is None
    # 5000 characters are well under the cap as characters, but 10000 bytes are over it.
    assert _notice(5000, "\u00e9") is None


def test_a_model_event_over_the_cap_is_not_encoded() -> None:
    too_big = ErrorEvent(code="UNKNOWN", message="x" * 9000, attempts=0)
    assert encode(too_big) is None
    items = [DiagnosticItem(tool="tsc", code="TSC_" + "A" * 900, line=1) for _ in range(10)]
    big_diagnostics = DiagnosticsEvent(
        attempt=1, ok=False, error_count=10, warning_count=0, items=items
    )
    assert encode(big_diagnostics) is None


def test_the_stream_leaves_out_a_non_final_event_that_is_too_big() -> None:
    items = [DiagnosticItem(tool="tsc", code="TSC_" + "A" * 900, line=1) for _ in range(10)]
    big = DiagnosticsEvent(attempt=1, ok=False, error_count=10, warning_count=0, items=items)

    async def work() -> AgentResult:
        handle.emit(stage("generating"))
        handle.emit(big)
        handle.emit(stage("verifying"))
        return published()

    handle = handle_for(work)
    raw = asyncio.run(collect(handle))
    assert names(raw) == ["started", "stage", "stage", "done"]
    assert b"AAAA" not in raw


def test_a_final_event_that_is_too_big_becomes_the_generic_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The `done` event is about 380 bytes: with a 200 byte cap it is too big, `started` is not.
    monkeypatch.setattr(sse, "MAX_EVENT_BYTES", 200)
    handle = handle_for(instant(published()))
    raw = asyncio.run(collect(handle))
    assert names(raw) == ["started", "error"]
    final = payloads(raw)[-1]
    assert final == {"code": "UNKNOWN", "message": INTERNAL_ERROR_MESSAGE, "attempts": 0}


def test_a_started_event_that_cannot_be_sent_ends_the_stream_with_the_generic_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(sse, "MAX_EVENT_BYTES", 10)
    limiter = make_limiter()
    ran: list[bool] = []

    async def work() -> AgentResult:
        ran.append(True)
        return published()

    handle = handle_for(work, lease=leased(limiter))
    raw = asyncio.run(collect(handle))
    assert names(raw) == ["error"]
    assert not ran
    assert limiter.in_flight() == 0


# --- fixed messages, nothing internal ---------------------------------------------------------


def test_every_error_code_has_one_fixed_non_empty_message() -> None:
    assert set(ERROR_MESSAGES) == set(ERROR_CODES)
    assert all(isinstance(text, str) and text.strip() for text in ERROR_MESSAGES.values())
    assert ERROR_MESSAGES["UNKNOWN"] == INTERNAL_ERROR_MESSAGE
    for text in ERROR_MESSAGES.values():  # no path, class name or stack text
        assert "Traceback" not in text and "/" not in text and "Error" not in text


def test_a_diagnostics_event_carries_tool_code_and_line_and_never_the_message() -> None:
    event = DiagnosticsEvent.model_validate(
        {
            "attempt": 1,
            "ok": False,
            "error_count": 1,
            "warning_count": 0,
            "items": [
                {"tool": "tsc", "code": "TSC_2322", "line": 5, "message": SENTINEL},
            ],
        }
    )
    raw = encode(event)
    assert raw is not None and SENTINEL.encode() not in raw
    (item,) = json.loads(raw.split(b"data: ", 1)[1])["items"]
    assert set(item) == {"tool", "code", "line"}


# --- the shared fixture -----------------------------------------------------------------------


def test_the_fixture_is_the_file_with_the_features_it_exists_for() -> None:
    raw = read_fixture()
    assert b": ping" in raw
    assert b"\r\n" in raw and b"\n" in raw.replace(b"\r\n", b"")
    assert "\u2028".encode() in raw
    assert any(byte > 0x7F for byte in raw)
    assert raw.endswith(b"\n\n")
    assert b"\r" not in raw.replace(b"\r\n", b"")  # CR only ever as half of CRLF
    attributes = (FIXTURE.parent / ".gitattributes").read_text(encoding="utf-8")
    assert "*.txt -text" in attributes  # git must never rewrite its line endings


def test_the_reference_reader_gets_the_events_of_the_fixture() -> None:
    events = parse_stream(read_fixture())
    assert [event.event for event in events] == [
        "started",
        "stage",
        "stage",
        "diagnostics",
        "stage",
        "notice",
        "stage",
        "diagnostics",
        "stage",
        "done",
    ]
    assert json.loads(events[5].data) == {
        "text": "caf\u00e9 na\u00efve \u65e5\u672c\u8a9e \U0001f600 line\u2028break"
    }
    # The CRLF blocks and the LF blocks give the same events as the all-LF form.
    assert parse_stream(lf(read_fixture())) == events


def test_the_reference_reader_follows_the_line_rules() -> None:
    assert parse_stream(b"event: a\r\ndata: x\r\n\r\n") == [RawEvent("a", "x")]
    assert parse_stream(b"event: a\rdata: x\r\r:") == [RawEvent("a", "x")]
    assert parse_stream(b"data: a\ndata: b\n\n") == [RawEvent("message", "a\nb")]
    assert parse_stream("data: a\u2028b\n\n".encode()) == [RawEvent("message", "a\u2028b")]
    assert parse_stream(b"id: 1\nretry: 5\n: note\n\n") == []
    assert parse_stream(b"event: a\ndata: x\n") == []  # no blank line: unfinished, dropped
    assert parse_stream(b"data: x\n\r") == []  # a final CR is held, so the event is not closed


def _blocks(raw_lf: bytes) -> list[bytes]:
    parts = raw_lf.split(b"\n\n")
    assert parts[-1] == b""  # the stream ends with a blank line
    return [part + b"\n\n" for part in parts[:-1]]


_MODEL_OF = {
    "started": StartedEvent,
    "stage": StageEvent,
    "diagnostics": DiagnosticsEvent,
    "done": DoneEvent,
    "error": ErrorEvent,
}


def _rebuild(model: Any, payload: dict[str, Any]) -> SseEvent:
    """The model of a fixture event. Only the `diagnostics` items skip their own validation."""
    if model is DiagnosticsEvent:
        items = [fixture_item(i["tool"], i["code"], i["line"]) for i in payload["items"]]
        return DiagnosticsEvent.model_validate({**payload, "items": items})
    return model.model_validate(payload)  # type: ignore[no-any-return]


def test_writing_every_fixture_event_again_gives_the_fixture_bytes() -> None:
    """parse -> model -> encode is the identity on the LF form of the shared fixture."""
    blocks = _blocks(lf(read_fixture()))
    assert len(blocks) == 12  # ten events and two pings
    seen = []
    for block in blocks:
        if block.startswith(b":"):
            assert block == PING
            seen.append("ping")
            continue
        (event,) = parse_stream(block)
        payload = json.loads(event.data)
        model = _MODEL_OF.get(event.event)
        if model is None:  # `notice` is not one of ours: the generic writer must still match
            assert event.event == "notice"
            written = format_event(event.event, payload)
        else:
            written = encode(_rebuild(model, payload))
        assert written == block, event.event
        seen.append(event.event)
    assert seen.count("ping") == 2 and "notice" in seen


def test_the_fixture_done_event_is_what_the_registry_row_gives() -> None:
    """The fixture's `done` is the reference of `FIXTURE_ROW`, written by `DoneEvent`."""
    (done,) = [e for e in parse_stream(read_fixture()) if e.event == "done"]
    event = DoneEvent(
        animation=reference_from_row(FIXTURE_ROW),
        cached=False,
        attempts=FIXTURE_ROW.attempts,
    )
    assert json.loads(done.data) == event.dump()
    assert encode(event) == b"event: done\ndata: " + done.data.encode() + b"\n\n"


def test_a_run_that_tells_the_fixture_story_writes_the_fixture_bytes() -> None:
    """Same events, pings after the same writes, written by `stream`: LF form of the fixture.

    The fixture's `notice` event is not one the endpoint can send, so it is left out of the
    expected bytes.
    """
    expected = b"".join(
        block for block in _blocks(lf(read_fixture())) if not block.startswith(b"event: notice")
    )

    async def scenario() -> bytes:
        clock = Clock(0.0)
        first, second = asyncio.Event(), asyncio.Event()

        async def work() -> AgentResult:
            handle.emit(stage("generating", 1))
            await first.wait()
            handle.emit(stage("verifying", 1))
            handle.emit(
                DiagnosticsEvent(
                    attempt=1,
                    ok=False,
                    error_count=2,
                    warning_count=0,
                    items=[
                        fixture_item("policy", "POLICY_IMPORT_DISALLOWED", 3),
                        fixture_item("tsc", "TSC_2322", 17),
                    ],
                )
            )
            await second.wait()
            handle.emit(stage("repairing", 2))
            handle.emit(stage("verifying", 2))
            handle.emit(
                DiagnosticsEvent(attempt=2, ok=True, error_count=0, warning_count=0, items=[])
            )
            handle.emit(stage("publishing", 2))
            return published()

        handle = handle_for(work)
        gen = stream(handle, clock=clock)
        chunks = [await anext(gen)]  # started
        chunks.append(await anext(gen))  # stage generating
        clock.now = 15.0
        chunks.append(await anext(gen))  # ping: 15 s since the last write, work is waiting
        first.set()
        chunks.append(await anext(gen))  # stage verifying
        chunks.append(await anext(gen))  # diagnostics
        clock.now = 30.0
        chunks.append(await anext(gen))  # ping
        second.set()
        chunks.extend([chunk async for chunk in gen])
        return b"".join(chunks)

    assert asyncio.run(scenario()) == expected


def test_sse_py_never_splits_lines_with_splitlines() -> None:
    tree = ast.parse(Path(sse.__file__).read_text(encoding="utf-8"))
    calls = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Attribute) and node.attr == "splitlines"
    ]
    assert calls == []


# --- slot lease -------------------------------------------------------------------------------


def test_a_lease_gives_the_slot_back_once_however_often_release_is_called() -> None:
    limiter = CountingLimiter()
    assert limiter.try_acquire(IP) is None
    other = leased(limiter, "198.51.100.9")  # another holder, must stay untouched
    lease = SlotLease(limiter, IP)
    assert not lease.released
    for _ in range(5):
        lease.release()
    assert lease.released
    assert limiter.in_flight() == 1 and limiter.released == 1
    other.release()
    assert limiter.in_flight() == 0 and limiter.released == 2


def test_releases_from_many_threads_still_give_the_slot_back_once() -> None:
    limiter = CountingLimiter()
    assert limiter.try_acquire(IP) is None
    leased(limiter, "198.51.100.9")  # held for the whole test
    lease = SlotLease(limiter, IP)
    gate = threading.Barrier(16)

    def worker() -> None:
        gate.wait()
        lease.release()

    threads = [threading.Thread(target=worker) for _ in range(16)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert limiter.released == 1 and limiter.in_flight() == 1


# --- RunHandle.execute ------------------------------------------------------------------------


async def run_execute(handle: RunHandle) -> list[SseEvent | None]:
    await handle.execute()
    items: list[SseEvent | None] = []
    while not handle.queue.empty():
        items.append(handle.queue.get_nowait())
    return items


def test_execute_queues_the_emitted_events_then_one_done_then_the_end_marker() -> None:
    async def work() -> AgentResult:
        handle.emit(stage("generating"))
        handle.emit(stage("publishing"))
        return published()

    handle = handle_for(work)
    items = asyncio.run(run_execute(handle))
    assert [type(item).__name__ for item in items] == [
        "StageEvent",
        "StageEvent",
        "DoneEvent",
        "NoneType",
    ]
    done = items[2]
    assert isinstance(done, DoneEvent)
    assert done.cached is False and done.attempts == 2  # attempts of the row, not of the calls
    assert done.animation == reference_from_row(FIXTURE_ROW)


def test_a_cache_hit_answers_started_cached_then_done_cached_with_the_recorded_attempts() -> None:
    row = dataclasses.replace(FIXTURE_ROW, attempts=3)
    limiter = CountingLimiter()
    handle = handle_for(instant(published(row, calls=0)), started=CACHED_STARTED, lease=None)
    raw = asyncio.run(collect(handle))
    assert names(raw) == ["started", "done"]
    started, done = payloads(raw)
    assert started["cached"] is True
    assert done["cached"] is True and done["attempts"] == 3
    assert (limiter.acquired, limiter.in_flight()) == (0, 0)  # no slot was ever taken


@pytest.mark.parametrize("code", sorted(ERROR_CODES))
def test_a_failed_run_becomes_one_error_with_the_fixed_message_for_its_code(code: str) -> None:
    failed = AgentFailed(code=code, calls=3)  # type: ignore[arg-type]
    items = asyncio.run(run_execute(handle_for(instant(failed))))
    assert items[-1] is None
    error = items[-2]
    assert isinstance(error, ErrorEvent)
    assert (error.code, error.message, error.attempts) == (code, ERROR_MESSAGES[code], 3)
    assert sum(1 for item in items if isinstance(item, ErrorEvent | DoneEvent)) == 1


def test_an_error_event_never_carries_diagnostic_messages_or_source_text() -> None:
    diagnostic = Diagnostic(tool="tsc", code="TSC_2322", severity="error", message=SENTINEL, line=4)
    failed = AgentFailed(code="ANIMATION_VERIFICATION_FAILED", calls=4, diagnostics=(diagnostic,))
    raw = asyncio.run(collect(handle_for(instant(failed))))
    assert SENTINEL.encode() not in raw
    assert payloads(raw)[-1] == {
        "code": "ANIMATION_VERIFICATION_FAILED",
        "message": ERROR_MESSAGES["ANIMATION_VERIFICATION_FAILED"],
        "attempts": 4,
    }


def test_an_unexpected_exception_becomes_one_unknown_error_and_only_its_class_is_logged(
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def work() -> AgentResult:
        handle.emit(stage("generating"))
        raise RuntimeError(SENTINEL)

    handle = handle_for(work)
    with caplog.at_level(logging.INFO):
        raw = asyncio.run(collect(handle))
    assert names(raw) == ["started", "stage", "error"]
    assert payloads(raw)[-1] == {
        "code": "UNKNOWN",
        "message": INTERNAL_ERROR_MESSAGE,
        "attempts": 0,
    }
    assert SENTINEL.encode() not in raw
    logged = "\n".join(record.getMessage() for record in caplog.records)
    assert "RuntimeError" in logged and SENTINEL not in logged


def test_a_result_of_the_wrong_type_is_an_unknown_error() -> None:
    async def work() -> Any:
        return "not a result"

    raw = asyncio.run(collect(handle_for(work)))
    assert names(raw) == ["started", "error"]
    assert payloads(raw)[-1]["code"] == "UNKNOWN"


def test_a_done_event_that_breaks_its_own_schema_is_an_unknown_error() -> None:
    row = dataclasses.replace(FIXTURE_ROW, attempts=5)  # more than the 4 calls allowed
    raw = asyncio.run(collect(handle_for(instant(published(row)))))
    assert names(raw) == ["started", "error"]
    assert payloads(raw)[-1]["code"] == "UNKNOWN"


def test_an_agent_that_ended_unknown_after_the_client_left_sends_nothing() -> None:
    async def scenario() -> list[SseEvent | None]:
        handle = handle_for(instant(AgentFailed(code="UNKNOWN", calls=1)))
        handle.cancelled.set()
        return await run_execute(handle)

    assert asyncio.run(scenario()) == [None]  # only the end marker (Requirement 13.15)


def test_a_timeout_is_sent_even_though_the_agent_sets_the_cancel_flag_for_it() -> None:
    async def scenario() -> list[SseEvent | None]:
        handle = handle_for(instant(AgentFailed(code="ANIMATION_TIMEOUT", calls=2)))
        handle.cancelled.set()
        return await run_execute(handle)

    items = asyncio.run(scenario())
    assert isinstance(items[0], ErrorEvent) and items[0].code == "ANIMATION_TIMEOUT"


def test_events_emitted_after_the_final_event_or_after_close_are_ignored() -> None:
    async def scenario() -> tuple[list[SseEvent | None], int]:
        handle = handle_for(instant(published()))
        items = await run_execute(handle)
        handle.emit(stage("generating"))  # after `done`
        late = handle.queue.qsize()
        other = handle_for(instant(published()))
        other.close()
        other.emit(stage("generating"))  # after close
        return items, late + other.queue.qsize()

    items, extra = asyncio.run(scenario())
    assert isinstance(items[-2], DoneEvent) and items[-1] is None
    assert extra == 0


def test_a_cancelled_run_queues_the_end_marker_and_no_final_event() -> None:
    async def scenario() -> list[SseEvent | None]:
        started = asyncio.Event()

        async def work() -> AgentResult:
            started.set()
            await asyncio.sleep(3600)
            return published()

        handle = handle_for(work)
        task = handle.start()
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        return [handle.queue.get_nowait() for _ in range(handle.queue.qsize())]

    assert asyncio.run(scenario()) == [None]


# --- the stream: order and ending -------------------------------------------------------------


def test_started_comes_first_and_one_final_event_comes_last_on_success_and_failure() -> None:
    async def ok_work() -> AgentResult:
        handle.emit(stage("generating"))
        handle.emit(stage("verifying"))
        handle.emit(DiagnosticsEvent(attempt=1, ok=True, error_count=0, warning_count=0, items=[]))
        handle.emit(stage("publishing"))
        return published()

    handle = handle_for(ok_work)
    raw = asyncio.run(collect(handle))
    assert names(raw) == [
        "started",
        "stage",
        "stage",
        "diagnostics",
        "stage",
        "done",
    ]
    assert raw.endswith(b"\n\n") and raw.count(b"event: done") == 1

    failed = handle_for(instant(AgentFailed(code="PROVIDER_UNAVAILABLE", calls=1)))
    raw = asyncio.run(collect(failed))
    assert names(raw) == ["started", "error"]


def test_nothing_is_written_after_the_final_event_even_if_more_is_queued() -> None:
    async def scenario() -> bytes:
        handle = handle_for(instant(published()))
        gen = stream(handle)
        chunks = [await anext(gen)]  # started: the run starts at the next step
        handle.queue.put_nowait(stage("generating"))
        handle.queue.put_nowait(
            DoneEvent(animation=reference_from_row(FIXTURE_ROW), cached=False, attempts=1)
        )
        handle.queue.put_nowait(stage("publishing"))  # a forged event after `done`
        handle.queue.put_nowait(sse.unknown_error_event())  # and a second final event
        async for chunk in gen:
            chunks.append(chunk)
        return b"".join(chunks)

    raw = asyncio.run(scenario())
    assert names(raw) == ["started", "stage", "done"]


def test_the_started_event_is_yielded_before_the_run_does_anything() -> None:
    touched: list[str] = []

    async def work() -> AgentResult:
        touched.append("work")
        return published()

    async def scenario() -> bytes:
        gen = stream(handle_for(work))
        first = await anext(gen)
        assert touched == []  # nothing has run yet: `started` is not waiting for the agent
        await gen.aclose()
        return first

    first = asyncio.run(scenario())
    assert names(first) == ["started"]
    assert touched == []


def test_the_started_payload_is_the_one_the_handle_was_given() -> None:
    cached = asyncio.run(collect(handle_for(instant(published()), started=CACHED_STARTED)))
    assert payloads(cached)[0] == {"max_attempts": 4, "deadline_ms": 240000, "cached": True}
    short = StartedEvent(max_attempts=1, deadline_ms=1000, cached=False)
    raw = asyncio.run(collect(handle_for(instant(published()), started=short)))
    assert payloads(raw)[0] == {"max_attempts": 1, "deadline_ms": 1000, "cached": False}


# --- ping -------------------------------------------------------------------------------------


def test_a_ping_is_written_when_15_seconds_passed_without_a_write() -> None:
    async def scenario() -> list[bytes]:
        clock = Clock(100.0)
        release = asyncio.Event()

        async def work() -> AgentResult:
            await release.wait()
            return published()

        gen = stream(handle_for(work), clock=clock)
        chunks = [await anext(gen)]  # started
        clock.now += 15.0
        chunks.append(await anext(gen))
        clock.now += 15.0
        chunks.append(await anext(gen))
        clock.now += 40.0  # a long silence is still one ping per step
        chunks.append(await anext(gen))
        release.set()
        chunks.extend([chunk async for chunk in gen])
        return chunks

    chunks = asyncio.run(scenario())
    assert chunks[1:4] == [PING, PING, PING]
    assert names(b"".join(chunks)) == ["started", "done"]


def test_no_ping_is_written_before_15_seconds_have_passed_since_the_last_write() -> None:
    async def scenario() -> tuple[bool, bytes]:
        clock = Clock(100.0)
        release = asyncio.Event()

        async def work() -> AgentResult:
            await release.wait()
            return published()

        handle = handle_for(work)
        gen = stream(handle, clock=clock)
        await anext(gen)  # started, written at t=100
        clock.now = 114.9  # 14.9 s later: not due
        pending = asyncio.ensure_future(anext(gen))
        done, _ = await asyncio.wait({pending}, timeout=0.05)
        quiet = not done  # nothing was written yet
        handle.emit(stage("generating"))  # an event wakes the wait: it, not a ping, comes out
        chunk = await pending
        release.set()
        async for _ in gen:
            pass
        return quiet, chunk

    quiet, chunk = asyncio.run(scenario())
    assert quiet
    assert names(chunk) == ["stage"]


def test_the_interval_counts_from_the_last_write_not_from_the_start() -> None:
    async def scenario() -> tuple[bool, bytes]:
        clock = Clock(0.0)
        release = asyncio.Event()

        async def work() -> AgentResult:
            handle.emit(stage("generating"))
            await release.wait()
            return published()

        handle = handle_for(work)
        gen = stream(handle, clock=clock)
        await anext(gen)  # started at t=0
        clock.now = 10.0
        await anext(gen)  # stage written at t=10
        clock.now = 20.0  # 20 s after the start but only 10 s after the last write
        pending = asyncio.ensure_future(anext(gen))
        done, _ = await asyncio.wait({pending}, timeout=0.05)
        quiet = not done
        handle.emit(stage("verifying"))
        chunk = await pending
        release.set()
        async for _ in gen:
            pass
        return quiet, chunk

    quiet, chunk = asyncio.run(scenario())
    assert quiet and names(chunk) == ["stage"]


def test_queued_events_go_out_before_a_ping_even_when_a_ping_is_due() -> None:
    async def scenario() -> list[bytes]:
        clock = Clock(0.0)
        release = asyncio.Event()

        async def work() -> AgentResult:
            handle.emit(stage("generating"))
            handle.emit(stage("verifying"))
            await release.wait()
            return published()

        handle = handle_for(work)
        gen = stream(handle, clock=clock)
        chunks = [await anext(gen)]  # started
        chunks.append(await anext(gen))  # stage generating; `verifying` is already queued
        clock.now = 60.0  # a ping is long overdue
        chunks.append(await anext(gen))
        clock.now = 120.0  # nothing is queued any more, and 60 s passed since the last write
        chunks.append(await anext(gen))
        release.set()
        chunks.extend([chunk async for chunk in gen])
        return chunks

    chunks = asyncio.run(scenario())
    assert [names(chunk) for chunk in chunks[:3]] == [["started"], ["stage"], ["stage"]]
    assert chunks[3] == PING


def test_no_ping_follows_the_final_event() -> None:
    async def scenario() -> list[bytes]:
        clock = Clock(0.0)
        gen = stream(handle_for(instant(published())), clock=clock)
        chunks = [await anext(gen)]
        chunks.append(await anext(gen))  # done
        clock.now = 10_000.0  # far past any ping
        with pytest.raises(StopAsyncIteration):
            await anext(gen)
        return chunks

    chunks = asyncio.run(scenario())
    assert names(chunks[-1]) == ["done"] and PING not in chunks


def test_the_default_clock_pings_after_the_real_interval() -> None:
    async def scenario() -> list[bytes]:
        release = asyncio.Event()

        async def work() -> AgentResult:
            await release.wait()
            return published()

        gen = stream(handle_for(work), ping_interval_s=0.05)
        chunks = [await anext(gen)]
        chunks.append(await asyncio.wait_for(anext(gen), 2.0))
        release.set()
        chunks.extend([chunk async for chunk in gen])
        return chunks

    chunks = asyncio.run(scenario())
    assert chunks[1] == PING
    assert names(b"".join(chunks)) == ["started", "done"]


# --- the slot is released on every way a stream can end ---------------------------------------


def test_the_slot_is_held_while_the_run_works_and_released_after_done() -> None:
    limiter = CountingLimiter()
    seen: list[int] = []

    async def work() -> AgentResult:
        seen.append(limiter.in_flight())
        return published()

    asyncio.run(collect(handle_for(work, lease=leased(limiter))))
    assert seen == [1]
    assert (limiter.acquired, limiter.released, limiter.in_flight()) == (1, 1, 0)


@pytest.mark.parametrize(
    "result",
    [
        AgentFailed(code="ANIMATION_VERIFICATION_FAILED", calls=4),
        AgentFailed(code="UNKNOWN", calls=1),
    ],
)
def test_the_slot_is_released_after_an_error_event(result: AgentFailed) -> None:
    limiter = CountingLimiter()
    asyncio.run(collect(handle_for(instant(result), lease=leased(limiter))))
    assert (limiter.acquired, limiter.released, limiter.in_flight()) == (1, 1, 0)


def test_the_slot_is_released_after_an_unexpected_exception() -> None:
    limiter = CountingLimiter()

    async def work() -> AgentResult:
        raise ValueError("boom")

    asyncio.run(collect(handle_for(work, lease=leased(limiter))))
    assert (limiter.acquired, limiter.released, limiter.in_flight()) == (1, 1, 0)


def test_closing_the_generator_after_started_releases_the_slot_and_skips_the_run() -> None:
    limiter = CountingLimiter()
    ran: list[bool] = []

    async def work() -> AgentResult:
        ran.append(True)
        return published()

    async def scenario() -> RunHandle:
        handle = handle_for(work, lease=leased(limiter))
        gen = stream(handle)
        await anext(gen)  # started
        await gen.aclose()  # the client left right after `started`
        await settle()
        return handle

    handle = asyncio.run(scenario())
    assert not ran and handle.cancelled.is_set()
    assert (limiter.acquired, limiter.released, limiter.in_flight()) == (1, 1, 0)


def test_closing_the_generator_mid_run_cancels_the_agent_and_releases_the_slot() -> None:
    limiter = CountingLimiter()
    outcome: list[str] = []

    async def scenario() -> RunHandle:
        working = asyncio.Event()

        async def work() -> AgentResult:
            handle.emit(stage("generating"))
            working.set()
            try:
                await asyncio.sleep(3600)
            except asyncio.CancelledError:
                outcome.append("cancelled")
                raise
            return published()

        handle = handle_for(work, lease=leased(limiter))
        gen = stream(handle)
        await anext(gen)
        await anext(gen)  # stage generating: the agent is now inside its long wait
        await working.wait()
        await gen.aclose()
        await settle()
        return handle

    handle = asyncio.run(scenario())
    assert outcome == ["cancelled"]
    assert handle.cancelled.is_set()
    assert (limiter.acquired, limiter.released, limiter.in_flight()) == (1, 1, 0)


def test_cancelling_the_reader_while_it_waits_for_an_event_releases_the_slot() -> None:
    limiter = CountingLimiter()

    async def scenario() -> None:
        working = asyncio.Event()

        async def work() -> AgentResult:
            working.set()
            await asyncio.sleep(3600)
            return published()

        gen = stream(handle_for(work, lease=leased(limiter)))
        await anext(gen)
        reader = asyncio.ensure_future(anext(gen))  # waits inside `queue.get`
        await working.wait()
        reader.cancel()
        with pytest.raises(asyncio.CancelledError):
            await reader
        await settle()

    asyncio.run(scenario())
    assert (limiter.acquired, limiter.released, limiter.in_flight()) == (1, 1, 0)


# --- the response -----------------------------------------------------------------------------


def _http_scope(spec_version: str) -> dict[str, Any]:
    return {"type": "http", "asgi": {"version": "3.0", "spec_version": spec_version}}


def test_a_response_whose_generator_is_never_iterated_still_releases_the_slot_and_logs_once(
    caplog: pytest.LogCaptureFixture,
) -> None:
    limiter = CountingLimiter()
    ran: list[bool] = []

    async def work() -> AgentResult:
        ran.append(True)
        return published()

    async def scenario() -> RunHandle:
        handle = handle_for(work, lease=leased(limiter), log=RunLog("lesson", False))
        response = AnimationStreamResponse(handle)

        async def receive() -> dict[str, Any]:
            await asyncio.Event().wait()
            return {}

        async def send(message: dict[str, Any]) -> None:
            raise OSError("the client is gone")  # the very first send fails

        with pytest.raises(ClientDisconnect):
            await response(_http_scope("2.4"), receive, send)
        return handle

    with caplog.at_level(logging.INFO):
        handle = asyncio.run(scenario())
    assert not ran and handle.cancelled.is_set()
    assert (limiter.acquired, limiter.released, limiter.in_flight()) == (1, 1, 0)
    lines = animation_log_lines(caplog)
    assert [line["event"] for line in lines] == ["animation.start", "animation.end"]
    assert lines[-1]["code"] == "CANCELLED"


def test_a_client_that_disconnects_mid_run_cancels_the_agent_within_one_second() -> None:
    limiter = CountingLimiter()
    outcome: list[str] = []

    async def scenario() -> tuple[RunHandle, float]:
        working = asyncio.Event()
        disconnect = asyncio.Event()
        sent: list[dict[str, Any]] = []

        async def work() -> AgentResult:
            working.set()
            try:
                await asyncio.sleep(3600)
            except asyncio.CancelledError:
                outcome.append("cancelled")
                raise
            return published()

        handle = handle_for(work, lease=leased(limiter))
        response = AnimationStreamResponse(handle)

        async def receive() -> dict[str, Any]:
            await disconnect.wait()
            return {"type": "http.disconnect"}

        async def send(message: dict[str, Any]) -> None:
            sent.append(message)

        loop = asyncio.get_running_loop()
        task = asyncio.create_task(response(_http_scope("2.0"), receive, send))
        await working.wait()
        start = loop.time()
        disconnect.set()
        await asyncio.wait_for(task, 1.0)
        assert [m["type"] for m in sent][:2] == ["http.response.start", "http.response.body"]
        return handle, loop.time() - start

    handle, elapsed = asyncio.run(scenario())
    assert elapsed < 1.0
    assert outcome == ["cancelled"] and handle.cancelled.is_set()
    assert (limiter.acquired, limiter.released, limiter.in_flight()) == (1, 1, 0)


def _client_for(limiter: AiLimiter, work: Callable[[], Awaitable[AgentResult]]) -> TestClient:
    app = FastAPI()

    @app.post("/stream")
    async def create() -> AnimationStreamResponse:
        handle = handle_for(work, lease=leased(limiter))
        return AnimationStreamResponse(handle)

    return TestClient(app)


def test_the_response_has_the_stream_headers_and_the_slot_is_back_afterwards() -> None:
    limiter = CountingLimiter()
    inside: list[int] = []

    async def work() -> AgentResult:
        inside.append(limiter.in_flight())
        return published()

    response = _client_for(limiter, work).post("/stream")
    assert response.status_code == 200
    assert response.headers["content-type"] == "text/event-stream; charset=utf-8"
    assert response.headers["cache-control"] == "no-store, no-transform"
    assert response.headers["x-accel-buffering"] == "no"
    assert names(response.content) == ["started", "done"]
    assert inside == [1]
    assert (limiter.acquired, limiter.released, limiter.in_flight()) == (1, 1, 0)


def test_the_response_body_for_a_failed_run_is_started_then_one_error() -> None:
    limiter = CountingLimiter()
    failed = instant(AgentFailed(code="ANIMATION_STORAGE_FAILED", calls=2))
    response = _client_for(limiter, failed).post("/stream")
    assert response.status_code == 200  # the failure is an event, not a status
    assert names(response.content) == ["started", "error"]
    assert payloads(response.content)[-1]["message"] == ERROR_MESSAGES["ANIMATION_STORAGE_FAILED"]
    assert limiter.in_flight() == 0


# --- the real agent through the stream --------------------------------------------------------


def test_a_real_agent_run_streams_its_stages_and_ends_in_one_done(
    caplog: pytest.LogCaptureFixture,
) -> None:
    limiter = CountingLimiter()
    rig = make_rig(gemini=[fenced(source(1))], verifier=[verified()])
    log = RunLog("lesson", False)
    handle = RunHandle(
        started=STARTED,
        work=lambda: run_agent(rig.run),
        lease=leased(limiter),
        log=log,
        cancelled=rig.run.cancelled,
    )
    rig.run.emit = handle.emit
    rig.run.log = log

    with caplog.at_level(logging.INFO):
        raw = asyncio.run(collect(handle))

    events = names(raw)
    assert events[0] == "started" and events[-1] == "done"
    assert events.count("done") == 1 and "error" not in events
    stages = [p["stage"] for p in payloads(raw) if "stage" in p]
    assert stages == ["generating", "verifying", "publishing"]
    diagnostics = [p for p in payloads(raw) if "items" in p]
    assert len(diagnostics) == 1 and diagnostics[0]["ok"] is True
    done = payloads(raw)[-1]
    assert done["cached"] is False and done["attempts"] == 1
    assert b"export default" not in raw  # no source text on the wire
    assert (limiter.acquired, limiter.released, limiter.in_flight()) == (1, 1, 0)
    lines = animation_log_lines(caplog)
    assert [line["event"] for line in lines].count("animation.start") == 1
    assert [line["event"] for line in lines].count("animation.end") == 1
    assert lines[-1]["event"] == "animation.end" and lines[-1]["code"] == "OK"


def test_a_real_agent_run_that_never_verifies_ends_in_one_error_and_leaks_nothing() -> None:
    limiter = CountingLimiter()
    rig = make_rig(
        gemini=[fenced(source(n)) for n in range(1, 5)],
        verifier=[
            rejected("POLICY_COLOR_LITERAL", message=SENTINEL),
            rejected("TSC_2322", message=SENTINEL),
            rejected("POLICY_IMPORT_DISALLOWED", message=SENTINEL),
            rejected("RENDER_THROW", message=SENTINEL),
        ],
    )
    handle = RunHandle(
        started=STARTED,
        work=lambda: run_agent(rig.run),
        lease=leased(limiter),
        cancelled=rig.run.cancelled,
    )
    rig.run.emit = handle.emit
    raw = asyncio.run(collect(handle))

    events = names(raw)
    assert events[0] == "started" and events[-1] == "error"
    assert events.count("error") == 1 and "done" not in events
    assert payloads(raw)[-1] == {
        "code": "ANIMATION_VERIFICATION_FAILED",
        "message": ERROR_MESSAGES["ANIMATION_VERIFICATION_FAILED"],
        "attempts": 4,
    }
    assert SENTINEL.encode() not in raw and b"export default" not in raw
    assert limiter.in_flight() == 0
