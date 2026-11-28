"""Parity test: token normalization in Python agrees with the TypeScript verifier (Property 11).

Why: the fidelity gate of the verifier (step 7) compares screen text with the Required_Tokens
that Python derived, and both sides normalize with NFKC, `lower()` and removal of every
ECMAScript `\\s` character. If the two disagreed for one character, a label that is on screen
could be reported missing, or a hidden answer could pass as absent (Requirement 10.13, design
Property 11). This file is the Python half: it reads the shared fixture
`fixtures/animation/token-normalization.json`, whose `expected` strings were computed by Node's
`normalizeToken` (the TypeScript half is `animation-verifier/tests/tokens.test.ts`, which reads the
same file). Node cannot run from the backend tests, so the fixture is the only bridge.

What is checked:

- the fixture itself: shape, unique names, at least 20 vectors, the characters Requirement 10.13
  names (U+FEFF, U+200B, U+0130), and no ECMAScript whitespace left in any `expected`;
- every vector through `normalize_token`, through an independent per-character reference in
  `tests/animation_token_support.py` (its whitespace list is spelled out, not taken from the
  module), and through `derive_tokens` / `required_tokens` as a table cell, which is the Pytest
  side of Requirement 10.13 ("Pytest (`required_tokens`)");
- idempotence on 40 seeds. `normalize_token` is not idempotent in general: removing whitespace
  after NFKC can bring a base character next to a mark that then composes on the second pass
  (ledger 3.1). The same limit exists in the verifier. The generator therefore only builds text
  where no removed character can separate a base from a mark, and `test_the_exclusions_...`
  shows with concrete counterexamples why each excluded class has to be excluded, and that
  dropping the filter does find failures, so the property is not passing by accident;
- a differential check on unrestricted random text against the per-character reference.

`hypothesis` is not a dependency, so the generators are seeded `random.Random(seed)`.
Python 3.12 has Unicode 15.0 and Node 26 has Unicode 17: a character added after 15.0 could
differ, which is why the vectors use stable characters and `ci/api` is the final proof.
"""

from __future__ import annotations

import json
import random
import unicodedata
from pathlib import Path
from typing import Any

import pytest

from app.ai.animation.contract import AnimationContract, ContractOk, load_contract
from app.ai.animation.models import CreateAnimationRequest
from app.ai.animation.tokens import derive_tokens, normalize_token, required_tokens
from tests.animation_token_support import ECMA_WHITESPACE, reference_normalize

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BACKEND_DIR.parent
FIXTURE = BACKEND_DIR / "tests" / "fixtures" / "animation" / "token-normalization.json"
VERIFIER_TEST = REPO_DIR / "animation-verifier" / "tests" / "tokens.test.ts"
VERIFIER_SOURCE = REPO_DIR / "animation-verifier" / "src" / "tokens.ts"
FIXTURE_REFERENCE = "backend/tests/fixtures/animation/token-normalization.json"

SEEDS = 40
MIN_VECTORS = 20

# The one vector that is deliberately not idempotent (same name as the verifier's test).
NOT_IDEMPOTENT = {"whitespace-between-base-and-combining-mark"}


def _contract() -> AnimationContract:
    loaded = load_contract()
    assert isinstance(loaded, ContractOk)
    return loaded.contract


def _vectors() -> list[dict[str, str]]:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


VECTORS = _vectors()


# --- the fixture --------------------------------------------------------------------------


def test_the_fixture_has_the_shape_both_sides_read() -> None:
    assert isinstance(VECTORS, list)
    assert len(VECTORS) >= MIN_VECTORS
    for vector in VECTORS:
        assert set(vector) == {"name", "input", "expected"}
        assert all(isinstance(vector[key], str) for key in vector)
        assert vector["name"]
    names = [vector["name"] for vector in VECTORS]
    assert len(set(names)) == len(names)


def test_the_fixture_covers_the_characters_requirement_10_13_names() -> None:
    inputs = "".join(vector["input"] for vector in VECTORS)
    for needle, label in (("\ufeff", "U+FEFF"), ("\u200b", "U+200B"), ("\u0130", "U+0130")):
        assert needle in inputs, label


def test_no_expected_string_contains_ecmascript_whitespace() -> None:
    for vector in VECTORS:
        assert not ECMA_WHITESPACE & set(vector["expected"]), vector["name"]


def test_the_typescript_side_reads_the_same_fixture_file() -> None:
    """If the verifier tests pointed at another copy, the two halves would stop proving parity."""
    assert FIXTURE_REFERENCE in VERIFIER_TEST.read_text(encoding="utf-8").replace("\\", "/")
    assert FIXTURE_REFERENCE in VERIFIER_SOURCE.read_text(encoding="utf-8")


# --- every vector -------------------------------------------------------------------------


@pytest.mark.parametrize("vector", VECTORS, ids=lambda vector: vector["name"])
def test_normalize_token_gives_the_string_node_computed(vector: dict[str, str]) -> None:
    assert normalize_token(vector["input"]) == vector["expected"]


@pytest.mark.parametrize("vector", VECTORS, ids=lambda vector: vector["name"])
def test_an_independent_per_character_reference_gives_the_same_string(
    vector: dict[str, str],
) -> None:
    assert reference_normalize(vector["input"]) == vector["expected"]


def _request_with_cell(cell: str) -> CreateAnimationRequest:
    """A valid lesson request whose only free text, besides the title and a header, is `cell`."""
    return CreateAnimationRequest.model_validate(
        {
            "kind": "lesson",
            "title": "Parity title",
            "text": "Text of the lesson.",
            "language": "en",
            "visual": {"kind": "table", "headers": ["Header"], "rows": [[cell]]},
        }
    )


@pytest.mark.parametrize("vector", VECTORS, ids=lambda vector: vector["name"])
def test_required_tokens_normalize_each_vector_to_the_expected_string(
    vector: dict[str, str],
) -> None:
    """Through `derive_tokens`: kept when something is left, dropped when `expected` is empty."""
    if len(vector["input"].strip()) > 40:
        pytest.skip("longer than a table cell (40 characters)")
    request = _request_with_cell(vector["input"])
    tokens = derive_tokens(request, _contract())
    forms = [normalize_token(token) for token in tokens.required]
    assert forms[:2] == ["paritytitle", "header"]
    assert tokens.skipped == []
    if vector["expected"] == "":
        assert forms == ["paritytitle", "header"]
    else:
        assert forms == ["paritytitle", "header", vector["expected"]]
    assert required_tokens(request, _contract()) == tokens.required


def test_every_vector_fits_in_a_table_cell_so_the_test_above_does_not_skip() -> None:
    assert [v["name"] for v in VECTORS if len(v["input"].strip()) > 40] == []


def test_each_expected_string_is_a_fixed_point_except_the_documented_vector() -> None:
    not_fixed = {v["name"] for v in VECTORS if normalize_token(v["expected"]) != v["expected"]}
    assert not_fixed == NOT_IDEMPOTENT & {v["name"] for v in VECTORS}
    assert not_fixed == {"whitespace-between-base-and-combining-mark"}


# --- idempotence on generated text --------------------------------------------------------


def _is_hangul_jamo(ch: str) -> bool:
    code = ord(ch)
    return (
        0x1100 <= code <= 0x11FF  # conjoining jamo
        or 0x3130 <= code <= 0x318F  # compatibility jamo (NFKC maps them to conjoining jamo)
        or 0xA960 <= code <= 0xA97F
        or 0xD7B0 <= code <= 0xD7FF
        or 0xFFA0 <= code <= 0xFFDC  # halfwidth jamo
    )


def _is_safe_char(ch: str) -> bool:
    """True when `ch` can sit anywhere in a string without breaking idempotence.

    Excluded: control, format, separator, unassigned, surrogate and private-use characters (the
    ones that matter are added back as explicit units); every mark; Hangul jamo; U+FF9E and
    U+FF9F (NFKC turns them into combining marks); and any character whose NFKC or lowercase form
    holds whitespace or a mark, such as the spacing diacritics U+00A8 and U+309B, which NFKC
    expands to a space plus a combining mark.
    """
    category = unicodedata.category(ch)
    if ch in ECMA_WHITESPACE or category[0] in "CMZ" or _is_hangul_jamo(ch):
        return False
    if ord(ch) in (0xFF9E, 0xFF9F):
        return False
    compat = unicodedata.normalize("NFKC", ch)
    if any(c in ECMA_WHITESPACE or unicodedata.category(c)[0] == "M" for c in compat):
        return False
    if any(_is_hangul_jamo(c) for c in compat):
        return False
    lowered = compat.lower()
    return not any(unicodedata.category(c)[0] == "M" or _is_hangul_jamo(c) for c in lowered)


def _random_assigned_char(rng: random.Random) -> str:
    """Any assigned, non-surrogate code point (rejection sampling over the whole range)."""
    while True:
        code = rng.randrange(0x110000)
        if 0xD800 <= code <= 0xDFFF:
            continue
        char = chr(code)
        if unicodedata.category(char) != "Cn":
            return char


def _random_safe_char(rng: random.Random) -> str:
    while True:
        char = _random_assigned_char(rng)
        if _is_safe_char(char):
            return char


ASCII_UNITS = tuple("abcxyzABCXYZ0123789()[]{}+-*/=<>,.;:!?'\"_#@")
SPACE_UNITS = tuple(sorted(ECMA_WHITESPACE))
# Not whitespace in ECMAScript, so the module keeps them: they separate tokens in frame text.
KEPT_INVISIBLE_UNITS = ("\u200b", "\u200c", "\u200d", "\u2060", "\u0085", "\u180e")
# Whole units that are safe on their own: each starts with a base character and holds its own
# marks, so removing whitespace around the unit cannot detach them.
COMPOSITE_UNITS = (
    "e\u0301",
    "\u00e9",
    "\u0130",
    "\u00df",
    "\u1e9e",
    "\u03a3",
    "\u03c3",
    "\uff21",
    "\uff11",
    "\ufb01",
    "\u2460",
    "x\u00b2",
    "\u2167",
    "\u212a",
    "\U0001d400",
    "\U0001f600",
    "\uff76\uff9e",
    "\uac00",
)
UNIT_KINDS = ("ascii", "space", "invisible", "composite", "random")


def random_safe_text(rng: random.Random) -> tuple[str, set[str]]:
    """Text built from the safe units, and the unit kinds it used."""
    used: set[str] = set()
    parts: list[str] = []
    for _ in range(rng.randint(0, 16)):
        kind = rng.choice(UNIT_KINDS)
        used.add(kind)
        if kind == "ascii":
            parts.append(rng.choice(ASCII_UNITS))
        elif kind == "space":
            parts.append(rng.choice(SPACE_UNITS))
        elif kind == "invisible":
            parts.append(rng.choice(KEPT_INVISIBLE_UNITS))
        elif kind == "composite":
            parts.append(rng.choice(COMPOSITE_UNITS))
        else:
            parts.append(_random_safe_char(rng))
    return "".join(parts), used


def random_any_text(rng: random.Random) -> str:
    """Text with any assigned character, whitespace and kept invisibles, filter or not."""
    parts: list[str] = []
    for _ in range(rng.randint(0, 12)):
        pool = rng.choice(["any", "any", "space", "invisible", "ascii", "composite"])
        if pool == "any":
            parts.append(_random_assigned_char(rng))
        elif pool == "space":
            parts.append(rng.choice(SPACE_UNITS))
        elif pool == "invisible":
            parts.append(rng.choice(KEPT_INVISIBLE_UNITS))
        elif pool == "ascii":
            parts.append(rng.choice(ASCII_UNITS))
        else:
            parts.append(rng.choice(COMPOSITE_UNITS))
    return "".join(parts)


@pytest.mark.parametrize("seed", range(SEEDS))
def test_normalize_token_is_idempotent_on_text_where_no_space_can_detach_a_mark(
    seed: int,
) -> None:
    rng = random.Random(f"idempotent-{seed}")
    for _ in range(25):
        text, _used = random_safe_text(rng)
        once = normalize_token(text)
        assert normalize_token(once) == once, [hex(ord(c)) for c in text]
        # The result never holds ECMAScript whitespace, so a second pass cannot find any.
        assert not ECMA_WHITESPACE & set(once)


@pytest.mark.parametrize("seed", range(SEEDS))
def test_normalize_token_equals_the_per_character_reference_on_unrestricted_text(
    seed: int,
) -> None:
    rng = random.Random(f"reference-{seed}")
    for _ in range(25):
        text = random_any_text(rng)
        assert normalize_token(text) == reference_normalize(text), [hex(ord(c)) for c in text]


@pytest.mark.parametrize("seed", range(SEEDS))
def test_normalize_token_never_raises_and_returns_a_string(seed: int) -> None:
    rng = random.Random(f"total-{seed}")
    for _ in range(25):
        text = random_any_text(rng)
        if rng.random() < 0.3:
            text += rng.choice(["\ud800", "\udfff", "\ud83d", "\ude00"])
        assert isinstance(normalize_token(text), str)


# --- guards: the generator and its exclusions ---------------------------------------------


def test_the_generator_uses_every_unit_kind_and_makes_varied_text() -> None:
    used: set[str] = set()
    lengths: set[int] = set()
    texts: list[str] = []
    for seed in range(SEEDS):
        rng = random.Random(f"idempotent-{seed}")
        for _ in range(25):
            text, kinds = random_safe_text(rng)
            used |= kinds
            lengths.add(len(text))
            texts.append(text)
    assert used == set(UNIT_KINDS)
    assert len(lengths) >= 10
    joined = "".join(texts)
    assert any(ch in ECMA_WHITESPACE for ch in joined)
    assert any(ch in KEPT_INVISIBLE_UNITS for ch in joined)
    assert any(ord(ch) > 0xFFFF for ch in joined)
    assert any(unicodedata.normalize("NFKC", ch) != ch for ch in joined)
    assert any(ch.isupper() for ch in joined)
    # Not mostly empty or mostly one script.
    assert sum(1 for text in texts if text) > len(texts) * 0.9
    assert len({unicodedata.category(ch) for ch in joined}) >= 8


# Each excluded class, with a string that really is not idempotent when the class is allowed.
# Why it breaks: NFKC leaves the base and the mark apart (a space sits between them), the space
# is removed afterwards, and the second pass composes them. Node behaves the same.
COUNTEREXAMPLES = {
    "mark after whitespace": ("e \u0301", "\u0301"),
    "spacing diaeresis (NFKC: space + U+0308)": ("a\u00a8", "\u00a8"),
    "spacing voiced kana mark (NFKC: space + U+3099)": ("\u304b\u309b", "\u309b"),
    "halfwidth voiced mark after whitespace": ("\uff76 \uff9e", "\uff9e"),
    "Hangul jamo after whitespace": ("\u1100 \u1161", "\u1161"),
}


@pytest.mark.parametrize("name", sorted(COUNTEREXAMPLES))
def test_the_exclusions_are_needed_each_class_has_a_real_counterexample(name: str) -> None:
    text, excluded_char = COUNTEREXAMPLES[name]
    once = normalize_token(text)
    assert normalize_token(once) != once, name
    assert not _is_safe_char(excluded_char), name


def _random_risky_text(rng: random.Random) -> str:
    """Safe text mixed with the excluded characters of the counterexamples above."""
    risky = [char for _, char in COUNTEREXAMPLES.values()] + ["\u0301", "\u3099", "\uff9e"]
    parts: list[str] = []
    for _ in range(rng.randint(1, 10)):
        pool = rng.choice(["safe", "space", "risky", "risky"])
        if pool == "safe":
            parts.append(_random_safe_char(rng))
        elif pool == "space":
            parts.append(rng.choice(SPACE_UNITS))
        else:
            parts.append(rng.choice(risky))
    return "".join(parts)


def test_dropping_the_filter_finds_non_idempotent_text_within_the_seeds() -> None:
    """Negative control: the idempotence property can fail, and the filter is what prevents it.

    Every failing text must hold an excluded character, otherwise the filter would be too wide
    to explain the failure (and the safe generator could be hiding a real bug).
    """
    failures = 0
    for seed in range(SEEDS):
        rng = random.Random(f"risky-{seed}")
        for _ in range(25):
            text = _random_risky_text(rng)
            once = normalize_token(text)
            if normalize_token(once) != once:
                failures += 1
                assert any(not _is_safe_char(ch) and ch not in ECMA_WHITESPACE for ch in text)
    assert failures >= SEEDS // 2


def test_a_safe_character_stays_idempotent_after_a_space_for_every_code_point() -> None:
    """Exhaustive check of the filter: no assigned safe character breaks after a space or a mark.

    The random generator only samples; this walks every code point once with two prefixes (a
    letter and a letter with its own mark), so a character the filter wrongly accepts shows up.
    """
    checked = 0
    for code in range(0x110000):
        if 0xD800 <= code <= 0xDFFF:
            continue
        char = chr(code)
        if not _is_safe_char(char):
            continue
        checked += 1
        for text in (f"a {char}", f"e\u0301 {char} ", f"{char}\u00a0{char}"):
            once = normalize_token(text)
            assert normalize_token(once) == once, hex(code)
    assert checked > 100_000


def test_the_safe_filter_keeps_plain_text_and_drops_marks() -> None:
    for char in "aZ7(\u00e9\u00df\uff21\ufb01\u2460\U0001f600\U0001d400\uac00":
        assert _is_safe_char(char), hex(ord(char))
    # U+0130 lowercases to `i` plus a mark: allowed only as a whole unit, never as a random pick.
    assert not _is_safe_char("\u0130")
    assert "\u0130" in COMPOSITE_UNITS
    for char in (" ", "\u00a0", "\u0301", "\u3099", "\u1161", "\u200b", "\ud800", "\u0378"):
        assert not _is_safe_char(char), hex(ord(char))


def test_normalization_is_a_pure_function_of_its_input() -> None:
    sample: Any = random.Random("pure")
    for _ in range(50):
        text = random_any_text(sample)
        assert normalize_token(text) == normalize_token(text)
