"""Guards on the written documents of the animation feature (task 35.4; Requirements 40.1, 40.7 to
40.10, 40.12, 38.9, 13.11, 16.1, 16.2, 16.6, 41.2, 41.4).

Why: `docs/infra/12-remotion-animation.md` is the one place an operator learns how to release, run
and debug the feature, and the steering files are what the next developer reads before touching it.
Nothing in a behaviour test notices when a section is renamed, an error code loses its row in the
troubleshooting table, an env name is spelled differently in the overview than in the code, the
`hop_limit = 2` explanation turns back into a bare `hop limit 1`, or an account id is pasted into a
document. These tests read the real files (paths relative to this file, never the network) and fail
when the text drifts.

How: every rule is a function over text that returns a list of problems (empty means fine). Each
rule is run on the real documents, and also on small invented texts (and on the real text with one
line damaged) to prove it can fail; a rule that only ever sees a clean tree proves nothing.

The rules:

1. document 12 has a `##` heading, without a number, for each section of Requirement 40.1 and the
   five runbook parts as `###`, at least one non-empty `mermaid` block (one in the architecture
   section), the words `Chromium` and `Firefox` (in the browser checklist), and `<ACCOUNT_ID>`
   (40.1, 40.7, 40.9);
2. the troubleshooting table (columns `Kode | Terlihat di | Penyebab | Tindakan`) has one row for
   each error code of Requirements 13.11 and 16.6 plus `PROVIDER_NOT_CONFIGURED` and
   `INVALID_REQUEST`, with the cause and the action filled in (40.8); the list of codes in this
   file is also compared with `ERROR_CODES` in the code;
3. each env of Requirements 16.1 and 16.2, `AI_ANIMATION_MODEL` and `NEXT_PUBLIC_ANIMATIONS` appears
   in document 12 and in `00-overview.md`, and the env table of document 12 has a row with the
   documented default (40.8);
4. document 12 and every steering file contain no 12-digit number, no signature query parameter and
   no access key id (40.9, 40.4); the documents of the feature are scanned for the same patterns;
5. the three RSS rows `RSS (a)`, `(b)` and `(c)` are rows of the table in "Batas dan kuota" only,
   with the 600 MiB threshold, and are either marked unmeasured or carry a number, a command and a
   UTC date (40.12, 41.2);
6. no line of `02`, `03` and `10` says `hop limit 1` without naming `web` or `nat`, and `02` and
   `03` state `hop_limit = 2` for `api` with the `boto3` reason (40.10);
7. the operator checklist and the release order are complete numbered tables, and the cost section
   marks unverified prices and asks for the user's approval (38.9, 41.4, 41.5);
8. the overview indexes document 12, the CI/CD document names the new jobs and the release
   workflow, and the roadmap has the R14 task with its six parts (40.2, 40.11).

Not here: the line `Total tambahan AWS per bulan: US$<angka>` in `07-cost-guardrails.md` and its
approval line are guarded by `scripts/ci/test-checkers.py` (task 35.5).
"""

from __future__ import annotations

import datetime
import re
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
INFRA_DOCS = REPO / "docs" / "infra"
STEERING = REPO / ".kiro" / "steering"

DOC12 = INFRA_DOCS / "12-remotion-animation.md"
OVERVIEW = INFRA_DOCS / "00-overview.md"
IAM = INFRA_DOCS / "02-iam-and-oidc.md"
COMPUTE = INFRA_DOCS / "03-compute.md"
CICD = INFRA_DOCS / "05-cicd.md"
COST = INFRA_DOCS / "07-cost-guardrails.md"
ROADMAP = INFRA_DOCS / "10-implementation-roadmap.md"
FEATURE_DOCS = (DOC12, OVERVIEW, IAM, COMPUTE, CICD, COST, ROADMAP)

# Requirement 40.1: one `##` heading per section, in the words of the requirement.
SECTIONS = (
    "Tujuan dan status",
    "Arsitektur",
    "Alur data",
    "Kontrak",
    "Variabel lingkungan",
    "Protokol SSE",
    "Tata letak S3",
    "Tabel database",
    "Infra dan IAM",
    "Urutan rilis",
    "Runbook",
    "Langkah manual admin",
    "Daftar periksa browser",
    "Biaya",
    "Keamanan dan sisa risiko",
    "Batas dan kuota",
    "Tabel pemecahan masalah",
)
# Requirement 40.1: the runbook parts, written as `###` headings inside the runbook section.
RUNBOOK_PARTS = (
    "Menyalakan",
    "Mematikan",
    "Rollback",
    "Memeriksa verifier",
    "Membaca log tanpa data sensitif",
)

# Requirement 13.11 (the closed set an `error` event may carry).
CODES_13_11 = (
    "ANIMATION_VERIFICATION_FAILED",
    "ANIMATION_TIMEOUT",
    "ANIMATION_VERIFIER_UNAVAILABLE",
    "ANIMATION_STORAGE_FAILED",
    "ANIMATION_QUOTA_EXCEEDED",
    "PROVIDER_UNAVAILABLE",
    "RATE_LIMITED",
    "UNKNOWN",
)
# Requirement 16.6 (the codes added to the status map of the envelope).
CODES_16_6 = (
    "ANIMATION_NOT_CONFIGURED",
    "ANIMATION_QUOTA_EXCEEDED",
    "ANIMATION_VERIFICATION_FAILED",
    "ANIMATION_TIMEOUT",
    "ANIMATION_VERIFIER_UNAVAILABLE",
    "ANIMATION_STORAGE_FAILED",
)
# Requirement 40.8 names these two as well.
CODES_OTHER = ("PROVIDER_NOT_CONFIGURED", "INVALID_REQUEST")
TROUBLESHOOTING_CODES = tuple(dict.fromkeys((*CODES_13_11, *CODES_16_6, *CODES_OTHER)))
TROUBLESHOOTING_HEADER = ("Kode", "Terlihat di", "Penyebab", "Tindakan")

# Requirement 16.1 and 16.2 with the default each states; `None` means the requirement gives none.
# `NEXT_PUBLIC_ANIMATIONS` defaults to `off` (Requirement 40.6, `frontend/.env.example`).
ENV_DEFAULTS: dict[str, str | None] = {
    "ANIMATION_RATE_PER_MINUTE_IP": "4",
    "ANIMATION_DAILY_PER_IP": "30",
    "ANIMATION_MAX_CONCURRENT_PER_IP": "1",
    "ANIMATION_MAX_CONCURRENT_GLOBAL": "2",
    "ANIMATION_MAX_ATTEMPTS": "4",
    "ANIMATION_DEADLINE_MS": "240000",
    "ANIMATION_ENABLED": "false",
    "ANIMATION_BUCKET": None,
    "ANIMATION_VERIFIER_FUNCTION": None,
    "AWS_REGION": None,
    "AI_ANIMATION_MODEL": None,
    "NEXT_PUBLIC_ANIMATIONS": "off",
}

RSS_LABELS = ("RSS (a)", "RSS (b)", "RSS (c)")
RSS_THRESHOLD = "600 MiB"
UNMEASURED = "[belum diverifikasi]"

FORBIDDEN_PATTERNS = {
    "a 12-digit number (an account id)": re.compile(r"\b\d{12}\b"),
    "a signature query parameter": re.compile(r"X-Amz-Signature"),
    "an access key id": re.compile(r"AKIA[0-9A-Z]{16}"),
}

# Spellings of "nothing here yet" that must not count as a filled cell.
PLACEHOLDERS = frozenset(
    {"", "-", "--", "\u2014", "\u2013", "n/a", "na", "tbd", "todo", "...", "\u2026"}
)

HOP_ONE = re.compile(r"hop[ _]limit\s*(?:=\s*)?1(?!\d)", re.IGNORECASE)
HOP_TWO = re.compile(r"hop[ _]limit\s*(?:=\s*)?2(?!\d)", re.IGNORECASE)
WEB_OR_NAT = re.compile(r"\b(?:web|nat)\b", re.IGNORECASE)
WORD_API = re.compile(r"\bapi\b", re.IGNORECASE)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


# --------------------------------------------------------------------------------------------
# A small Markdown reader: lines outside code fences, fenced blocks, headings, sections, tables.
# --------------------------------------------------------------------------------------------

OPEN_FENCE = re.compile(r"^[ \t]*(`{3,}|~{3,})(.*)$")
CLOSE_FENCE = re.compile(r"^[ \t]*(`{3,}|~{3,})[ \t]*$")
HEADING = re.compile(r"^(#{1,6})[ \t]+(\S.*?)[ \t]*$")
SEPARATOR = re.compile(r"^\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?$")


@dataclass(frozen=True)
class Line:
    no: int
    text: str
    fenced: bool


@dataclass(frozen=True)
class Block:
    language: str
    body: str
    line: int


@dataclass(frozen=True)
class Parsed:
    lines: tuple[Line, ...]
    blocks: tuple[Block, ...]
    unclosed_fence: bool


@dataclass(frozen=True)
class Table:
    header: tuple[str, ...]
    rows: tuple[tuple[str, ...], ...]
    line: int


def scan(text: str) -> Parsed:
    """Split `text` into lines, marking the ones inside a code fence, and collect fenced blocks.

    Split on `\\n` only (not `str.splitlines`, which also breaks on U+2028 and friends).
    """
    lines: list[Line] = []
    blocks: list[Block] = []
    fence: tuple[str, int] | None = None
    language = ""
    start = 0
    body: list[str] = []
    for no, raw in enumerate(text.split("\n"), start=1):
        raw = raw.rstrip("\r")
        if fence is None:
            opening = OPEN_FENCE.match(raw)
            if opening and not (opening.group(1)[0] == "`" and "`" in opening.group(2)):
                fence = (opening.group(1)[0], len(opening.group(1)))
                info = opening.group(2).split()
                language = info[0] if info else ""
                start = no
                body = []
                lines.append(Line(no, raw, True))
            else:
                lines.append(Line(no, raw, False))
            continue
        closing = CLOSE_FENCE.match(raw)
        if closing and closing.group(1)[0] == fence[0] and len(closing.group(1)) >= fence[1]:
            blocks.append(Block(language, "\n".join(body), start))
            fence = None
        else:
            body.append(raw)
        lines.append(Line(no, raw, True))
    return Parsed(tuple(lines), tuple(blocks), fence is not None)


def heading_of(line: Line) -> tuple[int, str] | None:
    """`(level, title)` when the line is a Markdown heading outside a code fence."""
    if line.fenced:
        return None
    found = HEADING.match(line.text)
    return (len(found.group(1)), found.group(2)) if found else None


def section(
    parsed: Parsed, title: str, level: int = 2, *, prefix: bool = False
) -> tuple[Line, ...] | None:
    """The lines under the first heading of `level` called `title`, up to the next heading of the
    same or a higher level. `None` when there is no such heading."""
    wanted = title.casefold()
    inside: list[Line] = []
    found = False
    for line in parsed.lines:
        head = heading_of(line)
        if not found:
            if head and head[0] == level:
                name = head[1].casefold()
                if name.startswith(wanted) if prefix else name == wanted:
                    found = True
            continue
        if head and head[0] <= level:
            break
        inside.append(line)
    return tuple(inside) if found else None


def split_row(line: str) -> tuple[str, ...]:
    """Cells of one table row. A `|` inside a backtick span or written `\\|` stays in its cell."""
    body = line.strip()
    if body.startswith("|"):
        body = body[1:]
    if body.endswith("|") and not body.endswith("\\|"):
        body = body[:-1]
    cells: list[str] = []
    current: list[str] = []
    in_code = False
    index = 0
    while index < len(body):
        char = body[index]
        if char == "\\" and body[index + 1 : index + 2] == "|":
            current.append("|")
            index += 2
            continue
        if char == "`":
            in_code = not in_code
        if char == "|" and not in_code:
            cells.append("".join(current).strip())
            current = []
        else:
            current.append(char)
        index += 1
    cells.append("".join(current).strip())
    return tuple(cells)


def tables(lines: tuple[Line, ...]) -> list[Table]:
    """Every pipe table in `lines` (a header row, a separator row, then the rows that follow)."""
    found: list[Table] = []
    index = 0
    while index < len(lines):
        head = lines[index]
        nxt = lines[index + 1] if index + 1 < len(lines) else None
        is_table = (
            not head.fenced
            and head.text.strip().startswith("|")
            and nxt is not None
            and not nxt.fenced
            and SEPARATOR.match(nxt.text.strip()) is not None
        )
        if not is_table:
            index += 1
            continue
        rows: list[tuple[str, ...]] = []
        cursor = index + 2
        while cursor < len(lines):
            row = lines[cursor]
            if row.fenced or not row.text.strip().startswith("|"):
                break
            rows.append(split_row(row.text))
            cursor += 1
        found.append(Table(split_row(head.text), tuple(rows), head.no))
        index = cursor
    return found


def plain(cell: str) -> str:
    """A cell without the backticks around it."""
    return cell.strip().strip("`").strip()


def filled(cell: str) -> bool:
    """True when the cell says something: not empty, not a dash, not a to-do marker."""
    text = cell.strip()
    return re.search(r"\w", text) is not None and text.casefold() not in PLACEHOLDERS


def table_with_header(
    parsed: Parsed, title: str, first: str, *, prefix: bool = False
) -> tuple[Table | None, str | None]:
    """The first table of section `title` whose first header cell is `first`, or the problem."""
    lines = section(parsed, title, prefix=prefix)
    if lines is None:
        return None, f"no '{title}' section"
    for table in tables(lines):
        if table.header and table.header[0] == first:
            return table, None
    return None, f"no table starting with '{first}' in '{title}'"


# --------------------------------------------------------------------------------------------
# Rules. Each returns a list of problems; an empty list means the text passes.
# --------------------------------------------------------------------------------------------


def structure_problems(parsed: Parsed) -> list[str]:
    """Requirement 40.1 and 40.7: the sections, unnumbered, and the runbook parts."""
    problems: list[str] = []
    level_two = [h for h in map(heading_of, parsed.lines) if h and h[0] == 2]
    titles = [title.casefold() for _, title in level_two]
    for wanted in SECTIONS:
        count = titles.count(wanted.casefold())
        if count == 0:
            problems.append(f"missing the '## {wanted}' section")
        elif count > 1:
            problems.append(f"the '## {wanted}' heading appears {count} times")
    for _, title in level_two:
        if re.match(r"\d+(\.\d+)*[.)]?\s", title):
            problems.append(f"the '## {title}' heading is numbered")
    if parsed.unclosed_fence:
        problems.append("a code fence is never closed, so the headings after it are not read")
    runbook = section(parsed, "Runbook")
    if runbook is not None:
        parts = {h[1].casefold() for h in map(heading_of, runbook) if h and h[0] == 3}
        for part in RUNBOOK_PARTS:
            if part.casefold() not in parts:
                problems.append(f"the runbook has no '### {part}' part")
    return problems


def diagram_problems(parsed: Parsed) -> list[str]:
    """Requirement 40.1 and 40.7: a non-empty `mermaid` block, one of them in the architecture."""
    drawn = [b for b in parsed.blocks if b.language.casefold() == "mermaid" and b.body.strip()]
    if not drawn:
        return ["no non-empty mermaid block"]
    architecture = section(parsed, "Arsitektur")
    if not architecture:
        return ["no 'Arsitektur' section to hold a diagram"]
    first, last = architecture[0].no, architecture[-1].no
    if not any(first <= b.line <= last for b in drawn):
        return ["the 'Arsitektur' section has no mermaid block"]
    return []


def browser_problems(parsed: Parsed, text: str) -> list[str]:
    """Requirement 40.7: both browsers are named, and in the browser checklist."""
    problems: list[str] = []
    checklist = section(parsed, "Daftar periksa browser")
    checklist_text = "\n".join(line.text for line in checklist or ())
    for word in ("Chromium", "Firefox"):
        pattern = re.compile(rf"\b{word}\b")
        if not pattern.search(text):
            problems.append(f"the word {word} is not in the document")
        elif not pattern.search(checklist_text):
            problems.append(f"the word {word} is not in the 'Daftar periksa browser' section")
    return problems


def placeholder_problems(text: str) -> list[str]:
    """Requirement 40.9: the account id is written as `<ACCOUNT_ID>`."""
    return [] if "<ACCOUNT_ID>" in text else ["the document never writes <ACCOUNT_ID>"]


def forbidden_pattern_problems(label: str, text: str) -> list[str]:
    """Requirements 40.4 and 40.9: no account id, signature parameter or access key id."""
    return [
        f"{label}: contains {what}"
        for what, pattern in FORBIDDEN_PATTERNS.items()
        if pattern.search(text)
    ]


def troubleshooting_problems(
    parsed: Parsed, codes: tuple[str, ...] = TROUBLESHOOTING_CODES
) -> list[str]:
    """Requirement 40.8: one row per error code, with the cause and the action filled in."""
    lines = section(parsed, "Tabel pemecahan masalah")
    if lines is None:
        return ["no 'Tabel pemecahan masalah' section"]
    chosen = [t for t in tables(lines) if t.header == TROUBLESHOOTING_HEADER]
    if not chosen:
        return [f"no table with the columns {' | '.join(TROUBLESHOOTING_HEADER)}"]
    problems: list[str] = []
    by_code: dict[str, list[tuple[str, ...]]] = {}
    for table in chosen:
        for row in table.rows:
            if len(row) != len(TROUBLESHOOTING_HEADER):
                problems.append(f"the row starting '{row[0] if row else ''}' has {len(row)} cells")
                continue
            by_code.setdefault(plain(row[0]), []).append(row)
    for code in codes:
        rows = by_code.get(code, [])
        if not rows:
            problems.append(f"{code}: no row in the troubleshooting table")
            continue
        if len(rows) > 1:
            problems.append(f"{code}: {len(rows)} rows in the troubleshooting table")
        for row in rows:
            if not filled(row[2]):
                problems.append(f"{code}: the cause cell is empty")
            if not filled(row[3]):
                problems.append(f"{code}: the action cell is empty")
    return problems


def env_presence_problems(label: str, text: str) -> list[str]:
    """Requirement 40.8: every animation env is written (as a whole name) in the document."""
    return [
        f"{label}: {name} is not written"
        for name in ENV_DEFAULTS
        if not re.search(rf"(?<![A-Za-z0-9_]){name}(?![A-Za-z0-9_])", text)
    ]


def env_table_problems(parsed: Parsed) -> list[str]:
    """Document 12: the env table has a row per env, with the default Requirement 16 states."""
    table, problem = table_with_header(parsed, "Variabel lingkungan", "Env")
    if table is None:
        return [problem or "no env table"]
    if "Default" not in table.header:
        return ["the env table has no 'Default' column"]
    column = table.header.index("Default")
    rows = {plain(row[0]): row for row in table.rows if len(row) == len(table.header)}
    problems: list[str] = []
    for name, default in ENV_DEFAULTS.items():
        row = rows.get(name)
        if row is None:
            problems.append(f"{name}: no row in the env table")
        elif default is not None and plain(row[column]) != default:
            problems.append(f"{name}: the default is '{plain(row[column])}', not '{default}'")
    return problems


def rss_problems(parsed: Parsed) -> list[str]:
    """Requirements 40.12 and 41.2: the three RSS rows, only in 'Batas dan kuota'."""
    lines = section(parsed, "Batas dan kuota")
    if lines is None:
        return ["no 'Batas dan kuota' section"]
    inside = tables(lines)
    memory = [t for t in inside if t.header and t.header[0] == "Baris"]
    if not memory:
        return ["no table starting with 'Baris' (the RSS table) in 'Batas dan kuota'"]
    problems: list[str] = []
    rows = [row for table in memory for row in table.rows]
    for label in RSS_LABELS:
        count = sum(1 for row in rows if row and plain(row[0]) == label)
        if count != 1:
            problems.append(f"{label}: {count} rows in 'Batas dan kuota', expected 1")
    inside_lines = {table.line for table in inside}
    for table in tables(parsed.lines):
        if table.line not in inside_lines and any(
            row and plain(row[0]) in RSS_LABELS for row in table.rows
        ):
            problems.append(f"an RSS row is outside 'Batas dan kuota' (table at line {table.line})")
    header = memory[0].header
    needed = ("Ambang", "Nilai (MiB)", "Perintah yang dijalankan", "Tanggal UTC")
    missing = [name for name in needed if name not in header]
    if missing:
        return [*problems, f"the RSS table has no column {', '.join(missing)}"]
    threshold, value, command, date = (header.index(name) for name in needed)
    for row in rows:
        name = plain(row[0]) if row else "?"
        if len(row) != len(header):
            problems.append(f"{name}: {len(row)} cells, expected {len(header)}")
            continue
        if RSS_THRESHOLD not in row[threshold]:
            problems.append(f"{name}: the threshold is not {RSS_THRESHOLD}")
        measured = plain(row[value])
        if measured == UNMEASURED:
            continue
        if not re.fullmatch(r"\d+(\.\d+)?", measured):
            problems.append(f"{name}: the value '{measured}' is neither a number nor {UNMEASURED}")
            continue
        if not filled(row[command]):
            problems.append(f"{name}: a measured value has no command")
        day = plain(row[date])
        try:
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
                raise ValueError(day)
            datetime.date.fromisoformat(day)
        except ValueError:
            problems.append(f"{name}: a measured value needs a UTC date YYYY-MM-DD, not '{day}'")
    return problems


def hop_one_problems(label: str, text: str) -> list[str]:
    """Requirement 40.10: no line says `hop limit 1` without naming `web` or `nat`."""
    return [
        f"{label}:{no}: 'hop limit 1' without web or nat"
        for no, line in enumerate(text.split("\n"), start=1)
        if HOP_ONE.search(line) and not WEB_OR_NAT.search(line)
    ]


def hop_two_problems(label: str, text: str) -> list[str]:
    """Requirement 40.10: `hop_limit = 2` for `api`, with the `boto3` credential reason."""
    lines = text.split("\n")
    problems: list[str] = []
    if not any("hop_limit = 2" in line and WORD_API.search(line) for line in lines):
        problems.append(f"{label}: no line with 'hop_limit = 2' for api")
    if not any(HOP_TWO.search(line) and "boto3" in line for line in lines):
        problems.append(f"{label}: no hop limit 2 line gives the boto3 credential reason")
    return problems


def numbered_rows_problems(
    parsed: Parsed, title: str, first: str, prefix: str, minimum: int
) -> list[str]:
    """A table whose first column counts `prefix1`, `prefix2`, ... with every cell filled in."""
    table, problem = table_with_header(parsed, title, first)
    if table is None:
        return [problem or f"no table in '{title}'"]
    problems: list[str] = []
    if len(table.rows) < minimum:
        problems.append(f"'{title}' has {len(table.rows)} rows, expected at least {minimum}")
    for index, row in enumerate(table.rows, start=1):
        if len(row) != len(table.header):
            problems.append(f"'{title}' row {index} has {len(row)} cells")
        elif plain(row[0]) != f"{prefix}{index}":
            problems.append(f"'{title}' row {index} is '{plain(row[0])}', not {prefix}{index}")
        elif not all(filled(cell) for cell in row):
            problems.append(f"'{title}' row {prefix}{index} has an empty cell")
    return problems


def cost_problems(parsed: Parsed) -> list[str]:
    """Requirements 41.4 and 41.5 as far as document 12 goes: inputs, formulas, approval."""
    lines = section(parsed, "Biaya")
    if lines is None:
        return ["no 'Biaya' section"]
    text = "\n".join(line.text for line in lines)
    problems: list[str] = []
    if not any({"Masukan", "Rumus"} <= set(t.header) for t in tables(lines)):
        problems.append("the cost table has no 'Masukan' and 'Rumus' columns")
    if UNMEASURED not in text:
        problems.append(f"no {UNMEASURED} marker for the prices not yet checked")
    if not re.search(r"US\$5\b", text):
        problems.append("the US$5 threshold is not named")
    if not re.search(r"persetujuan pengguna", text, re.IGNORECASE):
        problems.append("the user's approval is not mentioned")
    if "paket Free" not in text or "kredit promo" not in text:
        problems.append("the 'paket Free' and 'kredit promo' statement is missing")
    return problems


def overview_problems(text: str) -> list[str]:
    """Requirement 40.2: the overview indexes document 12 and names the Component."""
    problems: list[str] = []
    if "(./12-remotion-animation.md)" not in text:
        problems.append("the overview has no link to 12-remotion-animation.md")
    if not re.search(r"Component\s*=\s*animation", text):
        problems.append("the overview does not name Component=animation")
    return problems


def cicd_problems(text: str) -> list[str]:
    """Requirement 40.11: the two jobs and the release workflow are described."""
    wanted = ("`verifier`", "`contracts`", "ci/verifier", "ci/contracts", "release-verifier.yml")
    return [f"05-cicd.md does not mention {item}" for item in wanted if item not in text]


def roadmap_problems(parsed: Parsed) -> list[str]:
    """Requirement 40.2: the R14 task with purpose, guide, tests, demo, cost and pull requests."""
    lines = section(parsed, "R14", level=3, prefix=True)
    if lines is None:
        return ["the roadmap has no '### R14' task"]
    text = "\n".join(line.text for line in lines)
    return [
        f"the R14 task has no '{label}' part"
        for label in ("Tujuan", "Panduan", "Pengujian", "Demo", "Biaya", "PR")
        if not re.search(rf"^\s*[-*]\s+\*\*{re.escape(label)}\.\*\*", text, re.MULTILINE)
    ]


# --------------------------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def doc12() -> str:
    return read(DOC12)


@pytest.fixture(scope="module")
def parsed12(doc12: str) -> Parsed:
    return scan(doc12)


def steering_files() -> list[Path]:
    return sorted(STEERING.glob("*.md"))


def edit_line(text: str, starts_with: str, change: Callable[[str], str]) -> str:
    """`text` with the one line that starts with `starts_with` changed; fails if not found once."""
    lines = text.split("\n")
    hits = [i for i, line in enumerate(lines) if line.startswith(starts_with)]
    assert len(hits) == 1, f"expected one line starting {starts_with!r}, found {len(hits)}"
    lines[hits[0]] = change(lines[hits[0]])
    return "\n".join(lines)


# --------------------------------------------------------------------------------------------
# The real documents
# --------------------------------------------------------------------------------------------


def test_document_12_has_every_section_and_runbook_part(parsed12: Parsed) -> None:
    assert structure_problems(parsed12) == []


def test_document_12_has_a_mermaid_diagram_in_the_architecture(parsed12: Parsed) -> None:
    assert diagram_problems(parsed12) == []


def test_document_12_names_both_browsers_in_the_checklist(doc12: str, parsed12: Parsed) -> None:
    assert browser_problems(parsed12, doc12) == []


def test_document_12_writes_the_account_placeholder(doc12: str) -> None:
    assert placeholder_problems(doc12) == []


def test_steering_has_the_files_requirement_40_3_names() -> None:
    names = {path.stem for path in steering_files()}
    wanted = {
        "ai-pipeline",
        "backend",
        "infra",
        "persistence",
        "game-engine",
        "structure",
        "tech",
        "product",
        "known-issues",
        "conventions",
    }
    assert wanted <= names, f"missing steering files: {sorted(wanted - names)}"


@pytest.mark.parametrize(
    "path",
    [*FEATURE_DOCS, *steering_files()],
    ids=lambda path: path.relative_to(REPO).as_posix(),
)
def test_documents_hide_account_ids_signatures_and_keys(path: Path) -> None:
    assert forbidden_pattern_problems(path.name, read(path)) == []


def test_troubleshooting_table_covers_every_error_code(parsed12: Parsed) -> None:
    assert troubleshooting_problems(parsed12) == []


def test_error_codes_in_this_file_are_the_ones_the_code_can_send() -> None:
    """If the agent gains a code, the troubleshooting table and this file must gain it too."""
    from app.ai.animation.models import ERROR_CODES

    assert set(ERROR_CODES) == set(CODES_13_11)
    assert set(CODES_13_11) <= set(TROUBLESHOOTING_CODES)


def test_every_animation_env_is_in_document_12_and_the_overview(doc12: str) -> None:
    problems = [
        *env_presence_problems("12-remotion-animation.md", doc12),
        *env_presence_problems("00-overview.md", read(OVERVIEW)),
    ]
    assert problems == []


def test_env_table_in_document_12_has_the_documented_defaults(parsed12: Parsed) -> None:
    assert env_table_problems(parsed12) == []


def test_rss_rows_are_in_limits_and_quotas_with_the_threshold(parsed12: Parsed) -> None:
    assert rss_problems(parsed12) == []


@pytest.mark.parametrize("path", [IAM, COMPUTE, ROADMAP], ids=lambda path: path.name)
def test_no_hop_limit_1_line_without_web_or_nat(path: Path) -> None:
    assert hop_one_problems(path.name, read(path)) == []


@pytest.mark.parametrize("path", [IAM, COMPUTE], ids=lambda path: path.name)
def test_hop_limit_2_is_stated_for_api_with_the_boto3_reason(path: Path) -> None:
    assert hop_two_problems(path.name, read(path)) == []


def test_operator_checklist_is_a_complete_numbered_table(parsed12: Parsed) -> None:
    """Requirement 38.9: what only an operator can prove is a checklist item in document 12."""
    assert numbered_rows_problems(parsed12, "Langkah manual admin", "No", "O-", 10) == []


def test_release_order_has_its_seven_numbered_steps(parsed12: Parsed) -> None:
    assert numbered_rows_problems(parsed12, "Urutan rilis", "Langkah", "", 7) == []


def test_cost_section_marks_unverified_prices_and_asks_for_approval(parsed12: Parsed) -> None:
    assert cost_problems(parsed12) == []


def test_overview_indexes_document_12() -> None:
    assert overview_problems(read(OVERVIEW)) == []


def test_cicd_document_names_the_new_jobs_and_workflow() -> None:
    assert cicd_problems(read(CICD)) == []


def test_roadmap_has_the_r14_task_with_its_six_parts() -> None:
    assert roadmap_problems(scan(read(ROADMAP))) == []


# --------------------------------------------------------------------------------------------
# Each rule on invented text that breaks it
# --------------------------------------------------------------------------------------------


def sections_text(skip: tuple[str, ...] = (), *, runbook_parts: bool = True) -> str:
    out: list[str] = ["# 12 Title", ""]
    for title in SECTIONS:
        if title in skip:
            continue
        out += [f"## {title}", "", "text", ""]
        if title == "Arsitektur":
            out += ["```mermaid", "flowchart LR", "  a --> b", "```", ""]
        if title == "Runbook" and runbook_parts:
            for part in RUNBOOK_PARTS:
                out += [f"### {part}", "", "text", ""]
    return "\n".join(out)


def test_structure_rule_accepts_a_complete_invented_document() -> None:
    assert structure_problems(scan(sections_text())) == []


def test_structure_rule_names_a_missing_section() -> None:
    problems = structure_problems(scan(sections_text(skip=("Biaya",))))
    assert problems == ["missing the '## Biaya' section"]


def test_structure_rule_rejects_a_numbered_heading() -> None:
    text = sections_text().replace("## Biaya", "## 3. Biaya")
    problems = structure_problems(scan(text))
    assert any("'## 3. Biaya' heading is numbered" in p for p in problems)
    assert any("missing the '## Biaya'" in p for p in problems)


def test_structure_rule_does_not_count_a_heading_inside_a_code_fence() -> None:
    text = sections_text(skip=("Biaya",)) + "\n```md\n## Biaya\n```\n"
    assert structure_problems(scan(text)) == ["missing the '## Biaya' section"]


def test_structure_rule_does_not_count_a_level_three_heading_as_a_section() -> None:
    text = sections_text(skip=("Biaya",)) + "\n### Biaya\n"
    assert structure_problems(scan(text)) == ["missing the '## Biaya' section"]


def test_structure_rule_rejects_a_repeated_heading() -> None:
    problems = structure_problems(scan(sections_text() + "\n## Biaya\n\nmore\n"))
    assert problems == ["the '## Biaya' heading appears 2 times"]


def test_structure_rule_rejects_an_unclosed_fence() -> None:
    problems = structure_problems(scan(sections_text() + "\n```bash\nls\n"))
    assert problems == ["a code fence is never closed, so the headings after it are not read"]


def test_structure_rule_names_a_missing_runbook_part() -> None:
    text = sections_text().replace("### Rollback", "#### Rollback")
    assert structure_problems(scan(text)) == ["the runbook has no '### Rollback' part"]


def test_diagram_rule_needs_a_non_empty_mermaid_block() -> None:
    assert diagram_problems(scan(sections_text())) == []
    plain_fence = sections_text().replace("```mermaid", "```text")
    assert diagram_problems(scan(plain_fence)) == ["no non-empty mermaid block"]
    empty = sections_text().replace("flowchart LR\n  a --> b", "")
    assert diagram_problems(scan(empty)) == ["no non-empty mermaid block"]


def test_diagram_rule_wants_the_diagram_in_the_architecture_section() -> None:
    text = sections_text().replace("```mermaid\nflowchart LR\n  a --> b\n```", "")
    text += "\n```mermaid\nflowchart LR\n  a --> b\n```\n"
    assert diagram_problems(scan(text)) == ["the 'Arsitektur' section has no mermaid block"]


def test_browser_rule_wants_both_browsers_in_the_checklist() -> None:
    both = "## Daftar periksa browser\n\nChromium dan Firefox\n"
    assert browser_problems(scan(both), both) == []
    one = "## Daftar periksa browser\n\nChromium saja\n"
    assert browser_problems(scan(one), one) == ["the word Firefox is not in the document"]
    elsewhere = "## Daftar periksa browser\n\nChromium\n\n## Lain\n\nFirefox\n"
    assert browser_problems(scan(elsewhere), elsewhere) == [
        "the word Firefox is not in the 'Daftar periksa browser' section"
    ]
    glued = "## Daftar periksa browser\n\nChromiumX dan Firefox\n"
    assert browser_problems(scan(glued), glued) == ["the word Chromium is not in the document"]


def test_placeholder_rule_wants_account_id_in_angle_brackets() -> None:
    assert placeholder_problems("bucket lore-prod-animations-<ACCOUNT_ID>") == []
    assert placeholder_problems("bucket lore-prod-animations-ACCOUNT_ID") != []


def test_forbidden_pattern_rule_flags_each_pattern() -> None:
    account = "123456789012"
    key = "AKIA" + "A" * 16
    signature = "X-Amz-" + "Signature=abc"
    assert forbidden_pattern_problems("x", f"akun {account} dipakai") == [
        "x: contains a 12-digit number (an account id)"
    ]
    assert forbidden_pattern_problems("x", f"?{signature}&y=1") == [
        "x: contains a signature query parameter"
    ]
    assert forbidden_pattern_problems("x", f"key {key}") == ["x: contains an access key id"]
    both = forbidden_pattern_problems("x", f"{account} {key}")
    assert len(both) == 2


def test_forbidden_pattern_rule_leaves_near_misses_alone() -> None:
    near = [
        "id <ACCOUNT_ID>",
        "angka 12345678901 (11 digit)",
        "angka 1234567890123 (13 digit)",
        "X-Amz-Expires=300",
        "AKIA" + "A" * 15,
        "AKIA" + "a" * 16,
    ]
    for text in near:
        assert forbidden_pattern_problems("x", text) == [], text


TROUBLE_HEADER_ROW = "| Kode | Terlihat di | Penyebab | Tindakan |"


def trouble_text(rows: list[str], header: str = TROUBLE_HEADER_ROW) -> str:
    return "\n".join(["## Tabel pemecahan masalah", "", header, "|---|---|---|---|", *rows, ""])


def trouble_rows(skip: tuple[str, ...] = ()) -> list[str]:
    return [
        f"| `{code}` | di mana | sebab yang nyata | tindakan yang nyata |"
        for code in TROUBLESHOOTING_CODES
        if code not in skip
    ]


def test_troubleshooting_rule_accepts_a_complete_invented_table() -> None:
    assert troubleshooting_problems(scan(trouble_text(trouble_rows()))) == []


def test_troubleshooting_rule_names_a_code_without_a_row() -> None:
    problems = troubleshooting_problems(scan(trouble_text(trouble_rows(skip=("UNKNOWN",)))))
    assert problems == ["UNKNOWN: no row in the troubleshooting table"]


def test_troubleshooting_rule_rejects_an_empty_cause_or_action() -> None:
    rows = trouble_rows(skip=("RATE_LIMITED", "UNKNOWN"))
    rows.append("| `RATE_LIMITED` | di mana |  | tindakan yang nyata |")
    rows.append("| `UNKNOWN` | di mana | sebab yang nyata |  |")
    problems = troubleshooting_problems(scan(trouble_text(rows)))
    assert problems == [
        "RATE_LIMITED: the cause cell is empty",
        "UNKNOWN: the action cell is empty",
    ]


@pytest.mark.parametrize("marker", ["-", "--", "TBD", "todo", "n/a", "...", "\u2026", "\u2014"])
def test_troubleshooting_rule_rejects_a_placeholder_action(marker: str) -> None:
    rows = [*trouble_rows(skip=("UNKNOWN",)), f"| `UNKNOWN` | di mana | sebab nyata | {marker} |"]
    problems = troubleshooting_problems(scan(trouble_text(rows)))
    assert problems == ["UNKNOWN: the action cell is empty"]


def test_troubleshooting_rule_wants_the_code_in_a_table_row_not_in_prose() -> None:
    text = trouble_text(trouble_rows(skip=("UNKNOWN",))) + "\nKode `UNKNOWN` ada di prosa.\n"
    assert troubleshooting_problems(scan(text)) == ["UNKNOWN: no row in the troubleshooting table"]


def test_troubleshooting_rule_ignores_a_table_under_another_heading() -> None:
    text = trouble_text(trouble_rows()).replace(
        "## Tabel pemecahan masalah", "## Tabel pemecahan lain"
    )
    assert troubleshooting_problems(scan(text)) == ["no 'Tabel pemecahan masalah' section"]


def test_troubleshooting_rule_ignores_a_table_with_other_columns() -> None:
    text = trouble_text(trouble_rows(), header="| Kode | Penyebab | Tindakan | Catatan |")
    problems = troubleshooting_problems(scan(text))
    assert problems == ["no table with the columns Kode | Terlihat di | Penyebab | Tindakan"]


def test_troubleshooting_rule_rejects_a_row_with_a_missing_cell() -> None:
    rows = [*trouble_rows(skip=("UNKNOWN",)), "| `UNKNOWN` | di mana | sebab nyata |"]
    problems = troubleshooting_problems(scan(trouble_text(rows)))
    assert "the row starting '`UNKNOWN`' has 3 cells" in problems
    assert "UNKNOWN: no row in the troubleshooting table" in problems


def test_troubleshooting_rule_rejects_a_repeated_code() -> None:
    rows = [*trouble_rows(), "| `UNKNOWN` | lain | sebab lain | tindakan lain |"]
    problems = troubleshooting_problems(scan(trouble_text(rows)))
    assert problems == ["UNKNOWN: 2 rows in the troubleshooting table"]


def test_troubleshooting_rule_reads_pipes_inside_code_and_escaped_pipes() -> None:
    rows = trouble_rows(skip=("UNKNOWN",))
    rows.append("| `UNKNOWN` | `a | b` | sebab \\| nyata | tindakan nyata |")
    assert troubleshooting_problems(scan(trouble_text(rows))) == []


def test_troubleshooting_rule_does_not_read_a_table_inside_a_code_fence() -> None:
    fenced = "\n".join(["```", *trouble_text(trouble_rows()).split("\n"), "```"])
    assert troubleshooting_problems(scan(fenced)) == ["no 'Tabel pemecahan masalah' section"]
    heading = "## Tabel pemecahan masalah\n\n```\n" + "\n".join(
        trouble_text(trouble_rows()).split("\n")[2:]
    )
    problems = troubleshooting_problems(scan(heading + "\n```\n"))
    assert problems == [f"no table with the columns {' | '.join(TROUBLESHOOTING_HEADER)}"]


def test_env_presence_rule_wants_whole_names() -> None:
    text = " ".join(f"`{name}`" for name in ENV_DEFAULTS)
    assert env_presence_problems("d", text) == []
    missing = text.replace("AWS_REGION", "AWS_REGION_X")
    assert env_presence_problems("d", missing) == ["d: AWS_REGION is not written"]
    shorter = text.replace("NEXT_PUBLIC_ANIMATIONS", "NEXT_PUBLIC_ANIMATION")
    assert env_presence_problems("d", shorter) == ["d: NEXT_PUBLIC_ANIMATIONS is not written"]


def env_text(overrides: dict[str, str] | None = None, skip: tuple[str, ...] = ()) -> str:
    values = {**{k: v or "tidak diset" for k, v in ENV_DEFAULTS.items()}, **(overrides or {})}
    rows = [f"| `{name}` | `{value}` | Terraform | arti |" for name, value in values.items()]
    rows = [row for row in rows if not any(f"`{name}`" in row for name in skip)]
    head = [
        "## Variabel lingkungan",
        "",
        "| Env | Default | Diset oleh | Arti |",
        "|---|---|---|---|",
    ]
    return "\n".join([*head, *rows])


def test_env_table_rule_accepts_the_documented_defaults() -> None:
    assert env_table_problems(scan(env_text())) == []


def test_env_table_rule_names_a_wrong_default_and_a_missing_row() -> None:
    wrong = env_table_problems(scan(env_text({"ANIMATION_DAILY_PER_IP": "50"})))
    assert wrong == ["ANIMATION_DAILY_PER_IP: the default is '50', not '30'"]
    missing = env_table_problems(scan(env_text(skip=("AI_ANIMATION_MODEL",))))
    assert missing == ["AI_ANIMATION_MODEL: no row in the env table"]


RSS_HEADER_ROW = (
    "| Baris | Kapan diukur | Ambang | Nilai (MiB) | Perintah yang dijalankan | Tanggal UTC |"
)


def rss_text(
    rows: list[str] | None = None,
    *,
    header: str = RSS_HEADER_ROW,
    outside: str = "",
) -> str:
    rows = rows if rows is not None else rss_rows()
    return "\n".join(
        ["## Batas dan kuota", "", header, "|---|---|---|---|---|---|", *rows, "", outside]
    )


def rss_rows(skip: tuple[str, ...] = ()) -> list[str]:
    return [
        f"| {label} | kapan | 600 MiB | `[belum diverifikasi]` | | |"
        for label in RSS_LABELS
        if label not in skip
    ]


def test_rss_rule_accepts_unmeasured_rows_and_a_fully_measured_row() -> None:
    assert rss_problems(scan(rss_text())) == []
    measured = rss_rows(skip=("RSS (b)",))
    measured.append("| RSS (b) | kapan | 600 MiB | 412.5 | `docker top` | 2026-11-30 |")
    assert rss_problems(scan(rss_text(measured))) == []


def test_rss_rule_names_a_missing_or_repeated_row() -> None:
    missing = rss_problems(scan(rss_text(rss_rows(skip=("RSS (c)",)))))
    assert missing == ["RSS (c): 0 rows in 'Batas dan kuota', expected 1"]
    repeated = rss_problems(scan(rss_text([*rss_rows(), *rss_rows(skip=("RSS (a)", "RSS (b)"))])))
    assert repeated == ["RSS (c): 2 rows in 'Batas dan kuota', expected 1"]


def test_rss_rule_rejects_a_row_outside_limits_and_quotas() -> None:
    other = "\n".join(
        [
            "## Biaya",
            "",
            "| Baris | Ambang |",
            "|---|---|",
            "| RSS (a) | 600 MiB |",
        ]
    )
    problems = rss_problems(scan(rss_text(outside="") + "\n" + other))
    assert len(problems) == 1
    assert problems[0].startswith("an RSS row is outside 'Batas dan kuota'")


def test_rss_rule_rejects_a_wrong_threshold_and_a_bad_value() -> None:
    wrong = rss_rows(skip=("RSS (a)",))
    wrong.append("| RSS (a) | kapan | 500 MiB | `[belum diverifikasi]` | | |")
    assert rss_problems(scan(rss_text(wrong))) == ["RSS (a): the threshold is not 600 MiB"]
    bad = rss_rows(skip=("RSS (a)",))
    bad.append("| RSS (a) | kapan | 600 MiB | sekitar 400 | | |")
    problems = rss_problems(scan(rss_text(bad)))
    assert problems == [
        "RSS (a): the value 'sekitar 400' is neither a number nor [belum diverifikasi]"
    ]


@pytest.mark.parametrize("day", ["", "30-11-2026", "2026-13-40", "2026-11-3", "kemarin"])
def test_rss_rule_rejects_a_measured_value_without_a_real_utc_date(day: str) -> None:
    rows = rss_rows(skip=("RSS (a)",))
    rows.append(f"| RSS (a) | kapan | 600 MiB | 300 | `docker top` | {day} |")
    problems = rss_problems(scan(rss_text(rows)))
    assert problems == [f"RSS (a): a measured value needs a UTC date YYYY-MM-DD, not '{day}'"]


def test_rss_rule_rejects_a_measured_value_without_a_command() -> None:
    rows = rss_rows(skip=("RSS (a)",))
    rows.append("| RSS (a) | kapan | 600 MiB | 300 | | 2026-11-30 |")
    assert rss_problems(scan(rss_text(rows))) == ["RSS (a): a measured value has no command"]


def test_rss_rule_needs_the_columns_it_reads() -> None:
    text = rss_text(header="| Baris | Kapan diukur | Ambang | Nilai | Perintah | Tanggal |")
    problems = rss_problems(scan(text))
    assert problems == [
        "the RSS table has no column Nilai (MiB), Perintah yang dijalankan, Tanggal UTC"
    ]


def test_hop_one_rule_flags_a_bare_hop_limit_1() -> None:
    bad = [
        "Hop limit 1 pada instance api.",
        "`http_put_response_hop_limit = 1`",
        "hop_limit = 1",
        "HOP LIMIT 1 untuk native build",
        "hop limit 1 pada `website`",
    ]
    for line in bad:
        assert hop_one_problems("d", line) == ["d:1: 'hop limit 1' without web or nat"], line


def test_hop_one_rule_accepts_web_or_nat_and_other_numbers() -> None:
    good = [
        "Hop limit 1 pada `web` dan `nat`.",
        "hop_limit = 1   # web: hop limit 1",
        "hop limit 1 hanya untuk nat",
        "hop limit 2 pada api",
        "hop limit 12",
        "hop_limit = 2",
    ]
    for line in good:
        assert hop_one_problems("d", line) == [], line


def test_hop_one_rule_reports_the_line_number() -> None:
    assert hop_one_problems("d", "aman\nHop limit 1\naman") == [
        "d:2: 'hop limit 1' without web or nat"
    ]


def test_hop_two_rule_wants_api_and_the_boto3_reason() -> None:
    good = "http_put_response_hop_limit = 2   # hop_limit = 2, hanya api\nHop limit 2: boto3."
    assert hop_two_problems("d", good) == []
    no_api = "hop_limit = 2 untuk web\nHop limit 2: boto3."
    assert hop_two_problems("d", no_api) == ["d: no line with 'hop_limit = 2' for api"]
    no_reason = "hop_limit = 2 pada api"
    assert hop_two_problems("d", no_reason) == [
        "d: no hop limit 2 line gives the boto3 credential reason"
    ]
    wrong_value = "hop_limit = 1 pada api\nHop limit 2: boto3."
    assert hop_two_problems("d", wrong_value) == ["d: no line with 'hop_limit = 2' for api"]


def steps_text(rows: list[str], title: str = "Langkah manual admin", first: str = "No") -> str:
    return "\n".join([f"## {title}", "", f"| {first} | Langkah | Bukti |", "|---|---|---|", *rows])


def test_numbered_rows_rule_accepts_a_complete_table() -> None:
    rows = [f"| O-{n} | langkah {n} | bukti {n} |" for n in range(1, 11)]
    parsed = scan(steps_text(rows))
    assert numbered_rows_problems(parsed, "Langkah manual admin", "No", "O-", 10) == []


def test_numbered_rows_rule_rejects_gaps_empty_cells_and_short_tables() -> None:
    parsed = scan(
        steps_text(
            [
                "| O-1 | a | b |",
                "| O-3 | a | b |",
            ]
        )
    )
    problems = numbered_rows_problems(parsed, "Langkah manual admin", "No", "O-", 3)
    assert problems == [
        "'Langkah manual admin' has 2 rows, expected at least 3",
        "'Langkah manual admin' row 2 is 'O-3', not O-2",
    ]
    empty = scan(steps_text(["| O-1 | a |  |"]))
    assert numbered_rows_problems(empty, "Langkah manual admin", "No", "O-", 1) == [
        "'Langkah manual admin' row O-1 has an empty cell"
    ]
    assert numbered_rows_problems(scan("## Lain\n"), "Langkah manual admin", "No", "O-", 1) == [
        "no 'Langkah manual admin' section"
    ]


def test_cost_rule_wants_markers_threshold_and_approval() -> None:
    good = "\n".join(
        [
            "## Biaya",
            "",
            "| Komponen | Masukan | Rumus | Hasil |",
            "|---|---|---|---|",
            "| Lambda | 324000 | GB-detik | US$5,40 `[belum diverifikasi]` |",
            "",
            "Akun di paket Free dengan kredit promo. Di atas US$5 butuh persetujuan pengguna.",
        ]
    )
    assert cost_problems(scan(good)) == []
    no_approval = good.replace("persetujuan pengguna", "izin")
    assert cost_problems(scan(no_approval)) == ["the user's approval is not mentioned"]
    no_marker = good.replace("[belum diverifikasi]", "")
    assert cost_problems(scan(no_marker)) == [
        f"no {UNMEASURED} marker for the prices not yet checked"
    ]
    no_columns = good.replace("| Komponen | Masukan | Rumus | Hasil |", "| Komponen | Hasil |")
    assert "the cost table has no 'Masukan' and 'Rumus' columns" in cost_problems(scan(no_columns))


def test_overview_rule_wants_the_link_and_the_component() -> None:
    good = "[12](./12-remotion-animation.md) dan Component=animation"
    assert overview_problems(good) == []
    assert overview_problems("Component=animation") == [
        "the overview has no link to 12-remotion-animation.md"
    ]
    assert overview_problems("[12](./12-remotion-animation.md)") == [
        "the overview does not name Component=animation"
    ]


def test_cicd_rule_names_each_missing_item() -> None:
    good = "`verifier` `contracts` ci/verifier ci/contracts release-verifier.yml"
    assert cicd_problems(good) == []
    assert cicd_problems(good.replace("release-verifier.yml", "")) == [
        "05-cicd.md does not mention release-verifier.yml"
    ]


def test_roadmap_rule_wants_the_six_parts_of_r14() -> None:
    parts = ("Tujuan", "Panduan", "Pengujian", "Demo", "Biaya", "PR")
    body = "\n".join(f"- **{part}.** teks" for part in parts)
    good = f"### R13 Lain\n\n- **Tujuan.** x\n\n### R14 Animasi\n\n{body}\n\n## 4. Risiko\n"
    assert roadmap_problems(scan(good)) == []
    assert roadmap_problems(scan(good.replace("- **Demo.** teks\n", ""))) == [
        "the R14 task has no 'Demo' part"
    ]
    assert roadmap_problems(scan("### R13 Lain\n")) == ["the roadmap has no '### R14' task"]


def test_the_markdown_reader_splits_on_newlines_only() -> None:
    parsed = scan("a\u2028b\n## Biaya\r\n")
    assert [line.text for line in parsed.lines] == ["a\u2028b", "## Biaya", ""]
    assert heading_of(parsed.lines[1]) == (2, "Biaya")


# --------------------------------------------------------------------------------------------
# The real text with one line damaged: the rules must notice on the real format too
# --------------------------------------------------------------------------------------------


def test_damaging_the_real_document_is_noticed(doc12: str) -> None:
    def codes_without_unknown(text: str) -> list[str]:
        return troubleshooting_problems(scan(text.replace("| `UNKNOWN` |", "| `UNKNOWN_X` |")))

    def blank_action(text: str) -> list[str]:
        edited = edit_line(text, "| `RATE_LIMITED` |", lambda row: row.rsplit("|", 2)[0] + "|  |")
        return troubleshooting_problems(scan(edited))

    def without_rss_b(text: str) -> list[str]:
        return rss_problems(scan(edit_line(text, "| RSS (b) |", lambda row: "")))

    def other_threshold(text: str) -> list[str]:
        edited = edit_line(text, "| RSS (c) |", lambda row: row.replace("600 MiB", "800 MiB"))
        return rss_problems(scan(edited))

    def unnumbered_to_numbered(text: str) -> list[str]:
        return structure_problems(scan(text.replace("\n## Biaya\n", "\n## 14. Biaya\n")))

    def no_mermaid(text: str) -> list[str]:
        return diagram_problems(scan(text.replace("```mermaid", "```text")))

    def no_firefox(text: str) -> list[str]:
        damaged = text.replace("Firefox", "Browser lain")
        return browser_problems(scan(damaged), damaged)

    def renamed_env(text: str) -> list[str]:
        return env_presence_problems("d", text.replace("AI_ANIMATION_MODEL", "AI_MODEL_ANIMASI"))

    def changed_default(text: str) -> list[str]:
        row = "| `ANIMATION_DAILY_PER_IP` |"
        edited = edit_line(text, row, lambda r: r.replace("| 30 |", "| 50 |"))
        return env_table_problems(scan(edited))

    def pasted_account(text: str) -> list[str]:
        return forbidden_pattern_problems("d", text + "\nakun 210987654321\n")

    def no_placeholder(text: str) -> list[str]:
        return placeholder_problems(text.replace("<ACCOUNT_ID>", "AKUN"))

    cases: list[tuple[str, Callable[[str], list[str]], str]] = [
        ("an error code loses its row", codes_without_unknown, "UNKNOWN: no row"),
        ("an action cell is blanked", blank_action, "RATE_LIMITED: the action cell is empty"),
        ("an RSS row is deleted", without_rss_b, "RSS (b): 0 rows"),
        ("the RSS threshold changes", other_threshold, "RSS (c): the threshold is not 600 MiB"),
        ("a section gets a number", unnumbered_to_numbered, "'## 14. Biaya' heading is numbered"),
        ("the diagrams stop being mermaid", no_mermaid, "no non-empty mermaid block"),
        ("a browser is no longer named", no_firefox, "the word Firefox"),
        ("an env is renamed", renamed_env, "AI_ANIMATION_MODEL is not written"),
        ("a documented default changes", changed_default, "the default is '50', not '30'"),
        ("an account id is pasted", pasted_account, "a 12-digit number"),
        ("the placeholder is replaced", no_placeholder, "never writes <ACCOUNT_ID>"),
    ]
    for what, check, expected in cases:
        problems = check(doc12)
        assert any(expected in problem for problem in problems), (what, problems)


def test_damaging_the_real_hop_limit_text_is_noticed() -> None:
    compute = read(COMPUTE)
    lowered = compute.replace("hop_limit = 2", "hop_limit = 3")
    assert hop_two_problems("03", lowered) == ["03: no line with 'hop_limit = 2' for api"]
    no_reason = compute.replace("boto3", "SDK")
    assert hop_two_problems("03", no_reason) == [
        "03: no hop limit 2 line gives the boto3 credential reason"
    ]
    roadmap = read(ROADMAP) + "\nHop limit 1 pada api.\n"
    problems = hop_one_problems("10", roadmap)
    assert len(problems) == 1 and "without web or nat" in problems[0]
