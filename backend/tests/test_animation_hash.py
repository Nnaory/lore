"""Tests for `canonical_json` and `canonical_hash`, the Request_Hash of an animation request.

Why: the hash is the idempotency key (`UNIQUE (owner_id, request_hash)`, Requirement 18), so two
requests that mean the same thing must hash alike and any real difference must change it. The
vectors in `tests/fixtures/ai/animation-request-hash.json` carry a hand-written canonical JSON and
the SHA-256 of it, so the implementation is checked against the spec text and not against itself.
The tests below also pin the properties the vectors cannot show on their own: no mutation of the
request, key order of the input, and the key set of the hashed body. No network, no database, no
`langgraph` or `boto3`.
"""

from __future__ import annotations

import copy
import hashlib
import json
import re
from pathlib import Path
from typing import Any

import pytest

from app.ai.animation.models import CreateAnimationRequest, canonical_hash, canonical_json

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "ai" / "animation-request-hash.json"
VECTORS: dict[str, Any] = json.loads(FIXTURE.read_text(encoding="utf-8"))
REQUEST_VECTORS: list[dict[str, Any]] = VECTORS["request_vectors"]
VALUE_VECTORS: list[dict[str, Any]] = VECTORS["value_vectors"]

HEX64 = re.compile(r"^[0-9a-f]{64}$")


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _request(vector: dict[str, Any]) -> CreateAnimationRequest:
    return CreateAnimationRequest.model_validate(vector["request"])


def _hash_of(vector: dict[str, Any]) -> str:
    return canonical_hash(_request(vector), vector["contract_version"])


def _by_name(vectors: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {vector["name"]: vector for vector in vectors}


def _reverse_keys(value: Any) -> Any:
    """The same JSON value with every object's keys in reverse insertion order."""
    if isinstance(value, dict):
        return {key: _reverse_keys(value[key]) for key in reversed(list(value))}
    if isinstance(value, list):
        return [_reverse_keys(item) for item in value]
    return value


# --- The fixture itself ----------------------------------------------------------------------


def test_fixture_has_at_least_six_request_vectors_with_the_required_cases() -> None:
    names = {vector["name"] for vector in REQUEST_VECTORS}
    assert len(REQUEST_VECTORS) >= 6
    assert {
        "omitted-optional-fields",  # concepts and forbidden_tokens not sent (== [])
        "puzzle-forbidden-unordered-duplicates",
        "integral-floats",  # 2.0 versus 2
        "negative-zero",
        "title-nfc",
        "title-nfd",  # e + U+0301 versus U+00E9
    } <= names
    value_names = {vector["name"] for vector in VALUE_VECTORS}
    assert {"boolean-true", "integer-one"} <= value_names  # true versus 1


@pytest.mark.parametrize("vector", REQUEST_VECTORS + VALUE_VECTORS, ids=lambda v: v["name"])
def test_fixture_sha256_is_the_digest_of_its_hand_written_canonical_json(
    vector: dict[str, Any],
) -> None:
    assert HEX64.fullmatch(vector["sha256"])
    assert _sha(vector["canonical"]) == vector["sha256"]


def test_fixture_hand_written_canonical_json_is_sorted_compact_utf8() -> None:
    for vector in REQUEST_VECTORS + VALUE_VECTORS:
        text = vector["canonical"]
        parsed = json.loads(text)
        redone = json.dumps(parsed, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        assert redone == text, vector["name"]


@pytest.mark.parametrize("group", [REQUEST_VECTORS, VALUE_VECTORS], ids=["request", "value"])
def test_fixture_same_and_differs_claims_match_the_digests(group: list[dict[str, Any]]) -> None:
    named = _by_name(group)
    claims = 0
    for vector in group:
        if "same_hash_as" in vector:
            claims += 1
            assert vector["sha256"] == named[vector["same_hash_as"]]["sha256"], vector["name"]
        for other in vector.get("differs_from", []):
            claims += 1
            assert vector["sha256"] != named[other]["sha256"], vector["name"]
    assert claims >= 2


# --- canonical_hash against the vectors -------------------------------------------------------


@pytest.mark.parametrize("vector", REQUEST_VECTORS, ids=lambda v: v["name"])
def test_canonical_hash_matches_the_fixture_digest(vector: dict[str, Any]) -> None:
    assert _hash_of(vector) == vector["sha256"]


@pytest.mark.parametrize("vector", REQUEST_VECTORS, ids=lambda v: v["name"])
def test_canonical_hash_is_lowercase_hex_sha256(vector: dict[str, Any]) -> None:
    assert HEX64.fullmatch(_hash_of(vector))


def test_missing_optional_fields_hash_like_empty_lists() -> None:
    named = _by_name(REQUEST_VECTORS)
    omitted, explicit = named["omitted-optional-fields"], named["explicit-empty-lists"]
    assert "concepts" not in omitted["request"]
    assert "forbidden_tokens" not in omitted["request"]
    assert explicit["request"]["concepts"] == []
    assert _hash_of(omitted) == _hash_of(explicit)


def test_forbidden_tokens_order_and_duplicates_do_not_change_the_hash() -> None:
    named = _by_name(REQUEST_VECTORS)
    shuffled = named["puzzle-forbidden-unordered-duplicates"]
    assert _request(shuffled).forbidden_tokens == ["zeta", "alpha", "zeta", "Beta"]
    assert _hash_of(shuffled) == _hash_of(named["puzzle-forbidden-sorted-unique"])


def test_forbidden_tokens_are_sorted_by_code_point_not_by_locale_or_case() -> None:
    base = copy.deepcopy(_by_name(REQUEST_VECTORS)["puzzle-forbidden-sorted-unique"])
    expected = base["sha256"]
    # By code point "Beta" comes before "alpha"; a case-insensitive or locale sort would not.
    assert expected == _sha(base["canonical"])
    assert '"forbidden_tokens":["Beta","alpha","zeta"]' in base["canonical"]
    base["request"]["forbidden_tokens"] = ["zeta", "Beta", "alpha"]
    assert _hash_of(base) == expected
    base["request"]["forbidden_tokens"] = ["alpha", "zeta", "Beta", "Beta", "alpha"]
    assert _hash_of(base) == expected


def test_changed_token_set_concept_order_or_contract_version_changes_the_hash() -> None:
    named = _by_name(REQUEST_VECTORS)
    base = _hash_of(named["puzzle-forbidden-unordered-duplicates"])
    assert _hash_of(named["puzzle-forbidden-set-changed"]) != base
    assert _hash_of(named["puzzle-concepts-reordered"]) != base
    lesson = named["omitted-optional-fields"]
    assert _hash_of(named["contract-version-2"]) != _hash_of(lesson)
    assert canonical_hash(_request(lesson), 1) != canonical_hash(_request(lesson), 2)


def test_whole_floats_and_negative_zero_hash_like_integers() -> None:
    named = _by_name(REQUEST_VECTORS)
    integers = _hash_of(named["omitted-optional-fields"])
    floats = _request(named["integral-floats"])
    assert isinstance(floats.visual.vectors[0].to[0], float)  # the model keeps floats
    assert _hash_of(named["integral-floats"]) == integers
    assert _hash_of(named["negative-zero"]) == integers


def test_a_fractional_coordinate_is_not_rounded() -> None:
    named = _by_name(REQUEST_VECTORS)
    assert _hash_of(named["fractional-coordinate-kept"]) != _hash_of(
        named["omitted-optional-fields"]
    )


def test_title_is_trimmed_but_text_is_not() -> None:
    named = _by_name(REQUEST_VECTORS)
    base = _hash_of(named["omitted-optional-fields"])
    assert _hash_of(named["title-js-whitespace-trimmed"]) == base
    assert _hash_of(named["text-is-not-trimmed"]) != base


def test_unicode_is_not_normalized_and_not_escaped() -> None:
    named = _by_name(REQUEST_VECTORS)
    nfc, nfd = named["title-nfc"], named["title-nfd"]
    assert _request(nfc).title != _request(nfd).title
    assert _hash_of(nfc) != _hash_of(nfd)
    # The digest is over UTF-8 text with the emoji itself, not over a `\ud83d\ude00` escape.
    emoji = named["emoji-not-escaped"]
    assert "\U0001f600" in emoji["canonical"]
    assert _hash_of(emoji) == emoji["sha256"]


def test_key_order_of_the_input_does_not_change_the_hash() -> None:
    for vector in REQUEST_VECTORS:
        reordered = {**vector, "request": _reverse_keys(vector["request"])}
        assert _hash_of(reordered) == vector["sha256"], vector["name"]


def test_hash_covers_exactly_the_eight_spec_keys_with_trimmed_title() -> None:
    vector = _by_name(REQUEST_VECTORS)["puzzle-forbidden-unordered-duplicates"]
    req = _request(vector)
    body = {
        "contract_version": 7,
        "kind": req.kind,
        "title": req.title,
        "text": req.text,
        "concepts": list(req.concepts),
        "visual": req.visual.dump(),
        "language": req.language,
        "forbidden_tokens": sorted(set(req.forbidden_tokens)),
    }
    assert canonical_hash(req, 7) == _sha(canonical_json(body))
    assert set(json.loads(canonical_json(body))) == {
        "contract_version",
        "kind",
        "title",
        "text",
        "concepts",
        "visual",
        "language",
        "forbidden_tokens",
    }


def test_every_field_of_the_request_changes_the_hash() -> None:
    base_vector = copy.deepcopy(_by_name(REQUEST_VECTORS)["puzzle-forbidden-sorted-unique"])
    base = _hash_of(base_vector)
    edits: list[tuple[str, Any]] = [
        ("kind", "lesson"),  # a lesson without forbidden_tokens, see below
        ("title", "Another title"),
        ("text", "Another text"),
        ("concepts", ["sum"]),
        ("language", "id"),
        ("forbidden_tokens", []),
        ("visual", {"kind": "vectors", "vectors": [{"from": [0, 0], "to": [1, 1]}]}),
    ]
    seen = {base}
    for field, value in edits:
        changed = copy.deepcopy(base_vector)
        changed["request"][field] = value
        if field == "kind":
            changed["request"]["forbidden_tokens"] = []
        digest = _hash_of(changed)
        assert digest not in seen, field
        seen.add(digest)


def test_canonical_hash_does_not_mutate_the_request() -> None:
    req = _request(_by_name(REQUEST_VECTORS)["puzzle-forbidden-unordered-duplicates"])
    before = req.model_dump(mode="python")
    tokens_before = list(req.forbidden_tokens)
    canonical_hash(req, 1)
    assert req.model_dump(mode="python") == before
    assert req.forbidden_tokens == tokens_before == ["zeta", "alpha", "zeta", "Beta"]


# --- canonical_json against the vectors -------------------------------------------------------


@pytest.mark.parametrize("vector", VALUE_VECTORS, ids=lambda v: v["name"])
def test_canonical_json_matches_the_fixture(vector: dict[str, Any]) -> None:
    assert canonical_json(vector["value"]) == vector["canonical"]
    assert _sha(canonical_json(vector["value"])) == vector["sha256"]


def test_boolean_true_and_integer_one_are_different() -> None:
    assert canonical_json({"flag": True}) == '{"flag":true}'
    assert canonical_json({"flag": 1}) == '{"flag":1}'
    assert canonical_json({"flag": False}) == '{"flag":false}'
    assert canonical_json({"flag": 0}) == '{"flag":0}'
    assert canonical_json([True, 1, 1.0]) == "[true,1,1]"


def test_canonical_json_whole_floats_become_integers() -> None:
    assert canonical_json({"n": 2.0}) == canonical_json({"n": 2}) == '{"n":2}'
    assert canonical_json({"n": -0.0}) == '{"n":0}'
    assert canonical_json({"n": [1.0, {"m": -3.0}]}) == '{"n":[1,{"m":-3}]}'
    assert canonical_json({"n": 2.5}) == '{"n":2.5}'
    assert canonical_json({"n": -2.5}) == '{"n":-2.5}'


def test_canonical_json_sorts_keys_at_every_depth_without_spaces() -> None:
    value = {"b": {"y": 1, "x": [{"d": None, "c": "é"}]}, "a": True}
    assert canonical_json(value) == '{"a":true,"b":{"x":[{"c":"é","d":null}],"y":1}}'


def test_canonical_json_keeps_list_order_and_does_not_mutate_its_input() -> None:
    value = {"items": [3, 1.0, 2], "nested": {"z": -0.0}}
    before = copy.deepcopy(value)
    assert canonical_json(value) == '{"items":[3,1,2],"nested":{"z":0}}'
    assert value == before
    assert isinstance(value["items"][1], float)  # the caller's float was not replaced


def test_canonical_json_does_not_normalize_or_escape_unicode() -> None:
    assert canonical_json({"s": "\u00e9"}) != canonical_json({"s": "e\u0301"})
    assert canonical_json({"s": "\U0001f600"}) == '{"s":"\U0001f600"}'
    assert canonical_json({"s": "a\u2028b"}) == '{"s":"a\u2028b"}'
