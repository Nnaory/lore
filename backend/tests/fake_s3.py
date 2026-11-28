"""In-memory S3 client double for the Animation_Store tests (no moto, no boto3, no network).

Why: `store.py` talks to S3 through four methods and classifies failures by the shape of
`exc.response`, so a small hand-written double is enough to drive every branch of design 6.8 and
it works in the sandbox where boto3 is not installed. It is also what the round-trip property test
(task 16.2) uses.

What it models, as S3 does:

- `put_object` checks the base64 `ChecksumSHA256` against the body (`BadDigest` 400 otherwise),
  and `IfNoneMatch="*"` against an existing key (`PreconditionFailed` 412). With
  `supports_conditional=False` the header answers `NotImplemented` 501, like a region without
  conditional writes.
- `get_object` returns `{"Body": <file-like>}` or `NoSuchKey` 404; `head_object` answers a missing
  key with code `"404"`, as a HEAD has no body.
- Unknown parameter names raise `TypeError` (botocore raises `ParamValidationError`), so a
  misspelled `IfNoneMatch` shows up as a failure instead of passing silently.
- Any method the store should never call (`delete_object`, `list_objects_v2`, ...) is recorded in
  `unexpected` and raises `AttributeError`.

Faults and races are scripted: `fail(...)` makes the next matching calls fail with an S3 error or
a given exception; `before(...)` runs a function once just before a matching call executes, which
is how a second writer that wins a race is simulated. Every call is recorded in `calls` before it
runs, so a test can count calls at the moment a fake deadline expires.
"""

from __future__ import annotations

import base64
import hashlib
import io
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

PUT_PARAMS = {"Bucket", "Key", "Body", "ContentType", "ChecksumSHA256", "IfNoneMatch"}


class FakeClientError(Exception):
    """Has the `response` shape of `botocore.exceptions.ClientError`, and nothing else."""

    def __init__(self, status: int, code: str) -> None:
        super().__init__(f"{code} ({status})")
        self.response = {
            "Error": {"Code": code, "Message": "fake"},
            "ResponseMetadata": {"HTTPStatusCode": status},
        }


@dataclass(frozen=True)
class Call:
    """One recorded client call: the method, the key's last segment and the parameters."""

    op: str
    name: str
    params: dict[str, Any]


@dataclass
class _Fault:
    op: str
    name: str
    error: Exception
    times: int


@dataclass
class _Hook:
    op: str
    name: str
    action: Callable[[], None]


@dataclass
class FakeS3:
    """The S3 double; `objects` maps a full key to its bytes."""

    bucket: str = "lore-bucket"
    region: str = "ap-southeast-3"
    supports_conditional: bool = True
    objects: dict[str, bytes] = field(default_factory=dict)
    content_types: dict[str, str] = field(default_factory=dict)
    calls: list[Call] = field(default_factory=list)
    unexpected: list[str] = field(default_factory=list)
    bodies: list[io.BytesIO] = field(default_factory=list)
    _faults: list[_Fault] = field(default_factory=list)
    _hooks: list[_Hook] = field(default_factory=list)

    # -- scripting ------------------------------------------------------------------------------

    def fail(
        self,
        op: str,
        name: str,
        status: int = 500,
        code: str = "InternalError",
        *,
        times: int = 1,
        exc: Exception | None = None,
    ) -> None:
        """Fail the next `times` calls of `op` on a key ending in `name`."""
        self._faults.append(_Fault(op, name, exc or FakeClientError(status, code), times))

    def before(self, op: str, name: str, action: Callable[[], None]) -> None:
        """Run `action` once, just before the next `op` on a key ending in `name` executes."""
        self._hooks.append(_Hook(op, name, action))

    # -- views for assertions -------------------------------------------------------------------

    def ops(self) -> list[str]:
        """`"get_object manifest.json"`-style labels in call order."""
        return [f"{call.op} {call.name}".strip() for call in self.calls]

    def calls_of(self, op: str, name: str | None = None) -> list[Call]:
        return [c for c in self.calls if c.op == op and (name is None or c.name == name)]

    def keys(self) -> set[str]:
        return set(self.objects)

    # -- machinery ------------------------------------------------------------------------------

    def _enter(self, op: str, params: dict[str, Any]) -> str:
        key = str(params.get("Key", ""))
        name = key.rsplit("/", 1)[-1]
        self.calls.append(Call(op, name, dict(params)))
        for hook in list(self._hooks):
            if hook.op == op and name.endswith(hook.name):
                self._hooks.remove(hook)
                hook.action()
        for fault in self._faults:
            if fault.op == op and name.endswith(fault.name) and fault.times > 0:
                fault.times -= 1
                raise fault.error
        if params.get("Bucket") != self.bucket:
            raise FakeClientError(404, "NoSuchBucket")
        return key

    def get_object(self, **kwargs: Any) -> dict[str, Any]:
        unknown = set(kwargs) - {"Bucket", "Key"}
        if unknown:
            raise TypeError(f"unknown parameters for get_object: {sorted(unknown)}")
        key = self._enter("get_object", kwargs)
        if key not in self.objects:
            raise FakeClientError(404, "NoSuchKey")
        body = io.BytesIO(self.objects[key])
        self.bodies.append(body)
        return {"Body": body, "ContentLength": len(self.objects[key])}

    def head_object(self, **kwargs: Any) -> dict[str, Any]:
        unknown = set(kwargs) - {"Bucket", "Key"}
        if unknown:
            raise TypeError(f"unknown parameters for head_object: {sorted(unknown)}")
        key = self._enter("head_object", kwargs)
        if key not in self.objects:
            raise FakeClientError(404, "404")
        return {"ContentLength": len(self.objects[key])}

    def put_object(self, **kwargs: Any) -> dict[str, Any]:
        unknown = set(kwargs) - PUT_PARAMS
        if unknown:
            raise TypeError(f"unknown parameters for put_object: {sorted(unknown)}")
        key = self._enter("put_object", kwargs)
        body = kwargs["Body"]
        if not isinstance(body, bytes):
            raise TypeError("Body must be bytes")
        digest = base64.b64encode(hashlib.sha256(body).digest()).decode("ascii")
        if kwargs.get("ChecksumSHA256") != digest:
            raise FakeClientError(400, "BadDigest")
        condition = kwargs.get("IfNoneMatch")
        if condition is not None:
            if condition != "*":
                raise TypeError("IfNoneMatch must be '*'")
            if not self.supports_conditional:
                raise FakeClientError(501, "NotImplemented")
            if key in self.objects:
                raise FakeClientError(412, "PreconditionFailed")
        self.objects[key] = body
        self.content_types[key] = str(kwargs.get("ContentType", ""))
        return {"ETag": '"fake"'}

    def generate_presigned_url(
        self,
        ClientMethod: str,
        Params: dict[str, Any] | None = None,
        ExpiresIn: int = 3600,
        HttpMethod: str | None = None,
    ) -> str:
        params = dict(Params or {})
        self.calls.append(
            Call(
                "generate_presigned_url",
                str(params.get("Key", "")).rsplit("/", 1)[-1],
                {
                    "ClientMethod": ClientMethod,
                    "Params": params,
                    "ExpiresIn": ExpiresIn,
                    "HttpMethod": HttpMethod,
                },
            )
        )
        return (
            f"https://{params['Bucket']}.s3.{self.region}.amazonaws.com/{params['Key']}"
            f"?X-Amz-Expires={ExpiresIn}&X-Amz-Signature=fake"
        )

    def __getattr__(self, name: str) -> Any:
        # Only reached for names that are not defined above, such as `delete_object`.
        if name.startswith("_"):
            raise AttributeError(name)
        self.unexpected.append(name)
        raise AttributeError(f"the store must not call {name}")
