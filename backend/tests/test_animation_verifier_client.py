"""Tests for the verifier Lambda client (`app.ai.animation.verifier_client`).

Why: the client decides whether a failed verification is the model's fault (repair) or the
infrastructure's (stop), it must never block the event loop, and its log must never carry a
source, a token or a Diagnostic message (Requirements 14.1 to 14.5, 14.7 to 14.9, 14.12, 14.13,
15.8, 15.17 and 41.1, design 6.7). `boto3` and `botocore` are not installed in the sandbox, so
everything here runs against fakes with the shape of the boto3 Lambda client. That is the point of
the design: the fake needs only `invoke(**kwargs)`, and the real package is imported in one
place only.

What is real in these tests:

- the worker thread, the `asyncio` task and its cancellation (`invoke` is awaited in a real event
  loop and the fake blocks a real thread on a `threading.Event`);
- `AiLimiter`, taken and released the way the endpoint's slot lease will do it;
- the lazy import: a subprocess with an import blocker, and an AST scan of the module.

Blocking fakes wait on an event that the test sets when it is done, not on a long sleep. Each
coroutine releases its fake in a `finally`, because `asyncio.run` joins its worker threads at
shutdown and a thread stuck in a fake would hang the run.

What is NOT proved here [belum diverifikasi]: that the keyword names (`FunctionName`,
`InvocationType`, `Payload`), the `FunctionError` key, `Payload.read()` and the
`Config(retries=...)` meaning match the installed botocore. Run once online with the pinned
boto3: `cd backend && .venv/bin/python -c "import boto3; boto3.client('lambda',
region_name='ap-southeast-3')"` and inspect `client.meta.service_model.operation_model('Invoke')`.
"""

from __future__ import annotations

import ast
import asyncio
import inspect
import json
import logging
import subprocess
import sys
import textwrap
import threading
import time
import types
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from contextlib import suppress
from pathlib import Path
from typing import Any

import pytest

from app.ai.animation import verifier_client
from app.ai.animation.verifier_client import (
    LOG_ITEMS_MAX,
    PAYLOAD_KEYS,
    REASONS,
    LambdaOutcome,
    LambdaVerifierClient,
    VerifierPort,
    build_payload,
)
from app.ai.limits import AiLimiter, AiLimits

BACKEND_DIR = Path(__file__).resolve().parent.parent
MODULE_PATH = BACKEND_DIR / "app" / "ai" / "animation" / "verifier_client.py"

FUNCTION_NAME = "lore-prod-animation-verifier"
REGION = "ap-southeast-3"

SOURCE_SENTINEL = "SOURCE-SENTINEL-7c1e"
TOKEN_SENTINEL = "TOKEN-SENTINEL-4b9d"
MESSAGE_SENTINEL = "MESSAGE-SENTINEL-d02f"
ERROR_SENTINEL = "LAMBDA-ERROR-SENTINEL-a55e"
EXCEPTION_SENTINEL = "EXCEPTION-SENTINEL-91c3"
BODY_SENTINEL = "BODY-SENTINEL-3e7a"
BUNDLE_SENTINEL = "BUNDLE-SENTINEL-6f20"

# --- builders -------------------------------------------------------------------------------

SUMMARY: dict[str, Any] = {
    "verifier_version": "0.1.0",
    "contract_version": 1,
    "runtime_version": {"react": "19.3.0", "remotion": "4.0.543"},
    "checks": [{"name": "size", "ok": True, "ms": 1}, {"name": "policy", "ok": True, "ms": 3}],
    "truncated": False,
}


def diagnostic(
    code: str = "POLICY_FORBIDDEN_IDENTIFIER",
    *,
    tool: str = "policy",
    severity: str = "error",
    message: str = "forbidden name",
) -> dict[str, Any]:
    return {"tool": tool, "code": code, "severity": severity, "line": 3, "message": message}


def ok_result(bundle: str = "export default function Main() { return null; }") -> dict[str, Any]:
    meta = {"width": 1280, "height": 720, "fps": 30, "durationInFrames": 90}
    return {"ok": True, "diagnostics": [], "bundle": bundle, "meta": meta, "summary": SUMMARY}


def failed_result(*items: dict[str, Any]) -> dict[str, Any]:
    return {"ok": False, "diagnostics": list(items) or [diagnostic()], "summary": SUMMARY}


def encode(value: Any) -> bytes:
    return json.dumps(value).encode("utf-8")


class FakeStream:
    """The `Payload` of an invoke response: `read()` and `close()`, with counters."""

    def __init__(self, body: Any) -> None:
        self._body = body
        self.reads = 0
        self.closed = False

    def read(self) -> Any:
        self.reads += 1
        if isinstance(self._body, Exception):
            raise self._body
        return self._body

    def close(self) -> None:
        self.closed = True


def answer(body: Any = b"", *, function_error: str | None = None, status: int = 200) -> Any:
    response: dict[str, Any] = {"StatusCode": status, "Payload": FakeStream(body)}
    if function_error is not None:
        response["FunctionError"] = function_error
    return response


class FakeLambda:
    """A Lambda client double: records every call, then answers or raises as told."""

    def __init__(self, respond: Callable[[dict[str, Any]], Any] | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self.threads: list[int] = []
        self._respond = respond or (lambda kwargs: answer(encode(ok_result())))

    def invoke(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        self.threads.append(threading.get_ident())
        return self._respond(kwargs)


class BlockingLambda(FakeLambda):
    """`invoke` blocks its thread until `release()` or until `limit` seconds have passed."""

    def __init__(self, limit: float = 5.0) -> None:
        super().__init__()
        self.entered = threading.Event()
        self.finished = threading.Event()
        self._gate = threading.Event()
        self._limit = limit

    def invoke(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        self.entered.set()
        try:
            self._gate.wait(self._limit)
            return answer(encode(ok_result()))
        finally:
            self.finished.set()

    def release(self) -> None:
        self._gate.set()


class ClientError(Exception):
    """Same shape as `botocore.exceptions.ClientError`: a `.response` dict, no botocore import."""

    def __init__(self, code: str, message: str = "boom") -> None:
        super().__init__(message)
        self.response = {
            "Error": {"Code": code, "Message": message},
            "ResponseMetadata": {"HTTPStatusCode": 400},
        }


# Named like the botocore classes; only the class name matters to the client.
class ReadTimeoutError(Exception): ...


class ConnectTimeoutError(Exception): ...


class EndpointConnectionError(Exception): ...


class NoCredentialsError(Exception): ...


class NoRegionError(Exception): ...


class ResponseStreamingError(Exception): ...


class WithBrokenResponse(Exception):
    response = "not a dict"


def make_payload(source: str = "export default 1;") -> dict[str, Any]:
    return build_payload(
        source=source,
        kind="lesson",
        required_tokens=["alpha", "beta"],
        forbidden_tokens=[],
        contract_version=1,
    )


def make_client(fake: Any, **options: Any) -> LambdaVerifierClient:
    return LambdaVerifierClient(FUNCTION_NAME, REGION, client=fake, **options)


async def wait_until(event: threading.Event, timeout: float = 2.0) -> None:
    """Wait for a thread's event without blocking the loop."""
    deadline = time.monotonic() + timeout
    while not event.is_set():
        assert time.monotonic() < deadline, "the worker thread never reached the fake"
        await asyncio.sleep(0.005)


class Ticker:
    """A task that sleeps in small steps and records how late the loop woke it up."""

    def __init__(self, interval: float = 0.01) -> None:
        self.interval = interval
        self.max_delay = 0.0
        self.ticks = 0
        self._task: asyncio.Task[None] | None = None

    async def _run(self) -> None:
        last = time.perf_counter()
        while True:
            await asyncio.sleep(self.interval)
            now = time.perf_counter()
            self.max_delay = max(self.max_delay, now - last - self.interval)
            self.ticks += 1
            last = now

    def start(self) -> None:
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with suppress(asyncio.CancelledError):
                await self._task


def log_records(caplog: pytest.LogCaptureFixture) -> list[dict[str, Any]]:
    return [
        json.loads(record.getMessage())
        for record in caplog.records
        if record.name == "lore.animation"
    ]


# --- the payload ----------------------------------------------------------------------------


def test_payload_has_exactly_the_five_keys_and_copies_the_token_lists() -> None:
    required = ["Vector", "Origin"]
    forbidden = ["Math.random"]
    payload = build_payload(
        source="src",
        kind="puzzle",
        required_tokens=required,
        forbidden_tokens=forbidden,
        contract_version=1,
    )
    required.append("added later")
    forbidden.clear()
    assert tuple(payload) == PAYLOAD_KEYS
    assert set(PAYLOAD_KEYS) == {
        "source",
        "kind",
        "required_tokens",
        "forbidden_tokens",
        "contract_version",
    }
    assert payload["required_tokens"] == ["Vector", "Origin"]
    assert payload["forbidden_tokens"] == ["Math.random"]


def test_invoke_sync_makes_the_documented_boto3_call() -> None:
    fake = FakeLambda()
    outcome = make_client(fake).invoke_sync(make_payload())
    assert outcome.kind == "result"
    assert len(fake.calls) == 1
    call = fake.calls[0]
    assert set(call) == {"FunctionName", "InvocationType", "Payload"}
    assert call["FunctionName"] == FUNCTION_NAME
    assert call["InvocationType"] == "RequestResponse"
    assert isinstance(call["Payload"], bytes)
    assert json.loads(call["Payload"]) == make_payload()


def test_tokens_are_identical_on_every_attempt_and_only_the_source_changes() -> None:
    required = ["Vector", "Origin"]
    forbidden = ["Math.random"]
    fake = FakeLambda()
    client = make_client(fake)
    for attempt, source in enumerate(["first", "second", "third"], start=1):
        payload = build_payload(
            source=source,
            kind="puzzle",
            required_tokens=required,
            forbidden_tokens=forbidden,
            contract_version=1,
        )
        client.invoke_sync(payload, attempt)
    sent = [json.loads(call["Payload"]) for call in fake.calls]
    assert [body["source"] for body in sent] == ["first", "second", "third"]
    assert all(set(body) == set(PAYLOAD_KEYS) for body in sent)
    for key in ("kind", "required_tokens", "forbidden_tokens", "contract_version"):
        assert len({json.dumps(body[key]) for body in sent}) == 1


def test_a_source_with_non_ascii_text_and_a_lone_surrogate_is_sent_without_error() -> None:
    source = "caf\u00e9 \U0001f600 \ud800 end"
    fake = FakeLambda()
    outcome = make_client(fake).invoke_sync(make_payload(source))
    assert outcome.kind == "result"
    body = fake.calls[0]["Payload"]
    body.decode("ascii")  # ASCII only, so encoding cannot fail
    assert json.loads(body)["source"] == source


@pytest.mark.parametrize(
    "payload",
    [
        {**make_payload(), "prompt": "extra"},
        {key: value for key, value in make_payload().items() if key != "kind"},
        {},
        "not a mapping",
        None,
    ],
    ids=["extra-key", "missing-key", "empty", "string", "none"],
)
def test_a_payload_that_is_not_the_five_keys_is_refused_before_any_call(payload: Any) -> None:
    fake = FakeLambda()
    outcome = make_client(fake).invoke_sync(payload)
    assert outcome == LambdaOutcome("unavailable", reason="bad_payload")
    assert fake.calls == []


def test_a_payload_that_cannot_be_encoded_is_refused_before_any_call() -> None:
    fake = FakeLambda()
    payload = {**make_payload(), "contract_version": object()}
    assert make_client(fake).invoke_sync(payload).reason == "bad_payload"
    assert fake.calls == []


# --- classification of the four outcomes ----------------------------------------------------


def test_a_valid_ok_result_is_a_result() -> None:
    fake = FakeLambda(lambda _: answer(encode(ok_result(BUNDLE_SENTINEL))))
    outcome = make_client(fake).invoke_sync(make_payload())
    assert outcome.kind == "result"
    assert outcome.reason is None
    assert outcome.result is not None
    assert outcome.result.ok is True
    assert outcome.result.bundle == BUNDLE_SENTINEL
    assert outcome.result.meta is not None
    assert outcome.result.meta.duration_in_frames == 90


def test_a_valid_failed_result_is_a_result_with_its_diagnostics() -> None:
    items = [
        diagnostic("POLICY_FORBIDDEN_IDENTIFIER"),
        diagnostic("VERIFIER_DEADLINE", tool="verifier"),
    ]
    fake = FakeLambda(lambda _: answer(encode(failed_result(*items))))
    outcome = make_client(fake).invoke_sync(make_payload())
    assert outcome.kind == "result"
    assert outcome.result is not None
    assert outcome.result.ok is False
    assert [item.code for item in outcome.result.diagnostics] == [
        "POLICY_FORBIDDEN_IDENTIFIER",
        "VERIFIER_DEADLINE",
    ]
    assert outcome.result.bundle is None


@pytest.mark.parametrize("flavour", ["Unhandled", "Handled"])
def test_function_error_is_its_own_outcome_and_the_body_is_never_read(flavour: str) -> None:
    body = encode(
        {"errorMessage": ERROR_SENTINEL, "stackTrace": [ERROR_SENTINEL], "errorType": "E"}
    )
    response = answer(body, function_error=flavour)
    outcome = make_client(FakeLambda(lambda _: response)).invoke_sync(make_payload())
    assert outcome == LambdaOutcome("function_error")
    assert response["Payload"].reads == 0
    assert response["Payload"].closed is True
    assert ERROR_SENTINEL not in repr(outcome)


UNAVAILABLE_ANSWERS: list[tuple[str, Callable[[], Any], str]] = [
    ("empty-body", lambda: answer(b""), "empty_payload"),
    ("blank-body", lambda: answer(b" \n\t"), "empty_payload"),
    ("empty-text", lambda: answer(""), "empty_payload"),
    ("html", lambda: answer(b"<html>502 Bad Gateway</html>"), "not_json"),
    ("invalid-utf8", lambda: answer(b"\x80\x81"), "not_json"),
    ("deeply-nested", lambda: answer(b"[" * 300_000), "not_json"),
    ("not-bytes", lambda: answer(12345), "not_json"),
    ("json-null", lambda: answer(b"null"), "bad_shape"),
    ("json-array", lambda: answer(b"[]"), "bad_shape"),
    ("json-string", lambda: answer(b'"ok"'), "bad_shape"),
    ("empty-object", lambda: answer(b"{}"), "bad_shape"),
    (
        "no-summary",
        lambda: answer(encode({k: v for k, v in ok_result().items() if k != "summary"})),
        "bad_shape",
    ),
    (
        "ok-without-bundle",
        lambda: answer(encode({k: v for k, v in ok_result().items() if k != "bundle"})),
        "bad_shape",
    ),
    (
        "failed-with-bundle",
        lambda: answer(encode({**failed_result(), "bundle": "export {}"})),
        "bad_shape",
    ),
    (
        "unknown-code-prefix",
        lambda: answer(encode(failed_result(diagnostic("NOPE_THING")))),
        "bad_shape",
    ),
    (
        "canvas-mismatch",
        lambda: answer(
            encode({**ok_result(), "meta": {**ok_result()["meta"], "width": 640}}),
        ),
        "bad_shape",
    ),
    ("status-202", lambda: answer(encode(ok_result()), status=202), "bad_status"),
    ("status-500", lambda: answer(encode(ok_result()), status=500), "bad_status"),
    ("no-payload", lambda: {"StatusCode": 200}, "bad_response"),
    ("payload-without-read", lambda: {"StatusCode": 200, "Payload": object()}, "bad_response"),
    ("not-a-mapping", lambda: "oops", "bad_response"),
    ("none", lambda: None, "bad_response"),
    ("stream-fails", lambda: answer(ResponseStreamingError("sentinel")), "network"),
]


@pytest.mark.parametrize(
    ("make_answer", "reason"),
    [pytest.param(make, reason, id=name) for name, make, reason in UNAVAILABLE_ANSWERS],
)
def test_an_unusable_answer_is_unavailable_with_a_reason(
    make_answer: Callable[[], Any], reason: str
) -> None:
    response = make_answer()
    outcome = make_client(FakeLambda(lambda _: response)).invoke_sync(make_payload())
    assert outcome == LambdaOutcome("unavailable", reason=reason)
    assert reason in REASONS


def test_the_response_stream_is_closed_on_every_path() -> None:
    bodies = [encode(ok_result()), b"", b"<html>", encode({"x": 1})]
    for body in bodies:
        response = answer(body)
        make_client(FakeLambda(lambda _, r=response: r)).invoke_sync(make_payload())
        assert response["Payload"].closed is True


# --- exceptions are classified by shape and class name, with no botocore import -------------

EXCEPTIONS: list[tuple[Exception, str]] = [
    (ClientError("TooManyRequestsException"), "throttled"),
    (ClientError("ThrottlingException"), "throttled"),
    (ClientError("AccessDeniedException"), "access_denied"),
    (ClientError("UnrecognizedClientException"), "access_denied"),
    (ClientError("ResourceNotFoundException"), "not_found"),
    (ClientError("ServiceException"), "service_error"),
    (ClientError("InvalidRequestContentException"), "client_error"),
    (ClientError("SomethingNew"), "client_error"),
    (ReadTimeoutError("read timed out"), "network"),
    (ConnectTimeoutError("connect timed out"), "network"),
    (EndpointConnectionError("no endpoint"), "network"),
    (ResponseStreamingError("broken stream"), "network"),
    (TimeoutError("timed out"), "network"),
    (ConnectionResetError("reset"), "network"),
    (NoCredentialsError("no credentials"), "credentials"),
    (NoRegionError("no region"), "config"),
    (WithBrokenResponse("odd"), "error"),
    (RuntimeError("anything"), "error"),
    (ValueError("anything"), "error"),
]


@pytest.mark.parametrize(
    ("exc", "reason"),
    [pytest.param(exc, reason, id=type(exc).__name__ + "-" + reason) for exc, reason in EXCEPTIONS],
)
def test_an_exception_from_invoke_is_unavailable_and_never_escapes(
    exc: Exception, reason: str
) -> None:
    def respond(_: dict[str, Any]) -> Any:
        raise exc

    outcome = make_client(FakeLambda(respond)).invoke_sync(make_payload())
    assert outcome == LambdaOutcome("unavailable", reason=reason)
    assert reason in REASONS


def test_every_reason_the_client_can_give_is_in_the_closed_set() -> None:
    given = {reason for _, _, reason in UNAVAILABLE_ANSWERS} | {r for _, r in EXCEPTIONS}
    assert given <= set(REASONS)
    assert len(REASONS) == len(set(REASONS))


# --- the boto3 client: lazy, created once, injectable ---------------------------------------


def test_the_client_is_created_once_and_reused() -> None:
    made: list[str] = []
    fake = FakeLambda()

    def factory(region: str) -> FakeLambda:
        made.append(region)
        return fake

    client = LambdaVerifierClient(FUNCTION_NAME, REGION, client_factory=factory)
    assert made == []  # nothing is built by construction
    for _ in range(3):
        assert client.invoke_sync(make_payload()).kind == "result"
    assert made == [REGION]
    assert len(fake.calls) == 3


def test_concurrent_first_calls_create_the_client_once() -> None:
    made: list[int] = []
    fake = FakeLambda()

    def slow_factory(region: str) -> FakeLambda:
        made.append(1)
        time.sleep(0.05)  # long enough for every thread to be waiting at the lock
        return fake

    client = LambdaVerifierClient(FUNCTION_NAME, REGION, client_factory=slow_factory)
    with ThreadPoolExecutor(max_workers=8) as pool:
        outcomes = list(pool.map(lambda _: client.invoke_sync(make_payload()), range(8)))
    assert [outcome.kind for outcome in outcomes] == ["result"] * 8
    assert len(made) == 1
    assert len(fake.calls) == 8


def test_a_factory_that_fails_is_unavailable_and_is_tried_again_next_time() -> None:
    attempts: list[int] = []
    fake = FakeLambda()

    def factory(region: str) -> FakeLambda:
        attempts.append(1)
        if len(attempts) == 1:
            raise ImportError(f"No module named 'boto3' {EXCEPTION_SENTINEL}")
        return fake

    client = LambdaVerifierClient(FUNCTION_NAME, REGION, client_factory=factory)
    first = client.invoke_sync(make_payload())
    assert first == LambdaOutcome("unavailable", reason="client_unavailable")
    assert EXCEPTION_SENTINEL not in repr(first)
    assert client.invoke_sync(make_payload()).kind == "result"
    assert len(attempts) == 2


def install_fake_boto(monkeypatch: pytest.MonkeyPatch) -> dict[str, list[Any]]:
    """Put fake `boto3` and `botocore.config` modules in `sys.modules` for one test."""
    seen: dict[str, list[Any]] = {"clients": []}

    class FakeConfig:
        def __init__(self, **kwargs: Any) -> None:
            self.kwargs = kwargs

    def client(service: str, config: Any = None) -> FakeLambda:
        seen["clients"].append((service, config))
        return FakeLambda()

    boto3 = types.ModuleType("boto3")
    boto3.client = client  # type: ignore[attr-defined]
    botocore = types.ModuleType("botocore")
    botocore.__path__ = []  # type: ignore[attr-defined]
    config = types.ModuleType("botocore.config")
    config.Config = FakeConfig  # type: ignore[attr-defined]
    botocore.config = config  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "boto3", boto3)
    monkeypatch.setitem(sys.modules, "botocore", botocore)
    monkeypatch.setitem(sys.modules, "botocore.config", config)
    return seen


def test_the_default_factory_builds_the_lambda_client_with_the_documented_config(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen = install_fake_boto(monkeypatch)
    client = LambdaVerifierClient(FUNCTION_NAME, REGION)
    assert seen["clients"] == []  # the import and the client wait for the first call
    assert client.invoke_sync(make_payload()).kind == "result"
    assert client.invoke_sync(make_payload()).kind == "result"
    assert len(seen["clients"]) == 1
    service, config = seen["clients"][0]
    assert service == "lambda"
    assert config.kwargs == {
        "region_name": REGION,
        "connect_timeout": 5,
        "read_timeout": 75,
        "retries": {"mode": "standard", "max_attempts": 2},
    }


def test_a_blank_region_is_refused_and_no_client_is_built(monkeypatch: pytest.MonkeyPatch) -> None:
    seen = install_fake_boto(monkeypatch)
    outcome = LambdaVerifierClient(FUNCTION_NAME, "  ").invoke_sync(make_payload())
    assert outcome == LambdaOutcome("unavailable", reason="client_unavailable")
    assert seen["clients"] == []


def test_a_missing_boto3_is_unavailable_not_a_crash(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "boto3", None)  # `import boto3` now raises ImportError
    client = LambdaVerifierClient(FUNCTION_NAME, REGION)
    assert client.invoke_sync(make_payload()) == LambdaOutcome(
        "unavailable", reason="client_unavailable"
    )


def cloud_sdk_imports(tree: ast.AST) -> list[tuple[str, str]]:
    """(enclosing function or `<module>`, imported module) for boto3, botocore and langgraph."""
    found: list[tuple[str, str]] = []

    def visit(node: ast.AST, scope: str) -> None:
        for child in ast.iter_child_nodes(node):
            inner = (
                child.name if isinstance(child, ast.FunctionDef | ast.AsyncFunctionDef) else scope
            )
            if isinstance(child, ast.Import):
                names = [alias.name for alias in child.names]
            elif isinstance(child, ast.ImportFrom):
                names = [child.module or ""]
            else:
                names = []
            for name in names:
                if name.split(".")[0] in {"boto3", "botocore", "langgraph"}:
                    found.append((scope, name))
            visit(child, inner)

    visit(tree, "<module>")
    return sorted(found)


def test_boto3_is_imported_in_one_function_and_botocore_exceptions_never() -> None:
    tree = ast.parse(MODULE_PATH.read_text(encoding="utf-8"))
    assert cloud_sdk_imports(tree) == [
        ("_default_client_factory", "boto3"),
        ("_default_client_factory", "botocore.config"),
    ]
    assert "botocore.exceptions" not in MODULE_PATH.read_text(encoding="utf-8")


def test_importing_and_constructing_the_client_loads_no_cloud_sdk() -> None:
    """Fresh interpreter with a blocker: any attempt to import the SDKs fails the run (41.1)."""
    code = textwrap.dedent(
        """
        import sys

        BLOCKED = ("boto3", "botocore", "langgraph")

        class Blocker:
            def find_spec(self, name, path=None, target=None):
                if name.split(".")[0] in BLOCKED:
                    raise AssertionError("imported " + name)
                return None

        sys.meta_path.insert(0, Blocker())
        from app.ai.animation import verifier_client

        verifier_client.LambdaVerifierClient("fn", "ap-southeast-3")
        loaded = [name for name in BLOCKED if name in sys.modules]
        assert not loaded, loaded
        """
    )
    done = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, cwd=BACKEND_DIR, check=False
    )
    assert done.returncode == 0, done.stderr


def test_the_client_fits_the_port_the_agent_depends_on() -> None:
    client = make_client(FakeLambda())
    assert isinstance(client, VerifierPort)
    assert inspect.iscoroutinefunction(LambdaVerifierClient.invoke)
    params = inspect.signature(LambdaVerifierClient.invoke).parameters
    assert params["remaining_ms"].kind is inspect.Parameter.KEYWORD_ONLY
    assert params["attempt"].default == 1


# --- async: thread, time budget, event loop, cancellation -----------------------------------


def test_invoke_runs_the_blocking_call_in_a_worker_thread() -> None:
    fake = FakeLambda()
    client = make_client(fake)

    async def scenario() -> tuple[LambdaOutcome, int]:
        return await client.invoke(make_payload(), remaining_ms=30_000), threading.get_ident()

    outcome, loop_thread = asyncio.run(scenario())
    assert outcome.kind == "result"
    assert fake.threads and fake.threads[0] != loop_thread


@pytest.mark.parametrize("remaining", [0, -1, -250.5, float("nan")])
def test_no_invocation_starts_when_no_time_is_left(remaining: float) -> None:
    fake = FakeLambda()
    outcome = asyncio.run(make_client(fake).invoke(make_payload(), remaining_ms=remaining))
    assert outcome == LambdaOutcome("timeout")
    assert fake.calls == []


def test_running_out_of_time_during_the_call_is_a_timeout_and_does_not_wait() -> None:
    fake = BlockingLambda()
    client = make_client(fake)

    async def scenario() -> tuple[LambdaOutcome, float, bool]:
        try:
            started = time.monotonic()
            outcome = await client.invoke(make_payload(), remaining_ms=100)
            elapsed = time.monotonic() - started
            still_blocked = not fake.finished.is_set()
        finally:
            fake.release()
        await wait_until(fake.finished)
        return outcome, elapsed, still_blocked

    outcome, elapsed, still_blocked = asyncio.run(scenario())
    assert outcome == LambdaOutcome("timeout")
    assert 0.09 <= elapsed < 1.0
    assert still_blocked, "the call returned only after the worker finished"


def test_a_slow_call_does_not_block_other_tasks_on_the_event_loop() -> None:
    fake = BlockingLambda()
    client = make_client(fake)
    ticker = Ticker()

    async def scenario() -> LambdaOutcome:
        ticker.start()
        task = asyncio.create_task(client.invoke(make_payload(), remaining_ms=30_000))
        try:
            await wait_until(fake.entered)
            await asyncio.sleep(0.3)  # the worker thread is blocked for this whole time
            assert not task.done()
            fake.release()
            return await task
        finally:
            fake.release()
            await ticker.stop()

    outcome = asyncio.run(scenario())
    assert outcome.kind == "result"
    assert ticker.ticks >= 10, "the ticker did not run while the call was blocked"
    assert ticker.max_delay < 0.1, f"the loop stalled for {ticker.max_delay:.3f}s"


def test_the_ticker_would_notice_a_call_that_blocks_the_loop() -> None:
    """Control for the test above: the same measurement does see a call made on the loop."""
    fake = BlockingLambda(limit=0.2)  # returns by itself after 0.2 s
    client = make_client(fake)
    ticker = Ticker()

    async def scenario() -> None:
        ticker.start()
        await asyncio.sleep(0.05)
        client.invoke_sync(make_payload())  # wrong on purpose: blocks the loop thread
        await asyncio.sleep(0.05)
        await ticker.stop()

    asyncio.run(scenario())
    assert ticker.max_delay >= 0.15


def test_cancelling_returns_at_once_and_gives_the_limiter_slot_back() -> None:
    limiter = AiLimiter(AiLimits())
    assert limiter.try_acquire("10.0.0.9") is None  # another request already holds a slot
    before = limiter.in_flight()
    assert before == 1
    fake = BlockingLambda(limit=5.0)  # the fake would block for up to 5 s
    client = make_client(fake)

    async def request() -> LambdaOutcome:
        # What the endpoint's slot lease does: take the slot, run, release in `finally`.
        assert limiter.try_acquire("10.0.0.1") is None
        try:
            return await client.invoke(make_payload(), remaining_ms=240_000)
        finally:
            limiter.release("10.0.0.1")

    async def scenario() -> tuple[float, int, int, bool]:
        task = asyncio.create_task(request())
        try:
            await wait_until(fake.entered)
            during = limiter.in_flight()
            started = time.monotonic()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            elapsed = time.monotonic() - started
            after = limiter.in_flight()
            worker_still_blocked = not fake.finished.is_set()
        finally:
            fake.release()
        await wait_until(fake.finished)
        return elapsed, during, after, worker_still_blocked

    elapsed, during, after, worker_still_blocked = asyncio.run(scenario())
    assert during == before + 1
    assert elapsed < 1.0
    assert after == before
    assert worker_still_blocked, "cancel waited for the worker thread instead of returning"
    assert limiter.in_flight() == before  # the late answer did not touch the limiter
    assert len(fake.calls) == 1  # and nothing was started after the cancel


def test_a_cancelled_call_drops_the_late_answer() -> None:
    fake = BlockingLambda()
    client = make_client(fake)

    async def scenario() -> list[LambdaOutcome]:
        results: list[LambdaOutcome] = []
        task = asyncio.create_task(client.invoke(make_payload(), remaining_ms=30_000))
        try:
            await wait_until(fake.entered)
            task.cancel()
            with suppress(asyncio.CancelledError):
                results.append(await task)
        finally:
            fake.release()
        await wait_until(fake.finished)
        await asyncio.sleep(0.05)  # let the loop process the late completion, if it would
        return results

    assert asyncio.run(scenario()) == []  # the cancelled caller never received an outcome


# --- the log --------------------------------------------------------------------------------

ALLOWED_LOG_KEYS = {
    "event",
    "endpoint",
    "attempt",
    "outcome",
    "latency_ms",
    "reason",
    "ok",
    "error_count",
    "warning_count",
    "items",
}


def sentinel_payload() -> dict[str, Any]:
    return build_payload(
        source=f"const secret = '{SOURCE_SENTINEL}';",
        kind="puzzle",
        required_tokens=[TOKEN_SENTINEL],
        forbidden_tokens=[f"{TOKEN_SENTINEL}-forbidden"],
        contract_version=1,
    )


def test_the_log_never_carries_source_tokens_messages_bodies_or_exception_text(
    caplog: pytest.LogCaptureFixture,
) -> None:
    def raises(_: dict[str, Any]) -> Any:
        raise ClientError("AccessDeniedException", EXCEPTION_SENTINEL)

    scenarios: list[Callable[[dict[str, Any]], Any]] = [
        lambda _: answer(encode(failed_result(diagnostic(message=MESSAGE_SENTINEL)))),
        lambda _: answer(encode(ok_result(BUNDLE_SENTINEL))),
        lambda _: answer(
            encode({"errorMessage": ERROR_SENTINEL, "stackTrace": [ERROR_SENTINEL]}),
            function_error="Unhandled",
        ),
        lambda _: answer(f"<html>{BODY_SENTINEL}</html>".encode()),
        lambda _: answer(encode({"note": BODY_SENTINEL})),
        raises,
    ]
    with caplog.at_level(logging.DEBUG):
        for respond in scenarios:
            make_client(FakeLambda(respond)).invoke_sync(sentinel_payload())
        asyncio.run(make_client(FakeLambda()).invoke(sentinel_payload(), remaining_ms=0))
    records = log_records(caplog)
    assert len(records) == len(scenarios) + 1
    for sentinel in (
        SOURCE_SENTINEL,
        TOKEN_SENTINEL,
        MESSAGE_SENTINEL,
        ERROR_SENTINEL,
        EXCEPTION_SENTINEL,
        BODY_SENTINEL,
        BUNDLE_SENTINEL,
    ):
        assert sentinel not in caplog.text
    for record in caplog.records:
        assert record.exc_info is None  # no traceback, which could echo a message
    for fields in records:
        assert set(fields) <= ALLOWED_LOG_KEYS
        assert fields["event"] == "animation.verifier"
        assert fields["endpoint"] == "animations"


def test_a_result_is_logged_with_counts_and_the_tool_and_code_of_each_diagnostic(
    caplog: pytest.LogCaptureFixture,
) -> None:
    items = [
        diagnostic("POLICY_FORBIDDEN_IDENTIFIER"),
        diagnostic("ESLINT_LORE_KIT_STYLE", tool="eslint", severity="warning"),
    ]
    fake = FakeLambda(lambda _: answer(encode(failed_result(*items))))
    with caplog.at_level(logging.DEBUG):
        make_client(fake).invoke_sync(make_payload(), 2)
    (fields,) = log_records(caplog)
    assert fields["attempt"] == 2
    assert fields["outcome"] == "result"
    assert fields["ok"] is False
    assert fields["error_count"] == 1
    assert fields["warning_count"] == 1
    assert fields["items"] == [
        {"tool": "policy", "code": "POLICY_FORBIDDEN_IDENTIFIER"},
        {"tool": "eslint", "code": "ESLINT_LORE_KIT_STYLE"},
    ]
    assert set(fields["items"][0]) == {"tool", "code"}


def test_the_log_lists_at_most_ten_diagnostics_but_counts_all(
    caplog: pytest.LogCaptureFixture,
) -> None:
    many = [diagnostic(f"POLICY_RULE_{n}") for n in range(12)]
    fake = FakeLambda(lambda _: answer(encode(failed_result(*many))))
    with caplog.at_level(logging.DEBUG):
        make_client(fake).invoke_sync(make_payload())
    (fields,) = log_records(caplog)
    assert fields["error_count"] == 12
    assert len(fields["items"]) == LOG_ITEMS_MAX == 10


def test_every_outcome_writes_one_line_with_its_level_and_reason(
    caplog: pytest.LogCaptureFixture,
) -> None:
    def raises(_: dict[str, Any]) -> Any:
        raise ClientError("TooManyRequestsException")

    cases: list[tuple[Callable[[dict[str, Any]], Any], str, str | None, int]] = [
        (lambda _: answer(encode(ok_result())), "result", None, logging.INFO),
        (lambda _: answer(b"{}", function_error="Unhandled"), "function_error", None, logging.INFO),
        (raises, "unavailable", "throttled", logging.WARNING),
        (lambda _: answer(b""), "unavailable", "empty_payload", logging.WARNING),
    ]
    for respond, outcome, reason, level in cases:
        caplog.clear()
        with caplog.at_level(logging.DEBUG):
            make_client(FakeLambda(respond)).invoke_sync(make_payload(), 4)
        (fields,) = log_records(caplog)
        assert fields["outcome"] == outcome
        assert fields.get("reason") == reason
        assert fields["attempt"] == 4
        assert caplog.records[0].levelno == level


def test_a_timeout_is_logged_with_the_attempt_number(caplog: pytest.LogCaptureFixture) -> None:
    fake = FakeLambda()
    with caplog.at_level(logging.DEBUG):
        asyncio.run(make_client(fake).invoke(make_payload(), remaining_ms=0, attempt=3))
    (fields,) = log_records(caplog)
    assert fields["outcome"] == "timeout"
    assert fields["attempt"] == 3
    assert fields["latency_ms"] == 0


def test_latency_comes_from_the_injected_clock(caplog: pytest.LogCaptureFixture) -> None:
    ticks = iter([10.0, 10.25])
    client = make_client(FakeLambda(), clock=lambda: next(ticks))
    with caplog.at_level(logging.DEBUG):
        client.invoke_sync(make_payload())
    (fields,) = log_records(caplog)
    assert fields["latency_ms"] == 250


def test_the_module_only_logs_through_the_animation_logger() -> None:
    assert verifier_client.logger.name == "lore.animation"
