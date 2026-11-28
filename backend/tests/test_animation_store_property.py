"""Property test: what the Animation_Store writes to S3 reads back identical (Property 4, S3 half).

Why: the player's browser downloads `main.js` and checks it against `bundle_sha256` before it runs
(Requirement 26), and the Reader and the registry hand out `source_sha256` and `bundle_sha256`
taken from the manifest. If a write changed one byte (a wrong encoding, a cut body, an escaped
character, a newline rewritten) or if the manifest described other bytes than the ones stored,
every later load would fail the integrity check, or worse, run code that was not verified.
Requirement 19.10 states the property: for any valid source, writing the three objects and reading
them back gives byte-identical objects whose SHA-256 equal `source_sha256` and `bundle_sha256`.

The store is driven against the in-memory S3 double (`tests/fake_s3.py`: it checks the base64
`ChecksumSHA256` of each body, answers `If-None-Match: *` with 412, and records each call). The
objects are read back through the same client API a reader would use (`get_object`), not through
the double's dictionary. `hypothesis` is not a dependency, so the pairs `(source, bundle)` come
from seeded `random.Random` instances (40 seeds): multi-byte text (2, 3 and 4 bytes), CRLF and
lone CR that must survive untouched, empty lines, very long lines, a one-byte pair, and pairs
that are exactly at the byte limits of the contract (32768 and 131072).

Per pair the test checks:

- the keys written are exactly `animations/v1/<2 hex>/<source_sha256>/{main.ts,main.js,
  manifest.json}`, computed here from the hash of the source taken before the write;
- `main.ts` and `main.js` read back byte for byte, and decode to the original strings;
- the SHA-256 of the bytes read back equals the hash taken before the write, and equals the
  hashes in the manifest that was read back; the manifest byte counts equal the lengths;
- the manifest read back is the one `publish` returned (`Published.manifest`);
- a second publish of the same source (even with another bundle) adopts the stored manifest
  and writes nothing, so the stored bytes stay identical (Requirement 19.5);
- two independent runs give the same bytes (no hidden randomness in what is stored).

Everything runs without boto3, botocore, the network or AWS.
"""

from __future__ import annotations

import base64
import copy
import hashlib
import json
import random
from datetime import UTC, datetime
from pathlib import Path

import pytest

from app.ai.animation.contract import ContractOk, load_contract
from app.ai.animation.models import AnimationManifest
from app.ai.animation.store import (
    CONTENT_TYPE_BUNDLE,
    CONTENT_TYPE_MANIFEST,
    CONTENT_TYPE_SOURCE,
    Adopted,
    ManifestFields,
    Published,
    S3AnimationStore,
)
from tests.fake_s3 import FakeS3

SEEDS = 40
BUCKET = "lore-bucket"
REGION = "ap-southeast-3"
FIXED_NOW = datetime(2026, 11, 27, 9, 41, 3, tzinfo=UTC)
MANIFEST_FIXTURE = Path(__file__).parent / "fixtures" / "animation" / "manifest-valid.json"

# Text pieces, with their UTF-8 length in the comment. The mix makes character count differ from
# byte count, so a store that counted characters or used another encoding is caught.
PIECES: tuple[str, ...] = (
    "export const meta = { durationInFrames: 90 };",  # ASCII
    "const x = 1;",
    "\n",
    "\r\n",
    "\r",
    "\n\n\n",
    "\t",
    " ",
    "\u00e9",  # 2 bytes
    "\u00df",
    "\u03a9",
    "\u65e5\u672c\u8a9e",  # 3 bytes each
    "\u2192",
    "\u2028",
    "\U0001f600",  # 4 bytes
    "\U0001d400",
    "e\u0301",
    "\ufeff",
    "\x00",
    "// comment \u2014 dash",
    '"quote"',
    "\\u00e9",
    "}",
)

BOUNDARY_SOURCE_BYTES = 32768
BOUNDARY_BUNDLE_BYTES = 131072


def _limits() -> tuple[int, int]:
    loaded = load_contract()
    assert isinstance(loaded, ContractOk)
    limits = loaded.contract.limits
    return limits.source_max_bytes, limits.bundle_max_bytes


def exact_bytes(rng: random.Random, size: int) -> str:
    """Text whose UTF-8 encoding is exactly `size` bytes, from pieces of mixed byte width."""
    parts: list[str] = []
    used = 0
    while used < size:
        piece = rng.choice(PIECES)
        width = len(piece.encode("utf-8"))
        if used + width > size:
            piece, width = "a", 1
        parts.append(piece)
        used += width
    text = "".join(parts)
    assert len(text.encode("utf-8")) == size
    return text


def random_text(rng: random.Random, max_pieces: int) -> str:
    return "".join(rng.choice(PIECES) for _ in range(rng.randint(1, max_pieces)))


def random_pair(seed: int) -> tuple[str, str, str]:
    """`(source, bundle, shape)` for the seed; every tenth seed sits on a byte limit."""
    rng = random.Random(f"store-{seed}")
    source_limit, bundle_limit = _limits()
    assert (source_limit, bundle_limit) == (BOUNDARY_SOURCE_BYTES, BOUNDARY_BUNDLE_BYTES)
    if seed % 10 == 0:
        return exact_bytes(rng, source_limit), exact_bytes(rng, bundle_limit), "at the limits"
    if seed % 10 == 5:
        return chr(ord("a") + seed % 26), chr(ord("A") + seed % 26), "one byte each"
    if seed % 10 == 7:
        line = "const longLine = '" + "\u00e9" * (3000 + seed * 10) + "';"
        return line + "\n", line.replace("const", "var") + "\n", "one very long line"
    source = random_text(rng, 400)
    bundle = random_text(rng, 800)
    return source, bundle, "random"


def fields_for(seed: int) -> ManifestFields:
    """Manifest fields that vary with the seed (the store computes hashes and sizes itself)."""
    rng = random.Random(f"fields-{seed}")
    base = json.loads(MANIFEST_FIXTURE.read_text(encoding="utf-8"))
    manifest = AnimationManifest.model_validate(base)
    duration = rng.randint(30, 900)
    meta = copy.deepcopy(base["meta"])
    meta["durationInFrames"] = duration
    if rng.random() < 0.5:
        meta["pauseAtFrame"] = rng.randint(1, duration - 1)
    else:
        meta.pop("pauseAtFrame", None)
    verification = copy.deepcopy(base["verification"])
    verification["verifier_version"] = (
        f"{rng.randint(0, 3)}.{rng.randint(0, 9)}.{rng.randint(0, 9)}"
    )
    if rng.random() < 0.5:
        verification["warnings"] = []
    checked = AnimationManifest.model_validate({**base, "meta": meta, "verification": verification})
    return ManifestFields(
        contract_version=manifest.contract_version,
        runtime_version=manifest.runtime_version,
        meta=checked.meta,
        verification=checked.verification,
        skipped_tokens=tuple(
            rng.choice(["#fff", "rgb(1,2,3)", "https://x", "caf\u00e9", "\U0001f600"])
            for _ in range(rng.randint(0, 4))
        ),
        model=rng.choice(["gemini-3.5-flash-lite", "model-\u00e9", "m"]),
        attempts=rng.randint(1, 4),
        request_hash=hashlib.sha256(f"request-{seed}".encode()).hexdigest(),
    )


def make_store(fake: FakeS3) -> S3AnimationStore:
    return S3AnimationStore(BUCKET, REGION, client=fake, now=lambda: FIXED_NOW)


def read_back(fake: FakeS3, key: str) -> bytes:
    """What a reader gets: one `get_object` call, then the body."""
    reply = fake.get_object(Bucket=BUCKET, Key=key)
    body = reply["Body"]
    data: bytes = body.read()
    body.close()
    return data


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# --- the property -------------------------------------------------------------------------


@pytest.mark.parametrize("seed", range(SEEDS))
def test_three_objects_read_back_byte_identical_with_the_hashes_taken_before_writing(
    seed: int,
) -> None:
    source, bundle, _ = random_pair(seed)
    source_bytes, bundle_bytes = source.encode("utf-8"), bundle.encode("utf-8")
    source_hash_before, bundle_hash_before = sha(source_bytes), sha(bundle_bytes)
    prefix = f"animations/v1/{source_hash_before[:2]}/{source_hash_before}/"

    fake = FakeS3()
    result = make_store(fake).publish(source, bundle, fields_for(seed))
    assert isinstance(result, Published), result
    assert fake.unexpected == []

    # Exactly three objects, under the content-addressed prefix.
    assert fake.keys() == {prefix + "main.ts", prefix + "main.js", prefix + "manifest.json"}
    assert result.s3_prefix == prefix

    # Byte identity, read through the client.
    stored_source = read_back(fake, prefix + "main.ts")
    stored_bundle = read_back(fake, prefix + "main.js")
    stored_manifest = read_back(fake, prefix + "manifest.json")
    assert stored_source == source_bytes
    assert stored_bundle == bundle_bytes
    assert stored_source.decode("utf-8") == source
    assert stored_bundle.decode("utf-8") == bundle

    # The hashes of what was stored equal the hashes taken before the write.
    assert sha(stored_source) == source_hash_before
    assert sha(stored_bundle) == bundle_hash_before

    # The manifest read back describes exactly those bytes.
    manifest = AnimationManifest.model_validate(json.loads(stored_manifest))
    assert manifest.source_sha256 == source_hash_before == sha(stored_source)
    assert manifest.bundle_sha256 == bundle_hash_before == sha(stored_bundle)
    assert manifest.source_bytes == len(stored_source)
    assert manifest.bundle_bytes == len(stored_bundle)
    assert manifest.dump() == result.manifest.dump()
    assert manifest.created_at == "2026-11-27T09:41:03Z"

    # Each object was sent with the checksum of its body and the right content type.
    for name, body, content_type in (
        ("main.ts", source_bytes, CONTENT_TYPE_SOURCE),
        ("main.js", bundle_bytes, CONTENT_TYPE_BUNDLE),
        ("manifest.json", stored_manifest, CONTENT_TYPE_MANIFEST),
    ):
        (call,) = fake.calls_of("put_object", name)
        assert (
            call.params["ChecksumSHA256"]
            == base64.b64encode(hashlib.sha256(body).digest()).decode()
        )
        assert call.params["IfNoneMatch"] == "*"
        assert call.params["Body"] == body
        assert fake.content_types[prefix + name] == content_type


@pytest.mark.parametrize("seed", range(SEEDS))
def test_publishing_the_same_source_again_adopts_the_stored_objects_and_writes_nothing(
    seed: int,
) -> None:
    source, bundle, _ = random_pair(seed)
    fake = FakeS3()
    first = make_store(fake).publish(source, bundle, fields_for(seed))
    assert isinstance(first, Published)
    snapshot = dict(fake.objects)
    puts_before = len(fake.calls_of("put_object"))

    # Same source, different bundle and fields: the stored animation wins (Requirement 19.5).
    other = bundle[::-1] if bundle[::-1] != bundle else bundle + "z"
    second = make_store(fake).publish(source, other, fields_for(seed + 1000))
    assert isinstance(second, Adopted)
    assert second.manifest.dump() == first.manifest.dump()
    assert second.s3_prefix == first.s3_prefix
    assert fake.objects == snapshot
    assert len(fake.calls_of("put_object")) == puts_before

    # And the same pair again gives the same adopted value.
    third = make_store(fake).publish(source, bundle, fields_for(seed))
    assert isinstance(third, Adopted)
    assert third.manifest.dump() == first.manifest.dump()
    assert fake.objects == snapshot


@pytest.mark.parametrize("seed", range(SEEDS))
def test_two_independent_runs_store_the_same_bytes(seed: int) -> None:
    source, bundle, _ = random_pair(seed)
    one, two = FakeS3(), FakeS3()
    assert isinstance(make_store(one).publish(source, bundle, fields_for(seed)), Published)
    assert isinstance(make_store(two).publish(source, bundle, fields_for(seed)), Published)
    assert one.objects == two.objects
    assert one.ops() == two.ops()


@pytest.mark.parametrize("seed", range(SEEDS))
def test_presigned_urls_point_at_the_keys_that_were_written(seed: int) -> None:
    """The Reader signs the keys by hash alone; they must be the keys `publish` wrote."""
    source, bundle, _ = random_pair(seed)
    fake = FakeS3()
    result = make_store(fake).publish(source, bundle, fields_for(seed))
    assert isinstance(result, Published)
    urls = make_store(fake).presign(result.manifest.source_sha256)
    for label, name in (("bundle", "main.js"), ("manifest", "manifest.json")):
        key = f"{result.s3_prefix}{name}"
        assert key in fake.objects
        assert f"/{key}?" in urls[label]
        assert "X-Amz-Expires=300" in urls[label]
    assert fake.calls_of("get_object") == [] or all(
        call.name == "manifest.json" for call in fake.calls_of("get_object")
    )


# --- guards: the pairs are as varied as the property needs ---------------------------------


def test_the_generated_pairs_cover_the_shapes_the_property_is_about() -> None:
    shapes: set[str] = set()
    pairs = [random_pair(seed) for seed in range(SEEDS)]
    for _source, _bundle, shape in pairs:
        shapes.add(shape)
    assert shapes == {"at the limits", "one byte each", "one very long line", "random"}

    sources = [source for source, _, _ in pairs]
    bundles = [bundle for _, bundle, _ in pairs]
    assert any(len(s.encode()) == BOUNDARY_SOURCE_BYTES for s in sources)
    assert any(len(b.encode()) == BOUNDARY_BUNDLE_BYTES for b in bundles)
    assert any(len(s.encode()) == 1 for s in sources)
    # Characters and bytes differ, so a count of characters would be wrong for these.
    assert sum(1 for s in sources if len(s) != len(s.encode())) >= 20
    joined = "".join(sources + bundles)
    assert "\r\n" in joined
    assert "\r" in joined.replace("\r\n", "")
    assert any(ord(char) > 0xFFFF for char in joined)
    assert any(0x800 <= ord(char) <= 0xFFFF for char in joined)
    assert any(0x80 <= ord(char) < 0x800 for char in joined)
    assert "\ufeff" in joined and "\x00" in joined
    # No pair repeats, and the sources are not all of one length.
    assert len({(s, b) for s, b, _ in pairs}) == SEEDS
    assert len({len(s) for s in sources}) >= 20


def test_the_fields_vary_across_seeds() -> None:
    fields = [fields_for(seed) for seed in range(SEEDS)]
    assert {f.attempts for f in fields} == {1, 2, 3, 4}
    assert any(f.meta.dump().get("pauseAtFrame") is not None for f in fields)
    assert any(f.meta.dump().get("pauseAtFrame") is None for f in fields)
    assert any(f.skipped_tokens for f in fields) and any(not f.skipped_tokens for f in fields)
    assert len({f.model for f in fields}) == 3
    assert len({f.request_hash for f in fields}) == SEEDS
