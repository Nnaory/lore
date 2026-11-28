"""Tests for the animation models and the fixtures shared with the frontend.

Why: the request, the Animation_Reference, the verifier result, the manifest and the stream events
cross the browser, the Lambda and S3, so the Python models and the Zod schemas must decide alike.
The fixtures in `tests/fixtures/animation/` are plain JSON read by this file and by Vitest
(`reference-*`, `request-*`, `verifier-result-*`, `manifest-valid`, `reader-response`). A file named
`<kind>-valid-*` must be accepted and `<kind>-invalid-*` rejected; the tables below also say which
field each invalid file breaks, so a fixture cannot pass for the wrong reason. No network, no
database, no `langgraph` or `boto3`.
"""

from __future__ import annotations

import copy
import dataclasses
import json
import re
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

import pytest
from pydantic import BaseModel, ValidationError

from app.ai.animation import models as models_module
from app.ai.animation.contract import (
    AnimationContract,
    Canvas,
    ContractInvalid,
    ContractOk,
    Duration,
    load_contract,
)
from app.ai.animation.models import (
    ATTEMPTS_MAX,
    ATTEMPTS_MIN,
    CONCEPT_MAX_UNITS,
    CONCEPTS_MAX,
    DIAGNOSTICS_EVENT_ITEMS_MAX,
    ERROR_CODES,
    FORBIDDEN_TOKEN_MAX_UNITS,
    FORBIDDEN_TOKENS_MAX,
    TEXT_MAX_UNITS,
    TITLE_MAX_UNITS,
    AnimationManifest,
    AnimationReference,
    AnimationRow,
    CreateAnimationRequest,
    Diagnostic,
    DiagnosticsEvent,
    DoneEvent,
    ErrorEvent,
    MainMeta,
    RuntimeVersion,
    StageEvent,
    StartedEvent,
    VerifierResult,
    contains_lone_surrogate,
    js_trim,
)
from app.ai.contracts.requests import utf16_length
from app.ai.zod_compat import zod_flatten

BACKEND_DIR = Path(__file__).resolve().parent.parent
FIXTURES = BACKEND_DIR / "tests" / "fixtures" / "animation"

EMOJI = "\U0001f600"  # two UTF-16 units, one code point

# Fixture families this file owns, so another task's files in the folder cannot break these tests.
FAMILIES = ("reference", "request", "verifier-result")
OWNED_FILES = ("manifest-valid", "reader-response")

# Which field the first error of each invalid fixture points at. "" is a whole-model rule.
REFERENCE_INVALID_FIELD = {
    "reference-invalid-id-uppercase": "animation_id",
    "reference-invalid-id-braces": "animation_id",
    "reference-invalid-id-urn-prefix": "animation_id",
    "reference-invalid-id-no-hyphens": "animation_id",
    "reference-invalid-source-sha-63": "source_sha256",
    "reference-invalid-source-sha-65": "source_sha256",
    "reference-invalid-source-sha-uppercase": "source_sha256",
    "reference-invalid-bundle-sha-63": "bundle_sha256",
    "reference-invalid-bundle-sha-65": "bundle_sha256",
    "reference-invalid-bundle-sha-uppercase": "bundle_sha256",
    "reference-invalid-duration-29": "duration_in_frames",
    "reference-invalid-duration-901": "duration_in_frames",
    "reference-invalid-duration-fractional": "duration_in_frames",
    "reference-invalid-duration-string": "duration_in_frames",
    "reference-invalid-duration-boolean": "duration_in_frames",
    "reference-invalid-pause-0": "pause_at_frame",
    "reference-invalid-pause-equals-duration": "",
    "reference-invalid-pause-exceeds-duration": "",
    "reference-invalid-pause-null": "",
    "reference-invalid-width-1279": "width",
    "reference-invalid-height-721": "height",
    "reference-invalid-fps-24": "fps",
    "reference-invalid-contract-version-0": "contract_version",
    "reference-invalid-contract-version-string": "contract_version",
    "reference-invalid-missing-bundle-sha": "bundle_sha256",
    "reference-invalid-camelcase-keys": "animation_id",
}
REQUEST_INVALID_FIELD = {
    "request-invalid-title-emoji-over-200-units": "title",
    "request-invalid-concept-emoji-over-80-units": "concepts",
    "request-invalid-forbidden-emoji-over-80-units": "forbidden_tokens",
    "request-invalid-lone-surrogate-in-title": "",
    "request-invalid-lone-surrogate-in-key": "",
    "request-invalid-lone-surrogate-in-visual": "",
    "request-invalid-lesson-with-forbidden-tokens": "",
    "request-invalid-title-nbsp-only": "title",
    "request-invalid-text-empty": "text",
    "request-invalid-concept-empty": "concepts",
    "request-invalid-concepts-six": "concepts",
    "request-invalid-forbidden-tokens-nine": "forbidden_tokens",
    "request-invalid-language": "language",
    "request-invalid-kind": "kind",
    "request-invalid-visual-unknown-kind": "visual",
    "request-invalid-missing-visual": "visual",
    "request-invalid-title-not-string": "title",
}
VERIFIER_RESULT_INVALID_FIELD = {
    "verifier-result-invalid-ok-without-bundle": "",
    "verifier-result-invalid-ok-without-meta": "",
    "verifier-result-invalid-failed-with-bundle": "",
    "verifier-result-invalid-failed-with-meta": "",
    "verifier-result-invalid-unknown-code-prefix": "diagnostics",
    "verifier-result-invalid-severity": "diagnostics",
    "verifier-result-invalid-line-zero": "diagnostics",
}


def _contract() -> AnimationContract:
    loaded = load_contract()
    assert isinstance(loaded, ContractOk)
    return loaded.contract


def _load(name: str) -> Any:
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def _stems(pattern: str) -> list[str]:
    return sorted(path.stem for path in FIXTURES.glob(f"{pattern}.json"))


def _rejected(model: type[BaseModel], raw: object) -> ValidationError:
    with pytest.raises(ValidationError) as caught:
        model.model_validate(raw)
    return caught.value


def _first_field(error: ValidationError) -> str:
    """Top-level field of the first error, or "" for a rule on the whole model."""
    loc = error.errors(include_url=False)[0]["loc"]
    return str(loc[0]) if loc else ""


def _request(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "kind": "lesson",
        "title": "T",
        "text": "t",
        "language": "en",
        "visual": {"kind": "vectors", "vectors": [{"from": [0, 0], "to": [4, 2]}]},
    }
    body.update(overrides)
    return body


def _diagnostic(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "tool": "policy",
        "code": "POLICY_JSX_SYNTAX",
        "severity": "error",
        "message": "m",
    }
    body.update(overrides)
    return body


def _mutated(raw: dict[str, Any], path: tuple[str, ...], value: object) -> dict[str, Any]:
    copied = copy.deepcopy(raw)
    target = copied
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value
    return copied


# --- the fixture folder ---------------------------------------------------------------------


def test_every_fixture_family_has_files() -> None:
    for family in FAMILIES:
        assert _stems(f"{family}-valid-*"), family
        assert _stems(f"{family}-invalid-*"), family
    for name in OWNED_FILES:
        assert (FIXTURES / f"{name}.json").is_file(), name


def test_fixture_names_say_valid_or_invalid() -> None:
    for family in FAMILIES:
        for stem in _stems(f"{family}-*"):
            assert re.match(rf"{family}-(valid|invalid)-[a-z0-9-]+$", stem), stem


@pytest.mark.parametrize(
    "path",
    [
        path
        for pattern in (*(f"{family}-*" for family in FAMILIES), *OWNED_FILES)
        for path in sorted(FIXTURES.glob(f"{pattern}.json"))
    ],
    ids=lambda path: path.stem,
)
def test_fixtures_are_plain_json(path: Path) -> None:
    """Vitest reads these files with `JSON.parse`: no BOM, no NaN or Infinity, no comments."""

    def reject(name: str) -> object:
        raise ValueError(f"{name} is not valid JSON")

    raw = path.read_bytes()
    assert not raw.startswith(b"\xef\xbb\xbf")
    json.loads(raw.decode("utf-8"), parse_constant=reject)


def test_boundary_fixtures_follow_the_contract() -> None:
    """The files hold literals; this fails if the contract moves and they do not."""
    contract = _contract()
    canvas, duration, limits = contract.canvas, contract.duration, contract.limits
    lesson = _load("reference-valid-lesson")
    assert (lesson["width"], lesson["height"], lesson["fps"]) == (
        canvas.width,
        canvas.height,
        canvas.fps,
    )
    assert _load("reference-valid-duration-min")["duration_in_frames"] == duration.min
    assert _load("reference-valid-duration-max")["duration_in_frames"] == duration.max
    assert _load("reference-invalid-duration-29")["duration_in_frames"] == duration.min - 1
    assert _load("reference-invalid-duration-901")["duration_in_frames"] == duration.max + 1
    assert _load("reference-invalid-width-1279")["width"] == canvas.width - 1
    assert _load("reference-invalid-height-721")["height"] == canvas.height + 1
    assert _load("reference-invalid-fps-24")["fps"] != canvas.fps
    manifest = _load("manifest-valid")
    assert 1 <= manifest["source_bytes"] <= limits.source_max_bytes
    assert 1 <= manifest["bundle_bytes"] <= limits.bundle_max_bytes
    assert len(_load("verifier-result-valid-ok")["diagnostics"]) <= limits.diagnostics_max


# --- AnimationReference -----------------------------------------------------------------------


@pytest.mark.parametrize("name", _stems("reference-valid-*"))
def test_valid_reference_fixtures_are_accepted_and_dump_without_none(name: str) -> None:
    raw = _load(name)
    reference = AnimationReference.model_validate(raw)
    known = set(AnimationReference.model_fields)
    # Whole-number floats become ints and unknown keys are dropped; nothing else changes.
    expected = {
        key: int(value) if isinstance(value, float) else value
        for key, value in raw.items()
        if key in known
    }
    assert reference.dump() == expected
    assert all(not isinstance(value, float) for value in reference.dump().values())


def test_reference_without_a_pause_frame_dumps_without_the_key() -> None:
    lesson = AnimationReference.model_validate(_load("reference-valid-lesson")).dump()
    puzzle = AnimationReference.model_validate(_load("reference-valid-puzzle")).dump()
    assert "pause_at_frame" not in lesson
    assert puzzle["pause_at_frame"] == 180


def test_reference_drops_unknown_keys() -> None:
    reference = AnimationReference.model_validate(_load("reference-valid-unknown-key-dropped"))
    assert "future_field" not in reference.dump()


@pytest.mark.parametrize("name", sorted(REFERENCE_INVALID_FIELD))
def test_invalid_reference_fixtures_fail_on_the_intended_field(name: str) -> None:
    assert _first_field(_rejected(AnimationReference, _load(name))) == REFERENCE_INVALID_FIELD[name]


def test_every_invalid_reference_fixture_has_an_expected_field() -> None:
    assert sorted(REFERENCE_INVALID_FIELD) == _stems("reference-invalid-*")


def test_a_whole_number_float_is_accepted_and_a_fraction_is_not() -> None:
    base = _load("reference-valid-lesson")
    accepted = AnimationReference.model_validate({**base, "duration_in_frames": 30.0})
    assert accepted.duration_in_frames == 30
    assert isinstance(accepted.duration_in_frames, int)
    assert _first_field(_rejected(AnimationReference, {**base, "duration_in_frames": 30.5})) == (
        "duration_in_frames"
    )


def test_a_boolean_is_not_a_whole_number() -> None:
    base = _load("reference-valid-lesson")
    assert _first_field(_rejected(AnimationReference, {**base, "contract_version": True})) == (
        "contract_version"
    )


def test_an_animation_id_with_a_trailing_newline_is_rejected() -> None:
    base = _load("reference-valid-lesson")
    raw = {**base, "animation_id": base["animation_id"] + "\n"}
    assert _first_field(_rejected(AnimationReference, raw)) == "animation_id"


def test_reference_reads_canvas_and_duration_from_the_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    changed = _contract().model_copy(
        update={
            "canvas": Canvas(width=640, height=360, fps=24),
            "duration": Duration(min=10, max=20),
        }
    )
    monkeypatch.setattr(models_module, "load_contract", lambda: ContractOk(changed))
    base = _load("reference-valid-lesson")
    moved = {**base, "width": 640, "height": 360, "fps": 24, "duration_in_frames": 15}
    assert AnimationReference.model_validate(moved).width == 640
    assert _first_field(_rejected(AnimationReference, base)) == "width"
    assert _first_field(_rejected(AnimationReference, {**moved, "duration_in_frames": 21})) == (
        "duration_in_frames"
    )


def test_a_missing_contract_fails_validation_with_a_validation_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(models_module, "load_contract", lambda: ContractInvalid("broken"))
    error = _rejected(AnimationReference, _load("reference-valid-lesson"))
    assert "contract is not available" in str(error)


# --- CreateAnimationRequest -------------------------------------------------------------------


@pytest.mark.parametrize("name", _stems("request-valid-*"))
def test_valid_request_fixtures_are_accepted(name: str) -> None:
    request = CreateAnimationRequest.model_validate(_load(name))
    dumped = request.dump()
    assert "future_field" not in dumped
    assert isinstance(dumped["concepts"], list)
    assert isinstance(dumped["forbidden_tokens"], list)


@pytest.mark.parametrize("name", sorted(REQUEST_INVALID_FIELD))
def test_invalid_request_fixtures_fail_on_the_intended_field(name: str) -> None:
    error = _rejected(CreateAnimationRequest, _load(name))
    assert _first_field(error) == REQUEST_INVALID_FIELD[name]


def test_every_invalid_request_fixture_has_an_expected_field() -> None:
    assert sorted(REQUEST_INVALID_FIELD) == _stems("request-invalid-*")


def test_request_limits_match_requirement_15() -> None:
    assert (TITLE_MAX_UNITS, TEXT_MAX_UNITS) == (200, 2000)
    assert (CONCEPTS_MAX, CONCEPT_MAX_UNITS) == (5, 80)
    assert (FORBIDDEN_TOKENS_MAX, FORBIDDEN_TOKEN_MAX_UNITS) == (8, 80)


def test_emoji_at_the_limit_count_in_utf16_units_not_code_points() -> None:
    title = CreateAnimationRequest.model_validate(_load("request-valid-title-emoji-200-units"))
    assert (len(title.title), utf16_length(title.title)) == (100, 200)
    concept = _load("request-valid-concept-emoji-80-units")["concepts"][1]
    assert (len(concept), utf16_length(concept)) == (40, 80)
    token = _load("request-valid-forbidden-emoji-80-units")["forbidden_tokens"][1]
    assert (len(token), utf16_length(token)) == (40, 80)
    # One more emoji is still far below the limit in code points, but over it in UTF-16 units.
    over_title = _load("request-invalid-title-emoji-over-200-units")["title"]
    assert (len(over_title), utf16_length(over_title)) == (101, 202)
    over_concept = _load("request-invalid-concept-emoji-over-80-units")["concepts"][1]
    assert (len(over_concept), utf16_length(over_concept)) == (41, 82)
    over_token = _load("request-invalid-forbidden-emoji-over-80-units")["forbidden_tokens"][1]
    assert (len(over_token), utf16_length(over_token)) == (41, 82)


@pytest.mark.parametrize(
    ("field", "maximum"),
    [("title", TITLE_MAX_UNITS), ("text", TEXT_MAX_UNITS)],
)
def test_title_and_text_accept_exactly_the_limit(field: str, maximum: int) -> None:
    assert CreateAnimationRequest.model_validate(_request(**{field: "a" * maximum}))
    error = _rejected(CreateAnimationRequest, _request(**{field: "a" * (maximum + 1)}))
    assert _first_field(error) == field


def test_concepts_and_forbidden_tokens_accept_exactly_the_limits() -> None:
    at_limit = _request(
        kind="puzzle",
        concepts=["c" * CONCEPT_MAX_UNITS] * CONCEPTS_MAX,
        forbidden_tokens=["f" * FORBIDDEN_TOKEN_MAX_UNITS] * FORBIDDEN_TOKENS_MAX,
    )
    assert CreateAnimationRequest.model_validate(at_limit)
    long_concept = _request(concepts=["c" * (CONCEPT_MAX_UNITS + 1)])
    assert _first_field(_rejected(CreateAnimationRequest, long_concept)) == "concepts"
    long_token = _request(kind="puzzle", forbidden_tokens=["f" * (FORBIDDEN_TOKEN_MAX_UNITS + 1)])
    assert _first_field(_rejected(CreateAnimationRequest, long_token)) == "forbidden_tokens"


@pytest.mark.parametrize(
    ("title", "trimmed"),
    [
        ("  x  ", "x"),
        ("\ufeffx\u3000", "x"),  # BOM and ideographic space are JavaScript whitespace
        ("\x1cx\x1c", "\x1cx\x1c"),  # Python's strip() would remove these, JavaScript's does not
        ("a b", "a b"),
    ],
)
def test_title_is_trimmed_like_javascript(title: str, trimmed: str) -> None:
    assert js_trim(title) == trimmed
    assert CreateAnimationRequest.model_validate(_request(title=title)).title == trimmed


@pytest.mark.parametrize("title", ["\u00a0", "\ufeff", " \t\n ", ""])
def test_a_title_that_is_only_whitespace_is_rejected(title: str) -> None:
    assert _first_field(_rejected(CreateAnimationRequest, _request(title=title))) == "title"


def test_text_concepts_and_tokens_are_not_trimmed() -> None:
    request = CreateAnimationRequest.model_validate(
        _load("request-valid-untrimmed-text-and-tokens")
    )
    assert request.text == "  keep the spaces around this text  "
    assert request.concepts == ["  "]
    assert request.forbidden_tokens == ["  ", "Ya", "ya"]
    assert CreateAnimationRequest.model_validate(_request(text="   ")).text == "   "


def test_a_missing_token_list_is_the_same_as_an_empty_one() -> None:
    bare = CreateAnimationRequest.model_validate(_request(kind="puzzle"))
    explicit = CreateAnimationRequest.model_validate(
        _request(kind="puzzle", concepts=[], forbidden_tokens=[])
    )
    assert bare.dump() == explicit.dump()
    assert bare.concepts == [] and bare.forbidden_tokens == []


def test_only_a_puzzle_may_send_forbidden_tokens() -> None:
    error = _rejected(CreateAnimationRequest, _load("request-invalid-lesson-with-forbidden-tokens"))
    assert "puzzle" in str(error)
    assert CreateAnimationRequest.model_validate(_request(kind="puzzle", forbidden_tokens=["x"]))
    assert CreateAnimationRequest.model_validate(_request(kind="lesson", forbidden_tokens=[]))


def test_null_is_not_accepted_for_an_optional_list() -> None:
    assert _first_field(_rejected(CreateAnimationRequest, _request(concepts=None))) == ""


def test_the_visual_is_validated_and_dumped_with_its_wire_names() -> None:
    raw = _load("request-valid-lesson-minimal")
    dumped = CreateAnimationRequest.model_validate(raw).dump()
    assert dumped["visual"] == raw["visual"]  # `from` stays `from`, unset optionals stay absent


@pytest.mark.parametrize(
    "name",
    [
        "request-invalid-lone-surrogate-in-title",
        "request-invalid-lone-surrogate-in-key",
        "request-invalid-lone-surrogate-in-visual",
    ],
)
def test_a_lone_surrogate_in_a_key_value_or_nested_value_is_rejected(name: str) -> None:
    assert "lone surrogate" in str(_rejected(CreateAnimationRequest, _load(name)))


def test_a_joined_surrogate_pair_is_an_ordinary_character() -> None:
    pair = json.loads('"\\ud83d\\ude00"')
    assert pair == EMOJI
    request = CreateAnimationRequest.model_validate(_request(title=pair))
    assert request.title == EMOJI


def test_lone_surrogate_search_covers_keys_nesting_and_depth() -> None:
    assert contains_lone_surrogate("a\ud800b")
    assert contains_lone_surrogate("\udfff")
    assert contains_lone_surrogate({"\ud800": 1})
    assert contains_lone_surrogate({"a": [1, ("x", {"b": "\udc00"})]})
    assert not contains_lone_surrogate({"a": [1, ("x", {"b": EMOJI})], "n": None, "f": 1.5})
    nested: list[Any] = []
    for _ in range(20_000):  # deeper than the recursion limit
        nested = [nested]
    assert not contains_lone_surrogate(nested)


def test_request_errors_flatten_like_zod() -> None:
    error = _rejected(CreateAnimationRequest, _request(title="\u00a0", language="fr"))
    flat = zod_flatten(error)
    assert set(flat["fieldErrors"]) == {"title", "language"}
    assert flat["formErrors"] == []


# --- Diagnostic, MainMeta, VerifierResult -----------------------------------------------------


def test_every_contract_prefix_is_an_allowed_code_prefix() -> None:
    for prefix in _contract().diagnostic_code_prefixes:
        tool = "agent" if prefix == "AGENT" else "verifier"
        diagnostic = Diagnostic.model_validate(_diagnostic(tool=tool, code=f"{prefix}_SOME_CODE_2"))
        assert diagnostic.code == f"{prefix}_SOME_CODE_2"


@pytest.mark.parametrize(
    "code",
    ["FOO_BAR", "policy_x", "POLICY_", "POLICY", "POLICY_x", "POLICY_X\n", "XPOLICY_X", ""],
)
def test_a_code_without_a_contract_prefix_is_rejected(code: str) -> None:
    assert _first_field(_rejected(Diagnostic, _diagnostic(code=code))) == "code"


def test_message_length_is_the_contract_limit_in_utf16_units() -> None:
    limit = _contract().limits.diagnostic_message_max_chars
    assert Diagnostic.model_validate(_diagnostic(message="a" * limit))
    assert _first_field(_rejected(Diagnostic, _diagnostic(message="a" * (limit + 1)))) == "message"
    # `limit // 2` emoji is exactly `limit` units; one more is over although it is < limit points.
    assert Diagnostic.model_validate(_diagnostic(message=EMOJI * (limit // 2)))
    over = _diagnostic(message=EMOJI * (limit // 2 + 1))
    assert _first_field(_rejected(Diagnostic, over)) == "message"


@pytest.mark.parametrize("field", ["line", "column"])
def test_line_and_column_start_at_one(field: str) -> None:
    assert Diagnostic.model_validate(_diagnostic(**{field: 1}))
    assert _first_field(_rejected(Diagnostic, _diagnostic(**{field: 0}))) == field
    assert _first_field(_rejected(Diagnostic, _diagnostic(**{field: 1.5}))) == field


def test_tool_and_severity_are_closed_sets() -> None:
    assert Diagnostic.model_validate(_diagnostic(tool="agent", code="AGENT_EXTRACT_NO_CODE"))
    assert _first_field(_rejected(Diagnostic, _diagnostic(tool="npm"))) == "tool"
    assert _first_field(_rejected(Diagnostic, _diagnostic(severity="info"))) == "severity"


def test_main_meta_uses_camel_case_and_the_contract_range() -> None:
    contract = _contract()
    canvas, duration = contract.canvas, contract.duration
    base = {
        "width": canvas.width,
        "height": canvas.height,
        "fps": canvas.fps,
        "durationInFrames": duration.min,
    }
    meta = MainMeta.model_validate(base)
    assert meta.dump() == base  # no pauseAtFrame key, no null
    assert MainMeta.model_validate({**base, "durationInFrames": duration.max})
    for bad in (duration.min - 1, duration.max + 1):
        # The error location uses the wire name, so a client sees the key it sent.
        assert _first_field(_rejected(MainMeta, {**base, "durationInFrames": bad})) == (
            "durationInFrames"
        )
    snake = {**base, "duration_in_frames": base["durationInFrames"]}
    del snake["durationInFrames"]
    assert _rejected(MainMeta, snake)


def test_main_meta_pause_frame_is_inside_the_animation() -> None:
    base = {"width": 1280, "height": 720, "fps": 30, "durationInFrames": 210}
    assert MainMeta.model_validate({**base, "pauseAtFrame": 1})
    assert MainMeta.model_validate({**base, "pauseAtFrame": 209})
    for bad in (0, 210):
        assert _rejected(MainMeta, {**base, "pauseAtFrame": bad})


@pytest.mark.parametrize("name", _stems("verifier-result-valid-*"))
def test_valid_verifier_results_are_accepted_and_round_trip(name: str) -> None:
    raw = _load(name)
    result = VerifierResult.model_validate(raw)
    assert result.dump() == raw
    assert (result.bundle is not None) == raw["ok"]
    assert (result.meta is not None) == raw["ok"]


@pytest.mark.parametrize("name", sorted(VERIFIER_RESULT_INVALID_FIELD))
def test_invalid_verifier_results_fail_on_the_intended_field(name: str) -> None:
    error = _rejected(VerifierResult, _load(name))
    assert _first_field(error) == VERIFIER_RESULT_INVALID_FIELD[name]


def test_every_invalid_verifier_result_fixture_has_an_expected_field() -> None:
    assert sorted(VERIFIER_RESULT_INVALID_FIELD) == _stems("verifier-result-invalid-*")


def test_a_verifier_result_holds_at_most_the_contract_number_of_diagnostics() -> None:
    limit = _contract().limits.diagnostics_max
    raw = _load("verifier-result-valid-failed")
    one = raw["diagnostics"][0]
    assert VerifierResult.model_validate({**raw, "diagnostics": [one] * limit})
    error = _rejected(VerifierResult, {**raw, "diagnostics": [one] * (limit + 1)})
    assert _first_field(error) == "diagnostics"


def test_ok_must_be_a_real_boolean() -> None:
    raw = _load("verifier-result-valid-failed")
    assert _first_field(_rejected(VerifierResult, {**raw, "ok": "false"})) == "ok"
    assert _first_field(_rejected(VerifierResult, {**raw, "ok": 0})) == "ok"


def test_a_check_time_must_be_a_whole_non_negative_number() -> None:
    raw = _load("verifier-result-valid-ok")
    for bad in (-1, 1.5, "3"):
        mutated = _mutated(raw, ("summary", "checks"), [{"name": "size", "ok": True, "ms": bad}])
        assert _first_field(_rejected(VerifierResult, mutated)) == "summary"
    zero = _mutated(raw, ("summary", "checks"), [{"name": "size", "ok": True, "ms": 0.0}])
    assert VerifierResult.model_validate(zero).summary.checks[0].ms == 0


# --- AnimationManifest ------------------------------------------------------------------------


def test_valid_manifest_is_accepted_and_round_trips() -> None:
    raw = _load("manifest-valid")
    assert AnimationManifest.model_validate(raw).dump() == raw


@pytest.mark.parametrize(
    ("path", "value", "field"),
    [
        (("schema_version",), 2, "schema_version"),
        (("contract_version",), 0, "contract_version"),
        (("source_sha256",), "A" * 64, "source_sha256"),
        (("bundle_sha256",), "a" * 63, "bundle_sha256"),
        (("request_hash",), "a" * 65, "request_hash"),
        (("source_bytes",), 0, "source_bytes"),
        (("bundle_bytes",), 0, "bundle_bytes"),
        (("attempts",), ATTEMPTS_MIN - 1, "attempts"),
        (("attempts",), ATTEMPTS_MAX + 1, "attempts"),
        (("model",), "", "model"),
        (("created_at",), "2026-11-27 09:41:03", "created_at"),
        (("created_at",), "2026-11-27T09:41:03+00:00", "created_at"),
        (("created_at",), "2026-13-40T25:61:61Z", "created_at"),
        (("meta", "durationInFrames"), 29, "meta"),
        (("verification", "warnings"), [_diagnostic()], "verification"),
        (("skipped_tokens",), "#ff8800", "skipped_tokens"),
    ],
)
def test_manifest_rejects_a_value_that_breaks_the_rules(
    path: tuple[str, ...], value: object, field: str
) -> None:
    error = _rejected(AnimationManifest, _mutated(_load("manifest-valid"), path, value))
    assert _first_field(error) == field


def test_manifest_byte_counts_follow_the_contract_limits() -> None:
    limits = _contract().limits
    raw = _load("manifest-valid")
    at_limit = _mutated(raw, ("source_bytes",), limits.source_max_bytes)
    at_limit = _mutated(at_limit, ("bundle_bytes",), limits.bundle_max_bytes)
    assert AnimationManifest.model_validate(at_limit)
    over_source = _mutated(raw, ("source_bytes",), limits.source_max_bytes + 1)
    assert _first_field(_rejected(AnimationManifest, over_source)) == "source_bytes"
    over_bundle = _mutated(raw, ("bundle_bytes",), limits.bundle_max_bytes + 1)
    assert _first_field(_rejected(AnimationManifest, over_bundle)) == "bundle_bytes"


def test_manifest_accepts_the_attempt_range_and_a_fractional_second() -> None:
    raw = _load("manifest-valid")
    for attempts in range(ATTEMPTS_MIN, ATTEMPTS_MAX + 1):
        assert AnimationManifest.model_validate(_mutated(raw, ("attempts",), attempts))
    stamped = _mutated(raw, ("created_at",), "2026-11-27T09:41:03.250Z")
    assert AnimationManifest.model_validate(stamped).created_at == "2026-11-27T09:41:03.250Z"


def test_manifest_meta_without_a_pause_frame_dumps_without_the_key() -> None:
    meta = {"width": 1280, "height": 720, "fps": 30, "durationInFrames": 90}
    raw = _mutated(_load("manifest-valid"), ("meta",), meta)
    assert AnimationManifest.model_validate(raw).dump()["meta"] == meta


# --- Reader response --------------------------------------------------------------------------


def test_reader_response_fixture_matches_the_documented_shape() -> None:
    raw = _load("reader-response")
    assert raw["ok"] is True
    data = raw["data"]
    assert set(data) == {"animation", "manifest", "urls", "expires_in"}
    assert data["expires_in"] == 300

    reference = AnimationReference.model_validate(data["animation"])
    assert reference.dump() == data["animation"]

    summary = data["manifest"]
    assert set(summary) == {
        "contract_version",
        "runtime_version",
        "source_bytes",
        "bundle_bytes",
        "meta",
        "verifier_version",
        "model",
        "attempts",
    }
    assert (
        RuntimeVersion.model_validate(summary["runtime_version"]).dump()
        == (summary["runtime_version"])
    )
    meta = MainMeta.model_validate(summary["meta"])
    assert meta.dump() == summary["meta"]
    assert meta.duration_in_frames == reference.duration_in_frames
    assert meta.pause_at_frame == reference.pause_at_frame
    assert summary["contract_version"] == reference.contract_version
    assert ATTEMPTS_MIN <= summary["attempts"] <= ATTEMPTS_MAX

    sha = reference.source_sha256
    folder = f"animations/v1/{sha[:2]}/{sha}"
    for key, file_name in (("bundle", "main.js"), ("manifest", "manifest.json")):
        url = data["urls"][key]
        assert re.match(r"https://[a-z0-9-]+\.s3\.ap-southeast-3\.amazonaws\.com/", url), key
        assert f"/{folder}/{file_name}?" in url, key
        assert "X-Amz-Algorithm=AWS4-HMAC-SHA256" in url
        assert "X-Amz-Expires=300" in url
    assert set(data["urls"]) == {"bundle", "manifest"}


# --- Stream events ----------------------------------------------------------------------------


def _done_payload() -> dict[str, Any]:
    return {
        "animation": _load("reference-valid-lesson"),
        "cached": False,
        "attempts": 2,
    }


SSE_EXAMPLES: list[tuple[Any, str, dict[str, Any]]] = [
    (StartedEvent, "started", {"max_attempts": 4, "deadline_ms": 240000, "cached": False}),
    (StageEvent, "stage", {"stage": "generating", "attempt": 1}),
    (StageEvent, "stage", {"stage": "verifying", "attempt": 1}),
    (StageEvent, "stage", {"stage": "repairing", "attempt": 2}),
    (StageEvent, "stage", {"stage": "publishing", "attempt": 2}),
    (
        DiagnosticsEvent,
        "diagnostics",
        {
            "attempt": 1,
            "ok": False,
            "error_count": 3,
            "warning_count": 1,
            "items": [
                {"tool": "policy", "code": "POLICY_COLOR_LITERAL", "line": 41},
                {"tool": "tsc", "code": "TSC_2322", "line": 57},
                {"tool": "agent", "code": "AGENT_REPAIR_UNCHANGED"},
            ],
        },
    ),
    (DoneEvent, "done", _done_payload()),
    (
        ErrorEvent,
        "error",
        {
            "code": "ANIMATION_VERIFICATION_FAILED",
            "message": (
                "The animation could not be verified. The lesson will use the standard drawing."
            ),
            "attempts": 4,
        },
    ),
]


@pytest.mark.parametrize(("model", "name", "payload"), SSE_EXAMPLES)
def test_stream_events_round_trip_the_design_examples(
    model: Any, name: str, payload: dict[str, Any]
) -> None:
    event = model.model_validate(payload)
    assert model.event_name == name
    assert event.dump() == payload
    line = json.dumps(event.dump(), ensure_ascii=False, separators=(",", ":"))
    assert "\n" not in line and "\r" not in line


def test_a_done_event_for_a_lesson_has_no_pause_frame_key() -> None:
    dumped = DoneEvent.model_validate(_done_payload()).dump()
    assert "pause_at_frame" not in dumped["animation"]


def test_a_diagnostics_item_never_carries_a_message() -> None:
    item = {**_diagnostic(), "message": "secret detail", "line": 3}
    leaky = {**SSE_EXAMPLES[5][2], "items": [item]}
    dumped = DiagnosticsEvent.model_validate(leaky).dump()
    assert dumped["items"] == [{"tool": "policy", "code": "POLICY_JSX_SYNTAX", "line": 3}]


def test_error_codes_are_the_closed_set_of_requirement_13() -> None:
    assert set(ERROR_CODES) == {
        "ANIMATION_VERIFICATION_FAILED",
        "ANIMATION_TIMEOUT",
        "ANIMATION_VERIFIER_UNAVAILABLE",
        "ANIMATION_STORAGE_FAILED",
        "ANIMATION_QUOTA_EXCEEDED",
        "PROVIDER_UNAVAILABLE",
        "RATE_LIMITED",
        "UNKNOWN",
    }
    error = SSE_EXAMPLES[7][2]
    for code in ERROR_CODES:
        assert ErrorEvent.model_validate({**error, "code": code}).code == code
    for outside in ("ANIMATION_NOT_CONFIGURED", "INVALID_REQUEST", "animation_timeout", ""):
        assert _first_field(_rejected(ErrorEvent, {**error, "code": outside})) == "code"


@pytest.mark.parametrize(
    ("model", "payload", "field"),
    [
        (StartedEvent, {"max_attempts": 5, "deadline_ms": 1, "cached": False}, "max_attempts"),
        (StartedEvent, {"max_attempts": 4, "deadline_ms": 0, "cached": False}, "deadline_ms"),
        (StartedEvent, {"max_attempts": 4, "deadline_ms": 1, "cached": "no"}, "cached"),
        (StageEvent, {"stage": "uploading", "attempt": 1}, "stage"),
        (StageEvent, {"stage": "verifying", "attempt": 0}, "attempt"),
        (DoneEvent, {"cached": True, "attempts": 1}, "animation"),
        (DoneEvent, {**_done_payload(), "attempts": 0}, "attempts"),
        (ErrorEvent, {"code": "UNKNOWN", "message": "", "attempts": 0}, "message"),
        (ErrorEvent, {"code": "UNKNOWN", "message": "x", "attempts": -1}, "attempts"),
    ],
)
def test_stream_events_reject_values_outside_their_rules(
    model: Any, payload: dict[str, Any], field: str
) -> None:
    assert _first_field(_rejected(model, payload)) == field


def test_a_diagnostics_event_lists_at_most_ten_items() -> None:
    payload = SSE_EXAMPLES[5][2]
    item = payload["items"][0]
    full = {**payload, "items": [item] * DIAGNOSTICS_EVENT_ITEMS_MAX}
    assert DiagnosticsEvent.model_validate(full)
    over = {**payload, "items": [item] * (DIAGNOSTICS_EVENT_ITEMS_MAX + 1)}
    assert _first_field(_rejected(DiagnosticsEvent, over)) == "items"


def test_an_error_event_may_report_zero_attempts() -> None:
    """The deadline can pass before the first Gemini call starts."""
    payload = {"code": "ANIMATION_TIMEOUT", "message": "Too slow.", "attempts": 0}
    assert ErrorEvent.model_validate(payload).attempts == 0


# --- AnimationRow -----------------------------------------------------------------------------


def test_animation_row_is_a_frozen_dataclass_with_the_table_columns() -> None:
    names = [field.name for field in dataclasses.fields(AnimationRow)]
    assert names == [
        "id",
        "owner_id",
        "request_hash",
        "source_sha256",
        "bundle_sha256",
        "s3_prefix",
        "kind",
        "meta",
        "attempts",
        "model",
        "verifier_version",
        "contract_version",
        "runtime_version",
        "source_bytes",
        "bundle_bytes",
        "created_at",
    ]
    manifest = _load("manifest-valid")
    row = AnimationRow(
        id="7a1b9c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d",
        owner_id=uuid.UUID("11111111-2222-4333-8444-555555555555"),
        request_hash=manifest["request_hash"],
        source_sha256=manifest["source_sha256"],
        bundle_sha256=manifest["bundle_sha256"],
        s3_prefix=f"animations/v1/{manifest['source_sha256'][:2]}/{manifest['source_sha256']}/",
        kind="puzzle",
        meta=manifest["meta"],
        attempts=manifest["attempts"],
        model=manifest["model"],
        verifier_version=manifest["verification"]["verifier_version"],
        contract_version=manifest["contract_version"],
        runtime_version=manifest["runtime_version"],
        source_bytes=manifest["source_bytes"],
        bundle_bytes=manifest["bundle_bytes"],
        created_at=1_795_000_000_000,
    )
    with pytest.raises(dataclasses.FrozenInstanceError):
        row.attempts = 3  # type: ignore[misc]


# --- imports ----------------------------------------------------------------------------------


def test_importing_the_models_in_a_fresh_process_imports_no_heavy_packages() -> None:
    code = (
        "import sys\n"
        "import app.ai.animation.models\n"
        "heavy = ['boto3', 'botocore', 'langgraph']\n"
        "found = [m for m in heavy if m in sys.modules]\n"
        "assert not found, found\n"
    )
    done = subprocess.run(
        [sys.executable, "-c", code],
        cwd=BACKEND_DIR,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert done.returncode == 0, done.stderr
