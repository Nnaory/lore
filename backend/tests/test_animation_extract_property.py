"""Property tests: source normalization is idempotent and extraction round-trips (Property 15).

Why: the agent hashes and stores the exact string that `extract_main_ts` returns, and the registry
key is the SHA-256 of it. If normalizing twice changed the string, the hash of a stored source
would differ from the hash of the same source read back; if the extraction cut or reshaped code
inside a fence, the verifier would judge a different file than the one Gemini wrote. Requirement
5.11 states both: `normalize_source` is idempotent for every string, and for a string `s` that has
a non-whitespace character and no triple backtick, `extract_main_ts` of `s` wrapped in a `ts` fence
returns `{ok: True}` with the source `normalize_source(s)`.

The cases the unit table (`test_animation_extract.py`) cannot list are generated here from seeded
`random.Random` instances (40 seeds, 25 strings each; `hypothesis` is not a dependency). The
alphabet is made of the awkward units on purpose: repeated and interleaved U+FEFF, CR, LF and
CRLF in every order, lone surrogates, U+2028, U+0085, NUL, backticks one and two at a time, emoji,
and code fragments that start with `import`, `export`, `//` or `/*`.

Four groups:

1. `normalize_source`: idempotent, always valid UTF-8, no CR, no leading BOM, exactly one LF at the
   end, and equal to an independent reference written with regular expressions.
2. The round trip of Requirement 5.11, also with other fence labels, CRLF around the fence, prose
   before and after, an earlier block with another label and a later `ts` block (the first wins).
3. A reply without any fence that starts with a code marker is taken whole.
4. Replies that must fail: prose, an unclosed block, a block of whitespace, only other labels.

`test_the_generators_...` keeps the properties from passing on easy strings only.
"""

from __future__ import annotations

import random
import re
from collections.abc import Callable
from typing import Any

import pytest

from app.ai.animation.prompts import ExtractFail, ExtractOk, extract_main_ts, normalize_source

SEEDS = 40
STRINGS_PER_SEED = 25
FENCE = "```"
NO_CODE = "AGENT_EXTRACT_NO_CODE"
BOM = "\ufeff"

UNITS: dict[str, tuple[str, ...]] = {
    "code": (
        "import { AbsoluteFill } from 'remotion';",
        "export const meta = { durationInFrames: 90 };",
        "export default function Main() { return null; }",
        "const a = 1;",
        "// a comment",
        "/* block */",
        "{",
        "}",
        "'",
        '"',
    ),
    "break": ("\n", "\n", "\r\n", "\r", "\n\n", "\r\r", "\n\r"),
    "space": (" ", "  ", "\t", "\u00a0", "\u2028", "\u0085", "\u3000", "\x0b", "\x1c"),
    "bom": (BOM, BOM, BOM + BOM),
    "surrogate": ("\ud800", "\udfff", "\ud83d", "\ude00"),
    "backtick": ("`", "``", "a`b"),
    "text": ("x", "abc", "e\u0301", "\u00e9", "\U0001f600", "\u65e5\u672c", "\x00", "?"),
}
KIND_NAMES = tuple(UNITS)


def random_source(rng: random.Random) -> tuple[str, set[str]]:
    """A string with a non-whitespace character and no triple backtick, plus the unit kinds."""
    used: set[str] = set()
    parts: list[str] = []
    for _ in range(rng.randint(0, 14)):
        kind = rng.choice(KIND_NAMES)
        used.add(kind)
        parts.append(rng.choice(UNITS[kind]))
    text = "".join(parts)
    while FENCE in text:
        text = text.replace(FENCE, "`` `")
    if all(char.isspace() for char in text):
        text += "x"
    return text, used


def random_any_string(rng: random.Random) -> str:
    """Any string from the alphabet, whitespace-only and fence-bearing ones included."""
    parts = [rng.choice(UNITS[rng.choice(KIND_NAMES)]) for _ in range(rng.randint(0, 14))]
    return "".join(parts)


def reference_normalize_source(text: str) -> str:
    """Requirement 5.10 written with regular expressions, not the code under test.

    Lone surrogates become `?`, the leading BOMs go, CRLF then CR become LF, and the string ends
    in exactly one LF.
    """
    cleaned = "".join("?" if 0xD800 <= ord(char) <= 0xDFFF else char for char in text)
    cleaned = re.sub(r"\A\ufeff+", "", cleaned)
    cleaned = re.sub(r"\r\n|\r", "\n", cleaned)
    return re.sub(r"\n*\Z", "", cleaned) + "\n"


def extracted(text: str) -> str:
    result = extract_main_ts(text)
    assert isinstance(result, ExtractOk), repr(text)
    assert result.ok is True
    return result.source


def rejected(text: str) -> None:
    result = extract_main_ts(text)
    assert isinstance(result, ExtractFail), repr(text)
    assert result.ok is False
    assert result.code == NO_CODE


# --- 1. normalize_source ------------------------------------------------------------------


@pytest.mark.parametrize("seed", range(SEEDS))
def test_normalize_source_is_idempotent_and_has_the_agreed_shape(seed: int) -> None:
    rng = random.Random(f"normalize-{seed}")
    for _ in range(STRINGS_PER_SEED):
        text = random_any_string(rng)
        once = normalize_source(text)
        assert normalize_source(once) == once, repr(text)
        assert once.endswith("\n")
        assert not once.endswith("\n\n")
        assert "\r" not in once
        assert not once.startswith(BOM)
        once.encode("utf-8")  # never a lone surrogate
        assert once == reference_normalize_source(text), repr(text)


@pytest.mark.parametrize("seed", range(SEEDS))
def test_normalize_source_changes_only_what_requirement_5_10_lists(seed: int) -> None:
    """Characters other than the leading BOMs, line breaks and surrogates are never touched."""
    rng = random.Random(f"preserve-{seed}")
    for _ in range(STRINGS_PER_SEED):
        text, _ = random_source(rng)
        out = normalize_source(text)
        expected_body = re.sub(r"\r\n|\r", "\n", re.sub(r"\A\ufeff+", "", text))
        expected_body = "".join(
            "?" if 0xD800 <= ord(char) <= 0xDFFF else char for char in expected_body
        )
        assert out.rstrip("\n") == expected_body.rstrip("\n")
        # No other whitespace is trimmed, and code is never cut.
        assert len(out) >= len(expected_body.rstrip("\n"))


def test_normalize_source_does_not_cut_a_source_over_the_size_limit() -> None:
    big = "x" * 40_000
    assert normalize_source(big) == big + "\n"
    assert extracted(f"{FENCE}ts\n{big}\n{FENCE}") == big + "\n"


# --- 2. the round trip of Requirement 5.11 -------------------------------------------------

LABELS = ("ts", "typescript", "TS", "TypeScript", "TYPESCRIPT", "Ts")
NEWLINES = ("\n", "\r\n")


def wrap(rng: random.Random, source: str, *, label: str | None = None) -> tuple[str, str]:
    """`source` inside a `ts` fence, and the style used (for the guard test)."""
    newline = rng.choice(NEWLINES)
    label = label or rng.choice(LABELS)
    return f"{FENCE}{label}{newline}{source}{newline}{FENCE}", label + repr(newline)


@pytest.mark.parametrize("seed", range(SEEDS))
def test_a_source_in_a_ts_fence_comes_back_normalized(seed: int) -> None:
    rng = random.Random(f"roundtrip-{seed}")
    for _ in range(STRINGS_PER_SEED):
        source, _ = random_source(rng)
        wrapped, _ = wrap(rng, source)
        assert extracted(wrapped) == normalize_source(source), repr(source)


@pytest.mark.parametrize("seed", range(SEEDS))
def test_prose_around_the_fence_and_other_blocks_do_not_change_the_result(seed: int) -> None:
    rng = random.Random(f"surround-{seed}")
    for _ in range(STRINGS_PER_SEED):
        source, _ = random_source(rng)
        other, _ = random_source(rng)
        wrapped, _ = wrap(rng, source, label=rng.choice(LABELS))
        before = rng.choice(
            [
                "",
                "Here is the file:\n\n",
                "Sure! `inline` code and **bold**\n",
                f"{FENCE}js\nconsole.log(1);\n{FENCE}\n",
                f"{FENCE}\nplain block\n{FENCE}\n",
                f"{FENCE}json\n{{}}\n{FENCE}\nand then:\n",
            ]
        )
        after = rng.choice(
            [
                "",
                "\nHope this helps.",
                "\n\n" + "prose " * 20,
                f"\n{FENCE}ts\n{other}\n{FENCE}",  # a later ts block: the first one wins
                f"\n{FENCE}typescript\nexport const second = 2;\n{FENCE}\n",
            ]
        )
        assert extracted(before + wrapped + after) == normalize_source(source), repr(source)


@pytest.mark.parametrize("seed", range(SEEDS))
def test_the_leading_bom_of_the_reply_is_dropped_before_the_fence_is_looked_for(seed: int) -> None:
    rng = random.Random(f"bom-{seed}")
    for _ in range(STRINGS_PER_SEED):
        source, _ = random_source(rng)
        wrapped, _ = wrap(rng, source)
        assert extracted(BOM * rng.randint(1, 3) + wrapped) == normalize_source(source)


# --- 3. a reply without a fence -----------------------------------------------------------

MARKERS = ("import", "export", "//", "/*")


@pytest.mark.parametrize("seed", range(SEEDS))
def test_a_reply_without_a_fence_that_starts_like_code_is_taken_whole(seed: int) -> None:
    rng = random.Random(f"plain-{seed}")
    for _ in range(STRINGS_PER_SEED):
        rest, _ = random_source(rng)
        lead = rng.choice(["", " ", "\n", "\t\n ", BOM, "\r\n"])
        text = lead + rng.choice(MARKERS) + rest
        assert extracted(text) == normalize_source(text), repr(text)


# --- 4. replies that hold no code ---------------------------------------------------------


@pytest.mark.parametrize("seed", range(SEEDS))
def test_replies_without_usable_code_fail_with_the_agent_code(seed: int) -> None:
    rng = random.Random(f"fail-{seed}")
    for _ in range(STRINGS_PER_SEED):
        source, _ = random_source(rng)
        whitespace = "".join(rng.choice(["", " ", "\n", "\t", "\r\n", "\u3000"]) for _ in range(4))
        cases = {
            "unclosed": f"{FENCE}ts\n{source}",
            "unclosed after prose": f"Here:\n{FENCE}typescript\n{source}\n",
            "whitespace only": f"{FENCE}ts\n{whitespace}\n{FENCE}",
            "only other labels": f"{FENCE}js\n{source}\n{FENCE}\n{FENCE}\n{source}\n{FENCE}",
            "bare fence": f"{FENCE}\n{source}\n{FENCE}",
            "info string is not a label": f"{FENCE}ts title=x\n{source}\n{FENCE}",
            "empty reply": "",
        }
        for name, text in cases.items():
            assert isinstance(extract_main_ts(text), ExtractFail), (name, repr(text))
            rejected(text)

        words = " ".join(
            rng.choice(["hello", "the", "code", "below", "sure", "ok"]) for _ in range(5)
        )
        rejected(words)
        rejected(f"{words}\n{source.replace(chr(0), '')}".replace(FENCE, ""))


@pytest.mark.parametrize("seed", range(SEEDS))
def test_extraction_never_raises_and_always_returns_one_of_two_shapes(seed: int) -> None:
    rng = random.Random(f"total-{seed}")
    for _ in range(STRINGS_PER_SEED):
        text = random_any_string(rng)
        if rng.random() < 0.5:
            text = rng.choice(["", FENCE + "ts\n", FENCE + "\n", "\n" + FENCE]) + text
        if rng.random() < 0.3:
            text += rng.choice(["\n" + FENCE, FENCE, "\n" + FENCE + "ts"])
        result = extract_main_ts(text)
        assert isinstance(result, ExtractOk | ExtractFail)
        if isinstance(result, ExtractOk):
            assert result.source == normalize_source(result.source)
            assert result.source.endswith("\n")
            result.source.encode("utf-8")
        else:
            assert result.code == NO_CODE


# --- guards -------------------------------------------------------------------------------


def test_the_generators_reach_every_unit_kind_and_every_shape() -> None:
    kinds: set[str] = set()
    sources: list[str] = []
    for seed in range(SEEDS):
        rng = random.Random(f"roundtrip-{seed}")
        for _ in range(STRINGS_PER_SEED):
            source, used = random_source(rng)
            kinds |= used
            sources.append(source)
    assert kinds == set(KIND_NAMES)
    joined = "".join(sources)
    assert "\r\n" in joined
    assert re.search(r"\r(?!\n)", joined)
    assert BOM + BOM in joined
    assert re.search(r"\ufeff.+\ufeff", joined, re.DOTALL)
    assert re.search("[\ud800-\udfff]", joined)
    assert "``" in joined
    assert any(s.endswith("\n") for s in sources)
    assert any(s.startswith("\n") for s in sources)
    assert any(s.startswith(BOM) for s in sources)
    assert len({len(s) for s in sources}) >= 20
    # Never a triple backtick, always something that is not whitespace (Python's definition).
    assert all(FENCE not in s for s in sources)
    assert all(any(not ch.isspace() for ch in s) for s in sources)

    # Both newline styles and all label spellings are used around the fence.
    styles: set[str] = set()
    for seed in range(SEEDS):
        rng = random.Random(f"roundtrip-{seed}")
        for _ in range(STRINGS_PER_SEED):
            source, _ = random_source(rng)
            _, style = wrap(rng, source)
            styles.add(style)
    assert len(styles) == len(LABELS) * len(NEWLINES)

    # Strings where normalization really changes something are common, so idempotence is tested
    # on strings that were not already normal.
    changed = 0
    for seed in range(SEEDS):
        rng = random.Random(f"normalize-{seed}")
        for _ in range(STRINGS_PER_SEED):
            text = random_any_string(rng)
            changed += normalize_source(text) != text
    assert changed > SEEDS * STRINGS_PER_SEED * 0.8


def test_the_bom_case_that_motivated_lstrip_is_in_the_generated_strings() -> None:
    """`removeprefix(BOM)` would leave a second BOM and fail idempotence; see `normalize_source`."""
    assert normalize_source(BOM + BOM + "x") == "x\n"
    assert normalize_source(normalize_source(BOM + BOM + "x")) == "x\n"
    hits = 0
    for seed in range(SEEDS):
        rng = random.Random(f"normalize-{seed}")
        for _ in range(STRINGS_PER_SEED):
            text = random_any_string(rng)
            hits += text.startswith(BOM + BOM)
    assert hits >= 5


def test_the_properties_catch_a_normalizer_that_is_not_idempotent() -> None:
    """Sharpness: a normalizer that drops one BOM, or fixes line breaks in the wrong order."""

    def one_bom(text: str) -> str:
        cleaned = text.removeprefix(BOM).replace("\r\n", "\n").replace("\r", "\n")
        return cleaned.rstrip("\n") + "\n"

    def cr_first(text: str) -> str:
        cleaned = text.lstrip(BOM).replace("\r", "\n").replace("\r\n", "\n")
        return cleaned.rstrip("\n") + "\n"

    def not_idempotent(function: Callable[[str], str]) -> int:
        failures = 0
        for seed in range(SEEDS):
            rng = random.Random(f"normalize-{seed}")
            for _ in range(STRINGS_PER_SEED):
                text = random_any_string(rng)
                failures += function(function(text)) != function(text)
        return failures

    def differs_from_reference(function: Callable[[str], str]) -> int:
        failures = 0
        for seed in range(SEEDS):
            rng = random.Random(f"normalize-{seed}")
            for _ in range(STRINGS_PER_SEED):
                text = random_any_string(rng)
                failures += function(text) != reference_normalize_source(text)
        return failures

    assert not_idempotent(one_bom) >= 1
    assert differs_from_reference(cr_first) >= 1
    assert not_idempotent(normalize_source) == 0
    assert differs_from_reference(normalize_source) == 0


def test_plain_cases_written_by_hand() -> None:
    """A few fixed examples so the generated checks are anchored to readable values."""
    assert extracted("```ts\nconst a = 1;\n```") == "const a = 1;\n"
    assert extracted("```TypeScript\r\nconst a = 1;\r\n```") == "const a = 1;\n"
    assert extracted("import x from 'y';") == "import x from 'y';\n"
    assert extracted("\ufeff// c\r\ncode\r\n\r\n\r\n") == "// c\ncode\n"
    rejected("just words")
    rejected("```ts\nunclosed")
    result: Any = extract_main_ts("```ts\n\n```")
    assert isinstance(result, ExtractFail)
