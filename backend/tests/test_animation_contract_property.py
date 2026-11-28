"""Property test: reading the animation contract is total (Property 1, backend side).

Why: design Property 1 says that for any JSON value used as the contract content, the readers
answer `{ok: true}` or `{ok: false}` and never raise (Requirements 2.10, 2.11, 38.3). A
reader that raised would turn a damaged contract file into a 500 instead of the 503
`ANIMATION_NOT_CONFIGURED` the endpoint promises. The Python side is `parse_contract` (a parsed
value), `read_contract_file` (text on disk) and `load_contract` (the cached file next to the
module); all three are driven here.

`hypothesis` is not a dependency (no network, no lockfile), so the generators are seeded
`random.Random(seed)` instances over 40 seeds, the pattern of `test_ai_chunking.py`. Each seed
builds four kinds of input:

- arbitrary JSON (any depth, any type), which can never be a contract;
- the shipped contract with one to three random edits (delete, replace, wrong type, number
  nudge, truncate), judged by an oracle written here that knows only the necessary conditions of
  Requirement 2.11 and not the Pydantic model: an input that breaks one must be rejected, and an
  accepted input must satisfy all of them;
- the shipped contract with one rule broken on purpose, which must be rejected with a reason that
  names the field;
- the shipped contract changed in a way the rules allow (unknown keys, whole floats, key order,
  more supported versions), which must be accepted.

`test_the_generators_reach_every_branch` keeps these from passing because a generator never
produced the interesting cases.
"""

from __future__ import annotations

import copy
import json
import math
import random
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest

from app.ai.animation import contract as contract_module
from app.ai.animation.contract import (
    CONTRACT_FILE_NAME,
    ContractInvalid,
    ContractOk,
    ContractResult,
    load_contract,
    parse_contract,
    read_contract_file,
)

SEEDS = 40
MUTANTS_PER_SEED = 6
SHIPPED = Path(contract_module.__file__).with_name(CONTRACT_FILE_NAME)

Path_ = tuple[str | int, ...]


def _shipped() -> dict[str, Any]:
    return json.loads(SHIPPED.read_text(encoding="utf-8"))


FIELD_NAMES = list(_shipped())
WHOLE_NUMBER_PATHS: list[Path_] = [
    ("contract_version",),
    ("canvas", "width"),
    ("canvas", "height"),
    ("canvas", "fps"),
    ("duration", "min"),
    ("duration", "max"),
    *(("limits", name) for name in _shipped()["limits"]),
]


# --- generators ---------------------------------------------------------------------------

STRINGS = ("", " ", "x", "main.ts", "1280", "\u00e9", "\u0130", "\ud800", "a\nb", "\x00", "{}")
NUMBERS: tuple[int | float, ...] = (0, 1, -1, 2, 30, 1280, 2**53, 2**63, 10**30, -(10**30))
FLOATS = (0.0, -0.0, 1.0, 1280.0, 1.5, -2.5, 1e-9, 1e308, 2.0**53)


def random_json(rng: random.Random, depth: int = 0) -> Any:
    """Any JSON value: every scalar type, and arrays and objects up to depth 4."""
    kinds = ["null", "bool", "int", "float", "str"]
    if depth < 4:
        kinds += ["list", "dict", "list", "dict"]
    kind = rng.choice(kinds)
    if kind == "null":
        return None
    if kind == "bool":
        return rng.random() < 0.5
    if kind == "int":
        return rng.choice(NUMBERS)
    if kind == "float":
        return rng.choice(FLOATS)
    if kind == "str":
        return rng.choice(STRINGS)
    if kind == "list":
        return [random_json(rng, depth + 1) for _ in range(rng.randint(0, 4))]
    keys = [*FIELD_NAMES, "a", "", "\u00e9", "contract_version"]
    return {rng.choice(keys): random_json(rng, depth + 1) for _ in range(rng.randint(0, 4))}


def json_type(value: object) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, int | float):
        return "number"
    if isinstance(value, str):
        return "str"
    return "list" if isinstance(value, list) else "dict"


def get_at(root: Any, path: Path_) -> Any:
    for step in path:
        root = root[step]
    return root


def set_at(root: Any, path: Path_, value: Any) -> None:
    get_at(root, path[:-1])[path[-1]] = value


def delete_at(root: Any, path: Path_) -> None:
    parent = get_at(root, path[:-1])
    if isinstance(parent, dict):
        del parent[path[-1]]
    else:
        del parent[int(path[-1])]


def random_path(rng: random.Random, raw: Any) -> Path_:
    """A random walk from the root: pick a child, then go deeper with probability 0.6.

    Uniform choice over all paths would almost always land inside the 148-entry colour list;
    walking from the top reaches the structural fields (`canvas.fps`, `limits.*`) as often as
    the free-form lists.
    """
    path: Path_ = ()
    node = raw
    while True:
        children = list(node) if isinstance(node, dict) else list(range(len(node)))
        if not children:
            return path
        step = rng.choice(children)
        path = (*path, step)
        node = node[step]
        if not isinstance(node, dict | list) or rng.random() >= 0.6:
            return path


OPERATIONS = ("delete", "replace", "wrong_type", "nudge", "truncate")


def mutate_once(rng: random.Random, raw: dict[str, Any], used: set[str]) -> None:
    """One random edit of `raw`, in place. `used` collects the operation names."""
    path = random_path(rng, raw)
    old = get_at(raw, path)
    operation = rng.choice(OPERATIONS)
    used.add(operation)
    if operation == "delete":
        delete_at(raw, path)
    elif operation == "replace":
        set_at(raw, path, random_json(rng))
    elif operation == "wrong_type":
        while True:
            candidate = random_json(rng)
            if json_type(candidate) != json_type(old):
                break
        set_at(raw, path, candidate)
    elif operation == "nudge":
        if json_type(old) == "number":
            set_at(raw, path, rng.choice([old + 1, old - 1, -old, 0, old * 2, 0.5]))
        else:
            set_at(raw, path, random_json(rng))
    elif isinstance(old, list):
        set_at(raw, path, old[:-1])
    elif isinstance(old, str):
        set_at(raw, path, "")
    else:
        set_at(raw, path, [])


def mutated_contract(seed: int) -> tuple[dict[str, Any], set[str]]:
    rng = random.Random(f"mutated-{seed}")
    raw = _shipped()
    used: set[str] = set()
    for _ in range(rng.randint(1, 3)):
        mutate_once(rng, raw, used)
    return raw, used


def deep(depth: int, leaf: Any = 1) -> Any:
    """`[[[...leaf...]]]` nested `depth` times, built without recursion."""
    node = leaf
    for _ in range(depth):
        node = [node]
    return node


# Rules the contract must enforce, each as (name, edit that breaks only that rule). The edit
# draws its bad value from `rng` so the 40 seeds try different values.
BAD_NUMBERS: tuple[Any, ...] = (0, -1, -(10**30), 1.5, "1", "", True, False, None, [], {}, [1])


def _break_number(path: Path_) -> Callable[[random.Random, dict[str, Any]], str]:
    def apply(rng: random.Random, raw: dict[str, Any]) -> str:
        set_at(raw, path, rng.choice(BAD_NUMBERS))
        return ".".join(map(str, path))

    return apply


def _remove_field(rng: random.Random, raw: dict[str, Any]) -> str:
    name = rng.choice(FIELD_NAMES)
    del raw[name]
    return name


def _min_above_max(rng: random.Random, raw: dict[str, Any]) -> str:
    raw["duration"]["min"] = raw["duration"]["max"] + rng.randint(1, 10_000)
    return "duration"


def _max_below_min(rng: random.Random, raw: dict[str, Any]) -> str:
    raw["duration"]["max"] = raw["duration"]["min"] - rng.randint(1, 29)
    return "duration"


def _version_not_supported(rng: random.Random, raw: dict[str, Any]) -> str:
    raw["contract_version"] = rng.randint(2, 50)
    return "supported_runtime_contract_versions"


def _supported_without_version(rng: random.Random, raw: dict[str, Any]) -> str:
    raw["supported_runtime_contract_versions"] = [
        rng.randint(2, 9) for _ in range(rng.randint(1, 4))
    ]
    return "supported_runtime_contract_versions"


def _supported_empty(rng: random.Random, raw: dict[str, Any]) -> str:
    raw["supported_runtime_contract_versions"] = rng.choice([[], {}, "", None, "1"])
    return "supported_runtime_contract_versions"


def _wrong_count(field: str, good: int) -> Callable[[random.Random, dict[str, Any]], str]:
    def apply(rng: random.Random, raw: dict[str, Any]) -> str:
        count = rng.choice([n for n in range(0, 21) if n != good])
        raw[field] = [f"T{n}" for n in range(count)]
        return field

    return apply


def _prefixes_without_agent(rng: random.Random, raw: dict[str, Any]) -> str:
    raw["diagnostic_code_prefixes"] = [f"P{n}" for n in range(11)]
    return "AGENT"


def _object_field_not_an_object(rng: random.Random, raw: dict[str, Any]) -> str:
    name = rng.choice(["canvas", "duration", "limits", "allowed_imports", "required_exports"])
    raw[name] = rng.choice([[], "x", 0, None, True, [1, 2, 3]])
    return name


def _not_a_pause_rule(rng: random.Random, raw: dict[str, Any]) -> str:
    raw["pause_rules"][rng.choice(["lesson", "puzzle"])] = rng.choice(["maybe", "", 1, None])
    return "pause_rules"


BREAKERS: dict[str, Callable[[random.Random, dict[str, Any]], str]] = {
    **{f"number:{'.'.join(map(str, p))}": _break_number(p) for p in WHOLE_NUMBER_PATHS},
    "remove-field": _remove_field,
    "min-above-max": _min_above_max,
    "max-below-min": _max_below_min,
    "version-not-supported": _version_not_supported,
    "supported-without-version": _supported_without_version,
    "supported-empty": _supported_empty,
    "color-token-count": _wrong_count("color_tokens", 9),
    "prefix-count": _wrong_count("diagnostic_code_prefixes", 11),
    "no-agent-prefix": _prefixes_without_agent,
    "object-not-object": _object_field_not_an_object,
    "pause-rule": _not_a_pause_rule,
}
BREAKER_NAMES = sorted(BREAKERS)


def broken_contract(seed: int) -> tuple[dict[str, Any], str, str]:
    """The shipped contract with one rule broken: (raw, breaker name, text the reason names)."""
    rng = random.Random(f"broken-{seed}")
    name = BREAKER_NAMES[seed % len(BREAKER_NAMES)]  # 40 seeds cover all 27 rules at least once
    raw = _shipped()
    named = BREAKERS[name](rng, raw)
    return raw, name, named


def _add_unknown_keys(rng: random.Random, raw: dict[str, Any]) -> str:
    # Not `allowed_imports`: there every key is a module name and must hold import lists.
    holders = [raw, *[v for k, v in raw.items() if isinstance(v, dict) and k != "allowed_imports"]]
    for _ in range(rng.randint(1, 4)):
        rng.choice(holders)[rng.choice(["extra", "_", "\u00e9", "x" * 40])] = random_json(rng)
    return "unknown-keys"


def _whole_floats(rng: random.Random, raw: dict[str, Any]) -> str:
    for path in rng.sample(WHOLE_NUMBER_PATHS, rng.randint(1, len(WHOLE_NUMBER_PATHS))):
        set_at(raw, path, float(get_at(raw, path)))
    raw["supported_runtime_contract_versions"] = [
        float(v) for v in raw["supported_runtime_contract_versions"]
    ]
    return "whole-floats"


def _shuffled_keys(rng: random.Random, raw: dict[str, Any]) -> str:
    def shuffle(node: Any) -> Any:
        if isinstance(node, dict):
            items = [(key, shuffle(value)) for key, value in node.items()]
            rng.shuffle(items)
            return dict(items)
        return node

    shuffled = shuffle(raw)
    raw.clear()
    raw.update(shuffled)
    return "shuffled-keys"


def _more_supported_versions(rng: random.Random, raw: dict[str, Any]) -> str:
    extra = [rng.randint(1, 9) for _ in range(rng.randint(1, 5))]
    versions = [*raw["supported_runtime_contract_versions"], *extra]
    rng.shuffle(versions)
    raw["supported_runtime_contract_versions"] = versions
    return "more-supported-versions"


def _newer_version_supported(rng: random.Random, raw: dict[str, Any]) -> str:
    version = rng.randint(2, 99)
    raw["contract_version"] = version
    raw["supported_runtime_contract_versions"] = [1, version]
    return "newer-version"


def _larger_numbers(rng: random.Random, raw: dict[str, Any]) -> str:
    for path in WHOLE_NUMBER_PATHS[1:]:
        set_at(raw, path, get_at(raw, path) + rng.randint(0, 1000))
    raw["duration"]["max"] = raw["duration"]["min"] + rng.randint(0, 1000)
    return "larger-numbers"


ALLOWED_CHANGES: dict[str, Callable[[random.Random, dict[str, Any]], str]] = {
    "unknown-keys": _add_unknown_keys,
    "whole-floats": _whole_floats,
    "shuffled-keys": _shuffled_keys,
    "more-supported-versions": _more_supported_versions,
    "newer-version": _newer_version_supported,
    "larger-numbers": _larger_numbers,
}


def allowed_contract(seed: int) -> tuple[dict[str, Any], list[str]]:
    rng = random.Random(f"allowed-{seed}")
    raw = _shipped()
    names = rng.sample(sorted(ALLOWED_CHANGES), rng.randint(1, 3))
    for name in names:
        ALLOWED_CHANGES[name](rng, raw)
    return raw, names


# --- the oracle (Requirement 2.11, written without the Pydantic model) ----------------------


def is_whole(value: object) -> bool:
    """A JSON number with no fraction. `true` is not a number; 1280.0 is the whole 1280."""
    if isinstance(value, bool):
        return False
    return isinstance(value, int) or (isinstance(value, float) and value.is_integer())


def positive(value: object) -> bool:
    return is_whole(value) and value >= 1  # type: ignore[operator]


def violations(raw: object) -> list[str]:
    """Necessary conditions of Requirement 2.11 that `raw` breaks. Empty does not mean valid."""
    if not isinstance(raw, dict):
        return ["root is not an object"]
    found = [f"{name} is missing" for name in FIELD_NAMES if name not in raw]
    version = raw.get("contract_version")
    if not positive(version):
        found.append("contract_version")
    supported = raw.get("supported_runtime_contract_versions")
    if not isinstance(supported, list) or not supported:
        found.append("supported_runtime_contract_versions")
    elif not all(positive(v) for v in supported):
        found.append("supported_runtime_contract_versions items")
    elif positive(version) and version not in supported:
        found.append("supported_runtime_contract_versions lacks contract_version")
    for name in ("canvas", "duration"):
        if not isinstance(raw.get(name), dict):
            found.append(f"{name} is not an object")
    canvas = raw.get("canvas") if isinstance(raw.get("canvas"), dict) else {}
    found += [
        f"canvas.{key}" for key in ("width", "height", "fps") if not positive(canvas.get(key))
    ]
    duration = raw.get("duration") if isinstance(raw.get("duration"), dict) else {}
    low, high = duration.get("min"), duration.get("max")
    found += [f"duration.{key}" for key, v in (("min", low), ("max", high)) if not positive(v)]
    if positive(low) and positive(high) and low > high:
        found.append("duration min is above max")
    tokens = raw.get("color_tokens")
    if "color_tokens" in raw and (not isinstance(tokens, list) or len(tokens) != 9):
        found.append("color_tokens")
    prefixes = raw.get("diagnostic_code_prefixes")
    if "diagnostic_code_prefixes" in raw and (
        not isinstance(prefixes, list) or len(prefixes) != 11 or "AGENT" not in prefixes
    ):
        found.append("diagnostic_code_prefixes")
    return found


def check_accepted(result: ContractOk, raw: dict[str, Any]) -> None:
    """An accepted contract satisfies every condition of Requirement 2.11, with whole ints."""
    contract = result.contract
    assert result.ok is True
    assert violations(raw) == []
    assert type(contract.contract_version) is int
    assert contract.contract_version >= 1
    assert contract.contract_version in contract.supported_runtime_contract_versions
    assert all(type(v) is int and v >= 1 for v in contract.supported_runtime_contract_versions)
    for size in (contract.canvas.width, contract.canvas.height, contract.canvas.fps):
        assert type(size) is int
        assert size >= 1
    assert 1 <= contract.duration.min <= contract.duration.max
    assert len(contract.color_tokens) == 9
    assert len(contract.diagnostic_code_prefixes) == 11
    assert "AGENT" in contract.diagnostic_code_prefixes
    # The model keeps what the file said, with whole floats read as ints.
    assert contract.contract_version == raw["contract_version"]
    assert contract.canvas.width == raw["canvas"]["width"]
    assert contract.duration.max == raw["duration"]["max"]
    assert contract.file_name == raw["file_name"]


def check_rejected(result: ContractResult) -> str:
    """A rejection carries a short, non-empty reason and the `ok` flag a caller branches on."""
    assert isinstance(result, ContractInvalid)
    assert result.ok is False
    assert isinstance(result.reason, str)
    assert result.reason.strip()
    # At most five `path: message` items plus one "+N more", so `;` separates at most six parts.
    # The five is written out here on purpose: importing the module's constant would let a
    # change of that constant move the bound with it.
    assert result.reason.count(";") <= 5
    assert len(result.reason) <= 1500
    return result.reason


def check_result(result: ContractResult, raw: object) -> bool:
    """The totality promise: exactly one of the two shapes. Returns whether it was accepted."""
    assert isinstance(result, ContractOk | ContractInvalid)
    if isinstance(result, ContractOk):
        assert isinstance(raw, dict)
        check_accepted(result, raw)
        return True
    check_rejected(result)
    return False


# --- three ways to read the same value ----------------------------------------------------


@pytest.fixture
def use_contract_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[Callable[[str], Path]]:
    """Point `load_contract` at a temp file with the given text and reset its cache."""
    path = tmp_path / CONTRACT_FILE_NAME

    def use(text: str) -> Path:
        path.write_text(text, encoding="utf-8")
        monkeypatch.setattr(contract_module, "CONTRACT_PATH", path)
        load_contract.cache_clear()
        return path

    load_contract.cache_clear()
    yield use
    load_contract.cache_clear()


def read_three_ways(
    raw: object, use: Callable[[str], Path], note: Callable[[ContractResult], None]
) -> list[ContractResult]:
    """`parse_contract`, `read_contract_file` and `load_contract` on one JSON value."""
    text = json.dumps(raw, ensure_ascii=True)
    path = use(text)
    results = [parse_contract(json.loads(text)), read_contract_file(path), load_contract()]
    for result in results:
        note(result)
    return results


def assert_same_verdict(results: list[ContractResult]) -> None:
    assert len({type(result) for result in results}) == 1
    assert len({getattr(result, "reason", None) for result in results}) == 1


# --- the properties -----------------------------------------------------------------------


@pytest.mark.parametrize("seed", range(SEEDS))
def test_arbitrary_json_is_always_answered_and_is_never_a_contract(
    seed: int, use_contract_file: Callable[[str], Path]
) -> None:
    rng = random.Random(f"arbitrary-{seed}")
    for _ in range(MUTANTS_PER_SEED):
        raw = random_json(rng)
        before = copy.deepcopy(raw)
        results = read_three_ways(raw, use_contract_file, lambda _result: None)
        assert raw == before
        for result in results:
            reason = check_rejected(result)
            assert reason == check_rejected(results[0])
        assert_same_verdict(results)
        assert violations(raw), "arbitrary JSON must break at least one rule"


@pytest.mark.parametrize("seed", range(SEEDS))
def test_a_randomly_edited_contract_is_judged_by_the_necessary_conditions(
    seed: int, use_contract_file: Callable[[str], Path]
) -> None:
    raw, _ = mutated_contract(seed)
    before = copy.deepcopy(raw)
    verdicts: list[bool] = []

    def note(result: ContractResult) -> None:
        verdicts.append(check_result(result, raw))

    results = read_three_ways(raw, use_contract_file, note)
    assert raw == before
    assert_same_verdict(results)
    assert len(set(verdicts)) == 1
    if violations(raw):
        assert verdicts[0] is False, violations(raw)


@pytest.mark.parametrize("seed", range(SEEDS))
def test_a_contract_with_one_rule_broken_is_rejected_and_the_reason_names_it(
    seed: int, use_contract_file: Callable[[str], Path]
) -> None:
    raw, breaker, named = broken_contract(seed)
    results = read_three_ways(raw, use_contract_file, lambda _result: None)
    assert_same_verdict(results)
    reason = check_rejected(results[0])
    assert named in reason, (breaker, reason)


@pytest.mark.parametrize("seed", range(SEEDS))
def test_a_contract_changed_only_in_allowed_ways_is_accepted(
    seed: int, use_contract_file: Callable[[str], Path]
) -> None:
    raw, names = allowed_contract(seed)
    before = copy.deepcopy(raw)
    accepted: list[bool] = []
    results = read_three_ways(
        raw, use_contract_file, lambda r: accepted.append(check_result(r, raw))
    )
    assert raw == before
    assert accepted == [True, True, True], (names, [getattr(r, "reason", "") for r in results])
    assert_same_verdict(results)


@pytest.mark.parametrize("seed", range(SEEDS))
@pytest.mark.parametrize("placement", ["root", "unknown-key", "known-key", "list-item"])
def test_deeply_nested_input_never_raises(
    seed: int, placement: str, use_contract_file: Callable[[str], Path]
) -> None:
    depth = random.Random(f"deep-{seed}").choice([10, 100, 400, 900, 1100, 5000, 100_000])
    marker = "@@NEST@@"
    base: Any = _shipped()
    if placement == "unknown-key":
        base["extra"] = marker
    elif placement == "known-key":
        base["allowed_imports"]["react"]["values"] = marker
    elif placement == "list-item":
        base["supported_runtime_contract_versions"].append(marker)
    nest = deep(depth)
    raw = nest if placement == "root" else copy.deepcopy(base)
    if placement == "unknown-key":
        raw["extra"] = nest
    elif placement == "known-key":
        raw["allowed_imports"]["react"]["values"] = nest
    elif placement == "list-item":
        raw["supported_runtime_contract_versions"][-1] = nest

    # The parsed value, built without recursion.
    direct = parse_contract(raw)
    assert isinstance(direct, ContractOk | ContractInvalid)

    # The same value as text on disk. Text nested past the parser's recursion limit must come
    # back as a rejection, not as a RecursionError.
    brackets = "[" * depth + "1" + "]" * depth
    text = brackets if placement == "root" else json.dumps(base).replace(f'"{marker}"', brackets)
    path = use_contract_file(text)
    from_file = read_contract_file(path)
    loaded = load_contract()
    assert type(from_file) is type(loaded)
    for result in (direct, from_file, loaded):
        if isinstance(result, ContractInvalid):
            check_rejected(result)
    if placement == "unknown-key":
        # Unknown keys are dropped, so only the parser's own limit can reject this contract.
        assert isinstance(direct, ContractOk)
        assert isinstance(from_file, ContractOk) or depth >= 400
    else:
        assert isinstance(direct, ContractInvalid)
        assert isinstance(from_file, ContractInvalid)


@pytest.mark.parametrize(
    "value",
    [
        float("nan"),
        float("inf"),
        float("-inf"),
        b"bytes",
        bytearray(b"x"),
        {1, 2},
        frozenset(),
        (1, 2),
        object(),
        type,
        1j,
        {1: "int key"},
        {None: "none key", (1, 2): "tuple key"},
        {"contract_version": float("nan")},
        {"contract_version": float("inf"), "supported_runtime_contract_versions": [float("inf")]},
        {"canvas": {"width": math.nan, "height": math.inf, "fps": -math.inf}},
    ],
    ids=lambda value: type(value).__name__ + ":" + repr(value)[:24],
)
def test_values_that_json_cannot_hold_are_rejected_without_raising(value: object) -> None:
    check_rejected(parse_contract(value))


@pytest.mark.parametrize("seed", range(SEEDS))
def test_an_unreadable_file_is_rejected_without_raising(
    seed: int, use_contract_file: Callable[[str], Path]
) -> None:
    """Truncation, garbage and bad encodings of a real contract file (the file route)."""
    rng = random.Random(f"file-{seed}")
    good = json.dumps(_shipped())
    kind = rng.choice(["truncate", "garbage", "nan", "bytes", "empty", "bom", "trailing"])
    path = use_contract_file(good)
    if kind == "truncate":
        text = good[: rng.randint(0, len(good) - 2)]
        path.write_text(text, encoding="utf-8")
    elif kind == "garbage":
        path.write_bytes(bytes(rng.randrange(256) for _ in range(rng.randint(0, 200))))
    elif kind == "nan":
        path.write_text(good.replace('"contract_version": 1', '"contract_version": NaN', 1))
    elif kind == "bytes":
        path.write_bytes(good.encode("utf-8")[: len(good) // 2] + b"\xff\xfe")
    elif kind == "empty":
        path.write_bytes(b"")
    elif kind == "bom":
        path.write_bytes(b"\xef\xbb\xbf" + good.encode("utf-8"))
    else:
        path.write_text(good + rng.choice([" x", "{}", "\n\n,", "\x00"]), encoding="utf-8")
    load_contract.cache_clear()
    results = [read_contract_file(path), load_contract()]
    for result in results:
        assert isinstance(result, ContractOk | ContractInvalid)
        if isinstance(result, ContractInvalid):
            check_rejected(result)
    assert type(results[0]) is type(results[1])
    # Each damage above breaks the file as JSON, except nothing: all of them must be rejected.
    assert all(isinstance(result, ContractInvalid) for result in results), kind
    path.unlink()
    load_contract.cache_clear()
    check_rejected(read_contract_file(path))
    check_rejected(load_contract())


# --- guards on the generators -------------------------------------------------------------


def test_the_generators_reach_every_branch() -> None:
    """Without this, the properties could pass while a generator only ever made easy inputs."""
    operations: set[str] = set()
    accepted = rejected = 0
    judged_bad = 0
    for seed in range(SEEDS):
        rng = random.Random(f"mutated-{seed}")
        raw = _shipped()
        for _ in range(rng.randint(1, 3)):
            mutate_once(rng, raw, operations)
        verdict = parse_contract(raw)
        accepted += isinstance(verdict, ContractOk)
        rejected += isinstance(verdict, ContractInvalid)
        judged_bad += bool(violations(raw))
    assert operations == set(OPERATIONS)
    assert accepted >= 1, "no random edit stayed valid (edits that only touch free-form fields)"
    assert rejected >= 20
    assert judged_bad >= 10, "the oracle should catch many of the edits on its own"

    json_types = {json_type(random_json(random.Random(n))) for n in range(400)}
    assert json_types == {"null", "bool", "number", "str", "list", "dict"}

    breakers_seen = {broken_contract(seed)[1] for seed in range(SEEDS)}
    assert breakers_seen == set(BREAKER_NAMES)
    allowed_seen = {name for seed in range(SEEDS) for name in allowed_contract(seed)[1]}
    assert allowed_seen == set(ALLOWED_CHANGES)

    # The shipped contract itself is accepted, so every rejection above comes from the edit.
    assert isinstance(parse_contract(_shipped()), ContractOk)
    assert violations(_shipped()) == []


def test_the_oracle_agrees_with_the_known_cases() -> None:
    """The oracle is its own small spec: check it on cases decided by hand."""
    good = _shipped()
    assert violations(good) == []
    for edit in (
        lambda r: r.update(contract_version=0),
        lambda r: r.update(contract_version=True),
        lambda r: r.update(contract_version=2),
        lambda r: r["canvas"].update(fps=30.5),
        lambda r: r["duration"].update(min=901),
        lambda r: r.update(color_tokens=[]),
        lambda r: r.update(diagnostic_code_prefixes=["AGENT"] * 10),
        lambda r: r.pop("limits"),
        lambda r: r.update(supported_runtime_contract_versions=[]),
    ):
        raw = _shipped()
        edit(raw)
        assert violations(raw), raw
    assert violations([]) and violations(None) and violations("contract")
    whole = _shipped()
    whole["canvas"]["width"] = 1280.0
    assert violations(whole) == []
