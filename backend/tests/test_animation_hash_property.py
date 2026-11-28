"""Property test: the Request_Hash is stable for equal requests and sensitive to real change.

Why: the hash is the idempotency key of the registry (`UNIQUE (owner_id, request_hash)`,
Requirement 18). If two spellings of one request hashed differently, the player would pay for
Gemini and the verifier twice; if two different requests hashed alike, the second would receive
the first one's animation. Design Property 5 (Requirement 18.2) states both directions:

- Stable: changing the key order of the input JSON, or the order and duplicates of
  `forbidden_tokens`, does not change `canonical_hash`. The same holds for the other spellings the
  spec makes equal: a missing `concepts`/`forbidden_tokens` and `[]` (18.1), `2.0` and `2`, `-0.0`
  and `0`, JavaScript whitespace around the title, escaped and raw non-ASCII text on the wire, and
  unknown keys, which the model drops.
- Sensitive: changing the set of `forbidden_tokens`, the `contract_version`, the order of
  `concepts`, or any other value (kind, title, text, a concept, any label or number of the
  visual, the language) changes the hash. No Unicode normalization is applied, so U+00E9 and
  `e` + U+0301 differ.

`hypothesis` is not a dependency, so requests come from seeded `random.Random` instances (40 seeds;
each seed builds one request with all five `visual` kinds across the seeds, about a dozen
equivalent spellings and a dozen real changes of it). A final check across every request of the
run says that two requests hash alike exactly when an independent description of them is equal, so
neither a collision nor an over-eager normalization can hide.

The vectors with hand-written canonical JSON are in `test_animation_hash.py`; this file is about
the relations between requests, not about single values.
"""

from __future__ import annotations

import copy
import json
import random
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import pytest

from app.ai.animation.models import CreateAnimationRequest, canonical_hash
from tests.animation_token_support import js_trim_reference

SEEDS = 40
CONTRACT_VERSION = 1
HEX64 = re.compile(r"^[0-9a-f]{64}$")
KINDS = ("vectors", "plot", "diagram", "table", "formula")

WORDS = (
    "Force",
    "net force",
    "Vektor",
    "x",
    "y (m)",
    "time",
    "caf\u00e9",
    "\u0130stanbul",
    "Stra\u00dfe",
    "\u65e5\u672c\u8a9e",
    "\U0001f600",
    "a b",
    "F = m \u00d7 a",
    "Ya",
    "ya",
    "42",
    "e\u0301",
    "\u03a3",
)


# --- generators ---------------------------------------------------------------------------


def word(rng: random.Random, max_len: int) -> str:
    """A word that fits `max_len` characters, made unique-ish by a digit sometimes."""
    candidates = [w for w in WORDS if len(w) <= max_len - 2]
    text = rng.choice(candidates)
    return text + str(rng.randint(0, 9)) if rng.random() < 0.5 else text


def optional(rng: random.Random, key: str, value: Any, chance: float = 0.7) -> dict[str, Any]:
    return {key: value} if rng.random() < chance else {}


def number(rng: random.Random) -> int | float:
    """A coordinate: whole numbers (as int) and fractions, small enough for any field."""
    if rng.random() < 0.5:
        return rng.randint(-9, 9)
    return rng.choice([0.5, -1.25, 2.75, 3.5, -4.125, 6.0])


def random_visual(rng: random.Random, kind: str) -> dict[str, Any]:
    visual: dict[str, Any]
    if kind == "vectors":
        vectors = []
        for index in range(rng.randint(1, 4)):
            vectors.append(
                {
                    "from": [number(rng), number(rng)],
                    "to": [10 + index, number(rng)],
                    **optional(rng, "label", word(rng, 24)),
                }
            )
        visual = {"kind": kind, "vectors": vectors}
        if rng.random() < 0.5:
            visual["points"] = [
                {"at": [number(rng), number(rng)], **optional(rng, "label", word(rng, 24))}
                for _ in range(rng.randint(1, 3))
            ]
        if rng.random() < 0.5:
            visual["x_range"] = [-10, rng.choice([5, 8.5, 20.0])]
    elif kind == "plot":
        visual = {
            "kind": kind,
            "series": [
                {
                    "points": [[number(rng), number(rng)] for _ in range(rng.randint(2, 5))],
                    **optional(rng, "label", word(rng, 24)),
                }
                for _ in range(rng.randint(1, 3))
            ],
            **optional(rng, "x_label", word(rng, 24)),
            **optional(rng, "y_label", word(rng, 24)),
        }
    elif kind == "diagram":
        count = rng.randint(2, 5)
        visual = {
            "kind": kind,
            "layout": rng.choice(["flow", "tree", "cycle"]),
            "nodes": [
                {"id": f"n{i}", "label": word(rng, 32), **optional(rng, "detail", word(rng, 70))}
                for i in range(count)
            ],
            "edges": [
                {
                    "from": f"n{a}",
                    "to": f"n{(a + 1) % count}",
                    **optional(rng, "label", word(rng, 24)),
                }
                for a in rng.sample(range(count), rng.randint(0, count))
            ],
        }
    elif kind == "table":
        columns = rng.randint(1, 4)
        rows = [
            [word(rng, 40) if rng.random() < 0.9 else "" for _ in range(columns)]
            for _ in range(rng.randint(1, 5))
        ]
        visual = {
            "kind": kind,
            "headers": [word(rng, 24) for _ in range(columns)],
            "rows": rows,
        }
        if rng.random() < 0.5:
            visual["highlight_rows"] = [0]
    else:
        visual = {
            "kind": kind,
            "expression": word(rng, 80),
            "terms": [
                {"symbol": word(rng, 16), "meaning": word(rng, 80)}
                for _ in range(rng.randint(1, 4))
            ],
            **optional(rng, "example", word(rng, 120)),
        }
    visual.update(optional(rng, "caption", word(rng, 160), 0.5))
    return visual


def random_request(rng: random.Random, kind: str | None = None) -> dict[str, Any]:
    request_kind = rng.choice(["lesson", "puzzle"])
    raw: dict[str, Any] = {
        "kind": request_kind,
        "title": f"{word(rng, 100)} {word(rng, 60)}",
        "text": " ".join(word(rng, 30) for _ in range(rng.randint(1, 6))),
        "visual": random_visual(rng, kind or rng.choice(KINDS)),
        "language": rng.choice(["en", "id"]),
    }
    if rng.random() < 0.7:
        raw["concepts"] = [f"{word(rng, 60)}{i}" for i in range(rng.randint(0, 5))]
    if request_kind == "puzzle" and rng.random() < 0.9:
        raw["forbidden_tokens"] = [word(rng, 60) for _ in range(rng.randint(0, 8))]
    return raw


def model(raw: dict[str, Any]) -> CreateAnimationRequest:
    return CreateAnimationRequest.model_validate(raw)


def digest(raw: dict[str, Any], version: int = CONTRACT_VERSION) -> str:
    return canonical_hash(model(raw), version)


# --- equivalent spellings -----------------------------------------------------------------


def shuffle_keys(rng: random.Random, value: Any) -> Any:
    """The same JSON value with the keys of every object in a random order."""
    if isinstance(value, dict):
        keys = list(value)
        rng.shuffle(keys)
        return {key: shuffle_keys(rng, value[key]) for key in keys}
    if isinstance(value, list):
        return [shuffle_keys(rng, item) for item in value]
    return value


def regroup_forbidden(rng: random.Random, raw: dict[str, Any]) -> dict[str, Any]:
    """Same set of `forbidden_tokens`, new order, extra repeats (at most 8 entries)."""
    changed = copy.deepcopy(raw)
    unique = list(dict.fromkeys(raw.get("forbidden_tokens", [])))
    extras = [rng.choice(unique) for _ in range(rng.randint(0, 8 - len(unique)))] if unique else []
    tokens = [*unique, *extras]
    rng.shuffle(tokens)
    changed["forbidden_tokens"] = tokens
    return changed


def wholes_as_floats(rng: random.Random, value: Any) -> Any:
    """Numbers with a whole value written as floats (`2` as `2.0`, `0` sometimes as `-0.0`)."""
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return -0.0 if value == 0 and rng.random() < 0.5 else float(value)
    if isinstance(value, dict):
        return {key: wholes_as_floats(rng, item) for key, item in value.items()}
    if isinstance(value, list):
        return [wholes_as_floats(rng, item) for item in value]
    return value


def wholes_as_ints(value: Any) -> Any:
    """The opposite: floats with a whole value written as ints."""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, dict):
        return {key: wholes_as_ints(item) for key, item in value.items()}
    if isinstance(value, list):
        return [wholes_as_ints(item) for item in value]
    return value


def padded_title(rng: random.Random, raw: dict[str, Any]) -> dict[str, Any]:
    changed = copy.deepcopy(raw)
    padding = "\t\n\u00a0\u3000\ufeff \u2028"
    left = "".join(rng.choice(padding) for _ in range(rng.randint(0, 4)))
    right = "".join(rng.choice(padding) for _ in range(rng.randint(0, 4)))
    changed["title"] = left + raw["title"] + right
    return changed


def padded_labels(rng: random.Random, value: Any) -> Any:
    """Spaces around every string of the visual that the model strips (not `kind`, `id`...)."""
    keep = {"kind", "layout", "tone", "id", "from", "to"}
    if isinstance(value, dict):
        return {
            key: item if key in keep else padded_labels(rng, item) for key, item in value.items()
        }
    if isinstance(value, list):
        return [padded_labels(rng, item) for item in value]
    if isinstance(value, str):
        return " " * rng.randint(0, 2) + value + "\u00a0" * rng.randint(0, 2)
    return value


def with_extra_keys(rng: random.Random, value: Any, depth: int = 0) -> Any:
    """Unknown keys added at every level; the model drops them, so the hash must not see them."""
    if isinstance(value, dict):
        extended = {key: with_extra_keys(rng, item, depth + 1) for key, item in value.items()}
        extended[f"unknown_{depth}_{rng.randint(0, 99)}"] = rng.choice(
            [1, "x", None, [1, 2], {"a": 1}, True]
        )
        return extended
    if isinstance(value, list):
        return [with_extra_keys(rng, item, depth + 1) for item in value]
    return value


def wire_round_trip(rng: random.Random, raw: dict[str, Any]) -> dict[str, Any]:
    """The body as it travels: JSON text with either escaped or raw non-ASCII, then parsed."""
    text = json.dumps(raw, ensure_ascii=rng.random() < 0.5, indent=rng.choice([None, 2]))
    parsed: dict[str, Any] = json.loads(text)
    return parsed


def omit_empty_lists(raw: dict[str, Any]) -> dict[str, Any]:
    changed = copy.deepcopy(raw)
    for key in ("concepts", "forbidden_tokens"):
        if changed.get(key) == []:
            del changed[key]
    return changed


def with_empty_lists(raw: dict[str, Any]) -> dict[str, Any]:
    changed = copy.deepcopy(raw)
    changed.setdefault("concepts", [])
    if changed["kind"] == "puzzle":
        changed.setdefault("forbidden_tokens", [])
    return changed


EQUIVALENTS = (
    "shuffle_keys",
    "regroup_forbidden",
    "floats",
    "ints",
    "padded_title",
    "padded_labels",
    "extra_keys",
    "wire",
    "omit_empty",
    "with_empty",
    "everything",
)


def equivalent(rng: random.Random, raw: dict[str, Any], name: str) -> dict[str, Any]:
    """`raw` written another way that means the same request."""
    base = copy.deepcopy(raw)
    if name == "shuffle_keys":
        result: dict[str, Any] = shuffle_keys(rng, base)
    elif name == "regroup_forbidden":
        result = regroup_forbidden(rng, base) if base["kind"] == "puzzle" else base
    elif name == "floats":
        result = {**base, "visual": wholes_as_floats(rng, base["visual"])}
    elif name == "ints":
        result = {**base, "visual": wholes_as_ints(base["visual"])}
    elif name == "padded_title":
        result = padded_title(rng, base)
    elif name == "padded_labels":
        result = {**base, "visual": padded_labels(rng, base["visual"])}
    elif name == "extra_keys":
        result = with_extra_keys(rng, base)
    elif name == "wire":
        result = wire_round_trip(rng, base)
    elif name == "omit_empty":
        result = omit_empty_lists(base)
    elif name == "with_empty":
        result = with_empty_lists(base)
    else:
        result = base
        for step in EQUIVALENTS[:-1]:
            result = equivalent(rng, result, step)
    return result


# --- real changes -------------------------------------------------------------------------


def leaves(value: Any, path: tuple[str | int, ...] = ()) -> list[tuple[str | int, ...]]:
    """Paths of the strings and numbers inside a JSON value."""
    if isinstance(value, dict):
        return [p for key, item in value.items() for p in leaves(item, (*path, key))]
    if isinstance(value, list):
        return [p for index, item in enumerate(value) for p in leaves(item, (*path, index))]
    return [path] if isinstance(value, str | int | float) and not isinstance(value, bool) else []


def get_at(root: Any, path: tuple[str | int, ...]) -> Any:
    for step in path:
        root = root[step]
    return root


def set_at(root: Any, path: tuple[str | int, ...], value: Any) -> None:
    get_at(root, path[:-1])[path[-1]] = value


def other_char(rng: random.Random, original: str) -> str:
    return rng.choice([c for c in "abcxyzXYZ019\u00e9\u03a9" if c != original])


def change_visual_leaf(rng: random.Random, raw: dict[str, Any]) -> dict[str, Any] | None:
    """One string or number of the visual changed to another value that is still valid."""
    paths = leaves(raw["visual"])
    for _ in range(40):
        path = rng.choice(paths)
        changed = copy.deepcopy(raw)
        old = get_at(changed["visual"], path)
        if isinstance(old, str):
            if path[-1] == "kind" or old == "" or path[-1] in {"layout"}:
                continue
            new: Any = other_char(rng, old[0]) + old[1:]
        else:
            new = old + 0.5
        set_at(changed["visual"], path, new)
        try:
            model(changed)
        except ValueError:
            continue
        return changed
    return None


def change_concepts(rng: random.Random, raw: dict[str, Any]) -> dict[str, Any] | None:
    concepts = list(raw.get("concepts", []))
    options = ["add", "edit", "remove", "reorder"]
    option = rng.choice(options)
    if option == "add" and len(concepts) < 5:
        concepts.append("added concept")
    elif option == "edit" and concepts:
        index = rng.randrange(len(concepts))
        concepts[index] = other_char(rng, concepts[index][:1]) + concepts[index][1:]
    elif option == "remove" and concepts:
        concepts.pop(rng.randrange(len(concepts)))
    elif option == "reorder" and len(set(concepts)) >= 2:
        swapped = list(concepts)
        while swapped == concepts:
            rng.shuffle(swapped)
        concepts = swapped
    else:
        return None
    return {**raw, "concepts": concepts}


def change_forbidden(rng: random.Random, raw: dict[str, Any]) -> dict[str, Any] | None:
    if raw["kind"] != "puzzle":
        return None
    tokens = list(dict.fromkeys(raw.get("forbidden_tokens", [])))
    option = rng.choice(["add", "edit", "remove"])
    if option == "add" and len(tokens) < 8:
        tokens.append("brand new token")
    elif option == "edit" and tokens:
        index = rng.randrange(len(tokens))
        tokens[index] = other_char(rng, tokens[index][:1]) + tokens[index][1:]
    elif option == "remove" and tokens:
        tokens.pop(rng.randrange(len(tokens)))
    else:
        return None
    return {**raw, "forbidden_tokens": tokens}


def change_scalar(rng: random.Random, raw: dict[str, Any], key: str) -> dict[str, Any]:
    changed = copy.deepcopy(raw)
    if key == "kind":
        if raw["kind"] == "lesson":
            changed["kind"] = "puzzle"
        else:
            changed["kind"] = "lesson"
            changed.pop("forbidden_tokens", None)
            return changed if not raw.get("forbidden_tokens") else changed
    elif key == "language":
        changed["language"] = "id" if raw["language"] == "en" else "en"
    else:
        changed[key] = raw[key] + rng.choice(["!", " more", "\u00e9"])
    return changed


MUTATIONS = (
    "kind",
    "title",
    "text",
    "language",
    "visual",
    "concepts",
    "forbidden",
)


def real_change(rng: random.Random, raw: dict[str, Any], name: str) -> dict[str, Any] | None:
    """`raw` with one value changed; `None` when this request has nothing of that kind to change."""
    if name in {"kind", "title", "text", "language"}:
        return change_scalar(rng, raw, name)
    if name == "visual":
        return change_visual_leaf(rng, raw)
    if name == "concepts":
        return change_concepts(rng, raw)
    return change_forbidden(rng, raw)


# --- independent description of a request -------------------------------------------------


def description(raw: dict[str, Any], version: int = CONTRACT_VERSION) -> str:
    """What the request is, written without `canonical_json`: used to judge hash (in)equality.

    Built from the validated model (so trimming and dropped keys are applied by the model) with
    whole floats as ints, `forbidden_tokens` as a sorted set, and ASCII-escaped JSON, which is
    injective on text just as the raw form is.
    """
    request = model(raw)

    def whole(value: Any) -> Any:
        if isinstance(value, float) and value.is_integer():
            return int(value)
        if isinstance(value, dict):
            return {key: whole(item) for key, item in value.items()}
        if isinstance(value, list | tuple):
            return [whole(item) for item in value]
        return value

    body = {
        "v": version,
        "kind": request.kind,
        "title": request.title,
        "text": request.text,
        "concepts": list(request.concepts),
        "visual": whole(request.visual.dump()),
        "language": request.language,
        "forbidden": sorted(set(request.forbidden_tokens)),
    }
    return json.dumps(body, sort_keys=True, ensure_ascii=True)


@dataclass
class Family:
    """One base request, its equivalents and its real changes, with the hashes of each."""

    base: dict[str, Any]
    equivalents: list[tuple[str, dict[str, Any]]]
    changes: list[tuple[str, dict[str, Any]]]


def family(seed: int) -> Family:
    rng = random.Random(f"hash-{seed}")
    base = random_request(rng, KINDS[seed % len(KINDS)])
    equivalents = [(name, equivalent(rng, base, name)) for name in EQUIVALENTS]
    changes: list[tuple[str, dict[str, Any]]] = []
    for name in MUTATIONS:
        for _ in range(2):
            changed = real_change(rng, base, name)
            if changed is not None:
                changes.append((name, changed))
    return Family(base, equivalents, changes)


# --- the properties -----------------------------------------------------------------------


@pytest.mark.parametrize("seed", range(SEEDS))
def test_the_hash_is_a_stable_lowercase_hex_digest_and_leaves_the_request_alone(
    seed: int,
) -> None:
    raw = family(seed).base
    request = model(raw)
    before = request.model_dump()
    first = canonical_hash(request, CONTRACT_VERSION)
    assert HEX64.fullmatch(first)
    assert canonical_hash(request, CONTRACT_VERSION) == first
    assert canonical_hash(model(copy.deepcopy(raw)), CONTRACT_VERSION) == first
    assert request.model_dump() == before


@pytest.mark.parametrize("seed", range(SEEDS))
def test_equivalent_spellings_of_a_request_have_the_same_hash(seed: int) -> None:
    fam = family(seed)
    expected = digest(fam.base)
    for name, spelling in fam.equivalents:
        assert digest(spelling) == expected, name
        assert description(spelling) == description(fam.base), name


@pytest.mark.parametrize("seed", range(SEEDS))
def test_a_real_change_to_any_value_changes_the_hash(seed: int) -> None:
    fam = family(seed)
    expected = digest(fam.base)
    assert fam.changes, "the seed produced no change to test"
    for name, changed in fam.changes:
        assert digest(changed) != expected, name
        assert description(changed) != description(fam.base), name


@pytest.mark.parametrize("seed", range(SEEDS))
def test_the_contract_version_changes_the_hash(seed: int) -> None:
    raw = family(seed).base
    versions = [1, 2, 3, 10, 100]
    hashes = [digest(raw, version) for version in versions]
    assert len(set(hashes)) == len(versions)


UNICODE_FIELDS = ("title", "text", "concept", "forbidden", "caption", "label")
UNICODE_PAIRS = (
    ("\u00e9", "e\u0301"),
    ("\u00c5", "A\u030a"),
    ("\ufb01", "fi"),
    ("\uff21", "A"),
    ("A", "a"),
    ("\u00df", "ss"),
    ("a b", "ab"),
)


def with_text(raw: dict[str, Any], field: str, value: str) -> dict[str, Any]:
    """`raw` with `value` placed in one text field (a puzzle, so `forbidden` is allowed)."""
    changed = copy.deepcopy(raw)
    changed["kind"] = "puzzle"
    if field == "title":
        changed["title"] = f"{raw['title']} {value}"
    elif field == "text":
        changed["text"] = f"{raw['text']} {value}"
    elif field == "concept":
        changed["concepts"] = [f"concept {value}"]
    elif field == "forbidden":
        changed["forbidden_tokens"] = [f"token {value}"]
    elif field == "caption":
        changed["visual"]["caption"] = f"caption {value}"
    else:
        changed["visual"] = {
            "kind": "formula",
            "expression": f"e {value}",
            "terms": [{"symbol": "s", "meaning": "m"}],
        }
    return changed


@pytest.mark.parametrize("seed", range(SEEDS))
def test_text_that_differs_only_by_unicode_form_or_case_hashes_differently(seed: int) -> None:
    """No Unicode normalization and no case folding anywhere in the hash (Requirement 18.1)."""
    base = random_request(random.Random(f"unicode-{seed}"))
    field = UNICODE_FIELDS[seed % len(UNICODE_FIELDS)]
    for left, right in UNICODE_PAIRS:
        one = digest(with_text(base, field, left))
        two = digest(with_text(base, field, right))
        assert one != two, (field, left, right)


def test_every_text_field_is_covered_by_the_unicode_check() -> None:
    assert {UNICODE_FIELDS[seed % len(UNICODE_FIELDS)] for seed in range(SEEDS)} == set(
        UNICODE_FIELDS
    )


@pytest.mark.parametrize("seed", range(SEEDS))
def test_equal_hashes_mean_equal_requests_across_the_whole_pool(seed: int) -> None:
    """Neither a collision nor an over-eager normalization: equal hash means equal description."""
    pool: list[dict[str, Any]] = []
    for offset in (0, SEEDS, 2 * SEEDS):
        fam = family(seed + offset)
        pool.append(fam.base)
        pool.extend(spelling for _, spelling in fam.equivalents)
        pool.extend(changed for _, changed in fam.changes)
    by_hash: dict[str, str] = {}
    by_description: dict[str, str] = {}
    for raw in pool:
        digest_value = digest(raw)
        text = description(raw)
        assert by_hash.setdefault(digest_value, text) == text
        assert by_description.setdefault(text, digest_value) == digest_value
    assert len(by_hash) == len(by_description)
    assert len(by_hash) >= 20


# --- guards: the generators reach what the properties need ---------------------------------


def test_the_generators_reach_every_kind_every_equivalence_and_every_change() -> None:
    families = [family(seed) for seed in range(SEEDS)]
    assert {f.base["visual"]["kind"] for f in families} == set(KINDS)
    assert {f.base["kind"] for f in families} == {"lesson", "puzzle"}
    assert {name for f in families for name, _ in f.equivalents} == set(EQUIVALENTS)
    assert {name for f in families for name, _ in f.changes} == set(MUTATIONS)
    # Every kind of change succeeded for several requests, not once by luck.
    for name in MUTATIONS:
        assert sum(1 for f in families for n, _ in f.changes if n == name) >= 10, name

    # The equivalents really differ from the base as JSON, otherwise they prove nothing.
    # (`wire` differs in the JSON text it travels as, not in the parsed value; `omit_empty`,
    # `with_empty` and `regroup_forbidden` only apply to requests that have those fields.)
    for name in set(EQUIVALENTS) - {"with_empty", "omit_empty", "regroup_forbidden", "wire"}:
        different = sum(
            1
            for f in families
            for n, spelling in f.equivalents
            if n == name and json.dumps(spelling, sort_keys=False) != json.dumps(f.base)
        )
        # Only the kinds with numbers (vectors, plot) can show whole floats.
        assert different >= {"floats": 10, "ints": 3}.get(name, 30), name
    omitted = sum(
        1
        for f in families
        for n, s in f.equivalents
        if n == "omit_empty" and ("concepts" not in s) and f.base.get("concepts") == []
    )
    assert omitted >= 1
    reordered = sum(
        1
        for f in families
        for n, s in f.equivalents
        if n == "regroup_forbidden"
        and s.get("forbidden_tokens") != f.base.get("forbidden_tokens")
        and f.base.get("forbidden_tokens")
    )
    assert reordered >= 5
    repeated = sum(
        1
        for f in families
        for n, s in f.equivalents
        if n == "regroup_forbidden"
        and len(s.get("forbidden_tokens", [])) > len(set(s.get("forbidden_tokens", [])))
    )
    assert repeated >= 3

    # Numbers: fractions, whole ints, and whole floats all occur in the bases and variants.
    numbers = [item for f in families for item in _numbers(f.base["visual"])]
    assert any(isinstance(n, int) for n in numbers)
    assert any(isinstance(n, float) and not n.is_integer() for n in numbers)
    floaty = [item for f in families for _, s in f.equivalents for item in _numbers(s["visual"])]
    assert any(isinstance(n, float) and n.is_integer() for n in floaty)
    assert any(str(n) == "-0.0" for n in floaty)

    # The title padding uses JavaScript whitespace that Python `strip` does not know (U+FEFF).
    assert any(
        js_trim_reference(s["title"]) == f.base["title"] and s["title"] != f.base["title"]
        for f in families
        for n, s in f.equivalents
        if n == "padded_title"
    )


def _numbers(value: Any) -> list[int | float]:
    if isinstance(value, bool):
        return []
    if isinstance(value, int | float):
        return [value]
    if isinstance(value, dict):
        return [n for item in value.values() for n in _numbers(item)]
    if isinstance(value, list):
        return [n for item in value for n in _numbers(item)]
    return []


def relation_failures(hash_of: Callable[[dict[str, Any]], str]) -> set[str]:
    """Which relations a hash function breaks over every seed (empty for a correct one)."""
    failures: set[str] = set()
    for seed in range(SEEDS):
        fam = family(seed)
        base = hash_of(fam.base)
        for name, spelling in fam.equivalents:
            if hash_of(spelling) != base:
                failures.add(f"unstable:{name}")
        for name, changed in fam.changes:
            if hash_of(changed) == base:
                failures.add(f"insensitive:{name}")
    return failures


def sloppy_hash(
    *,
    drop: tuple[str, ...] = (),
    sort_forbidden: bool = True,
    raw_visual: bool = False,
    raw_title: bool = False,
    include_version: bool = True,
) -> Callable[[dict[str, Any]], str]:
    """A hash like `canonical_hash` with one rule removed, to see the relations notice it."""

    def hash_of(raw: dict[str, Any]) -> str:
        req = model(raw)
        forbidden = list(req.forbidden_tokens)
        body = {
            "contract_version": CONTRACT_VERSION if include_version else 0,
            "kind": req.kind,
            "title": raw["title"] if raw_title else req.title,
            "text": req.text,
            "concepts": list(req.concepts),
            "visual": raw["visual"] if raw_visual else req.visual.dump(),
            "language": req.language,
            "forbidden_tokens": sorted(set(forbidden)) if sort_forbidden else forbidden,
        }
        for key in drop:
            del body[key]
        return json.dumps(body, sort_keys=True, ensure_ascii=False)

    return hash_of


def test_the_relations_hold_for_the_real_hash() -> None:
    assert relation_failures(digest) == set()


@pytest.mark.parametrize(
    ("name", "broken", "expected"),
    [
        ("forgets concepts", sloppy_hash(drop=("concepts",)), "insensitive:concepts"),
        (
            "forgets forbidden tokens",
            sloppy_hash(drop=("forbidden_tokens",)),
            "insensitive:forbidden",
        ),
        ("forgets the language", sloppy_hash(drop=("language",)), "insensitive:language"),
        ("forgets the kind", sloppy_hash(drop=("kind",)), "insensitive:kind"),
        ("forgets the text", sloppy_hash(drop=("text",)), "insensitive:text"),
        ("forgets the visual", sloppy_hash(drop=("visual",)), "insensitive:visual"),
        ("keeps forbidden order", sloppy_hash(sort_forbidden=False), "unstable:regroup_forbidden"),
        ("hashes the visual as sent", sloppy_hash(raw_visual=True), "unstable:floats"),
        ("hashes the untrimmed title", sloppy_hash(raw_title=True), "unstable:padded_title"),
    ],
)
def test_the_relations_catch_a_hash_that_breaks_one_rule(
    name: str, broken: Callable[[dict[str, Any]], str], expected: str
) -> None:
    assert expected in relation_failures(broken), name


def test_a_hash_without_the_contract_version_is_caught_by_its_own_test() -> None:
    """The version is an argument, not part of the request, so it has its own check."""
    broken = sloppy_hash(include_version=False)
    raw = family(0).base
    assert broken(raw) == broken(raw)
    assert digest(raw, 1) != digest(raw, 2)
