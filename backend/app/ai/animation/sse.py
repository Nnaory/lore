"""Server-Sent Events for one animation run: wire format, slot lease, run handle and stream.

Why: `POST /api/v1/ai/animations` answers with a stream so the browser can show progress while the
agent works for up to four minutes (design D-8, 6.10, 10.4; Requirement 17). Everything that
touches the wire or the concurrency slot lives here, so the endpoint (task 18.3) only has to wire
a run to a response, and the rules can be tested without Gemini, AWS or a database.

The wire format (Requirement 17.2). Each event is written as

    event: <name>\\n
    data: <JSON on one line>\\n
    \\n

in UTF-8, with `ensure_ascii=False` and `separators=(',', ':')`. `json.dumps` escapes every control
character, so the data line never holds `\\n` or `\\r`; non-ASCII text (and U+2028, which a JSON
string may hold raw) goes out unescaped. The writer always uses `\\n`. The shared fixture
`backend/tests/fixtures/animation/sse-stream.txt` also holds `\\r\\n` on purpose, to prove the
client parser accepts all three separators; this module never reads a stream, so it has no line
splitting of its own, and it must never use `str.splitlines()`, which also breaks at U+2028.
`: ping\\n\\n` is a comment the client ignores. No event is larger than `MAX_EVENT_BYTES` (8192)
bytes, counted over the whole written event. `encode` returns `None` for one that is larger, and
the stream then leaves it out; a final event that is too large is replaced by the generic `error`
(`UNKNOWN`), so the stream still ends in exactly one final event.

What an event may carry (Requirement 17.7, 17.10): only the closed models of `models.py`, which
have no field for source code, prompts, tokens, keys, cookies, URLs or Diagnostic messages. The
`message` of an `error` event is one fixed sentence per code (`ERROR_MESSAGES`), never text from an
exception or from Gemini.

The pieces:

- `SlotLease` pairs one successful `AiLimiter.try_acquire` with exactly one `release`, however
  many places call `release` and from whichever thread (Requirement 15.7).
- `RunHandle` is one run as the stream sees it: the `started` event, the event queue the agent
  writes to (`emit` is the `RunContext.emit` callback), the coroutine that does the work, the lease
  and the log. `execute()` runs the work and queues exactly one final event (`done` or `error`),
  then `None` as the end marker. `close()` is the one clean-up: it sets the cancel flag, cancels the
  task and releases the lease, and it is safe to call any number of times from any exit path.
- `stream` is the async generator: `started` first and at once, then the queued events, `: ping`
  every `PING_INTERVAL_S` seconds (measured by an injected clock) while nothing was written, and
  nothing after the final event. Its `finally` calls `RunHandle.close()`.
- `AnimationStreamResponse` is the `StreamingResponse` around it. Its `finally` calls the same
  `close()`, because a generator that is suspended at a `yield` when the client leaves, or one
  that was never iterated because the first `send` failed, is only closed later by the garbage
  collector, and the slot must not wait for that.

The slot is therefore released in two places that both reach `SlotLease.release` (the generator's
`finally` and the response's `finally`). A `BackgroundTask` as a third place would only run when
the response ended normally, which the `finally` already covers, so there is none.

Cancellation: `close()` sets `RunHandle.cancelled` (the same `asyncio.Event` the endpoint hands to
`RunContext`, so a thread inside `store.publish` stops at its next S3 call) and cancels the task,
whose `CancelledError` the agent turns into the `CANCELLED` log line. An agent that returns
`UNKNOWN` while that flag is set is a run the client left: its answer is not sent (Requirement
13.15). The timeout of the agent also sets the flag, but with `ANIMATION_TIMEOUT`, which is sent.

Ping timing: the wait for the next event is `PING_INTERVAL_S` minus the time since the last write,
read from `clock`. The clock is read at the moment a chunk is handed to the transport (just before
the `yield`), so a test with a fake clock can move the clock between two `anext` calls. The wait
itself runs on the event loop's real time, as `asyncio.wait_for` does. Queued events always go out
before a ping.

Logging: only the class and place of an unexpected exception are logged, never its message
(Requirement 32.4). The `animation.*` JSON lines come from `RunLog` (`logging_.py`), shared with
the agent; this module only makes sure `animation.start` and `animation.end` exist even for a run
that never got to start (a cache hit, or a client that left right after `started`).

Imports: the standard library, Starlette, and the animation modules that do not load `langgraph`
or `boto3`.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import threading
import time
import traceback
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from typing import Any

from starlette.responses import StreamingResponse
from starlette.types import Receive, Scope, Send

from app.ai.animation.agent import AgentFailed, AgentPublished, AgentResult
from app.ai.animation.logging_ import END_CANCELLED, END_OK, RunLog
from app.ai.animation.models import (
    DoneEvent,
    ErrorCode,
    ErrorEvent,
    SseEvent,
    StartedEvent,
)
from app.ai.envelope import INTERNAL_ERROR_MESSAGE
from app.ai.limits import AiLimiter

logger = logging.getLogger("lore.ai")

# Requirement 17.5: no event is larger than this, counted over the whole written event.
MAX_EVENT_BYTES = 8192
# Requirement 17.6, 17.13: a comment line when nothing was written for this long.
PING_INTERVAL_S = 15.0
PING = b": ping\n\n"

MEDIA_TYPE = "text/event-stream; charset=utf-8"
STREAM_HEADERS: dict[str, str] = {
    "Cache-Control": "no-store, no-transform",
    "X-Accel-Buffering": "no",
}

# Event names are fixed by the models; the check keeps a bad name from becoming a second line.
_EVENT_NAME = re.compile(r"[a-z][a-z_]*")

# Requirement 17.10: one fixed sentence per code, no internal detail. The wording follows the
# "server message" column of design 11.1; `UNKNOWN` and `RATE_LIMITED` reuse the sentences the
# JSON endpoints already send.
ERROR_MESSAGES: dict[ErrorCode, str] = {
    "ANIMATION_VERIFICATION_FAILED": (
        "The animation could not be verified. The standard drawing will be used."
    ),
    "ANIMATION_TIMEOUT": "The animation took too long to make.",
    "ANIMATION_VERIFIER_UNAVAILABLE": "The animation checker is not available right now.",
    "ANIMATION_STORAGE_FAILED": "The animation could not be saved.",
    "ANIMATION_QUOTA_EXCEEDED": "The animation limit for this device has been reached.",
    "PROVIDER_UNAVAILABLE": "The AI provider is not available right now.",
    "RATE_LIMITED": "Too many AI requests. Wait a moment, then try again.",
    "UNKNOWN": INTERNAL_ERROR_MESSAGE,
}

# What the run does: returns the agent's result (or, for a cache hit, a result built from the row).
RunWork = Callable[[], Awaitable[AgentResult]]


# ---------------------------------------------------------------------------------------------
# Wire format
# ---------------------------------------------------------------------------------------------


def _wire(name: str, payload: Mapping[str, Any]) -> bytes:
    """The bytes of one event, with no size check."""
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return f"event: {name}\ndata: {data}\n\n".encode()


def format_event(name: str, payload: Mapping[str, Any]) -> bytes | None:
    """One event as written on the wire, or `None` if it must not be sent.

    `None` means the event is larger than `MAX_EVENT_BYTES`, the name is not a plain lowercase
    word, or the payload holds text that is not valid Unicode (a lone surrogate cannot be written
    as UTF-8). It never raises for those; a payload that is not JSON at all is a caller bug.
    """
    if _EVENT_NAME.fullmatch(name) is None:
        return None
    try:
        raw = _wire(name, payload)
    except UnicodeEncodeError:
        return None
    return raw if len(raw) <= MAX_EVENT_BYTES else None


def encode(event: SseEvent) -> bytes | None:
    """`event` as written on the wire (Requirement 17.2), or `None` if it must not be sent."""
    return format_event(event.event_name, event.dump())


def is_terminal(event: object) -> bool:
    """True for `done` and `error`, the two events that end a stream (Requirement 17.4)."""
    return isinstance(event, DoneEvent | ErrorEvent)


def unknown_error_event() -> ErrorEvent:
    """The generic final event for anything that went wrong outside the agent's own codes."""
    return ErrorEvent(code="UNKNOWN", message=ERROR_MESSAGES["UNKNOWN"], attempts=0)


# Fixed and small, so it is built once without the size check: the fallback must always go out.
_UNKNOWN_BYTES = _wire(ErrorEvent.event_name, unknown_error_event().dump())


def _chunk(event: SseEvent) -> bytes | None:
    """Wire bytes of `event`; a final event that is too large becomes the generic error."""
    data = encode(event)
    if data is None and is_terminal(event):
        return _UNKNOWN_BYTES
    return data


def _where(exc: BaseException) -> str:
    """`ExceptionClass at file:line in function`; never the message (it may quote user data)."""
    frames = traceback.extract_tb(exc.__traceback__)
    if not frames:
        return type(exc).__name__
    last = frames[-1]
    return f"{type(exc).__name__} at {last.filename}:{last.lineno} in {last.name}"


# ---------------------------------------------------------------------------------------------
# Slot lease
# ---------------------------------------------------------------------------------------------


class SlotLease:
    """One acquired concurrency slot that is given back exactly once, whoever asks.

    Build it right after a successful `limiter.try_acquire(ip)`. `release()` may be called from
    the generator, from the response, from a worker thread, any number of times: only the first
    call reaches `limiter.release`, so two leases of the same IP can never free each other's slot.
    """

    def __init__(self, limiter: AiLimiter, ip: str) -> None:
        self._limiter = limiter
        self._ip = ip
        self._released = False
        self._lock = threading.Lock()

    @property
    def released(self) -> bool:
        return self._released

    def release(self) -> None:
        with self._lock:
            if self._released:
                return
            self._released = True
        self._limiter.release(self._ip)


# ---------------------------------------------------------------------------------------------
# One run, as the stream sees it
# ---------------------------------------------------------------------------------------------


class RunHandle:
    """The started event, the event queue, the work, the lease and the log of one stream.

    `started` is the first event (`cached` true for an Idempotent_Hit). `work` returns an
    `AgentPublished` or `AgentFailed`; for a cache hit it returns an `AgentPublished` built from
    the registry row (`calls=0`), so `done` carries the recorded `attempts` of the row
    (Requirement 17.12). `lease` is `None` when no slot was taken (a cache hit). `log` is the same
    `RunLog` the agent writes to, so `animation.start` and `animation.end` appear once each.
    `cancelled` is the flag the endpoint also puts in `RunContext`; it is created here if omitted.

    One handle is one run, used by one event loop thread.
    """

    def __init__(
        self,
        *,
        started: StartedEvent,
        work: RunWork,
        lease: SlotLease | None = None,
        log: RunLog | None = None,
        cancelled: asyncio.Event | None = None,
    ) -> None:
        self.started = started
        self.lease = lease
        self.cancelled = cancelled if cancelled is not None else asyncio.Event()
        self.queue: asyncio.Queue[SseEvent | None] = asyncio.Queue()
        self._work = work
        self._log = log
        self._task: asyncio.Task[None] | None = None
        self._began = False  # `execute` has started running
        self._sealed = False  # the final event is queued: nothing may follow it
        self._closed = False

    # -- events ---------------------------------------------------------------------------

    def emit(self, event: SseEvent) -> None:
        """Queue an event for the stream. Never blocks; ignored after the final event or close.

        This is the `RunContext.emit` callback.
        """
        if self._sealed or self._closed:
            return
        self.queue.put_nowait(event)

    def _seal(self, event: SseEvent) -> None:
        """Queue the final event; no other event is accepted after it."""
        if self._sealed or self._closed:
            return
        self.queue.put_nowait(event)
        self._sealed = True

    # -- running --------------------------------------------------------------------------

    def start(self) -> asyncio.Task[None]:
        """Run `execute()` as a task owned by this handle (once)."""
        if self._task is None:
            self._task = asyncio.create_task(self.execute(), name="animation-run")
        return self._task

    async def execute(self) -> None:
        """Do the work, queue exactly one final event, then the end marker `None`.

        An unexpected exception becomes one `error` event with `UNKNOWN`. When the client left
        (the cancel flag is set) and the agent ended as `UNKNOWN`, nobody is listening and the
        answer is not sent (Requirement 13.15). Cancellation of the task is not caught.
        """
        self._began = True
        try:
            if self._log is not None:
                self._log.start()
            final = await self._final_event()
            if final is not None:
                self._seal(final)
        finally:
            self.queue.put_nowait(None)

    async def _final_event(self) -> SseEvent | None:
        try:
            result = await self._work()
            return self._to_event(result)
        except Exception as exc:  # the last line of defence: one end state, no leak
            logger.error("animation stream failed: %s", _where(exc))
            self._end_log(code="UNKNOWN", attempts=0, model=None)
            return unknown_error_event()

    def _to_event(self, result: AgentResult) -> SseEvent | None:
        if isinstance(result, AgentPublished):
            self._end_log(code=END_OK, attempts=result.calls, model=result.model)
            return DoneEvent(
                animation=result.reference,
                cached=self.started.cached,
                attempts=result.row.attempts,
            )
        if isinstance(result, AgentFailed):
            self._end_log(code=result.code, attempts=result.calls, model=result.model)
            if result.code == "UNKNOWN" and self.cancelled.is_set():
                return None
            return ErrorEvent(
                code=result.code,
                message=ERROR_MESSAGES[result.code],
                attempts=result.calls,
            )
        raise TypeError("the run returned neither AgentPublished nor AgentFailed")

    def _end_log(self, *, code: str, attempts: int, model: str | None) -> None:
        """`animation.end` once; a no-op when the agent already wrote it."""
        if self._log is not None:
            self._log.end(code=code, attempts=attempts, model=model)

    # -- clean-up -------------------------------------------------------------------------

    def close(self) -> None:
        """Stop the run and give the slot back. Idempotent; call it from every exit path.

        Sets the cancel flag, cancels the task, and releases the lease. A run that the agent never
        began (a cache hit, or a client that left right after `started`) gets its
        `animation.end` here as `CANCELLED`; a task the agent is running writes its own line, with
        the real counts, when the cancellation reaches it.
        """
        if not self._closed:
            self._closed = True
            self.cancelled.set()
            task = self._task
            if task is not None and not task.done():
                task.cancel()
            if (task is None or not self._began) and self._log is not None:
                self._log.end(code=END_CANCELLED, attempts=0, model=None)
        if self.lease is not None:
            self.lease.release()


# ---------------------------------------------------------------------------------------------
# The stream
# ---------------------------------------------------------------------------------------------


async def stream(
    run: RunHandle,
    *,
    ping_interval_s: float = PING_INTERVAL_S,
    clock: Callable[[], float] = time.monotonic,
) -> AsyncIterator[bytes]:
    """The bytes of one stream: `started`, the run's events, `: ping` while idle, one final event.

    `started` is yielded before anything else, and at once, which also shows that nothing buffers
    the response (Requirement 17.4). The run starts after it. Nothing is written after the final
    event, and a ping is never written after it (Requirement 17.13). Whatever ends this generator
    (the final event, an exception, `aclose()`, a cancellation) ends in `run.close()`.
    """
    try:
        first = _chunk(run.started)
        if first is None:  # unreachable for four small numbers; fail closed
            yield _UNKNOWN_BYTES
            return
        last_write = clock()
        yield first
        run.start()
        queue = run.queue
        while True:
            try:
                item = queue.get_nowait()
            except asyncio.QueueEmpty:
                wait = max(0.0, ping_interval_s - (clock() - last_write))
                try:
                    item = await asyncio.wait_for(queue.get(), wait)
                except TimeoutError:
                    last_write = clock()
                    yield PING
                    continue
            if item is None:
                break
            data = _chunk(item)
            if data is None:  # too large to send: leave it out
                continue
            last_write = clock()
            yield data
            if is_terminal(item):
                break
    finally:
        run.close()


class AnimationStreamResponse(StreamingResponse):
    """`StreamingResponse` for one run: SSE headers, and the run closed however the response ends.

    Status 200, `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-store,
    no-transform`, `X-Accel-Buffering: no` (Requirement 17.1). `close()` runs in a `finally` of
    `__call__`, so the slot is released and the agent cancelled when the client leaves, when the
    first `send` fails, and when the generator was never iterated (Requirement 15.7). It is
    synchronous on purpose: it must still work while the surrounding task is being cancelled.
    """

    def __init__(
        self,
        run: RunHandle,
        *,
        ping_interval_s: float = PING_INTERVAL_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        super().__init__(
            stream(run, ping_interval_s=ping_interval_s, clock=clock),
            status_code=200,
            headers=dict(STREAM_HEADERS),
            media_type=MEDIA_TYPE,
        )
        self._run = run

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            self._run.close()
