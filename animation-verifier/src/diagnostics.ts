// Builder Diagnostic, pemotongan ke batas, dan urutan keluaran verifier (design bagian 5.3 butir 5
// sampai 7 dan tabel 5.12; Requirement 6.8, 6.9, 6.15, 6.16, 7.19, 10.12, 2.13).
// Semua langkah pipeline membuat Diagnostic lewat `makeDiagnostic` agar `tool` selalu mengikuti
// awalan kode dan `message` tidak pernah melebihi batas kontrak. `finalize` memilih paling banyak
// `diagnostics_max` Diagnostic, dan `orderForOutput` memberi urutan keluaran yang eksplisit supaya
// dua kali jalan menghasilkan hasil identik (Requirement 6.12). Modul ini murni: tanpa `Date`,
// `Math.random`, atau iterasi `Set`/`Map` di jalur keluaran, dan tanpa throw di batas modul.

import { buildDiagnosticCodeRegex, type DerivedContract, type RawContract } from "./contract.js";
import type { Diagnostic, Severity, Tool } from "./types.js";

/**
 * Awalan kode ke `tool` (Requirement 6.15). Urutan entri mengikuti `diagnostic_code_prefixes`
 * pada kontrak tanpa `AGENT`; tes memastikan regex dari tabel ini sama dengan regex kontrak.
 * `AGENT` sengaja tidak ada: verifier tidak pernah membuat Diagnostic `tool: "agent"`.
 */
const TOOL_BY_PREFIX: ReadonlyMap<string, Tool> = new Map<string, Tool>([
  ["SIZE", "size"],
  ["ENCODING", "size"],
  ["POLICY", "policy"],
  ["META", "policy"],
  ["ESLINT", "eslint"],
  ["TSC", "tsc"],
  ["BUNDLE", "esbuild"],
  ["RENDER", "render"],
  ["FIDELITY", "fidelity"],
  ["VERIFIER", "verifier"],
]);

/** Bentuk kode yang sah, dari pembangun regex yang sama dengan kontrak (Requirement 2.13). */
const VERIFIER_CODE_FORM = buildDiagnosticCodeRegex([...TOOL_BY_PREFIX.keys()]);

/**
 * Cadangan bila pemanggil tidak memberi batas: sama dengan `limits.diagnostic_message_max_chars`
 * pada kontrak. Pipeline meneruskan nilai kontrak; tes menjaga keduanya tetap sama.
 */
export const DEFAULT_MESSAGE_MAX_CHARS = 200;

/** Urutan langkah untuk keluaran: `verifier` terakhir (Requirement 6.9). */
const TOOL_ORDER: readonly Tool[] = [
  "size",
  "policy",
  "eslint",
  "tsc",
  "esbuild",
  "render",
  "fidelity",
  "verifier",
];

/** Urutan `FIDELITY_*` menurut kode (Requirement 10.12). */
const FIDELITY_CODE_ORDER: readonly string[] = [
  "FIDELITY_FORBIDDEN_OVERLAPS_REQUIRED",
  "FIDELITY_TOKEN_MISSING",
  "FIDELITY_FORBIDDEN_TOKEN_VISIBLE",
];

/** Kode yang dipakai bila pemanggil memberi kode yang tidak sah (galat pemrograman, bukan masukan). */
const INVALID_CODE_FALLBACK = "VERIFIER_INTERNAL";

/** Berapa karakter kode tidak sah yang dicantumkan di pesan agar pesan tetap pendek. */
const INVALID_CODE_ECHO_CHARS = 60;

export interface DiagnosticLocation {
  /** Basis 1; nilai di luar bilangan bulat >= 1 dibuang. */
  line?: number;
  /** Basis 1; nilai di luar bilangan bulat >= 1 dibuang. */
  column?: number;
}

/** Satu baris tabel 5.12. Keluarga kode (`ESLINT_<RULE>`, `TSC_<n>`) diwakili satu contoh nyata. */
export interface DiagnosticCodeSpec {
  code: string;
  /** `agent` hanya untuk kode buatan agent backend; verifier tidak pernah mengirimnya. */
  tool: Tool | "agent";
  severity: Severity;
  /** Templat pesan pada tabel 5.12; `null` bila pesan berasal dari alat (ESLint, tsc, esbuild). */
  template: string | null;
}

/**
 * Daftar kode Diagnostic lengkap, salinan tabel 5.12 design. Dipakai tes (dan korpus fixture) agar
 * tabel menjadi satu-satunya rujukan kode di sisi verifier. Kode `VERIFIER_CRASH` dibuat agent
 * tetapi berbentuk kode verifier, jadi `tool`-nya `verifier`.
 */
export const DIAGNOSTIC_CODE_TABLE: readonly DiagnosticCodeSpec[] = [
  { code: "SIZE_SOURCE_TOO_LARGE", tool: "size", severity: "error", template: "source is <n> bytes, limit is <max>" },
  { code: "ENCODING_INVALID", tool: "size", severity: "error", template: "source contains NUL, a lone surrogate, or a BOM" },
  { code: "POLICY_JSX_SYNTAX", tool: "policy", severity: "error", template: "JSX is not allowed, use createElement" },
  { code: "POLICY_IMPORT_DISALLOWED", tool: "policy", severity: "error", template: "import of <name> from <module> is not allowed" },
  { code: "POLICY_DYNAMIC_IMPORT", tool: "policy", severity: "error", template: "dynamic import and require are not allowed" },
  { code: "POLICY_FORBIDDEN_IDENTIFIER", tool: "policy", severity: "error", template: "identifier <name> is not allowed" },
  { code: "POLICY_FORBIDDEN_MEMBER", tool: "policy", severity: "error", template: "<member> is not allowed, use random(seed) from remotion" },
  { code: "POLICY_FORBIDDEN_PROPERTY", tool: "policy", severity: "error", template: "property <name> is not allowed" },
  { code: "POLICY_DYNAMIC_ELEMENT", tool: "policy", severity: "error", template: "createElement type must be a string literal, Fragment, or a known component" },
  { code: "POLICY_FORBIDDEN_ELEMENT", tool: "policy", severity: "error", template: "element <name> is not allowed" },
  { code: "POLICY_FORBIDDEN_ATTRIBUTE", tool: "policy", severity: "error", template: "attribute <name> is not allowed" },
  { code: "POLICY_URL_LITERAL", tool: "policy", severity: "error", template: "url() and URL schemes are not allowed in strings" },
  { code: "POLICY_COLOR_LITERAL", tool: "policy", severity: "error", template: "use var(--color-<token>) from the Kit palette, found <fragment>" },
  { code: "POLICY_META_INVALID", tool: "policy", severity: "error", template: "meta must be a literal object with width 1280, height 720, fps 30, durationInFrames 30..900" },
  { code: "META_PAUSE_REQUIRED", tool: "policy", severity: "error", template: "puzzle animations must set meta.pauseAtFrame" },
  { code: "META_PAUSE_FORBIDDEN", tool: "policy", severity: "error", template: "lesson animations must not set meta.pauseAtFrame" },
  { code: "POLICY_EXPORT_MISSING", tool: "policy", severity: "error", template: "export default function Main() with no parameters is required" },
  { code: "POLICY_EXPORT_UNEXPECTED", tool: "policy", severity: "error", template: "only meta and the default export are allowed" },
  { code: "ESLINT_LORE_NO_MODULE_STATE", tool: "eslint", severity: "error", template: "module-level state is not allowed: <name>" },
  { code: "ESLINT_LORE_USES_FRAME", tool: "eslint", severity: "error", template: "Main must call useCurrentFrame() from remotion" },
  { code: "ESLINT_LORE_KIT_STYLE", tool: "eslint", severity: "warning", template: "Kit style: <detail>" },
  { code: "ESLINT_INLINE_DIRECTIVE", tool: "eslint", severity: "error", template: "eslint directive comments are not allowed" },
  { code: "ESLINT_PARSE_ERROR", tool: "eslint", severity: "error", template: null },
  // Keluarga `ESLINT_<RULE>`: satu contoh nyata, severity mengikuti aturan (error atau warning).
  { code: "ESLINT_NO_UNUSED_VARS", tool: "eslint", severity: "error", template: null },
  // Keluarga `TSC_<n>`: satu contoh nyata (nomor galat compiler).
  { code: "TSC_2304", tool: "tsc", severity: "error", template: null },
  { code: "TSC_SUPPRESSION_DIRECTIVE", tool: "tsc", severity: "error", template: "@ts-ignore, @ts-nocheck and @ts-expect-error are not allowed" },
  { code: "BUNDLE_TOO_LARGE", tool: "esbuild", severity: "error", template: "bundle is <n> bytes, limit is <max>" },
  { code: "BUNDLE_UNEXPECTED_REQUIRE", tool: "esbuild", severity: "error", template: "bundle requires <module>" },
  { code: "BUNDLE_FAILED", tool: "esbuild", severity: "error", template: null },
  { code: "RENDER_EXCEPTION", tool: "render", severity: "error", template: "frame=<n> render threw <ErrorName>" },
  { code: "RENDER_CONSOLE_ERROR", tool: "render", severity: "error", template: "console.error was called during render" },
  { code: "RENDER_CONSOLE_WARN", tool: "render", severity: "warning", template: "console.warn was called during render" },
  { code: "RENDER_DOM_LIMIT", tool: "render", severity: "error", template: "frame=<n> count=<n> exceeds 600 elements" },
  { code: "RENDER_EMPTY", tool: "render", severity: "error", template: "frame=<n> rendered no content" },
  { code: "RENDER_META_MISMATCH", tool: "render", severity: "error", template: "executed meta differs from the static meta, or default export is not a function" },
  { code: "RENDER_NONDETERMINISTIC", tool: "render", severity: "error", template: "frame=<n> rendered differently on the second pass" },
  { code: "RENDER_FRAME_TIMEOUT", tool: "render", severity: "error", template: "frame=<n|evaluate> did not finish in time" },
  { code: "RENDER_RESOURCE_LIMIT", tool: "render", severity: "error", template: "memory limit reached" },
  { code: "FIDELITY_TOKEN_MISSING", tool: "fidelity", severity: "error", template: 'frame=<n> missing "<80 chars>"' },
  { code: "FIDELITY_FORBIDDEN_TOKEN_VISIBLE", tool: "fidelity", severity: "error", template: 'frame=<n> shows "<80 chars>" before the answer' },
  { code: "FIDELITY_FORBIDDEN_OVERLAPS_REQUIRED", tool: "fidelity", severity: "warning", template: 'forbidden token also required, ignored: "<80 chars>"' },
  { code: "VERIFIER_BAD_INPUT", tool: "verifier", severity: "error", template: "event does not match the input schema" },
  { code: "VERIFIER_CONTRACT_MISMATCH", tool: "verifier", severity: "error", template: "contract_version <a> differs from verifier <b>" },
  { code: "VERIFIER_INTERNAL", tool: "verifier", severity: "error", template: "internal verifier error" },
  { code: "VERIFIER_DEADLINE", tool: "verifier", severity: "error", template: "verification deadline reached" },
  { code: "VERIFIER_CRASH", tool: "verifier", severity: "error", template: "the verifier crashed, retrying with the same source" },
  { code: "AGENT_EXTRACT_NO_CODE", tool: "agent", severity: "error", template: "no TypeScript code block was found in the reply" },
  { code: "AGENT_REPAIR_UNCHANGED", tool: "agent", severity: "error", template: "the repaired source is identical to the previous one" },
];

/** Memotong ke `maxChars` unit UTF-16 tanpa membelah pasangan surrogat (hasil tetap sah di Pydantic). */
function truncateMessage(message: string, maxChars: number): string {
  const limit = Number.isInteger(maxChars) && maxChars >= 1 ? maxChars : DEFAULT_MESSAGE_MAX_CHARS;
  if (message.length <= limit) return message;
  const lastKept = message.charCodeAt(limit - 1);
  const splitsPair = lastKept >= 0xd800 && lastKept <= 0xdbff;
  return message.slice(0, splitsPair ? limit - 1 : limit);
}

function validPosition(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 1;
}

/**
 * Membuat Diagnostic. `tool` ditetapkan dari awalan `code` (Requirement 6.15) dan `message`
 * dipotong ke `maxChars` (default `diagnostic_message_max_chars`, Requirement 6.8). `line` dan
 * `column` yang bukan bilangan bulat >= 1 dibuang, bukan dikirim, karena skema backend menolaknya.
 * Kode yang bukan bentuk kode verifier (termasuk `AGENT_*`) adalah galat pemrograman: hasilnya
 * `VERIFIER_INTERNAL` dengan kode asli di pesan, sehingga setiap Diagnostic keluaran tetap sah.
 */
export function makeDiagnostic(
  code: string,
  severity: Severity,
  message: string,
  loc?: DiagnosticLocation,
  maxChars: number = DEFAULT_MESSAGE_MAX_CHARS,
): Diagnostic {
  const tool = VERIFIER_CODE_FORM.test(code)
    ? TOOL_BY_PREFIX.get(code.slice(0, code.indexOf("_")))
    : undefined;
  const valid = tool !== undefined;
  const diagnostic: Diagnostic = {
    tool: valid ? tool : "verifier",
    code: valid ? code : INVALID_CODE_FALLBACK,
    severity: valid ? severity : "error",
    message: truncateMessage(
      valid ? message : `invalid diagnostic code: ${code.slice(0, INVALID_CODE_ECHO_CHARS)}`,
      maxChars,
    ),
  };
  if (validPosition(loc?.line)) diagnostic.line = loc.line;
  if (validPosition(loc?.column)) diagnostic.column = loc.column;
  return diagnostic;
}

/**
 * Regex bentuk kode Diagnostic verifier milik kontrak (Requirement 2.13, 6.8). Sengaja hanya
 * mengembalikan regex turunan kontrak; tidak ada regex kedua yang dibangun di sini.
 */
export function codeRegex(contract: Pick<DerivedContract, "diagnosticCodeRegex">): RegExp {
  return contract.diagnosticCodeRegex;
}

function compareNumber(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Urutan titik kode, bukan `localeCompare`, agar tidak bergantung pada locale mesin. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Tanpa `line` atau `column` dianggap 0 sehingga lebih dulu (basis 1, Requirement 6.9). */
function position(value: number | undefined): number {
  return value ?? 0;
}

interface Indexed {
  diagnostic: Diagnostic;
  /** Posisi pada masukan: pemutus seri terakhir, sehingga urutan sama terjaga dan tak bergantung pada `sort`. */
  index: number;
}

function toolRank(tool: Tool): number {
  const rank = TOOL_ORDER.indexOf(tool);
  return rank === -1 ? TOOL_ORDER.length : rank;
}

function fidelityRank(code: string): number {
  const rank = FIDELITY_CODE_ORDER.indexOf(code);
  return rank === -1 ? FIDELITY_CODE_ORDER.length : rank;
}

function compareForOutput(a: Indexed, b: Indexed): number {
  const byTool = compareNumber(toolRank(a.diagnostic.tool), toolRank(b.diagnostic.tool));
  if (byTool !== 0) return byTool;
  if (a.diagnostic.tool === "fidelity") {
    // Requirement 10.12: menurut kode dengan urutan tetap, lalu urutan token pada masukan.
    const byRank = compareNumber(fidelityRank(a.diagnostic.code), fidelityRank(b.diagnostic.code));
    if (byRank !== 0) return byRank;
    const byUnknownCode = compareText(a.diagnostic.code, b.diagnostic.code);
    return byUnknownCode !== 0 ? byUnknownCode : compareNumber(a.index, b.index);
  }
  return (
    compareNumber(position(a.diagnostic.line), position(b.diagnostic.line)) ||
    compareNumber(position(a.diagnostic.column), position(b.diagnostic.column)) ||
    compareText(a.diagnostic.code, b.diagnostic.code) ||
    compareNumber(a.index, b.index)
  );
}

function compareForSelection(a: Indexed, b: Indexed): number {
  const severityRank = (d: Diagnostic): number => (d.severity === "error" ? 0 : 1);
  return (
    compareNumber(severityRank(a.diagnostic), severityRank(b.diagnostic)) ||
    compareNumber(position(a.diagnostic.line), position(b.diagnostic.line)) ||
    compareNumber(position(a.diagnostic.column), position(b.diagnostic.column)) ||
    compareNumber(a.index, b.index)
  );
}

function withIndex(diagnostics: readonly Diagnostic[]): Indexed[] {
  return diagnostics.map((diagnostic, index) => ({ diagnostic, index }));
}

/**
 * Urutan keluaran (Requirement 6.9): menurut langkah (`verifier` terakhir), lalu `line` (tanpa
 * `line` lebih dulu), lalu `column`, lalu `code` abjad. Untuk `FIDELITY_*`, urutannya menurut
 * Requirement 10.12 dan, di dalam satu kode, mengikuti urutan masukan. Masukan tidak diubah.
 */
export function orderForOutput(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return withIndex(diagnostics)
    .sort(compareForOutput)
    .map((entry) => entry.diagnostic);
}

/** Batas yang dibaca `finalize`: `limits` kontrak (cukup kuncinya). */
export type DiagnosticLimits = Pick<RawContract["limits"], "diagnostics_max">;

export interface FinalizeResult {
  /** True bila masukan lengkap tidak punya Diagnostic `error`; dihitung sebelum pemotongan. */
  ok: boolean;
  /** Paling banyak `diagnostics_max`, sudah dalam urutan keluaran. */
  diagnostics: Diagnostic[];
  /** True bila ada Diagnostic yang dibuang. */
  truncated: boolean;
}

/**
 * Langkah akhir pipeline (design 5.3 butir 5 sampai 7). `ok` dihitung dari seluruh masukan
 * sebelum pemotongan. Bila jumlah melebihi `diagnostics_max`, yang dipertahankan dipilih dengan
 * urutan error sebelum warning, lalu baris, lalu kolom (Requirement 7.19), sehingga warning
 * terbuang lebih dulu dan galat tidak pernah hilang selama masih muat. Hasil terpilih lalu
 * diurutkan untuk keluaran dengan urutan masukan semula, bukan urutan pemilihan, supaya urutan
 * token `FIDELITY_*` tetap utuh (Requirement 10.12).
 */
export function finalize(
  diagnostics: readonly Diagnostic[],
  limits: DiagnosticLimits,
): FinalizeResult {
  const ok = !diagnostics.some((diagnostic) => diagnostic.severity === "error");
  const max = limits.diagnostics_max;
  if (diagnostics.length <= max) {
    return { ok, diagnostics: orderForOutput(diagnostics), truncated: false };
  }
  const kept: boolean[] = diagnostics.map(() => false);
  for (const entry of withIndex(diagnostics).sort(compareForSelection).slice(0, max)) {
    kept[entry.index] = true;
  }
  const retained = diagnostics.filter((_, index) => kept[index]);
  return { ok, diagnostics: orderForOutput(retained), truncated: true };
}
