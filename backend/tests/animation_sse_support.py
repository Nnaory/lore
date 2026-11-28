"""A small reference reader for the animation SSE stream, and the shared fixture it reads.

Why: the stream the backend writes and the parser the browser runs (`frontend/src/lib/animation/
sse-parser.ts`) must agree on every byte of the shared fixture `fixtures/animation/sse-stream.txt`
(Requirements 17.9 and 17.15). The backend does not read streams in production, so the reader here
exists only for tests: it is the second, independent implementation that the writer is checked
against. It follows the same rules as the frontend parser, written again from the SSE rules and not
from `sse.py`:

- a line ends at `\\r\\n`, `\\n` or `\\r` and at nothing else, so U+2028, U+2029, U+0085 and the
  other "newline-like" characters stay inside the data (this is why it does not use
  `str.splitlines()`, which also breaks at those);
- a line that starts with `:` is a comment (`: ping`) and is ignored;
- a line is `field: value`, split at the first colon, with one space after the colon removed; only
  `event` and `data` matter, every other field (`id`, `retry`, unknown ones) is ignored;
- a blank line ends an event. An event with no `data` line is dropped; the name defaults to
  `message`; several `data` lines are joined with `\\n`;
- text after the last line break (an unfinished line or event) is dropped, and so is a `\\r` that
  is the very last byte, because it could still be the first half of `\\r\\n`.

`parse_stream` reads the whole stream in one piece. The property test of task 18.2 cuts the same
bytes at every offset and feeds them to a chunked reader; it can import `parse_stream` as the
whole-stream answer.

The fixture is read with `read_bytes()` so no newline translation can touch it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

FIXTURE = Path(__file__).parent / "fixtures" / "animation" / "sse-stream.txt"

_LINE_END = re.compile(rb"\r\n|\r|\n")


@dataclass(frozen=True)
class RawEvent:
    """One event as the wire gave it: its name and its `data` text, before any JSON parsing."""

    event: str
    data: str


def read_fixture() -> bytes:
    """The shared stream, byte for byte."""
    return FIXTURE.read_bytes()


def parse_stream(raw: bytes) -> list[RawEvent]:
    """Every complete event of `raw`, in order; comments and ignored fields are skipped."""
    if raw.endswith(b"\r"):
        raw = raw[:-1]  # held: a final CR may be the start of CRLF
    events: list[RawEvent] = []
    name: str | None = None
    data: list[str] = []
    position = 0
    for match in _LINE_END.finditer(raw):
        line = raw[position : match.start()].decode("utf-8")
        position = match.end()
        if line == "":
            if data:
                events.append(RawEvent(name or "message", "\n".join(data)))
            name, data = None, []
        elif line.startswith(":"):
            continue
        else:
            field, colon, value = line.partition(":")
            if colon and value.startswith(" "):
                value = value[1:]
            if field == "event":
                name = value
            elif field == "data":
                data.append(value)
    return events
