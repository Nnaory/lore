"""Reference token normalization shared by the token property tests (no code under test here).

Why: `test_animation_token_parity.py` and `test_animation_token_coverage.py` both need an oracle
for "the normal form of a token" that does not call `app.ai.animation.tokens`. If they used
`normalize_token` to judge `normalize_token`, a slip in it would also slip through the oracle.
The oracle follows Requirement 10.1 one character at a time, with the ECMAScript whitespace set
spelled out (the same 25 characters as `animation-verifier/tests/tokens.test.ts`).
"""

from __future__ import annotations

import unicodedata

# ECMA-262 WhiteSpace and LineTerminator, `\s` in a JavaScript regular expression.
ECMA_WHITESPACE = frozenset(
    "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)


def reference_normalize(text: str) -> str:
    """NFKC, `lower()`, then drop each ECMAScript whitespace character, one at a time."""
    folded = unicodedata.normalize("NFKC", text).lower()
    return "".join(ch for ch in folded if ch not in ECMA_WHITESPACE)


def js_trim_reference(text: str) -> str:
    """`String.prototype.trim` with the same whitespace set (the ends only)."""
    start, end = 0, len(text)
    while start < end and text[start] in ECMA_WHITESPACE:
        start += 1
    while end > start and text[end - 1] in ECMA_WHITESPACE:
        end -= 1
    return text[start:end]
