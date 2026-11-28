// Tes builder Diagnostic verifier (tugas 3.2): `tool` dari awalan kode, pemotongan pesan,
// regex kode milik kontrak, pemotongan ke 50 dengan `ok` dihitung sebelumnya, dan urutan keluaran
// (Requirement 6.8, 6.9, 6.15, 6.16, 7.19, 2.13, 10.12; design 5.3 butir 5 sampai 7 dan 5.12).
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { loadContract } from "../src/contract.js";
import {
  DEFAULT_MESSAGE_MAX_CHARS,
  DIAGNOSTIC_CODE_TABLE,
  codeRegex,
  finalize,
  makeDiagnostic,
  orderForOutput,
} from "../src/diagnostics.js";
import type { Diagnostic, Severity, Tool } from "../src/types.js";

const loaded = loadContract(
  JSON.parse(
    readFileSync(new URL("../contract/animation-contract.json", import.meta.url), "utf8"),
  ) as unknown,
);
if (!loaded.ok) throw new Error(`kontrak sumber tidak sah: ${loaded.reason}`);
const contract = loaded.contract;
const LIMITS = contract.limits;

/** Pola literal Requirement 6 kriteria 8, ditulis ulang di tes (bukan dari kontrak). */
const REQUIREMENT_CODE_REGEX =
  /^(SIZE|ENCODING|POLICY|META|ESLINT|TSC|BUNDLE|RENDER|FIDELITY|VERIFIER)_[A-Z0-9_]+$/;

/** Pasangan awalan dan `tool` pada Requirement 6 kriteria 15, ditulis ulang di tes. */
const EXPECTED_TOOL_BY_PREFIX: Record<string, Tool> = {
  SIZE: "size",
  ENCODING: "size",
  POLICY: "policy",
  META: "policy",
  ESLINT: "eslint",
  TSC: "tsc",
  BUNDLE: "esbuild",
  RENDER: "render",
  FIDELITY: "fidelity",
  VERIFIER: "verifier",
};

const VERIFIER_ROWS = DIAGNOSTIC_CODE_TABLE.filter((row) => row.tool !== "agent");
const AGENT_ROWS = DIAGNOSTIC_CODE_TABLE.filter((row) => row.tool === "agent");

function prefixOf(code: string): string {
  return code.slice(0, code.indexOf("_"));
}

function diag(
  code: string,
  severity: Severity,
  loc?: { line?: number; column?: number },
  message = "m",
): Diagnostic {
  return makeDiagnostic(code, severity, message, loc);
}

describe("tabel kode 5.12", () => {
  it("memuat 48 baris dengan kode unik", () => {
    expect(DIAGNOSTIC_CODE_TABLE).toHaveLength(48);
    expect(new Set(DIAGNOSTIC_CODE_TABLE.map((row) => row.code)).size).toBe(48);
  });

  it("hanya tiga kode tetap yang bersifat warning", () => {
    const warnings = DIAGNOSTIC_CODE_TABLE.filter((row) => row.severity === "warning").map(
      (row) => row.code,
    );
    expect(warnings.sort()).toEqual(
      ["ESLINT_LORE_KIT_STYLE", "FIDELITY_FORBIDDEN_OVERLAPS_REQUIRED", "RENDER_CONSOLE_WARN"].sort(),
    );
  });

  it("dua kode buatan agent bertool agent", () => {
    expect(AGENT_ROWS.map((row) => row.code)).toEqual([
      "AGENT_EXTRACT_NO_CODE",
      "AGENT_REPAIR_UNCHANGED",
    ]);
  });

  it("templat pesan paling banyak 200 karakter", () => {
    for (const row of DIAGNOSTIC_CODE_TABLE) {
      if (row.template !== null) expect(row.template.length).toBeLessThanOrEqual(200);
    }
  });

  it("templat pesan tidak memuat durasi atau id invokasi (Requirement 6.12)", () => {
    const durationOrInvocation =
      /\d\s*ms\b|\bms\s*[=:]|\d\s*(?:seconds?|secs?)\b|awsRequestId|request[_ -]?id|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    for (const row of DIAGNOSTIC_CODE_TABLE) {
      if (row.template !== null) expect(row.template).not.toMatch(durationOrInvocation);
    }
  });

  it("templat yang terkait satu frame memuat frame=<n> (Requirement 6.17)", () => {
    const perFrame = [
      "RENDER_EXCEPTION",
      "RENDER_DOM_LIMIT",
      "RENDER_EMPTY",
      "RENDER_NONDETERMINISTIC",
      "RENDER_FRAME_TIMEOUT",
      "FIDELITY_TOKEN_MISSING",
      "FIDELITY_FORBIDDEN_TOKEN_VISIBLE",
    ];
    for (const code of perFrame) {
      const row = DIAGNOSTIC_CODE_TABLE.find((candidate) => candidate.code === code);
      expect(row?.template).toMatch(/^frame=<[^>]+>/);
    }
  });
});

describe("codeRegex", () => {
  it("mengembalikan regex turunan kontrak, bukan regex baru (Requirement 2.13)", () => {
    expect(codeRegex(contract)).toBe(contract.diagnosticCodeRegex);
    expect(codeRegex(contract).source).toBe(REQUIREMENT_CODE_REGEX.source);
    expect(codeRegex(contract).flags).toBe("");
  });

  it.each(VERIFIER_ROWS.map((row) => row.code))("%s cocok dengan regex", (code) => {
    expect(codeRegex(contract).test(code)).toBe(true);
    expect(REQUIREMENT_CODE_REGEX.test(code)).toBe(true);
  });

  it.each(AGENT_ROWS.map((row) => row.code))("%s bukan bentuk kode verifier", (code) => {
    expect(codeRegex(contract).test(code)).toBe(false);
  });

  it.each(["", "SIZE", "SIZE_", "size_too_large", "SIZE_a", "SIZE-X", "FOO_BAR", "XSIZE_A", "SIZE_A B"])(
    "menolak %j",
    (code) => {
      expect(codeRegex(contract).test(code)).toBe(false);
    },
  );
});

describe("makeDiagnostic", () => {
  it.each(VERIFIER_ROWS)("$code bertool $tool sesuai awalan (Requirement 6.15)", (row) => {
    const diagnostic = makeDiagnostic(row.code, row.severity, "m");
    expect(diagnostic.tool).toBe(EXPECTED_TOOL_BY_PREFIX[prefixOf(row.code)]);
    expect(diagnostic.tool).toBe(row.tool);
    expect(diagnostic.code).toBe(row.code);
    expect(diagnostic.severity).toBe(row.severity);
    expect(codeRegex(contract).test(diagnostic.code)).toBe(true);
  });

  it("hanya memuat kunci Diagnostic dan tanpa line atau column bila tidak diberi", () => {
    const diagnostic = makeDiagnostic("POLICY_JSX_SYNTAX", "error", "JSX is not allowed");
    expect(Object.keys(diagnostic).sort()).toEqual(["code", "message", "severity", "tool"]);
    const located = makeDiagnostic("POLICY_JSX_SYNTAX", "error", "m", { line: 3, column: 7 });
    expect(Object.keys(located).sort()).toEqual(["code", "column", "line", "message", "severity", "tool"]);
    expect(located.line).toBe(3);
    expect(located.column).toBe(7);
  });

  it("membuang line dan column yang bukan bilangan bulat >= 1", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const diagnostic = makeDiagnostic("POLICY_JSX_SYNTAX", "error", "m", { line: bad, column: bad });
      expect("line" in diagnostic).toBe(false);
      expect("column" in diagnostic).toBe(false);
    }
    const onlyLine = makeDiagnostic("POLICY_JSX_SYNTAX", "error", "m", { line: 2 });
    expect(onlyLine.line).toBe(2);
    expect("column" in onlyLine).toBe(false);
  });

  it("batas bawaan sama dengan diagnostic_message_max_chars pada kontrak", () => {
    expect(DEFAULT_MESSAGE_MAX_CHARS).toBe(LIMITS.diagnostic_message_max_chars);
  });

  it("memotong pesan ke 200 karakter dan membiarkan pesan <= 200", () => {
    const max = LIMITS.diagnostic_message_max_chars;
    expect(makeDiagnostic("TSC_2304", "error", "x".repeat(max)).message).toBe("x".repeat(max));
    expect(makeDiagnostic("TSC_2304", "error", "x".repeat(max + 1)).message).toBe("x".repeat(max));
    expect(makeDiagnostic("TSC_2304", "error", "x".repeat(5000)).message).toHaveLength(max);
    expect(makeDiagnostic("TSC_2304", "error", "").message).toBe("");
  });

  it("memakai maxChars kustom dan mengabaikan nilai tak sah", () => {
    expect(makeDiagnostic("TSC_2304", "error", "abcdef", undefined, 3).message).toBe("abc");
    for (const bad of [0, -5, 2.5, Number.NaN]) {
      expect(makeDiagnostic("TSC_2304", "error", "x".repeat(300), undefined, bad).message).toHaveLength(
        DEFAULT_MESSAGE_MAX_CHARS,
      );
    }
  });

  it("tidak membelah pasangan surrogat saat memotong", () => {
    const message = `${"a".repeat(199)}\u{1F383}tail`;
    const cut = makeDiagnostic("TSC_2304", "error", message).message;
    expect(cut).toBe("a".repeat(199));
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    const kept = makeDiagnostic("TSC_2304", "error", `${"a".repeat(198)}\u{1F383}tail`).message;
    expect(kept).toBe(`${"a".repeat(198)}\u{1F383}`);
    expect(kept).toHaveLength(200);
  });

  it.each(["AGENT_EXTRACT_NO_CODE", "ESLINT_no-unused-vars", "FOO_BAR", "SIZE", "SIZE_", "size_x", ""])(
    "kode tidak sah %j menjadi VERIFIER_INTERNAL error",
    (code) => {
      const diagnostic = makeDiagnostic(code, "warning", "m", { line: 4 });
      expect(diagnostic.code).toBe("VERIFIER_INTERNAL");
      expect(diagnostic.tool).toBe("verifier");
      expect(diagnostic.severity).toBe("error");
      expect(diagnostic.message).toContain("invalid diagnostic code");
      expect(diagnostic.message.length).toBeLessThanOrEqual(200);
      expect(diagnostic.line).toBe(4);
      expect(codeRegex(contract).test(diagnostic.code)).toBe(true);
    },
  );

  it("kode tidak sah yang sangat panjang tetap menghasilkan pesan <= 200 karakter", () => {
    const diagnostic = makeDiagnostic("x".repeat(10_000), "error", "m");
    expect(diagnostic.message.length).toBeLessThanOrEqual(200);
  });
});

/** Diagnostic bertingkat untuk tes pemotongan: warning `POLICY_FORBIDDEN_PROPERTY` pada baris `line`. */
const warningAt = (line: number): Diagnostic =>
  diag("ESLINT_LORE_KIT_STYLE", "warning", { line, column: 1 }, `warning ${line}`);
const errorAt = (line: number, column = 1): Diagnostic =>
  diag("POLICY_FORBIDDEN_PROPERTY", "error", { line, column }, `error ${line}:${column}`);

describe("finalize", () => {
  it("masukan kosong: ok true, tanpa pemotongan", () => {
    expect(finalize([], LIMITS)).toEqual({ ok: true, diagnostics: [], truncated: false });
  });

  it("tepat 50 Diagnostic tidak dipotong", () => {
    const input = Array.from({ length: 50 }, (_, i) => warningAt(i + 1));
    const result = finalize(input, LIMITS);
    expect(result.diagnostics).toHaveLength(50);
    expect(result.truncated).toBe(false);
    expect(result.ok).toBe(true);
  });

  it("51 Diagnostic menyisakan 50 dan menandai truncated", () => {
    const input = Array.from({ length: 51 }, (_, i) => warningAt(i + 1));
    const result = finalize(input, LIMITS);
    expect(result.diagnostics).toHaveLength(50);
    expect(result.truncated).toBe(true);
    // Yang dibuang adalah warning dengan baris terbesar.
    expect(result.diagnostics.map((d) => d.line)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it("ok dihitung sebelum pemotongan: satu error di baris besar tidak hilang oleh 50 warning", () => {
    const input = [errorAt(900), ...Array.from({ length: 50 }, (_, i) => warningAt(i + 1))];
    expect(input).toHaveLength(51);
    const result = finalize(input, LIMITS);
    expect(result.ok).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.diagnostics).toHaveLength(50);
    expect(result.diagnostics.some((d) => d.severity === "error" && d.line === 900)).toBe(true);
    // Warning terakhir (baris 50) yang dibuang.
    expect(result.diagnostics.some((d) => d.line === 50)).toBe(false);
  });

  it("51 warning tanpa error: ok tetap true setelah pemotongan", () => {
    const input = Array.from({ length: 51 }, (_, i) => warningAt(i + 1));
    expect(finalize(input, LIMITS).ok).toBe(true);
  });

  it("51 error: ok false dan 50 error terawal (baris, lalu kolom) dipertahankan", () => {
    const input = Array.from({ length: 51 }, (_, i) => errorAt(100 - i));
    const result = finalize(input, LIMITS);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toHaveLength(50);
    // Baris masukan 100 turun ke 50; baris 100 (terbesar) dibuang, sisanya 50..99 berurutan naik.
    expect(result.diagnostics.map((d) => d.line)).toEqual(Array.from({ length: 50 }, (_, i) => 50 + i));
  });

  it("semua warning dibuang lebih dulu: 10 error + 45 warning menyisakan 10 error + 40 warning", () => {
    const errors = Array.from({ length: 10 }, (_, i) => errorAt(200 + i));
    const warnings = Array.from({ length: 45 }, (_, i) => warningAt(i + 1));
    const result = finalize([...warnings, ...errors], LIMITS);
    expect(result.diagnostics).toHaveLength(50);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toHaveLength(10);
    expect(result.diagnostics.filter((d) => d.severity === "warning").map((d) => d.line)).toEqual(
      Array.from({ length: 40 }, (_, i) => i + 1),
    );
  });

  it("bila error saja sudah > 50, tidak ada warning yang tersisa", () => {
    const errors = Array.from({ length: 60 }, (_, i) => errorAt(i + 1));
    const warnings = Array.from({ length: 5 }, (_, i) => warningAt(i + 1));
    const result = finalize([...warnings, ...errors], LIMITS);
    expect(result.diagnostics).toHaveLength(50);
    expect(result.diagnostics.every((d) => d.severity === "error")).toBe(true);
    expect(result.diagnostics.map((d) => d.line)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it("pemilihan memakai kolom bila baris sama (Requirement 7.19)", () => {
    const input = [
      ...Array.from({ length: 49 }, (_, i) => errorAt(1 + i)),
      errorAt(60, 9),
      errorAt(60, 2),
    ];
    const result = finalize(input, LIMITS);
    expect(result.diagnostics).toHaveLength(50);
    const last = result.diagnostics[49];
    expect(last?.line).toBe(60);
    expect(last?.column).toBe(2);
  });

  it("Diagnostic tanpa line dipilih lebih dulu daripada yang berbaris pada severity sama", () => {
    const noLine = diag("RENDER_CONSOLE_WARN", "warning", undefined, "no line");
    const input = [...Array.from({ length: 50 }, (_, i) => warningAt(i + 1)), noLine];
    const result = finalize(input, LIMITS);
    expect(result.diagnostics).toContain(noLine);
    expect(result.diagnostics.some((d) => d.line === 50)).toBe(false);
  });

  it("urutan token FIDELITY_* tetap utuh setelah pemotongan (Requirement 10.12)", () => {
    const fidelity = [
      diag("FIDELITY_FORBIDDEN_TOKEN_VISIBLE", "error", undefined, "v-t1"),
      diag("FIDELITY_TOKEN_MISSING", "error", undefined, "m-t2"),
      diag("FIDELITY_FORBIDDEN_OVERLAPS_REQUIRED", "warning", undefined, "o-t3"),
      diag("FIDELITY_TOKEN_MISSING", "error", undefined, "m-t4"),
      diag("FIDELITY_FORBIDDEN_TOKEN_VISIBLE", "error", undefined, "v-t5"),
    ];
    const policyWarnings = Array.from({ length: 46 }, (_, i) =>
      diag("POLICY_COLOR_LITERAL", "warning", { line: i + 1, column: 1 }, `p${i + 1}`),
    );
    const result = finalize([...fidelity, ...policyWarnings], LIMITS);
    expect(result.truncated).toBe(true);
    expect(result.diagnostics).toHaveLength(50);
    const tail = result.diagnostics.slice(-5).map((d) => d.message);
    expect(tail).toEqual(["o-t3", "m-t2", "m-t4", "v-t1", "v-t5"]);
    expect(result.diagnostics.some((d) => d.message === "p46")).toBe(false);
  });

  it("memakai diagnostics_max dari limits dan tidak mengubah masukan", () => {
    const input = Object.freeze(Array.from({ length: 5 }, (_, i) => warningAt(i + 1)));
    const result = finalize(input, { diagnostics_max: 3 });
    expect(result.diagnostics).toHaveLength(3);
    expect(result.truncated).toBe(true);
    expect(input).toHaveLength(5);
  });

  it("hasil dapat di-JSON-kan tanpa id invokasi atau durasi (hanya kunci Diagnostic)", () => {
    const result = finalize([errorAt(1), warningAt(2)], LIMITS);
    const allowed = new Set(["tool", "code", "severity", "line", "column", "message"]);
    for (const diagnostic of result.diagnostics) {
      for (const key of Object.keys(diagnostic)) expect(allowed.has(key)).toBe(true);
    }
  });
});

describe("orderForOutput", () => {
  it("mengurutkan menurut langkah dengan verifier terakhir (Requirement 6.9)", () => {
    const input = [
      diag("VERIFIER_DEADLINE", "error"),
      diag("FIDELITY_TOKEN_MISSING", "error"),
      diag("RENDER_EMPTY", "error"),
      diag("BUNDLE_FAILED", "error"),
      diag("TSC_2304", "error"),
      diag("ESLINT_LORE_USES_FRAME", "error"),
      diag("META_PAUSE_REQUIRED", "error"),
      diag("ENCODING_INVALID", "error"),
    ];
    expect(orderForOutput(input).map((d) => d.tool)).toEqual([
      "size",
      "policy",
      "eslint",
      "tsc",
      "esbuild",
      "render",
      "fidelity",
      "verifier",
    ]);
  });

  it("di dalam satu langkah: tanpa line lebih dulu, lalu line, column, lalu code abjad", () => {
    const a = diag("POLICY_JSX_SYNTAX", "error", { line: 2, column: 5 });
    const b = diag("POLICY_JSX_SYNTAX", "error", { line: 2, column: 1 });
    const c = diag("POLICY_EXPORT_MISSING", "error");
    const d = diag("POLICY_URL_LITERAL", "error", { line: 1, column: 9 });
    const e = diag("META_PAUSE_REQUIRED", "error", { line: 2, column: 1 });
    const f = diag("POLICY_META_INVALID", "error");
    const g = diag("POLICY_FORBIDDEN_IDENTIFIER", "error", { line: 2 });
    // line 2 tanpa column lebih dulu daripada line 2 dengan column.
    expect(orderForOutput([a, b, c, d, e, f, g])).toEqual([c, f, d, g, e, b, a]);
  });

  it("code dibanding menurut urutan titik kode, bukan locale", () => {
    const upper = diag("POLICY_EXPORT_MISSING", "error", { line: 1, column: 1 });
    const underscore = diag("POLICY_EXPORT_UNEXPECTED", "error", { line: 1, column: 1 });
    const digit = diag("TSC_2304", "error", { line: 1, column: 1 });
    const letter = diag("TSC_SUPPRESSION_DIRECTIVE", "error", { line: 1, column: 1 });
    expect(orderForOutput([underscore, upper])).toEqual([upper, underscore]);
    expect(orderForOutput([letter, digit])).toEqual([digit, letter]);
  });

  it("FIDELITY_* mengikuti Requirement 10.12 dan urutan token masukan dalam satu kode", () => {
    const missing1 = diag("FIDELITY_TOKEN_MISSING", "error", undefined, "token-b");
    const missing2 = diag("FIDELITY_TOKEN_MISSING", "error", undefined, "token-a");
    const visible1 = diag("FIDELITY_FORBIDDEN_TOKEN_VISIBLE", "error", undefined, "token-z");
    const visible2 = diag("FIDELITY_FORBIDDEN_TOKEN_VISIBLE", "error", undefined, "token-c");
    const overlap = diag("FIDELITY_FORBIDDEN_OVERLAPS_REQUIRED", "warning", undefined, "token-m");
    const result = orderForOutput([visible1, missing1, visible2, overlap, missing2]);
    expect(result).toEqual([overlap, missing1, missing2, visible1, visible2]);
  });

  it("kode yang sama tanpa line (mis. RENDER per frame) mempertahankan urutan masukan", () => {
    const frames = [0, 7, 15, 22, 29].map((n) =>
      diag("RENDER_EMPTY", "error", undefined, `frame=${n} rendered no content`),
    );
    expect(orderForOutput(frames)).toEqual(frames);
  });

  it("tidak mengubah masukan, mengembalikan array baru, dan idempoten", () => {
    const input = Object.freeze([
      diag("RENDER_EMPTY", "error"),
      diag("SIZE_SOURCE_TOO_LARGE", "error"),
      diag("POLICY_JSX_SYNTAX", "error", { line: 3, column: 1 }),
    ]);
    const first = orderForOutput(input);
    expect(first).not.toBe(input);
    expect(input.map((d) => d.code)).toEqual(["RENDER_EMPTY", "SIZE_SOURCE_TOO_LARGE", "POLICY_JSX_SYNTAX"]);
    expect(orderForOutput(first)).toEqual(first);
  });

  it("dua pemanggilan atas masukan yang sama menghasilkan urutan identik (determinisme)", () => {
    const input = [
      diag("ESLINT_LORE_KIT_STYLE", "warning", { line: 4, column: 2 }),
      diag("POLICY_COLOR_LITERAL", "error", { line: 4, column: 2 }),
      diag("RENDER_CONSOLE_WARN", "warning"),
      diag("TSC_2304", "error", { line: 1, column: 1 }),
    ];
    expect(JSON.stringify(orderForOutput(input))).toBe(JSON.stringify(orderForOutput([...input])));
  });
});

describe("sifat finalize dan orderForOutput", () => {
  const codes = VERIFIER_ROWS.map((row) => row.code);
  const diagnosticArb = fc
    .record({
      code: fc.constantFrom(...codes),
      severity: fc.constantFrom<Severity>("error", "warning"),
      line: fc.option(fc.integer({ min: 1, max: 6 }), { nil: undefined }),
      column: fc.option(fc.integer({ min: 1, max: 4 }), { nil: undefined }),
    })
    .map(({ code, severity, line, column }) => makeDiagnostic(code, severity, "m", { line, column }));
  const listArb = fc.array(diagnosticArb, { maxLength: 30 });
  const maxArb = fc.integer({ min: 1, max: 12 });

  it("hasil paling banyak max, truncated sesuai jumlah, ok dari seluruh masukan", () => {
    fc.assert(
      fc.property(listArb, maxArb, (input, max) => {
        const result = finalize(input, { diagnostics_max: max });
        expect(result.diagnostics).toHaveLength(Math.min(input.length, max));
        expect(result.truncated).toBe(input.length > max);
        expect(result.ok).toBe(input.every((d) => d.severity !== "error"));
        for (const kept of result.diagnostics) expect(input).toContain(kept);
        expect(new Set(result.diagnostics).size).toBe(result.diagnostics.length);
      }),
    );
  });

  it("warning dibuang lebih dulu: error hilang hanya bila tidak ada warning tersisa", () => {
    fc.assert(
      fc.property(listArb, maxArb, (input, max) => {
        const result = finalize(input, { diagnostics_max: max });
        const errorsIn = input.filter((d) => d.severity === "error").length;
        const errorsOut = result.diagnostics.filter((d) => d.severity === "error").length;
        const warningsOut = result.diagnostics.length - errorsOut;
        if (errorsOut < errorsIn) expect(warningsOut).toBe(0);
        // Bila ada error di masukan dan max >= 1, setidaknya satu error selalu bertahan.
        if (errorsIn > 0) expect(errorsOut).toBeGreaterThan(0);
      }),
    );
  });

  it("keluaran sudah berurutan: orderForOutput atas hasil mengembalikan hasil yang sama", () => {
    fc.assert(
      fc.property(listArb, maxArb, (input, max) => {
        const result = finalize(input, { diagnostics_max: max });
        expect(orderForOutput(result.diagnostics)).toEqual(result.diagnostics);
      }),
    );
  });
});
