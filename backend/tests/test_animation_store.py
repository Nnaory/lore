"""Tests for the Animation_Store (`app.ai.animation.store`) against an in-memory S3 double.

Why: the store decides what is written to the bucket, in which order, and what happens when S3
answers 412, 409, 501, 403 or nothing in time (Requirements 19.1 to 19.9, 19.11 to 19.15, 21.3,
21.7, 41.1; design 6.8, D-10, 10.2). Every branch is driven by `tests/fake_s3.FakeS3`, which keeps
objects in a dict, checks `ChecksumSHA256` and `IfNoneMatch` like S3 and records each call. There is
no moto, no boto3 and no network.

What is NOT proved here (boto3 and botocore are not installed in the sandbox):

- that the real botocore accepts the parameter names the store sends (`ChecksumSHA256`,
  `IfNoneMatch`, `ExpiresIn`) and builds the expected `Config`. `test_real_botocore_*` check that
  when botocore is installed (CI); here they are skipped, and a skip is NOT evidence.
- how real `botocore.exceptions.ClientError` and real S3 answers look. The store reads the
  documented `response["Error"]["Code"]` and `response["ResponseMetadata"]["HTTPStatusCode"]`
  shape, and the double raises exactly that shape.
"""

from __future__ import annotations

import ast
import base64
import copy
import hashlib
import json
import subprocess
import sys
import types
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from app.ai.animation import store as store_module
from app.ai.animation.models import AnimationManifest
from app.ai.animation.store import (
    CONTENT_TYPE_BUNDLE,
    CONTENT_TYPE_MANIFEST,
    CONTENT_TYPE_SOURCE,
    MANIFEST_MAX_READ_BYTES,
    Adopted,
    ManifestFields,
    Published,
    S3AnimationStore,
    StorageFailed,
    StoreError,
    TimedOut,
    animation_prefix,
    build_s3_client,
    client_config_options,
)
from tests.fake_s3 import FakeS3

BACKEND_DIR = Path(__file__).resolve().parent.parent
FIXTURES = Path(__file__).parent / "fixtures" / "animation"
BUCKET = "lore-bucket"
REGION = "ap-southeast-3"
FIXED_NOW = datetime(2026, 11, 27, 9, 41, 3, tzinfo=UTC)

# Non-ASCII on purpose: the bundle hash must be taken over UTF-8 bytes, not characters.
SOURCE = (
    "export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 210 };\n"
    "export default function Main() { return null; } // é → 日本\n"
)
BUNDLE = "var Main=()=>null;export{Main as default};/* é → 日本 😀 */\n"

SOURCE_SHA = hashlib.sha256(SOURCE.encode("utf-8")).hexdigest()
BUNDLE_SHA = hashlib.sha256(BUNDLE.encode("utf-8")).hexdigest()
PREFIX = f"animations/v1/{SOURCE_SHA[:2]}/{SOURCE_SHA}/"
KEY_TS = PREFIX + "main.ts"
KEY_JS = PREFIX + "main.js"
KEY_MANIFEST = PREFIX + "manifest.json"

HAPPY_OPS = [
    "get_object manifest.json",
    "put_object main.ts",
    "put_object main.js",
    "put_object manifest.json",
]


def _fixture_manifest() -> dict[str, Any]:
    return json.loads((FIXTURES / "manifest-valid.json").read_text(encoding="utf-8"))


def make_fields() -> ManifestFields:
    """Fields taken from the shared valid manifest fixture (the same ones the agent will pass)."""
    manifest = AnimationManifest.model_validate(_fixture_manifest())
    return ManifestFields(
        contract_version=manifest.contract_version,
        runtime_version=manifest.runtime_version,
        meta=manifest.meta,
        verification=manifest.verification,
        skipped_tokens=tuple(manifest.skipped_tokens),
        model=manifest.model,
        attempts=manifest.attempts,
        request_hash=manifest.request_hash,
    )


def make_store(fake: FakeS3) -> S3AnimationStore:
    return S3AnimationStore(BUCKET, REGION, client=fake, now=lambda: FIXED_NOW)


def racer_manifest_bytes(**changes: Any) -> bytes:
    """A manifest another run wrote for the same source, with its own bundle, attempts and model."""
    raw = copy.deepcopy(_fixture_manifest())
    raw["source_sha256"] = SOURCE_SHA
    raw["bundle_sha256"] = hashlib.sha256(b"another bundle").hexdigest()
    raw["bundle_bytes"] = len(b"another bundle")
    raw["source_bytes"] = len(SOURCE.encode("utf-8"))
    raw["attempts"] = 3
    raw["model"] = "racer-model"
    raw.update(changes)
    return json.dumps(raw).encode("utf-8")


def publish(fake: FakeS3, **kwargs: Any) -> Any:
    return make_store(fake).publish(SOURCE, BUNDLE, make_fields(), **kwargs)


def written_manifest(fake: FakeS3) -> AnimationManifest:
    return AnimationManifest.model_validate(json.loads(fake.objects[KEY_MANIFEST]))


# --- happy path: order, keys, parameters, manifest ------------------------------------------


def test_publish_writes_get_then_main_ts_main_js_manifest_last() -> None:
    fake = FakeS3()
    result = publish(fake)
    assert isinstance(result, Published)
    assert fake.ops() == HAPPY_OPS
    assert fake.unexpected == []
    assert fake.keys() == {KEY_TS, KEY_JS, KEY_MANIFEST}


def test_keys_follow_the_content_addressed_layout() -> None:
    assert animation_prefix(SOURCE_SHA) == PREFIX
    assert PREFIX == f"animations/v1/{SOURCE_SHA[:2]}/{SOURCE_SHA}/"
    fake = FakeS3()
    result = publish(fake)
    assert isinstance(result, Published)
    assert result.s3_prefix == PREFIX


def test_every_write_is_conditional_checksummed_and_typed() -> None:
    fake = FakeS3()
    publish(fake)
    expected = {
        "main.ts": (SOURCE.encode("utf-8"), CONTENT_TYPE_SOURCE),
        "main.js": (BUNDLE.encode("utf-8"), CONTENT_TYPE_BUNDLE),
        "manifest.json": (fake.objects[KEY_MANIFEST], CONTENT_TYPE_MANIFEST),
    }
    puts = fake.calls_of("put_object")
    assert [c.name for c in puts] == list(expected)
    for call in puts:
        body, content_type = expected[call.name]
        assert call.params["Bucket"] == BUCKET
        assert call.params["Body"] == body
        assert call.params["ContentType"] == content_type
        assert call.params["IfNoneMatch"] == "*"
        digest = base64.b64encode(hashlib.sha256(body).digest()).decode("ascii")
        assert call.params["ChecksumSHA256"] == digest
        assert set(call.params) == {
            "Bucket",
            "Key",
            "Body",
            "ContentType",
            "ChecksumSHA256",
            "IfNoneMatch",
        }
    assert CONTENT_TYPE_SOURCE == "text/typescript; charset=utf-8"
    assert CONTENT_TYPE_BUNDLE == "application/javascript; charset=utf-8"
    assert CONTENT_TYPE_MANIFEST == "application/json; charset=utf-8"


def test_hashes_are_taken_over_utf8_bytes() -> None:
    fake = FakeS3()
    result = publish(fake)
    assert isinstance(result, Published)
    manifest = result.manifest
    assert manifest.source_sha256 == SOURCE_SHA
    assert manifest.bundle_sha256 == BUNDLE_SHA
    assert manifest.source_bytes == len(SOURCE.encode("utf-8")) > len(SOURCE)
    assert manifest.bundle_bytes == len(BUNDLE.encode("utf-8")) > len(BUNDLE)
    # Not the hash of the UTF-16 or Latin-1 form of the same characters.
    assert BUNDLE_SHA != hashlib.sha256(BUNDLE.encode("utf-16")).hexdigest()
    assert BUNDLE_SHA != hashlib.sha256(BUNDLE.encode("latin-1", errors="replace")).hexdigest()


def test_manifest_written_is_valid_complete_and_equals_the_result() -> None:
    fake = FakeS3()
    result = publish(fake)
    assert isinstance(result, Published)
    on_disk = written_manifest(fake)
    assert on_disk == result.manifest
    fixture = _fixture_manifest()
    raw = json.loads(fake.objects[KEY_MANIFEST])
    assert raw["schema_version"] == 1
    assert raw["created_at"] == "2026-11-27T09:41:03Z"
    assert raw["skipped_tokens"] == fixture["skipped_tokens"]
    assert raw["meta"] == fixture["meta"]  # camelCase keys on the wire
    assert raw["verification"] == fixture["verification"]
    assert raw["model"] == fixture["model"]
    assert raw["attempts"] == fixture["attempts"]
    assert raw["request_hash"] == fixture["request_hash"]
    assert raw["runtime_version"] == fixture["runtime_version"]
    assert raw["contract_version"] == fixture["contract_version"]


def test_empty_skipped_tokens_are_written_as_an_empty_list() -> None:
    fake = FakeS3()
    result = make_store(fake).publish(SOURCE, BUNDLE, _with(make_fields(), skipped_tokens=()))
    assert isinstance(result, Published)
    assert json.loads(fake.objects[KEY_MANIFEST])["skipped_tokens"] == []


def test_round_trip_reads_back_identical_bytes_and_hashes() -> None:
    fake = FakeS3()
    result = publish(fake)
    assert isinstance(result, Published)
    assert fake.objects[KEY_TS] == SOURCE.encode("utf-8")
    assert fake.objects[KEY_JS] == BUNDLE.encode("utf-8")
    assert hashlib.sha256(fake.objects[KEY_TS]).hexdigest() == result.manifest.source_sha256
    assert hashlib.sha256(fake.objects[KEY_JS]).hexdigest() == result.manifest.bundle_sha256
    assert fake.content_types[KEY_TS] == CONTENT_TYPE_SOURCE


def test_response_bodies_are_closed() -> None:
    fake = FakeS3()
    fake.objects[KEY_MANIFEST] = racer_manifest_bytes()
    publish(fake)
    assert fake.bodies
    assert all(body.closed for body in fake.bodies)


def test_invalid_manifest_values_fail_before_any_s3_call() -> None:
    fake = FakeS3()
    result = make_store(fake).publish(SOURCE, BUNDLE, _with(make_fields(), attempts=9))
    assert isinstance(result, StorageFailed)
    assert fake.calls == []
    # The reason must not quote the offending values.
    assert "9" not in result.reason


def test_empty_source_is_rejected_without_a_call() -> None:
    fake = FakeS3()
    result = make_store(fake).publish("", BUNDLE, make_fields())
    assert isinstance(result, StorageFailed)
    assert fake.calls == []


def test_a_source_that_is_not_utf8_encodable_is_a_result_not_an_exception() -> None:
    fake = FakeS3()
    result = make_store(fake).publish("abc\ud800", BUNDLE, make_fields())
    assert isinstance(result, StorageFailed)
    assert fake.calls == []


def _with(fields: ManifestFields, **changes: Any) -> ManifestFields:
    return ManifestFields(**{**fields.__dict__, **changes})


# --- adoption ---------------------------------------------------------------------------------


def test_existing_manifest_is_adopted_and_nothing_is_written() -> None:
    fake = FakeS3()
    fake.objects[KEY_MANIFEST] = racer_manifest_bytes()
    before = dict(fake.objects)
    result = publish(fake)
    assert isinstance(result, Adopted)
    assert fake.ops() == ["get_object manifest.json"]
    assert fake.objects == before
    assert result.s3_prefix == PREFIX
    # The values come from the manifest, not from this run's fields.
    assert result.manifest.attempts == 3
    assert result.manifest.model == "racer-model"
    assert result.manifest.bundle_sha256 == hashlib.sha256(b"another bundle").hexdigest()
    assert result.manifest.bundle_bytes == len(b"another bundle")


def test_adoption_does_not_need_main_ts_or_main_js_to_be_read() -> None:
    fake = FakeS3()
    fake.objects[KEY_MANIFEST] = racer_manifest_bytes()
    publish(fake)
    assert fake.calls_of("get_object", "main.ts") == []
    assert fake.calls_of("get_object", "main.js") == []


# --- 412 on each of the three objects -------------------------------------------------------


def test_412_on_manifest_rereads_and_adopts_the_winner() -> None:
    fake = FakeS3()
    fake.before(
        "put_object",
        "manifest.json",
        lambda: fake.objects.__setitem__(KEY_MANIFEST, racer_manifest_bytes()),
    )
    result = publish(fake)
    assert isinstance(result, Adopted)
    assert fake.ops() == [*HAPPY_OPS, "get_object manifest.json"]
    assert result.manifest.model == "racer-model"
    # The racer's manifest was not overwritten.
    assert fake.objects[KEY_MANIFEST] == racer_manifest_bytes()


def test_412_on_manifest_that_cannot_be_read_back_is_storage_failed() -> None:
    fake = FakeS3()
    fake.fail("put_object", "manifest.json", 412, "PreconditionFailed")
    result = publish(fake)
    assert isinstance(result, StorageFailed)
    assert fake.ops() == [*HAPPY_OPS, "get_object manifest.json"]
    assert KEY_MANIFEST not in fake.objects


def test_412_on_manifest_with_a_broken_winner_is_storage_failed() -> None:
    fake = FakeS3()
    fake.before(
        "put_object",
        "manifest.json",
        lambda: fake.objects.__setitem__(KEY_MANIFEST, b"{not json"),
    )
    assert isinstance(publish(fake), StorageFailed)


@pytest.mark.parametrize("name", ["main.ts", "main.js"])
def test_412_on_an_object_adopts_a_manifest_that_appeared(name: str) -> None:
    fake = FakeS3()
    key = PREFIX + name
    body = SOURCE.encode("utf-8") if name == "main.ts" else BUNDLE.encode("utf-8")

    def winner_arrives() -> None:
        fake.objects[key] = body
        fake.objects[KEY_MANIFEST] = racer_manifest_bytes()

    fake.before("put_object", name, winner_arrives)
    result = publish(fake)
    assert isinstance(result, Adopted)
    assert fake.calls_of("put_object", "manifest.json") == []


@pytest.mark.parametrize("name", ["main.ts", "main.js"])
def test_412_on_an_object_with_the_same_bytes_and_no_manifest_goes_on(name: str) -> None:
    fake = FakeS3()
    key = PREFIX + name
    body = SOURCE.encode("utf-8") if name == "main.ts" else BUNDLE.encode("utf-8")
    fake.objects[key] = body  # left behind by a run that stopped before the manifest
    result = publish(fake)
    assert isinstance(result, Published)
    assert fake.objects[key] == body
    assert fake.keys() == {KEY_TS, KEY_JS, KEY_MANIFEST}
    assert f"get_object {name}" in fake.ops()
    assert fake.ops()[-1] == "put_object manifest.json"


@pytest.mark.parametrize("name", ["main.ts", "main.js"])
def test_412_on_an_object_with_different_bytes_fails_and_writes_no_manifest(name: str) -> None:
    fake = FakeS3()
    key = PREFIX + name
    fake.objects[key] = b"something else"
    result = publish(fake)
    assert isinstance(result, StorageFailed)
    assert "different content" in result.reason
    assert fake.objects[key] == b"something else"  # never overwritten
    assert KEY_MANIFEST not in fake.objects


def test_existing_object_that_is_longer_than_the_local_one_is_different() -> None:
    fake = FakeS3()
    fake.objects[KEY_TS] = SOURCE.encode("utf-8") + b"\n// extra"
    result = publish(fake)
    assert isinstance(result, StorageFailed)
    assert KEY_MANIFEST not in fake.objects


def test_412_followed_by_a_failed_download_is_storage_failed() -> None:
    fake = FakeS3()
    fake.objects[KEY_TS] = SOURCE.encode("utf-8")
    fake.fail("get_object", "main.ts", 403, "AccessDenied")
    result = publish(fake)
    assert isinstance(result, StorageFailed)
    assert KEY_JS not in fake.objects


# --- 409 ---------------------------------------------------------------------------------------


def test_409_is_repeated_once_and_then_succeeds() -> None:
    fake = FakeS3()
    fake.fail("put_object", "main.js", 409, "ConditionalRequestConflict", times=1)
    result = publish(fake)
    assert isinstance(result, Published)
    assert [c.name for c in fake.calls_of("put_object")] == [
        "main.ts",
        "main.js",
        "main.js",
        "manifest.json",
    ]


def test_second_409_is_storage_failed_and_there_is_no_third_attempt() -> None:
    fake = FakeS3()
    fake.fail("put_object", "main.js", 409, "ConditionalRequestConflict", times=5)
    result = publish(fake)
    assert isinstance(result, StorageFailed)
    assert len(fake.calls_of("put_object", "main.js")) == 2
    assert KEY_MANIFEST not in fake.objects


def test_409_then_412_follows_the_412_rules() -> None:
    fake = FakeS3()
    fake.fail("put_object", "manifest.json", 409, "ConditionalRequestConflict", times=1)
    # After the 409 the winner appears, so the repeated write meets a real 412 and adopts it.
    fake.before(
        "put_object",
        "manifest.json",
        lambda: fake.objects.__setitem__(KEY_MANIFEST, racer_manifest_bytes()),
    )
    assert isinstance(publish(fake), Adopted)


# --- 501: HEAD mode ----------------------------------------------------------------------------


def test_501_switches_to_head_before_every_write() -> None:
    fake = FakeS3(supports_conditional=False)
    result = publish(fake)
    assert isinstance(result, Published)
    assert fake.ops() == [
        "get_object manifest.json",
        "put_object main.ts",  # refused with 501, header not supported
        "head_object main.ts",
        "put_object main.ts",
        "head_object main.js",
        "put_object main.js",
        "head_object manifest.json",
        "put_object manifest.json",
    ]
    puts = fake.calls_of("put_object")
    assert "IfNoneMatch" in puts[0].params
    assert all("IfNoneMatch" not in call.params for call in puts[1:])
    assert all("ChecksumSHA256" in call.params for call in puts)
    assert fake.keys() == {KEY_TS, KEY_JS, KEY_MANIFEST}


def test_501_mode_treats_an_existing_object_like_412() -> None:
    fake = FakeS3(supports_conditional=False)
    fake.objects[KEY_TS] = SOURCE.encode("utf-8")
    result = publish(fake)
    assert isinstance(result, Published)
    # The existing main.ts was compared, not rewritten.
    assert len(fake.calls_of("put_object", "main.ts")) == 1
    assert "get_object main.ts" in fake.ops()


def test_501_mode_with_a_different_existing_object_fails() -> None:
    fake = FakeS3(supports_conditional=False)
    fake.objects[KEY_JS] = b"different"
    result = publish(fake)
    assert isinstance(result, StorageFailed)
    assert fake.objects[KEY_JS] == b"different"
    assert KEY_MANIFEST not in fake.objects


def test_501_mode_adopts_a_manifest_found_by_head() -> None:
    fake = FakeS3(supports_conditional=False)
    fake.before(
        "head_object",
        "manifest.json",
        lambda: fake.objects.__setitem__(KEY_MANIFEST, racer_manifest_bytes()),
    )
    result = publish(fake)
    assert isinstance(result, Adopted)
    assert len(fake.calls_of("put_object", "manifest.json")) == 0


def test_a_second_501_in_head_mode_ends_with_storage_failed() -> None:
    fake = FakeS3()
    fake.fail("put_object", "main.ts", 501, "NotImplemented", times=9)
    result = publish(fake)
    assert isinstance(result, StorageFailed)
    assert len(fake.calls_of("put_object", "main.ts")) == 2


def test_head_error_other_than_404_is_storage_failed() -> None:
    fake = FakeS3(supports_conditional=False)
    fake.fail("head_object", "main.ts", 403, "403")
    result = publish(fake)
    assert isinstance(result, StorageFailed)
    assert fake.keys() == set()


# --- failures ---------------------------------------------------------------------------------


def test_403_on_the_manifest_get_is_storage_failed_and_nothing_is_written() -> None:
    fake = FakeS3()
    fake.fail("get_object", "manifest.json", 403, "AccessDenied")
    result = publish(fake)
    assert isinstance(result, StorageFailed)
    assert "403" in result.reason
    assert fake.ops() == ["get_object manifest.json"]
    assert fake.objects == {}


def test_500_on_the_manifest_get_is_storage_failed() -> None:
    fake = FakeS3()
    fake.fail("get_object", "manifest.json", 500, "InternalError")
    assert isinstance(publish(fake), StorageFailed)
    assert fake.objects == {}


@pytest.mark.parametrize("name", ["main.ts", "main.js", "manifest.json"])
def test_403_on_a_put_is_storage_failed(name: str) -> None:
    fake = FakeS3()
    fake.fail("put_object", name, 403, "AccessDenied")
    result = publish(fake)
    assert isinstance(result, StorageFailed)
    assert "AccessDenied" in result.reason
    assert len(fake.calls_of("put_object", name)) == 1
    if name != "manifest.json":
        assert KEY_MANIFEST not in fake.objects


def test_an_error_that_is_not_a_client_error_is_storage_failed_with_its_class_name() -> None:
    fake = FakeS3()
    fake.fail("put_object", "main.js", exc=TimeoutError("read timed out"))
    result = publish(fake)
    assert isinstance(result, StorageFailed)
    assert "TimeoutError" in result.reason
    assert "read timed out" not in result.reason
    assert KEY_MANIFEST not in fake.objects


def test_a_bad_digest_from_s3_is_storage_failed() -> None:
    fake = FakeS3()
    fake.fail("put_object", "main.ts", 400, "BadDigest")
    result = publish(fake)
    assert isinstance(result, StorageFailed)
    assert "BadDigest" in result.reason


@pytest.mark.parametrize(
    "raw",
    [
        b"",
        b"{not json",
        b"[]",
        b'{"schema_version": 1}',
        b'{"schema_version": NaN}',
        b"\xff\xfe\xfa",
        b"null",
    ],
    ids=["empty", "bad-json", "array", "missing-fields", "nan", "not-utf8", "null"],
)
def test_a_manifest_that_is_not_valid_is_storage_failed_with_no_writes(raw: bytes) -> None:
    fake = FakeS3()
    fake.objects[KEY_MANIFEST] = raw
    result = publish(fake)
    assert isinstance(result, StorageFailed)
    assert fake.calls_of("put_object") == []
    assert fake.objects == {KEY_MANIFEST: raw}


def test_manifest_with_another_schema_version_is_storage_failed() -> None:
    fake = FakeS3()
    fake.objects[KEY_MANIFEST] = racer_manifest_bytes(schema_version=2)
    assert isinstance(publish(fake), StorageFailed)
    assert fake.calls_of("put_object") == []


def test_manifest_for_another_source_is_storage_failed() -> None:
    fake = FakeS3()
    fake.objects[KEY_MANIFEST] = racer_manifest_bytes(source_sha256="0" * 64)
    result = publish(fake)
    assert isinstance(result, StorageFailed)
    assert "different source" in result.reason
    assert fake.calls_of("put_object") == []


def test_an_oversized_manifest_is_storage_failed() -> None:
    fake = FakeS3()
    fake.objects[KEY_MANIFEST] = b" " * (MANIFEST_MAX_READ_BYTES + 1)
    result = publish(fake)
    assert isinstance(result, StorageFailed)
    assert "too large" in result.reason
    assert fake.calls_of("put_object") == []


def test_a_failure_reason_never_contains_source_bundle_or_keys() -> None:
    fake = FakeS3()
    fake.fail("put_object", "main.js", 403, "AccessDenied")
    result = publish(fake)
    assert isinstance(result, StorageFailed)
    for secret in (SOURCE, BUNDLE, SOURCE_SHA, BUCKET, "animations/"):
        assert secret not in result.reason


# --- deadline and cancellation ---------------------------------------------------------------


def _deadline_after(fake: FakeS3, allowed: int) -> Callable[[], float]:
    """A fake `remaining_ms` that is positive until `allowed` calls were recorded, then 0."""
    return lambda: 1.0 if len(fake.calls) < allowed else 0.0


@pytest.mark.parametrize("allowed", [0, 1, 2, 3])
def test_a_deadline_that_expires_after_n_calls_stops_and_never_writes_the_manifest(
    allowed: int,
) -> None:
    fake = FakeS3()
    result = publish(fake, remaining_ms=_deadline_after(fake, allowed))
    assert result == TimedOut(cancelled=False)
    assert len(fake.calls) == allowed
    assert KEY_MANIFEST not in fake.objects


def test_a_deadline_that_never_expires_lets_all_four_calls_through() -> None:
    fake = FakeS3()
    result = publish(fake, remaining_ms=lambda: 1.0)
    assert isinstance(result, Published)
    assert len(fake.calls) == 4


def test_a_negative_remaining_time_counts_as_expired() -> None:
    fake = FakeS3()
    assert publish(fake, remaining_ms=lambda: -5.0) == TimedOut()
    assert fake.calls == []


@pytest.mark.parametrize("allowed", [0, 1, 2, 3])
def test_a_cancelled_run_starts_no_further_call(allowed: int) -> None:
    fake = FakeS3()
    result = publish(fake, cancelled=lambda: len(fake.calls) >= allowed)
    assert result == TimedOut(cancelled=True)
    assert len(fake.calls) == allowed
    assert KEY_MANIFEST not in fake.objects


def test_deadline_and_cancel_are_checked_before_the_head_and_reread_calls_too() -> None:
    # 501 path: get, put (501), head, put, head, put, head, put = 8 calls when nothing stops it.
    for allowed in range(8):
        fake = FakeS3(supports_conditional=False)
        result = publish(fake, remaining_ms=_deadline_after(fake, allowed))
        assert result == TimedOut()
        assert len(fake.calls) == allowed
        assert KEY_MANIFEST not in fake.objects


def test_a_deadline_that_runs_out_before_a_reread_does_not_adopt_or_write() -> None:
    fake = FakeS3()
    fake.before(
        "put_object",
        "manifest.json",
        lambda: fake.objects.__setitem__(KEY_MANIFEST, racer_manifest_bytes()),
    )
    result = publish(fake, remaining_ms=_deadline_after(fake, 4))
    assert result == TimedOut()  # the 412 came back, but the re-read could not start
    assert fake.objects[KEY_MANIFEST] == racer_manifest_bytes()


# --- the store never deletes, lists or writes without a condition -------------------------------


def _names_used_in_code(path: Path) -> set[str]:
    """Attribute names, identifiers and string literals in `path`, docstrings left out."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    docstrings: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Module | ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef):
            first = node.body[0] if node.body else None
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant):
                docstrings.add(id(first.value))
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute):
            names.add(node.attr)
        elif isinstance(node, ast.Name):
            names.add(node.id)
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            if id(node) not in docstrings:
                names.add(node.value)
    return names


def test_only_get_put_and_head_are_called_and_no_forbidden_method_exists_in_the_source() -> None:
    for fake in (FakeS3(), FakeS3(supports_conditional=False)):
        publish(fake)
        assert fake.unexpected == []
        assert {c.op for c in fake.calls} <= {"get_object", "put_object", "head_object"}
    forbidden = {"delete_object", "delete_objects", "list_objects", "list_objects_v2"}
    assert not forbidden & _names_used_in_code(Path(store_module.__file__))


def test_without_the_501_path_every_put_carries_if_none_match() -> None:
    fake = FakeS3()
    publish(fake)
    assert all(c.params.get("IfNoneMatch") == "*" for c in fake.calls_of("put_object"))


# --- presign ----------------------------------------------------------------------------------


def test_presign_returns_two_urls_for_main_js_and_manifest_with_300_seconds() -> None:
    fake = FakeS3()
    urls = make_store(fake).presign(SOURCE_SHA)
    assert set(urls) == {"bundle", "manifest"}
    calls = fake.calls_of("generate_presigned_url")
    assert len(calls) == 2
    assert [c.params["Params"] for c in calls] == [
        {"Bucket": BUCKET, "Key": KEY_JS},
        {"Bucket": BUCKET, "Key": KEY_MANIFEST},
    ]
    assert all(c.params["ClientMethod"] == "get_object" for c in calls)
    assert all(c.params["ExpiresIn"] == 300 for c in calls)
    assert urls["bundle"].startswith(f"https://{BUCKET}.s3.{REGION}.amazonaws.com/{KEY_JS}")
    assert urls["manifest"].startswith(f"https://{BUCKET}.s3.{REGION}.amazonaws.com/{KEY_MANIFEST}")


def test_presign_makes_no_s3_request() -> None:
    fake = FakeS3()
    make_store(fake).presign(SOURCE_SHA)
    assert {c.op for c in fake.calls} == {"generate_presigned_url"}
    assert fake.unexpected == []


@pytest.mark.parametrize(
    "bad",
    ["", "A" * 64, SOURCE_SHA.upper(), SOURCE_SHA[:-1], SOURCE_SHA + "0", "../" + SOURCE_SHA[3:]],
    ids=["empty", "all-caps", "upper-hex", "63", "65", "traversal"],
)
def test_presign_rejects_a_hash_that_is_not_64_lowercase_hex(bad: str) -> None:
    fake = FakeS3()
    with pytest.raises(StoreError):
        make_store(fake).presign(bad)
    assert fake.calls == []


def test_presign_wraps_a_signing_failure_without_leaking_detail() -> None:
    class Broken(FakeS3):
        def generate_presigned_url(self, *args: Any, **kwargs: Any) -> str:
            raise RuntimeError("secret-credential-detail")

    with pytest.raises(StoreError) as caught:
        make_store(Broken()).presign(SOURCE_SHA)
    assert "RuntimeError" in str(caught.value)
    assert "secret-credential-detail" not in str(caught.value)


def test_presign_wraps_a_missing_client_factory_result() -> None:
    def factory(region: str) -> Any:
        raise ModuleNotFoundError("No module named 'boto3'")

    store = S3AnimationStore(BUCKET, REGION, client_factory=factory)
    with pytest.raises(StoreError) as caught:
        store.presign(SOURCE_SHA)
    assert "ModuleNotFoundError" in str(caught.value)


# --- lazy client ------------------------------------------------------------------------------


def test_the_client_factory_runs_on_first_use_only_and_with_the_region() -> None:
    fake = FakeS3()
    seen: list[str] = []

    def factory(region: str) -> FakeS3:
        seen.append(region)
        return fake

    store = S3AnimationStore(BUCKET, REGION, client_factory=factory, now=lambda: FIXED_NOW)
    assert seen == []  # construction builds nothing
    assert isinstance(store.publish(SOURCE, BUNDLE, make_fields()), Published)
    store.publish(SOURCE, BUNDLE, make_fields())
    store.presign(SOURCE_SHA)
    assert seen == [REGION]


def test_a_client_that_cannot_be_built_is_storage_failed_not_an_exception() -> None:
    def factory(region: str) -> Any:
        raise ModuleNotFoundError("No module named 'boto3'")

    store = S3AnimationStore(BUCKET, REGION, client_factory=factory)
    result = store.publish(SOURCE, BUNDLE, make_fields())
    assert isinstance(result, StorageFailed)
    assert "ModuleNotFoundError" in result.reason


def test_an_unexpected_exception_is_a_result_not_a_raise() -> None:
    class Exploding(FakeS3):
        def get_object(self, **kwargs: Any) -> Any:
            return ["not", "a", "mapping"]  # breaks inside the store's own code, not in S3

    result = make_store(Exploding()).publish(SOURCE, BUNDLE, make_fields())
    assert isinstance(result, StorageFailed)
    assert "unexpected error (AttributeError)" == result.reason


# --- client configuration and import hygiene --------------------------------------------------


def test_client_config_options_match_requirement_19_7_and_note_k_2() -> None:
    assert client_config_options("ap-southeast-3") == {
        "region_name": "ap-southeast-3",
        "signature_version": "s3v4",
        "s3": {"addressing_style": "virtual"},
        "connect_timeout": 5,
        "read_timeout": 75,
        "retries": {"mode": "standard", "max_attempts": 2},
    }


def test_build_s3_client_passes_the_options_to_config_and_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Wiring only, with stand-in modules; the real botocore is not available in the sandbox."""
    made: dict[str, Any] = {}

    class FakeConfig:
        def __init__(self, **kwargs: Any) -> None:
            made["config_kwargs"] = kwargs

    class FakeSession:
        def client(self, service: str, **kwargs: Any) -> str:
            made["service"] = service
            made["client_kwargs"] = kwargs
            return "client"

    boto3 = types.ModuleType("boto3")
    boto3_session = types.ModuleType("boto3.session")
    boto3_session.Session = FakeSession  # type: ignore[attr-defined]
    botocore = types.ModuleType("botocore")
    botocore_config = types.ModuleType("botocore.config")
    botocore_config.Config = FakeConfig  # type: ignore[attr-defined]
    for name, module in {
        "boto3": boto3,
        "boto3.session": boto3_session,
        "botocore": botocore,
        "botocore.config": botocore_config,
    }.items():
        monkeypatch.setitem(sys.modules, name, module)

    assert build_s3_client("ap-southeast-3") == "client"
    assert made["config_kwargs"] == client_config_options("ap-southeast-3")
    assert made["service"] == "s3"
    assert isinstance(made["client_kwargs"]["config"], FakeConfig)


def test_build_s3_client_without_boto3_raises_import_error_for_the_caller_to_wrap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(sys.modules, "boto3", None)
    monkeypatch.setitem(sys.modules, "boto3.session", None)
    with pytest.raises(ImportError):
        build_s3_client(REGION)


_IMPORT_CHECK = """
import json, sys
import app.ai.animation.store
loaded = sorted(m for m in sys.modules if m.split('.')[0] in ('boto3', 'botocore', 'langgraph'))
print(json.dumps(loaded))
"""

_WORKING_CHECK = """
import sys
# A real import of boto3 or botocore from now on raises ImportError.
sys.modules['boto3'] = None
sys.modules['botocore'] = None
from datetime import UTC, datetime
from app.ai.animation.store import Published, S3AnimationStore
from tests.fake_s3 import FakeS3
from tests.test_animation_store import BUNDLE, SOURCE, SOURCE_SHA, make_fields
store = S3AnimationStore('b', 'ap-southeast-3', client=FakeS3(bucket='b'))
result = store.publish(SOURCE, BUNDLE, make_fields())
assert isinstance(result, Published), result
urls = store.presign(SOURCE_SHA)
assert set(urls) == {'bundle', 'manifest'}
print('ok')
"""


def _run_python(code: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, cwd=BACKEND_DIR, timeout=120
    )


def test_importing_the_store_module_loads_neither_boto3_nor_botocore_nor_langgraph() -> None:
    done = _run_python(_IMPORT_CHECK)
    assert done.returncode == 0, done.stderr
    assert json.loads(done.stdout) == []


def test_publish_and_presign_with_an_injected_client_never_import_boto3() -> None:
    done = _run_python(_WORKING_CHECK)
    assert done.returncode == 0, done.stderr
    assert done.stdout.strip() == "ok"


def test_the_source_file_imports_boto3_only_inside_the_factory_function() -> None:
    source = Path(store_module.__file__).read_text(encoding="utf-8")
    boto_imports = ("import boto3", "from boto3", "import botocore", "from botocore")
    for number, line in enumerate(source.splitlines(), start=1):
        if line.lstrip().startswith(boto_imports):
            assert line.startswith("    "), f"module-level import of boto at line {number}"


# --- the real botocore (CI only: not installed in the sandbox) --------------------------------


def test_real_botocore_knows_the_parameters_and_builds_the_expected_config() -> None:
    pytest.importorskip(
        "botocore", reason="[belum diverifikasi] botocore is not installed in this environment"
    )
    from botocore.config import Config

    options = client_config_options(REGION)
    config = Config(**options)
    assert config.region_name == REGION
    assert config.signature_version == "s3v4"
    assert config.s3 == {"addressing_style": "virtual"}
    assert config.connect_timeout == 5
    assert config.read_timeout == 75
    assert config.retries == {"mode": "standard", "max_attempts": 2}


def test_real_boto3_client_knows_the_put_parameters_and_signs_virtual_host_urls_offline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip(
        "boto3", reason="[belum diverifikasi] boto3 is not installed in this environment"
    )
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIAEXAMPLEEXAMPLE")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "example-secret-not-real")
    monkeypatch.setenv("AWS_EC2_METADATA_DISABLED", "true")
    client = build_s3_client(REGION)
    operation = client.meta.service_model.operation_model("PutObject")  # type: ignore[attr-defined]
    members = operation.input_shape.members
    assert {"ChecksumSHA256", "IfNoneMatch", "ContentType", "Body", "Bucket", "Key"} <= set(members)
    urls = S3AnimationStore(BUCKET, REGION, client=client).presign(SOURCE_SHA)
    for url in urls.values():
        assert url.startswith(f"https://{BUCKET}.s3.{REGION}.amazonaws.com/animations/v1/")
        assert "X-Amz-Expires=300" in url
        assert "X-Amz-Algorithm=AWS4-HMAC-SHA256" in url
