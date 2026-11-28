#!/usr/bin/env python3
"""Smoke test for the animation feature on a deployed LORE (Requirement 33, design 14.6).

Why: unit tests use a fake Gemini, a fake Lambda and a fake S3, so they cannot prove that the
real stack (Caddy, Next, FastAPI, Gemini, the verifier Lambda, S3) works together. This script
makes one real animation through the public URL and checks every hop. It is run by an operator
after a release (operator step O-8), never by CI. Python 3.12, standard library only.

Usage:    python3 scripts/verify/animation-smoke.py <base-url>
          python3 scripts/verify/animation-smoke.py https://<site_address>
          python3 scripts/verify/animation-smoke.py http://<elastic-ip>
Exit:     0 every check passed; 1 the first check that failed (the rest are not run);
          2 the arguments are not exactly one http:// or https:// URL (usage goes to stderr).
Output:   stdout has exactly one line per check, `<name>: PASS` or `<name>: FAIL`. When a check
          fails, stderr gets one line `  reason: <code>` from a fixed list (an HTTP status, a
          timeout, an order rule that broke, ...). Nothing the server sent is echoed: no presigned
          URL, source code, bundle text, cookie value, animation id, error message or traceback.

Checks, in order (each one needs the one before it):
  sandbox-runtime-html   GET /sandbox/runtime.html: 200, the exact Content-Security-Policy header
                         and `X-Content-Type-Options: nosniff` (Requirement 27.3, 33.4, 33.14).
  sandbox-runtime-js     GET /sandbox/runtime.js: 200 and at most 1048576 bytes (33.14).
  animation-create       POST /api/v1/ai/animations with one fixed `lesson` request: `started`
                         within 5 s (cached false), at least one `stage`, `done` within 300 s
                         (cached false, attempts 1 to 4), events in the order of Requirement 17.
  animation-reader       GET /api/v1/animations/<id> with the same cookies: the animation equals
                         the `done` one, `expires_in` 300, both URLs are SigV4 GET URLs on the
                         virtual-hosted regional S3 host with X-Amz-Expires=300 (Requirement 21.3);
                         `main.js` is downloaded from the URL (without cookies, without following
                         a redirect) and its SHA-256 equals `bundle_sha256` (33.6).
  animation-cached       The same POST again: `started` (cached true) and `done` (cached true, the
                         same animation) within 5 s, no `stage` (33.7).
  animation-other-owner  The same GET with a new cookie jar: 404 `{"detail": "animation not
                         found"}` (33.8).

Cost: a run that passes spends N Gemini calls and N Lambda invocations (1 <= N <= 4). The
repeated request is answered from the registry and spends none. Every run leaves one `animations`
row and three S3 objects (`main.ts`, `main.js`, `manifest.json`). The IP limiter allows about four
animation requests per minute and 30 a day, so do not loop this script.

Operator checklist [belum diverifikasi]: nothing below has been run against a real service, because
the sandbox that wrote this script has no network and no AWS credentials. Run it on release day
and record the values and the UTC date in docs/infra/12-remotion-animation.md.

  1. Before the smoke run, with ANIMATION_ENABLED=true (operator step O-8):
         curl -fsS https://<site_address>/api/v1/health
         curl -fsS https://<site_address>/health/ai   # "configured", animation.enabled and
                                                      # animation.configured must all be true
     (`/health/ai` is not exposed by Caddy; run it on the instance:
      `curl -fsS http://127.0.0.1:8000/health/ai`.)

  2. RSS of the api container (target: every sample <= 600 MiB, Requirement 41.2, 41.3). On the api
     instance (`aws ssm start-session --target <INSTANCE_ID>`), sum the RSS of every process in the
     container once a second. Take (a) before the api release, (b) after 60 s idle, (c) during
     this script, and (d) with two runs at once. The limiter allows one run per IP
     (ANIMATION_MAX_CONCURRENT_PER_IP=1), so a second run from the same IP gets 429: start the two
     runs from two different public IPs (two machines, or one through a phone hotspot):
         cd /opt/lore
         CID=$(docker compose ps -q api)
         while true; do
           printf '%s ' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
           docker top "$CID" -eo rss | awk 'NR>1 {s+=$1} END {printf "%.1f\\n", s/1024}'
           sleep 1
         done | tee /tmp/api-rss.log
         sort -k2 -n /tmp/api-rss.log | tail -1     # the peak, in MiB, after stopping the loop
     If (c) or (d) is above 600 MiB: change ANIMATION_MAX_CONCURRENT_GLOBAL from "2" to "1" in
     `animation_ssm_params` (infra/animation.tf) through a PR, redeploy the api, measure again, and
     if it is still above 600 MiB set animation_enabled=false (rollback, operator step O-9).

  3. Conditional write on S3 (Requirement 19.11; this script does not test it). As an admin, in
     ap-southeast-3, with a throw-away key:
         KEY=animations/v1/zz/conditional-write-check-$(date +%s)
         echo test > /tmp/cw.txt
         aws s3api put-object --bucket lore-prod-animations-<ACCOUNT_ID> --key "$KEY" \\
           --body /tmp/cw.txt --if-none-match '*' --region ap-southeast-3     # expect success
         aws s3api put-object --bucket lore-prod-animations-<ACCOUNT_ID> --key "$KEY" \\
           --body /tmp/cw.txt --if-none-match '*' --region ap-southeast-3     # expect 412
     The second call must fail with PreconditionFailed (HTTP 412). A 501 makes the Animation_Store
     fall back to HeadObject before each write (Requirement 19.11); a second success means the
     condition is ignored. Either way, write the result in document 12 and tell the developer.
     The test object may be deleted afterwards, as an admin (the api role never deletes).

  4. Browsers (Requirement 27.9, 32.10), Chromium and Firefox, written down with version and date:
     open the site over https, play a story that has an animation, and in each browser check that
     (a) the page loads /sandbox/runtime.js (Network tab) with the CSP header and the iframe has
     `sandbox="allow-scripts"` without allow-same-origin, and (b) a test bundle sent with the
     `load` message that reads `document.cookie`, `localStorage` and `window.parent.document`
     throws `SecurityError` for all three.
"""

from __future__ import annotations

import hashlib
import http.client
import json
import re
import socket
import ssl
import sys
import time
from collections.abc import Callable
from contextlib import closing
from dataclasses import dataclass
from http.cookies import CookieError, SimpleCookie
from typing import Any, TextIO
from urllib.parse import parse_qs, urlsplit

USAGE = "usage: python3 scripts/verify/animation-smoke.py <base-url>  (http:// or https://)"
USER_AGENT = "lore-animation-smoke/1"
COOKIE_NAME = "lore_device"

# The CSP of the sandbox page. This is a literal on purpose: the script must work when it is
# copied alone to an operator's machine. A test compares both constants with
# frontend/src/lib/animation/sandbox-policy.json (Requirement 33.15). The header the frontend sends
# is the policy plus `frame-ancestors` (Requirement 27.3).
SANDBOX_CSP = (
    "default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'unsafe-inline'; "
    "img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; "
    "base-uri 'none'; object-src 'none'"
)
FRAME_ANCESTORS = "'self'"
EXPECTED_CSP = f"{SANDBOX_CSP}; frame-ancestors {FRAME_ANCESTORS}"

# The one request the script sends. It is the same JSON as
# backend/tests/fixtures/animation/request-valid-lesson-minimal.json, which the backend tests
# accept; a test keeps the two equal.
SMOKE_REQUEST: dict[str, Any] = {
    "kind": "lesson",
    "title": "Linear combinations",
    "text": "A linear combination scales vectors and adds them.",
    "visual": {
        "kind": "vectors",
        "vectors": [{"from": [0, 0], "to": [4, 2], "label": "2A"}],
    },
    "language": "en",
}

RUNTIME_JS_MAX_BYTES = 1048576  # Requirement 27.6, 33.14
STATIC_READ_BYTES = 2097152  # reads past this are not needed for any check
BUNDLE_READ_MAX_BYTES = 1048576  # a safety cap for the download, well above the 131072 limit
MAX_EVENT_BYTES = 8192  # Requirement 17.5
ATTEMPTS_MAX = 4
DIAGNOSTIC_ITEMS_MAX = 10
PRESIGN_EXPIRES = "300"
DRAIN_S = 2.0  # how long to wait for the stream to end after the final event
MIN_WAIT_S = 0.25  # a socket never gets less: an event already on its way still arrives

STAGES = ("generating", "verifying", "repairing", "publishing")
UUID_LOWER = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
SHA256_LOWER = re.compile(r"[0-9a-f]{64}")
# `<bucket>.s3.<region>.amazonaws.com`: virtual-hosted and regional (Requirement 21.3).
S3_VIRTUAL_HOST = re.compile(r"[a-z0-9][a-z0-9.-]*\.s3\.[a-z0-9-]+\.amazonaws\.com")
ERROR_CODE = re.compile(r"[A-Z_]{1,64}")

# A check passes with `None`, and fails with a short code from a fixed list (never server text).
Outcome = str | None


@dataclass(frozen=True)
class Settings:
    """The time limits of Requirement 33; tests shorten them."""

    started_s: float = 5.0  # request to `started` (33.5)
    done_s: float = 300.0  # request to `done` (33.5)
    cached_done_s: float = 5.0  # repeated request to `done` (33.7)
    http_s: float = 30.0  # every other request


@dataclass(frozen=True)
class Base:
    """Where the site is: scheme, host, port and an optional path prefix without a trailing /."""

    scheme: str
    host: str
    port: int
    prefix: str = ""


@dataclass(frozen=True)
class Fetched:
    """An object download: the HTTP status, and the body (`None` if it was over the cap)."""

    status: int
    body: bytes | None


def parse_base(argv: list[str]) -> Base | None:
    """The base URL from the arguments, or `None` unless it is exactly one http(s) URL."""
    if len(argv) != 1:
        return None
    try:
        parts = urlsplit(argv[0])
        port = parts.port
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not parts.hostname or "@" in parts.netloc:
        return None
    if parts.query or parts.fragment:
        return None
    default = 443 if parts.scheme == "https" else 80
    return Base(parts.scheme, parts.hostname, port or default, parts.path.rstrip("/"))


class Jar:
    """A cookie jar that holds `name=value` pairs and sends them back; it never prints them."""

    def __init__(self) -> None:
        self._cookies: dict[str, str] = {}

    def store(self, set_cookie_values: list[str]) -> None:
        for raw in set_cookie_values:
            parsed: SimpleCookie = SimpleCookie()
            try:
                parsed.load(raw)
            except CookieError:
                continue
            for name, morsel in parsed.items():
                if morsel["max-age"] == "0":
                    self._cookies.pop(name, None)
                else:
                    self._cookies[name] = morsel.value

    def has(self, name: str) -> bool:
        return name in self._cookies

    def header(self) -> str | None:
        if not self._cookies:
            return None
        return "; ".join(f"{name}={value}" for name, value in self._cookies.items())


@dataclass
class Reply:
    """An HTTP response whose body has not been read yet, and the socket under it."""

    conn: http.client.HTTPConnection
    sock: socket.socket
    response: http.client.HTTPResponse

    @property
    def status(self) -> int:
        return self.response.status

    def values(self, name: str) -> list[str]:
        return self.response.headers.get_all(name) or []

    def close(self) -> None:
        self.response.close()
        self.conn.close()
        try:
            self.sock.close()
        except OSError:
            pass


def _connection(base: Base, timeout: float) -> http.client.HTTPConnection:
    if base.scheme == "https":
        return http.client.HTTPSConnection(
            base.host, base.port, timeout=timeout, context=ssl.create_default_context()
        )
    return http.client.HTTPConnection(base.host, base.port, timeout=timeout)


def send(
    base: Base,
    method: str,
    target: str,
    *,
    timeout: float,
    jar: Jar | None = None,
    body: bytes | None = None,
    accept: str = "*/*",
) -> Reply:
    """Send one request and return as soon as the status line and headers have arrived.

    `Accept-Encoding: identity` keeps a proxy from compressing (and so buffering) the event
    stream. The cookies of `jar` are sent and the ones in the reply are stored. Redirects are never
    followed: a 3xx is a status like any other. Raises `OSError` and friends; the caller turns
    those into a failed check.
    """
    conn = _connection(base, timeout)
    try:
        conn.connect()
        sock = conn.sock
        headers = {
            "Accept": accept,
            "Accept-Encoding": "identity",
            "Connection": "close",
            "User-Agent": USER_AGENT,
        }
        if body is not None:
            headers["Content-Type"] = "application/json"
        cookie = jar.header() if jar is not None else None
        if cookie is not None:
            headers["Cookie"] = cookie
        conn.request(method, base.prefix + target, body=body, headers=headers)
        response = conn.getresponse()
    except BaseException:
        conn.close()
        raise
    reply = Reply(conn, sock, response)
    if jar is not None:
        jar.store(reply.values("Set-Cookie"))
    return reply


def fetch_object(url: str, max_bytes: int, timeout: float) -> Fetched:
    """GET a presigned URL: no cookies, no redirects, at most `max_bytes` of body.

    The cookie jar of the site must never reach S3, so this opens its own connection. The URL
    holds a signature; it is not printed anywhere.
    """
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError("not an http(s) URL")
    default = 443 if parts.scheme == "https" else 80
    base = Base(parts.scheme, parts.hostname, parts.port or default)
    target = parts.path + (f"?{parts.query}" if parts.query else "")
    with closing(send(base, "GET", target, timeout=timeout)) as reply:
        if reply.status != 200:
            return Fetched(reply.status, None)
        body = reply.response.read(max_bytes + 1)
    return Fetched(200, None if len(body) > max_bytes else body)


@dataclass(frozen=True)
class Env:
    """What a test replaces: the clock and the download (no real S3 in tests)."""

    clock: Callable[[], float] = time.monotonic
    fetch: Callable[[str, int, float], Fetched] = fetch_object


@dataclass(frozen=True)
class Event:
    name: str
    data: dict[str, Any]


class EventReader:
    """Reads Server-Sent Events from a reply, one at a time.

    Each read waits at most until `deadline` (on the injected clock). A line is split on the byte
    `\\n` only: the text may hold U+2028. Comments (`: ping`) are skipped, an event that is cut
    off by the end of the stream is dropped, and an event over 8192 bytes is refused.
    """

    def __init__(self, reply: Reply, env: Env) -> None:
        self._reply = reply
        self._env = env

    def read(self, deadline: float) -> Event | str:
        """The next event, or a failure code: `timeout`, `stream_interrupted`, ..."""
        name: str | None = None
        data: list[str] = []
        size = 0
        while True:
            if self._reply.response.isclosed():  # the body ended; a half-read event is dropped
                return "stream_interrupted"
            self._reply.sock.settimeout(max(MIN_WAIT_S, deadline - self._env.clock()))
            try:
                line = self._reply.response.readline(MAX_EVENT_BYTES + 1)
            except TimeoutError:
                return "timeout"
            if not line:
                return "stream_interrupted"
            if len(line) > MAX_EVENT_BYTES:
                return "event_too_large"
            text = line.rstrip(b"\r\n").decode("utf-8")
            if text.startswith(":"):
                if self._env.clock() > deadline:  # pings must not keep a late stream alive
                    return "timeout"
                continue
            size += len(line)
            if size > MAX_EVENT_BYTES:
                return "event_too_large"
            if text:
                key, _, value = text.partition(":")
                value = value.removeprefix(" ")
                if key == "event":
                    name = value
                elif key == "data":
                    data.append(value)
                continue
            if name is None and not data:
                continue  # a blank line that ends nothing
            try:
                payload = json.loads("\n".join(data))
            except ValueError:
                return "invalid_event"
            if not isinstance(payload, dict):
                return "invalid_event"
            return Event(name or "message", payload)


def is_int(value: object, low: int, high: int | None = None) -> bool:
    """A whole number (a bool is not one) from `low` up to `high`."""
    return type(value) is int and value >= low and (high is None or value <= high)


def valid_started(data: dict[str, Any]) -> bool:
    return (
        is_int(data.get("max_attempts"), 1, ATTEMPTS_MAX)
        and is_int(data.get("deadline_ms"), 1)
        and type(data.get("cached")) is bool
    )


def valid_stage(data: dict[str, Any]) -> bool:
    return data.get("stage") in STAGES and is_int(data.get("attempt"), 1, ATTEMPTS_MAX)


def valid_diagnostics(data: dict[str, Any]) -> bool:
    items = data.get("items")
    if not isinstance(items, list) or len(items) > DIAGNOSTIC_ITEMS_MAX:
        return False
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("tool"), str):
            return False
        if not isinstance(item.get("code"), str):
            return False
        if "line" in item and not is_int(item["line"], 1):
            return False
    return (
        is_int(data.get("attempt"), 1, ATTEMPTS_MAX)
        and type(data.get("ok")) is bool
        and is_int(data.get("error_count"), 0)
        and is_int(data.get("warning_count"), 0)
    )


def valid_reference(value: object) -> bool:
    """An Animation_Reference: the ids and hashes in their exact form, the sizes as numbers."""
    if not isinstance(value, dict):
        return False
    animation_id = value.get("animation_id")
    if not isinstance(animation_id, str) or UUID_LOWER.fullmatch(animation_id) is None:
        return False
    for key in ("source_sha256", "bundle_sha256"):
        digest = value.get(key)
        if not isinstance(digest, str) or SHA256_LOWER.fullmatch(digest) is None:
            return False
    sizes = ("width", "height", "fps", "duration_in_frames", "contract_version")
    if not all(is_int(value.get(key), 1) for key in sizes):
        return False
    return "pause_at_frame" not in value or is_int(value["pause_at_frame"], 1)


def valid_done(data: dict[str, Any]) -> bool:
    return (
        valid_reference(data.get("animation"))
        and type(data.get("cached")) is bool
        and is_int(data.get("attempts"), 1, ATTEMPTS_MAX)
    )


def error_reason(event: Event) -> str:
    """`event_error_<CODE>` for an `error` event; the code only if it has the expected form."""
    code = event.data.get("code")
    if isinstance(code, str) and ERROR_CODE.fullmatch(code):
        return f"event_error_{code}"
    return "event_error"


class Flow:
    """The order of the events between `started` and the final one (Requirement 17.12).

    Attempt n opens with `stage generating` (n is 1) or `stage repairing` (n above 1), then may
    have `stage verifying` and one `diagnostics`; `stage publishing` comes only after a
    `diagnostics` with `ok` true and nothing but the final event follows it.
    """

    def __init__(self, max_attempts: int) -> None:
        self._max = max_attempts
        self._attempt = 0
        self._verifying = False
        self._diagnostics: bool | None = None
        self._published = False

    def feed(self, event: Event) -> Outcome:
        if self._published:
            return "event_after_publishing"
        if event.name == "stage":
            return self._stage(event.data)
        if event.name == "diagnostics":
            return self._diagnostics_event(event.data)
        return "unexpected_event"

    def _stage(self, data: dict[str, Any]) -> Outcome:
        if not valid_stage(data):
            return "invalid_stage"
        stage, attempt = data["stage"], data["attempt"]
        if attempt > self._max:
            return "attempt_out_of_range"
        if stage in ("generating", "repairing"):
            if stage != ("generating" if attempt == 1 else "repairing"):
                return "stage_name_mismatch"
            if attempt != self._attempt + 1:
                return "attempt_sequence"
            self._attempt = attempt
            self._verifying = False
            self._diagnostics = None
            return None
        if attempt != self._attempt:
            return "attempt_mismatch"
        if stage == "verifying":
            if self._verifying or self._diagnostics is not None:
                return "stage_out_of_order"
            self._verifying = True
            return None
        if self._diagnostics is not True:  # publishing
            return "publishing_without_ok"
        self._published = True
        return None

    def _diagnostics_event(self, data: dict[str, Any]) -> Outcome:
        if not valid_diagnostics(data):
            return "invalid_diagnostics"
        if data["attempt"] != self._attempt:
            return "attempt_mismatch"
        if self._diagnostics is not None:
            return "duplicate_diagnostics"
        self._diagnostics = data["ok"]
        return None

    def finish(self) -> Outcome:
        """Called with the `done` event in hand."""
        if self._attempt == 0:
            return "no_stage_event"
        return None if self._published else "publishing_missing"


def presigned_problem(url: object, source_sha256: str, name: str) -> Outcome:
    """Why `url` is not the presigned GET URL it should be (Requirement 21.3), or `None`."""
    if not isinstance(url, str):
        return "presigned_url_invalid"
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return "presigned_url_invalid"
    if parts.scheme != "https" or parts.username or port not in (None, 443):
        return "presigned_not_https"
    if parts.hostname is None or S3_VIRTUAL_HOST.fullmatch(parts.hostname) is None:
        return "presigned_host_not_virtual_hosted"
    if parts.path != f"/animations/v1/{source_sha256[:2]}/{source_sha256}/{name}":
        return "presigned_key_mismatch"
    query = parse_qs(parts.query, keep_blank_values=True)
    if query.get("X-Amz-Algorithm") != ["AWS4-HMAC-SHA256"]:
        return "presigned_algorithm_invalid"
    if query.get("X-Amz-Expires") != [PRESIGN_EXPIRES]:
        return "presigned_expires_invalid"
    if not any(query.get("X-Amz-Signature", [])):
        return "presigned_signature_missing"
    return None


def reason_of(exc: BaseException) -> str:
    """A fixed code for an exception: its class says enough, its message may say too much."""
    if isinstance(exc, TimeoutError):
        return "timeout"
    if isinstance(exc, ssl.SSLError):
        return "tls_error"
    if isinstance(exc, OSError):
        return "connection_failed"
    if isinstance(exc, ValueError | http.client.HTTPException):
        return "invalid_response"
    if isinstance(exc, KeyboardInterrupt):
        return "interrupted"
    return f"unexpected_{type(exc).__name__}"


class Smoke:
    """The six checks, in order, with what they pass on to each other."""

    def __init__(self, base: Base, env: Env, settings: Settings) -> None:
        self._base = base
        self._env = env
        self._settings = settings
        self._jar = Jar()
        self._body = json.dumps(SMOKE_REQUEST).encode("utf-8")
        self._reference: dict[str, Any] = {}

    def checks(self) -> list[tuple[str, Callable[[], Outcome]]]:
        return [
            ("sandbox-runtime-html", self.check_runtime_html),
            ("sandbox-runtime-js", self.check_runtime_js),
            ("animation-create", self.check_create),
            ("animation-reader", self.check_reader),
            ("animation-cached", self.check_cached),
            ("animation-other-owner", self.check_other_owner),
        ]

    # -- static files --------------------------------------------------------------------------

    def _get(self, target: str, jar: Jar | None = None) -> Reply:
        return send(self._base, "GET", target, timeout=self._settings.http_s, jar=jar)

    def check_runtime_html(self) -> Outcome:
        with closing(self._get("/sandbox/runtime.html")) as reply:
            if reply.status != 200:
                return f"status_{reply.status}"
            if reply.values("Content-Security-Policy") != [EXPECTED_CSP]:
                return "csp_mismatch"
            nosniff = [value.strip().lower() for value in reply.values("X-Content-Type-Options")]
            if nosniff != ["nosniff"]:
                return "nosniff_missing"
            reply.response.read(STATIC_READ_BYTES)
        return None

    def check_runtime_js(self) -> Outcome:
        with closing(self._get("/sandbox/runtime.js")) as reply:
            if reply.status != 200:
                return f"status_{reply.status}"
            body = reply.response.read(RUNTIME_JS_MAX_BYTES + 1)
        return "runtime_js_too_large" if len(body) > RUNTIME_JS_MAX_BYTES else None

    # -- the event stream ----------------------------------------------------------------------

    def _open_stream(self, timeout: float) -> Reply:
        return send(
            self._base,
            "POST",
            "/api/v1/ai/animations",
            timeout=timeout,
            jar=self._jar,
            body=self._body,
            accept="text/event-stream",
        )

    @staticmethod
    def _stream_problem(reply: Reply) -> Outcome:
        if reply.status != 200:
            return f"status_{reply.status}"
        content_type = reply.values("Content-Type")
        if len(content_type) != 1 or not content_type[0].startswith("text/event-stream"):
            return "not_an_event_stream"
        return None

    def _next(self, reader: EventReader, deadline: float, phase: str) -> Event | str:
        got = reader.read(deadline)
        return f"{phase}_timeout" if got == "timeout" else got

    def _drain(self, reader: EventReader) -> Outcome:
        """After the final event: the stream must end, and no other event may come."""
        got = reader.read(self._env.clock() + DRAIN_S)
        if isinstance(got, Event):
            return "event_after_terminal"
        return None  # the end of the stream, or silence: nothing more arrived

    def check_create(self) -> Outcome:
        settings, clock = self._settings, self._env.clock
        sent = clock()
        with closing(self._open_stream(settings.started_s)) as reply:
            problem = self._stream_problem(reply)
            if problem is not None:
                return problem
            reader = EventReader(reply, self._env)

            first = self._next(reader, sent + settings.started_s, "started")
            if isinstance(first, str):
                return first
            if clock() - sent > settings.started_s:
                return "started_late"
            if first.name != "started" or not valid_started(first.data):
                return "first_event_not_started"
            if first.data["cached"] is not False:
                return "started_cached"

            flow = Flow(first.data["max_attempts"])
            while True:
                got = self._next(reader, sent + settings.done_s, "done")
                if isinstance(got, str):
                    return got
                if got.name == "error":
                    return error_reason(got)
                if got.name == "done":
                    break
                problem = flow.feed(got)
                if problem is not None:
                    return problem
            if clock() - sent > settings.done_s:
                return "done_late"
            if not valid_done(got.data):
                return "invalid_done"
            if got.data["cached"] is not False:
                return "done_cached"
            problem = flow.finish() or self._drain(reader)
            if problem is not None:
                return problem
        if not self._jar.has(COOKIE_NAME):
            return "device_cookie_missing"
        self._reference = got.data["animation"]
        return None

    def check_cached(self) -> Outcome:
        settings, clock = self._settings, self._env.clock
        sent = clock()
        deadline = sent + settings.cached_done_s
        with closing(self._open_stream(settings.cached_done_s)) as reply:
            problem = self._stream_problem(reply)
            if problem is not None:
                return problem
            reader = EventReader(reply, self._env)

            first = self._next(reader, deadline, "started")
            if isinstance(first, str):
                return first
            if first.name != "started" or not valid_started(first.data):
                return "first_event_not_started"
            if first.data["cached"] is not True:
                return "started_not_cached"

            got = self._next(reader, deadline, "done")
            if isinstance(got, str):
                return got
            if got.name == "error":
                return error_reason(got)
            if got.name == "stage":
                return "stage_in_cached_run"
            if got.name != "done":
                return "unexpected_event"
            if clock() - sent > settings.cached_done_s:
                return "done_late"
            if not valid_done(got.data):
                return "invalid_done"
            if got.data["cached"] is not True:
                return "done_not_cached"
            if got.data["animation"] != self._reference:
                return "animation_mismatch"
            return self._drain(reader)

    # -- the reader and the bundle -------------------------------------------------------------

    def _read_json(self, reply: Reply) -> dict[str, Any] | None:
        body = json.loads(reply.response.read(STATIC_READ_BYTES))
        return body if isinstance(body, dict) else None

    def check_reader(self) -> Outcome:
        reference = self._reference
        target = f"/api/v1/animations/{reference['animation_id']}"
        with closing(self._get(target, self._jar)) as reply:
            if reply.status != 200:
                return f"status_{reply.status}"
            if "no-store" not in ",".join(reply.values("Cache-Control")).lower():
                return "cache_control_missing"
            envelope = self._read_json(reply)
        data = envelope.get("data") if envelope is not None else None
        if envelope is None or envelope.get("ok") is not True or not isinstance(data, dict):
            return "invalid_reader_envelope"
        if data.get("animation") != reference:
            return "animation_mismatch"
        if not is_int(data.get("expires_in"), 300, 300):
            return "expires_in_invalid"
        urls = data.get("urls")
        if not isinstance(urls, dict):
            return "invalid_reader_envelope"
        source = reference["source_sha256"]
        for label, name in (("bundle", "main.js"), ("manifest", "manifest.json")):
            problem = presigned_problem(urls.get(label), source, name)
            if problem is not None:
                return problem

        fetched = self._env.fetch(urls["bundle"], BUNDLE_READ_MAX_BYTES, self._settings.http_s)
        if fetched.status != 200:
            return f"bundle_status_{fetched.status}"
        if fetched.body is None:
            return "bundle_too_large"
        if hashlib.sha256(fetched.body).hexdigest() != reference["bundle_sha256"]:
            return "bundle_sha256_mismatch"
        return None

    def check_other_owner(self) -> Outcome:
        target = f"/api/v1/animations/{self._reference['animation_id']}"
        with closing(self._get(target, Jar())) as reply:
            if reply.status != 404:
                return f"status_{reply.status}"
            body = self._read_json(reply)
        return None if body == {"detail": "animation not found"} else "not_found_body_mismatch"


def run(
    argv: list[str],
    *,
    out: TextIO,
    err: TextIO,
    env: Env | None = None,
    settings: Settings | None = None,
) -> int:
    """Run the checks against `argv[0]`; write one line per check to `out`, reasons to `err`."""
    base = parse_base(argv)
    if base is None:
        print(USAGE, file=err)
        return 2
    smoke = Smoke(base, env or Env(), settings or Settings())
    for name, check in smoke.checks():
        try:
            reason = check()
        except (Exception, KeyboardInterrupt) as exc:
            reason = reason_of(exc)
        if reason is None:
            print(f"{name}: PASS", file=out, flush=True)
            continue
        print(f"{name}: FAIL", file=out, flush=True)
        print(f"  reason: {reason}", file=err, flush=True)
        return 1
    return 0


def main() -> int:
    return run(sys.argv[1:], out=sys.stdout, err=sys.stderr, env=Env(fetch=fetch_object))


if __name__ == "__main__":
    raise SystemExit(main())
