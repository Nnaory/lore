// Tes pipeline lengkap `verify()`: aturan alir, urutan keluaran, ringkasan, dan ketujuh langkah nyata
// (tugas 7.2; Requirement 6.4 sampai 6.7, 6.9, 6.10, 6.11, 6.16, 6.17, 9.10; design 5.3 butir 4 sampai 8).
// Tiga lapis:
//  (1) langkah palsu: setiap cabang aturan alir diuji dengan tabel penuh 3^7 kombinasi hasil
//      (bersih, peringatan, galat) terhadap oracle yang ditulis ulang dari Requirement 6.5 sampai 6.7,
//      lalu `ok` sebelum pemotongan, urutan keluaran, `ms`, dan deadline (`VERIFIER_DEADLINE` menghentikan
//      sisa langkah);
//  (2) langkah 1 sampai 5 nyata + `FakeRenderHost` + langkah 7 nyata: format `frame=<n>` pada setiap
//      kode `RENDER_*` dan `FIDELITY_*` yang terkait frame, dan deadline di tengah langkah 6;
//  (3) ketujuh langkah NYATA, termasuk Worker render sungguhan. Host render produksi memuat
//      `render-worker.js` dari `dist/steps/`, jadi tes memakai `compileRenderWorker()` dan mengganti
//      langkah 6 dengan `createRenderStep(createWorkerRenderHost({ workerUrl }))` (ledger 6.2). Seluruh
//      `fixtures/good/*.ts` harus `ok: true` dengan tujuh `checks`; sumber yang diubah sedikit
//      membuktikan tiap titik berhenti pada pipeline nyata.
// Tes properti determinisme (7.3) dan korpus bad/warn (8.x) sengaja bukan bagian berkas ini.
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeClock, systemClock, type Clock } from "../src/clock.js";
import { loadContract, type Contract } from "../src/contract.js";
import { fidelityStep } from "../src/steps/fidelity.js";
import { DEFAULT_STEPS } from "../src/steps/registry.js";
import { createWorkerRenderHost } from "../src/steps/render-host.js";
import type { FrameCapture, ResultMessage } from "../src/steps/render-core.js";
import {
  FakeRenderHost,
  createRenderStep,
  type FakeRenderScript,
  type RenderHost,
  type RenderRequest,
} from "../src/steps/render.js";
import {
  BUNDLE_ARTIFACT,
  META_ARTIFACT,
  STEP_NUMBERS,
  type StepContext,
  type StepNumber,
  type VerifierStep,
} from "../src/steps/step.js";
import type { Diagnostic, Kind, MainMeta, Tool, VerifierResult } from "../src/types.js";
import { verify } from "../src/verify.js";
import { compileRenderWorker, type CompiledRenderWorker } from "./support/compile-render-worker.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// ---- kontrak dan pembantu bersama ----

const loaded = loadContract(
  JSON.parse(readFileSync(new URL("../contract/animation-contract.json", import.meta.url), "utf8")),
);
if (!loaded.ok) throw new Error(`kontrak sumber tidak sah: ${loaded.reason}`);
const contract: Contract = loaded.contract;
const DEADLINE_MS = contract.limits.verifier_deadline_ms;

/** Nama langkah 1 sampai 7 pada Requirement 6.16, ditulis ulang di tes (bukan dari `STEP_TOOL`). */
const TOOL_NAMES: readonly Tool[] = ["size", "policy", "eslint", "tsc", "esbuild", "render", "fidelity"];

const META: MainMeta = { width: 1280, height: 720, fps: 30, durationInFrames: 30 };
const BUNDLE_TEXT = "BUNDLE_TEXT";

interface EventParts {
  source?: string;
  kind?: Kind;
  required_tokens?: string[];
  forbidden_tokens?: string[];
}

function eventOf(parts: EventParts = {}): Record<string, unknown> {
  return {
    source: parts.source ?? "export default function Main() { return null }",
    kind: parts.kind ?? "lesson",
    required_tokens: parts.required_tokens ?? ["alpha"],
    forbidden_tokens: parts.forbidden_tokens ?? [],
    contract_version: contract.contract_version,
  };
}

const codesOf = (diagnostics: readonly Diagnostic[]): string[] => diagnostics.map((d) => d.code);
const messagesOf = (diagnostics: readonly Diagnostic[]): string[] => diagnostics.map((d) => d.message);
const errorsOf = (diagnostics: readonly Diagnostic[]): Diagnostic[] =>
  diagnostics.filter((d) => d.severity === "error");

/** Kode yang terkait satu frame (Requirement 6.17); lainnya (console, meta, memori) tanpa `frame=`. */
const FRAME_RELATED = /^(RENDER_(EXCEPTION|DOM_LIMIT|EMPTY|NONDETERMINISTIC|FRAME_TIMEOUT)|FIDELITY_(TOKEN_MISSING|FORBIDDEN_TOKEN_VISIBLE))$/;
const FRAME_MARK = /(^|\s)frame=(\d+|evaluate)(\s|$)/;

/** Invarian yang berlaku untuk hasil mana pun: `tool` sesuai langkah yang berjalan dan format `frame=`. */
function expectWellFormed(result: VerifierResult): void {
  const ran = new Set<string>(result.summary.checks.map((check) => check.name));
  for (const diagnostic of result.diagnostics) {
    expect(ran.has(diagnostic.tool) || diagnostic.tool === "verifier", diagnostic.code).toBe(true);
    expect(diagnostic.message.length).toBeLessThanOrEqual(contract.limits.diagnostic_message_max_chars);
    if (FRAME_RELATED.test(diagnostic.code)) {
      expect(diagnostic.message, diagnostic.code).toMatch(FRAME_MARK);
      expect(diagnostic.line, diagnostic.code).toBeUndefined();
    }
  }
  for (const check of result.summary.checks) {
    expect(Number.isInteger(check.ms) && check.ms >= 0, check.name).toBe(true);
  }
  // Galat selalu dipertahankan lebih dulu daripada peringatan, jadi `ok` sama dengan "tanpa galat tersisa".
  expect(result.ok).toBe(errorsOf(result.diagnostics).length === 0);
  expect(result.ok === ("bundle" in result)).toBe(true);
  expect(result.ok === ("meta" in result)).toBe(true);
}

// ---- lapis 1: langkah palsu ----

type Outcome = "clean" | "warning" | "error";
const OUTCOMES: readonly Outcome[] = ["clean", "warning", "error"];

/** Satu kode per langkah; awalannya menentukan `tool`, jadi urutan keluaran dapat diperiksa. */
const STEP_CODE: Readonly<Record<StepNumber, string>> = {
  1: "SIZE_SOURCE_TOO_LARGE",
  2: "POLICY_JSX_SYNTAX",
  3: "ESLINT_PARSE_ERROR",
  4: "TSC_2322",
  5: "BUNDLE_FAILED",
  6: "RENDER_EXCEPTION",
  7: "FIDELITY_TOKEN_MISSING",
};

type Behaviour = (context: StepContext) => readonly Diagnostic[];

interface Rig {
  steps: VerifierStep[];
  /** Nomor langkah menurut urutan pemanggilan. */
  ran: StepNumber[];
}

/**
 * Tujuh langkah uji. Langkah 2 mengisi meta dan langkah 5 mengisi bundle (seperti langkah sungguhan);
 * Diagnostic dan efek samping lain (memajukan jam) berasal dari `behaviours`.
 */
function rig(behaviours: Partial<Record<StepNumber, Behaviour>> = {}): Rig {
  const ran: StepNumber[] = [];
  const steps = STEP_NUMBERS.map(
    (number): VerifierStep => ({
      number,
      run: (context) => {
        ran.push(number);
        if (number === 2) context.artifacts.set(META_ARTIFACT, { ...META });
        if (number === 5) context.artifacts.set(BUNDLE_ARTIFACT, BUNDLE_TEXT);
        return { diagnostics: behaviours[number]?.(context) ?? [] };
      },
    }),
  );
  return { steps, ran };
}

function byOutcome(number: StepNumber, outcome: Outcome): Behaviour {
  return (context) =>
    outcome === "clean" ? [] : [context.diagnostic(STEP_CODE[number], outcome, `step ${number}`)];
}

function emit(...items: Array<[code: string, severity: "error" | "warning", message?: string, line?: number, column?: number]>): Behaviour {
  return (context) =>
    items.map(([code, severity, message, line, column]) =>
      context.diagnostic(code, severity, message ?? "m", line === undefined ? undefined : { line, column }),
    );
}

async function runFake(
  steps: readonly VerifierStep[],
  clock: Clock = new FakeClock(),
  event: Record<string, unknown> = eventOf(),
): Promise<VerifierResult> {
  return verify(event, { clock, contract, steps });
}

describe("registri produksi memuat ketujuh langkah", () => {
  it("nomor 1 sampai 7, masing-masing tepat satu", () => {
    expect(DEFAULT_STEPS.map((step) => step.number).sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("aturan alir: tabel penuh 3^7 kombinasi hasil langkah (Requirement 6.4 sampai 6.7)", () => {
  /** Oracle dari Requirement 6.5 sampai 6.7, ditulis sebagai urutan if, bukan salinan `mayRun`. */
  function expectedRan(outcomeOf: (step: StepNumber) => Outcome): StepNumber[] {
    const failed = (...steps: StepNumber[]): boolean => steps.some((step) => outcomeOf(step) === "error");
    if (failed(1)) return [1];
    if (failed(2, 3, 4)) return [1, 2, 3, 4];
    if (failed(5)) return [1, 2, 3, 4, 5];
    if (failed(6)) return [1, 2, 3, 4, 5, 6];
    return [1, 2, 3, 4, 5, 6, 7];
  }

  const combinations = STEP_NUMBERS.reduce<Outcome[][]>(
    (prefixes) => prefixes.flatMap((prefix) => OUTCOMES.map((outcome) => [...prefix, outcome])),
    [[]],
  );

  it("memuat 2187 kombinasi", () => {
    expect(combinations).toHaveLength(OUTCOMES.length ** STEP_NUMBERS.length);
  });

  it("langkah yang berjalan, checks, diagnostics, ok, bundle, dan meta mengikuti oracle di setiap kombinasi", async () => {
    const problems: string[] = [];
    for (const combination of combinations) {
      const outcomeOf = (step: StepNumber): Outcome => combination[step - 1] ?? "clean";
      const behaviours: Partial<Record<StepNumber, Behaviour>> = {};
      for (const step of STEP_NUMBERS) behaviours[step] = byOutcome(step, outcomeOf(step));
      const { steps, ran } = rig(behaviours);
      const result = await runFake(steps);

      const expected = expectedRan(outcomeOf);
      const label = combination.join(",");
      const expectedDiagnostics = expected
        .filter((step) => outcomeOf(step) !== "clean")
        .map((step) => `${STEP_CODE[step]}:${outcomeOf(step)}`);
      const actualDiagnostics = result.diagnostics.map((d) => `${d.code}:${d.severity}`);
      const expectedOk = !expected.some((step) => outcomeOf(step) === "error");

      const checks = JSON.stringify(result.summary.checks.map((c) => [c.name, c.ok]));
      const expectedChecks = JSON.stringify(expected.map((step) => [TOOL_NAMES[step - 1], outcomeOf(step) !== "error"]));
      if (JSON.stringify(ran) !== JSON.stringify(expected)) problems.push(`${label}: ran ${ran.join("")}`);
      if (checks !== expectedChecks) problems.push(`${label}: checks ${checks}`);
      if (JSON.stringify(actualDiagnostics) !== JSON.stringify(expectedDiagnostics)) {
        problems.push(`${label}: diagnostics ${actualDiagnostics.join("|")}`);
      }
      if (result.ok !== expectedOk) problems.push(`${label}: ok ${String(result.ok)}`);
      if (("bundle" in result) !== expectedOk || ("meta" in result) !== expectedOk) {
        problems.push(`${label}: bundle/meta presence`);
      }
      if (expectedOk && expected.length !== 7) problems.push(`${label}: ok tanpa ketujuh langkah`);
      if (result.summary.truncated) problems.push(`${label}: truncated`);
    }
    expect(problems).toEqual([]);
  });

  it("langkah 1 galat: hanya langkah 1 berjalan dan galat langkah lain tidak ikut dilaporkan", async () => {
    const { steps, ran } = rig({
      1: byOutcome(1, "error"),
      2: byOutcome(2, "error"),
      3: byOutcome(3, "error"),
      7: byOutcome(7, "error"),
    });
    const result = await runFake(steps);
    expect(ran).toEqual([1]);
    expect(codesOf(result.diagnostics)).toEqual(["SIZE_SOURCE_TOO_LARGE"]);
    expect(result.summary.checks).toEqual([{ name: "size", ok: false, ms: 0 }]);
  });

  it("langkah 2, 3, dan 4 galat bersama dilaporkan dalam satu hasil, dan langkah 5 sampai 7 tidak jalan", async () => {
    const { steps, ran } = rig({
      2: byOutcome(2, "error"),
      3: byOutcome(3, "error"),
      4: byOutcome(4, "error"),
      5: byOutcome(5, "error"),
      6: byOutcome(6, "error"),
      7: byOutcome(7, "error"),
    });
    const result = await runFake(steps);
    expect(ran).toEqual([1, 2, 3, 4]);
    expect(codesOf(result.diagnostics)).toEqual(["POLICY_JSX_SYNTAX", "ESLINT_PARSE_ERROR", "TSC_2322"]);
    expect(result.summary.checks.map((c) => [c.name, c.ok])).toEqual([
      ["size", true],
      ["policy", false],
      ["eslint", false],
      ["tsc", false],
    ]);
  });

  it("langkah 1 hanya berperingatan: langkah 2 sampai 7 tetap berjalan", async () => {
    const { steps, ran } = rig({ 1: byOutcome(1, "warning") });
    const result = await runFake(steps);
    expect(ran).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result.ok).toBe(true);
  });

  it("peringatan di semua langkah: ok true, ketujuh Diagnostic ada, bundle dan meta disertakan", async () => {
    const behaviours: Partial<Record<StepNumber, Behaviour>> = {};
    for (const step of STEP_NUMBERS) behaviours[step] = byOutcome(step, "warning");
    const result = await runFake(rig(behaviours).steps);
    expect(result.ok).toBe(true);
    expect(result.diagnostics.map((d) => d.severity)).toEqual(Array.from({ length: 7 }, () => "warning"));
    expect(result.summary.checks.every((check) => check.ok)).toBe(true);
    if (result.ok) {
      expect(result.bundle).toBe(BUNDLE_TEXT);
      expect(result.meta).toEqual(META);
    }
  });

  it("urutan langkah di daftar yang diberikan tidak memengaruhi urutan berjalan", async () => {
    const { steps, ran } = rig();
    const result = await runFake([...steps].reverse());
    expect(ran).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result.summary.checks.map((c) => c.name)).toEqual(TOOL_NAMES);
  });

  it("langkah 6 dan 7 tidak berjalan bila langkah 5 galat walau langkah 1 sampai 4 bersih", async () => {
    const { steps, ran } = rig({ 5: byOutcome(5, "error") });
    const result = await runFake(steps);
    expect(ran).toEqual([1, 2, 3, 4, 5]);
    expect(result.summary.checks.map((c) => c.name)).toEqual(["size", "policy", "eslint", "tsc", "esbuild"]);
  });
});

describe("`ok` dihitung sebelum pemotongan (Requirement 6.9, 7.19)", () => {
  const warnings = (count: number, tool: "ESLINT_LORE_KIT_STYLE" | "RENDER_CONSOLE_WARN" = "ESLINT_LORE_KIT_STYLE"): Behaviour =>
    (context) =>
      Array.from({ length: count }, (_, index) =>
        context.diagnostic(tool, "warning", `w${index}`, { line: index + 1 }),
      );

  it("tepat 50 Diagnostic: tidak dipotong", async () => {
    const result = await runFake(rig({ 3: warnings(50) }).steps);
    expect(result.diagnostics).toHaveLength(50);
    expect(result.summary.truncated).toBe(false);
  });

  it("51 peringatan tanpa galat: ok true, 50 tersisa, truncated true, bundle dan meta ada", async () => {
    const result = await runFake(rig({ 3: warnings(51) }).steps);
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toHaveLength(50);
    expect(result.summary.truncated).toBe(true);
    expect(result.diagnostics.every((d) => d.severity === "warning")).toBe(true);
    expect("bundle" in result && "meta" in result).toBe(true);
  });

  it("60 peringatan dan satu galat di baris terakhir: ok false, galat tidak terbuang, bundle dan meta hilang", async () => {
    const error: Behaviour = emit(["TSC_2322", "error", "late error", 999, 1]);
    const result = await runFake(rig({ 3: warnings(60), 4: error }).steps);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toHaveLength(50);
    expect(result.diagnostics.filter((d) => d.severity === "error").map((d) => d.code)).toEqual(["TSC_2322"]);
    expect(result.diagnostics.filter((d) => d.severity === "warning")).toHaveLength(49);
    expect(result.summary.truncated).toBe(true);
    expect("bundle" in result).toBe(false);
    expect("meta" in result).toBe(false);
  });

  it("60 galat: ok false, 50 galat tersisa, truncated true", async () => {
    const errors: Behaviour = (context) =>
      Array.from({ length: 60 }, (_, index) => context.diagnostic("POLICY_JSX_SYNTAX", "error", `e${index}`, { line: index + 1 }));
    const result = await runFake(rig({ 2: errors }).steps);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toHaveLength(50);
    expect(result.diagnostics.every((d) => d.severity === "error")).toBe(true);
    expect(result.summary.truncated).toBe(true);
  });

  it("pemotongan memilih baris terkecil lebih dulu, lalu urutan keluaran memakai urutan langkah", async () => {
    const result = await runFake(rig({ 3: warnings(60) }).steps);
    expect(result.diagnostics.map((d) => d.line)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });
});

describe("urutan keluaran (Requirement 6.9, 10.12)", () => {
  it("menurut langkah, lalu line (tanpa line lebih dulu), lalu column, lalu code abjad", async () => {
    const result = await runFake(
      rig({
        1: emit(["SIZE_SOURCE_TOO_LARGE", "warning", "size"]),
        2: emit(
          ["POLICY_B", "error", "b", 9, 2],
          ["POLICY_A", "error", "a"],
          ["POLICY_C", "error", "c", 2, 7],
          ["POLICY_E", "error", "e", 2, 3],
          ["POLICY_D", "error", "d", 2, 3],
        ),
        3: emit(["ESLINT_PARSE_ERROR", "error", "lint", 1, 1]),
        4: emit(["TSC_2322", "error", "tsc"]),
      }).steps,
    );
    expect(codesOf(result.diagnostics)).toEqual([
      "SIZE_SOURCE_TOO_LARGE",
      "POLICY_A",
      "POLICY_D",
      "POLICY_E",
      "POLICY_C",
      "POLICY_B",
      "ESLINT_PARSE_ERROR",
      "TSC_2322",
    ]);
  });

  it("semua tujuh langkah: urutan size, policy, eslint, tsc, esbuild, render, fidelity", async () => {
    const behaviours: Partial<Record<StepNumber, Behaviour>> = {};
    for (const step of STEP_NUMBERS) behaviours[step] = byOutcome(step, "warning");
    const result = await runFake(rig(behaviours).steps);
    expect(result.diagnostics.map((d) => d.tool)).toEqual(TOOL_NAMES);
  });

  it("FIDELITY_*: OVERLAPS, lalu MISSING, lalu VISIBLE; dalam satu kode menurut urutan emisi (token)", async () => {
    const result = await runFake(
      rig({
        7: emit(
          ["FIDELITY_FORBIDDEN_TOKEN_VISIBLE", "error", "visible z"],
          ["FIDELITY_TOKEN_MISSING", "error", "missing z"],
          ["FIDELITY_FORBIDDEN_OVERLAPS_REQUIRED", "warning", "overlap z"],
          ["FIDELITY_TOKEN_MISSING", "error", "missing a"],
          ["FIDELITY_FORBIDDEN_TOKEN_VISIBLE", "error", "visible a"],
        ),
      }).steps,
    );
    expect(messagesOf(result.diagnostics)).toEqual([
      "overlap z",
      "missing z",
      "missing a",
      "visible z",
      "visible a",
    ]);
  });

  it("VERIFIER_* selalu terakhir walau tanpa line", async () => {
    const clock = new FakeClock();
    const result = await runFake(
      rig({
        2: emit(["POLICY_JSX_SYNTAX", "warning", "policy", 40, 1]),
        3: (context) => {
          clock.advance(DEADLINE_MS);
          return [context.diagnostic("ESLINT_LORE_KIT_STYLE", "warning", "kit", { line: 9 })];
        },
      }).steps,
      clock,
    );
    expect(codesOf(result.diagnostics)).toEqual(["POLICY_JSX_SYNTAX", "ESLINT_LORE_KIT_STYLE", "VERIFIER_DEADLINE"]);
    expect(result.diagnostics.at(-1)?.tool).toBe("verifier");
  });

  it("Diagnostic yang sama tidak bergantung pada urutan emisi antar-langkah", async () => {
    const forward = await runFake(
      rig({ 2: emit(["POLICY_A", "error", "a", 3, 1], ["POLICY_B", "error", "b", 3, 1]) }).steps,
    );
    const backward = await runFake(
      rig({ 2: emit(["POLICY_B", "error", "b", 3, 1], ["POLICY_A", "error", "a", 3, 1]) }).steps,
    );
    expect(codesOf(forward.diagnostics)).toEqual(["POLICY_A", "POLICY_B"]);
    expect(codesOf(backward.diagnostics)).toEqual(["POLICY_A", "POLICY_B"]);
  });
});

describe("summary.checks (Requirement 6.10, 6.16)", () => {
  it("name sama dengan tool langkah, urut menurut nomor, dan ms bilangan bulat tak negatif dari FakeClock", async () => {
    const clock = new FakeClock(100);
    const advance = (ms: number): Behaviour => () => {
      clock.advance(ms);
      return [];
    };
    const result = await runFake(
      rig({ 1: advance(0.4), 2: advance(12.6), 3: advance(3.2), 5: advance(250), 6: advance(1) }).steps,
      clock,
    );
    expect(result.ok).toBe(true);
    expect(result.summary.checks).toEqual([
      { name: "size", ok: true, ms: 0 },
      { name: "policy", ok: true, ms: 13 },
      { name: "eslint", ok: true, ms: 3 },
      { name: "tsc", ok: true, ms: 0 },
      { name: "esbuild", ok: true, ms: 250 },
      { name: "render", ok: true, ms: 1 },
      { name: "fidelity", ok: true, ms: 0 },
    ]);
  });

  it("jam yang mundur memberi ms 0, bukan negatif", async () => {
    let current = 1000;
    const clock: Clock = { now: () => (current -= 10) }; // tiap pembacaan lebih kecil dari sebelumnya
    const result = await runFake(rig().steps, clock);
    expect(result.summary.checks).toHaveLength(7);
    expect(result.summary.checks.every((check) => check.ms === 0)).toBe(true);
  });

  it("memuat versi kontrak dan runtime dari paket terpasang, tanpa kunci lain", async () => {
    const result = await runFake(rig().steps);
    expect(Object.keys(result.summary).sort()).toEqual([
      "checks",
      "contract_version",
      "runtime_version",
      "truncated",
      "verifier_version",
    ]);
    expect(result.summary.contract_version).toBe(contract.contract_version);
    expect(Object.keys(result.summary.runtime_version).sort()).toEqual(["react", "remotion"]);
  });
});

describe("deadline menghentikan sisa langkah (Requirement 9.10, 6.7)", () => {
  it.each<StepNumber>([1, 2, 3, 4, 5, 6])(
    "jam mencapai deadline selama langkah %i: tidak ada langkah berikutnya dan satu VERIFIER_DEADLINE",
    async (slowStep) => {
      const clock = new FakeClock(5000);
      const { steps, ran } = rig({
        [slowStep]: () => {
          clock.advance(DEADLINE_MS);
          return [];
        },
      });
      const result = await runFake(steps, clock);
      expect(ran).toEqual(STEP_NUMBERS.filter((step) => step <= slowStep));
      expect(result.ok).toBe(false);
      expect(codesOf(result.diagnostics)).toEqual(["VERIFIER_DEADLINE"]);
      expect(result.diagnostics[0]).toMatchObject({ tool: "verifier", severity: "error" });
      expect(result.summary.checks.map((c) => c.name)).toEqual(TOOL_NAMES.slice(0, slowStep));
      expect(result.summary.checks.every((check) => check.ok)).toBe(true);
      expect("bundle" in result).toBe(false);
      expect("meta" in result).toBe(false);
    },
  );

  it("deadline lewat selama langkah terakhir: tidak ada langkah tersisa, hasil tetap lengkap", async () => {
    const clock = new FakeClock();
    const { steps, ran } = rig({
      7: () => {
        clock.advance(DEADLINE_MS * 2);
        return [];
      },
    });
    const result = await runFake(steps, clock);
    expect(ran).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result.ok).toBe(true);
    expect(result.summary.checks).toHaveLength(7);
  });

  it("batas tepat: deadline - 1 ms masih berjalan, deadline ms menghentikan", async () => {
    const run = async (elapsed: number) => {
      const clock = new FakeClock();
      const { steps, ran } = rig({
        1: () => {
          clock.advance(elapsed);
          return [];
        },
      });
      return { result: await runFake(steps, clock), ran };
    };
    const before = await run(DEADLINE_MS - 1);
    expect(before.ran).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(before.result.ok).toBe(true);

    const at = await run(DEADLINE_MS);
    expect(at.ran).toEqual([1]);
    expect(codesOf(at.result.diagnostics)).toEqual(["VERIFIER_DEADLINE"]);
  });

  it("deadline sebelum langkah pertama: tidak ada langkah dan checks kosong", async () => {
    let reads = 0;
    // Pembacaan pertama menetapkan deadline; pembacaan kedua (sebelum langkah 1) sudah di atasnya.
    const clock: Clock = { now: () => (reads++ === 0 ? 0 : DEADLINE_MS) };
    const { steps, ran } = rig();
    const result = await runFake(steps, clock);
    expect(ran).toEqual([]);
    expect(codesOf(result.diagnostics)).toEqual(["VERIFIER_DEADLINE"]);
    expect(result.summary.checks).toEqual([]);
    expect(result.ok).toBe(false);
  });

  it("temuan sebelum deadline tetap dilaporkan dan VERIFIER_DEADLINE tidak menggandakan galat", async () => {
    const clock = new FakeClock();
    const { steps, ran } = rig({
      2: emit(["POLICY_JSX_SYNTAX", "error", "jsx", 3, 1]),
      3: () => {
        clock.advance(DEADLINE_MS);
        return [];
      },
    });
    const result = await runFake(steps, clock);
    expect(ran).toEqual([1, 2, 3]);
    expect(codesOf(result.diagnostics)).toEqual(["POLICY_JSX_SYNTAX", "VERIFIER_DEADLINE"]);
    expect(result.summary.checks.map((c) => [c.name, c.ok])).toEqual([
      ["size", true],
      ["policy", false],
      ["eslint", true],
    ]);
  });

  it("langkah yang melaporkan VERIFIER_DEADLINE sendiri: tepat satu, langkah berikutnya tidak jalan, langkahnya ok false", async () => {
    const clock = new FakeClock();
    const { steps, ran } = rig({
      6: (context) => {
        clock.advance(DEADLINE_MS);
        return [context.diagnostic("VERIFIER_DEADLINE", "error", "verification deadline reached")];
      },
    });
    const result = await runFake(steps, clock);
    expect(ran).toEqual([1, 2, 3, 4, 5, 6]);
    expect(codesOf(result.diagnostics)).toEqual(["VERIFIER_DEADLINE"]);
    expect(result.summary.checks.at(-1)).toMatchObject({ name: "render", ok: false });
  });

  it("deadline dihitung dari awal pipeline, bukan dari langkah pertama", async () => {
    const clock = new FakeClock(7_000);
    const seen: number[] = [];
    const { steps } = rig({
      1: (context) => {
        seen.push(context.deadlineAt);
        return [];
      },
      7: (context) => {
        seen.push(context.deadlineAt);
        return [];
      },
    });
    await runFake(steps, clock);
    expect(seen).toEqual([7_000 + DEADLINE_MS, 7_000 + DEADLINE_MS]);
  });
});

// ---- lapis 2: langkah 6 dengan host palsu dan langkah 7 nyata ----

/** Tangkapan frame sehat: ada teks, elemen, dan dua lintasan yang sama. */
const capture = (text: string, count = 8): FrameCapture => ({
  html: `<i>${text}</i>`,
  text,
  count,
  secondHtml: `<i>${text}</i>`,
});

interface HostSpec {
  /** Teks semua frame yang tidak diatur lewat `perFrame`. */
  text?: string;
  perFrame?: Record<number, FrameCapture>;
  result?: Partial<Omit<ResultMessage, "frames">>;
}

function resultHost(spec: HostSpec = {}): FakeRenderHost {
  return new FakeRenderHost((request: RenderRequest): FakeRenderScript => ({
    outcome: {
      kind: "result",
      result: {
        type: "result",
        metaMatches: true,
        defaultIsFunction: true,
        console: { error: 0, warn: 0 },
        ...spec.result,
        frames: Object.fromEntries(
          request.job.frames.map((frame) => [frame, spec.perFrame?.[frame] ?? capture(spec.text ?? "alpha beta")]),
        ),
      },
    },
  }));
}

/** Langkah 1 sampai 4 bersih, langkah 5 menghasilkan bundle, langkah 6 memakai `host`, langkah 7 nyata. */
function hostPipeline(host: RenderHost, meta: MainMeta): VerifierStep[] {
  const clean = (number: 1 | 2 | 3 | 4): VerifierStep => ({
    number,
    run: (context) => {
      if (number === 2) context.artifacts.set(META_ARTIFACT, { ...meta });
      return { diagnostics: [] };
    },
  });
  const bundle: VerifierStep = {
    number: 5,
    run: (context) => {
      context.artifacts.set(BUNDLE_ARTIFACT, BUNDLE_TEXT);
      return { diagnostics: [] };
    },
  };
  return [clean(1), clean(2), clean(3), clean(4), bundle, createRenderStep(host), fidelityStep];
}

const PUZZLE_META: MainMeta = { ...META, pauseAtFrame: 10 };

describe("format frame=<n> pada RENDER_* dan FIDELITY_* (Requirement 6.17, 9.12, 10.11)", () => {
  interface FrameCase {
    name: string;
    kind: Kind;
    meta: MainMeta;
    required?: string[];
    forbidden?: string[];
    host: () => RenderHost;
    expected: Array<[code: string, message: string]>;
    lastStep: Tool;
  }

  const DOM_MAX = contract.limits.dom_max_elements;
  const cases: FrameCase[] = [
    {
      name: "RENDER_DOM_LIMIT menyebut frame dan count",
      kind: "lesson",
      meta: META,
      host: () => resultHost({ perFrame: { 15: capture("alpha beta", DOM_MAX + 1) } }),
      expected: [["RENDER_DOM_LIMIT", `frame=15 count=${DOM_MAX + 1} exceeds ${DOM_MAX} elements`]],
      lastStep: "render",
    },
    {
      name: "RENDER_EMPTY",
      kind: "lesson",
      meta: META,
      host: () => resultHost({ perFrame: { 7: { ...capture(""), count: 3 } } }),
      expected: [["RENDER_EMPTY", "frame=7 rendered no content"]],
      lastStep: "render",
    },
    {
      name: "RENDER_NONDETERMINISTIC",
      kind: "lesson",
      meta: META,
      host: () => resultHost({ perFrame: { 22: { ...capture("alpha beta"), secondHtml: "<q>other</q>" } } }),
      expected: [["RENDER_NONDETERMINISTIC", "frame=22 rendered differently on the second pass"]],
      lastStep: "render",
    },
    {
      name: "RENDER_EXCEPTION pada satu frame",
      kind: "lesson",
      meta: META,
      host: () => resultHost({ perFrame: { 29: { error: "RangeError: boom" } } }),
      expected: [["RENDER_EXCEPTION", "frame=29 render threw RangeError"]],
      lastStep: "render",
    },
    {
      name: "RENDER_EXCEPTION saat evaluasi memakai frame=evaluate",
      kind: "lesson",
      meta: META,
      host: () => resultHost({ result: { evaluateError: "SyntaxError: bad" } }),
      expected: [["RENDER_EXCEPTION", "frame=evaluate render threw SyntaxError"]],
      lastStep: "render",
    },
    {
      name: "RENDER_FRAME_TIMEOUT pada frame",
      kind: "lesson",
      meta: META,
      host: () => new FakeRenderHost({ outcome: { kind: "frame_timeout", at: 7 } }),
      expected: [["RENDER_FRAME_TIMEOUT", "frame=7 did not finish in time"]],
      lastStep: "render",
    },
    {
      name: "RENDER_FRAME_TIMEOUT saat evaluasi",
      kind: "lesson",
      meta: META,
      host: () => new FakeRenderHost({ outcome: { kind: "frame_timeout", at: "evaluate" } }),
      expected: [["RENDER_FRAME_TIMEOUT", "frame=evaluate did not finish in time"]],
      lastStep: "render",
    },
    {
      name: "FIDELITY_TOKEN_MISSING menyebut frame terakhir (lesson)",
      kind: "lesson",
      meta: META,
      required: ["alpha", "gamma"],
      host: () => resultHost(),
      expected: [["FIDELITY_TOKEN_MISSING", 'frame=29 missing "gamma"']],
      lastStep: "fidelity",
    },
    {
      name: "FIDELITY_TOKEN_MISSING di kedua frame puzzle menyebut frame jeda, satu Diagnostic",
      kind: "puzzle",
      meta: PUZZLE_META,
      required: ["gamma"],
      host: () => resultHost(),
      expected: [["FIDELITY_TOKEN_MISSING", 'frame=10 missing "gamma"']],
      lastStep: "fidelity",
    },
    {
      name: "FIDELITY_FORBIDDEN_TOKEN_VISIBLE menyebut frame pertama yang menampakkannya",
      kind: "puzzle",
      meta: PUZZLE_META,
      required: ["beta"],
      forbidden: ["alpha"],
      host: () => resultHost(),
      expected: [["FIDELITY_FORBIDDEN_TOKEN_VISIBLE", 'frame=0 shows "alpha" before the answer']],
      lastStep: "fidelity",
    },
  ];

  it.each(cases)("$name", async (scenario) => {
    const result = await verify(
      eventOf({ kind: scenario.kind, required_tokens: scenario.required ?? ["alpha"], forbidden_tokens: scenario.forbidden ?? [] }),
      { clock: new FakeClock(), contract, steps: hostPipeline(scenario.host(), scenario.meta) },
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => [d.code, d.message])).toEqual(scenario.expected);
    expect(result.summary.checks.at(-1)).toMatchObject({ name: scenario.lastStep, ok: false });
    expectWellFormed(result);
  });

  it("galat render menghentikan langkah 7: checks berakhir di render", async () => {
    const result = await verify(eventOf({ required_tokens: ["never shown"] }), {
      clock: new FakeClock(),
      contract,
      steps: hostPipeline(resultHost({ perFrame: { 0: { error: "Error: x" } } }), META),
    });
    expect(result.summary.checks.map((c) => c.name)).toEqual(TOOL_NAMES.slice(0, 6));
    expect(codesOf(result.diagnostics)).toEqual(["RENDER_EXCEPTION"]);
  });

  it("RENDER_CONSOLE_WARN dan peringatan tumpang tindih: ok true, bundle dan meta ada, ketujuh langkah jalan", async () => {
    const result = await verify(
      eventOf({ kind: "puzzle", required_tokens: ["beta"], forbidden_tokens: ["beta"] }),
      {
        clock: new FakeClock(),
        contract,
        steps: hostPipeline(resultHost({ result: { console: { error: 0, warn: 1 } } }), PUZZLE_META),
      },
    );
    expect(result.ok).toBe(true);
    expect(codesOf(result.diagnostics)).toEqual(["RENDER_CONSOLE_WARN", "FIDELITY_FORBIDDEN_OVERLAPS_REQUIRED"]);
    expect(result.summary.checks.map((c) => c.name)).toEqual(TOOL_NAMES);
    if (result.ok) {
      expect(result.bundle).toBe(BUNDLE_TEXT);
      expect(result.meta).toEqual(PUZZLE_META);
    }
  });

  it("deadline di tengah langkah 6: VERIFIER_DEADLINE, langkah 7 tidak berjalan, render ok false", async () => {
    const clock = new FakeClock();
    const host = new FakeRenderHost({
      progress: [
        { type: "progress", at: "evaluate", edge: "start" },
        { type: "progress", at: "evaluate", edge: "end" },
        () => clock.advance(DEADLINE_MS),
        { type: "progress", at: 0, edge: "start" },
      ],
      outcome: { kind: "result", result: { type: "result", metaMatches: true, defaultIsFunction: true, console: { error: 0, warn: 0 }, frames: {} } },
    });
    const result = await verify(eventOf(), { clock, contract, steps: hostPipeline(host, META) });
    expect(result.ok).toBe(false);
    expect(codesOf(result.diagnostics)).toEqual(["VERIFIER_DEADLINE"]);
    expect(result.summary.checks.map((c) => c.name)).toEqual(TOOL_NAMES.slice(0, 6));
    expect(result.summary.checks.at(-1)).toMatchObject({ name: "render", ok: false });
    expect("bundle" in result).toBe(false);
  });
});

// ---- lapis 3: ketujuh langkah nyata, Worker render sungguhan ----

interface Companion {
  kind: Kind;
  required_tokens: string[];
  forbidden_tokens: string[];
}

const GOOD_DIR = new URL("../fixtures/good/", import.meta.url);
const goodNames = readdirSync(GOOD_DIR)
  .filter((name) => name.endsWith(".ts"))
  .sort();

function readFixture(name: string): { source: string; companion: Companion } {
  return {
    source: readFileSync(new URL(name, GOOD_DIR), "utf8"),
    companion: JSON.parse(readFileSync(new URL(name.replace(/\.ts$/, ".json"), GOOD_DIR), "utf8")) as Companion,
  };
}

/** `meta` statis dari sumber fixture (sama dengan yang dibaca langkah 2). */
function staticMetaOf(source: string): MainMeta {
  const duration = Number(/durationInFrames:\s*(\d+)/.exec(source)?.[1]);
  const pause = /pauseAtFrame:\s*(\d+)/.exec(source);
  const meta: MainMeta = { width: 1280, height: 720, fps: 30, durationInFrames: duration };
  if (pause !== null) meta.pauseAtFrame = Number(pause[1]);
  return meta;
}

/** Mengganti tepat satu kemunculan `from`; gagal keras bila fixture berubah sehingga tes tidak diam-diam kosong. */
function patch(source: string, from: string, to: string): string {
  const parts = source.split(from);
  if (parts.length !== 2) throw new Error(`fixture patch target must occur exactly once: ${from}`);
  return parts.join(to);
}

describe("pipeline nyata: ketujuh langkah dengan Worker render sungguhan", () => {
  let compiled: CompiledRenderWorker;
  beforeAll(() => {
    compiled = compileRenderWorker();
  });
  afterAll(() => {
    compiled?.dispose();
  });

  /** Registri produksi dengan langkah 6 yang memuat Worker hasil `tsc` di direktori sementara. */
  function realSteps(): VerifierStep[] {
    return DEFAULT_STEPS.map((step) =>
      step.number === 6
        ? createRenderStep(createWorkerRenderHost({ workerUrl: compiled.workerUrl }))
        : step,
    );
  }

  async function verifyReal(parts: EventParts): Promise<VerifierResult> {
    return verify(eventOf(parts), { clock: systemClock(), contract, steps: realSteps() });
  }

  describe("seluruh fixtures/good lolos tanpa galat dengan tujuh checks", () => {
    it("memuat sedikitnya 8 fixture", () => {
      expect(goodNames.length).toBeGreaterThanOrEqual(8);
    });

    it.each(goodNames)("%s", async (name) => {
      const { source, companion } = readFixture(name);
      const result = await verifyReal({ source, ...companion });

      expect(errorsOf(result.diagnostics)).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.summary.checks.map((check) => check.name)).toEqual(TOOL_NAMES);
      expect(result.summary.checks.every((check) => check.ok)).toBe(true);
      expect(result.summary.truncated).toBe(false);
      expect(result.summary.contract_version).toBe(contract.contract_version);
      if (!result.ok) return;
      expect(result.meta).toEqual(staticMetaOf(source));
      expect(result.bundle.length).toBeGreaterThan(0);
      expect(result.bundle).not.toContain("sourceMappingURL");
      expectWellFormed(result);
    });
  });

  describe("sumber yang diubah sedikit berhenti di titik yang benar", () => {
    const lesson = readFixture("formula-lesson.ts");
    const puzzle = readFixture("puzzle-pause.ts");
    const FRAME_HOOK = "const frame = useCurrentFrame();";

    it("langkah 1 galat: hanya langkah size yang berjalan", async () => {
      const result = await verifyReal({ source: `// ${"x".repeat(contract.limits.source_max_bytes)}\n${lesson.source}`, ...lesson.companion });
      expect(result.ok).toBe(false);
      expect(codesOf(result.diagnostics)).toEqual(["SIZE_SOURCE_TOO_LARGE"]);
      expect(result.summary.checks.map((c) => [c.name, c.ok])).toEqual([["size", false]]);
      expectWellFormed(result);
    });

    it("langkah 2, 3, dan 4 dilaporkan bersama; langkah 5 sampai 7 tidak berjalan", async () => {
      const source = `${lesson.source}\nlet leaked = 0;\nconst typed: number = "text";\nconst roll = Math.random();\n`;
      const result = await verifyReal({ source, ...lesson.companion });
      expect(result.ok).toBe(false);
      const codes = codesOf(result.diagnostics);
      expect(codes).toContain("POLICY_FORBIDDEN_MEMBER");
      expect(codes).toContain("ESLINT_LORE_NO_MODULE_STATE");
      expect(codes).toContain("TSC_2322");
      expect(result.summary.checks.map((c) => [c.name, c.ok])).toEqual([
        ["size", true],
        ["policy", false],
        ["eslint", false],
        ["tsc", false],
      ]);
      // Urutan keluaran: semua policy, lalu eslint, lalu tsc.
      const tools = result.diagnostics.map((d) => d.tool);
      expect(tools).toEqual([...tools].sort((a, b) => TOOL_NAMES.indexOf(a as Tool) - TOOL_NAMES.indexOf(b as Tool)));
      expect(new Set(tools)).toEqual(new Set(["policy", "eslint", "tsc"]));
      expect("bundle" in result).toBe(false);
      expectWellFormed(result);
    });

    it("hanya langkah 3 galat (tanpa useCurrentFrame): langkah 5 sampai 7 tetap tidak berjalan", async () => {
      const source = patch(lesson.source, FRAME_HOOK, "const frame = 0;");
      const result = await verifyReal({ source, ...lesson.companion });
      expect(result.ok).toBe(false);
      expect(codesOf(errorsOf(result.diagnostics))).toContain("ESLINT_LORE_USES_FRAME");
      expect(result.summary.checks.map((c) => [c.name, c.ok])).toEqual([
        ["size", true],
        ["policy", true],
        ["eslint", false],
        ["tsc", true],
      ]);
    });

    it("langkah 6 galat: RENDER_EXCEPTION per frame dengan frame=<n>, langkah 7 tidak berjalan", async () => {
      const source = patch(lesson.source, FRAME_HOOK, `${FRAME_HOOK}\n  if (frame > 10) throw new Error("late failure");`);
      const result = await verifyReal({ source, ...lesson.companion });
      expect(result.ok).toBe(false);
      // d = 150: frame sampel 0, 37, 75, 112, 149; hanya yang > 10 gagal, satu Diagnostic per frame.
      expect(result.diagnostics.map((d) => [d.code, d.message])).toEqual([
        ["RENDER_EXCEPTION", "frame=37 render threw Error"],
        ["RENDER_EXCEPTION", "frame=75 render threw Error"],
        ["RENDER_EXCEPTION", "frame=112 render threw Error"],
        ["RENDER_EXCEPTION", "frame=149 render threw Error"],
      ]);
      expect(result.summary.checks.map((c) => [c.name, c.ok])).toEqual([
        ["size", true],
        ["policy", true],
        ["eslint", true],
        ["tsc", true],
        ["esbuild", true],
        ["render", false],
      ]);
      expect("bundle" in result).toBe(false);
      expectWellFormed(result);
    });

    it("langkah 7 galat: ketujuh langkah berjalan, ok false, tanpa bundle dan meta", async () => {
      const result = await verifyReal({
        source: lesson.source,
        ...lesson.companion,
        required_tokens: [...lesson.companion.required_tokens, "Zz missing term"],
      });
      expect(result.ok).toBe(false);
      expect(result.diagnostics.map((d) => [d.tool, d.code, d.message])).toEqual([
        ["fidelity", "FIDELITY_TOKEN_MISSING", 'frame=149 missing "Zz missing term"'],
      ]);
      expect(result.summary.checks.map((c) => c.name)).toEqual(TOOL_NAMES);
      expect(result.summary.checks.map((c) => c.ok)).toEqual([true, true, true, true, true, true, false]);
      expect("bundle" in result).toBe(false);
      expect("meta" in result).toBe(false);
      expectWellFormed(result);
    });

    it("puzzle: OVERLAPS, MISSING (urutan token masukan), lalu VISIBLE, dengan frame=<n>", async () => {
      const result = await verifyReal({
        source: puzzle.source,
        kind: "puzzle",
        required_tokens: [...puzzle.companion.required_tokens, "Zz second", "Zz first"],
        forbidden_tokens: ["What is B?", "A"],
      });
      expect(result.ok).toBe(false);
      expect(result.diagnostics.map((d) => [d.code, d.severity, d.message])).toEqual([
        ["FIDELITY_FORBIDDEN_OVERLAPS_REQUIRED", "warning", 'forbidden token also required, ignored: "A"'],
        ["FIDELITY_TOKEN_MISSING", "error", 'frame=90 missing "Zz second"'],
        ["FIDELITY_TOKEN_MISSING", "error", 'frame=90 missing "Zz first"'],
        ["FIDELITY_FORBIDDEN_TOKEN_VISIBLE", "error", 'frame=0 shows "What is B?" before the answer'],
      ]);
      expect(result.summary.checks.map((c) => c.name)).toEqual(TOOL_NAMES);
      expectWellFormed(result);
    });

    it("peringatan gaya Kit tidak mengubah ok: bundle dan meta tetap ada", async () => {
      const source = patch(lesson.source, 'padding: "12px 28px",', 'padding: "12px 28px",\n            borderRadius: 8,');
      const result = await verifyReal({ source, ...lesson.companion });
      expect(result.ok).toBe(true);
      expect(result.diagnostics.map((d) => [d.tool, d.code, d.severity])).toEqual([
        ["eslint", "ESLINT_LORE_KIT_STYLE", "warning"],
      ]);
      expect(result.summary.checks.map((c) => c.name)).toEqual(TOOL_NAMES);
      expect(result.summary.checks.every((c) => c.ok)).toBe(true);
      if (result.ok) {
        expect(result.meta).toEqual(staticMetaOf(lesson.source));
        expect(result.bundle.length).toBeGreaterThan(0);
      }
    });

    it("Forbidden_Token yang juga Required_Token pada puzzle hanya memberi peringatan: ok true", async () => {
      const result = await verifyReal({
        source: puzzle.source,
        ...puzzle.companion,
        forbidden_tokens: [...puzzle.companion.forbidden_tokens, "A"],
      });
      expect(result.ok).toBe(true);
      expect(result.diagnostics.map((d) => [d.tool, d.code, d.severity])).toEqual([
        ["fidelity", "FIDELITY_FORBIDDEN_OVERLAPS_REQUIRED", "warning"],
      ]);
      expect(result.summary.checks.map((c) => c.name)).toEqual(TOOL_NAMES);
      if (result.ok) expect(result.meta.pauseAtFrame).toBe(90);
    });
  });
});
