"""Required_Tokens, Skipped_Tokens and effective Forbidden_Tokens of an animation request.

Why: the fidelity gate of the verifier (step 7) checks that every label of the lesson `visual`
shows on screen, and the prompt tells Gemini the same list. The list is derived from the request
with pure functions here, so the prompt and the verifier payload cannot disagree (Requirement 12,
design 6.3). Nothing in this module calls Gemini, the verifier, the database or the network.

Rules in short:

- `normalize_token` is NFKC, `lower()`, then removal of every ECMAScript `\\s` character. It is
  the twin of `normalizeToken` in `animation-verifier/src/tokens.ts`; both must give the same
  string for every vector in `tests/fixtures/animation/token-normalization.json` (Req. 10.1, 10.13).
- `derive_tokens` reads the title, the caption and the text fields of the `visual` in a fixed
  order (design 6.3), drops values that are empty after normalization or repeat an earlier normal
  form, and moves a value that would trip the policy scan (a hex colour, `rgb(`, `hsl(`, a URL
  scheme) from `required` to `skipped` (G2, Requirement 12.2). Numeric coordinates are never
  tokens (Requirement 12.3). The string of the first occurrence is kept as written.
- `effective_forbidden_tokens` drops blank and repeated entries and any entry that is equal to, or
  inside, a Required_Token after normalization (Requirement 12.4, 12.7, 12.8).

Scheme and colour rules come from the contract (`url_schemes`, `url_schemes_strict_colon`,
`color_forms.hex_pattern`), never from a second list here. The one literal is the four colour
function prefixes that Requirement 12.2 names; the contract lists more functions for the policy
scan, and a test keeps the four inside that list.

Python's `unicodedata` follows the Python build (3.12 has Unicode 15.0) and the verifier follows
Node's ICU, so a newer Unicode could make the two differ for a newly added character. The CI
image (`ci/api`, Python 3.12) is what proves the parity on the shared vectors.

Functions here do not raise for a validated request. `re.error` can only come from a broken
`hex_pattern` in the shipped contract, which the contract tests would catch. This module must not
import `langgraph` or `boto3` (Requirement 41.1).
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from functools import cache

from app.ai.animation.contract import AnimationContract
from app.ai.animation.models import CreateAnimationRequest, VisualSpec
from app.ai.contracts.visual import (
    DiagramVisual,
    FormulaVisual,
    PlotVisual,
    TableVisual,
    VectorsVisual,
)
from app.ai.zod_compat import js_trim

# ECMAScript `\s`: WhiteSpace and LineTerminator, including U+FEFF. Python's `\s` and
# `str.isspace` differ (they keep U+FEFF and also match U+001C to U+001F and U+0085), so the set
# is spelled out. U+200B, U+200C, U+200D, U+2060, U+0085 and U+180E are not `\s` in ECMAScript.
_ECMA_WS = re.compile(
    "[\t\n\u000b\u000c\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]"
)

# Prefixes of the colour functions that Requirement 12.2 takes out of Required_Tokens.
_COLOR_FUNCTION_PREFIXES = ("rgb(", "rgba(", "hsl(", "hsla(")

# Lowercases A to Z only. `str.lower()` also maps non-ASCII characters (for example U+212A to `k`),
# and the scheme and function names are ASCII, so the scan folds ASCII and leaves the rest alone.
_ASCII_LOWER = {code: code + 32 for code in range(ord("A"), ord("Z") + 1)}


def normalize_token(s: str) -> str:
    """NFKC, `lower()`, then delete every ECMAScript `\\s` character; the empty string stays empty.

    The order matters: whitespace goes last, so characters such as U+200B stay and can separate
    tokens. Not idempotent for a combining mark that follows whitespace (`"e \\u0301"`); the
    verifier has the same limit.
    """
    return _ECMA_WS.sub("", unicodedata.normalize("NFKC", s).lower())


@dataclass(frozen=True)
class TokenSet:
    """Tokens of one request, both in the order of first appearance and without repeats."""

    required: list[str]  # Required_Tokens: the string of the first occurrence, as written
    skipped: list[str]  # Skipped_Tokens: kept out of `required`, recorded in the manifest


def _ascii_lower(text: str) -> str:
    return text.translate(_ASCII_LOWER)


@cache
def _compiled(pattern: str) -> re.Pattern[str]:
    return re.compile(pattern)


def url_scheme_prefix(text: str, contract: AnimationContract) -> str | None:
    """The forbidden URL scheme that `text` starts with, or `None`.

    Same rule as the policy scan (Requirement 7.9): after a JavaScript `trim()`, the text starts
    with `<scheme>:`, letter case ignored (ASCII only). For a scheme in `url_schemes_strict_colon`
    the colon must also be followed by a character that is not whitespace, so a label such as
    `Data: 5` or a bare `data:` is not a URL. Other schemes need only the colon. Returns the
    scheme as the contract spells it.
    """
    trimmed = js_trim(text)
    folded = _ascii_lower(trimmed)
    strict = {_ascii_lower(scheme) for scheme in contract.url_schemes_strict_colon}
    for scheme in contract.url_schemes:
        marker = _ascii_lower(scheme) + ":"
        if not folded.startswith(marker):
            continue
        if _ascii_lower(scheme) in strict:
            following = trimmed[len(marker) : len(marker) + 1]
            if following == "" or _ECMA_WS.fullmatch(following):
                continue
        return scheme
    return None


def _is_skipped(text: str, contract: AnimationContract) -> bool:
    """True when the whole token is a colour literal or starts like a forbidden URL (G2)."""
    trimmed = js_trim(text)
    if _compiled(contract.color_forms.hex_pattern).fullmatch(trimmed):
        return True
    if _ascii_lower(trimmed).startswith(_COLOR_FUNCTION_PREFIXES):
        return True
    return url_scheme_prefix(trimmed, contract) is not None


def _visual_texts(visual: VisualSpec) -> Iterator[str | None]:
    """Text values of a `visual` in token order: caption, then the fields of its kind.

    `None` marks an absent optional value. Coordinates, ranges, tones, layout, node ids and edge
    ends are not text the viewer reads, so they are not listed (Requirement 12.3).
    """
    yield visual.caption
    if isinstance(visual, VectorsVisual):
        for vector in visual.vectors:
            yield vector.label
        for point in visual.points or []:
            yield point.label
    elif isinstance(visual, PlotVisual):
        yield visual.x_label
        yield visual.y_label
        for series in visual.series:
            yield series.label
    elif isinstance(visual, DiagramVisual):
        for node in visual.nodes:
            yield node.label
            yield node.detail
        for edge in visual.edges:
            yield edge.label
    elif isinstance(visual, TableVisual):
        yield from visual.headers
        for row in visual.rows:
            yield from row
    elif isinstance(visual, FormulaVisual):
        yield visual.expression
        for term in visual.terms:
            yield term.symbol
            yield term.meaning
        yield visual.example


def derive_tokens(req: CreateAnimationRequest, contract: AnimationContract) -> TokenSet:
    """Required and skipped tokens of `req` (design 6.3). Pure: the request is not changed.

    A value is dropped when it is empty after normalization or has the normal form of an earlier
    value, skipped or not, so each normal form appears in at most one of the two lists. The title
    is the first value and goes through the same rules.
    """
    required: list[str] = []
    skipped: list[str] = []
    seen: set[str] = set()
    for text in (req.title, *_visual_texts(req.visual)):
        if text is None:
            continue
        normalized = normalize_token(text)
        if normalized == "" or normalized in seen:
            continue
        seen.add(normalized)
        (skipped if _is_skipped(text, contract) else required).append(text)
    return TokenSet(required=required, skipped=skipped)


def required_tokens(req: CreateAnimationRequest, contract: AnimationContract) -> list[str]:
    """Required_Tokens of `req`: the title, then the text of the `visual` (Requirement 12.1)."""
    return derive_tokens(req, contract).required


def effective_forbidden_tokens(req: CreateAnimationRequest, required: Sequence[str]) -> list[str]:
    """The `forbidden_tokens` of `req` that can still be told apart from the Required_Tokens.

    Walks the list in order and keeps the first spelling of each entry. An entry is dropped when
    it is empty after normalization, repeats an earlier normal form, or its normal form is equal
    to, or inside, the normal form of any Required_Token. So `["  ", "Ya", "ya"]` gives `["Ya"]`,
    and `["4"]` with the title `Pick 4 items` gives `[]` (Requirement 12.7, 12.8). A new list is
    returned and `req` is not changed.
    """
    required_forms = [normalize_token(token) for token in required]
    seen: set[str] = set()
    effective: list[str] = []
    for token in req.forbidden_tokens:
        form = normalize_token(token)
        if form == "" or form in seen:
            continue
        seen.add(form)
        if any(form in required_form for required_form in required_forms):
            continue
        effective.append(token)
    return effective
