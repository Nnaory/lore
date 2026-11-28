"""Property test: every visible text of a request is covered by a token (Property 12).

Why: the fidelity gate can only protect text that is in the Required_Tokens. If `derive_tokens`
silently forgot a field of some `visual` kind, or dropped a label because of a bad dedupe, the
animation could change that label and still pass. Requirement 12.6 states the property: for any
valid request, every string of the `title` and of the source fields of its `visual` that is not
empty after normalization has the same normal form as at least one element of `required` or
`skipped`.

The generator builds valid requests for the five `visual` kinds from seeded `random.Random`
instances (40 seeds, ten requests each; `hypothesis` is not a dependency). Strings come from a
vocabulary that includes the awkward cases: repeats that differ only by case, spaces or
invisible characters, strings that are empty after normalization (a lone U+FEFF, an empty table
cell), colour literals and URLs (they move to `skipped`), look-alikes that must stay `required`
(`# fff`, `data: 5`), and non-ASCII text.

Two independent checks run on each request:

1. The property itself. The source strings are collected from the validated model by walking its
   dump and picking the keys of Requirement 12.6, not by calling `_visual_texts`; normal forms
   come from the reference in `tests/animation_token_support.py`.
2. An exact oracle built while the request is generated: the strings in the order of Requirement
   12.1 and 12.10 with the label "colour literal or URL" known by construction. The expected
   `required` and `skipped` lists follow from it, so order, dedupe and classification are all
   compared, not only coverage.

`test_the_generator_...` keeps the properties from passing on easy input only.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import Any

import pytest

from app.ai.animation.contract import AnimationContract, ContractOk, load_contract
from app.ai.animation.models import CreateAnimationRequest
from app.ai.animation.tokens import derive_tokens, effective_forbidden_tokens, required_tokens
from tests.animation_token_support import js_trim_reference, reference_normalize

SEEDS = 40
REQUESTS_PER_SEED = 10
KINDS = ("vectors", "plot", "diagram", "table", "formula")

# Key names of Requirement 12.6 whose string value is text the viewer reads.
TEXT_KEYS = frozenset(
    {"caption", "label", "x_label", "y_label", "detail", "expression", "symbol", "meaning"}
    | {"example"}
)

# (text, goes to `skipped`). Every entry is valid for the shortest label (16 characters) or is
# filtered by length when a longer field is used.
SKIPPED_TEXTS = (
    "#fff",
    "#FFF",
    "#a1b2c3",
    "#A1B2C3D4",
    "#abcd",
    "rgb(1, 2, 3)",
    "RGBA(1,2,3,0.5)",
    "hsl(120, 50%, 50%)",
    "hsla(0,0%,0%,1)",
    "http://example.test/x",
    "HTTPS://Example.test",
    "ftp:files",
    "file:///x",
    "ws:x",
    "javascript:void(0)",
    "data:text/plain,x",
    "blob:abc",
    "vbscript:x",
)
# Look-alikes that stay in `required`.
REQUIRED_LOOKALIKES = (
    "# fff",
    "#ggg",
    "#ff",
    "#12345",
    "rgb 255",
    "hwb(1,2,3)",
    "Data: 5",
    "data:",
    "javascript: yes",
    "http",
    "https//x",
    "See http://x",
)
PLAIN_TEXTS = (
    "Force",
    "net force",
    "Vektor Posisi",
    "x",
    "y (m)",
    "time t",
    "F = m \u00d7 a",
    "H\u2082O",
    "Stra\u00dfe",
    "\u0130stanbul",
    "\uff36\uff45\uff43\uff54\uff4f\uff52",
    "\ufb01nal",
    "\u03a9 \u03a3",
    "caf\u00e9",
    "e\u0301",
    "\U0001f600 ok",
    "\u2460 step",
    "a b",
    "42",
    "3.14",
    "-1",
    "yes",
    "Yes",
    "no",
)
# Not empty for the model, empty (or nearly) after normalization.
INVISIBLE_ONLY = ("\ufeff", "\ufeff\ufeff")

# Ways to write the same text again: the normal form stays, the spelling changes.
DECORATIONS = ("same", "upper", "lower", "spaced", "nbsp", "bom_before", "bom_after")


@dataclass
class Draft:
    """A request under construction plus the oracle list that is built beside it."""

    rng: random.Random
    pool: list[tuple[str, bool]]
    # (text as stored in the request, label: is a colour literal or a forbidden URL)
    sources: list[tuple[str, bool]] = field(default_factory=list)
    decorations: set[str] = field(default_factory=set)

    def draw(self, max_len: int, *, optional: bool = False, allow_empty: bool = False) -> Any:
        """A stored string of at most `max_len` characters, recorded in `sources`."""
        if optional and self.rng.random() < 0.35:
            return None
        if allow_empty and self.rng.random() < 0.2:
            self.sources.append(("", False))
            return ""
        for _ in range(50):
            text, skipped = self.rng.choice(self.pool)
            text = self._decorate(text)
            if 1 <= len(text) <= max_len and text.strip() == text:
                self.sources.append((text, skipped))
                return text
        self.sources.append(("x", False))
        return "x"

    def _decorate(self, text: str) -> str:
        style = self.rng.choice(DECORATIONS)
        self.decorations.add(style)
        if style == "upper":
            return text.upper()
        if style == "lower":
            return text.lower()
        if style == "spaced":
            return text.replace(" ", "  ").replace(",", ", ")
        if style == "nbsp":
            return text.replace(" ", "\u00a0")
        # U+FEFF is not whitespace for Python's `strip` (the model keeps it) but is for
        # JavaScript's `trim` and for normalization, so it must not hide a colour literal.
        if style == "bom_before":
            return "\ufeff" + text
        if style == "bom_after":
            return text + "\ufeff"
        return text


def _pool(rng: random.Random) -> list[tuple[str, bool]]:
    """A small per-request pool, so the same text comes back and dedupe is exercised."""
    entries: list[tuple[str, bool]] = []
    entries += [(text, True) for text in rng.sample(SKIPPED_TEXTS, rng.randint(0, 4))]
    entries += [(text, False) for text in rng.sample(REQUIRED_LOOKALIKES, rng.randint(0, 4))]
    entries += [(text, False) for text in rng.sample(PLAIN_TEXTS, rng.randint(3, 9))]
    if rng.random() < 0.3:
        entries += [(text, False) for text in INVISIBLE_ONLY]
    return entries


def _vectors(draft: Draft) -> dict[str, Any]:
    rng = draft.rng
    visual: dict[str, Any] = {"kind": "vectors"}
    caption = draft.draw(160, optional=True)
    labels = [draft.draw(24, optional=True) for _ in range(rng.randint(1, 6))]
    vectors = [
        {
            "from": [0, 0],
            "to": [index + 1, rng.randint(1, 9)],
            **({"label": label} if label else {}),
        }
        for index, label in enumerate(labels)
    ]
    # Point labels come after all vector labels in the token order.
    points = []
    for _ in range(rng.randint(0, 6)):
        label = draft.draw(24, optional=True)
        points.append({"at": [rng.randint(0, 5), rng.randint(0, 5)], **_opt("label", label)})
    visual["vectors"] = vectors
    if points:
        visual["points"] = points
    return {**visual, **_opt("caption", caption)}


def _plot(draft: Draft) -> dict[str, Any]:
    rng = draft.rng
    caption = draft.draw(160, optional=True)
    x_label = draft.draw(24, optional=True)
    y_label = draft.draw(24, optional=True)
    series = [
        {"points": [[0, 0], [1, 1]], **_opt("label", draft.draw(24, optional=True))}
        for _ in range(rng.randint(1, 3))
    ]
    return {
        "kind": "plot",
        "series": series,
        **_opt("x_label", x_label),
        **_opt("y_label", y_label),
        **_opt("caption", caption),
    }


def _diagram(draft: Draft) -> dict[str, Any]:
    rng = draft.rng
    caption = draft.draw(160, optional=True)
    count = rng.randint(2, 8)
    nodes = []
    for index in range(count):
        label = draft.draw(32)
        detail = draft.draw(70, optional=True)
        nodes.append({"id": f"n{index}", "label": label, **_opt("detail", detail)})
    edges = []
    for _ in range(rng.randint(0, 12)):
        start, end = rng.sample(range(count), 2)
        edges.append(
            {"from": f"n{start}", "to": f"n{end}", **_opt("label", draft.draw(24, optional=True))}
        )
    return {
        "kind": "diagram",
        "layout": rng.choice(["flow", "tree", "cycle"]),
        "nodes": nodes,
        "edges": edges,
        **_opt("caption", caption),
    }


def _table(draft: Draft) -> dict[str, Any]:
    rng = draft.rng
    caption = draft.draw(160, optional=True)
    columns = rng.randint(1, 6)
    headers = [draft.draw(24) for _ in range(columns)]
    rows = [
        [draft.draw(40, allow_empty=True) for _ in range(columns)]
        for _ in range(rng.randint(1, 10))
    ]
    return {"kind": "table", "headers": headers, "rows": rows, **_opt("caption", caption)}


def _formula(draft: Draft) -> dict[str, Any]:
    rng = draft.rng
    caption = draft.draw(160, optional=True)
    expression = draft.draw(80)
    terms = []
    for _ in range(rng.randint(1, 5)):
        symbol = draft.draw(16)
        meaning = draft.draw(80)
        terms.append({"symbol": symbol, "meaning": meaning})
    example = draft.draw(120, optional=True)
    return {
        "kind": "formula",
        "expression": expression,
        "terms": terms,
        **_opt("example", example),
        **_opt("caption", caption),
    }


def _opt(key: str, value: Any) -> dict[str, Any]:
    return {} if value is None else {key: value}


BUILDERS = {
    "vectors": _vectors,
    "plot": _plot,
    "diagram": _diagram,
    "table": _table,
    "formula": _formula,
}


@dataclass
class Case:
    request: CreateAnimationRequest
    kind: str
    # Oracle: strings in token order (title first), with the "skipped" label.
    sources: list[tuple[str, bool]]
    decorations: set[str]


def random_case(seed: int, index: int) -> Case:
    rng = random.Random(f"coverage-{seed}-{index}")
    draft = Draft(rng, _pool(rng))
    kind = rng.choice(KINDS)
    draft.draw(200)
    # The model trims the title like JavaScript `trim()` (which also removes U+FEFF); nothing
    # else is trimmed that way. A title that is only U+FEFF would be empty, so it becomes "T".
    title = js_trim_reference(draft.sources[0][0]) or "T"
    draft.sources[0] = (title, draft.sources[0][1] if title != "T" else False)
    # The caption is drawn first inside each builder, so it follows the title in `sources`.
    visual = BUILDERS[kind](draft)
    request_kind = rng.choice(["lesson", "puzzle"])
    raw: dict[str, Any] = {
        "kind": request_kind,
        "title": title,
        "text": "Seeded text.",
        "visual": visual,
        "language": rng.choice(["en", "id"]),
    }
    if request_kind == "puzzle":
        raw["forbidden_tokens"] = [rng.choice(PLAIN_TEXTS) for _ in range(rng.randint(0, 8))]
    request = CreateAnimationRequest.model_validate(raw)
    return Case(request, kind, draft.sources, draft.decorations)


# --- the oracles --------------------------------------------------------------------------


def source_strings(request: CreateAnimationRequest) -> list[str]:
    """Strings of the title and the text fields of the visual, found by walking the dump."""
    found = [request.title]

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                if key in TEXT_KEYS and isinstance(value, str):
                    found.append(value)
                elif key == "headers":
                    found.extend(value)
                elif key == "rows":
                    found.extend(cell for row in value for cell in row)
                else:
                    walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(request.visual.model_dump(by_alias=True, exclude_none=True))
    return found


def expected_lists(sources: list[tuple[str, bool]]) -> tuple[list[str], list[str]]:
    """Required and skipped lists as Requirement 12.1 and 12.2 define them, from the oracle list."""
    required: list[str] = []
    skipped: list[str] = []
    seen: set[str] = set()
    for text, is_skipped in sources:
        form = reference_normalize(text)
        if form == "" or form in seen:
            continue
        seen.add(form)
        (skipped if is_skipped else required).append(text)
    return required, skipped


def _contract() -> AnimationContract:
    loaded = load_contract()
    assert isinstance(loaded, ContractOk)
    return loaded.contract


def check_case(case: Case) -> None:
    request = case.request
    contract = _contract()
    tokens = derive_tokens(request, contract)
    covered = {reference_normalize(token) for token in tokens.required + tokens.skipped}

    # The property of Requirement 12.6, with sources found by the key walk.
    strings = source_strings(request)
    assert len(strings) >= 1
    for text in strings:
        form = reference_normalize(text)
        if form:
            assert form in covered, (case.kind, text)

    # Nothing is invented, and no normal form appears twice or in both lists.
    forms = [reference_normalize(token) for token in tokens.required + tokens.skipped]
    assert all(forms)
    assert len(set(forms)) == len(forms)
    source_forms = {reference_normalize(text) for text in strings}
    assert set(forms) <= source_forms
    assert set(forms) == source_forms - {""}

    # Each token is a string of the request, written exactly as stored (no trim, no case change).
    assert all(token in strings for token in tokens.required + tokens.skipped)

    # The exact oracle: same strings, same order, same classification.
    expected_required, expected_skipped = expected_lists(case.sources)
    assert sorted(text for text, _ in case.sources) == sorted(strings)
    assert tokens.required == expected_required
    assert tokens.skipped == expected_skipped

    # Public entry points agree with `derive_tokens`, and the request is not changed.
    before = request.model_dump()
    assert required_tokens(request, contract) == tokens.required
    assert request.model_dump() == before

    # Requirement 12.9: at most 68 strings, each at most 200 characters.
    assert len(tokens.required) <= 68
    assert all(len(token) <= 200 for token in tokens.required + tokens.skipped)

    # A forbidden token can never be one of the required ones.
    required_forms = [reference_normalize(token) for token in tokens.required]
    for token in effective_forbidden_tokens(request, tokens.required):
        form = reference_normalize(token)
        assert form
        assert not any(form in required_form for required_form in required_forms)


@pytest.mark.parametrize("seed", range(SEEDS))
def test_every_visible_text_is_covered_by_a_required_or_skipped_token(seed: int) -> None:
    for index in range(REQUESTS_PER_SEED):
        check_case(random_case(seed, index))


# --- guards on the generator and the oracle -----------------------------------------------


def all_cases() -> list[Case]:
    return [random_case(seed, index) for seed in range(SEEDS) for index in range(REQUESTS_PER_SEED)]


def test_the_generator_reaches_every_kind_and_every_tricky_case() -> None:
    cases = all_cases()
    assert {case.kind for case in cases} == set(KINDS)
    assert {case.request.kind for case in cases} == {"lesson", "puzzle"}
    assert set().union(*(case.decorations for case in cases)) == set(DECORATIONS)

    skipped_total = sum(len(derive_tokens(c.request, _contract()).skipped) for c in cases)
    required_total = sum(len(derive_tokens(c.request, _contract()).required) for c in cases)
    assert skipped_total >= 100
    assert required_total >= 1000

    all_sources = [text for case in cases for text, _ in case.sources]
    # Strings that vanish after normalization are present (and so the property has to drop them).
    assert any(reference_normalize(text) == "" for text in all_sources)
    assert any(text == "" for text in all_sources)
    assert any(text.strip("\ufeff") == "" and text for text in all_sources)

    # Dedupe is exercised: some request repeats a normal form in different spellings.
    repeated = 0
    spelled_differently = 0
    for case in cases:
        forms: dict[str, set[str]] = {}
        for text, _ in case.sources:
            form = reference_normalize(text)
            if form:
                forms.setdefault(form, set()).add(text)
        repeated += sum(1 for spellings in forms.values() if len(spellings) >= 2)
        spelled_differently += sum(
            1 for spellings in forms.values() if len({js_trim_reference(s) for s in spellings}) >= 2
        )
    assert repeated >= 100
    assert spelled_differently >= 20

    # The "# fff" / "#fff" pair: same normal form, different class. Both orders happen.
    first_class: set[bool] = set()
    for case in cases:
        by_form: dict[str, list[bool]] = {}
        for text, is_skipped in case.sources:
            by_form.setdefault(reference_normalize(text), []).append(is_skipped)
        for flags in by_form.values():
            if len(set(flags)) == 2:
                first_class.add(flags[0])
    assert first_class == {True, False}

    # Table cells can be empty, headers and labels cannot.
    assert any(c.kind == "table" and any(text == "" for text, _ in c.sources) for c in cases)


def test_the_property_fails_when_a_field_is_forgotten() -> None:
    """The oracle is sharp: dropping any one source string from the tokens breaks coverage."""
    contract = _contract()
    broken = 0
    checked = 0
    for case in all_cases()[:120]:
        tokens = derive_tokens(case.request, contract)
        all_tokens = tokens.required + tokens.skipped
        for removed in range(len(all_tokens)):
            kept = all_tokens[:removed] + all_tokens[removed + 1 :]
            covered = {reference_normalize(token) for token in kept}
            checked += 1
            if any(
                reference_normalize(text) not in covered
                for text in source_strings(case.request)
                if reference_normalize(text)
            ):
                broken += 1
    assert checked > 500
    assert broken == checked


def test_every_kind_has_a_hand_checked_coverage_example() -> None:
    """One request per kind, written by hand, so the walk over the dump is itself checked."""
    cases: list[dict[str, Any]] = [
        {
            "kind": "vectors",
            "caption": "Net force",
            "vectors": [{"from": [0, 0], "to": [2, 1], "label": "F1"}],
            "points": [{"at": [1, 1], "label": "P"}],
        },
        {
            "kind": "plot",
            "x_label": "time",
            "y_label": "speed",
            "series": [{"label": "car", "points": [[0, 0], [1, 2]]}],
        },
        {
            "kind": "diagram",
            "layout": "flow",
            "nodes": [
                {"id": "a", "label": "Input", "detail": "raw data"},
                {"id": "b", "label": "Output"},
            ],
            "edges": [{"from": "a", "to": "b", "label": "process"}],
        },
        {"kind": "table", "headers": ["Name", "Value"], "rows": [["g", "9.8"], ["pi", ""]]},
        {
            "kind": "formula",
            "expression": "v = d / t",
            "terms": [{"symbol": "v", "meaning": "speed"}],
            "example": "10 m / 2 s",
        },
    ]
    expected = [
        ["Net force", "F1", "P"],
        ["time", "speed", "car"],
        ["Input", "raw data", "Output", "process"],
        ["Name", "Value", "g", "9.8", "pi"],
        ["v = d / t", "v", "speed", "10 m / 2 s"],
    ]
    for visual, texts in zip(cases, expected, strict=True):
        request = CreateAnimationRequest.model_validate(
            {"kind": "lesson", "title": "T", "text": "x", "visual": visual, "language": "en"}
        )
        assert sorted(text for text in source_strings(request) if text) == sorted(["T", *texts])
        assert required_tokens(request, _contract()) == ["T", *texts]
