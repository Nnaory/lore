"""Tests for the animation contract reader (no network, no database, no langgraph or boto3).

Why: the contract is the single source of truth for what an AI-written `main.ts` may contain, and
a bad or missing copy must turn the feature off (503 `ANIMATION_NOT_CONFIGURED`) instead of
crashing. These tests cover the minimum checks shared with the verifier (design 4.3), the byte
identity of the synced copy, and that the file reaches the Docker image.
"""

from __future__ import annotations

import ast
import copy
import fnmatch
import json
import re
import subprocess
import sys
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Annotated, Any

import pytest
from pydantic import Field, TypeAdapter, ValidationError

from app.ai.animation import contract as contract_module
from app.ai.animation.contract import (
    CONTRACT_FILE_NAME,
    AnimationContract,
    ContractInvalid,
    ContractOk,
    diagnostic_code_pattern,
    load_contract,
    parse_contract,
)

BACKEND_DIR = Path(__file__).resolve().parent.parent
ROOT = BACKEND_DIR.parent
PACKAGE_DIR = BACKEND_DIR / "app" / "ai" / "animation"
COPY = PACKAGE_DIR / CONTRACT_FILE_NAME
SOURCE = ROOT / "animation-verifier" / "contract" / CONTRACT_FILE_NAME

# The literal from Requirement 6.8. The built pattern must equal it (Requirement 2.13).
DIAGNOSTIC_CODE_LITERAL = (
    r"^(SIZE|ENCODING|POLICY|META|ESLINT|TSC|BUNDLE|RENDER|FIDELITY|VERIFIER)_[A-Z0-9_]+$"
)

_DELETE = object()


def _shipped_raw() -> dict[str, Any]:
    return json.loads(COPY.read_text(encoding="utf-8"))


FIELD_NAMES = list(_shipped_raw())
LIMIT_NAMES = list(_shipped_raw()["limits"])


@pytest.fixture
def raw() -> dict[str, Any]:
    """A fresh, valid contract as parsed JSON that a test may change."""
    return _shipped_raw()


def _with(raw: dict[str, Any], path: str, value: object) -> dict[str, Any]:
    """Copy of `raw` with the dotted `path` set to `value`, or removed when `_DELETE`."""
    changed = copy.deepcopy(raw)
    *parents, leaf = path.split(".")
    node: Any = changed
    for name in parents:
        node = node[name]
    if value is _DELETE:
        del node[leaf]
    else:
        node[leaf] = value
    return changed


def _invalid(result: object) -> str:
    assert isinstance(result, ContractInvalid)
    assert result.ok is False
    assert result.reason
    return result.reason


# --- the shipped contract -----------------------------------------------------------------


def test_shipped_contract_is_accepted() -> None:
    result = load_contract()
    assert isinstance(result, ContractOk), getattr(result, "reason", "")
    assert result.ok is True


def test_model_has_exactly_the_twenty_contract_fields() -> None:
    assert len(AnimationContract.model_fields) == 20
    assert set(AnimationContract.model_fields) == set(FIELD_NAMES)


def test_shipped_contract_has_the_agreed_values() -> None:
    result = load_contract()
    assert isinstance(result, ContractOk)
    contract = result.contract
    assert contract.file_name == "main.ts"
    assert (contract.canvas.width, contract.canvas.height, contract.canvas.fps) == (1280, 720, 30)
    assert (contract.duration.min, contract.duration.max) == (30, 900)
    assert contract.limits.source_max_bytes == 32768
    assert contract.limits.bundle_max_bytes == 131072
    assert contract.limits.dom_max_elements == 600
    assert len(contract.color_tokens) == 9
    assert len(contract.diagnostic_code_prefixes) == 11
    assert contract.contract_version in contract.supported_runtime_contract_versions


# --- minimum checks -----------------------------------------------------------------------


def test_whole_floats_and_unknown_keys_are_accepted(raw: dict[str, Any]) -> None:
    raw = _with(raw, "canvas.width", 1280.0)
    raw["not_in_the_contract"] = {"a": 1}
    result = parse_contract(raw)
    assert isinstance(result, ContractOk)
    assert result.contract.canvas.width == 1280
    assert type(result.contract.canvas.width) is int
    assert not hasattr(result.contract, "not_in_the_contract")


def test_a_newer_contract_version_is_accepted_when_the_runtime_supports_it(
    raw: dict[str, Any],
) -> None:
    raw = _with(raw, "contract_version", 2)
    raw["supported_runtime_contract_versions"] = [1, 2]
    assert isinstance(parse_contract(raw), ContractOk)


@pytest.mark.parametrize("field", FIELD_NAMES)
def test_each_missing_field_is_rejected(raw: dict[str, Any], field: str) -> None:
    reason = _invalid(parse_contract(_with(raw, field, _DELETE)))
    assert field in reason


@pytest.mark.parametrize("limit", LIMIT_NAMES)
def test_each_limit_must_be_a_positive_whole_number(raw: dict[str, Any], limit: str) -> None:
    for bad in (0, -1, 1.5, "1", True):
        reason = _invalid(parse_contract(_with(raw, f"limits.{limit}", bad)))
        assert f"limits.{limit}" in reason
    assert f"limits.{limit}" in _invalid(parse_contract(_with(raw, f"limits.{limit}", _DELETE)))


@pytest.mark.parametrize(
    ("path", "value", "expected_in_reason"),
    [
        ("contract_version", 0, "contract_version"),
        ("contract_version", -1, "contract_version"),
        ("contract_version", 1.5, "contract_version"),
        ("contract_version", "1", "contract_version"),
        ("contract_version", True, "contract_version"),
        ("contract_version", None, "contract_version"),
        # Version 2 is not in supported_runtime_contract_versions ([1]).
        ("contract_version", 2, "supported_runtime_contract_versions"),
        ("supported_runtime_contract_versions", [], "supported_runtime_contract_versions"),
        ("supported_runtime_contract_versions", [2], "supported_runtime_contract_versions"),
        ("supported_runtime_contract_versions", [0, 1], "supported_runtime_contract_versions"),
        ("supported_runtime_contract_versions", "1", "supported_runtime_contract_versions"),
        ("file_name", "", "file_name"),
        ("file_name", 5, "file_name"),
        ("canvas.width", 0, "canvas.width"),
        ("canvas.height", -720, "canvas.height"),
        ("canvas.fps", 30.5, "canvas.fps"),
        ("canvas.fps", "30", "canvas.fps"),
        ("canvas.fps", True, "canvas.fps"),
        ("canvas", [1280, 720, 30], "canvas"),
        ("duration.min", 0, "duration.min"),
        ("duration.max", 0, "duration.max"),
        # min greater than max, from either side.
        ("duration.min", 901, "duration"),
        ("duration.max", 29, "duration"),
        ("color_tokens", ["ink"] * 8, "color_tokens"),
        ("color_tokens", ["ink"] * 10, "color_tokens"),
        ("color_tokens", "ink", "color_tokens"),
        ("diagnostic_code_prefixes", ["SIZE"] * 10, "diagnostic_code_prefixes"),
        ("diagnostic_code_prefixes", ["SIZE"] * 12, "diagnostic_code_prefixes"),
        # Eleven prefixes but no AGENT.
        ("diagnostic_code_prefixes", [f"P{n}" for n in range(11)], "must include AGENT"),
        ("pause_rules.lesson", "maybe", "pause_rules.lesson"),
        ("pause_rules", "forbidden", "pause_rules"),
        ("allowed_imports", ["react"], "allowed_imports"),
        ("allowed_imports.react.values", "createElement", "allowed_imports.react.values"),
        ("required_exports.default.param_count", -1, "required_exports.default.param_count"),
        ("required_exports.default.function_name", "", "required_exports.default.function_name"),
        ("forbidden.identifier", [1, 2], "forbidden.identifier"),
        ("forbidden.attribute", None, "forbidden.attribute"),
        ("color_forms.hex_pattern", 1, "color_forms.hex_pattern"),
        ("kit_style_warnings.emoji_pattern", None, "kit_style_warnings.emoji_pattern"),
    ],
)
def test_each_minimum_violation_is_rejected_with_a_reason(
    raw: dict[str, Any], path: str, value: object, expected_in_reason: str
) -> None:
    reason = _invalid(parse_contract(_with(raw, path, value)))
    assert expected_in_reason in reason


@pytest.mark.parametrize("not_an_object", [None, [], "contract", 3, 1.5, True])
def test_input_that_is_not_an_object_is_rejected_at_the_root(not_an_object: object) -> None:
    assert _invalid(parse_contract(not_an_object)).startswith("(root)")


def test_reason_lists_five_issues_and_counts_the_rest() -> None:
    reason = _invalid(parse_contract({}))
    assert reason.count(";") == 5
    assert reason.endswith("; +15 more")


# --- reading the file ---------------------------------------------------------------------


@pytest.fixture
def use_contract_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[Callable[[bytes | None], Path]]:
    """Point the loader at a temp file (None = missing) and reset its per-process cache."""
    path = tmp_path / CONTRACT_FILE_NAME

    def use(content: bytes | None) -> Path:
        if content is not None:
            path.write_bytes(content)
        monkeypatch.setattr(contract_module, "CONTRACT_PATH", path)
        load_contract.cache_clear()
        return path

    load_contract.cache_clear()
    yield use
    load_contract.cache_clear()


@pytest.mark.parametrize(
    "content",
    [
        None,
        b"",
        b"{",
        b"\xff\xfe\x00 not utf-8",
        b'{"contract_version": NaN}',
        b"[" * 100_000,
        b"[]",
        b'{"contract_version": 1}',
    ],
    ids=["missing", "empty", "truncated", "not-utf8", "nan", "too-deep", "array", "partial"],
)
def test_an_unreadable_or_invalid_file_gives_a_reason_and_never_raises(
    use_contract_file: Callable[[bytes | None], Path], content: bytes | None
) -> None:
    use_contract_file(content)
    _invalid(load_contract())


def test_the_valid_file_is_read_once_per_process(
    use_contract_file: Callable[[bytes | None], Path],
) -> None:
    path = use_contract_file(COPY.read_bytes())
    first = load_contract()
    assert isinstance(first, ContractOk)
    path.unlink()  # A second read would now fail, so a hit proves the cache.
    assert load_contract() is first


def test_the_shipped_result_is_cached_between_calls() -> None:
    assert load_contract() is load_contract()


# --- diagnostic code pattern --------------------------------------------------------------


def _contract(raw: dict[str, Any]) -> AnimationContract:
    result = parse_contract(raw)
    assert isinstance(result, ContractOk)
    return result.contract


def test_pattern_equals_the_literal_of_requirement_6_8(raw: dict[str, Any]) -> None:
    assert diagnostic_code_pattern(_contract(raw)) == DIAGNOSTIC_CODE_LITERAL


@pytest.mark.parametrize(
    "code", ["SIZE_SOURCE_TOO_LARGE", "POLICY_JSX_SYNTAX", "ESLINT_NO_UNUSED_VARS", "TSC_2304"]
)
def test_pattern_accepts_verifier_codes(raw: dict[str, Any], code: str) -> None:
    assert re.fullmatch(diagnostic_code_pattern(_contract(raw)), code)


@pytest.mark.parametrize(
    "code",
    ["AGENT_NO_CODE", "SIZE", "SIZE_", "SIZE_x", "size_x", "XSIZE_X", "SIZE_X\n", "OTHER_X", ""],
)
def test_pattern_rejects_agent_and_malformed_codes(raw: dict[str, Any], code: str) -> None:
    assert re.fullmatch(diagnostic_code_pattern(_contract(raw)), code) is None


def test_pattern_follows_the_contract_order_and_skips_agent_anywhere(raw: dict[str, Any]) -> None:
    prefixes = raw["diagnostic_code_prefixes"]
    reordered = ["AGENT", *reversed([p for p in prefixes if p != "AGENT"])]
    pattern = diagnostic_code_pattern(_contract(_with(raw, "diagnostic_code_prefixes", reordered)))
    assert pattern == "^(" + "|".join(reordered[1:]) + ")_[A-Z0-9_]+$"


def test_pattern_works_as_a_pydantic_field_pattern(raw: dict[str, Any]) -> None:
    code_type = TypeAdapter(Annotated[str, Field(pattern=diagnostic_code_pattern(_contract(raw)))])
    assert code_type.validate_python("RENDER_FRAME_TIMEOUT") == "RENDER_FRAME_TIMEOUT"
    for bad in ("AGENT_X", "RENDER_X\n", "render_x"):
        with pytest.raises(ValidationError):
            code_type.validate_python(bad)


# --- packaging ----------------------------------------------------------------------------


def test_synced_copy_is_byte_identical_to_the_verifier_source() -> None:
    assert COPY.read_bytes() == SOURCE.read_bytes()


def _segments_match(pattern: list[str], path: list[str]) -> bool:
    """Docker's matching: `*` and `?` stay inside one path segment, `**` spans segments."""
    if not pattern:
        return not path
    head, rest = pattern[0], pattern[1:]
    if head == "**":
        return any(_segments_match(rest, path[i:]) for i in range(len(path) + 1))
    return bool(path) and fnmatch.fnmatchcase(path[0], head) and _segments_match(rest, path[1:])


def is_dockerignored(rel_path: str, rules: list[str]) -> bool:
    """Whether `.dockerignore` excludes `rel_path` (a rule on any parent directory counts)."""
    parts = rel_path.split("/")
    ignored = False
    for rule in rules:
        negate = rule.startswith("!")
        pattern = [p for p in rule.removeprefix("!").strip("/").split("/") if p]
        if any(_segments_match(pattern, parts[:i]) for i in range(1, len(parts) + 1)):
            ignored = not negate
    return ignored


def _dockerignore_rules() -> list[str]:
    lines = (BACKEND_DIR / ".dockerignore").read_text(encoding="utf-8").splitlines()
    return [line.strip() for line in lines if line.strip() and not line.strip().startswith("#")]


def test_dockerignore_matcher_follows_docker_rules() -> None:
    rules = ["*.md", "tests", "!tests/keep.py", "**/cache"]
    assert is_dockerignored("README.md", rules)
    assert not is_dockerignored("app/notes.md", rules)  # `*.md` only matches at the root
    assert is_dockerignored("tests/test_x.py", rules)
    assert not is_dockerignored("tests/keep.py", rules)
    assert is_dockerignored("app/ai/cache/x.json", rules)
    assert not is_dockerignored("app/ai/x.json", rules)


def test_contract_file_is_copied_into_the_image() -> None:
    dockerfile = (BACKEND_DIR / "Dockerfile").read_text(encoding="utf-8")
    assert re.search(r"^COPY\s+(?:--\S+\s+)*app\s+\./app\s*$", dockerfile, re.MULTILINE)
    rules = _dockerignore_rules()
    relative = COPY.relative_to(BACKEND_DIR).as_posix()
    assert relative == "app/ai/animation/animation-contract.json"
    assert not is_dockerignored("app", rules)
    assert not is_dockerignored(relative, rules)


# --- no heavy imports (Requirement 41.1) --------------------------------------------------

HEAVY = {"langgraph", "boto3", "botocore"}


def _imported_modules(path: Path) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            names.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            names.add(node.module.split(".")[0])
    return names


def test_package_init_has_no_imports_and_contract_avoids_heavy_packages() -> None:
    assert _imported_modules(PACKAGE_DIR / "__init__.py") == set()
    assert not _imported_modules(PACKAGE_DIR / "contract.py") & HEAVY
    assert not _imported_modules(Path(__file__)) & HEAVY


def test_loading_the_contract_in_a_fresh_process_imports_no_heavy_packages() -> None:
    code = (
        "import sys\n"
        "from app.ai.animation.contract import load_contract\n"
        "assert load_contract().ok\n"
        f"heavy = {sorted(HEAVY)!r}\n"
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
