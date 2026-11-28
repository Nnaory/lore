// Tes langkah 1, ukuran dan encoding (tugas 4.1; Requirement 7.1, 7.2, 7.18, 6.5, 1.1, 1.12, 1.14,
// 38.10; design 5.4). Batas ukuran dibaca dari kontrak, jadi tes memakai `limits.source_max_bytes`
// sebagai satu-satunya sumber angka 32768 dan hanya menegaskan nilainya sekali. Emoji dan huruf
// berakses dipakai untuk membedakan hitungan byte UTF-8 dari panjang string (unit UTF-16).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/clock.js";
import { loadContract, type Contract } from "../src/contract.js";
import { DEFAULT_STEPS } from "../src/steps/registry.js";
import { hasInvalidEncoding, sizeStep, utf8ByteLength } from "../src/steps/size.js";
import { createStepContext, indexSteps } from "../src/steps/step.js";
import type { Diagnostic } from "../src/types.js";
import { safeVerify } from "../src/verify.js";

// ---- kontrak dan konteks ----

const CONTRACT_URL = new URL("../contract/animation-contract.json", import.meta.url);
const RAW_CONTRACT = JSON.parse(readFileSync(CONTRACT_URL, "utf8")) as Record<string, unknown>;
const loaded = loadContract(RAW_CONTRACT);
if (!loaded.ok) throw new Error(`kontrak sumber tidak sah: ${loaded.reason}`);
const contract: Contract = loaded.contract;
const LIMIT = contract.limits.source_max_bytes;

function inputFor(source: string) {
  return {
    source,
    kind: "lesson" as const,
    required_tokens: [],
    forbidden_tokens: [],
    contract_version: contract.contract_version,
  };
}

async function runStep(source: string, using: Contract = contract): Promise<readonly Diagnostic[]> {
  const context = createStepContext({
    input: inputFor(source),
    contract: using,
    clock: new FakeClock(),
    deadlineAt: Number.POSITIVE_INFINITY,
  });
  return (await sizeStep.run(context)).diagnostics;
}

function codesOf(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((diagnostic) => diagnostic.code);
}

/** Padding ASCII sehingga `prefix` + padding tepat `bytes` byte UTF-8. */
function padTo(prefix: string, bytes: number): string {
  return prefix + "a".repeat(bytes - utf8ByteLength(prefix));
}

const BOM = "\uFEFF";
const EMOJI = "\u{1F600}"; // 4 byte UTF-8, 2 unit UTF-16

// ---- batas ukuran ----

describe("langkah 1: batas ukuran", () => {
  it("kontrak sumber menetapkan batas 32768 byte", () => {
    expect(LIMIT).toBe(32768);
  });

  it("tepat 32768 byte lolos", async () => {
    const source = "a".repeat(LIMIT);
    expect(utf8ByteLength(source)).toBe(LIMIT);
    expect(await runStep(source)).toEqual([]);
  });

  it("32769 byte menghasilkan satu SIZE_SOURCE_TOO_LARGE tanpa posisi", async () => {
    const diagnostics = await runStep("a".repeat(LIMIT + 1));
    expect(diagnostics).toEqual([
      {
        tool: "size",
        code: "SIZE_SOURCE_TOO_LARGE",
        severity: "error",
        message: `source is ${LIMIT + 1} bytes, limit is ${LIMIT}`,
      },
    ]);
  });

  it("memakai batas dari kontrak yang dimuat, bukan literal", async () => {
    const small = loadContract({
      ...RAW_CONTRACT,
      limits: { ...(RAW_CONTRACT.limits as Record<string, unknown>), source_max_bytes: 100 },
    });
    expect(small.ok).toBe(true);
    if (!small.ok) return;
    expect(await runStep("a".repeat(100), small.contract)).toEqual([]);
    const over = await runStep("a".repeat(101), small.contract);
    expect(codesOf(over)).toEqual(["SIZE_SOURCE_TOO_LARGE"]);
    expect(over[0]?.message).toBe("source is 101 bytes, limit is 100");
  });
});

describe("langkah 1: ukuran dihitung dalam byte UTF-8", () => {
  it("emoji 4 byte: 8192 emoji (16384 unit UTF-16) tepat di batas dan lolos", async () => {
    const source = EMOJI.repeat(LIMIT / 4);
    expect(source.length).toBeLessThan(LIMIT);
    expect(utf8ByteLength(source)).toBe(LIMIT);
    expect(await runStep(source)).toEqual([]);
  });

  it("satu byte di atas batas gagal walau panjang string jauh di bawah batas", async () => {
    const diagnostics = await runStep(EMOJI.repeat(LIMIT / 4) + "a");
    expect(codesOf(diagnostics)).toEqual(["SIZE_SOURCE_TOO_LARGE"]);
    expect(diagnostics[0]?.message).toBe(`source is ${LIMIT + 1} bytes, limit is ${LIMIT}`);

    const emojiOnly = EMOJI.repeat(LIMIT / 4 + 1);
    expect(emojiOnly.length).toBeLessThan(LIMIT);
    expect(codesOf(await runStep(emojiOnly))).toEqual(["SIZE_SOURCE_TOO_LARGE"]);
  });

  it("huruf berakses (2 byte) dan tanda mata uang (3 byte) dihitung per byte", async () => {
    expect(await runStep("\u00e9".repeat(LIMIT / 2))).toEqual([]);
    expect(codesOf(await runStep("\u00e9".repeat(LIMIT / 2) + "a"))).toEqual(["SIZE_SOURCE_TOO_LARGE"]);
    // 10922 x 3 = 32766 lolos, 10923 x 3 = 32769 gagal.
    expect(await runStep("\u20ac".repeat(10922))).toEqual([]);
    expect(codesOf(await runStep("\u20ac".repeat(10923)))).toEqual(["SIZE_SOURCE_TOO_LARGE"]);
  });
});

// ---- encoding ----

describe("langkah 1: encoding tidak valid", () => {
  const invalid: ReadonlyArray<readonly [string, string]> = [
    ["NUL di tengah", "export const meta = {};\u0000\n"],
    ["NUL di awal", "\u0000export const meta = {};"],
    ["NUL sendirian", "\u0000"],
    ["BOM di indeks 0", `${BOM}export const meta = {};\n`],
    ["BOM sendirian", BOM],
    ["surrogat tinggi sendirian", "a\uD800b"],
    ["surrogat rendah sendirian", "a\uDC00b"],
    ["surrogat tinggi di akhir", "const x = 1; \uD83D"],
    ["surrogat rendah di awal", "\uDE00 const x = 1;"],
    ["pasangan terbalik", "\uDE00\uD83D"],
    ["dua surrogat tinggi lalu satu rendah", "\uD83D\uD83D\uDE00"],
    ["surrogat rendah berlebih setelah pasangan sah", "\uD83D\uDE00\uDE00"],
  ];

  it.each(invalid)("%s menghasilkan satu ENCODING_INVALID", async (_name, source) => {
    expect(hasInvalidEncoding(source)).toBe(true);
    const diagnostics = await runStep(source);
    expect(diagnostics).toEqual([
      {
        tool: "size",
        code: "ENCODING_INVALID",
        severity: "error",
        message: "source contains NUL, a lone surrogate, or a BOM",
      },
    ]);
  });

  it("beberapa pelanggaran encoding sekaligus tetap satu Diagnostic", async () => {
    expect(codesOf(await runStep(`${BOM}a\u0000b\uD800c`))).toEqual(["ENCODING_INVALID"]);
  });

  it("BOM tepat di batas ukuran: 32768 byte lolos ukuran lalu gagal encoding", async () => {
    const source = padTo(BOM, LIMIT);
    expect(utf8ByteLength(source)).toBe(LIMIT);
    expect(codesOf(await runStep(source))).toEqual(["ENCODING_INVALID"]);
  });

  it("surrogat tunggal dihitung 3 byte (U+FFFD): 32768 byte gagal encoding, 32769 gagal ukuran", async () => {
    expect(codesOf(await runStep(padTo("\uD800", LIMIT)))).toEqual(["ENCODING_INVALID"]);
    expect(codesOf(await runStep(padTo("\uD800", LIMIT + 1)))).toEqual(["SIZE_SOURCE_TOO_LARGE"]);
  });
});

describe("langkah 1: sumber yang lolos", () => {
  const valid: ReadonlyArray<readonly [string, string]> = [
    ["file kosong", ""],
    ["spasi dan baris baru saja", "  \t\r\n\n   \u00a0\u3000"],
    ["komentar baris saja", "// tidak ada kode di sini\n"],
    ["komentar blok saja", "/* tidak ada kode di sini */"],
    ["pasangan surrogat sah (emoji)", `// ${EMOJI}\nexport const meta = {};\n`],
    ["BOM bukan di indeks 0 adalah spasi ECMAScript biasa", `export const meta = {};${BOM}\n`],
    ["karakter kontrol selain NUL", "a\u0001\u0008\u001f\u007fb"],
    ["U+FFFD yang sah", "a\uFFFDb"],
  ];

  it.each(valid)("%s lolos tanpa Diagnostic (Requirement 1.14)", async (_name, source) => {
    expect(hasInvalidEncoding(source)).toBe(false);
    expect(await runStep(source)).toEqual([]);
  });
});

// ---- ukuran menang atas encoding ----

describe("langkah 1: ukuran lebih dulu, encoding tidak diperiksa (Requirement 7.18)", () => {
  const oversizeWithBadEncoding: ReadonlyArray<readonly [string, string]> = [
    ["NUL", "a".repeat(LIMIT) + "\u0000"],
    ["BOM di indeks 0", padTo(BOM, LIMIT + 1)],
    ["surrogat tunggal", padTo("\uD800", LIMIT + 1)],
    ["ketiganya", padTo(`${BOM}\u0000\uD800`, LIMIT + 1)],
  ];

  it.each(oversizeWithBadEncoding)("32769 byte dengan %s hanya melapor SIZE_*", async (_name, source) => {
    expect(utf8ByteLength(source)).toBe(LIMIT + 1);
    expect(hasInvalidEncoding(source)).toBe(true);
    const diagnostics = await runStep(source);
    expect(codesOf(diagnostics)).toEqual(["SIZE_SOURCE_TOO_LARGE"]);
    expect(diagnostics.every((diagnostic) => diagnostic.tool === "size")).toBe(true);
  });
});

// ---- pendaftaran dan alur pipeline ----

describe("registri produksi memuat langkah 1", () => {
  it("DEFAULT_STEPS memuat langkah bernomor 1 yaitu sizeStep, dan registri tetap valid", () => {
    const step = DEFAULT_STEPS.find((candidate) => candidate.number === 1);
    expect(step).toBe(sizeStep);
    expect(indexSteps(DEFAULT_STEPS).ok).toBe(true);
  });

  it("lewat verify() dengan registri produksi: sumber terlalu besar berhenti di langkah 1", async () => {
    const result = await safeVerify(inputFor("a".repeat(LIMIT + 1)), {
      clock: new FakeClock(),
      contract,
    });
    expect(result.ok).toBe(false);
    expect(codesOf(result.diagnostics)).toEqual(["SIZE_SOURCE_TOO_LARGE"]);
    expect(result.summary.checks.map(({ name, ok }) => ({ name, ok }))).toEqual([
      { name: "size", ok: false },
    ]);
    expect("bundle" in result).toBe(false);
  });

  it("lewat verify() dengan registri produksi: encoding salah berhenti di langkah 1", async () => {
    const result = await safeVerify(inputFor("export const meta = {};\u0000"), {
      clock: new FakeClock(),
      contract,
    });
    expect(result.ok).toBe(false);
    expect(codesOf(result.diagnostics)).toEqual(["ENCODING_INVALID"]);
    expect(result.summary.checks.map(({ name, ok }) => ({ name, ok }))).toEqual([
      { name: "size", ok: false },
    ]);
  });
});
