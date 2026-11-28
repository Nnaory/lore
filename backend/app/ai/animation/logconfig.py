"""Process log setup for the animation feature: let its INFO lines reach the container log.

Why: `logging_.py` writes `animation.start`, `animation.attempt`, `animation.end` and
`animation.verifier` at INFO on the logger `lore.animation`, and an operator follows a run from
those lines (Requirement 33). But uvicorn only configures its own loggers (`uvicorn`,
`uvicorn.error`, `uvicorn.access`), so a process started with `uvicorn app.main:app` has no handler
on the root logger, and `lore.animation` inherits the root level (WARNING). Every INFO line of this
feature would be dropped, and the feature would run blind in production (finding of task 16.4).

The fix is made in the application, at startup, and only for this feature's logger:

- the level of `lore.animation` becomes INFO, unless it is already INFO or lower;
- one `StreamHandler` is added, writing the message as it is (`%(message)s`: `logging_.json_line`
  already made it one JSON object per line), but only when neither the logger nor any ancestor has
  a handler. If someone configured the root logger (a `--log-config` file, `logging.basicConfig`, a
  test runner), the records propagate to that handler and no second one is added, so no line is
  printed twice. A handler added by an earlier call counts too, so calling this again changes
  nothing (the application is created many times in tests, and a server can restart its lifespan);
- `propagate` is left alone, so `caplog` and any root handler still see the records;
- no other logger is touched: not `uvicorn*`, not the root, not `lore.ai`.

Why the application and not a `--log-config` in the Dockerfile: it is testable here, it needs no
change to the image command or to `deploy/` (Requirement 36.10), and an operator who wants a
different format can still configure the root logger, which this function then respects.

Why the lifespan and not import time: `app.main` is imported by every test and tool, and importing
a module should not change process-wide logging. The lifespan runs once when the server starts.

Why stderr: it is the default stream of `StreamHandler`, the container runtime collects stdout and
stderr alike, and a program that prints its own result on stdout (a script, a test subprocess)
keeps stdout clean.

This module imports only the standard library and `logging_` (for the logger).
"""

from __future__ import annotations

import logging
from typing import TextIO

from app.ai.animation.logging_ import logger


def configure_animation_logging(
    *, target: logging.Logger | None = None, stream: TextIO | None = None
) -> None:
    """Let the INFO lines of `lore.animation` reach the process log. Safe to call many times.

    `target` and `stream` exist so a test can use a scratch logger and a buffer; the application
    calls it with no arguments.
    """
    chosen = target if target is not None else logger
    if chosen.level == logging.NOTSET or chosen.level > logging.INFO:
        chosen.setLevel(logging.INFO)
    if chosen.hasHandlers():
        return
    handler = logging.StreamHandler(stream)
    handler.setFormatter(logging.Formatter("%(message)s"))
    chosen.addHandler(handler)
