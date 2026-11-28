"""Animation_Store: write and presign the three immutable S3 objects of one animation.

Why: a published animation is `main.ts`, `main.js` and `manifest.json` under one key prefix
`animations/v1/<first 2 hex>/<source_sha256>/` (Requirement 19.1, design 6.8, D-10). The objects
are content-addressed and never changed, so the store writes each one only if it does not exist
(`If-None-Match: *`) and writes `manifest.json` last: when a manifest exists, the other two are
there (Requirement 19.3). Two runs that publish the same source share the objects, and the run that
finds a manifest already present adopts it instead of writing (Requirement 19.5).

`publish` is synchronous and meant for `asyncio.to_thread`. It follows design 6.8 step by step:

1. One `get_object` for `manifest.json`. Only 404 means "not there". Any other status (403 too), a
   manifest that is not valid JSON or not a valid `AnimationManifest` (this includes
   `schema_version != 1`), or one whose `source_sha256` is not the key, is `StorageFailed` and
   nothing is written (Requirement 19.12). A valid manifest is adopted: nothing is written.
2. `main.ts`, `main.js`, then `manifest.json`, each with `ChecksumSHA256` (base64 of the raw digest,
   so S3 rejects damaged data) and `IfNoneMatch="*"` (Requirement 19.2 to 19.4).
3. 412: re-read the manifest and adopt it when present. If it is absent and the refused object is
   `main.ts` or `main.js`, download that object and compare its SHA-256 with the local bytes (same:
   go on, different: `StorageFailed`). A refused `manifest.json` that cannot be read back, or any
   other outcome, is `StorageFailed`. 409: repeat that write once, a second 409 is `StorageFailed`
   (Requirement 19.13). 501 on the header: switch to `head_object` before every write for the rest
   of this publish and treat an existing object like a 412 (Requirement 19.11). That mode sends
   the one `put_object` without `IfNoneMatch`, because the region does not support the header; it
   only happens after a `head_object` reported the key absent. Any other failure is `StorageFailed`.
4. Before every S3 call the deadline and the cancel flag are checked. A spent deadline or a
   cancelled run gives `TimedOut` and nothing more is written, so `manifest.json` is never written
   late (Requirement 19.14). `TimedOut.cancelled` tells the two apart. Within one call only the
   client timeouts apply; the agent also wraps `publish` in `asyncio.wait_for`.
5. The module never calls `delete_object`, an unconditional `put_object` (except as noted in 3),
   or `list_objects` (Requirement 19.9).

Result types (`Published`, `Adopted`, `StorageFailed`, `TimedOut`) are returned, not raised.
`publish` catches anything unexpected and returns `StorageFailed` with the exception class name
only. The one exception to "no raise" is `presign`, because design 6.8 fixes its return type as
`dict[str, str]`; it raises `StoreError` (message holds the class name only, never a URL).

`bundle_sha256` is the SHA-256 of the UTF-8 bytes of the bundle text; `source_sha256` is that of the
source, which the caller has already normalised (`normalize_source`). Both byte counts, the hashes,
`schema_version` and `created_at` are set here; everything else in the manifest comes from
`ManifestFields`. The manifest is built through `AnimationManifest`, so it must pass the same
checks as one read back.

Errors from S3 are classified by shape, not by class: an exception with
`response["Error"]["Code"]` and `response["ResponseMetadata"]["HTTPStatusCode"]` is treated as a
`botocore.exceptions.ClientError` (K-2). That keeps `except ClientError` out of this file and lets
tests use a fake client without botocore. Any other exception from a call is a plain failure.

The S3 client comes from `client` (tests) or from `client_factory` on first use, never at import
time. `build_s3_client` is the only place that imports `boto3` and `botocore` and it does so inside
the function, so importing this module, or running it with an injected client, never loads them
(Requirement 41.1). The region is passed explicitly because boto3 does not read `AWS_REGION` (K-2).

[belum diverifikasi] against the real boto3/botocore (not installed in the sandbox): the parameter
names `ChecksumSHA256`, `IfNoneMatch`, `ExpiresIn`, `ClientMethod`/`Params` of
`generate_presigned_url`, that the installed botocore knows `IfNoneMatch` on `put_object` (added
in 2024), and that `retries["max_attempts"]` counts retries after the first call.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol

from pydantic import ValidationError

from app.ai.animation.models import (
    MANIFEST_SCHEMA_VERSION,
    AnimationManifest,
    MainMeta,
    ManifestVerification,
    RuntimeVersion,
)

KEY_ROOT = "animations/v1/"
KEY_SOURCE = "main.ts"
KEY_BUNDLE = "main.js"
KEY_MANIFEST = "manifest.json"

CONTENT_TYPE_SOURCE = "text/typescript; charset=utf-8"
CONTENT_TYPE_BUNDLE = "application/javascript; charset=utf-8"
CONTENT_TYPE_MANIFEST = "application/json; charset=utf-8"

# Client settings of Requirement 19.7 and design 6.8 (Note K-2).
CONNECT_TIMEOUT_S = 5
READ_TIMEOUT_S = 75
RETRY_MAX_ATTEMPTS = 2
# Lifetime of the URLs from `presign` (Requirement 21.3).
PRESIGN_EXPIRES_S = 300

# A real manifest is a few kilobytes; this only stops a broken object from filling memory.
MANIFEST_MAX_READ_BYTES = 262_144
_READ_CHUNK_BYTES = 65_536

_SHA256_HEX = re.compile(r"[0-9a-f]{64}")

# Status implied by an S3 error code when the response has no status (HEAD answers have no body).
_STATUS_OF_CODE: Mapping[str, int] = {
    "PreconditionFailed": 412,
    "ConditionalRequestConflict": 409,
    "NotImplemented": 501,
    "NoSuchKey": 404,
    "NotFound": 404,
    "404": 404,
}


class S3ClientLike(Protocol):
    """The four boto3 S3 client methods this module calls, keyword arguments only."""

    def get_object(self, **kwargs: Any) -> Mapping[str, Any]: ...

    def put_object(self, **kwargs: Any) -> Mapping[str, Any]: ...

    def head_object(self, **kwargs: Any) -> Mapping[str, Any]: ...

    def generate_presigned_url(self, ClientMethod: str, **kwargs: Any) -> str: ...


def client_config_options(region: str) -> dict[str, Any]:
    """Keyword arguments for `botocore.config.Config` (Requirement 19.7, Note K-2).

    A function of its own so a test can check the values without botocore. `region_name` is always
    given: boto3 reads `AWS_DEFAULT_REGION`, not the `AWS_REGION` that the service environment sets.
    """
    return {
        "region_name": region,
        "signature_version": "s3v4",
        "s3": {"addressing_style": "virtual"},
        "connect_timeout": CONNECT_TIMEOUT_S,
        "read_timeout": READ_TIMEOUT_S,
        "retries": {"mode": "standard", "max_attempts": RETRY_MAX_ATTEMPTS},
    }


def build_s3_client(region: str) -> S3ClientLike:
    """Create the real boto3 S3 client. The only place that imports `boto3` and `botocore`.

    A new `Session` is used instead of the process-wide default one: creating clients from the
    default session in several threads at once is not safe, and `publish` runs in worker threads.
    Raises whatever boto3 raises (for example `ModuleNotFoundError`); callers turn that into a
    result.
    """
    from boto3.session import Session
    from botocore.config import Config

    return Session().client("s3", config=Config(**client_config_options(region)))


def animation_prefix(source_sha256: str) -> str:
    """`animations/v1/<first two hex>/<source_sha256>/`, the `s3_prefix` of a registry row."""
    return f"{KEY_ROOT}{source_sha256[:2]}/{source_sha256}/"


@dataclass(frozen=True)
class ManifestFields:
    """The manifest values the store cannot compute itself.

    The store adds `schema_version`, `source_sha256`, `bundle_sha256`, `source_bytes`,
    `bundle_bytes` and `created_at`. `verification.warnings` holds only Diagnostics with severity
    `warning`; `attempts` is 1 to 4.
    """

    contract_version: int
    runtime_version: RuntimeVersion
    meta: MainMeta
    verification: ManifestVerification
    skipped_tokens: tuple[str, ...]
    model: str
    attempts: int
    request_hash: str


@dataclass(frozen=True)
class Published:
    """The three objects were written; `manifest` is the one that was written."""

    manifest: AnimationManifest
    s3_prefix: str


@dataclass(frozen=True)
class Adopted:
    """A manifest already existed for this source; nothing was written and `manifest` is its value.

    The caller records this manifest's values in the registry, not its own (Requirement 19.15).
    """

    manifest: AnimationManifest
    s3_prefix: str


@dataclass(frozen=True)
class StorageFailed:
    """S3 refused or failed; `reason` names the operation and error class or code, nothing more."""

    reason: str


@dataclass(frozen=True)
class TimedOut:
    """The deadline ran out (or the run was cancelled) before the next S3 call could start."""

    cancelled: bool = False


PublishResult = Published | Adopted | StorageFailed | TimedOut


class StoreError(Exception):
    """`presign` could not produce the URLs (invalid hash, client missing, signing failed)."""


@dataclass(frozen=True)
class _Err:
    """What the store needs to know about a failed S3 call, taken from the exception's shape."""

    kind: str
    status: int | None
    code: str | None

    @classmethod
    def of(cls, exc: Exception) -> _Err:
        """Read `exc.response` like a `botocore.exceptions.ClientError` without importing it."""
        status: int | None = None
        code: str | None = None
        response = getattr(exc, "response", None)
        if isinstance(response, Mapping):
            meta = response.get("ResponseMetadata")
            if isinstance(meta, Mapping):
                raw_status = meta.get("HTTPStatusCode")
                if isinstance(raw_status, int) and not isinstance(raw_status, bool):
                    status = raw_status
            error = response.get("Error")
            if isinstance(error, Mapping):
                raw_code = error.get("Code")
                if isinstance(raw_code, str):
                    code = raw_code
        return cls(type(exc).__name__, status, code)

    @property
    def effective_status(self) -> int | None:
        if self.status is not None:
            return self.status
        return _STATUS_OF_CODE.get(self.code) if self.code is not None else None

    def describe(self) -> str:
        parts = [self.kind]
        if self.status is not None:
            parts.append(f"status={self.status}")
        if self.code is not None:
            parts.append(f"code={self.code}")
        return " ".join(parts)


class _Done(Exception):
    """Ends `publish` early with a result. Never leaves this module."""

    def __init__(self, result: PublishResult) -> None:
        super().__init__()
        self.result = result


@dataclass
class _Run:
    """State of one `publish` call."""

    client: S3ClientLike
    prefix: str
    source_sha256: str
    remaining_ms: Callable[[], float] | None
    cancelled: Callable[[], bool] | None
    head_mode: bool = False

    def check(self) -> None:
        """Stop with `TimedOut` if the run was cancelled or the deadline is spent."""
        if self.cancelled is not None and self.cancelled():
            raise _Done(TimedOut(cancelled=True))
        if self.remaining_ms is not None and self.remaining_ms() <= 0:
            raise _Done(TimedOut())


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _b64_sha256(data: bytes) -> str:
    return base64.b64encode(hashlib.sha256(data).digest()).decode("ascii")


def _reject_constant(name: str) -> object:
    raise ValueError(f"{name} is not valid JSON")


class S3AnimationStore:
    """Publishes animations to one bucket and builds presigned read URLs."""

    def __init__(
        self,
        bucket: str,
        region: str,
        *,
        client: S3ClientLike | None = None,
        client_factory: Callable[[str], S3ClientLike] = build_s3_client,
        now: Callable[[], datetime] = _utc_now,
    ) -> None:
        """`client` is for tests; otherwise `client_factory(region)` runs on first use."""
        self._bucket = bucket
        self._region = region
        self._client = client
        self._factory = client_factory
        self._now = now
        self._lock = threading.Lock()

    # -- client ---------------------------------------------------------------------------------

    def _s3(self) -> S3ClientLike:
        """The client, created once on first use (thread-safe)."""
        with self._lock:
            if self._client is None:
                self._client = self._factory(self._region)
            return self._client

    # -- publish --------------------------------------------------------------------------------

    def publish(
        self,
        source: str,
        bundle: str,
        fields: ManifestFields,
        *,
        remaining_ms: Callable[[], float] | None = None,
        cancelled: Callable[[], bool] | None = None,
    ) -> PublishResult:
        """Write the animation, or adopt the one already there. Never raises.

        `remaining_ms` returns the milliseconds left of the run (`RunContext.remaining_ms`) and
        `cancelled` tells whether the run was cancelled (`RunContext.cancelled.is_set`); both are
        read before every S3 call. Without them there is no deadline and no cancellation.
        """
        try:
            return self._publish(source, bundle, fields, remaining_ms, cancelled)
        except _Done as done:
            return done.result
        except Exception as exc:
            return StorageFailed(f"unexpected error ({type(exc).__name__})")

    def _publish(
        self,
        source: str,
        bundle: str,
        fields: ManifestFields,
        remaining_ms: Callable[[], float] | None,
        cancelled: Callable[[], bool] | None,
    ) -> PublishResult:
        try:
            source_bytes = source.encode("utf-8")
            bundle_bytes = bundle.encode("utf-8")
        except UnicodeEncodeError:
            return StorageFailed("source or bundle is not valid UTF-8 text")
        source_sha = hashlib.sha256(source_bytes).hexdigest()
        prefix = animation_prefix(source_sha)
        manifest = self._build_manifest(source_bytes, bundle_bytes, source_sha, fields)
        if isinstance(manifest, StorageFailed):
            return manifest
        try:
            client = self._s3()
        except Exception as exc:
            return StorageFailed(f"s3 client unavailable ({type(exc).__name__})")
        run = _Run(client, prefix, source_sha, remaining_ms, cancelled)

        existing = self._read_manifest(run)
        if existing is not None:
            return Adopted(existing, prefix)

        manifest_bytes = json.dumps(
            manifest.dump(), ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8")
        self._write(run, KEY_SOURCE, source_bytes, CONTENT_TYPE_SOURCE)
        self._write(run, KEY_BUNDLE, bundle_bytes, CONTENT_TYPE_BUNDLE)
        self._write(run, KEY_MANIFEST, manifest_bytes, CONTENT_TYPE_MANIFEST)
        return Published(manifest, prefix)

    def _build_manifest(
        self, source_bytes: bytes, bundle_bytes: bytes, source_sha: str, fields: ManifestFields
    ) -> AnimationManifest | StorageFailed:
        """The manifest to write, validated like one read back; a bad input is `StorageFailed`."""
        created_at = self._now().astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        raw = {
            "schema_version": MANIFEST_SCHEMA_VERSION,
            "contract_version": fields.contract_version,
            "runtime_version": fields.runtime_version.dump(),
            "source_sha256": source_sha,
            "bundle_sha256": hashlib.sha256(bundle_bytes).hexdigest(),
            "source_bytes": len(source_bytes),
            "bundle_bytes": len(bundle_bytes),
            "meta": fields.meta.dump(),
            "verification": fields.verification.dump(),
            "skipped_tokens": list(fields.skipped_tokens),
            "model": fields.model,
            "attempts": fields.attempts,
            "request_hash": fields.request_hash,
            "created_at": created_at,
        }
        try:
            return AnimationManifest.model_validate(raw)
        except ValidationError:
            # The error text would quote the values, so only the fact is reported.
            return StorageFailed("the manifest values are not valid")

    # -- S3 calls -------------------------------------------------------------------------------

    def _call(
        self, run: _Run, operation: str, **params: Any
    ) -> tuple[Mapping[str, Any] | None, _Err | None]:
        """One S3 call after the deadline and cancel check: `(reply, None)` or `(None, error)`."""
        run.check()
        try:
            reply = getattr(run.client, operation)(**params)
        except Exception as exc:
            return None, _Err.of(exc)
        return reply, None

    def _read_body(self, reply: Mapping[str, Any] | None, limit: int, what: str) -> bytes | None:
        """The reply body as bytes, or None when it is longer than `limit`.

        Raises `_Done(StorageFailed)` when there is no body or reading it fails.
        """
        body = reply.get("Body") if reply is not None else None
        if body is None:
            raise _Done(StorageFailed(f"{what}: the reply has no body"))
        chunks: list[bytes] = []
        total = 0
        try:
            while True:
                chunk = body.read(min(_READ_CHUNK_BYTES, limit + 1 - total))
                if not chunk:
                    break
                total += len(chunk)
                if total > limit:
                    return None
                chunks.append(chunk)
        except Exception as exc:
            raise _Done(
                StorageFailed(f"{what}: reading the body failed ({_Err.of(exc).kind})")
            ) from exc
        finally:
            close = getattr(body, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:  # Closing a finished stream must not hide the result.
                    pass
        return b"".join(chunks)

    def _read_manifest(self, run: _Run) -> AnimationManifest | None:
        """One GET of `manifest.json`: the manifest, or None for 404.

        Anything else (another status, 403, bad JSON, wrong schema version or `source_sha256`)
        raises `_Done(StorageFailed)`.
        """
        reply, err = self._call(
            run, "get_object", Bucket=self._bucket, Key=run.prefix + KEY_MANIFEST
        )
        if err is not None:
            if err.effective_status == 404:
                return None
            raise _Done(StorageFailed(f"get manifest.json failed: {err.describe()}"))
        raw = self._read_body(reply, MANIFEST_MAX_READ_BYTES, "get manifest.json")
        if raw is None:
            raise _Done(StorageFailed("get manifest.json: the object is too large"))
        try:
            parsed = json.loads(raw.decode("utf-8"), parse_constant=_reject_constant)
            manifest = AnimationManifest.model_validate(parsed)
        except (UnicodeDecodeError, ValueError, RecursionError):
            # `ValidationError` is a `ValueError`; no text is copied from the object.
            raise _Done(StorageFailed("manifest.json is not a valid manifest")) from None
        if manifest.source_sha256 != run.source_sha256:
            raise _Done(StorageFailed("manifest.json belongs to a different source"))
        return manifest

    def _exists(self, run: _Run, key: str) -> bool:
        """`head_object` for the HEAD mode: True if present, False for 404, else `_Done`."""
        _, err = self._call(run, "head_object", Bucket=self._bucket, Key=key)
        if err is None:
            return True
        if err.effective_status == 404:
            return False
        raise _Done(StorageFailed(f"head {key.rsplit('/', 1)[-1]} failed: {err.describe()}"))

    def _on_exists(self, run: _Run, name: str, local: bytes) -> None:
        """S3 says `name` already exists. Adopt a manifest, or check the object matches `local`.

        Raises `_Done` to finish (adopt or fail); returns normally when the existing object has the
        same bytes and the publish can go on.
        """
        manifest = self._read_manifest(run)
        if manifest is not None:
            raise _Done(Adopted(manifest, run.prefix))
        if name == KEY_MANIFEST:
            raise _Done(StorageFailed("manifest.json exists but cannot be read back"))
        reply, err = self._call(run, "get_object", Bucket=self._bucket, Key=run.prefix + name)
        if err is not None:
            raise _Done(StorageFailed(f"get {name} failed: {err.describe()}"))
        existing = self._read_body(reply, len(local), f"get {name}")
        if existing is None or hashlib.sha256(existing).digest() != hashlib.sha256(local).digest():
            raise _Done(StorageFailed(f"{name} already exists with different content"))

    def _write(self, run: _Run, name: str, body: bytes, content_type: str) -> None:
        """Write one object if it is absent; see the module docstring, step 3."""
        key = run.prefix + name
        conflicts = 0
        while True:
            if run.head_mode and self._exists(run, key):
                self._on_exists(run, name, body)
                return
            params: dict[str, Any] = {
                "Bucket": self._bucket,
                "Key": key,
                "Body": body,
                "ContentType": content_type,
                "ChecksumSHA256": _b64_sha256(body),
            }
            if not run.head_mode:
                params["IfNoneMatch"] = "*"
            _, err = self._call(run, "put_object", **params)
            if err is None:
                return
            status = err.effective_status
            if status == 412:
                self._on_exists(run, name, body)
                return
            if status == 409 and conflicts == 0:
                conflicts = 1
                continue
            if status == 501 and not run.head_mode:
                run.head_mode = True
                continue
            raise _Done(StorageFailed(f"put {name} failed: {err.describe()}"))

    # -- presign --------------------------------------------------------------------------------

    def presign(self, source_sha256: str) -> dict[str, str]:
        """GET URLs for `main.js` and `manifest.json`, valid for 300 seconds. No S3 call.

        Signing uses the credentials already cached by the client, so it makes no request to S3
        (Requirement 21.3, 21.7). Returns `{"bundle": url, "manifest": url}`. Raises `StoreError`
        for a `source_sha256` that is not 64 lowercase hex characters or when signing fails.
        """
        if _SHA256_HEX.fullmatch(source_sha256) is None:
            raise StoreError("source_sha256 must be 64 lowercase hex characters")
        prefix = animation_prefix(source_sha256)
        try:
            client = self._s3()
            urls = {
                label: client.generate_presigned_url(
                    "get_object",
                    Params={"Bucket": self._bucket, "Key": prefix + name},
                    ExpiresIn=PRESIGN_EXPIRES_S,
                )
                for label, name in (("bundle", KEY_BUNDLE), ("manifest", KEY_MANIFEST))
            }
        except Exception as exc:
            raise StoreError(f"presign failed ({type(exc).__name__})") from None
        if not all(isinstance(url, str) and url for url in urls.values()):
            raise StoreError("presign failed (no URL returned)")
        return urls
