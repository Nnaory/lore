// Tes render NYATA dan isolasi langkah 6 (tugas 6.3; design 5.9, 12.1, 14.1; Requirement 3.12, 9.15,
// 11.1, 11.3, 11.7, 11.9, 11.10, 11.11, 11.12, 32.13).
// Semua tes di sini memakai Worker sungguhan (`worker_threads`) yang menjalankan JavaScript hasil
// `tsc` di direktori sementara (`tests/support/compile-render-worker.ts`), bukan `FakeRenderHost`;
// direktori itu dihapus di `afterAll`. Lima kelompok:
//   1. korpus `fixtures/good` lewat `verify()` penuh dengan Worker nyata: `ok`, tujuh langkah, dan
//      total `ms` di `summary.checks` <= 30000 (9.15); paritas versi `summary.runtime_version` dengan
//      `node_modules/<paket>/package.json` dan pin di `package.json` (3.12);
//   2. isolasi: trik `createElement.constructor` tidak melihat `process.env` (11.10), banjir console
//      tidak menulis satu byte pun ke stdout/stderr PROSES (11.11; diperiksa di proses anak terpisah
//      yang keluarannya hanya satu baris JSON tanpa sentinel, sisi Worker dari 32.13; sisi handler
//      Lambda ada di tugas 8.3), `typeof` nama terlarang dan `require` selain react/remotion (11.12);
//   3. loop sinkron tak berujung: `RENDER_FRAME_TIMEOUT` dalam batas, lalu fixture bagus di host yang
//      sama tetap lulus (Worker dan konteks `vm` baru, 11.1, 11.7);
//   4. sumber daya yang DISKALAKAN agar aman di mesin ber-RAM sempit: pertumbuhan RSS nyata melewati
//      batas yang diturunkan (11.9) dan heap Worker kecil yang habis menjadi `ERR_WORKER_OUT_OF_MEMORY`
//      (11.3), masing-masing dengan kontrol yang membuktikan penyebabnya bukan persiapan Worker;
//   5. kasus harfiah `new Uint8Array(1.4e9).fill(1)` terhadap batas RSS 1200 MB yang sebenarnya. Kasus
//      ini hanya berjalan bila memori yang tersedia >= 3 GiB (atau dipaksa dengan
//      `LORE_VERIFIER_HEAVY=1`, dimatikan dengan `LORE_VERIFIER_HEAVY=0`); selain itu dilewati dengan
//      alasan tertulis, bukan dianggap lulus.
// Tidak ada pernyataan waktu yang sempit: batas bawah hanya yang pasti benar secara konstruksi
// (pewaktu tidak menyala lebih awal dari 2000 ms) dan batas atas memberi kelonggaran beberapa detik.

import { execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { freemem } from "node:os";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { FakeClock, systemClock } from "../src/clock.js";
import { loadContract, type Contract } from "../src/contract.js";
import { DEFAULT_STEPS } from "../src/steps/registry.js";
import {
  TERMINATE_GRACE_MS,
  createWorkerRenderHost,
  type RenderHost,
  type RenderOutcome,
  type RenderRequest,
} from "../src/steps/render-host.js";
import { FRAMES_ARTIFACT, createRenderStep } from "../src/steps/render.js";
import {
  BUNDLE_ARTIFACT,
  META_ARTIFACT,
  createStepContext,
  type VerifierStep,
} from "../src/steps/step.js";
import type { Diagnostic, Kind, MainMeta, VerifierResult } from "../src/types.js";
import { verify } from "../src/verify.js";
import { compileRenderWorker, type CompiledRenderWorker } from "./support/compile-render-worker.js";
import { handBundle } from "./support/render-bundles.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 90_000 });

const runFile = promisify(execFile);

// ---- kontrak, korpus, dan pembantu ----

const loaded = loadContract(
  JSON.parse(readFileSync(new URL("../contract/animation-contract.json", import.meta.url), "utf8")),
);
if (!loaded.ok) throw new Error(`kontrak sumber tidak sah: ${loaded.reason}`);
const contract: Contract = loaded.contract;

const META: MainMeta = { width: 1280, height: 720, fps: 30, durationInFrames: 30 };
/** `sampleFrames(30)`: `{0, floor(30/4), floor(30/2), floor(90/4), 29}`. */
const LESSON_FRAMES = [0, 7, 15, 22, 29];
const LOW_RSS = (): number => 0;
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

const CompanionSchema = z.object({
  kind: z.enum(["lesson", "puzzle"]),
  required_tokens: z.array(z.string()),
  forbidden_tokens: z.array(z.string()),
});

interface GoodFixture {
  readonly name: string;
  readonly source: string;
  readonly kind: Kind;
  readonly requiredTokens: readonly string[];
  readonly forbiddenTokens: readonly string[];
}

function loadFixtures(): GoodFixture[] {
  const dir = new URL("../fixtures/good/", import.meta.url);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => {
      const companion = CompanionSchema.parse(
        JSON.parse(readFileSync(new URL(name.replace(/\.ts$/, ".json"), dir), "utf8")),
      );
      return {
        name,
        source: readFileSync(new URL(name, dir), "utf8"),
        kind: companion.kind,
        requiredTokens: companion.required_tokens,
        forbiddenTokens: companion.forbidden_tokens,
      };
    });
}

const FIXTURES = loadFixtures();

let compiled: CompiledRenderWorker;
let host: RenderHost;

beforeAll(() => {
  compiled = compileRenderWorker();
  host = createWorkerRenderHost({ workerUrl: compiled.workerUrl, readRssBytes: LOW_RSS });
});

afterAll(() => {
  compiled?.dispose();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Pipeline lengkap (tujuh langkah) dengan langkah 6 di atas `renderHost`, jam monotonik sungguhan. */
function pipelineSteps(renderHost: RenderHost): VerifierStep[] {
  return DEFAULT_STEPS.map((step) => (step.number === 6 ? createRenderStep(renderHost) : step));
}

function verifyWithWorker(
  source: string,
  kind: Kind,
  requiredTokens: readonly string[] = [],
  forbiddenTokens: readonly string[] = [],
): Promise<VerifierResult> {
  return verify(
    {
      source,
      kind,
      required_tokens: requiredTokens,
      forbidden_tokens: forbiddenTokens,
      contract_version: contract.contract_version,
    },
    { clock: systemClock(), contract, steps: pipelineSteps(host) },
  );
}

const errorsOf = (diagnostics: readonly Diagnostic[]): Diagnostic[] =>
  diagnostics.filter((diagnostic) => diagnostic.severity === "error");

interface RequestOptions {
  readonly frames?: number[];
  readonly limits?: Partial<RenderRequest["limits"]>;
  /** Dipanggil pada setiap `progress` bertepi `start`; yang pertama adalah `evaluate`. */
  readonly onStart?: () => void;
}

/** Permintaan untuk `host.run` langsung, dengan batas dari kontrak yang dapat diturunkan per tes. */
function requestFor(bundle: string, options: RequestOptions = {}): RenderRequest {
  return {
    job: {
      type: "run",
      bundle,
      frames: options.frames ?? LESSON_FRAMES,
      shim: { allowed_imports: contract.allowed_imports },
      fps: META.fps,
      width: META.width,
      height: META.height,
      staticMeta: META,
    },
    limits: {
      frame_timeout_ms: contract.limits.frame_timeout_ms,
      rss_limit_mb: contract.limits.rss_limit_mb,
      worker_heap_mb: contract.limits.worker_heap_mb,
      ...options.limits,
    },
    remainingMs: Number.POSITIVE_INFINITY,
    deadlineReached: () => {
      options.onStart?.();
      return false;
    },
  };
}

/** Langkah 6 di atas host nyata untuk satu bundle; `frames` terisi hanya bila langkah tanpa galat. */
async function runRenderStep(
  bundle: string,
  options: { readonly host?: RenderHost; readonly contract?: Contract } = {},
) {
  const stepContract = options.contract ?? contract;
  const context = createStepContext({
    input: { source: "", kind: "lesson", required_tokens: [], forbidden_tokens: [], contract_version: 1 },
    contract: stepContract,
    clock: new FakeClock(),
    deadlineAt: Number.POSITIVE_INFINITY,
  });
  context.artifacts.set(META_ARTIFACT, META);
  context.artifacts.set(BUNDLE_ARTIFACT, bundle);
  const result = await createRenderStep(options.host ?? host).run(context);
  return { diagnostics: result.diagnostics, frames: context.artifacts.get(FRAMES_ARTIFACT) };
}

const codesOf = (diagnostics: readonly Diagnostic[]): string[] => diagnostics.map((d) => d.code);

// ---- 1. korpus dan paritas versi ----

describe("render sukses di Worker nyata (Requirement 3.12, 9.15)", () => {
  it("memuat korpus bagus untuk diuji", () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(8);
  });

  it.each(FIXTURES.map((fixture) => [fixture.name, fixture] as const))(
    "%s lolos ketujuh langkah dan total ms di summary.checks <= 30000",
    async (_name, fixture) => {
      const result = await verifyWithWorker(
        fixture.source,
        fixture.kind,
        fixture.requiredTokens,
        fixture.forbiddenTokens,
      );
      expect(errorsOf(result.diagnostics)).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.summary.checks.map((check) => check.name)).toEqual([
        "size",
        "policy",
        "eslint",
        "tsc",
        "esbuild",
        "render",
        "fidelity",
      ]);
      const total = result.summary.checks.reduce((sum, check) => sum + check.ms, 0);
      expect(total).toBeLessThanOrEqual(30_000);
    },
  );

  it("summary.runtime_version sama dengan node_modules/<paket>/package.json dan pin di package.json", async () => {
    const fixture = FIXTURES.find((candidate) => candidate.name === "formula-lesson.ts") ?? FIXTURES[0];
    if (fixture === undefined) throw new Error("korpus bagus kosong");
    const result = await verifyWithWorker(
      fixture.source,
      fixture.kind,
      fixture.requiredTokens,
      fixture.forbiddenTokens,
    );
    expect(result.ok).toBe(true);

    const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
    const ManifestSchema = z.object({ version: z.string().min(1) });
    const PinsSchema = z.object({ dependencies: z.record(z.string()) });
    const pins = PinsSchema.parse(readJson("../package.json")).dependencies;

    for (const name of ["react", "remotion"] as const) {
      const installed = ManifestSchema.parse(readJson(`../node_modules/${name}/package.json`)).version;
      expect(installed).toMatch(/^\d+\.\d+\.\d+$/);
      expect(result.summary.runtime_version[name]).toBe(installed);
      expect(pins[name]).toBe(installed);
      expect(result.summary.runtime_version[name]).toBe(pins[name]);
    }
  });
});

// ---- 2. isolasi ----

describe("isolasi kode pengarang di Worker nyata (Requirement 11.10, 11.11, 11.12)", () => {
  it("createElement.constructor tidak melihat process.env: hasil 0 atau RENDER_EXCEPTION (11.10)", async () => {
    vi.stubEnv("LORE_VERIFIER_TEST_SECRET", "must-not-reach-the-worker");
    const escape = "React.createElement['con' + 'structor']";
    const bundle = handBundle(
      [
        `const count = ${escape}('return Object.keys(process.env).length')();`,
        `const secret = ${escape}('return String(process.env.LORE_VERIFIER_TEST_SECRET)')();`,
        // Bukti bahwa jalan keluar benar-benar sampai ke realm Worker (design 12.3 butir 7): tanpa ini
        // hasil 0 bisa berarti "tidak sampai", bukan "env kosong".
        `const reached = ${escape}('return typeof process')();`,
        'return h("p", null, "env=" + count + ";secret=" + secret + ";host=" + reached);',
      ].join("\n"),
    );

    const { diagnostics, frames } = await runRenderStep(bundle);
    if (diagnostics.length > 0) {
      expect(new Set(codesOf(diagnostics))).toEqual(new Set(["RENDER_EXCEPTION"]));
    } else {
      expect(frames?.map((frame) => frame.text)).toEqual(
        LESSON_FRAMES.map(() => "env=0;secret=undefined;host=object"),
      );
    }
  });

  it("typeof nama terlarang bernilai undefined dan require selain react dan remotion melempar (11.12)", async () => {
    const bundle = handBundle(
      [
        "const types = [typeof process, typeof Buffer, typeof fs, typeof fetch, typeof XMLHttpRequest,",
        "  typeof WebSocket, typeof EventSource, typeof Worker, typeof WebAssembly];",
        "let denied = 0;",
        'for (const id of ["fs", "node:fs", "child_process", "react-dom", "react/jsx-runtime"]) {',
        "  try { require(id); } catch { denied += 1; }",
        "}",
        'return h("p", null, types.join(",") + ";denied=" + denied);',
      ].join("\n"),
    );

    const { diagnostics, frames } = await runRenderStep(bundle);
    expect(diagnostics).toEqual([]);
    const expected = `${Array<string>(9).fill("undefined").join(",")};denied=5`;
    expect(frames?.map((frame) => frame.text)).toEqual(LESSON_FRAMES.map(() => expected));
  });

  it("1000 pemanggilan console tidak menulis satu byte pun ke stdout atau stderr proses (11.11)", async () => {
    const sentinel = "LORE_SENTINEL_6_3_CONSOLE_FLOOD";
    const calls = 250;
    const bundle = handBundle('return h("p", null, "ok");', {
      top: [
        `const S = "${sentinel}";`,
        `for (let i = 0; i < ${calls}; i += 1) {`,
        "  console.log(S, i); console.info(S); console.debug(S); console.warn(S); console.error(S);",
        "}",
        // Jalan keluar lewat realm Worker: console dan stream Worker, bukan console konteks `vm`.
        "const escape = React.createElement['con' + 'structor'];",
        "escape('S', 'console.log(S); process.stdout.write(S); process.stderr.write(S);')(S);",
      ].join("\n"),
    });
    const request = { ...requestFor(bundle), remainingMs: 1e12 };

    // Proses anak: stdout proses yang sebenarnya hanya boleh berisi satu baris JSON dari skrip itu.
    const script = [
      "const { createWorkerRenderHost } = await import(process.env.LORE_TEST_HOST_URL);",
      "const request = JSON.parse(process.env.LORE_TEST_REQUEST);",
      "const outcome = await createWorkerRenderHost().run({ ...request, deadlineReached: () => false });",
      'const result = outcome.kind === "result" ? outcome.result : undefined;',
      "process.stdout.write(JSON.stringify({ kind: outcome.kind, console: result?.console,",
      '  evaluateError: result?.evaluateError ?? null }) + "\\n");',
    ].join("\n");
    const { stdout, stderr } = await runFile(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        env: {
          PATH: process.env.PATH ?? "",
          LORE_TEST_HOST_URL: compiled.hostUrl.href,
          LORE_TEST_REQUEST: JSON.stringify(request),
        },
        timeout: 45_000, // lebih pendek dari batas tes, supaya execFile yang mematikan anak bila macet
        maxBuffer: 1024 * 1024,
      },
    );

    expect(stdout).not.toContain(sentinel);
    expect(stderr).toBe("");
    const lines = stdout.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("");
    const ReportSchema = z.object({
      kind: z.literal("result"),
      console: z.object({ error: z.number(), warn: z.number() }),
      evaluateError: z.null(),
    });
    const report = ReportSchema.parse(JSON.parse(lines[0] ?? ""));
    // Panggilan benar-benar terjadi dan tertangkap (bukan terhenti sebelum sempat menulis).
    expect(report.console.error).toBeGreaterThanOrEqual(calls);
    expect(report.console.warn).toBeGreaterThanOrEqual(calls);
  });
});

// ---- 3. loop tak berujung ----

describe("loop sinkron tak berujung (Requirement 9.9, 11.1, 11.7)", () => {
  it("evaluasi bundle yang tak berhenti dimatikan watchdog 2000 ms dalam batas", async () => {
    const bundle = handBundle('return h("p", null, "never");', { top: "for (;;) {}" });
    let startedAt: number | undefined;
    const request = requestFor(bundle, {
      onStart: () => {
        startedAt ??= performance.now();
      },
    });

    const outcome: RenderOutcome = await host.run(request);
    const elapsed = performance.now() - (startedAt ?? Number.NaN);

    expect(outcome).toEqual({ kind: "frame_timeout", at: "evaluate" });
    // Pewaktu dipasang tepat sebelum `startedAt` dicatat, jadi tidak mungkin menyala lebih awal.
    expect(elapsed).toBeGreaterThanOrEqual(contract.limits.frame_timeout_ms - 50);
    // Keputusan pada 2000 ms, lalu terminate paling lama TERMINATE_GRACE_MS; sisanya kelonggaran.
    expect(elapsed).toBeLessThan(contract.limits.frame_timeout_ms + TERMINATE_GRACE_MS + 3000);
  });

  it("frame yang tak berhenti memberi RENDER_FRAME_TIMEOUT frame=15 dan fixture bagus berikutnya lulus", async () => {
    const loop = [
      'import { createElement } from "react";',
      'import { useCurrentFrame } from "remotion";',
      "",
      "export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 30 };",
      "",
      "export default function Main() {",
      "  const frame = useCurrentFrame();",
      "  if (frame >= 15) {",
      "    for (;;) {",
      "      // never ends",
      "    }",
      "  }",
      '  return createElement("p", null, "Frame " + frame);',
      "}",
      "",
    ].join("\n");

    const stuck = await verifyWithWorker(loop, "lesson");
    expect(stuck.ok).toBe(false);
    expect(stuck.diagnostics.map((d) => [d.code, d.message])).toEqual([
      ["RENDER_FRAME_TIMEOUT", "frame=15 did not finish in time"],
    ]);
    // Langkah 7 tidak berjalan setelah langkah 6 gagal.
    expect(stuck.summary.checks.map((check) => [check.name, check.ok])).toEqual([
      ["size", true],
      ["policy", true],
      ["eslint", true],
      ["tsc", true],
      ["esbuild", true],
      ["render", false],
    ]);

    const fixture = FIXTURES[0];
    if (fixture === undefined) throw new Error("korpus bagus kosong");
    const next = await verifyWithWorker(
      fixture.source,
      fixture.kind,
      fixture.requiredTokens,
      fixture.forbiddenTokens,
    );
    expect(errorsOf(next.diagnostics)).toEqual([]);
    expect(next.ok).toBe(true);
  });
});

// ---- 4. sumber daya, diskalakan ----

/**
 * Menyimpan 50 MB demi 50 MB saat evaluasi bundle (sekali, bukan per frame), lalu menahannya selama
 * 1 detik agar pemeriksa RSS 50 ms sempat melihatnya. Isi `Main` tidak mengalokasikan apa pun.
 */
function allocatingBundle(chunks: number): string {
  return handBundle('return h("p", null, "kept");', {
    top: [
      "const keep = [];",
      `for (let i = 0; i < ${chunks}; i += 1) keep.push(new Uint8Array(50e6).fill(1));`,
      "const until = Date.now() + 1000;",
      "while (Date.now() < until) { /* hold */ }",
    ].join("\n"),
  });
}

/**
 * Batas waktu per frame yang dinaikkan untuk tes sumber daya: yang diuji adalah jalur RSS dan heap,
 * jadi `RENDER_FRAME_TIMEOUT` tidak boleh mendahului keduanya pada mesin yang sedang lambat.
 */
const PATIENT_FRAME_TIMEOUT_MS = 30_000;

describe("batas sumber daya, diskalakan agar aman di mesin ber-RAM sempit (Requirement 11.3, 11.9)", () => {
  it("pertumbuhan RSS nyata melewati batas memberi resource_limit; tanpa melewatinya hasilnya normal (11.9)", async () => {
    const growthLimitMb = 150;
    const chunks = 8; // 400 MB: tidak pernah tercapai bila pemeriksa RSS bekerja

    /** Pembaca RSS nyata, dihitung sejak evaluasi bundle dimulai, jadi persiapan Worker tidak ikut. */
    const growthSinceEvaluate = (): { read: () => number; arm: () => void } => {
      let base: number | undefined;
      return {
        arm: () => {
          base ??= process.memoryUsage.rss();
        },
        read: () => (base === undefined ? 0 : Math.max(0, process.memoryUsage.rss() - base)),
      };
    };
    const runWith = async (bundle: string): Promise<RenderOutcome> => {
      const growth = growthSinceEvaluate();
      const rssHost = createWorkerRenderHost({ workerUrl: compiled.workerUrl, readRssBytes: growth.read });
      return rssHost.run(
        requestFor(bundle, {
          limits: { rss_limit_mb: growthLimitMb, frame_timeout_ms: PATIENT_FRAME_TIMEOUT_MS },
          onStart: growth.arm,
        }),
      );
    };

    // Kontrol: alokasi kecil (50 MB) di bawah batas selesai normal, jadi `resource_limit` di bawah
    // berasal dari alokasi bundle, bukan dari persiapan Worker atau pemuatan React.
    const control = await runWith(allocatingBundle(1));
    expect(control.kind).toBe("result");

    const outcome = await runWith(allocatingBundle(chunks));
    expect(outcome).toEqual({ kind: "resource_limit" });
  });

  it("heap Worker yang habis menjadi resource_limit (ERR_WORKER_OUT_OF_MEMORY), bukan proses yang mati (11.3)", async () => {
    const limits = { worker_heap_mb: 128, frame_timeout_ms: PATIENT_FRAME_TIMEOUT_MS };
    const healthy = handBundle('return h("p", null, "ok");');
    const exhaust = handBundle("const keep = []; for (;;) keep.push(new Array(1e6).fill(keep.length));");

    // Kontrol: dengan heap yang sama, bundle sehat selesai normal, jadi kegagalan di bawah berasal dari
    // kode yang menghabiskan heap, bukan dari batas yang terlalu kecil untuk memuat jsdom dan React.
    expect((await host.run(requestFor(healthy, { limits }))).kind).toBe("result");

    expect(await host.run(requestFor(exhaust, { limits }))).toEqual({ kind: "resource_limit" });

    const after = await runRenderStep(healthy);
    expect(after.diagnostics).toEqual([]); // host yang sama masih sehat setelahnya
  });
});

// ---- 5. kasus harfiah 1,4 GB ----

const HEAVY_SWITCH = process.env.LORE_VERIFIER_HEAVY;
const HEAVY_MIN_FREE_BYTES = 3 * GIB;
const heavyAllowed = HEAVY_SWITCH === "1" || (HEAVY_SWITCH !== "0" && freemem() >= HEAVY_MIN_FREE_BYTES);

describe("kasus harfiah terhadap batas RSS 1200 MB (Requirement 11.9)", () => {
  // Dilewati bila memori tersedia kurang dari 3 GiB: mengisi 1,4 GB bisa menjatuhkan mesin kecil.
  // Jalankan: LORE_VERIFIER_HEAVY=1 npx vitest run tests/render-real.test.ts -t "1,4 GB"
  it.skipIf(!heavyAllowed)(
    "new Uint8Array(1.4e9).fill(1) memberi RENDER_RESOURCE_LIMIT dan Worker dihentikan (1,4 GB; dilewati bila memori tersedia < 3 GiB)",
    async () => {
      const realRssHost = createWorkerRenderHost({ workerUrl: compiled.workerUrl });
      // Batas RSS tetap 1200 MB dari kontrak; hanya batas waktu per frame dinaikkan agar pengisian
      // 1,4 GB yang lambat pada mesin sibuk tidak didahului `RENDER_FRAME_TIMEOUT`.
      const patient: Contract = {
        ...contract,
        limits: { ...contract.limits, frame_timeout_ms: PATIENT_FRAME_TIMEOUT_MS },
      };
      const bundle = handBundle(
        [
          "const big = new Uint8Array(1.4e9).fill(1);",
          "const until = Date.now() + 500;",
          "while (Date.now() < until) { /* hold */ }",
          'return h("p", null, "size " + big.length);',
        ].join("\n"),
      );

      const { diagnostics } = await runRenderStep(bundle, { host: realRssHost, contract: patient });
      expect(diagnostics.map((d) => [d.code, d.message])).toEqual([
        ["RENDER_RESOURCE_LIMIT", "memory limit reached"],
      ]);

      // Setelah Worker dimatikan, host yang sama masih melayani invokasi berikutnya.
      const after = await runRenderStep(handBundle('return h("p", null, "ok");'), { host: realRssHost });
      expect(after.diagnostics).toEqual([]);
    },
  );
});
