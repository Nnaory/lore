// Tes korpus: setiap Main_File di `fixtures/good`, `bad`, dan `warn` dijalankan melalui pipeline NYATA
// (ketujuh langkah, termasuk Worker render sungguhan) dan hasilnya dibandingkan dengan harapannya
// (tugas 8.2; Requirement 38.1, 38.2, 38.11, 37.6; design 5.14 dan 8.4).
//   - good/: `ok` true, nol Diagnostic `error`, dan ketujuh langkah berjalan (supaya `ok` bukan hasil
//     pipeline yang berhenti dini).
//   - bad/: `ok` false, sedikitnya satu galat, dan SEMUA kode pada `expected.json` muncul. Yang diperiksa
//     adalah SUBSET kode: fixture boleh menghasilkan kode tambahan (mis. `ESLINT_TYPESCRIPT_ESLINT_BAN_TS_COMMENT`
//     di samping `TSC_SUPPRESSION_DIRECTIVE`, atau `TSC_*` lain, atau `ESLINT_PARSE_ERROR`).
//   - warn/: `ok` true tanpa galat dan setiap kode yang diharapkan muncul sebagai `warning`.
//   - Tidak ada fixture mana pun yang boleh menghasilkan kode `VERIFIER_*`: itu berarti pipeline yang rusak
//     atau kehabisan waktu, bukan temuan tentang Main_File.
// Satu-satunya toleransi (`EQUIVALENT_CODES`): `bad/render-resource-limit.ts` menghabiskan heap Worker dalam
// sekitar 1,0 sampai 1,4 detik, sedangkan watchdog langkah 6 menyala pada 2000 ms tanpa kemajuan. Pada mesin
// yang lambat atau terbebani Worker itu dimatikan oleh watchdog lebih dulu, dan hasilnya `RENDER_FRAME_TIMEOUT`,
// bukan `RENDER_RESOURCE_LIMIT`. Keduanya berarti "Worker dimatikan karena Main_File menghabiskan sumber daya
// dan proses verifier selamat", jadi untuk fixture itu dan kode itu saja `RENDER_FRAME_TIMEOUT` diterima.
// Tes pencocok di bawah membuktikan toleransi ini tidak meluas ke pasangan fixture/kode lain.
//
// `.corpus-results.json` (di akar paket, diabaikan git) berisi hasil NYATA per berkas, dibaca skrip RIE
// (tugas 9.2) yang menjalankan berkas yang sama pada image Lambda dan membandingkan hasilnya:
//   { "<folder>/<berkas>.ts": { "ok": boolean, "codes": ["KODE", ...] }, ... }
// `<folder>` adalah `good`, `bad`, atau `warn`; `codes` adalah SEMUA kode Diagnostic yang dikembalikan
// verifier (galat dan peringatan), terurut menurut titik kode dan unik; kunci terurut. File ditulis hanya
// setelah seluruh korpus dijalankan, jadi tidak pernah berisi hasil sebagian.
// `fixtures/release-smoke.json` (dipakai `scripts/ci/verifier-release.sh`) menunjuk satu fixture bagus dan
// satu buruk; tes di bawah menjaganya tetap sesuai dengan korpus dan hasil pipeline.

import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { systemClock } from "../src/clock.js";
import { loadContract, type Contract } from "../src/contract.js";
import { DEFAULT_STEPS } from "../src/steps/registry.js";
import { createWorkerRenderHost } from "../src/steps/render-host.js";
import { createRenderStep } from "../src/steps/render.js";
import type { VerifierStep } from "../src/steps/step.js";
import type { Diagnostic, Tool, VerifierResult } from "../src/types.js";
import { safeVerify } from "../src/verify.js";
import { compileRenderWorker, type CompiledRenderWorker } from "./support/compile-render-worker.js";
import { loadCorpus, loadExpected, type CorpusEntry, type CorpusFolder } from "./support/corpus.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const FOLDERS: readonly CorpusFolder[] = ["good", "bad", "warn"];
const RESULTS_URL = new URL("../.corpus-results.json", import.meta.url);
const SMOKE_URL = new URL("../fixtures/release-smoke.json", import.meta.url);

/** Nama langkah 1 sampai 7 pada Requirement 6.16, ditulis ulang di tes. */
const TOOL_NAMES: readonly Tool[] = ["size", "policy", "eslint", "tsc", "esbuild", "render", "fidelity"];

const loaded = loadContract(
  JSON.parse(readFileSync(new URL("../contract/animation-contract.json", import.meta.url), "utf8")),
);
if (!loaded.ok) throw new Error(`kontrak sumber tidak sah: ${loaded.reason}`);
const contract: Contract = loaded.contract;

// ---- toleransi satu-satunya ----

/** `<folder>/<berkas>` -> kode yang diharapkan -> kode pengganti yang juga diterima untuk kode itu. */
const EQUIVALENT_CODES: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  "bad/render-resource-limit.ts": { RENDER_RESOURCE_LIMIT: ["RENDER_FRAME_TIMEOUT"] },
};

/**
 * Kode yang diharapkan tetapi tidak ada pada hasil. Sebuah kode terpenuhi bila hadir, atau bila salah satu
 * penggantinya yang terdaftar untuk fixture itu hadir. Urutan hasil mengikuti urutan `expected`.
 */
function missingCodes(
  key: string,
  expected: readonly string[],
  actual: ReadonlySet<string>,
  equivalents: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = EQUIVALENT_CODES,
): string[] {
  return expected.filter((code) => {
    if (actual.has(code)) return false;
    return !(equivalents[key]?.[code] ?? []).some((replacement) => actual.has(replacement));
  });
}

// ---- pipeline nyata ----

let compiled: CompiledRenderWorker | undefined;

beforeAll(() => {
  compiled = compileRenderWorker();
});
afterAll(() => {
  compiled?.dispose();
});

/** Registri produksi dengan langkah 6 yang memuat Worker hasil `tsc` di direktori sementara (ledger 6.2). */
function realSteps(workerUrl: URL): VerifierStep[] {
  return DEFAULT_STEPS.map((step) =>
    step.number === 6 ? createRenderStep(createWorkerRenderHost({ workerUrl })) : step,
  );
}

/** Hasil per fixture, dijalankan sekali walau dibaca beberapa tes. Kunci `<folder>/<berkas>`. */
const cache = new Map<string, Promise<VerifierResult>>();

function resultOf(folder: CorpusFolder, entry: CorpusEntry): Promise<VerifierResult> {
  const key = `${folder}/${entry.name}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  if (compiled === undefined) throw new Error("Worker render belum dikompilasi");
  const pending = safeVerify(
    {
      source: entry.source,
      kind: entry.kind,
      required_tokens: entry.required_tokens,
      forbidden_tokens: entry.forbidden_tokens,
      contract_version: contract.contract_version,
    },
    { clock: systemClock(), contract, steps: realSteps(compiled.workerUrl) },
  );
  cache.set(key, pending);
  return pending;
}

const corpora: Readonly<Record<CorpusFolder, CorpusEntry[]>> = {
  good: loadCorpus("good"),
  bad: loadCorpus("bad"),
  warn: loadCorpus("warn"),
};

const errorsOf = (diagnostics: readonly Diagnostic[]): string[] =>
  diagnostics.filter((d) => d.severity === "error").map((d) => `${d.tool} ${d.code}: ${d.message}`);

/** Kode terurut menurut titik kode dan unik: bentuk yang dibandingkan skrip RIE. */
const codesOf = (diagnostics: readonly Diagnostic[]): string[] => [
  ...new Set(diagnostics.map((d) => d.code)),
].sort();

const verifierCodesOf = (diagnostics: readonly Diagnostic[]): string[] =>
  codesOf(diagnostics).filter((code) => code.startsWith("VERIFIER_"));

// ---- pencocok toleransi ----

describe("missingCodes: toleransi hanya untuk satu fixture dan satu kode", () => {
  const key = "bad/render-resource-limit.ts";

  it("kode yang hadir terpenuhi, tanpa memandang pengganti", () => {
    expect(missingCodes(key, ["RENDER_RESOURCE_LIMIT"], new Set(["RENDER_RESOURCE_LIMIT"]))).toEqual([]);
  });

  it("RENDER_FRAME_TIMEOUT menggantikan RENDER_RESOURCE_LIMIT pada fixture itu", () => {
    expect(missingCodes(key, ["RENDER_RESOURCE_LIMIT"], new Set(["RENDER_FRAME_TIMEOUT"]))).toEqual([]);
  });

  it("tanpa salah satunya kode dilaporkan hilang", () => {
    expect(missingCodes(key, ["RENDER_RESOURCE_LIMIT"], new Set(["RENDER_EXCEPTION"]))).toEqual([
      "RENDER_RESOURCE_LIMIT",
    ]);
  });

  it("fixture lain tidak mendapat toleransi", () => {
    expect(
      missingCodes("bad/render-frame-timeout.ts", ["RENDER_RESOURCE_LIMIT"], new Set(["RENDER_FRAME_TIMEOUT"])),
    ).toEqual(["RENDER_RESOURCE_LIMIT"]);
  });

  it("kode lain pada fixture itu tidak mendapat toleransi", () => {
    expect(missingCodes(key, ["RENDER_EMPTY"], new Set(["RENDER_FRAME_TIMEOUT"]))).toEqual(["RENDER_EMPTY"]);
  });

  it("tabel toleransi hanya memuat fixture yang ada di bad/ dan kodenya ada pada expected.json", () => {
    const expected = loadExpected("bad");
    for (const [fixtureKey, replacements] of Object.entries(EQUIVALENT_CODES)) {
      const name = fixtureKey.replace(/^bad\//, "");
      expect(fixtureKey.startsWith("bad/"), fixtureKey).toBe(true);
      for (const code of Object.keys(replacements)) {
        expect(expected[name] ?? [], fixtureKey).toContain(code);
      }
    }
  });

  it("mengembalikan semua kode yang hilang menurut urutan expected", () => {
    expect(missingCodes("bad/x.ts", ["B", "A", "C"], new Set(["A"]))).toEqual(["B", "C"]);
  });
});

// ---- korpus ----

describe("korpus: jumlah fixture", () => {
  it("good/ memuat sedikitnya 8, bad/ sedikitnya 31, dan warn/ tiga fixture (Requirement 38.1, 38.2, 38.11)", () => {
    expect(corpora.good.length).toBeGreaterThanOrEqual(8);
    expect(corpora.bad.length).toBeGreaterThanOrEqual(31);
    expect(corpora.warn.length).toBeGreaterThanOrEqual(3);
  });

  it("setiap fixture bad/ dan warn/ punya kode yang diharapkan di expected.json", () => {
    for (const folder of ["bad", "warn"] as const) {
      for (const entry of corpora[folder]) {
        expect(entry.expectedCodes?.length ?? 0, `${folder}/${entry.name}`).toBeGreaterThanOrEqual(1);
      }
    }
  });
});

describe("korpus good/: ok true tanpa Diagnostic error (Requirement 38.1)", () => {
  it.each(corpora.good.map((entry) => entry.name))("%s", async (name) => {
    const entry = corpora.good.find((candidate) => candidate.name === name);
    if (entry === undefined) throw new Error(`fixture hilang: ${name}`);
    const result = await resultOf("good", entry);

    expect(errorsOf(result.diagnostics)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(verifierCodesOf(result.diagnostics)).toEqual([]);
    expect(result.summary.checks.map((check) => check.name)).toEqual(TOOL_NAMES);
    expect(result.summary.checks.every((check) => check.ok)).toBe(true);
  });
});

describe("korpus bad/: ok false dan semua kode pada expected.json (Requirement 38.2)", () => {
  it.each(corpora.bad.map((entry) => entry.name))("%s", async (name) => {
    const entry = corpora.bad.find((candidate) => candidate.name === name);
    if (entry === undefined) throw new Error(`fixture hilang: ${name}`);
    const result = await resultOf("bad", entry);
    const actual = new Set(result.diagnostics.map((diagnostic) => diagnostic.code));

    expect(missingCodes(`bad/${name}`, entry.expectedCodes ?? [], actual), [...actual].sort().join(", ")).toEqual([]);
    expect(result.ok).toBe(false);
    expect(errorsOf(result.diagnostics).length).toBeGreaterThanOrEqual(1);
    expect("bundle" in result).toBe(false);
    expect("meta" in result).toBe(false);
    expect(verifierCodesOf(result.diagnostics)).toEqual([]);
  });
});

describe("korpus warn/: ok true dengan peringatan yang diharapkan (Requirement 38.11)", () => {
  it.each(corpora.warn.map((entry) => entry.name))("%s", async (name) => {
    const entry = corpora.warn.find((candidate) => candidate.name === name);
    if (entry === undefined) throw new Error(`fixture hilang: ${name}`);
    const result = await resultOf("warn", entry);

    expect(errorsOf(result.diagnostics)).toEqual([]);
    expect(result.ok).toBe(true);
    for (const code of entry.expectedCodes ?? []) {
      const severities = result.diagnostics.filter((d) => d.code === code).map((d) => d.severity);
      expect(severities.length, code).toBeGreaterThanOrEqual(1);
      expect(new Set(severities), code).toEqual(new Set(["warning"]));
    }
    expect(verifierCodesOf(result.diagnostics)).toEqual([]);
    if (result.ok) {
      expect(result.bundle.length).toBeGreaterThan(0);
      expect(result.meta.durationInFrames).toBeGreaterThan(0);
    }
  });
});

// ---- fixtures/release-smoke.json ----

const SmokeSchema = z
  .object({
    description: z.string().min(1),
    good: z
      .object({
        source: z.string().regex(/^good\/[a-z0-9-]+\.ts$/),
        companion: z.string().regex(/^good\/[a-z0-9-]+\.json$/),
      })
      .strict(),
    bad: z
      .object({
        source: z.string().regex(/^bad\/[a-z0-9-]+\.ts$/),
        companion: z
          .string()
          .regex(/^bad\/[a-z0-9-]+\.json$/)
          .optional(),
        expected_codes: z.array(z.string().min(1)).min(1),
      })
      .strict(),
  })
  .strict();

describe("fixtures/release-smoke.json (dipakai verifier-release.sh)", () => {
  const parsed = SmokeSchema.safeParse(JSON.parse(readFileSync(SMOKE_URL, "utf8")));

  it("berbentuk sah", () => {
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
  });

  it("menunjuk fixture good/ dan bad/ yang ada, beserta pendampingnya", () => {
    if (!parsed.success) throw new Error("release-smoke.json tidak sah");
    const { good, bad } = parsed.data;
    const goodEntry = corpora.good.find((entry) => `good/${entry.name}` === good.source);
    const badEntry = corpora.bad.find((entry) => `bad/${entry.name}` === bad.source);
    expect(goodEntry, good.source).toBeDefined();
    expect(badEntry, bad.source).toBeDefined();
    expect(good.companion).toBe(good.source.replace(/\.ts$/, ".json"));
    expect(goodEntry?.hasCompanion).toBe(true);
    // Pendamping fixture buruk wajib ditulis bila (dan hanya bila) fixture itu punya pendamping di disk.
    expect(bad.companion).toBe(badEntry?.hasCompanion === true ? bad.source.replace(/\.ts$/, ".json") : undefined);
  });

  it("expected_codes sama persis dengan entri fixture buruk di bad/expected.json", () => {
    if (!parsed.success) throw new Error("release-smoke.json tidak sah");
    const name = parsed.data.bad.source.replace(/^bad\//, "");
    expect(parsed.data.bad.expected_codes).toEqual(loadExpected("bad")[name]);
  });

  it("fixture bagus lolos dan fixture buruk gagal dengan kodenya, tanpa kode VERIFIER_* (hasil pipeline nyata)", async () => {
    if (!parsed.success) throw new Error("release-smoke.json tidak sah");
    const { good, bad } = parsed.data;
    const goodEntry = corpora.good.find((entry) => `good/${entry.name}` === good.source);
    const badEntry = corpora.bad.find((entry) => `bad/${entry.name}` === bad.source);
    if (goodEntry === undefined || badEntry === undefined) throw new Error("fixture smoke tidak ditemukan");

    const goodResult = await resultOf("good", goodEntry);
    expect(goodResult.ok).toBe(true);

    const badResult = await resultOf("bad", badEntry);
    expect(badResult.ok).toBe(false);
    const actual = new Set(badResult.diagnostics.map((diagnostic) => diagnostic.code));
    // Skrip rilis memeriksa kode secara harfiah (tanpa toleransi), jadi fixture itu tidak boleh yang bertoleransi.
    expect(EQUIVALENT_CODES[bad.source]).toBeUndefined();
    expect(bad.expected_codes.filter((code) => !actual.has(code))).toEqual([]);
    expect(verifierCodesOf(badResult.diagnostics)).toEqual([]);
  });
});

// ---- .corpus-results.json ----

const ResultsSchema = z.record(
  z
    .object({
      ok: z.boolean(),
      codes: z.array(z.string().regex(/^[A-Z]+_[A-Z0-9_]+$/)),
    })
    .strict(),
);

describe(".corpus-results.json (dibaca skrip RIE)", () => {
  it("ditulis dari hasil nyata seluruh korpus, terurut dan tanpa duplikat", async () => {
    const results: Record<string, { ok: boolean; codes: string[] }> = {};
    for (const folder of FOLDERS) {
      for (const entry of corpora[folder]) {
        const result = await resultOf(folder, entry);
        results[`${folder}/${entry.name}`] = { ok: result.ok, codes: codesOf(result.diagnostics) };
      }
    }
    const sorted = Object.fromEntries(Object.entries(results).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    writeFileSync(RESULTS_URL, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");

    // Baca ulang dari disk: bentuk, kunci, dan urutan yang dibaca skrip RIE.
    const onDisk = ResultsSchema.parse(JSON.parse(readFileSync(RESULTS_URL, "utf8")));
    expect(Object.keys(onDisk)).toEqual(
      FOLDERS.flatMap((folder) => corpora[folder].map((entry) => `${folder}/${entry.name}`)).sort(),
    );
    for (const [key, value] of Object.entries(onDisk)) {
      expect(value.codes, key).toEqual([...new Set(value.codes)].sort());
      expect(value.ok, key).toBe(!key.startsWith("bad/"));
    }
    expect(onDisk).toEqual(sorted);
  });
});
