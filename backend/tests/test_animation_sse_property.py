"""Property tests: an SSE stream reads the same however the network cuts it (Property 7, backend).

Why: the browser receives the animation stream in chunks of whatever size the network delivers. A
chunk can end inside a multi-byte UTF-8 character, between the `\\r` and the `\\n` of a CRLF, in
the middle of a `data:` line or between two events. If the parser gave different events for
different cuts, a player would see a missing `done`, a doubled `stage` or a mangled message on a
slow connection and never in a test. Requirements 17.9 and 17.15 state the property: for every cut
of the serialized stream, the events are those of the whole stream, which for the shared fixture
`fixtures/animation/sse-stream.txt` are the events it was written from.

The parser under test here is a small incremental reference reader written in this file
(`ChunkedParser`). It follows the same rules as `frontend/src/lib/animation/sse-parser.ts` but is
written again, over bytes and a stateful UTF-8 decoder, so it is a second implementation to check
the writer against. The "whole stream" answer is the other reference reader of
`tests/animation_sse_support.py` (`parse_stream`), which splits on the bytes with a regular
expression instead. What is exercised on the backend side is the writer: `sse.encode` and
`sse.PING` must produce bytes that both readers agree on at every cut.

Streams: the shared fixture (it has CRLF, comments, a non-ASCII `notice`, U+2028 inside data, and
an unknown event), and 40 seeded random streams of the five event models written with `encode`,
with `: ping` comments between events and the newlines rewritten in LF, CRLF, CR or mixed style
(a different style does not change the events). `hypothesis` is not a dependency, so streams
and cuts come from `random.Random(seed)`.

Cuts: every single offset; one byte at a time; random partitions with empty chunks; and every pair
of offsets near a line break or a non-ASCII byte. `test_the_harness_catches_*` runs four broken
readers through the same harness, so a pass means something.

The fixture is read with `read_bytes()` and never written or changed here.
"""

from __future__ import annotations

import codecs
import itertools
import json
import random
import re
import uuid
from collections.abc import Callable, Iterable
from typing import Any

import pytest

from app.ai.animation.models import (
    ERROR_CODES,
    AnimationReference,
    DiagnosticItem,
    DiagnosticsEvent,
    DoneEvent,
    ErrorEvent,
    SseEvent,
    StageEvent,
    StartedEvent,
)
from app.ai.animation.sse import PING, encode
from tests.animation_sse_support import RawEvent, parse_stream, read_fixture

SEEDS = 40
LINE_END = re.compile(r"\r\n|\r|\n")


# --- the reference reader that takes chunks -----------------------------------------------


class ChunkedParser:
    """Incremental SSE reader over bytes. `push` returns the events a chunk completed.

    A stateful UTF-8 decoder keeps half a character until the rest arrives. A line ends at CRLF,
    LF or CR and nowhere else (U+2028 and U+0085 stay in the data); a CR at the very end of what
    has arrived is held, because the next chunk may start with the LF. A blank line closes an
    event, which is returned only if it had a `data:` line. Comments (`:`) and fields other than
    `event` and `data` are ignored. `finish` drops what is unfinished.
    """

    line_end = LINE_END

    def __init__(self) -> None:
        self._decoder = codecs.getincrementaldecoder("utf-8")("strict")
        self._buffer = ""
        self._name: str | None = None
        self._data: list[str] = []

    def push(self, chunk: bytes) -> list[RawEvent]:
        self._buffer += self._decoder.decode(chunk)
        events: list[RawEvent] = []
        position = 0
        while True:
            match = self.line_end.search(self._buffer, position)
            if match is None:
                break
            if match.group() == "\r" and match.end() == len(self._buffer):
                break  # could be the first half of CRLF
            event = self._line(self._buffer[position : match.start()])
            position = match.end()
            if event is not None:
                events.append(event)
        self._buffer = self._buffer[position:]
        return events

    def finish(self) -> None:
        """End of the stream: whatever is half read is dropped."""
        self._buffer, self._name, self._data = "", None, []

    def _line(self, line: str) -> RawEvent | None:
        if line == "":
            name, data = self._name, self._data
            self._name, self._data = None, []
            return RawEvent(name or "message", "\n".join(data)) if data else None
        if line.startswith(":"):
            return None
        field, colon, value = line.partition(":")
        if colon and value.startswith(" "):
            value = value[1:]
        if field == "event":
            self._name = value
        elif field == "data":
            self._data.append(value)
        return None


Reader = Callable[[], Any]


def read_in_chunks(chunks: Iterable[bytes], parser: Reader = ChunkedParser) -> list[RawEvent]:
    reader = parser()
    events: list[RawEvent] = []
    for chunk in chunks:
        events.extend(reader.push(chunk))
    reader.finish()
    return events


def read_or_error(chunks: Iterable[bytes], parser: Reader = ChunkedParser) -> object:
    """`read_in_chunks`, or the exception it raised: a reader that crashes is also wrong."""
    try:
        return read_in_chunks(chunks, parser)
    except Exception as exc:  # the harness judges the reader, so any failure is a result
        return exc


# --- cuts ---------------------------------------------------------------------------------


def cut_at(raw: bytes, *offsets: int) -> list[bytes]:
    """`raw` split at the given offsets (any order, repeats give empty chunks)."""
    points = [0, *sorted(offsets), len(raw)]
    return [raw[a:b] for a, b in itertools.pairwise(points)]


def interesting_offsets(raw: bytes) -> list[int]:
    """Offsets within two bytes of a CR, an LF or a non-ASCII byte (and inside such characters)."""
    found: set[int] = set()
    for index, byte in enumerate(raw):
        if byte in (0x0A, 0x0D) or byte >= 0x80:
            found.update(o for o in range(index - 1, index + 3) if 0 <= o <= len(raw))
    return sorted(found)


def random_partition(rng: random.Random, raw: bytes) -> list[bytes]:
    chunks: list[bytes] = []
    position = 0
    while position < len(raw):
        if rng.random() < 0.1:
            chunks.append(b"")  # an empty read is legal
        size = rng.choice([1, 1, 2, 3, 5, 8, 13, 64, 200])
        chunks.append(raw[position : position + size])
        position += size
    return chunks


def first_mismatch(
    raw: bytes, parser: Reader, *, pairs: bool = True, seed: str = "mismatch"
) -> tuple[str, list[bytes]] | None:
    """The first cut at which `parser` disagrees with the whole-stream answer, or `None`."""
    whole = parse_stream(raw)
    for offset in range(len(raw) + 1):
        chunks = cut_at(raw, offset)
        if read_or_error(chunks, parser) != whole:
            return f"single cut at {offset}", chunks
    one_by_one = [raw[i : i + 1] for i in range(len(raw))]
    if read_or_error(one_by_one, parser) != whole:
        return "one byte at a time", one_by_one
    rng = random.Random(f"{seed}-{len(raw)}")
    for _ in range(40):
        chunks = random_partition(rng, raw)
        if read_or_error(chunks, parser) != whole:
            return "random partition", chunks
    if pairs:
        near = interesting_offsets(raw)
        for first, second in itertools.combinations_with_replacement(near, 2):
            chunks = cut_at(raw, first, second)
            if read_or_error(chunks, parser) != whole:
                return f"cuts at {first} and {second}", chunks
    return None


# --- streams ------------------------------------------------------------------------------

TOOL_CODES = (
    ("policy", "POLICY_IMPORT_DISALLOWED"),
    ("tsc", "TSC_2322"),
    ("eslint", "ESLINT_LORE_USES_FRAME"),
    ("render", "RENDER_EXCEPTION"),
    ("fidelity", "FIDELITY_TOKEN_MISSING"),
    ("size", "SIZE_SOURCE_TOO_LARGE"),
    ("verifier", "VERIFIER_CRASH"),
)
MESSAGE_PIECES = (
    "The animation took too long.",
    "caf\u00e9 na\u00efve",
    "\u65e5\u672c\u8a9e",
    "\U0001f600",
    "line\u2028break",
    "para\u2029break",
    "next\u0085line",
    "tab\tinside",
    'quote " and \\ slash',
    "carriage\rreturn",
    "new\nline",
    "data: looks like a field",
    ": looks like a comment",
    "event: nope",
    "  leading and trailing  ",
    "\u00e9" * 40,
    "\ud7ff\ue000\U0010ffff",
)


def reference(rng: random.Random) -> AnimationReference:
    pause = rng.random() < 0.5
    duration = rng.randint(30, 900)
    raw: dict[str, Any] = {
        "animation_id": str(uuid.UUID(int=rng.getrandbits(128), version=4)),
        "source_sha256": f"{rng.getrandbits(256):064x}",
        "bundle_sha256": f"{rng.getrandbits(256):064x}",
        "width": 1280,
        "height": 720,
        "fps": 30,
        "duration_in_frames": duration,
        "contract_version": 1,
    }
    if pause:
        raw["pause_at_frame"] = rng.randint(1, duration - 1)
    return AnimationReference.model_validate(raw)


def random_event(rng: random.Random) -> SseEvent:
    kind = rng.choice(["started", "stage", "diagnostics", "done", "error"])
    if kind == "started":
        return StartedEvent(
            max_attempts=rng.randint(1, 4),
            deadline_ms=rng.choice([1, 240_000, rng.randint(1, 10**9)]),
            cached=rng.random() < 0.5,
        )
    if kind == "stage":
        return StageEvent(
            stage=rng.choice(["generating", "verifying", "repairing", "publishing"]),
            attempt=rng.randint(1, 4),
        )
    if kind == "diagnostics":
        items = []
        for _ in range(rng.randint(0, 10)):
            tool, code = rng.choice(TOOL_CODES)
            line = {} if rng.random() < 0.4 else {"line": rng.randint(1, 5000)}
            items.append(DiagnosticItem(tool=tool, code=code, **line))
        return DiagnosticsEvent(
            attempt=rng.randint(1, 4),
            ok=rng.random() < 0.3,
            error_count=rng.randint(0, 60),
            warning_count=rng.randint(0, 60),
            items=items,
        )
    if kind == "done":
        return DoneEvent(
            animation=reference(rng), cached=rng.random() < 0.5, attempts=rng.randint(1, 4)
        )
    message = " ".join(rng.choice(MESSAGE_PIECES) for _ in range(rng.randint(1, 4)))
    return ErrorEvent(code=rng.choice(ERROR_CODES), message=message, attempts=rng.randint(0, 4))


STYLES = ("lf", "crlf", "cr", "mixed")


def restyle(rng: random.Random, raw: bytes, style: str) -> bytes:
    """The same stream with its line breaks written as CRLF, CR or a random mix.

    The stream's last two LF (the blank line that closes the final event) are kept as LF, because a
    stream whose last byte is a lone CR does not close its last event (the reader holds that CR),
    and the point here is the events, not that edge.
    """
    if style == "lf":
        return raw
    body, tail = raw[:-2], raw[-2:]
    assert tail == b"\n\n"
    out = bytearray()
    previous = b""  # the line break written for the last LF, while it is still the last thing
    for byte in body:
        if byte != 0x0A:
            out.append(byte)
            previous = b""
            continue
        if style == "crlf":
            choice = b"\r\n"
        elif style == "cr":
            choice = b"\r"
        else:
            # After a lone CR the next break must not start with LF, or the two would read as one
            # CRLF and an empty line (the end of an event) would disappear.
            options = [b"\r", b"\r\n"] if previous == b"\r" else [b"\n", b"\r\n", b"\r"]
            choice = rng.choice(options)
        out += choice
        previous = choice
    return bytes(out) + tail


def random_stream(seed: int) -> tuple[bytes, list[SseEvent], str]:
    """`(bytes, events, style)`: events written by `encode`, with pings, in a line-break style."""
    rng = random.Random(f"stream-{seed}")
    events = [random_event(rng) for _ in range(rng.randint(2, 14))]
    pieces: list[bytes] = []
    for position, event in enumerate(events):
        wire = encode(event)
        assert wire is not None
        pieces.append(wire)
        if position < len(events) - 1 and rng.random() < 0.35:
            pieces.append(PING)
    style = STYLES[seed % len(STYLES)]
    return restyle(rng, b"".join(pieces), style), events, style


def assert_events_match(parsed: list[RawEvent], events: list[SseEvent]) -> None:
    """The parsed stream is the events that were written: names, order and JSON content."""
    assert [event.event for event in parsed] == [event.event_name for event in events]
    for raw, model in zip(parsed, events, strict=True):
        assert json.loads(raw.data) == model.dump()


# --- the shared fixture -------------------------------------------------------------------


def test_the_fixture_has_every_feature_the_cuts_need() -> None:
    raw = read_fixture()
    assert b"\r\n" in raw and b"\n" in raw.replace(b"\r\n", b"")
    assert b": ping" in raw
    assert any(byte >= 0x80 for byte in raw)
    assert "\u2028".encode() in raw
    assert b"event: notice" in raw
    # Characters of 2, 3 and 4 bytes are all present, so a cut can fall inside each width.
    text = raw.decode("utf-8")
    widths = {len(char.encode()) for char in text}
    assert {1, 2, 3, 4} <= widths


def test_the_fixture_reads_the_same_at_every_single_cut() -> None:
    raw = read_fixture()
    whole = parse_stream(raw)
    assert [event.event for event in whole][0] == "started"
    assert [event.event for event in whole][-1] in {"done", "error"}
    for offset in range(len(raw) + 1):
        assert read_in_chunks(cut_at(raw, offset)) == whole, offset


def test_the_fixture_reads_the_same_one_byte_at_a_time() -> None:
    raw = read_fixture()
    assert read_in_chunks(raw[i : i + 1] for i in range(len(raw))) == parse_stream(raw)


def test_the_fixture_reads_the_same_at_every_pair_of_cuts_near_a_break_or_a_wide_character() -> (
    None
):
    raw = read_fixture()
    whole = parse_stream(raw)
    near = interesting_offsets(raw)
    assert len(near) > 100
    for first, second in itertools.combinations_with_replacement(near, 2):
        assert read_in_chunks(cut_at(raw, first, second)) == whole, (first, second)


@pytest.mark.parametrize("seed", range(SEEDS))
def test_the_fixture_reads_the_same_at_random_partitions(seed: int) -> None:
    raw = read_fixture()
    whole = parse_stream(raw)
    rng = random.Random(f"fixture-{seed}")
    for _ in range(25):
        assert read_in_chunks(random_partition(rng, raw)) == whole


def test_a_stream_that_stops_at_any_byte_gives_a_prefix_of_the_events_and_never_a_partial_one() -> (
    None
):
    raw = read_fixture()
    whole = parse_stream(raw)
    for stop in range(len(raw) + 1):
        events = read_in_chunks([raw[:stop]])
        assert events == whole[: len(events)], stop
        assert events == parse_stream(raw[:stop]), stop
        # Cut in two and stopped: the same prefix, so the decoder holding half a character at the
        # end does not turn it into an event or an exception.
        half = max(stop - 1, 0)
        assert read_in_chunks(cut_at(raw[:stop], half)) == events, stop


# --- streams written by `encode` ----------------------------------------------------------


@pytest.mark.parametrize("seed", range(SEEDS))
def test_a_stream_written_by_encode_reads_back_the_same_events_at_every_single_cut(
    seed: int,
) -> None:
    raw, events, _style = random_stream(seed)
    whole = parse_stream(raw)
    assert_events_match(whole, events)
    for offset in range(len(raw) + 1):
        assert read_in_chunks(cut_at(raw, offset)) == whole, (seed, offset)


@pytest.mark.parametrize("seed", range(SEEDS))
def test_a_stream_written_by_encode_reads_back_the_same_events_with_other_cuts(seed: int) -> None:
    raw, events, _style = random_stream(seed)
    whole = parse_stream(raw)
    assert read_in_chunks(raw[i : i + 1] for i in range(len(raw))) == whole
    rng = random.Random(f"cuts-{seed}")
    for _ in range(30):
        assert read_in_chunks(random_partition(rng, raw)) == whole
    near = interesting_offsets(raw)
    pairs = list(itertools.combinations_with_replacement(near, 2))
    for first, second in rng.sample(pairs, min(len(pairs), 400)):
        assert read_in_chunks(cut_at(raw, first, second)) == whole, (first, second)
    assert_events_match(read_in_chunks(random_partition(rng, raw)), events)


@pytest.mark.parametrize("seed", range(SEEDS))
def test_the_line_break_style_does_not_change_the_events(seed: int) -> None:
    """The same events written in LF, CRLF, CR and mixed style read back identically."""
    raw, events, style = random_stream(seed)
    rng = random.Random(f"style-{seed}")
    unstyled = re.sub(rb"\r\n|\r", b"\n", raw[:-2]) + raw[-2:]
    for other in STYLES:
        variant = restyle(random.Random(f"{seed}-{other}"), unstyled, other)
        assert_events_match(parse_stream(variant), events)
        assert_events_match(read_in_chunks(random_partition(rng, variant)), events)
    assert style in STYLES


def test_the_random_streams_reach_every_style_event_kind_and_character_width() -> None:
    styles: set[str] = set()
    names: set[str] = set()
    widths: set[int] = set()
    has_crlf = has_lone_cr = has_ping = has_2028 = has_0085 = False
    total_cuts = 0
    for seed in range(SEEDS):
        raw, events, style = random_stream(seed)
        styles.add(style)
        names |= {event.event_name for event in events}
        widths |= {len(char.encode()) for char in raw.decode("utf-8")}
        has_crlf |= b"\r\n" in raw
        has_lone_cr |= re.search(rb"\r(?!\n)", raw) is not None
        has_ping |= PING in raw or b": ping" in raw
        has_2028 |= "\u2028".encode() in raw
        has_0085 |= "\u0085".encode() in raw
        total_cuts += len(raw) + 1
    assert styles == set(STYLES)
    assert names == {"started", "stage", "diagnostics", "done", "error"}
    assert widths >= {1, 2, 3, 4}
    assert has_crlf and has_lone_cr and has_ping and has_2028 and has_0085
    assert total_cuts > 20_000


# --- negative controls: the harness must catch readers that are wrong ------------------------


class DecodesEachChunkAlone(ChunkedParser):
    """Wrong: a half character at the end of a chunk is decoded by itself."""

    def __init__(self) -> None:
        super().__init__()
        self._decoder = codecs.getincrementaldecoder("utf-8")("replace")

    def push(self, chunk: bytes) -> list[RawEvent]:
        self._decoder.reset()
        return super().push(chunk)


class EndsLinesOnATrailingCR(ChunkedParser):
    """Wrong: a CR at the end of a chunk is a line break even if an LF follows."""

    def push(self, chunk: bytes) -> list[RawEvent]:
        self._buffer += self._decoder.decode(chunk)
        events: list[RawEvent] = []
        position = 0
        while (match := LINE_END.search(self._buffer, position)) is not None:
            event = self._line(self._buffer[position : match.start()])
            position = match.end()
            if event is not None:
                events.append(event)
        self._buffer = self._buffer[position:]
        return events


class ReadsEachChunkAsAWholeStream:
    """Wrong: every chunk is parsed alone, so an event cut in two is lost."""

    def push(self, chunk: bytes) -> list[RawEvent]:
        return parse_stream(chunk) if chunk else []

    def finish(self) -> None:
        return None


class BreaksLinesLikeSplitlines(ChunkedParser):
    """Wrong: U+2028, U+2029 and U+0085 end a line (what `str.splitlines()` does)."""

    line_end = re.compile(r"\r\n|\r|\n|\u2028|\u2029|\u0085")


@pytest.mark.parametrize(
    "broken",
    [DecodesEachChunkAlone, EndsLinesOnATrailingCR, ReadsEachChunkAsAWholeStream],
    ids=lambda cls: cls.__name__,
)
def test_the_harness_catches_a_reader_that_does_not_survive_cuts(broken: Reader) -> None:
    raw = read_fixture()
    assert read_in_chunks([raw], broken) == parse_stream(raw)  # fine when never cut
    assert first_mismatch(raw, broken) is not None


def test_the_harness_catches_a_reader_that_breaks_lines_like_splitlines_even_uncut() -> None:
    """The ledger's warning: U+2028 inside the data must not end a line."""
    raw = read_fixture()
    assert "\u2028" in raw.decode("utf-8")
    assert read_in_chunks([raw], BreaksLinesLikeSplitlines) != parse_stream(raw)
    assert first_mismatch(raw, BreaksLinesLikeSplitlines) is not None


def test_each_broken_reader_also_fails_on_a_random_stream_not_only_on_the_fixture() -> None:
    for broken in (DecodesEachChunkAlone, EndsLinesOnATrailingCR, ReadsEachChunkAsAWholeStream):
        failing = 0
        for seed in range(SEEDS):
            raw, _events, _style = random_stream(seed)
            rng = random.Random(f"negative-{seed}")
            whole = parse_stream(raw)
            failing += any(
                read_or_error(random_partition(rng, raw), broken) != whole for _ in range(5)
            )
        assert failing >= 5, broken.__name__


def test_the_good_reader_passes_the_same_harness() -> None:
    assert first_mismatch(read_fixture(), ChunkedParser) is None
