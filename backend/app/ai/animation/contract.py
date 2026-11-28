"""Reader for the shared animation contract (`animation-contract.json`).

Why: the contract is the one place where the rules for an AI-written `main.ts` live (canvas,
limits, allowed imports, forbidden names, colour tokens, diagnostic code prefixes). The verifier
and the sandbox runtime read their own copy of the same file, so this module only checks the
shape and never hard-codes a value (Requirement 2.6). The checks are the minimum shared by all
three readers (design 4.3, Requirement 2.11); `animation-verifier/src/contract.ts` is the
TypeScript twin.

`load_contract()` is total: a missing file, bad JSON or a rule violation gives `ContractInvalid`
with a short `reason`, never an exception. The endpoint turns that into 503
`ANIMATION_NOT_CONFIGURED` before it calls Gemini, counts quota or takes a slot (Requirement
2.10, 2.15). The result is cached for the life of the process because the file ships inside the
image and cannot change while the process runs.

The copy next to this module is written by `scripts/sync-animation-contract.py`; do not edit it.
This module must not import `langgraph` or `boto3` (Requirement 41.1).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    Strict,
    ValidationError,
    ValidationInfo,
    field_validator,
    model_validator,
)

CONTRACT_FILE_NAME = "animation-contract.json"
CONTRACT_PATH = Path(__file__).with_name(CONTRACT_FILE_NAME)

# Prefix of the Diagnostic codes the agent writes itself; the verifier never emits it.
AGENT_PREFIX = "AGENT"

# Ten verifier prefixes plus AGENT, and the nine colour tokens of the Kit palette.
DIAGNOSTIC_PREFIX_COUNT = 11
COLOR_TOKEN_COUNT = 9

# Issues shown in `reason`; the rest are summarised as "+N more" so logs stay short.
MAX_REASON_ISSUES = 5


def _whole_number(value: object) -> object:
    """Treat a JSON number such as 1280.0 as the whole number it is in JavaScript."""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


# Whole numbers only: rejects 1.5, "5", True and null, like Zod's `z.number().int()`.
WholeInt = Annotated[int, BeforeValidator(_whole_number), Strict()]
PositiveWhole = Annotated[WholeInt, Field(ge=1)]
NonNegativeWhole = Annotated[WholeInt, Field(ge=0)]
StringList = tuple[str, ...]


class _ContractModel(BaseModel):
    """Base for contract models: unknown keys are dropped (as Zod does) and values are fixed."""

    model_config = ConfigDict(extra="ignore", frozen=True)


class ImportNames(_ContractModel):
    values: StringList
    types: StringList


class Canvas(_ContractModel):
    width: PositiveWhole
    height: PositiveWhole
    fps: PositiveWhole


class Duration(_ContractModel):
    min: PositiveWhole
    max: PositiveWhole

    @model_validator(mode="after")
    def _ordered(self) -> Duration:
        if self.min > self.max:
            raise ValueError("min must be less than or equal to max")
        return self


class Limits(_ContractModel):
    source_max_bytes: PositiveWhole
    bundle_max_bytes: PositiveWhole
    dom_max_elements: PositiveWhole
    frame_timeout_ms: PositiveWhole
    verifier_deadline_ms: PositiveWhole
    diagnostics_max: PositiveWhole
    diagnostic_message_max_chars: PositiveWhole
    worker_heap_mb: PositiveWhole
    rss_limit_mb: PositiveWhole
    fold_depth: PositiveWhole


class MetaExport(_ContractModel):
    keys: StringList
    optional_keys: StringList


class DefaultExport(_ContractModel):
    function_name: Annotated[str, Field(min_length=1)]
    param_count: NonNegativeWhole


class RequiredExports(_ContractModel):
    meta: MetaExport
    default: DefaultExport


class PauseRules(_ContractModel):
    lesson: Literal["required", "forbidden"]
    puzzle: Literal["required", "forbidden"]


class ForbiddenAttribute(_ContractModel):
    names: StringList
    patterns: StringList
    style_key_prefixes: StringList


class Forbidden(_ContractModel):
    identifier: StringList
    member: StringList
    property: StringList
    element: StringList
    attribute: ForbiddenAttribute


class ColorForms(_ContractModel):
    hex_pattern: str
    functions: StringList
    named_colors: StringList


class KitStyleWarnings(_ContractModel):
    border_radius_property: str
    shadow_properties: StringList
    gradient_functions: StringList
    filter_functions: StringList
    backdrop_property: str
    emoji_pattern: str
    font_family_property: str


class AnimationContract(_ContractModel):
    """The 20 fields of `animation-contract.json` (design 4.1), in the order of that table."""

    contract_version: PositiveWhole
    file_name: Annotated[str, Field(min_length=1)]
    canvas: Canvas
    duration: Duration
    limits: Limits
    allowed_imports: dict[str, ImportNames]
    required_exports: RequiredExports
    pause_rules: PauseRules
    forbidden: Forbidden
    url_schemes: StringList
    url_schemes_strict_colon: StringList
    css_functions_forbidden: StringList
    color_tokens: Annotated[
        StringList, Field(min_length=COLOR_TOKEN_COUNT, max_length=COLOR_TOKEN_COUNT)
    ]
    color_keywords: StringList
    color_properties: StringList
    color_forms: ColorForms
    font_variables: StringList
    kit_style_warnings: KitStyleWarnings
    diagnostic_code_prefixes: Annotated[
        StringList, Field(min_length=DIAGNOSTIC_PREFIX_COUNT, max_length=DIAGNOSTIC_PREFIX_COUNT)
    ]
    supported_runtime_contract_versions: Annotated[tuple[PositiveWhole, ...], Field(min_length=1)]

    @field_validator("diagnostic_code_prefixes")
    @classmethod
    def _includes_agent(cls, prefixes: StringList) -> StringList:
        if AGENT_PREFIX not in prefixes:
            raise ValueError(f"must include {AGENT_PREFIX}")
        return prefixes

    # `contract_version` is declared first, so it is in `info.data` unless it failed itself.
    @field_validator("supported_runtime_contract_versions")
    @classmethod
    def _includes_contract_version(
        cls, versions: tuple[int, ...], info: ValidationInfo
    ) -> tuple[int, ...]:
        version = info.data.get("contract_version")
        if version is not None and version not in versions:
            raise ValueError("must include contract_version")
        return versions


@dataclass(frozen=True)
class ContractOk:
    """A contract that passed the minimum checks."""

    contract: AnimationContract
    ok: Literal[True] = True


@dataclass(frozen=True)
class ContractInvalid:
    """A contract that is missing, unreadable or breaks a rule; `reason` is for operators."""

    reason: str
    ok: Literal[False] = False


ContractResult = ContractOk | ContractInvalid


def _describe_issues(error: ValidationError) -> str:
    """`path: message` for the first few issues, like `describeIssues` in the verifier."""
    issues = error.errors(include_url=False)
    shown = []
    for issue in issues[:MAX_REASON_ISSUES]:
        path = ".".join(str(part) for part in issue["loc"]) or "(root)"
        shown.append(f"{path}: {issue['msg'].removeprefix('Value error, ')}")
    hidden = len(issues) - len(shown)
    return "; ".join(shown) + (f"; +{hidden} more" if hidden > 0 else "")


def parse_contract(raw: object) -> ContractResult:
    """Check `raw` (the result of `json.loads`) against the minimum rules. Never raises."""
    try:
        return ContractOk(AnimationContract.model_validate(raw))
    except ValidationError as exc:
        return ContractInvalid(_describe_issues(exc))
    except Exception:  # Keep the "never raises" promise for any input type.
        return ContractInvalid("(root): contract could not be read")


def _reject_constant(name: str) -> object:
    """`json.loads` accepts NaN and Infinity; JSON.parse in the other readers does not."""
    raise ValueError(f"{name} is not valid JSON")


def read_contract_file(path: Path) -> ContractResult:
    """Read and check the contract at `path` without caching. Never raises."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"), parse_constant=_reject_constant)
    except (OSError, ValueError, RecursionError) as exc:
        return ContractInvalid(f"{path.name}: cannot be read as JSON ({type(exc).__name__})")
    return parse_contract(raw)


@cache
def load_contract() -> ContractResult:
    """The contract shipped next to this module, read once per process (also when invalid)."""
    return read_contract_file(CONTRACT_PATH)


def diagnostic_code_pattern(contract: AnimationContract) -> str:
    """Regex source for a verifier Diagnostic code, built from every prefix except `AGENT`.

    Same text as the literal in Requirement 6.8, `^(SIZE|...|VERIFIER)_[A-Z0-9_]+$`, in the order
    of the contract. It is a string so it can go straight into `Field(pattern=...)`. In Python's
    `re`, `$` also matches before a trailing newline, so use `fullmatch` when compiling it.
    """
    prefixes = [prefix for prefix in contract.diagnostic_code_prefixes if prefix != AGENT_PREFIX]
    return "^(" + "|".join(re.escape(prefix) for prefix in prefixes) + ")_[A-Z0-9_]+$"
