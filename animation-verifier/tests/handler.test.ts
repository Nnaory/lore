// Tes handler Lambda dan orkestrasi `verify` (tugas 3.3): validasi masukan, versi kontrak, aturan
// alir langkah, `ok` sebelum pemotongan, deadline berbasis FakeClock, gagal tertutup, exception
// menjadi satu `VERIFIER_INTERNAL`, kontrak rusak, dan satu baris log tanpa sentinel
// (Requirement 6.1 sampai 6.7, 6.9, 6.10, 6.11, 6.13, 6.14, 11.6, 2.10, 3.7; design 5.3 dan 5.2).
// Langkah 1 sampai 7 yang sebenarnya ditulis di tugas lain, jadi tes ini memasang langkah uji yang
// hanya merekam pemanggilan dan memberi Diagnostic yang ditentukan tes; yang diuji adalah
// orkestratornya, bukan isi langkah.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../src/clock.js";
import { loadContract, type Contract, type LoadContractResult } from "../src/contract.js";
import {
  CONTRACT_LOCATIONS,
  createHandler,
  handler as productionHandler,
  readContractFromLocations,
} from "../src/handler.js";
import { DEFAULT_STEPS } from "../src/steps/registry.js";
import {
  BUNDLE_ARTIFACT,
  META_ARTIFACT,
  STEP_NUMBERS,
  indexSteps,
  type StepContext,
  type StepNumber,
  type StepResult,
  type VerifierStep,
} from "../src/steps/step.js";
import type { MainMeta, VerifierResult } from "../src/types.js";
import { MAX_TOKENS, MAX_TOKEN_CHARS, parseInput, safeVerify } from "../src/verify.js";
import { UNKNOWN_VERSIONS } from "../src/versions.js";

// ---- kontrak dan masukan ----

const CONTRACT_PATH = new URL("../contract/animation-contract.json", import.meta.url);
const RAW_CONTRACT = JSON.parse(readFileSync(CONTRACT_PATH, "utf8")) as unknown;
const loaded = loadContract(RAW_CONTRACT);
if (!loaded.ok) throw new Error(`kontrak sumber tidak sah: ${loaded.reason}`);
const contract: Contract = loaded.contract;
const LOADED_OK: LoadContractResult = loaded;

const VALID_EVENT = {
  source: "export default function Main() { return null }",
  kind: "lesson",
  required_tokens: ["alpha"],
  forbidden_tokens: [] as string[],
  contract_version: contract.contract_version,
};

const META: MainMeta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };
const CONTEXT = { awsRequestId: "req-0001" };

const BAD_INPUT_DIAGNOSTIC = {
  tool: "verifier",
  code: "VERIFIER_BAD_INPUT",
  severity: "error",
  message: "event does not match the input schema",
};
const INTERNAL_DIAGNOSTIC = {
  tool: "verifier",
  code: "VERIFIER_INTERNAL",
  severity: "error",
  message: "internal verifier error",
};

// ---- langkah uji ----

type Behaviour = (context: StepContext) => StepResult | Promise<StepResult>;
const PASS: StepResult = { diagnostics: [] };

/** Nama langkah 1 sampai 7 pada Requirement 6.16, ditulis ulang di tes (bukan dari `STEP_TOOL`). */
const TOOL_NAMES = ["size", "policy", "eslint", "tsc", "esbuild", "render", "fidelity"];

interface Rig {
  steps: VerifierStep[];
  /** Nomor langkah menurut urutan pemanggilan. */
  ran: StepNumber[];
}

/**
 * Tujuh langkah uji. Langkah 2 mengisi meta dan langkah 5 mengisi bundle (seperti langkah
 * sungguhan), lalu menjalankan perilaku yang diberikan tes. `skip` melepas langkah dari registri.
 */
function rig(
  behaviours: Partial<Record<StepNumber, Behaviour>> = {},
  options: { skip?: StepNumber[]; omitBundle?: boolean } = {},
): Rig {
  const ran: StepNumber[] = [];
  const steps: VerifierStep[] = [];
  for (const number of STEP_NUMBERS) {
    if (options.skip?.includes(number) === true) continue;
    steps.push({
      number,
      run: (context) => {
        ran.push(number);
        if (number === 2) context.artifacts.set(META_ARTIFACT, { ...META });
        if (number === 5 && options.omitBundle !== true) {
          context.artifacts.set(BUNDLE_ARTIFACT, "BUNDLE_TEXT");
        }
        return behaviours[number]?.(context) ?? PASS;
      },
    });
  }
  return { steps, ran };
}

function failing(code: string, severity: "error" | "warning" = "error"): Behaviour {
  return (context) => ({ diagnostics: [context.diagnostic(code, severity, "m")] });
}

function build(options: {
  steps?: readonly VerifierStep[];
  clock?: FakeClock;
  load?: () => LoadContractResult;
}) {
  const lines: string[] = [];
  const handler = createHandler({
    clock: options.clock ?? new FakeClock(),
    loadContract: options.load ?? (() => LOADED_OK),
    writeLine: (line) => lines.push(line),
    steps: options.steps,
  });
  return { handler, lines };
}

async function run(event: unknown, steps: readonly VerifierStep[], clock?: FakeClock) {
  const { handler, lines } = build({ steps, clock });
  const result = await handler(event, CONTEXT);
  return { result, lines };
}

function codes(result: VerifierResult): string[] {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

/** Salinan hasil dengan `ms` dinolkan: bidang itu dikecualikan dari perbandingan determinisme. */
function withoutMs(result: VerifierResult): unknown {
  return JSON.parse(
    JSON.stringify(result, (key, value: unknown) => (key === "ms" ? 0 : value)),
  ) as unknown;
}

// ---- masukan (Requirement 6.2, 6.14) ----

describe("masukan tidak sah menghasilkan VERIFIER_BAD_INPUT", () => {
  const nonObjects: [string, unknown][] = [
    ["null", null],
    ["undefined", undefined],
    ["angka", 42],
    ["string", "text"],
    ["boolean", true],
    ["larik kosong", []],
    ["larik berisi event sah", [VALID_EVENT]],
  ];

  it.each(nonObjects)("event %s", async (_name, event) => {
    const { steps, ran } = rig();
    const { result } = await run(event, steps);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([BAD_INPUT_DIAGNOSTIC]);
    expect(ran).toEqual([]);
  });

  it.each(["source", "kind", "required_tokens", "forbidden_tokens", "contract_version"])(
    "kunci %s hilang",
    async (key) => {
      const event: Record<string, unknown> = { ...VALID_EVENT };
      delete event[key];
      const { steps, ran } = rig();
      const { result } = await run(event, steps);
      expect(result.diagnostics).toEqual([BAD_INPUT_DIAGNOSTIC]);
      expect(ran).toEqual([]);
    },
  );

  it.each([
    ["kind di luar enum", { kind: "quiz" }],
    ["kind beda huruf", { kind: "LESSON" }],
    ["kind bukan string", { kind: 1 }],
    ["source bukan string", { source: 12 }],
    ["token bukan larik", { required_tokens: "alpha" }],
    ["token berisi angka", { required_tokens: ["alpha", 1] }],
    ["token berisi null", { forbidden_tokens: [null] }],
    ["lebih dari 200 token", { required_tokens: Array.from({ length: MAX_TOKENS + 1 }, () => "a") }],
    ["token lebih dari 400 karakter", { forbidden_tokens: ["a".repeat(MAX_TOKEN_CHARS + 1)] }],
    ["contract_version nol", { contract_version: 0 }],
    ["contract_version negatif", { contract_version: -1 }],
    ["contract_version pecahan", { contract_version: 1.5 }],
    ["contract_version string", { contract_version: "1" }],
    ["contract_version NaN", { contract_version: Number.NaN }],
    ["contract_version tak hingga", { contract_version: Number.POSITIVE_INFINITY }],
  ])("%s", async (_name, patch) => {
    const { steps, ran } = rig();
    const { result } = await run({ ...VALID_EVENT, ...patch }, steps);
    expect(result.diagnostics).toEqual([BAD_INPUT_DIAGNOSTIC]);
    expect(ran).toEqual([]);
  });

  it("hasilnya memenuhi Requirement 6.14: tanpa bundle, meta, checks, dan truncated", async () => {
    const { steps } = rig();
    const { result } = await run(null, steps);
    expect(result.ok).toBe(false);
    expect("bundle" in result).toBe(false);
    expect("meta" in result).toBe(false);
    expect(result.summary.checks).toEqual([]);
    expect(result.summary.truncated).toBe(false);
    expect(result.summary.contract_version).toBe(contract.contract_version);
  });

  it("batas tepat 200 token dan 400 karakter masih sah", async () => {
    const event = {
      ...VALID_EVENT,
      required_tokens: Array.from({ length: MAX_TOKENS }, () => "a".repeat(MAX_TOKEN_CHARS)),
    };
    expect(parseInput(event).ok).toBe(true);
    const { steps, ran } = rig();
    await run(event, steps);
    expect(ran).toEqual([...STEP_NUMBERS]);
  });

  it("kunci ekstra diabaikan dan tidak sampai ke langkah", async () => {
    let seen: string[] = [];
    const { steps, ran } = rig({
      1: (context) => {
        seen = Object.keys(context.input).sort();
        return PASS;
      },
    });
    const { result } = await run({ ...VALID_EVENT, extra: "x", nested: { a: 1 } }, steps);
    expect(result.ok).toBe(true);
    expect(ran).toEqual([...STEP_NUMBERS]);
    expect(seen).toEqual(
      ["contract_version", "forbidden_tokens", "kind", "required_tokens", "source"].sort(),
    );
  });

  it("parseInput tidak melempar untuk objek dengan getter yang melempar", () => {
    const hostile = {
      get source(): string {
        throw new Error("boom");
      },
    };
    expect(parseInput(hostile)).toEqual({ ok: false });
  });
});

// ---- versi kontrak (Requirement 6.3, 6.14) ----

describe("versi kontrak", () => {
  it("berbeda: satu VERIFIER_CONTRACT_MISMATCH dan tidak ada langkah berjalan", async () => {
    const { steps, ran } = rig();
    const { result } = await run({ ...VALID_EVENT, contract_version: 2 }, steps);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([
      {
        tool: "verifier",
        code: "VERIFIER_CONTRACT_MISMATCH",
        severity: "error",
        message: `contract_version 2 differs from verifier ${contract.contract_version}`,
      },
    ]);
    expect(ran).toEqual([]);
    expect(result.summary.checks).toEqual([]);
    expect(result.summary.truncated).toBe(false);
    expect(result.summary.contract_version).toBe(contract.contract_version);
    expect("bundle" in result).toBe(false);
  });
});

// ---- summary (Requirement 6.10, 3.7) ----

describe("summary", () => {
  it("memuat versi verifier dan runtime dari paket terpasang, sama dengan pin", async () => {
    const readJson = (path: string): { version: string; dependencies?: Record<string, string> } =>
      JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as {
        version: string;
        dependencies?: Record<string, string>;
      };
    const own = readJson("../package.json");
    const react = readJson("../node_modules/react/package.json");
    const remotion = readJson("../node_modules/remotion/package.json");

    const { steps } = rig();
    const { result } = await run(VALID_EVENT, steps);
    expect(result.summary.verifier_version).toBe(own.version);
    expect(result.summary.runtime_version).toEqual({ react: react.version, remotion: remotion.version });
    expect(result.summary.runtime_version.react).toBe(own.dependencies?.react);
    expect(result.summary.runtime_version.remotion).toBe(own.dependencies?.remotion);
    expect(result.summary.contract_version).toBe(contract.contract_version);
  });

  it("untuk masukan salah, runtime_version tetap dari paket terpasang", async () => {
    const { result } = await run(null, rig().steps);
    expect(result.summary.runtime_version.react).not.toBe(UNKNOWN_VERSIONS.runtime_version.react);
    expect(result.summary.runtime_version.remotion).not.toBe(UNKNOWN_VERSIONS.runtime_version.remotion);
  });
});

// ---- aturan alir (Requirement 6.4 sampai 6.7, 6.11, 6.16) ----

describe("aturan alir langkah", () => {
  it("semua langkah bersih: ok true dengan bundle, meta, dan checks berurutan", async () => {
    const clock = new FakeClock();
    const { steps, ran } = rig({ 3: () => (clock.advance(12.6), PASS) });
    const { result } = await run(VALID_EVENT, steps, clock);
    expect(ran).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("tidak tercapai");
    expect(result.bundle).toBe("BUNDLE_TEXT");
    expect(result.meta).toEqual(META);
    expect(result.diagnostics).toEqual([]);
    expect(result.summary.checks.map((check) => check.name)).toEqual(TOOL_NAMES);
    expect(result.summary.checks.every((check) => check.ok)).toBe(true);
    expect(result.summary.checks.map((check) => check.ms)).toEqual([0, 0, 13, 0, 0, 0, 0]);
    expect(result.summary.truncated).toBe(false);
  });

  it("urutan di registri tidak berpengaruh", async () => {
    const { steps, ran } = rig();
    const { result } = await run(VALID_EVENT, [...steps].reverse());
    expect(result.ok).toBe(true);
    expect(ran).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it.each<[string, StepNumber, StepNumber[]]>([
    ["langkah 1 galat berhenti setelah langkah 1", 1, [1]],
    ["langkah 5 galat: langkah 6 dan 7 tidak jalan", 5, [1, 2, 3, 4, 5]],
    ["langkah 6 galat: langkah 7 tidak jalan", 6, [1, 2, 3, 4, 5, 6]],
    ["langkah 7 galat: semua sudah jalan", 7, [1, 2, 3, 4, 5, 6, 7]],
  ])("%s", async (_name, failingStep, expectedRan) => {
    const { steps, ran } = rig({ [failingStep]: failing("POLICY_TEST") });
    const { result } = await run(VALID_EVENT, steps);
    expect(ran).toEqual(expectedRan);
    expect(result.ok).toBe(false);
    expect("bundle" in result).toBe(false);
    expect("meta" in result).toBe(false);
    expect(result.summary.checks.map((check) => check.name)).toEqual(
      expectedRan.map((number) => TOOL_NAMES[number - 1]),
    );
    expect(result.summary.checks.at(-1)?.ok).toBe(false);
    expect(result.summary.checks.slice(0, -1).every((check) => check.ok)).toBe(true);
  });

  it("langkah 2, 3, dan 4 jalan bersama; galat salah satunya menahan langkah 5", async () => {
    const { steps, ran } = rig({
      2: failing("POLICY_JSX_SYNTAX"),
      3: failing("ESLINT_PARSE_ERROR"),
      4: failing("TSC_2322"),
    });
    const { result } = await run(VALID_EVENT, steps);
    expect(ran).toEqual([1, 2, 3, 4]);
    expect(codes(result)).toEqual(["POLICY_JSX_SYNTAX", "ESLINT_PARSE_ERROR", "TSC_2322"]);
    expect(result.summary.checks.map((check) => check.ok)).toEqual([true, false, false, false]);
  });

  it.each<StepNumber>([2, 3, 4])("galat hanya di langkah %i menahan langkah 5", async (failingStep) => {
    const { steps, ran } = rig({ [failingStep]: failing("POLICY_TEST") });
    await run(VALID_EVENT, steps);
    expect(ran).toEqual([1, 2, 3, 4]);
  });

  it("warning tidak menghalangi langkah berikutnya dan tidak mengubah ok", async () => {
    const { steps, ran } = rig({
      3: failing("ESLINT_LORE_KIT_STYLE", "warning"),
      6: failing("RENDER_CONSOLE_WARN", "warning"),
    });
    const { result } = await run(VALID_EVENT, steps);
    expect(ran).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result.ok).toBe(true);
    expect(codes(result)).toEqual(["ESLINT_LORE_KIT_STYLE", "RENDER_CONSOLE_WARN"]);
  });

  it("keluaran diurutkan: tanpa line lebih dulu, lalu line menaik, bukan urutan temuan", async () => {
    const { steps } = rig({
      2: (context) => ({
        diagnostics: [
          context.diagnostic("POLICY_A", "error", "m", { line: 9, column: 1 }),
          context.diagnostic("POLICY_B", "error", "m"),
          context.diagnostic("POLICY_C", "error", "m", { line: 2, column: 5 }),
        ],
      }),
    });
    const { result } = await run(VALID_EVENT, steps);
    expect(codes(result)).toEqual(["POLICY_B", "POLICY_C", "POLICY_A"]);
  });

  it("pesan Diagnostic langkah dipotong ke batas kontrak, bukan batas bawaan", async () => {
    const shorter = loadContract({
      ...(RAW_CONTRACT as Record<string, unknown>),
      limits: {
        ...((RAW_CONTRACT as { limits: Record<string, unknown> }).limits),
        diagnostic_message_max_chars: 50,
      },
    });
    if (!shorter.ok) throw new Error(shorter.reason);
    const { steps } = rig({
      2: (context) => ({ diagnostics: [context.diagnostic("POLICY_TEST", "error", "x".repeat(500))] }),
    });
    const handler = createHandler({
      clock: new FakeClock(),
      loadContract: () => shorter,
      writeLine: () => undefined,
      steps,
    });
    const result = await handler(VALID_EVENT, CONTEXT);
    expect(result.diagnostics[0]?.message).toHaveLength(50);
  });
});

// ---- ok sebelum pemotongan (Requirement 6.9) ----

describe("pemotongan ke 50 Diagnostic", () => {
  const manyWarnings: Behaviour = (context) => ({
    diagnostics: Array.from({ length: 60 }, (_, index) =>
      context.diagnostic("ESLINT_LORE_KIT_STYLE", "warning", `w${index}`, { line: index + 1 }),
    ),
  });

  it("60 warning tanpa galat: ok true, 50 tersisa, truncated true", async () => {
    const { steps } = rig({ 3: manyWarnings });
    const { result } = await run(VALID_EVENT, steps);
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toHaveLength(50);
    expect(result.summary.truncated).toBe(true);
    expect("bundle" in result).toBe(true);
  });

  it("60 warning dan satu galat: ok false dan galat tidak ikut terbuang", async () => {
    const { steps } = rig({ 3: manyWarnings, 4: failing("TSC_2322") });
    const { result } = await run(VALID_EVENT, steps);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toHaveLength(50);
    expect(codes(result)).toContain("TSC_2322");
    expect(result.summary.truncated).toBe(true);
    expect("bundle" in result).toBe(false);
  });
});

// ---- deadline (Requirement 6.7 dan design 5.3 butir 3) ----

describe("deadline berbasis Clock", () => {
  it("jam melewati deadline di tengah pipeline: VERIFIER_DEADLINE dan sisa langkah berhenti", async () => {
    const clock = new FakeClock(1000);
    const { steps, ran } = rig({
      2: () => {
        clock.advance(contract.limits.verifier_deadline_ms);
        return PASS;
      },
    });
    const { result } = await run(VALID_EVENT, steps, clock);
    expect(ran).toEqual([1, 2]);
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(["VERIFIER_DEADLINE"]);
    expect(result.diagnostics[0]).toMatchObject({ tool: "verifier", severity: "error" });
    expect(result.summary.checks.map((check) => check.name)).toEqual(["size", "policy"]);
  });

  it("satu milidetik sebelum deadline masih berjalan", async () => {
    const clock = new FakeClock();
    const { steps, ran } = rig({
      1: () => {
        clock.advance(contract.limits.verifier_deadline_ms - 1);
        return PASS;
      },
    });
    const { result } = await run(VALID_EVENT, steps, clock);
    expect(ran).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result.ok).toBe(true);
  });

  it("langkah yang melaporkan VERIFIER_DEADLINE sendiri menghentikan langkah berikutnya", async () => {
    const { steps, ran } = rig({ 6: failing("VERIFIER_DEADLINE") });
    const { result } = await run(VALID_EVENT, steps);
    expect(ran).toEqual([1, 2, 3, 4, 5, 6]);
    expect(codes(result)).toEqual(["VERIFIER_DEADLINE"]);
  });

  it("langkah menerima deadlineAt absolut dari jam yang sama", async () => {
    const clock = new FakeClock(250);
    let deadlineAt = 0;
    const { steps } = rig({
      6: (context) => {
        deadlineAt = context.deadlineAt;
        return PASS;
      },
    });
    await run(VALID_EVENT, steps, clock);
    expect(deadlineAt).toBe(250 + contract.limits.verifier_deadline_ms);
  });
});

// ---- gagal tertutup ----

describe("pipeline tidak lengkap tidak pernah ok", () => {
  it("tanpa langkah terdaftar: satu VERIFIER_INTERNAL", async () => {
    const { result } = await run(VALID_EVENT, []);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([INTERNAL_DIAGNOSTIC]);
    expect("bundle" in result).toBe(false);
  });

  it("langkah 7 belum terdaftar: tidak ada ok meski langkah lain bersih", async () => {
    const { steps, ran } = rig({}, { skip: [7] });
    const { result } = await run(VALID_EVENT, steps);
    expect(ran).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([INTERNAL_DIAGNOSTIC]);
    expect(result.summary.checks).toHaveLength(6);
  });

  it("langkah 5 bersih tetapi tanpa bundle: VERIFIER_INTERNAL", async () => {
    const { steps } = rig({}, { omitBundle: true });
    const { result } = await run(VALID_EVENT, steps);
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(["VERIFIER_INTERNAL"]);
  });

  it("langkah 1 belum terdaftar: langkah lain tidak berjalan", async () => {
    const { steps, ran } = rig({}, { skip: [1] });
    const { result } = await run(VALID_EVENT, steps);
    expect(ran).toEqual([]);
    expect(codes(result)).toEqual(["VERIFIER_INTERNAL"]);
  });

  it("nomor langkah ganda adalah galat internal", async () => {
    const { steps } = rig();
    const duplicate = steps[0];
    if (duplicate === undefined) throw new Error("tidak tercapai");
    const { result } = await run(VALID_EVENT, [...steps, duplicate]);
    expect(codes(result)).toEqual(["VERIFIER_INTERNAL"]);
    expect(indexSteps([...steps, duplicate]).ok).toBe(false);
  });

  it("registri produksi memuat nomor langkah yang valid dan tidak ganda", () => {
    expect(indexSteps(DEFAULT_STEPS).ok).toBe(true);
  });
});

// ---- exception (Requirement 6.13) ----

describe("exception menjadi satu VERIFIER_INTERNAL", () => {
  it("langkah yang melempar: satu Diagnostic, checks kosong, teks exception tidak bocor", async () => {
    const { steps } = rig({
      3: () => {
        throw new Error("SENTINEL_THROW source=export default");
      },
    });
    const { result, lines } = await run(VALID_EVENT, steps);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([INTERNAL_DIAGNOSTIC]);
    expect(result.summary.checks).toEqual([]);
    expect("bundle" in result).toBe(false);
    expect(JSON.stringify(result)).not.toContain("SENTINEL_THROW");
    expect(lines.join("\n")).not.toContain("SENTINEL_THROW");
    expect((JSON.parse(lines[0] ?? "{}") as { by_code: unknown }).by_code).toEqual({
      VERIFIER_INTERNAL: 1,
    });
  });

  it("langkah async yang menolak (reject) diperlakukan sama", async () => {
    const { steps } = rig({ 2: () => Promise.reject(new Error("async boom")) });
    const { result } = await run(VALID_EVENT, steps);
    expect(result.diagnostics).toEqual([INTERNAL_DIAGNOSTIC]);
  });

  it("jam yang melempar juga menjadi VERIFIER_INTERNAL", async () => {
    const clock = { now: (): number => { throw new Error("clock broken"); } };
    const result = await safeVerify(VALID_EVENT, { clock, contract, steps: rig().steps });
    expect(result.diagnostics).toEqual([INTERNAL_DIAGNOSTIC]);
  });

  it("safeVerify tidak pernah menolak walau dependensinya rusak", async () => {
    const broken = { clock: new FakeClock() } as unknown as Parameters<typeof safeVerify>[1];
    const result = await safeVerify(VALID_EVENT, broken);
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(["VERIFIER_INTERNAL"]);
  });

  it("penulis log yang melempar tidak mengubah hasil", async () => {
    const handler = createHandler({
      clock: new FakeClock(),
      loadContract: () => LOADED_OK,
      writeLine: () => {
        throw new Error("stdout closed");
      },
      steps: rig().steps,
    });
    const result = await handler(VALID_EVENT, CONTEXT);
    expect(result.ok).toBe(true);
  });
});

// ---- kontrak rusak (Requirement 2.10) ----

describe("kontrak rusak", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "verifier-contract-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function tempFile(name: string, content: string): URL {
    const path = join(dir, name);
    writeFileSync(path, content, "utf8");
    return pathToFileURL(path);
  }

  it("loader yang gagal: VERIFIER_INTERNAL dengan contract_version tak diketahui", async () => {
    const { handler, lines } = build({
      steps: rig().steps,
      load: () => ({ ok: false, reason: "contract.limits: bad" }),
    });
    const result = await handler(VALID_EVENT, CONTEXT);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([INTERNAL_DIAGNOSTIC]);
    expect(result.summary.checks).toEqual([]);
    expect(result.summary.contract_version).toBe(0);
    expect(lines).toHaveLength(1);
  });

  it("loader yang melempar: VERIFIER_INTERNAL", async () => {
    const { handler } = build({
      steps: rig().steps,
      load: () => {
        throw new Error("disk gone");
      },
    });
    const result = await handler(VALID_EVENT, CONTEXT);
    expect(result.diagnostics).toEqual([INTERNAL_DIAGNOSTIC]);
  });

  it("berkas sumber asli terbaca dan sama dengan kontrak yang dimuat tes", () => {
    const result = readContractFromLocations(CONTRACT_LOCATIONS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.contract.contract_version).toBe(contract.contract_version);
  });

  it("lokasi yang tidak ada dilewati sampai ketemu", () => {
    const missing = pathToFileURL(join(dir, "tidak-ada.json"));
    expect(readContractFromLocations([missing, CONTRACT_PATH]).ok).toBe(true);
  });

  it("semua lokasi tidak ada", () => {
    expect(readContractFromLocations([pathToFileURL(join(dir, "tidak-ada.json"))]).ok).toBe(false);
    expect(readContractFromLocations([]).ok).toBe(false);
  });

  it.each([
    ["not-json", "{not json"],
    ["not-a-contract", "{}"],
    ["array", "[]"],
    ["empty", ""],
  ])("berkas %s ditolak dan tidak diganti lokasi berikutnya", (name, content) => {
    const broken = tempFile(`broken-${name}.json`, content);
    expect(readContractFromLocations([broken, CONTRACT_PATH]).ok).toBe(false);
  });

  it("lokasi yang ada tetapi tidak terbaca (direktori) ditolak", () => {
    const folder = join(dir, "folder");
    mkdirSync(folder);
    expect(readContractFromLocations([pathToFileURL(folder), CONTRACT_PATH]).ok).toBe(false);
  });

  it("ujung ke ujung: handler dengan berkas kontrak rusak menghasilkan VERIFIER_INTERNAL", async () => {
    const broken = tempFile("e2e-broken.json", "{not json");
    const { handler } = build({
      steps: rig().steps,
      load: () => readContractFromLocations([broken]),
    });
    const result = await handler(VALID_EVENT, CONTEXT);
    expect(result.diagnostics).toEqual([INTERNAL_DIAGNOSTIC]);
  });

  it("kontrak yang berhasil dimuat di-cache; yang gagal dicoba lagi", async () => {
    let calls = 0;
    const { handler } = build({
      steps: rig().steps,
      load: () => {
        calls += 1;
        return calls === 1 ? { ok: false, reason: "transient" } : LOADED_OK;
      },
    });
    expect((await handler(VALID_EVENT, CONTEXT)).diagnostics).toEqual([INTERNAL_DIAGNOSTIC]);
    expect((await handler(VALID_EVENT, CONTEXT)).ok).toBe(true);
    await handler(VALID_EVENT, CONTEXT);
    expect(calls).toBe(2);
  });
});

// ---- log satu baris (Requirement 11.6) ----

describe("log satu baris", () => {
  it("tepat satu baris JSON dengan empat kunci dan tanpa sentinel", async () => {
    const event = {
      ...VALID_EVENT,
      source: "SENTINEL_SOURCE",
      required_tokens: ["SENTINEL_REQUIRED"],
      forbidden_tokens: ["SENTINEL_FORBIDDEN"],
    };
    const clock = new FakeClock();
    const { steps } = rig({
      1: (context) => (clock.advance(7), { diagnostics: [context.diagnostic("SIZE_SOURCE_TOO_LARGE", "error", "SENTINEL_MESSAGE")] }),
    });
    const { result, lines } = await run(event, steps, clock);
    expect(result.ok).toBe(false);
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? "";
    expect(line).not.toContain("\n");
    expect(line).not.toMatch(/SENTINEL/);
    expect(JSON.parse(line)).toEqual({
      request_id: "req-0001",
      ok: false,
      checks: [{ name: "size", ok: false, ms: 7 }],
      by_code: { SIZE_SOURCE_TOO_LARGE: 1 },
    });
  });

  it("by_code menghitung per kode dengan kunci terurut", async () => {
    const { steps } = rig({
      3: (context) => ({
        diagnostics: [
          context.diagnostic("ESLINT_PARSE_ERROR", "error", "a"),
          context.diagnostic("ESLINT_LORE_KIT_STYLE", "warning", "b"),
          context.diagnostic("ESLINT_LORE_KIT_STYLE", "warning", "c"),
        ],
      }),
    });
    const { lines } = await run(VALID_EVENT, steps);
    const parsed = JSON.parse(lines[0] ?? "{}") as { by_code: Record<string, number> };
    expect(Object.entries(parsed.by_code)).toEqual([
      ["ESLINT_LORE_KIT_STYLE", 2],
      ["ESLINT_PARSE_ERROR", 1],
    ]);
  });

  it("masukan salah tetap menulis satu baris dengan checks kosong", async () => {
    const { lines } = await run(null, rig().steps);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      request_id: "req-0001",
      ok: false,
      checks: [],
      by_code: { VERIFIER_BAD_INPUT: 1 },
    });
  });

  it("context tanpa awsRequestId tidak melempar", async () => {
    const { handler, lines } = build({ steps: rig().steps });
    await handler(VALID_EVENT, undefined as unknown as { awsRequestId: string });
    expect((JSON.parse(lines[0] ?? "{}") as { request_id: string }).request_id).toBe("unknown");
  });

  it("handler produksi menulis tepat satu baris ke stdout proses", async () => {
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);
    let result: VerifierResult;
    try {
      result = await productionHandler(null, { awsRequestId: "req-prod-77" });
    } finally {
      spy.mockRestore();
    }
    expect(result.diagnostics).toEqual([BAD_INPUT_DIAGNOSTIC]);
    const ours = writes.filter((text) => text.includes("req-prod-77"));
    expect(ours).toHaveLength(1);
    const text = ours[0] ?? "";
    expect(text.endsWith("\n")).toBe(true);
    expect(text.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(text)).toMatchObject({ request_id: "req-prod-77", ok: false, checks: [] });
  });
});

// ---- determinisme (Requirement 6.12) ----

describe("determinisme", () => {
  it("dua panggilan identik selain ms, tanpa Math.random", async () => {
    const random = vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Math.random dipakai di jalur keluaran");
    });
    try {
      const behaviours = {
        3: failing("ESLINT_LORE_KIT_STYLE", "warning"),
        6: failing("RENDER_CONSOLE_WARN", "warning"),
      };
      const first = await run(VALID_EVENT, rig(behaviours).steps);
      const second = await run(VALID_EVENT, rig(behaviours).steps);
      expect(first.result.ok).toBe(true);
      expect(withoutMs(first.result)).toEqual(withoutMs(second.result));
    } finally {
      random.mockRestore();
    }
  });

  it("sumber jalur keluaran tidak memakai Date atau Math.random", () => {
    const files = [
      "../src/verify.ts",
      "../src/handler.ts",
      "../src/versions.ts",
      "../src/steps/step.ts",
      "../src/diagnostics.ts",
    ];
    for (const file of files) {
      const code = readFileSync(new URL(file, import.meta.url), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      expect(code, file).not.toMatch(/\bDate\b/);
      expect(code, file).not.toMatch(/Math\.random/);
    }
  });
});
