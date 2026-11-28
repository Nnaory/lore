"""Tests for Required_Tokens, Skipped_Tokens and the effective Forbidden_Tokens (Requirement 12).

Why: the fidelity gate (verifier step 7) checks that every label of the lesson `visual` shows on
screen, and the prompt tells Gemini the same list. Both sides must get the same tokens, so the
rules live in one pure module (`app/ai/animation/tokens.py`) and these tests pin them:

- `normalize_token` matches the 39 vectors in `fixtures/animation/token-normalization.json`,
  which the Node side computed with `normalizeToken` (Requirement 10.1, 10.13).
- The five golden fixtures `tokens-golden-<kind>.json` fix the order of the tokens per `visual`
  kind (Requirement 12.10). Their expected lists are written by hand, not produced by the code.
- The companion files of `animation-verifier/fixtures/good/*.json` hold the `required_tokens` the
  verifier fixtures were written for (without the title; Requirement 38.13).
- Skipped tokens (hex, `rgb(`, `hsl(`, forbidden URL schemes; G2), the 68-string bound, the
  examples of Requirement 12.7 and 12.8, no mutation of the request, and 40 seeded random requests
  for `effective_forbidden_tokens` (Requirement 12.11).

Unicode versions: `unicodedata` follows the Python build (3.12 ships Unicode 15.0) while the
verifier's `String.prototype.normalize` follows Node's ICU. A character added to NFKC or to case
mapping in a newer Unicode could make the two sides differ. The shared vectors only use stable
characters; the `ci/api` job (Python 3.12) is what proves the parity on the CI image.

No network, no database, no `langgraph` or `boto3`.
"""

from __future__ import annotations

import json
import random
import subprocess
import sys
from dataclasses import FrozenInstanceError
from pathlib import Path
from typing import Any

import pytest

from app.ai.animation.contract import AnimationContract, ContractOk, load_contract
from app.ai.animation.models import CreateAnimationRequest
from app.ai.animation.tokens import (
    TokenSet,
    derive_tokens,
    effective_forbidden_tokens,
    normalize_token,
    required_tokens,
    url_scheme_prefix,
)
from app.ai.zod_compat import js_trim

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BACKEND_DIR.parent
FIXTURES = BACKEND_DIR / "tests" / "fixtures" / "animation"
GOOD_FIXTURES = REPO_DIR / "animation-verifier" / "fixtures" / "good"

SEEDS = 40
GOLDEN_KINDS = ("vectors", "plot", "diagram", "table", "formula")

# Requirement 12.2 names these four prefixes; the contract lists more colour functions (`hwb(`,
# `oklch(`, ...) for the policy scan. They must stay a subset, or the two rules drifted apart.
SKIPPED_COLOR_FUNCTIONS = ("rgb(", "rgba(", "hsl(", "hsla(")


def _contract() -> AnimationContract:
    loaded = load_contract()
    assert isinstance(loaded, ContractOk)
    return loaded.contract


def _load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _vectors_visual() -> dict[str, Any]:
    """A valid visual with no label and no caption, so only the title is a token."""
    return {"kind": "vectors", "vectors": [{"from": [0, 0], "to": [1, 1]}]}


def _request(**overrides: Any) -> CreateAnimationRequest:
    raw: dict[str, Any] = {
        "kind": "lesson",
        "title": "A title",
        "text": "The lesson text.",
        "visual": _vectors_visual(),
        "language": "en",
    }
    raw.update(overrides)
    return CreateAnimationRequest.model_validate(raw)


def _table_request(
    headers: list[str], rows: list[list[str]], **overrides: Any
) -> CreateAnimationRequest:
    visual = {"kind": "table", "headers": headers, "rows": rows}
    return _request(visual=visual, **overrides)


def _derive(req: CreateAnimationRequest) -> TokenSet:
    return derive_tokens(req, _contract())


def _required(req: CreateAnimationRequest) -> list[str]:
    return required_tokens(req, _contract())


# --- normalize_token --------------------------------------------------------------------------

NORMALIZATION_VECTORS = _load(FIXTURES / "token-normalization.json")


def test_the_normalization_fixture_covers_what_requirement_10_13_asks() -> None:
    assert len(NORMALIZATION_VECTORS) >= 20
    inputs = "".join(vector["input"] for vector in NORMALIZATION_VECTORS)
    for needle in ("\ufeff", "\u200b", "\u0130"):
        assert needle in inputs


@pytest.mark.parametrize("vector", NORMALIZATION_VECTORS, ids=lambda vector: vector["name"])
def test_normalize_token_matches_the_vectors_computed_by_node(vector: dict[str, str]) -> None:
    assert normalize_token(vector["input"]) == vector["expected"]


def test_normalize_token_removes_exactly_the_ecmascript_whitespace_set() -> None:
    """`x<c>x` collapses to `xx` for the characters `String.prototype.trim` strips and no others.

    `js_trim` is the existing copy of the ECMAScript set, so this catches a typo in the regex
    without a second hand-written list. Lone surrogates are left out (they are not text).
    """
    for code_point in range(0x10000):
        if 0xD800 <= code_point <= 0xDFFF:
            continue
        char = chr(code_point)
        collapses = normalize_token(f"x{char}x") == "xx"
        assert collapses == (js_trim(char) == ""), hex(code_point)


def test_normalize_token_never_raises_on_a_lone_surrogate() -> None:
    assert normalize_token("A\ud800B") == "a\ud800b"


# Idempotence holds for every single code point, but not for text where whitespace sits between a
# base character and the combining mark that follows it (finding 3.1): the whitespace is removed
# after NFKC, so the mark and its base only meet on the second pass. The Node side behaves the
# same, so this is a documented limit and not a bug. The generator below therefore builds text
# from whole units: no unit starts with a combining mark or a Hangul jamo, so nothing can attach
# across a removed space.
IDEMPOTENCE_UNITS = (
    "a",
    "Z",
    "7",
    "(",
    ")",
    " ",
    "\t",
    "\n",
    "\u00a0",
    "\u3000",
    "\ufeff",
    "\u200b",
    "\u2060",
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
    "e\u0301",
    "\uff76\uff9e",
    "\u00e9",
)


@pytest.mark.parametrize("seed", range(SEEDS))
def test_normalize_token_is_idempotent_on_text_without_a_space_before_a_mark(seed: int) -> None:
    rng = random.Random(seed)
    text = "".join(rng.choice(IDEMPOTENCE_UNITS) for _ in range(rng.randint(0, 14)))
    once = normalize_token(text)
    assert normalize_token(once) == once


def test_normalization_is_not_idempotent_when_a_space_separates_a_base_and_its_mark() -> None:
    """The documented counterexample, so nobody widens the generator above by accident."""
    once = normalize_token("e \u0301")
    assert once == "e\u0301"
    assert normalize_token(once) == "\u00e9"


# --- url_scheme_prefix ------------------------------------------------------------------------


def test_every_scheme_of_the_contract_is_found_with_any_letter_case_and_leading_space() -> None:
    contract = _contract()
    assert contract.url_schemes
    for scheme in contract.url_schemes:
        for spelling in (scheme, scheme.upper(), scheme.capitalize()):
            assert url_scheme_prefix(f"  {spelling}://example.test/x", contract) == scheme


def test_url_scheme_prefix_trims_like_javascript() -> None:
    assert url_scheme_prefix("\ufeff\u00a0https://x", _contract()) == "https"


def test_the_strict_colon_schemes_need_a_character_that_is_not_a_space_after_the_colon() -> None:
    contract = _contract()
    strict = contract.url_schemes_strict_colon
    assert strict
    assert set(strict) <= set(contract.url_schemes)
    for scheme in strict:
        assert url_scheme_prefix(f"{scheme}:x", contract) == scheme
        assert url_scheme_prefix(f"{scheme}:abc def", contract) == scheme
        assert url_scheme_prefix(f"{scheme}: x", contract) is None
        assert url_scheme_prefix(f"{scheme}:\tx", contract) is None
        assert url_scheme_prefix(f"{scheme}:\u00a0x", contract) is None
        assert url_scheme_prefix(f"{scheme}:", contract) is None
        assert url_scheme_prefix(f"  {scheme}:  ", contract) is None


def test_a_scheme_outside_strict_colon_needs_only_the_colon() -> None:
    """Requirement 7.9 sets the follow-up rule for the strict schemes only."""
    contract = _contract()
    lax = [s for s in contract.url_schemes if s not in contract.url_schemes_strict_colon]
    assert lax
    for scheme in lax:
        assert url_scheme_prefix(f"{scheme}: x", contract) == scheme


@pytest.mark.parametrize(
    "text",
    [
        "",
        "HTTP",
        "File size",
        "http",
        "https",
        "httpd://x",
        "ftps://x",
        "mailto:a@b.c",
        "see https://x",
        "x data:y",
        "wsx:y",
    ],
)
def test_text_that_does_not_start_with_scheme_and_colon_is_not_a_url(text: str) -> None:
    assert url_scheme_prefix(text, _contract()) is None


def test_url_scheme_prefix_reads_its_rules_from_the_contract() -> None:
    contract = _contract().model_copy(
        update={"url_schemes": ("gopher",), "url_schemes_strict_colon": ("gopher",)}
    )
    assert url_scheme_prefix("gopher:x", contract) == "gopher"
    assert url_scheme_prefix("GOPHER: x", contract) is None
    assert url_scheme_prefix("http://x", contract) is None


# --- derive_tokens: golden fixtures, companions and order ---------------------------------------


def test_there_is_one_golden_fixture_per_visual_kind() -> None:
    for kind in GOLDEN_KINDS:
        golden = _load(FIXTURES / f"tokens-golden-{kind}.json")
        assert golden["request"]["visual"]["kind"] == kind


@pytest.mark.parametrize("kind", GOLDEN_KINDS)
def test_golden_fixtures_give_the_expected_tokens_in_order(kind: str) -> None:
    golden = _load(FIXTURES / f"tokens-golden-{kind}.json")
    req = CreateAnimationRequest.model_validate(golden["request"])
    tokens = _derive(req)
    assert tokens.required == golden["required_tokens"]
    assert tokens.skipped == golden["skipped_tokens"]
    assert _required(req) == golden["required_tokens"]
    assert effective_forbidden_tokens(req, tokens.required) == golden["effective_forbidden_tokens"]


def test_a_golden_fixture_keeps_the_requested_forbidden_tokens_untouched() -> None:
    """The puzzle golden asks for six tokens and keeps one; the request still lists all six."""
    golden = _load(FIXTURES / "tokens-golden-vectors.json")
    req = CreateAnimationRequest.model_validate(golden["request"])
    assert req.forbidden_tokens == golden["request"]["forbidden_tokens"]
    assert len(req.forbidden_tokens) == 6
    assert effective_forbidden_tokens(req, _required(req)) == ["(378, 354)"]


GOOD_COMPANIONS = sorted(GOOD_FIXTURES.glob("*.json"))
COMPANION_TITLE = "Companion fixture title"


def test_the_good_fixtures_of_the_verifier_have_companion_files_for_every_kind() -> None:
    assert GOOD_COMPANIONS, f"no companion files under {GOOD_FIXTURES}"
    kinds = {_load(path)["visual"]["kind"] for path in GOOD_COMPANIONS}
    assert kinds == set(GOLDEN_KINDS)
    assert {_load(path)["kind"] for path in GOOD_COMPANIONS} == {"lesson", "puzzle"}


@pytest.mark.parametrize("path", GOOD_COMPANIONS, ids=lambda path: path.stem)
def test_required_tokens_equal_the_companion_list_after_the_title(path: Path) -> None:
    """The companions were written without a title, so the title goes first and is skipped here.

    The files are the verifier's; this test reads them and never edits them (finding 3.4).
    """
    companion = _load(path)
    req = CreateAnimationRequest.model_validate(
        {
            "kind": companion["kind"],
            "title": COMPANION_TITLE,
            "text": "Companion fixture text.",
            "visual": companion["visual"],
            "language": "en",
            "forbidden_tokens": companion["forbidden_tokens"],
        }
    )
    required = _required(req)
    assert required[0] == COMPANION_TITLE
    assert required[1:] == companion["required_tokens"]
    assert _derive(req).skipped == []
    assert effective_forbidden_tokens(req, required) == companion["forbidden_tokens"]


def test_the_title_comes_first_and_is_the_trimmed_title_of_the_request() -> None:
    req = _request(
        title="  \u00a0Pick 4 items\ufeff ", visual={**_vectors_visual(), "caption": "C"}
    )
    assert _required(req) == ["Pick 4 items", "C"]


def test_numeric_coordinates_are_never_tokens() -> None:
    vectors = {
        "kind": "vectors",
        "vectors": [{"from": [111, 222], "to": [333, 444]}],
        "points": [{"at": [555, 666]}],
        "x_range": [0, 700],
    }
    plot = {
        "kind": "plot",
        "series": [{"points": [[777, 888], [999, 100]]}],
    }
    for visual in (vectors, plot):
        assert _required(_request(title="Plain title", visual=visual)) == ["Plain title"]


def test_node_ids_and_edge_ends_are_not_tokens() -> None:
    visual = {
        "kind": "diagram",
        "layout": "flow",
        "nodes": [{"id": "node-one", "label": "One"}, {"id": "node-two", "label": "Two"}],
        "edges": [{"from": "node-one", "to": "node-two"}],
    }
    assert _required(_request(title="Flow", visual=visual)) == ["Flow", "One", "Two"]


def test_a_value_that_is_empty_after_normalization_is_dropped() -> None:
    # U+FEFF passes the field rules (Python's `strip` keeps it) but normalizes to the empty string.
    req = _table_request(["\ufeff", "Real"], [["\ufeff\ufeff", ""]])
    assert _required(req) == ["A title", "Real"]
    assert _derive(req).skipped == []


def test_a_duplicate_by_normal_form_is_dropped_and_the_first_string_is_kept() -> None:
    req = _table_request(
        ["Net Force", "Other"],
        [["net  force", "\uff2e\uff25\uff34 \uff26\uff2f\uff32\uff23\uff25"], ["x\u00b2", "X2"]],
    )
    assert _required(req) == ["A title", "Net Force", "Other", "x\u00b2"]


def test_the_first_string_is_returned_verbatim_without_extra_trimming() -> None:
    # Python's `strip` leaves U+FEFF inside the cell, and the token must not be trimmed again.
    req = _table_request(["\ufeffAB", "ab"], [["\u00e9", "e\u0301"]])
    assert _required(req) == ["A title", "\ufeffAB", "\u00e9"]


def test_the_title_takes_part_in_the_duplicate_rule() -> None:
    req = _table_request(["a  TITLE", "Next"], [["x", "y"]])
    assert _required(req) == ["A title", "Next", "x", "y"]


@pytest.mark.parametrize(
    "text",
    [
        "#fff",
        "#FFFF",
        "#a1b2c3",
        "#A1B2C3D4",
        "#aBc",
        "\ufeff#fff",
        "rgb(1,2,3)",
        "RGBA(1,2,3,0.5)",
        "hsl(0, 0%, 0%)",
        "Hsla(0,0%,0%,1)",
        "\ufeff rgb(0,0,0)",
        "https://a.example",
        "HTTP://a",
        "ftp://f",
        "ws://w",
        "wss://w",
        "file:///etc/hosts",
        "data:text/plain,hi",
        "DATA:x",
        "javascript:alert(1)",
        "blob:x",
        "vbscript:x",
        "\ufeffhttps://x",
    ],
)
def test_a_token_that_would_trip_the_policy_scan_is_skipped_not_required(text: str) -> None:
    tokens = _derive(_table_request(["Col"], [[text]]))
    assert tokens.required == ["A title", "Col"]
    assert tokens.skipped == [text]


@pytest.mark.parametrize(
    "text",
    [
        "#ff",
        "#12345",
        "#fffffff",
        "#ggg",
        "# fff",
        "color #fff",
        "x #fff",
        "rgb (1)",
        "rgbx(1)",
        "hwb(1 2 3)",
        "Data: 5",
        "data:",
        "data:\u00a0x",
        "javascript: x",
        "HTTP",
        "File size",
        "httpd://x",
        "ftps://x",
        "mailto:a@b.c",
        "see https://x",
    ],
)
def test_a_token_that_only_looks_like_a_colour_or_url_stays_required(text: str) -> None:
    tokens = _derive(_table_request(["Col"], [[text]]))
    assert tokens.required == ["A title", "Col", text]
    assert tokens.skipped == []


def test_the_title_can_be_skipped_like_any_other_token() -> None:
    tokens = _derive(_request(title="#FFF"))
    assert tokens.required == []
    assert tokens.skipped == ["#FFF"]


def test_a_skipped_token_is_listed_once_in_the_order_of_first_appearance() -> None:
    req = _table_request(
        ["#FFF", "Name"], [["#fff", "rgb(1,2,3)"], ["\uff03\uff26\uff26\uff26", "x"]]
    )
    tokens = _derive(req)
    # The fullwidth `#FFF` has the same normal form as `#FFF`, so only the first spelling is kept.
    assert tokens.skipped == ["#FFF", "rgb(1,2,3)"]
    assert tokens.required == ["A title", "Name", "x"]


def test_the_hex_rule_comes_from_the_contract() -> None:
    contract = _contract()
    narrow = contract.color_forms.model_copy(update={"hex_pattern": r"^#[0-9a-f]{2}$"})
    custom = contract.model_copy(update={"color_forms": narrow})
    req = _table_request(["#ab", "#abc"], [["x", "y"]])
    tokens = derive_tokens(req, custom)
    assert tokens.skipped == ["#ab"]
    assert "#abc" in tokens.required


def test_the_skipped_colour_functions_are_part_of_the_contract_functions() -> None:
    assert set(SKIPPED_COLOR_FUNCTIONS) <= set(_contract().color_forms.functions)


def test_at_most_68_strings_of_at_most_200_characters() -> None:
    """Title 1, caption 1, six headers and sixty cells of the longest legal length (12.9)."""
    headers = [f"h{column}".ljust(24, "x") for column in range(6)]
    rows = [[f"r{row}c{column}".ljust(40, "y") for column in range(6)] for row in range(10)]
    visual = {"kind": "table", "headers": headers, "rows": rows, "caption": "C" * 160}
    req = _request(title="T" * 200, visual=visual)
    required = _required(req)
    assert len(required) == 68
    assert max(len(token) for token in required) == 200
    assert required[0] == "T" * 200
    assert required[1] == "C" * 160
    assert required[2:8] == headers
    assert required[8:] == [cell for row in rows for cell in row]


def test_derive_tokens_is_deterministic_and_returns_fresh_lists() -> None:
    req = CreateAnimationRequest.model_validate(
        _load(FIXTURES / "tokens-golden-table.json")["request"]
    )
    first = _derive(req)
    first.required.append("changed")
    first.skipped.append("changed")
    second = _derive(req)
    assert "changed" not in second.required
    assert "changed" not in second.skipped
    assert _derive(req) == second
    assert required_tokens(req, _contract()) == second.required


def test_token_set_is_a_frozen_dataclass() -> None:
    tokens = TokenSet(required=["a"], skipped=[])
    with pytest.raises(FrozenInstanceError):
        tokens.required = []


def test_deriving_tokens_does_not_change_the_request() -> None:
    req = _request(
        kind="puzzle",
        title="  Pick 4 items ",
        visual={"kind": "table", "headers": ["A", "B"], "rows": [["1", "#fff"]], "caption": "C"},
        forbidden_tokens=["4", "  ", "Ya", "ya"],
    )
    before = req.model_dump()
    forbidden_before = list(req.forbidden_tokens)
    required = _required(req)
    effective_forbidden_tokens(req, required)
    assert req.model_dump() == before
    assert req.forbidden_tokens == forbidden_before


# --- effective_forbidden_tokens ---------------------------------------------------------------


def _puzzle(forbidden: list[str], title: str = "A title") -> CreateAnimationRequest:
    return _request(kind="puzzle", title=title, forbidden_tokens=forbidden)


def test_blank_and_duplicate_tokens_are_dropped_and_the_first_spelling_is_kept() -> None:
    req = _puzzle(["  ", "Ya", "ya"])
    assert effective_forbidden_tokens(req, _required(req)) == ["Ya"]


def test_the_first_spelling_wins_whatever_it_is() -> None:
    req = _puzzle(["ya", "Ya", " YA "])
    assert effective_forbidden_tokens(req, _required(req)) == ["ya"]


def test_a_token_inside_a_required_token_is_dropped() -> None:
    req = _puzzle(["4"], title="Pick 4 items")
    assert _required(req) == ["Pick 4 items"]
    assert effective_forbidden_tokens(req, _required(req)) == []


def test_a_token_equal_to_a_required_token_is_dropped_after_normalization() -> None:
    req = _puzzle(["PICK4ITEMS", "pick 4  items", "Pick 4"], title="Pick 4 items")
    assert effective_forbidden_tokens(req, _required(req)) == []


def test_a_token_that_only_contains_a_required_token_is_kept() -> None:
    req = _puzzle(["Pick 4 items now"], title="Pick 4 items")
    assert effective_forbidden_tokens(req, _required(req)) == ["Pick 4 items now"]


def test_order_is_kept_and_unrelated_tokens_survive() -> None:
    req = _puzzle(["zeta", "alpha", "ZETA", "beta"], title="Gamma")
    assert effective_forbidden_tokens(req, _required(req)) == ["zeta", "alpha", "beta"]


def test_substring_is_checked_on_normal_forms_not_on_raw_strings() -> None:
    req = _puzzle(["tip to", "\uff54\uff49\uff50"], title="Tip\u00a0to\u3000tail")
    assert effective_forbidden_tokens(req, _required(req)) == []


def test_a_lesson_has_no_effective_forbidden_tokens() -> None:
    req = _request(kind="lesson")
    assert effective_forbidden_tokens(req, _required(req)) == []


def test_the_required_argument_is_used_as_given() -> None:
    req = _puzzle(["Alpha", "Beta"])
    assert effective_forbidden_tokens(req, ["alphabet soup"]) == ["Beta"]
    assert effective_forbidden_tokens(req, []) == ["Alpha", "Beta"]
    assert effective_forbidden_tokens(req, ("alphabet soup",)) == ["Beta"]


def test_the_result_is_a_new_list() -> None:
    req = _puzzle(["Alpha"])
    result = effective_forbidden_tokens(req, [])
    result.append("changed")
    assert req.forbidden_tokens == ["Alpha"]


# --- 40 random requests -------------------------------------------------------------------------

# Words that collide on purpose: same normal form with other spelling ("Yes"/"yes", `x²`/"x2",
# fullwidth), a value that normalizes to nothing (U+FEFF), colour and URL look-alikes, and one that
# is a substring of another ("Pick 4" in "Pick 4 items"). All fit the shortest label limit (16).
VOCAB = (
    "4",
    "Yes",
    "yes",
    "Net force",
    "net  force",
    "A",
    "B",
    "\uff21\uff22",
    "ab",
    "x\u00b2",
    "x2",
    "\u0130",
    "i",
    "\u00df",
    "SS",
    "#fff",
    "#FFF",
    "rgb(1,2,3)",
    "https://x",
    "Data: 5",
    "\ufeff",
    "\u03a3",
    "\u03c3",
    "\u03c2",
    "Pick 4",
    "pick4",
    "A + B",
    "t (s)",
)
FORBIDDEN_VOCAB = (
    *VOCAB,
    "  ",
    "\u3000",
    "4 ",
    " yes",
    "pick",
    "net",
    "ab ",
    "5",
    "A+B",
    "Pick 4 items",
)
TITLES = (
    "Pick 4 items",
    "Vectors",
    "Net force law",
    "\uff21\uff22 title",
    "\u0130stanbul",
    "Stra\u00dfe",
)


def _without_none(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _without_none(item) for key, item in value.items() if item is not None}
    if isinstance(value, list):
        return [_without_none(item) for item in value]
    return value


def _random_visual(rng: random.Random) -> dict[str, Any]:
    def word() -> str:
        return rng.choice(VOCAB)

    def maybe() -> str | None:
        return word() if rng.random() < 0.7 else None

    kind = rng.choice(GOLDEN_KINDS)
    if kind == "vectors":
        visual: dict[str, Any] = {
            "kind": kind,
            "vectors": [
                {"from": [0, 0], "to": [index + 1, rng.randint(1, 9)], "label": maybe()}
                for index in range(rng.randint(1, 6))
            ],
            "points": [{"at": [1, 1], "label": maybe()} for _ in range(rng.randint(0, 6))],
        }
    elif kind == "plot":
        visual = {
            "kind": kind,
            "x_label": maybe(),
            "y_label": maybe(),
            "series": [
                {"label": maybe(), "points": [[0, 0], [1, 1]]} for _ in range(rng.randint(1, 3))
            ],
        }
    elif kind == "diagram":
        count = rng.randint(2, 8)
        visual = {
            "kind": kind,
            "layout": rng.choice(["flow", "tree", "cycle"]),
            "nodes": [
                {"id": f"n{index}", "label": word(), "detail": maybe()} for index in range(count)
            ],
            "edges": [
                {"from": f"n{start}", "to": f"n{(start + 1) % count}", "label": maybe()}
                for start in rng.sample(range(count), rng.randint(0, min(count, 12)))
            ],
        }
    elif kind == "table":
        columns = rng.randint(1, 6)
        visual = {
            "kind": kind,
            "headers": [word() for _ in range(columns)],
            "rows": [
                [word() if rng.random() < 0.9 else "" for _ in range(columns)]
                for _ in range(rng.randint(1, 10))
            ],
        }
    else:
        visual = {
            "kind": kind,
            "expression": word(),
            "terms": [{"symbol": word(), "meaning": word()} for _ in range(rng.randint(1, 5))],
            "example": maybe(),
        }
    visual["caption"] = maybe()
    return _without_none(visual)


def _random_request(seed: int) -> CreateAnimationRequest:
    rng = random.Random(seed)
    kind = rng.choice(["lesson", "puzzle"])
    raw: dict[str, Any] = {
        "kind": kind,
        "title": f"{rng.choice(TITLES)} {rng.choice(VOCAB)}",
        "text": "Seeded text.",
        "visual": _random_visual(rng),
        "language": rng.choice(["en", "id"]),
    }
    if kind == "puzzle":
        raw["forbidden_tokens"] = [rng.choice(FORBIDDEN_VOCAB) for _ in range(rng.randint(0, 8))]
    return CreateAnimationRequest.model_validate(raw)


@pytest.mark.parametrize("seed", range(SEEDS))
def test_effective_forbidden_tokens_hold_their_properties_on_random_requests(seed: int) -> None:
    req = _random_request(seed)
    snapshot = req.model_dump()
    requested = list(req.forbidden_tokens)

    tokens = _derive(req)
    effective = effective_forbidden_tokens(req, tokens.required)

    # No mutation, and the same answer the second time.
    assert req.model_dump() == snapshot
    assert effective == effective_forbidden_tokens(req, _required(req))
    assert _derive(req) == tokens

    # Required_Tokens: bounded, normal forms unique and never empty, disjoint from the skipped.
    assert len(tokens.required) <= 68
    assert all(len(token) <= 200 for token in tokens.required + tokens.skipped)
    forms = [normalize_token(token) for token in tokens.required + tokens.skipped]
    assert all(forms)
    assert len(set(forms)) == len(forms)

    # The effective list is a subsequence of the request (same strings, same order).
    remaining = iter(requested)
    assert all(any(token == candidate for candidate in remaining) for token in effective)

    # Requirement 12.11: no blank, no duplicate, and nothing equal to or inside a required token.
    required_forms = [normalize_token(token) for token in tokens.required]
    effective_forms = [normalize_token(token) for token in effective]
    assert all(effective_forms)
    assert len(set(effective_forms)) == len(effective_forms)
    for form in effective_forms:
        assert not any(form in required for required in required_forms)

    # Nothing is dropped without a reason, and the first spelling is the one that stays.
    first_spelling: dict[str, str] = {}
    for token in requested:
        first_spelling.setdefault(normalize_token(token), token)
    for form, token in first_spelling.items():
        blocked = form == "" or any(form in required for required in required_forms)
        assert (token in effective) == (not blocked)
        if not blocked:
            assert effective[effective_forms.index(form)] == token


def test_the_random_requests_reach_every_branch_of_the_rules() -> None:
    """Guards the property above against passing because the generator never makes it work."""
    seen = {"kinds": set(), "forbidden": 0, "dropped": 0, "kept": 0, "skipped": 0, "blank": 0}
    for seed in range(SEEDS):
        req = _random_request(seed)
        tokens = _derive(req)
        effective = effective_forbidden_tokens(req, tokens.required)
        seen["kinds"].add(req.visual.kind)
        seen["forbidden"] += bool(req.forbidden_tokens)
        seen["kept"] += bool(effective)
        seen["dropped"] += len(effective) < len(
            set(map(normalize_token, req.forbidden_tokens)) - {""}
        )
        seen["skipped"] += bool(tokens.skipped)
        seen["blank"] += any(not normalize_token(t) for t in req.forbidden_tokens)
    assert seen["kinds"] == set(GOLDEN_KINDS)
    for name in ("forbidden", "dropped", "kept", "skipped", "blank"):
        assert seen[name] > 0, name


# --- imports ----------------------------------------------------------------------------------


def test_importing_the_tokens_in_a_fresh_process_imports_no_heavy_packages() -> None:
    code = (
        "import sys\n"
        "import app.ai.animation.tokens\n"
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
