"""Tests for `extract_main_ts` and `normalize_source` (Requirement 5.9 to 5.12, design 6.4).

Why: Gemini answers in free text, and the verifier needs the bare `main.ts`. The extraction is the
one place that decides which part of the reply is code, so its rules are pinned as a table before
the code exists (tests-first, task 13.2):

- the first fenced block labelled `ts` or `typescript` (any letter case) wins; blocks with another
  label are skipped, and a fence line must match ``^```(\\S*)\\s*$`` exactly (an info string such as
  ``ts title=x`` is not a fence);
- an unclosed `ts` block, an empty one, a reply with fences but no `ts` block (also a bare
  ```` ``` ```` block), or prose without code gives `ExtractFail("AGENT_EXTRACT_NO_CODE")`;
- with no fence line at all the whole text is the source when it starts (after a trim) with
  `import`, `export`, `//` or `/*`;
- the result is normalized: no BOM, CRLF and CR become LF, exactly one LF at the end; a source
  above `limits.source_max_bytes` is never cut (the verifier reports it, Requirement 5.10);
- a lone surrogate (Gemini JSON can carry `\\ud800`) is replaced before anything else, so the
  source can always be encoded as UTF-8.

Each rule gets a hand-written case; the idempotence and round-trip properties over generated
strings belong to task 13.3 (`test_animation_extract_property.py`) and are not repeated here.
The size limit comes from the contract (`load_contract`), not from a literal, and the failure
code is checked against the `Diagnostic` model and the `AGENT` prefix of the contract.

No network, no database, no `langgraph` or `boto3`.
"""

from __future__ import annotations

import subprocess
import sys
from dataclasses import FrozenInstanceError
from pathlib import Path

import pytest

from app.ai.animation.contract import AGENT_PREFIX, ContractOk, load_contract
from app.ai.animation.models import Diagnostic
from app.ai.animation.prompts import ExtractFail, ExtractOk, extract_main_ts, normalize_source

BACKEND_DIR = Path(__file__).resolve().parent.parent

NO_CODE = "AGENT_EXTRACT_NO_CODE"
FENCE = "```"


def _contract():
    loaded = load_contract()
    assert isinstance(loaded, ContractOk), loaded
    return loaded.contract


def _extracted(text: str) -> str:
    result = extract_main_ts(text)
    assert isinstance(result, ExtractOk), result
    assert result.ok is True
    return result.source


def _rejected(text: str) -> ExtractFail:
    result = extract_main_ts(text)
    assert isinstance(result, ExtractFail), result
    assert result.ok is False
    assert result.code == NO_CODE
    return result


def _fenced(body: str, label: str = "ts") -> str:
    return f"{FENCE}{label}\n{body}\n{FENCE}"


# --- fenced blocks that are accepted ----------------------------------------------------------

SAMPLE = (
    "import { AbsoluteFill } from 'remotion';\n\n"
    "export default function Main() {\n  return null;\n}"
)


@pytest.mark.parametrize("label", ["ts", "typescript"])
def test_a_ts_or_typescript_block_gives_its_content(label: str) -> None:
    assert _extracted(_fenced(SAMPLE, label)) == SAMPLE + "\n"


@pytest.mark.parametrize("label", ["TS", "Ts", "tS", "TYPESCRIPT", "TypeScript", "tYpEsCrIpT"])
def test_labels_are_matched_without_regard_to_letter_case(label: str) -> None:
    assert _extracted(_fenced("export const a = 1;", label)) == "export const a = 1;\n"


def test_prose_before_and_after_the_block_is_dropped() -> None:
    text = f"Sure, here is the file:\n\n{_fenced('export const a = 1;')}\n\nHope it helps!\n"
    assert _extracted(text) == "export const a = 1;\n"


def test_the_first_ts_block_wins() -> None:
    first = _fenced("export const first = 1;")
    second = _fenced("export const second = 2;", "typescript")
    text = f"{first}\n\n{second}"
    assert _extracted(text) == "export const first = 1;\n"


@pytest.mark.parametrize("other", ["json", "tsx", "js", "javascript", "python", "diff", "ts2"])
def test_a_block_with_another_label_is_skipped(other: str) -> None:
    text = f"{_fenced('{}', other)}\n\n{_fenced('export const a = 1;')}"
    assert _extracted(text) == "export const a = 1;\n"


def test_an_unlabelled_block_is_skipped_when_a_ts_block_follows() -> None:
    text = f"{FENCE}\nnot code\n{FENCE}\n{_fenced('export const a = 1;')}"
    assert _extracted(text) == "export const a = 1;\n"


def test_a_fence_line_inside_another_block_is_content_not_a_fence() -> None:
    # The markdown block is open until a bare fence, so the ts fence inside it is just text.
    text = f"{FENCE}md\n{FENCE}ts\nexport const a = 1;\n{FENCE}\nafter\n"
    assert isinstance(extract_main_ts(text), ExtractFail)
    # A ts block that closes keeps another fence-like line as content (it is not a bare fence).
    inner = f"{FENCE}ts\nconst a = 1;\n{FENCE}js\nconst b = 2;\n{FENCE}"
    assert _extracted(inner) == f"const a = 1;\n{FENCE}js\nconst b = 2;\n"


def test_trailing_spaces_after_a_fence_are_allowed() -> None:
    assert _extracted(f"{FENCE}ts  \t\nexport const a = 1;\n{FENCE}   ") == "export const a = 1;\n"


def test_inline_backticks_in_the_source_are_kept() -> None:
    body = "const label = `a ${1 + 1} b`;\nconst two = ``;\nexport default label;"
    assert _extracted(_fenced(body)) == body + "\n"


def test_indentation_blank_lines_and_trailing_spaces_inside_the_block_are_kept() -> None:
    kept = "\n\nexport default function Main() {  \n\n\treturn null;\n}"
    assert _extracted(_fenced(kept + "\n\n\n")) == kept + "\n"


def test_unicode_text_inside_the_block_is_kept() -> None:
    body = "export const title = 'Vektor \u2192 \u00e9 \U0001f383';"
    assert _extracted(_fenced(body)) == body + "\n"


# --- fenced blocks and replies that fail ------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        pytest.param(f"{FENCE}ts", id="opener-only"),
        pytest.param(f"{FENCE}ts\n", id="opener-and-newline"),
        pytest.param(f"{FENCE}ts\nexport const a = 1;", id="unclosed-no-newline"),
        pytest.param(f"{FENCE}typescript\nexport const a = 1;\n", id="unclosed-typescript"),
        pytest.param(f"intro\n{FENCE}TS\nexport const a = 1;\nlost the closing fence", id="prose"),
    ],
)
def test_an_unclosed_ts_block_fails(text: str) -> None:
    _rejected(text)


@pytest.mark.parametrize(
    "text",
    [
        pytest.param(f"{FENCE}ts\n{FENCE}", id="no-lines"),
        pytest.param(f"{FENCE}ts\n\n{FENCE}", id="blank-line"),
        pytest.param(f"{FENCE}ts\n  \n\t\n{FENCE}", id="spaces-and-tabs"),
        pytest.param(f"{FENCE}typescript\r\n\r\n{FENCE}\r\n", id="crlf"),
        pytest.param(f"{FENCE}ts\n\u00a0\u2003\n{FENCE}", id="unicode-spaces"),
    ],
)
def test_a_ts_block_with_only_whitespace_fails(text: str) -> None:
    _rejected(text)


def test_an_empty_first_ts_block_does_not_fall_through_to_a_later_one() -> None:
    _rejected(f"{FENCE}ts\n\n{FENCE}\n{_fenced('export const a = 1;')}")


@pytest.mark.parametrize(
    "text",
    [
        pytest.param(_fenced("print(1)", "python"), id="other-label-only"),
        pytest.param(_fenced("export const a = 1;", "tsx"), id="tsx-is-not-ts"),
        pytest.param(_fenced("export const a = 1;", ""), id="unlabelled-block"),
        pytest.param(f"{FENCE}ts title=main\nexport const a = 1;\n{FENCE}", id="info-string"),
        pytest.param(f"import a from 'a';\n{FENCE}\n", id="source-start-but-a-fence-exists"),
        pytest.param(f"{FENCE}md\n{FENCE}ts\nconst a = 1;\n{FENCE}\n", id="ts-fence-inside-md"),
        pytest.param(f"{FENCE}python\nprint(1)\n", id="other-label-unclosed"),
    ],
)
def test_a_reply_with_fences_but_no_ts_block_fails(text: str) -> None:
    _rejected(text)


# --- text without any fence -------------------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        pytest.param("import { A } from 'remotion';\nexport default A;", id="import"),
        pytest.param("export const a = 1;\nexport default a;\n", id="export"),
        pytest.param("// main.ts\nexport const a = 1;", id="line-comment"),
        pytest.param("/* main.ts */\nexport const a = 1;", id="block-comment"),
        pytest.param("\n\n  import x from 'x';\n", id="leading-blank-lines-and-spaces"),
        pytest.param("\t// note\r\nexport const a = 1;\r\n", id="tab-and-crlf"),
        pytest.param("\ufeffimport x from 'x';\n", id="bom"),
        pytest.param("importing is not code but it does start with import", id="prefix-only"),
    ],
)
def test_text_without_fences_that_starts_like_code_is_the_source(text: str) -> None:
    assert _extracted(text) == normalize_source(text)


@pytest.mark.parametrize(
    "text",
    [
        pytest.param("", id="empty"),
        pytest.param("   \n\t\n", id="whitespace"),
        pytest.param("\ufeff", id="bom-only"),
        pytest.param("Sure! Here is the animation you asked for.", id="prose"),
        pytest.param("const a = 1;\nexport default a;", id="does-not-start-with-a-marker"),
        pytest.param("Import x from 'x';", id="import-is-case-sensitive"),
        pytest.param("/ not a comment\nimport x from 'x';", id="single-slash"),
        pytest.param("# import x\nexport const a = 1;", id="hash-first"),
        pytest.param("Here is `export const a = 1;` inline.", id="inline-backticks"),
        pytest.param("\ud800", id="lone-surrogate-only"),
    ],
)
def test_text_without_fences_that_does_not_start_like_code_fails(text: str) -> None:
    _rejected(text)


def test_a_ts_block_wins_over_a_source_like_start() -> None:
    text = f"import a from 'a';\n{_fenced('export const b = 2;')}"
    assert _extracted(text) == "export const b = 2;\n"


# --- normalization ----------------------------------------------------------------------------

NORMALIZE_TABLE = [
    pytest.param("", "\n", id="empty"),
    pytest.param("x", "x\n", id="no-newline"),
    pytest.param("x\n", "x\n", id="one-newline"),
    pytest.param("x\n\n\n", "x\n", id="many-newlines"),
    pytest.param("\n\n", "\n", id="only-newlines"),
    pytest.param("\n\nx", "\n\nx\n", id="leading-newlines-kept"),
    pytest.param("x  \ny \n", "x  \ny \n", id="trailing-spaces-kept"),
    pytest.param("  ", "  \n", id="only-spaces"),
    pytest.param("x\r\n", "x\n", id="crlf-end"),
    pytest.param("a\r\nb\r\n", "a\nb\n", id="crlf-lines"),
    pytest.param("a\rb\r", "a\nb\n", id="cr-lines"),
    pytest.param("a\r\r\nb", "a\n\nb\n", id="cr-then-crlf"),
    pytest.param("a\n\rb", "a\n\nb\n", id="lf-then-cr"),
    pytest.param("\ufeffx", "x\n", id="bom"),
    pytest.param("\ufeff\ufeffx", "x\n", id="two-boms"),
    pytest.param("\ufeff", "\n", id="bom-only"),
    pytest.param("\ufeff\r\nx\r\n", "\nx\n", id="bom-then-crlf"),
    pytest.param("a\ufeffb", "a\ufeffb\n", id="inner-bom-kept"),
    pytest.param("\nx\ufeff", "\nx\ufeff\n", id="bom-not-at-start-kept"),
    pytest.param("a\u2028b\u0085c\x0bd", "a\u2028b\u0085c\x0bd\n", id="other-breaks-kept"),
    pytest.param("a\ud800b", "a?b\n", id="lone-high-surrogate"),
    pytest.param("\udc00", "?\n", id="lone-low-surrogate"),
    pytest.param("\U0001f383", "\U0001f383\n", id="valid-pair-kept"),
]


@pytest.mark.parametrize(("raw", "expected"), NORMALIZE_TABLE)
def test_normalize_source_table(raw: str, expected: str) -> None:
    assert normalize_source(raw) == expected


@pytest.mark.parametrize(("raw", "expected"), NORMALIZE_TABLE)
def test_normalizing_twice_changes_nothing_on_the_table(raw: str, expected: str) -> None:
    assert normalize_source(expected) == expected
    assert normalize_source(normalize_source(raw)) == normalize_source(raw)


@pytest.mark.parametrize(("raw", "expected"), NORMALIZE_TABLE)
def test_normalized_source_always_encodes_as_utf8(raw: str, expected: str) -> None:
    assert normalize_source(raw).encode("utf-8").decode("utf-8") == expected


def test_a_fenced_block_is_normalized_like_normalize_source() -> None:
    text = "intro\r\n```ts\r\nexport const a = 1;\r\n\r\n```\r\noutro\r\n"
    assert _extracted(text) == "export const a = 1;\n"
    assert _extracted("\ufeff```TS\rexport const a = 1;\r```\r") == "export const a = 1;\n"
    assert _extracted("\ufeff\ufeff```ts\nexport const a = 1;\n```") == "export const a = 1;\n"


@pytest.mark.parametrize(
    "body",
    [
        pytest.param(SAMPLE, id="sample"),
        pytest.param("x", id="single-char"),
        pytest.param("\n\nx\n\n", id="newlines-around"),
        pytest.param("a\r\nb\rc", id="mixed-breaks"),
        pytest.param("\ufeffx", id="leading-bom-in-the-body"),
        pytest.param("\ufeff", id="bom-is-not-whitespace-for-str-strip"),
        pytest.param("a\ud800b", id="lone-surrogate"),
        pytest.param("  x  ", id="spaces-around"),
    ],
)
def test_fencing_a_body_and_extracting_it_gives_the_normalized_body(body: str) -> None:
    assert _extracted(_fenced(body)) == normalize_source(body)


def test_a_lone_surrogate_in_the_reply_is_replaced_before_extraction() -> None:
    source = _extracted(_fenced("const s = '\ud800';"))
    assert source == "const s = '?';\n"
    source.encode("utf-8")


# --- size -------------------------------------------------------------------------------------


def _bodies(limit: int) -> dict[str, str]:
    return {
        "one-under-with-newline": "x" * (limit - 1),
        "exactly-limit-plus-newline": "x" * limit,
        "far-above": ("x" * 79 + "\n") * (limit // 40),
        "multibyte": "// " + "\u00e9" * (limit // 2),
    }


@pytest.mark.parametrize(
    "name",
    ["one-under-with-newline", "exactly-limit-plus-newline", "far-above", "multibyte"],
)
def test_a_source_over_the_contract_limit_is_not_cut(name: str) -> None:
    limit = _contract().limits.source_max_bytes
    body = _bodies(limit)[name]
    source = _extracted(_fenced(body))
    assert source == normalize_source(body)
    assert len(source.encode("utf-8")) >= limit
    unfenced = _extracted("// start\n" + body)
    assert unfenced == normalize_source("// start\n" + body)


def test_the_size_cases_cross_the_limit_in_bytes_not_in_characters() -> None:
    limit = _contract().limits.source_max_bytes
    bodies = _bodies(limit)
    assert len(bodies["far-above"].encode("utf-8")) > limit
    multibyte = bodies["multibyte"]
    assert len(multibyte) < limit < len(multibyte.encode("utf-8"))


# --- result shape and failure code ------------------------------------------------------------


def test_results_are_frozen_and_carry_ok() -> None:
    ok = ExtractOk(source="x\n")
    fail = ExtractFail(code=NO_CODE)
    assert (ok.ok, fail.ok) == (True, False)
    with pytest.raises(FrozenInstanceError):
        ok.source = "y\n"  # type: ignore[misc]
    with pytest.raises(FrozenInstanceError):
        fail.code = "AGENT_OTHER"  # type: ignore[misc]


def test_the_failure_code_is_a_valid_agent_diagnostic_code() -> None:
    code = _rejected("no code here").code
    assert code.startswith(f"{AGENT_PREFIX}_")
    assert AGENT_PREFIX in _contract().diagnostic_code_prefixes
    diagnostic = Diagnostic.model_validate(
        {
            "tool": "agent",
            "code": code,
            "severity": "error",
            "message": "no TypeScript code block was found in the reply",
        }
    )
    assert diagnostic.code == NO_CODE


def test_extraction_never_raises_on_odd_input() -> None:
    for text in ["", "\n", FENCE, f"{FENCE}\n{FENCE}", "\x00", "\ud800\udc00", FENCE * 50]:
        assert isinstance(extract_main_ts(text), ExtractOk | ExtractFail)


# --- imports ----------------------------------------------------------------------------------


def test_importing_the_prompts_in_a_fresh_process_imports_no_heavy_packages() -> None:
    code = (
        "import sys\n"
        "import app.ai.animation.prompts\n"
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
