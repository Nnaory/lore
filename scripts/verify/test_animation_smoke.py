#!/usr/bin/env python3
"""Tests for scripts/verify/animation-smoke.py (task 37.1; Requirement 33.3 to 33.15).

Why: the smoke script is the release gate of the animation feature (operator step O-8) and it can
only be run against the real stack, so every path of it is proved here against a fake LORE: a
loopback `ThreadingHTTPServer` that serves the two sandbox files, the SSE stream of
`POST /api/v1/ai/animations`, the Reader and a fake S3 object. Nothing here touches the network
beyond 127.0.0.1, AWS or Gemini. The suite covers the exit codes 0, 1 and 2, every failing check,
the event order of Requirement 17, the 5 s and 300 s limits (with an injected clock and with real
short limits), the presigned URL shape (virtual-hosted host, `X-Amz-Expires=300`), the download of
`main.js` and its SHA-256, and the absence of secrets from stdout and stderr.

How the run is wired: `animation_smoke.run(..., env=Env(clock, fetch))` takes the clock and the
download as parameters. The fake S3 host is `<bucket>.s3.<region>.amazonaws.com`, so the test's
`fetch` maps it to the loopback server and then calls the script's own `fetch_object`. The exit
code 0 is therefore proved in-process (`run` and `main`), while the exit codes 1 and 2 are also
proved on a real child process, which shows `raise SystemExit(main())` works as the entry point.

Where it lives: the task text puts `SmokeScriptTest` in scripts/ci/test-checkers.py, but that file
was being edited by task 33.1 at the same time, so the class is here instead (design 14.6 allows "a
Python test of its own"). Run it with `python3 -B scripts/verify/test_animation_smoke.py -v` or
`python3 -B -m unittest discover -s scripts/verify -p 'test_*.py' -v`. To make
`python3 -B scripts/ci/test-checkers.py -v` run it too, add to test-checkers.py:
`sys.path.insert(0, str(REPO_ROOT / "scripts" / "verify"))` and
`from test_animation_smoke import SmokeScriptStaticTest, SmokeScriptTest  # noqa: E402,F401`.
"""

from __future__ import annotations

import ast
import hashlib
import importlib.util
import io
import json
import socket
import ssl
import subprocess
import sys
import threading
import time
import unittest
from collections.abc import Callable
from contextlib import redirect_stderr, redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, NamedTuple
from unittest import mock
from urllib.parse import urlsplit

VERIFY_DIR = Path(__file__).resolve().parent
REPO_ROOT = VERIFY_DIR.parent.parent
SCRIPT = VERIFY_DIR / "animation-smoke.py"
POLICY_FILE = REPO_ROOT / "frontend" / "src" / "lib" / "animation" / "sandbox-policy.json"
NEXT_CONFIG = REPO_ROOT / "frontend" / "next.config.ts"
REQUEST_FIXTURE = (
    REPO_ROOT / "backend" / "tests" / "fixtures" / "animation" / "request-valid-lesson-minimal.json"
)


def load_script() -> Any:
    """Import animation-smoke.py (its name has a hyphen) without running `main`."""
    spec = importlib.util.spec_from_file_location("animation_smoke", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["animation_smoke"] = module  # dataclasses look the module up by name
    spec.loader.exec_module(module)
    return module


smoke = load_script()
REAL_FETCH = (
    smoke.fetch_object
)  # `main` tests patch `smoke.fetch_object`; the mapping needs the real one

CHECKS = [
    "sandbox-runtime-html",
    "sandbox-runtime-js",
    "animation-create",
    "animation-reader",
    "animation-cached",
    "animation-other-owner",
]

# Values that must never appear in stdout or stderr. The bucket name holds an account id.
ACCOUNT_ID = "123456789012"
BUCKET_HOST = f"lore-prod-animations-{ACCOUNT_ID}.s3.ap-southeast-3.amazonaws.com"
SIGNATURE = "5ec2e7f0a1b64c3d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d"
CREDENTIAL = "AKIAFAKEFAKEFAKE0000"
BUNDLE_TEXT = "// BUNDLE-SENTINEL-7d1c\nexport const Main = () => null;\n"
BUNDLE = BUNDLE_TEXT.encode("utf-8")
BUNDLE_SHA = hashlib.sha256(BUNDLE).hexdigest()
SOURCE_SHA = hashlib.sha256(b"SOURCE-SENTINEL-4b2a").hexdigest()
SERVER_TEXT = "MESSAGE-SENTINEL-93ef what the server said"
FIXED_SENTINELS = (
    ACCOUNT_ID,
    BUCKET_HOST,
    SIGNATURE,
    CREDENTIAL,
    "BUNDLE-SENTINEL",
    "SOURCE-SENTINEL",
    "MESSAGE-SENTINEL",
    "X-Amz",
    "amazonaws",
    "Traceback",
)

Events = list[tuple[str, Any]]


def reference(n: int = 1) -> dict[str, Any]:
    return {
        "animation_id": f"a11ce000-0000-4000-8000-{n:012d}",
        "source_sha256": SOURCE_SHA,
        "bundle_sha256": BUNDLE_SHA,
        "width": 1280,
        "height": 720,
        "fps": 30,
        "duration_in_frames": 150,
        "contract_version": 1,
    }


def presigned(name: str = "main.js", *, host: str = BUCKET_HOST, expires: str = "300") -> str:
    key = f"animations/v1/{SOURCE_SHA[:2]}/{SOURCE_SHA}/{name}"
    return (
        f"https://{host}/{key}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential={CREDENTIAL}"
        f"%2F20261127%2Fap-southeast-3%2Fs3%2Faws4_request&X-Amz-Date=20261127T094103Z"
        f"&X-Amz-Expires={expires}&X-Amz-SignedHeaders=host&X-Amz-Signature={SIGNATURE}"
    )


# --- event builders ------------------------------------------------------------------------------
# Names that start with `!` are not events: the fake server acts on them while it writes the stream.


def started(cached: bool = False, max_attempts: int = 4) -> tuple[str, Any]:
    return "started", {"max_attempts": max_attempts, "deadline_ms": 240000, "cached": cached}


def stage(name: str, attempt: int) -> tuple[str, Any]:
    return "stage", {"stage": name, "attempt": attempt}


def diagnostics(attempt: int, ok: bool, items: list[dict[str, Any]] | None = None):
    items = items or []
    errors = 0 if ok else max(1, len(items))
    return "diagnostics", {
        "attempt": attempt,
        "ok": ok,
        "error_count": errors,
        "warning_count": 0,
        "items": items,
    }


def done(ref: dict[str, Any], *, cached: bool = False, attempts: int = 2) -> tuple[str, Any]:
    return "done", {"animation": ref, "cached": cached, "attempts": attempts}


def happy(ref: dict[str, Any]) -> Events:
    """A run that fails verification once and is published on the second attempt."""
    failed = [{"tool": "policy", "code": "POLICY_IMPORT_DISALLOWED", "line": 3}]
    return [
        started(),
        stage("generating", 1),
        ("!ping", None),
        stage("verifying", 1),
        diagnostics(1, False, failed),
        stage("repairing", 2),
        stage("verifying", 2),
        diagnostics(2, True),
        stage("publishing", 2),
        done(ref),
    ]


def one_attempt(ref: dict[str, Any]) -> Events:
    return [
        started(),
        stage("generating", 1),
        stage("verifying", 1),
        diagnostics(1, True),
        stage("publishing", 1),
        done(ref, attempts=1),
    ]


# --- the fake LORE -------------------------------------------------------------------------------


class FakeClock:
    """A clock the fake server can move forward, to make a reply late without sleeping."""

    def __init__(self) -> None:
        self._now = 1000.0
        self._reads = 0
        self._cond = threading.Condition()

    def __call__(self) -> float:
        with self._cond:
            self._reads += 1
            self._cond.notify_all()
            return self._now

    @property
    def reads(self) -> int:
        with self._cond:
            return self._reads

    def wait_next_read(self, after: int, timeout: float = 2.0) -> None:
        if after <= 0:
            return
        with self._cond:
            self._cond.wait_for(lambda: self._reads > after, timeout=timeout)

    def advance(self, seconds: float) -> None:
        with self._cond:
            self._now += seconds


class FakeLore:
    """The state and the knobs of the fake server; a test sets a knob before it runs the script."""

    def __init__(self) -> None:
        self.clock = FakeClock()
        self.release = threading.Event()  # set at the end of the test: lets a stalled reply go
        self.port = 0
        # What the server answers.
        self.html_status = 200
        self.csp_headers = [smoke.EXPECTED_CSP]
        self.nosniff_headers = ["nosniff"]
        self.js_status = 200
        self.js_size = 4096
        self.create_status = 200
        self.create_content_type = "text/event-stream; charset=utf-8"
        self.hang_before_headers = False
        self.issue_cookie = True
        self.first_events: Callable[[dict[str, Any]], Events] = happy
        self.cached_events: Callable[[dict[str, Any], int], Events] | None = None
        self.reader_status = 200
        self.reader_cache_control: str | None = "no-store"
        self.reader_raw: bytes | None = None
        self.reader_edit: Callable[[dict[str, Any]], None] | None = None
        self.leak_to_other_owner = False
        self.not_found_body = b'{"detail": "animation not found"}'
        self.s3_status = 200
        self.s3_body = BUNDLE
        self.s3_redirect = False
        # What the server saw.
        self.seen: list[tuple[str, str, str | None, str | None, str | None]] = []
        self.posts: list[Any] = []
        self.s3_requests: list[tuple[str, str | None]] = []
        self.fetched_hosts: list[str | None] = []
        self.tokens: list[str] = []
        self.entries: dict[str, dict[str, dict[str, Any]]] = {}  # token -> request key -> entry
        self._ids = 0
        self._lock = threading.Lock()

    def new_token(self) -> str:
        with self._lock:
            token = f"c00c1e00-0000-4000-8000-{len(self.tokens) + 1:012d}"
            self.tokens.append(token)
            return token

    def new_entry(self) -> dict[str, Any]:
        with self._lock:
            self._ids += 1
            return {"ref": reference(self._ids), "attempts": 2}

    def animation_ids(self) -> list[str]:
        return [e["ref"]["animation_id"] for owned in self.entries.values() for e in owned.values()]

    def requests(self, method: str, prefix: str) -> list[str]:
        return [path for m, path, *_ in self.seen if m == method and path.startswith(prefix)]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args: Any) -> None:
        pass

    @property
    def fake(self) -> FakeLore:
        return self.server.fake  # type: ignore[attr-defined]

    # -- helpers --

    def _owner(self) -> tuple[str, str | None]:
        """(token, token to put in Set-Cookie or None) from the Cookie header of the request."""
        cookie = self.headers.get("Cookie") or ""
        pairs = dict(p.strip().partition("=")[::2] for p in cookie.split(";") if p.strip())
        token = pairs.get("lore_device")
        if token is not None:
            return token, None
        token = self.fake.new_token()
        return token, token if self.fake.issue_cookie else None

    def _reply(
        self,
        status: int,
        body: bytes = b"",
        headers: list[tuple[str, str]] | None = None,
        content_type: str = "application/json",
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        for name, value in headers or []:
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def _chunk(self, data: bytes) -> None:
        self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
        self.wfile.flush()

    def _stream(self, events: Events, issued: str | None) -> None:
        self.send_response(200)
        self.send_header("Content-Type", self.fake.create_content_type)
        self.send_header("Cache-Control", "no-store, no-transform")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Transfer-Encoding", "chunked")
        if issued is not None:
            self.send_header("Set-Cookie", f"lore_device={issued}; HttpOnly; Path=/; SameSite=lax")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.flush()
        try:
            reads_after_started = 0
            for name, data in events:
                if name == "!advance":
                    if reads_after_started > 0:
                        self.fake.clock.wait_next_read(reads_after_started)
                    self.fake.clock.advance(data)
                elif name == "!stall":
                    self.fake.release.wait(timeout=data)
                    return
                elif name == "!ping":
                    self._chunk(b": ping\n\n")
                elif name == "!raw":
                    self._chunk(data)
                else:
                    if name == "started":
                        reads_after_started = self.fake.clock.reads
                    payload = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
                    self._chunk(f"event: {name}\ndata: {payload}\n\n".encode())
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except OSError:
            pass  # the script closed the connection first

    def _note(self, path: str) -> None:
        self.fake.seen.append(
            (
                self.command,
                path,
                self.headers.get("Cookie"),
                self.headers.get("Accept-Encoding"),
                self.headers.get("Accept"),
            )
        )

    # -- routes --

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        self._note(path)
        fake = self.fake
        if path == "/sandbox/runtime.html":
            headers = [("Content-Security-Policy", v) for v in fake.csp_headers]
            headers += [("X-Content-Type-Options", v) for v in fake.nosniff_headers]
            self._reply(fake.html_status, b"<html></html>", headers, "text/html")
        elif path == "/sandbox/runtime.js":
            self._reply(fake.js_status, b"x" * fake.js_size, content_type="text/javascript")
        elif path.startswith("/api/v1/animations/"):
            self._reader(path.rsplit("/", 1)[1])
        elif path.startswith("/fake-s3/"):
            fake.s3_requests.append((path, self.headers.get("Cookie")))
            if fake.s3_redirect:
                self._reply(302, b"", [("Location", "https://elsewhere.invalid/main.js")])
            else:
                self._reply(fake.s3_status, fake.s3_body, content_type="text/javascript")
        else:
            self._reply(404, b'{"detail": "Not Found"}')

    def _reader(self, animation_id: str) -> None:
        fake = self.fake
        token, issued = self._owner()
        headers = [("Set-Cookie", f"lore_device={issued}; Path=/")] if issued else []
        found = None
        pool = fake.entries.values() if fake.leak_to_other_owner else [fake.entries.get(token, {})]
        for owned in pool:
            for entry in owned.values():
                if entry["ref"]["animation_id"] == animation_id:
                    found = entry
        if found is None:
            self._reply(404, fake.not_found_body, headers)
            return
        if fake.reader_status != 200:
            self._reply(fake.reader_status, b'{"ok": false}', headers)
            return
        if fake.reader_cache_control is not None:
            headers.append(("Cache-Control", fake.reader_cache_control))
        envelope: dict[str, Any] = {
            "ok": True,
            "data": {
                "animation": found["ref"],
                "manifest": {"attempts": found["attempts"]},
                "urls": {"bundle": presigned("main.js"), "manifest": presigned("manifest.json")},
                "expires_in": 300,
            },
        }
        if fake.reader_edit is not None:
            fake.reader_edit(envelope)
        body = fake.reader_raw if fake.reader_raw is not None else json.dumps(envelope).encode()
        self._reply(200, body, headers)

    def do_POST(self) -> None:
        path = urlsplit(self.path).path
        self._note(path)
        fake = self.fake
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"null")
        fake.posts.append(body)
        if path != "/api/v1/ai/animations":
            self._reply(404, b'{"detail": "Not Found"}')
            return
        if fake.hang_before_headers:
            fake.release.wait(timeout=10)
            return
        if fake.create_status != 200:
            self._reply(fake.create_status, b'{"ok": false}')
            return
        token, issued = self._owner()
        owned = fake.entries.setdefault(token, {})
        key = json.dumps(body, sort_keys=True)
        if key in owned:
            entry = owned[key]
            builder = fake.cached_events
            events = builder(entry["ref"], entry["attempts"]) if builder else None
            if events is None:
                events = [
                    started(True),
                    done(entry["ref"], cached=True, attempts=entry["attempts"]),
                ]
        else:
            entry = fake.new_entry()
            owned[key] = entry
            events = fake.first_events(entry["ref"])
        self._stream(events, issued)


class QuietServer(ThreadingHTTPServer):
    """A server that stays quiet when a client (a TLS hello, say) breaks a request."""

    def handle_error(self, request: Any, client_address: Any) -> None:
        pass


class Result(NamedTuple):
    code: int
    out: str
    err: str


class FakeServerCase(unittest.TestCase):
    """Starts a fake LORE on 127.0.0.1 for each test and runs the script against it."""

    def setUp(self) -> None:
        self.fake = FakeLore()
        self.server = QuietServer(("127.0.0.1", 0), Handler)
        self.server.fake = self.fake  # type: ignore[attr-defined]
        self.fake.port = self.server.server_address[1]
        self.thread = threading.Thread(
            target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True
        )
        self.thread.start()
        self.addCleanup(self._stop)

    def _stop(self) -> None:
        self.fake.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.fake.port}"

    def mapped_fetch(self, url: str, max_bytes: int, timeout: float) -> Any:
        """The download of the test: the S3 host of the URL is mapped to the loopback server."""
        parts = urlsplit(url)
        self.fake.fetched_hosts.append(parts.hostname)
        target = f"http://127.0.0.1:{self.fake.port}/fake-s3{parts.path}"
        if parts.query:
            target += f"?{parts.query}"
        return REAL_FETCH(target, max_bytes, timeout)

    def run_script(
        self,
        *,
        settings: Any = None,
        fake_clock: bool = False,
        url: str | None = None,
    ) -> Result:
        out, err = io.StringIO(), io.StringIO()
        clock = self.fake.clock if fake_clock else time.monotonic
        env = smoke.Env(clock=clock, fetch=self.mapped_fetch)
        code = smoke.run(
            [url or self.url], out=out, err=err, env=env, settings=settings or smoke.Settings()
        )
        return Result(code, out.getvalue(), err.getvalue())

    def sentinels(self) -> list[str]:
        return [*FIXED_SENTINELS, *self.fake.tokens, *self.fake.animation_ids()]

    def assertNoSecrets(self, result: Result) -> None:
        for text in (result.out, result.err):
            for sentinel in self.sentinels():
                self.assertNotIn(sentinel, text)

    def assertPasses(self, result: Result) -> None:
        self.assertEqual(result.code, 0, msg=result.out + result.err)
        self.assertEqual(result.out, "".join(f"{name}: PASS\n" for name in CHECKS))
        self.assertEqual(result.err, "")
        self.assertNoSecrets(result)

    def assertFails(self, result: Result, check: str, reason: str) -> None:
        """Exit 1, `PASS` for every earlier check, `FAIL` for `check`, and nothing after it."""
        position = CHECKS.index(check)
        lines = [f"{name}: PASS\n" for name in CHECKS[:position]] + [f"{check}: FAIL\n"]
        self.assertEqual(result.code, 1, msg=result.out + result.err)
        self.assertEqual(result.out, "".join(lines))
        self.assertEqual(result.err, f"  reason: {reason}\n")
        self.assertNoSecrets(result)


class SmokeScriptTest(FakeServerCase):
    # -- exit code 0 -----------------------------------------------------------------------------

    def test_every_check_passes_with_one_line_each_and_no_secrets(self) -> None:
        result = self.run_script()
        self.assertPasses(result)
        self.assertEqual(self.fake.posts, [smoke.SMOKE_REQUEST, smoke.SMOKE_REQUEST])

    def test_a_run_that_is_published_on_the_first_attempt_passes(self) -> None:
        self.fake.first_events = one_attempt
        self.assertPasses(self.run_script())

    def test_main_is_the_entry_point_and_returns_zero(self) -> None:
        out, err = io.StringIO(), io.StringIO()
        with (
            mock.patch.object(sys, "argv", ["animation-smoke.py", self.url]),
            mock.patch.object(smoke, "fetch_object", self.mapped_fetch),
            redirect_stdout(out),
            redirect_stderr(err),
        ):
            code = smoke.main()
        self.assertEqual(code, 0, msg=out.getvalue() + err.getvalue())
        self.assertEqual(out.getvalue(), "".join(f"{name}: PASS\n" for name in CHECKS))
        self.assertEqual(err.getvalue(), "")

    def test_a_base_url_with_a_trailing_slash_or_a_path_prefix_is_accepted(self) -> None:
        self.assertEqual(smoke.parse_base(["http://h:8/"]), smoke.Base("http", "h", 8, ""))
        self.assertEqual(
            smoke.parse_base(["https://h/lore/"]), smoke.Base("https", "h", 443, "/lore")
        )

    def test_text_the_parser_must_not_split_does_not_break_it(self) -> None:
        crlf = b'event: stage\r\ndata: {"stage":"verifying","attempt":1}\r\n\r\n'
        note = {
            "stage": "generating",
            "attempt": 1,
            "note": "caf\u00e9 na\u00efve \u2028 \U0001f600",
        }

        def events(ref: dict[str, Any]) -> Events:
            return [
                started(),
                ("stage", note),
                ("!raw", crlf),
                ("!raw", b": a comment\n\n"),
                diagnostics(1, True),
                stage("publishing", 1),
                done(ref, attempts=1),
            ]

        self.fake.first_events = events
        self.assertPasses(self.run_script())

    def test_each_run_gets_a_new_owner_so_it_is_never_cached_by_an_earlier_run(self) -> None:
        self.assertPasses(self.run_script())
        self.assertPasses(self.run_script())
        self.assertEqual(len(self.fake.tokens), 2 + 2)  # the other-owner check makes one each run
        self.assertEqual(len(self.fake.posts), 4)

    def test_cookies_follow_the_jar_and_never_reach_s3(self) -> None:
        self.assertPasses(self.run_script())
        posts = [s for s in self.fake.seen if s[0] == "POST"]
        reads = [s for s in self.fake.seen if s[1].startswith("/api/v1/animations/")]
        token = self.fake.tokens[0]
        self.assertIsNone(posts[0][2])  # no cookie before the first answer
        self.assertEqual(posts[1][2], f"lore_device={token}")  # the same jar for the repeat
        self.assertEqual(reads[0][2], f"lore_device={token}")  # and for the Reader
        self.assertIsNone(reads[1][2])  # a new jar for the last check
        self.assertEqual(self.fake.s3_requests[0][1], None)  # S3 never sees the cookie
        sha = f"/fake-s3/animations/v1/{SOURCE_SHA[:2]}/{SOURCE_SHA}/main.js"
        self.assertEqual([p for p, _ in self.fake.s3_requests], [sha])
        self.assertEqual(self.fake.fetched_hosts, [BUCKET_HOST])

    def test_requests_ask_for_identity_encoding_and_for_an_event_stream(self) -> None:
        self.assertPasses(self.run_script())
        for method, _path, _cookie, encoding, accept in self.fake.seen:
            self.assertEqual(encoding, "identity")
            if method == "POST":
                self.assertEqual(accept, "text/event-stream")

    # -- exit code 1: the static files -----------------------------------------------------------

    def test_runtime_html_with_a_bad_status_fails_and_stops_the_run(self) -> None:
        self.fake.html_status = 500
        self.assertFails(self.run_script(), "sandbox-runtime-html", "status_500")
        self.assertEqual(len(self.fake.seen), 1)  # the rest was not run

    def test_runtime_html_needs_the_exact_csp_header(self) -> None:
        policy = json.loads(POLICY_FILE.read_text(encoding="utf-8"))
        cases = {
            "missing": [],
            "without frame-ancestors": [policy["csp"]],
            "other frame-ancestors": [f"{policy['csp']}; frame-ancestors *"],
            "script-src loosened": [smoke.EXPECTED_CSP.replace("'self'", "'self' https:", 1)],
            "twice": [smoke.EXPECTED_CSP, smoke.EXPECTED_CSP],
            "trailing semicolon": [smoke.EXPECTED_CSP + ";"],
        }
        for label, headers in cases.items():
            with self.subTest(label):
                self.fake.csp_headers = headers
                self.assertFails(self.run_script(), "sandbox-runtime-html", "csp_mismatch")

    def test_runtime_html_needs_nosniff(self) -> None:
        for label, headers in {
            "missing": [],
            "other value": ["sniff"],
            "twice": ["nosniff"] * 2,
        }.items():
            with self.subTest(label):
                self.fake.nosniff_headers = headers
                self.assertFails(self.run_script(), "sandbox-runtime-html", "nosniff_missing")

    def test_runtime_html_accepts_nosniff_in_any_letter_case(self) -> None:
        self.fake.nosniff_headers = [" NoSniff "]
        self.assertPasses(self.run_script())

    def test_runtime_js_is_limited_to_1048576_bytes(self) -> None:
        self.fake.js_size = 1048576
        self.assertPasses(self.run_script())
        self.fake.js_size = 1048577
        self.assertFails(self.run_script(), "sandbox-runtime-js", "runtime_js_too_large")

    def test_runtime_js_with_a_bad_status_fails(self) -> None:
        self.fake.js_status = 404
        self.assertFails(self.run_script(), "sandbox-runtime-js", "status_404")

    # -- exit code 1: the first request ----------------------------------------------------------

    def test_a_non_200_answer_to_the_post_fails_with_its_status(self) -> None:
        for status in (400, 429, 503):
            with self.subTest(status):
                self.fake.create_status = status
                self.assertFails(self.run_script(), "animation-create", f"status_{status}")

    def test_a_200_that_is_not_an_event_stream_fails(self) -> None:
        self.fake.create_content_type = "application/json"
        self.assertFails(self.run_script(), "animation-create", "not_an_event_stream")

    def test_started_after_5_seconds_fails_and_at_5_seconds_passes(self) -> None:
        self.fake.first_events = lambda ref: [("!advance", 5.0), *happy(ref)]
        self.assertPasses(self.run_script(fake_clock=True))
        self.fake.first_events = lambda ref: [("!advance", 5.1), *happy(ref)]
        self.assertFails(self.run_script(fake_clock=True), "animation-create", "started_late")

    def test_a_started_that_never_comes_times_out(self) -> None:
        self.fake.first_events = lambda ref: [("!stall", 10)]
        result = self.run_script(settings=smoke.Settings(started_s=0.3))
        self.assertFails(result, "animation-create", "started_timeout")

    def test_a_server_that_never_sends_headers_times_out(self) -> None:
        self.fake.hang_before_headers = True
        result = self.run_script(settings=smoke.Settings(started_s=0.3))
        self.assertFails(result, "animation-create", "timeout")

    def test_done_after_300_seconds_fails_and_at_300_seconds_passes(self) -> None:
        def late(seconds: float) -> Callable[[dict[str, Any]], Events]:
            return lambda ref: [*happy(ref)[:-1], ("!advance", seconds), done(ref)]

        self.fake.first_events = late(300.0)
        self.assertPasses(self.run_script(fake_clock=True))
        self.fake.first_events = late(300.5)
        self.assertFails(self.run_script(fake_clock=True), "animation-create", "done_late")

    def test_a_done_that_never_comes_times_out(self) -> None:
        self.fake.first_events = lambda ref: [started(), stage("generating", 1), ("!stall", 10)]
        result = self.run_script(settings=smoke.Settings(done_s=0.4))
        self.assertFails(result, "animation-create", "done_timeout")

    def test_started_with_cached_true_fails(self) -> None:
        self.fake.first_events = lambda ref: [started(True), *happy(ref)[1:]]
        self.assertFails(self.run_script(), "animation-create", "started_cached")

    def test_the_first_event_must_be_a_valid_started(self) -> None:
        bad = {"max_attempts": 5, "deadline_ms": 1, "cached": False}
        for label, first in {
            "a stage": stage("generating", 1),
            "max_attempts 5": ("started", bad),
            "cached as a string": ("started", {**bad, "max_attempts": 4, "cached": "false"}),
        }.items():
            with self.subTest(label):
                self.fake.first_events = lambda ref, first=first: [first, *happy(ref)[1:]]
                self.assertFails(self.run_script(), "animation-create", "first_event_not_started")

    def test_an_error_event_fails_with_its_code_and_never_echoes_the_message(self) -> None:
        code = "ANIMATION_VERIFICATION_FAILED"
        error = ("error", {"code": code, "message": SERVER_TEXT, "attempts": 4})
        self.fake.first_events = lambda ref: [started(), stage("generating", 1), error]
        self.assertFails(self.run_script(), "animation-create", f"event_error_{code}")

    def test_an_error_code_of_an_unexpected_form_is_not_echoed(self) -> None:
        error = ("error", {"code": "SOURCE-SENTINEL <b>", "message": SERVER_TEXT, "attempts": 1})
        self.fake.first_events = lambda ref: [started(), error]
        self.assertFails(self.run_script(), "animation-create", "event_error")

    def test_a_run_without_a_stage_event_fails(self) -> None:
        self.fake.first_events = lambda ref: [started(), done(ref)]
        self.assertFails(self.run_script(), "animation-create", "no_stage_event")

    def test_a_done_without_publishing_fails(self) -> None:
        self.fake.first_events = lambda ref: [
            started(),
            stage("generating", 1),
            stage("verifying", 1),
            diagnostics(1, True),
            done(ref, attempts=1),
        ]
        self.assertFails(self.run_script(), "animation-create", "publishing_missing")

    def test_the_order_of_the_events_follows_requirement_17(self) -> None:
        failed = [{"tool": "tsc", "code": "TSC_2322", "line": 17}]
        gen1, ver1 = stage("generating", 1), stage("verifying", 1)
        ok1, bad1 = diagnostics(1, True), diagnostics(1, False, failed)
        pub1 = stage("publishing", 1)
        cases: dict[str, tuple[Events, str]] = {
            "publishing before diagnostics": ([gen1, ver1, pub1], "publishing_without_ok"),
            "publishing after a failed verification": (
                [gen1, ver1, bad1, pub1],
                "publishing_without_ok",
            ),
            "repairing as the first attempt": (
                [stage("repairing", 1)],
                "stage_name_mismatch",
            ),
            "generating as the second attempt": (
                [gen1, ver1, bad1, stage("generating", 2)],
                "stage_name_mismatch",
            ),
            "attempt 3 right after attempt 1": (
                [gen1, ver1, bad1, stage("repairing", 3)],
                "attempt_sequence",
            ),
            "generating twice": ([gen1, gen1], "attempt_sequence"),
            "verifying of another attempt": ([gen1, stage("verifying", 2)], "attempt_mismatch"),
            "diagnostics of another attempt": ([gen1, diagnostics(2, True)], "attempt_mismatch"),
            "verifying before any attempt": ([ver1], "attempt_mismatch"),
            "verifying twice": ([gen1, ver1, ver1], "stage_out_of_order"),
            "verifying after diagnostics": ([gen1, ok1, ver1], "stage_out_of_order"),
            "diagnostics twice": ([gen1, ver1, ok1, ok1], "duplicate_diagnostics"),
            "a stage after publishing": (
                [gen1, ver1, ok1, pub1, stage("verifying", 1)],
                "event_after_publishing",
            ),
            "an event that is not in the protocol": (
                [gen1, ("notice", {"text": "hello"})],
                "unexpected_event",
            ),
            "a second started": ([gen1, started()], "unexpected_event"),
            "an attempt above max_attempts": (
                [
                    gen1,
                    ver1,
                    bad1,
                    stage("repairing", 2),
                    diagnostics(2, False, failed),
                    stage("repairing", 3),
                ],
                "attempt_out_of_range",
            ),
            "a stage that does not exist": (
                [("stage", {"stage": "SOURCE-SENTINEL", "attempt": 1})],
                "invalid_stage",
            ),
            "an attempt of 0": (
                [("stage", {"stage": "generating", "attempt": 0})],
                "invalid_stage",
            ),
            "diagnostics with 11 items": (
                [gen1, diagnostics(1, False, [failed[0]] * 11)],
                "invalid_diagnostics",
            ),
            "diagnostics with a string count": (
                [gen1, ("diagnostics", {**ok1[1], "error_count": "0"})],
                "invalid_diagnostics",
            ),
        }
        for label, (middle, reason) in cases.items():
            with self.subTest(label):
                max_attempts = 2 if "above" in label else 4
                self.fake.first_events = lambda ref, m=middle, n=max_attempts: [
                    started(max_attempts=n),
                    *m,
                    done(ref),
                ]
                self.assertFails(self.run_script(), "animation-create", reason)

    def test_the_done_event_must_be_complete(self) -> None:
        ref = reference(1)

        def edited(**changes: Any) -> dict[str, Any]:
            return {**ref, **changes}

        bad_refs = {
            "attempts 0": ("attempts", 0),
            "attempts 5": ("attempts", 5),
            "attempts as a bool": ("attempts", True),
            "attempts as a float": ("attempts", 2.0),
            "a missing key": ("animation", {k: v for k, v in ref.items() if k != "fps"}),
            "an upper case hash": ("animation", edited(bundle_sha256=BUNDLE_SHA.upper())),
            "a short hash": ("animation", edited(source_sha256=SOURCE_SHA[:63])),
            "an id that is not a uuid": ("animation", edited(animation_id="not-a-uuid")),
            "an upper case id": ("animation", edited(animation_id=ref["animation_id"].upper())),
            "a width as a string": ("animation", edited(width="1280")),
            "a pause frame of 0": ("animation", edited(pause_at_frame=0)),
        }
        for label, (key, value) in bad_refs.items():
            with self.subTest(label):
                self.fake.first_events = lambda r, k=key, v=value: [
                    *happy(r)[:-1],
                    ("done", {**done(r)[1], k: v}),
                ]
                self.assertFails(self.run_script(), "animation-create", "invalid_done")

    def test_a_done_with_cached_true_fails_on_the_first_request(self) -> None:
        self.fake.first_events = lambda ref: [*happy(ref)[:-1], done(ref, cached=True)]
        self.assertFails(self.run_script(), "animation-create", "done_cached")

    def test_an_event_after_the_final_event_fails(self) -> None:
        self.fake.first_events = lambda ref: [*happy(ref), stage("verifying", 2)]
        self.assertFails(self.run_script(), "animation-create", "event_after_terminal")

    def test_a_stream_that_ends_without_a_final_event_fails(self) -> None:
        self.fake.first_events = lambda ref: happy(ref)[:5]
        self.assertFails(self.run_script(), "animation-create", "stream_interrupted")

    def test_an_event_cut_off_by_the_end_of_the_stream_is_dropped(self) -> None:
        raw = b'event: done\ndata: {"animation":'
        self.fake.first_events = lambda ref: [*happy(ref)[:-1], ("!raw", raw)]
        self.assertFails(self.run_script(), "animation-create", "stream_interrupted")

    def test_an_event_over_8192_bytes_fails(self) -> None:
        head = b'event: stage\ndata: {"stage":"generating","attempt":1,"pad":"'
        long_line = head + b"x" * 9000 + b'"}\n\n'
        self.fake.first_events = lambda ref: [started(), ("!raw", long_line)]
        self.assertFails(self.run_script(), "animation-create", "event_too_large")
        many = (
            b"event: stage\n" + b"".join(b"data: " + b"y" * 1000 + b"\n" for _ in range(9)) + b"\n"
        )
        self.fake.first_events = lambda ref: [started(), ("!raw", many)]
        self.assertFails(self.run_script(), "animation-create", "event_too_large")

    def test_data_that_is_not_a_json_object_fails(self) -> None:
        for label, raw in {
            "text": b"event: stage\ndata: not json\n\n",
            "an array": b"event: stage\ndata: [1]\n\n",
            "no data": b"event: stage\n\n",
        }.items():
            with self.subTest(label):
                self.fake.first_events = lambda ref, raw=raw: [started(), ("!raw", raw)]
                self.assertFails(self.run_script(), "animation-create", "invalid_event")

    def test_bytes_that_are_not_utf8_fail_without_a_traceback(self) -> None:
        raw = b'event: stage\ndata: {"stage":"\xff"}\n\n'
        self.fake.first_events = lambda ref: [started(), ("!raw", raw)]
        self.assertFails(self.run_script(), "animation-create", "invalid_response")

    def test_a_reply_without_the_device_cookie_fails(self) -> None:
        self.fake.issue_cookie = False
        self.assertFails(self.run_script(), "animation-create", "device_cookie_missing")

    # -- exit code 1: the Reader and the bundle --------------------------------------------------

    def test_a_reader_that_does_not_answer_200_fails(self) -> None:
        self.fake.reader_status = 503
        self.assertFails(self.run_script(), "animation-reader", "status_503")

    def test_the_reader_answer_must_be_no_store(self) -> None:
        self.fake.reader_cache_control = None
        self.assertFails(self.run_script(), "animation-reader", "cache_control_missing")

    def test_a_reader_body_that_is_not_the_expected_envelope_fails(self) -> None:
        cases: dict[str, Callable[[dict[str, Any]], None]] = {
            "ok false": lambda e: e.update(ok=False),
            "no data": lambda e: e.pop("data"),
            "urls as a list": lambda e: e["data"].update(urls=[]),
        }
        for label, edit in cases.items():
            with self.subTest(label):
                self.fake.reader_edit = edit
                self.assertFails(self.run_script(), "animation-reader", "invalid_reader_envelope")
        self.fake.reader_edit = None
        self.fake.reader_raw = b"[]"
        self.assertFails(self.run_script(), "animation-reader", "invalid_reader_envelope")
        self.fake.reader_raw = b"<html>"
        self.assertFails(self.run_script(), "animation-reader", "invalid_response")

    def test_the_reader_animation_must_equal_the_done_animation(self) -> None:
        self.fake.reader_edit = lambda e: e["data"]["animation"].update(width=640)
        self.assertFails(self.run_script(), "animation-reader", "animation_mismatch")

    def test_expires_in_must_be_300(self) -> None:
        for value in (600, 299, "300", True, None):
            with self.subTest(value):
                self.fake.reader_edit = lambda e, v=value: e["data"].update(expires_in=v)
                self.assertFails(self.run_script(), "animation-reader", "expires_in_invalid")

    def test_a_bad_presigned_url_fails_before_any_download(self) -> None:
        """Each case is a function of the file name, so it is wrong for `bundle` and `manifest`."""
        other_prefix = f"animations/v1/ff/{SOURCE_SHA}/"
        cases: dict[str, tuple[Callable[[str], Any], str]] = {
            "plain http": (
                lambda n: presigned(n).replace("https://", "http://", 1),
                "presigned_not_https",
            ),
            "path-style host": (
                lambda n: presigned(n).replace(BUCKET_HOST, "s3.ap-southeast-3.amazonaws.com"),
                "presigned_host_not_virtual_hosted",
            ),
            "global host": (
                lambda n: presigned(n, host="lore-bucket.s3.amazonaws.com"),
                "presigned_host_not_virtual_hosted",
            ),
            "another domain": (
                lambda n: presigned(n, host=f"{BUCKET_HOST}.example.org"),
                "presigned_host_not_virtual_hosted",
            ),
            "a key of another animation": (
                lambda n: presigned(n).replace(
                    f"animations/v1/{SOURCE_SHA[:2]}/{SOURCE_SHA}/", other_prefix
                ),
                "presigned_key_mismatch",
            ),
            "expires 3600": (lambda n: presigned(n, expires="3600"), "presigned_expires_invalid"),
            "no expires": (
                lambda n: presigned(n).replace("&X-Amz-Expires=300", ""),
                "presigned_expires_invalid",
            ),
            "another algorithm": (
                lambda n: presigned(n).replace("AWS4-HMAC-SHA256", "AWS4-HMAC-SHA1"),
                "presigned_algorithm_invalid",
            ),
            "no signature": (
                lambda n: presigned(n).replace(
                    f"&X-Amz-Signature={SIGNATURE}", "&X-Amz-Signature="
                ),
                "presigned_signature_missing",
            ),
            "not a string": (lambda n: None, "presigned_url_invalid"),
        }
        names = {"bundle": "main.js", "manifest": "manifest.json"}
        for label, (make, reason) in cases.items():
            for which, name in names.items():
                with self.subTest(f"{label} ({which})"):
                    self.fake.s3_requests.clear()
                    self.fake.reader_edit = lambda e, w=which, n=name, m=make: e["data"][
                        "urls"
                    ].update({w: m(n)})
                    self.assertFails(self.run_script(), "animation-reader", reason)
                    self.assertEqual(self.fake.s3_requests, [])  # no download was tried

    def test_a_bundle_that_cannot_be_downloaded_fails(self) -> None:
        self.fake.s3_status = 403
        self.assertFails(self.run_script(), "animation-reader", "bundle_status_403")

    def test_a_redirect_from_s3_is_not_followed(self) -> None:
        self.fake.s3_redirect = True
        self.assertFails(self.run_script(), "animation-reader", "bundle_status_302")
        self.assertEqual(len(self.fake.s3_requests), 1)

    def test_a_bundle_whose_sha256_differs_fails(self) -> None:
        self.fake.s3_body = BUNDLE + b" "
        self.assertFails(self.run_script(), "animation-reader", "bundle_sha256_mismatch")

    def test_a_bundle_over_the_download_cap_fails(self) -> None:
        self.fake.s3_body = b"x" * (smoke.BUNDLE_READ_MAX_BYTES + 1)
        self.assertFails(self.run_script(), "animation-reader", "bundle_too_large")

    # -- exit code 1: the repeated request -------------------------------------------------------

    def cached(self, events: Callable[[dict[str, Any], int], Events]) -> None:
        self.fake.cached_events = events

    def test_the_repeated_request_must_be_cached_and_have_no_stage(self) -> None:
        cases: dict[str, tuple[Callable[[dict[str, Any], int], Events], str]] = {
            "a stage event": (
                lambda ref, n: [started(True), stage("generating", 1), done(ref, cached=True)],
                "stage_in_cached_run",
            ),
            "started not cached": (
                lambda ref, n: [started(False), done(ref, cached=True)],
                "started_not_cached",
            ),
            "done not cached": (lambda ref, n: [started(True), done(ref)], "done_not_cached"),
            "another animation": (
                lambda ref, n: [started(True), done(reference(99), cached=True)],
                "animation_mismatch",
            ),
            "an unknown event": (
                lambda ref, n: [started(True), ("notice", {}), done(ref, cached=True)],
                "unexpected_event",
            ),
            "the stream ends after started": (lambda ref, n: [started(True)], "stream_interrupted"),
            "an event after done": (
                lambda ref, n: [started(True), done(ref, cached=True), stage("verifying", 1)],
                "event_after_terminal",
            ),
            "an error event": (
                lambda ref, n: [started(True), ("error", {"code": "UNKNOWN", "message": "x"})],
                "event_error_UNKNOWN",
            ),
        }
        for label, (events, reason) in cases.items():
            with self.subTest(label):
                self.cached(events)
                self.assertFails(self.run_script(), "animation-cached", reason)

    def test_the_cached_done_must_come_within_5_seconds(self) -> None:
        def late(seconds: float) -> Callable[[dict[str, Any], int], Events]:
            return lambda ref, n: [started(True), ("!advance", seconds), done(ref, cached=True)]

        self.cached(late(5.0))
        self.assertPasses(self.run_script(fake_clock=True))
        self.cached(late(5.5))
        self.assertFails(self.run_script(fake_clock=True), "animation-cached", "done_late")

    def test_a_cached_done_that_never_comes_times_out(self) -> None:
        self.cached(lambda ref, n: [started(True), ("!stall", 10)])
        result = self.run_script(settings=smoke.Settings(cached_done_s=0.3))
        self.assertFails(result, "animation-cached", "done_timeout")

    # -- exit code 1: the other owner ------------------------------------------------------------

    def test_another_owner_that_can_read_the_animation_fails(self) -> None:
        self.fake.leak_to_other_owner = True
        self.assertFails(self.run_script(), "animation-other-owner", "status_200")

    def test_the_404_body_must_be_exactly_animation_not_found(self) -> None:
        for body in (
            b'{"detail": "Not Found"}',
            b"{}",
            b"[]",
            b'{"detail":"animation not found","x":1}',
        ):
            with self.subTest(body):
                self.fake.not_found_body = body
                self.assertFails(
                    self.run_script(), "animation-other-owner", "not_found_body_mismatch"
                )

    def test_the_404_body_may_be_written_without_spaces(self) -> None:
        self.fake.not_found_body = b'{"detail":"animation not found"}'
        self.assertPasses(self.run_script())

    # -- exit code 1: the network ----------------------------------------------------------------

    def test_a_refused_connection_fails_the_first_check_without_a_traceback(self) -> None:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        result = self.run_script(url=f"http://127.0.0.1:{port}")
        self.assertFails(result, "sandbox-runtime-html", "connection_failed")

    def test_a_tls_handshake_with_a_plain_http_server_fails_cleanly(self) -> None:
        """The server may answer in clear text or reset the connection; both end the run."""
        result = self.run_script(url=f"https://127.0.0.1:{self.fake.port}")
        self.assertEqual(result.code, 1)
        self.assertEqual(result.out, "sandbox-runtime-html: FAIL\n")
        self.assertIn(result.err, ("  reason: tls_error\n", "  reason: connection_failed\n"))
        self.assertNoSecrets(result)

    def test_an_interrupt_is_a_failed_check_not_a_traceback(self) -> None:
        def interrupted(self_: Any) -> None:
            raise KeyboardInterrupt

        with mock.patch.object(smoke.Smoke, "check_runtime_html", interrupted):
            result = self.run_script()
        self.assertFails(result, "sandbox-runtime-html", "interrupted")

    # -- the real process ------------------------------------------------------------------------

    def child(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-B", str(SCRIPT), *args],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )

    def test_a_child_process_exits_1_on_the_first_failed_check(self) -> None:
        self.fake.html_status = 500
        done_ = self.child(self.url)
        self.assertEqual(done_.returncode, 1)
        self.assertEqual(done_.stdout, "sandbox-runtime-html: FAIL\n")
        self.assertEqual(done_.stderr, "  reason: status_500\n")
        self.assertEqual(len(self.fake.seen), 1)

    def test_a_child_process_exits_1_when_the_connection_is_refused(self) -> None:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        done_ = self.child(f"http://127.0.0.1:{port}")
        self.assertEqual(done_.returncode, 1)
        self.assertEqual(done_.stdout, "sandbox-runtime-html: FAIL\n")
        self.assertNotIn("Traceback", done_.stderr)

    def test_a_child_process_exits_2_unless_it_gets_exactly_one_http_url(self) -> None:
        bad_arguments = [
            [],
            ["http://localhost:8000", "http://localhost:8001"],
            ["ftp://example.org"],
            ["localhost:8000"],
            ["example.org"],
            ["http://"],
            ["https:///path"],
            ["--help"],
            [""],
            ["http://user:secret@example.org"],
            ["http://example.org:99999"],
            ["http://example.org/?q=1"],
            ["http://example.org/#frag"],
        ]
        for argv in bad_arguments:
            with self.subTest(argv):
                done_ = self.child(*argv)
                self.assertEqual(done_.returncode, 2)
                self.assertEqual(done_.stdout, "")
                self.assertTrue(done_.stderr.startswith("usage: "))
                self.assertNotIn("secret", done_.stderr)
                self.assertNotIn("Traceback", done_.stderr)

    def test_run_returns_2_for_bad_arguments_without_touching_the_network(self) -> None:
        out, err = io.StringIO(), io.StringIO()
        self.assertEqual(smoke.run([], out=out, err=err), 2)
        self.assertEqual(out.getvalue(), "")
        self.assertIn("usage: ", err.getvalue())
        self.assertEqual(self.fake.seen, [])


class SmokeScriptStaticTest(unittest.TestCase):
    """What can be said about the script without running it."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.source = SCRIPT.read_text(encoding="utf-8")
        cls.tree = ast.parse(cls.source, feature_version=(3, 12))
        cls.policy = json.loads(POLICY_FILE.read_text(encoding="utf-8"))

    def literal(self, name: str) -> Any:
        """The value of a module-level `NAME = <literal>` in the script's own source."""
        for node in self.tree.body:
            if isinstance(node, ast.Assign) and [
                t.id for t in node.targets if isinstance(t, ast.Name)
            ] == [name]:
                return ast.literal_eval(node.value)
        self.fail(f"{name} is not a module-level literal in the script")

    def test_the_csp_literal_of_the_script_is_the_shared_constant(self) -> None:
        self.assertEqual(self.literal("SANDBOX_CSP"), self.policy["csp"])
        self.assertEqual(self.literal("FRAME_ANCESTORS"), self.policy["frame_ancestors"])
        self.assertEqual(smoke.SANDBOX_CSP, self.policy["csp"])

    def test_the_expected_header_is_the_policy_plus_frame_ancestors(self) -> None:
        self.assertEqual(
            smoke.EXPECTED_CSP,
            f"{self.policy['csp']}; frame-ancestors {self.policy['frame_ancestors']}",
        )
        self.assertIn("frame-ancestors 'self'", smoke.EXPECTED_CSP)
        if NEXT_CONFIG.exists():  # the header the frontend really sends is built the same way
            text = NEXT_CONFIG.read_text(encoding="utf-8")
            self.assertIn("`${policy.csp}; frame-ancestors ${policy.frame_ancestors}`", text)

    def test_the_request_is_the_fixture_the_backend_tests_accept(self) -> None:
        fixture = json.loads(REQUEST_FIXTURE.read_text(encoding="utf-8"))
        self.assertEqual(smoke.SMOKE_REQUEST, fixture)
        self.assertEqual(smoke.SMOKE_REQUEST["kind"], "lesson")

    def test_the_script_uses_only_the_standard_library(self) -> None:
        modules: set[str] = set()
        for node in ast.walk(self.tree):
            if isinstance(node, ast.Import):
                modules.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                modules.add(node.module.split(".")[0])
        self.assertTrue(modules)
        self.assertEqual({m for m in modules if m not in sys.stdlib_module_names}, set())
        self.assertNotIn("traceback", modules)

    def test_the_script_is_valid_python_3_12(self) -> None:
        ast.parse(self.source, feature_version=(3, 12))  # also done in setUpClass; explicit here

    def test_main_returns_int_and_is_the_exit_code_of_the_script(self) -> None:
        main = next(
            n for n in self.tree.body if isinstance(n, ast.FunctionDef) and n.name == "main"
        )
        self.assertEqual(ast.unparse(main.returns), "int")
        self.assertEqual(main.args.args, [])
        last = self.tree.body[-1]
        self.assertIsInstance(last, ast.If)
        self.assertEqual(ast.unparse(last.test), "__name__ == '__main__'")
        self.assertEqual([ast.unparse(s) for s in last.body], ["raise SystemExit(main())"])

    def test_the_file_starts_with_a_shebang_and_a_docstring(self) -> None:
        self.assertTrue(self.source.startswith("#!/usr/bin/env python3\n"))
        self.assertIsNotNone(ast.get_docstring(self.tree))

    def test_the_docstring_has_the_operator_commands_and_the_unverified_label(self) -> None:
        doc = ast.get_docstring(self.tree) or ""
        for needle in (
            "[belum diverifikasi]",
            "600 MiB",
            "docker top",
            "--if-none-match",
            "Chromium and Firefox",
            "SecurityError",
            "ANIMATION_MAX_CONCURRENT_GLOBAL",
        ):
            self.assertIn(needle, doc)

    def test_the_cost_of_a_run_is_documented(self) -> None:
        doc = ast.get_docstring(self.tree) or ""
        self.assertIn(
            "N Gemini calls and N Lambda invocations (1 <= N <= 4)",
            doc.replace("\n", " ").replace("  ", " "),
        )

    def test_the_check_names_are_the_ones_of_the_tests(self) -> None:
        base = smoke.Base("http", "127.0.0.1", 1)
        names = [n for n, _ in smoke.Smoke(base, smoke.Env(), smoke.Settings()).checks()]
        self.assertEqual(names, CHECKS)

    def test_the_default_limits_are_the_ones_of_requirement_33(self) -> None:
        settings = smoke.Settings()
        self.assertEqual(
            (settings.started_s, settings.done_s, settings.cached_done_s), (5.0, 300.0, 5.0)
        )
        self.assertEqual(smoke.RUNTIME_JS_MAX_BYTES, 1048576)
        self.assertEqual(smoke.MAX_EVENT_BYTES, 8192)

    def test_exceptions_become_fixed_codes(self) -> None:
        cases = [
            (TimeoutError("secret"), "timeout"),
            (ssl.SSLError("secret"), "tls_error"),
            (ConnectionRefusedError("secret"), "connection_failed"),
            (ValueError("secret"), "invalid_response"),
            (json.JSONDecodeError("secret", "x", 0), "invalid_response"),
            (KeyError("secret"), "unexpected_KeyError"),
            (KeyboardInterrupt(), "interrupted"),
        ]
        for exc, reason in cases:
            with self.subTest(type(exc).__name__):
                self.assertEqual(smoke.reason_of(exc), reason)

    def test_presigned_url_shapes(self) -> None:
        good = presigned()
        self.assertIsNone(smoke.presigned_problem(good, SOURCE_SHA, "main.js"))
        self.assertIsNone(
            smoke.presigned_problem(presigned("manifest.json"), SOURCE_SHA, "manifest.json")
        )
        self.assertEqual(
            smoke.presigned_problem(good, SOURCE_SHA, "manifest.json"), "presigned_key_mismatch"
        )
        not_virtual = "presigned_host_not_virtual_hosted"
        hosts = {
            "bucket.s3.ap-southeast-3.amazonaws.com": None,
            "lore-prod-animations-1.s3.us-east-1.amazonaws.com": None,
            "s3.ap-southeast-3.amazonaws.com": not_virtual,
            "bucket.s3.amazonaws.com": not_virtual,
            "bucket.s3.dualstack.ap-southeast-3.amazonaws.com": not_virtual,
            "bucket.s3.ap-southeast-3.amazonaws.com.evil.example": not_virtual,
            "bucket.s3.ap-southeast-3.amazonaws.com:8443": "presigned_not_https",
            "x@bucket.s3.ap-southeast-3.amazonaws.com": "presigned_not_https",
        }
        for host, expected in hosts.items():
            with self.subTest(host):
                url = good.replace(BUCKET_HOST, host)
                self.assertEqual(smoke.presigned_problem(url, SOURCE_SHA, "main.js"), expected)


if __name__ == "__main__":
    unittest.main()
