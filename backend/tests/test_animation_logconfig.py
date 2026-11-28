"""Tests for `app/ai/animation/logconfig.py`: the INFO lines of a run must reach the process log.

Why: task 16.4 found that nothing configures logging in `app/main.py` or the Dockerfile. uvicorn
only sets up its own loggers, so under `uvicorn app.main:app` the root logger has no handler and a
level of WARNING, and every `animation.start`, `animation.attempt` and `animation.end` line (level
INFO on `lore.animation`) would be dropped: the feature would run blind in production. Task 18.3
closes that gap with `configure_animation_logging()`, called once at startup (the lifespan). These
tests prove the choice made there:

1. the function itself, on scratch loggers: INFO level, one handler that writes the message as it
   is, no second handler on a second call, no handler when an ancestor already has one (so nothing
   is printed twice), an existing lower level kept;
2. what it leaves alone: `propagate`, the root logger, the `uvicorn*` loggers and `lore.ai`;
3. when it runs: at startup (the lifespan), never at import time or when the app is only built;
4. end to end in a fresh Python process, the only place where the root logger really has no
   handler (inside pytest it always has): a full animation run prints its three JSON lines once
   each on stderr after startup, prints nothing when startup never ran, and prints nothing twice
   when the root logger was configured by someone else.

The scratch loggers have `propagate = False`, because inside pytest the root logger has handlers
and `hasHandlers()` would otherwise be true for every logger.
"""

from __future__ import annotations

import io
import json
import logging
import os
import subprocess
import sys
import textwrap
import uuid
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

import app.main as main_module
from app.ai.animation import logging_ as logging_module
from app.ai.animation.logconfig import configure_animation_logging
from app.ai.animation.logging_ import json_line

BACKEND_DIR = Path(__file__).resolve().parent.parent
LINE = {"event": "animation.start", "kind": "lesson", "cached": False}
WATCHED = ("", "uvicorn", "uvicorn.error", "uvicorn.access", "lore.ai")


def scratch_logger(parent: logging.Logger | None = None) -> logging.Logger:
    """A new logger that does not reach the root logger, with no level of its own."""
    name = f"scratch-logconfig.{uuid.uuid4().hex}"
    target = logging.getLogger(f"{parent.name}.{name}" if parent is not None else name)
    target.propagate = parent is not None
    target.setLevel(logging.NOTSET)
    return target


def snapshot(name: str) -> tuple[int, list[logging.Handler], bool]:
    target = logging.getLogger(name)
    return target.level, list(target.handlers), target.propagate


@pytest.fixture
def real_logger_restored() -> Any:
    """The real `lore.animation` logger is process-wide, so put it back as it was."""
    logger = logging_module.logger
    saved = (logger.level, list(logger.handlers))
    yield logger
    logger.setLevel(saved[0])
    logger.handlers[:] = saved[1]


# --- the function --------------------------------------------------------------------------------


def test_it_sets_info_and_adds_one_handler_that_writes_the_json_line_as_it_is() -> None:
    target = scratch_logger()
    buffer = io.StringIO()
    configure_animation_logging(target=target, stream=buffer)

    assert target.level == logging.INFO
    assert len(target.handlers) == 1
    target.info(json_line(LINE))
    target.debug("below INFO: dropped")
    assert buffer.getvalue() == json_line(LINE) + "\n"  # no prefix, no timestamp, one line
    assert json.loads(buffer.getvalue()) == LINE


def test_a_second_call_adds_nothing_and_a_line_is_still_printed_once() -> None:
    target = scratch_logger()
    buffer = io.StringIO()
    for _ in range(3):
        configure_animation_logging(target=target, stream=buffer)
    assert len(target.handlers) == 1
    target.info(json_line(LINE))
    assert buffer.getvalue().count("\n") == 1


def test_it_adds_no_handler_when_an_ancestor_has_one_so_nothing_prints_twice() -> None:
    parent = scratch_logger()
    seen = io.StringIO()
    handler = logging.StreamHandler(seen)
    handler.setFormatter(logging.Formatter("%(message)s"))
    parent.addHandler(handler)
    child = scratch_logger(parent)
    own = io.StringIO()

    configure_animation_logging(target=child, stream=own)

    assert child.handlers == []
    assert child.level == logging.INFO  # the level is still set, so INFO reaches the ancestor
    child.info(json_line(LINE))
    assert seen.getvalue() == json_line(LINE) + "\n"
    assert own.getvalue() == ""


@pytest.mark.parametrize(
    ("before", "after"),
    [
        (logging.NOTSET, logging.INFO),
        (logging.WARNING, logging.INFO),
        (logging.ERROR, logging.INFO),
        (logging.INFO, logging.INFO),
        (logging.DEBUG, logging.DEBUG),  # an operator who asked for more keeps it
    ],
)
def test_the_level_becomes_info_unless_it_is_already_that_low(before: int, after: int) -> None:
    target = scratch_logger()
    target.setLevel(before)
    configure_animation_logging(target=target, stream=io.StringIO())
    assert target.level == after


def test_it_leaves_propagation_the_root_and_the_other_loggers_alone(
    real_logger_restored: logging.Logger,
) -> None:
    others = {name: snapshot(name) for name in WATCHED}
    propagate = real_logger_restored.propagate

    configure_animation_logging()  # the real logger, as the application calls it

    assert real_logger_restored.propagate is propagate is True
    assert real_logger_restored.level == logging.INFO
    # Inside pytest the root logger has handlers, so no handler of its own is added here.
    assert real_logger_restored.handlers == []
    assert {name: snapshot(name) for name in WATCHED} == others


# --- when it runs --------------------------------------------------------------------------------


def test_it_runs_at_startup_and_not_when_the_application_is_only_built(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[int] = []
    monkeypatch.setattr(main_module, "configure_animation_logging", lambda: calls.append(1))
    monkeypatch.delenv("PGHOST", raising=False)

    application = main_module.create_app()
    assert calls == []  # building the app changes no process-wide logging state
    with TestClient(application):
        assert calls == [1]  # startup
    assert calls == [1]


# --- a fresh process: the real situation of production -------------------------------------------

RUN_SCRIPT = textwrap.dedent(
    """
    import json, logging, sys
    import pytest
    from fastapi.testclient import TestClient
    from tests.animation_agent_support import fenced, source, verified
    from tests.animation_endpoint_support import PATH, build_world, request_body

    mode = sys.argv[1]
    if mode == "root-configured":
        logging.basicConfig(stream=sys.stderr, format="%(message)s")  # someone else's setup
    root_handlers = len(logging.getLogger().handlers)
    uvicorn_before = [
        (logging.getLogger(n).level, len(logging.getLogger(n).handlers))
        for n in ("uvicorn", "uvicorn.error", "uvicorn.access")
    ]
    world = build_world(pytest.MonkeyPatch(), gemini=[fenced(source(1))], verifier=[verified()])
    client = TestClient(world.app)
    if mode != "no-startup":
        client.__enter__()  # the lifespan: this is the startup that sets logging up
    response = client.post(PATH, json=request_body())
    uvicorn_after = [
        (logging.getLogger(n).level, len(logging.getLogger(n).handlers))
        for n in ("uvicorn", "uvicorn.error", "uvicorn.access")
    ]
    print(json.dumps({
        "status": response.status_code,
        "events": response.text.count("event: "),
        "root_handlers_at_start": root_handlers,
        "uvicorn_untouched": uvicorn_before == uvicorn_after,
        "animation_handlers": len(logging.getLogger("lore.animation").handlers),
    }))
    """
)


def run_fresh_process(mode: str) -> tuple[dict[str, Any], list[dict[str, Any]], str]:
    """Run `RUN_SCRIPT` in a new interpreter: its stdout result, its stderr JSON lines, stderr."""
    env = {key: value for key, value in os.environ.items() if key != "PGHOST"}
    done = subprocess.run(
        [sys.executable, "-c", RUN_SCRIPT, mode],
        cwd=BACKEND_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert done.returncode == 0, done.stderr
    result = json.loads(done.stdout)
    lines = [json.loads(line) for line in done.stderr.splitlines() if line.startswith("{")]
    return result, lines, done.stderr


def test_after_startup_a_full_run_prints_its_three_lines_once_each_on_stderr() -> None:
    result, lines, stderr = run_fresh_process("startup")
    assert result["status"] == 200 and result["events"] == 6  # a real run, not a refusal
    assert result["root_handlers_at_start"] == 0  # the situation under `uvicorn app.main:app`
    assert result["animation_handlers"] == 1
    assert result["uvicorn_untouched"] is True
    assert [line["event"] for line in lines] == [
        "animation.start",
        "animation.attempt",
        "animation.end",
    ]
    assert (lines[0]["kind"], lines[0]["cached"]) == ("lesson", False)
    assert (lines[1]["outcome"], lines[2]["code"], lines[2]["attempts"]) == ("verified", "OK", 1)
    assert stderr.count("\n") == 3  # every line of stderr is one of the three, none twice


def test_without_the_startup_the_info_lines_are_dropped() -> None:
    """The finding of task 16.4, as a control: no configuration means a blind production."""
    result, lines, stderr = run_fresh_process("no-startup")
    assert result["status"] == 200 and result["events"] == 6
    assert result["animation_handlers"] == 0
    assert lines == [] and stderr == ""


def test_when_the_root_logger_is_configured_by_someone_else_nothing_prints_twice() -> None:
    result, lines, stderr = run_fresh_process("root-configured")
    assert result["root_handlers_at_start"] == 1
    assert result["animation_handlers"] == 0  # no second handler: the root one carries the lines
    assert [line["event"] for line in lines] == [
        "animation.start",
        "animation.attempt",
        "animation.end",
    ]
    assert stderr.count("\n") == 3
