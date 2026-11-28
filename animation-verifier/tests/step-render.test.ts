// Tes sisi induk langkah 6, uji render (tugas 6.2; Requirement 9.2, 9.4 sampai 9.10, 9.12 sampai
// 9.14, 11.3, 11.7, 11.8, 11.9, 6.7, 6.12; design 5.9).
// Empat lapis: (1) `sampleFrames` (contoh dan properti); (2) penerjemahan `RenderOutcome` ke
// Diagnostic dengan `FakeRenderHost` dan `FakeClock` (tanpa spawn): setiap kode `RENDER_*`,
// `VERIFIER_DEADLINE` di awal dan di tengah langkah, `VERIFIER_INTERNAL`; (3) langkah di dalam
// `verify()` dengan langkah lain palsu (`RENDER_CONSOLE_WARN` tetap `ok` true, deadline tengah langkah
// menghentikan langkah 7); (4) langkah di atas inti Worker yang dijalankan di proses tes
// (`runRenderJob`, tanpa spawn) untuk membuktikan keputusan `RENDER_EMPTY` dan semua `fixtures/good`
// tanpa temuan palsu. Worker nyata diuji di `render-host-real.test.ts` (kecil) dan 6.3.
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../src/clock.js";
import { loadContract, type Contract } from "../src/contract.js";
import { FakeRenderHost, parseWorkerMessage } from "../src/steps/render-host.js";
import {
  FRAMES_ARTIFACT,
  THUMBNAIL_WRAPPER_ELEMENTS,
  createRenderStep,
  errorNameOf,
  renderStep,
  sampleFrames,
  type FakeRenderScript,
  type RenderHost,
  type RenderOutcome,
  type RenderRequest,
} from "../src/steps/render.js";
import { runRenderJob, type FrameCapture, type ResultMessage, type RunMessage } from "../src/steps/render-core.js";
import { DEFAULT_STEPS } from "../src/steps/registry.js";
import {
  BUNDLE_ARTIFACT,
  META_ARTIFACT,
  createStepContext,
  indexSteps,
  type StepContext,
  type StepResult,
  type VerifierStep,
} from "../src/steps/step.js";
import type { Diagnostic, Kind, MainMeta } from "../src/types.js";
import { verify } from "../src/verify.js";
import { esbuildBundle, handBundle, loadGoodFixtures } from "./support/render-bundles.js";

vi.setConfig({ testTimeout: 60_000 });

// ---- kontrak dan pembantu ----

const loaded = loadContract(
  JSON.parse(readFileSync(new URL("../contract/animation-contract.json", import.meta.url), "utf8")),
);
if (!loaded.ok) throw new Error(`kontrak sumber tidak sah: ${loaded.reason}`);
const contract: Contract = loaded.contract;

const META: MainMeta = { width: 1280, height: 720, fps: 30, durationInFrames: 30 };
/** `sampleFrames(30)`, ditulis tangan: `floor(30/4)=7`, `floor(30/2)=15`, `floor(90/4)=22`, `d-1=29`. */
const LESSON_FRAMES = [0, 7, 15, 22, 29];

interface ContextOptions {
  kind?: Kind;
  /** `null` melepas artefak. */
  meta?: MainMeta | null;
  bundle?: string | null;
  clock?: FakeClock;
  deadlineAt?: number;
}

function makeContext(options: ContextOptions = {}): { context: StepContext; clock: FakeClock } {
  const clock = options.clock ?? new FakeClock();
  const context = createStepContext({
    input: {
      source: "",
      kind: options.kind ?? "lesson",
      required_tokens: [],
      forbidden_tokens: [],
      contract_version: contract.contract_version,
    },
    contract,
    clock,
    deadlineAt: options.deadlineAt ?? clock.now() + contract.limits.verifier_deadline_ms,
  });
  if (options.meta !== null) context.artifacts.set(META_ARTIFACT, options.meta ?? META);
  if (options.bundle !== null) context.artifacts.set(BUNDLE_ARTIFACT, options.bundle ?? "BUNDLE");
  return { context, clock };
}

type Script = FakeRenderScript | ((request: RenderRequest, index: number) => FakeRenderScript);

async function runStep(script: Script, options: ContextOptions = {}) {
  const host = new FakeRenderHost(script);
  const { context, clock } = makeContext(options);
  const result: StepResult = await createRenderStep(host).run(context);
  return { result, diagnostics: result.diagnostics, host, context, clock };
}

/** Tangkapan frame yang sehat: ada teks, elemen, dan dua lintasan yang sama. */
const sane = (text = "hello", count = 8): FrameCapture => ({
  html: `<i>${text}</i>`,
  text,
  count,
  secondHtml: `<i>${text}</i>`,
});

interface ResultSpec {
  perFrame?: Record<number, FrameCapture>;
  result?: Partial<Omit<ResultMessage, "frames">>;
}

/** Skenario `result` untuk tepat frame yang diminta langkah; frame tanpa `perFrame` sehat. */
function resultScript(spec: ResultSpec = {}): (request: RenderRequest) => FakeRenderScript {
  return (request) => ({
    outcome: {
      kind: "result",
      result: {
        type: "result",
        metaMatches: true,
        defaultIsFunction: true,
        console: { error: 0, warn: 0 },
        ...spec.result,
        frames: Object.fromEntries(
          request.job.frames.map((frame) => [frame, spec.perFrame?.[frame] ?? sane()]),
        ),
      },
    },
  });
}

const outcomeScript = (outcome: RenderOutcome): FakeRenderScript => ({ outcome });

const codes = (diagnostics: readonly Diagnostic[]): string[] => diagnostics.map((d) => d.code);
const hasError = (diagnostics: readonly Diagnostic[]): boolean =>
  diagnostics.some((d) => d.severity === "error");

function diagnostic(code: string, message: string, severity: "error" | "warning" = "error"): Diagnostic {
  return { tool: code.startsWith("VERIFIER_") ? "verifier" : "render", code, severity, message };
}

const INTERNAL = diagnostic("VERIFIER_INTERNAL", "internal verifier error");
const DEADLINE = diagnostic("VERIFIER_DEADLINE", "verification deadline reached");

// ---- sampleFrames ----

describe("sampleFrames (Requirement 9.2, 9.13)", () => {
  it.each([
    ["lesson d=30", () => sampleFrames(30), [0, 7, 15, 22, 29]],
    ["lesson d=900", () => sampleFrames(900), [0, 225, 450, 675, 899]],
    ["lesson d=30 dengan p (hanya p ditambah)", () => sampleFrames(30, 10, "lesson"), [0, 7, 10, 15, 22, 29]],
    ["puzzle d=30 p=10", () => sampleFrames(30, 10, "puzzle"), [0, 5, 7, 9, 10, 15, 22, 29]],
    ["puzzle tanpa kind dianggap puzzle bila p ada", () => sampleFrames(30, 10), [0, 5, 7, 9, 10, 15, 22, 29]],
    ["puzzle p=1 (floor(p/2)=0 dan p-1=0 menumpuk di 0)", () => sampleFrames(30, 1, "puzzle"), [0, 1, 7, 15, 22, 29]],
    ["puzzle p=2", () => sampleFrames(30, 2, "puzzle"), [0, 1, 2, 7, 15, 22, 29]],
    ["puzzle p=d-1", () => sampleFrames(30, 29, "puzzle"), [0, 7, 14, 15, 22, 28, 29]],
    ["puzzle p jatuh pada frame dasar (15)", () => sampleFrames(30, 15, "puzzle"), [0, 7, 14, 15, 22, 29]],
    ["d=31 (pembulatan ke bawah)", () => sampleFrames(31), [0, 7, 15, 23, 30]],
  ])("%s", (_name, compute, expected) => {
    expect(compute()).toEqual(expected);
  });

  it("membuang nilai di luar [0, d-1] dan yang bukan bilangan bulat, tanpa melempar", () => {
    expect(sampleFrames(30, 99, "puzzle")).toEqual(LESSON_FRAMES);
    expect(sampleFrames(30, 30, "lesson")).toEqual(LESSON_FRAMES);
    expect(sampleFrames(30, 10.5, "lesson")).toEqual(LESSON_FRAMES);
    expect(sampleFrames(0)).toEqual([]);
    expect(sampleFrames(Number.NaN)).toEqual([]);
  });

  it("properti: terurut naik tanpa duplikat, di dalam [0, d-1], dan memuat semua frame yang diwajibkan", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 30, max: 900 }),
        fc.nat(),
        fc.constantFrom<Kind>("lesson", "puzzle"),
        (d, seed, kind) => {
          const p = 1 + (seed % (d - 1));
          const frames = sampleFrames(d, p, kind);
          for (let i = 1; i < frames.length; i += 1) expect(frames[i]).toBeGreaterThan(frames[i - 1] ?? Infinity);
          expect(frames.every((f) => Number.isInteger(f) && f >= 0 && f <= d - 1)).toBe(true);
          const required = [0, Math.floor(d / 4), Math.floor(d / 2), Math.floor((3 * d) / 4), d - 1, p];
          if (kind === "puzzle") required.push(Math.floor(p / 2), p - 1);
          for (const frame of required) expect(frames).toContain(frame);
          expect(frames.length).toBeLessThanOrEqual(required.length);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---- permintaan ke host ----

describe("langkah 6: permintaan ke RenderHost", () => {
  it("menyerahkan bundle, meta, jam, dan batas kontrak; frame sampel menurut jenis", async () => {
    const { host } = await runStep(resultScript(), {
      bundle: "BUNDLE-TEXT",
      clock: new FakeClock(1000),
    });
    const [request] = host.requests;
    expect(host.requests).toHaveLength(1);
    expect(request?.job).toEqual({
      type: "run",
      bundle: "BUNDLE-TEXT",
      frames: LESSON_FRAMES,
      shim: {
        allowed_imports: {
          react: { values: [...(contract.allowed_imports.react?.values ?? [])] },
          remotion: { values: [...(contract.allowed_imports.remotion?.values ?? [])] },
        },
      },
      fps: 30,
      width: 1280,
      height: 720,
      staticMeta: META,
    });
    expect(request?.limits).toEqual({ frame_timeout_ms: 2000, rss_limit_mb: 1200, worker_heap_mb: 512 });
    expect(request?.remainingMs).toBe(contract.limits.verifier_deadline_ms);
  });

  it("puzzle: frame sampel memuat pauseAtFrame, floor(p/2), dan p-1, dan staticMeta membawa pauseAtFrame", async () => {
    const meta: MainMeta = { ...META, pauseAtFrame: 10 };
    const { host } = await runStep(resultScript(), { kind: "puzzle", meta });
    expect(host.requests[0]?.job.frames).toEqual([0, 5, 7, 9, 10, 15, 22, 29]);
    expect(host.requests[0]?.job.staticMeta).toEqual(meta);
    expect(host.requests[0]?.job.staticMeta).not.toBe(meta);
  });

  it("remainingMs mengikuti jam, dan deadlineReached membaca jam yang sama", async () => {
    const clock = new FakeClock(500);
    const { host } = await runStep(resultScript(), { clock, deadlineAt: 2500 });
    const request = host.requests[0];
    expect(request?.remainingMs).toBe(2000);
    expect(request?.deadlineReached()).toBe(false);
    clock.advance(1999);
    expect(request?.deadlineReached()).toBe(false);
    clock.advance(1);
    expect(request?.deadlineReached()).toBe(true);
  });
});

// ---- penerjemahan hasil ----

describe("langkah 6: hasil bersih", () => {
  it("tanpa temuan, dan teks mentah tiap frame sampel masuk ke FRAMES_ARTIFACT untuk langkah 7", async () => {
    const { diagnostics, context } = await runStep(
      resultScript({ perFrame: { 29: sane("final text") } }),
    );
    expect(diagnostics).toEqual([]);
    expect(context.artifacts.get(FRAMES_ARTIFACT)).toEqual(
      LESSON_FRAMES.map((frame) => ({ frame, text: frame === 29 ? "final text" : "hello" })),
    );
  });

  it("tidak mengisi FRAMES_ARTIFACT bila langkah melapor galat", async () => {
    const { diagnostics, context } = await runStep(
      resultScript({ perFrame: { 7: { error: "Error: x" } } }),
    );
    expect(hasError(diagnostics)).toBe(true);
    expect(context.artifacts.get(FRAMES_ARTIFACT)).toBeUndefined();
  });
});

describe("langkah 6: RENDER_EXCEPTION (Requirement 9.4)", () => {
  it("exception evaluasi: frame=evaluate, nama galat saja, tanpa line, dan tanpa pemeriksaan frame", async () => {
    const { diagnostics } = await runStep(
      resultScript({
        result: { evaluateError: "TypeError: Cannot read properties of undefined (reading 'x')" },
        perFrame: { 0: { text: "", count: 3 } },
      }),
    );
    expect(diagnostics).toEqual([diagnostic("RENDER_EXCEPTION", "frame=evaluate render threw TypeError")]);
    expect(diagnostics[0]).not.toHaveProperty("line");
    expect(diagnostics[0]).not.toHaveProperty("column");
  });

  it("exception pada satu frame: frame=<n>, frame lain tetap diperiksa, dan nondeterminisme dilewati (9.11)", async () => {
    const { diagnostics } = await runStep(
      resultScript({
        perFrame: {
          7: { error: "RangeError: Maximum call stack size exceeded", html: "<a>", secondHtml: "<b>", text: "", count: 3 },
          22: { ...sane(), secondHtml: "<different>" },
        },
      }),
    );
    expect(diagnostics).toEqual([
      diagnostic("RENDER_EXCEPTION", "frame=7 render threw RangeError"),
      diagnostic("RENDER_NONDETERMINISTIC", "frame=22 rendered differently on the second pass"),
    ]);
  });

  it("satu RENDER_EXCEPTION per frame bergalat", async () => {
    const { diagnostics } = await runStep(
      resultScript({ perFrame: { 0: { error: "Error: a" }, 15: { error: "TypeError: b" } } }),
    );
    expect(diagnostics).toEqual([
      diagnostic("RENDER_EXCEPTION", "frame=0 render threw Error"),
      diagnostic("RENDER_EXCEPTION", "frame=15 render threw TypeError"),
    ]);
  });

  it.each([
    ["TypeError: x is not a function", "TypeError"],
    ["Error: boom", "Error"],
    ["$Weird_1: boom", "$Weird_1"],
    ["thrown string: boom", "Error"],
    ["thrown a non-error object", "Error"],
    ["/home/user/app/main.js:3: boom", "Error"],
    ["Two Words: boom", "Error"],
    [`${"A".repeat(50)}: boom`, "Error"],
    ["", "Error"],
  ])("errorNameOf(%j) = %s", (description, expected) => {
    expect(errorNameOf(description)).toBe(expected);
  });
});

describe("langkah 6: kegagalan lingkungan Worker", () => {
  it("evaluateError berawalan 'verifier setup failed:' menjadi VERIFIER_INTERNAL, bukan salah pengarang", async () => {
    const { diagnostics } = await runStep(
      resultScript({ result: { evaluateError: "verifier setup failed: host module is missing Thumbnail" } }),
    );
    expect(diagnostics).toEqual([INTERNAL]);
  });
});

describe("langkah 6: console (Requirement 9.5)", () => {
  it("console.error: RENDER_CONSOLE_ERROR (error), satu temuan berapa pun jumlah panggilannya", async () => {
    const { diagnostics } = await runStep(resultScript({ result: { console: { error: 7, warn: 0 } } }));
    expect(diagnostics).toEqual([diagnostic("RENDER_CONSOLE_ERROR", "console.error was called during render")]);
  });

  it("console.warn: RENDER_CONSOLE_WARN dengan severity warning, sehingga langkah tidak melapor galat", async () => {
    const { diagnostics } = await runStep(resultScript({ result: { console: { error: 0, warn: 3 } } }));
    expect(diagnostics).toEqual([
      diagnostic("RENDER_CONSOLE_WARN", "console.warn was called during render", "warning"),
    ]);
    expect(hasError(diagnostics)).toBe(false);
  });

  it("keduanya dilaporkan bersama, juga ketika evaluasi gagal", async () => {
    const { diagnostics } = await runStep(
      resultScript({ result: { console: { error: 1, warn: 1 }, evaluateError: "Error: boom" } }),
    );
    expect(codes(diagnostics).sort()).toEqual(["RENDER_CONSOLE_ERROR", "RENDER_CONSOLE_WARN", "RENDER_EXCEPTION"]);
  });
});

describe("langkah 6: RENDER_DOM_LIMIT (Requirement 9.6)", () => {
  it("lebih dari dom_max_elements: frame dan jumlah ada di pesan", async () => {
    const { diagnostics } = await runStep(resultScript({ perFrame: { 15: sane("x", 601) } }));
    expect(diagnostics).toEqual([diagnostic("RENDER_DOM_LIMIT", "frame=15 count=601 exceeds 600 elements")]);
  });

  it("tepat sebesar batas lolos; satu temuan per frame yang melewatinya", async () => {
    expect((await runStep(resultScript({ perFrame: { 15: sane("x", 600) } }))).diagnostics).toEqual([]);
    const { diagnostics } = await runStep(
      resultScript({ perFrame: { 0: sane("x", 9000), 29: sane("x", 601) } }),
    );
    expect(diagnostics.map((d) => d.message)).toEqual([
      "frame=0 count=9000 exceeds 600 elements",
      "frame=29 count=601 exceeds 600 elements",
    ]);
  });
});

describe("langkah 6: RENDER_EMPTY (Requirement 9.7)", () => {
  const WRAPPERS = THUMBNAIL_WRAPPER_ELEMENTS;

  it("frame tanpa teks dan tanpa elemen dari Main (hanya pembungkus Thumbnail) kosong, di frame mana pun", async () => {
    const { diagnostics } = await runStep(resultScript({ perFrame: { 0: sane("", WRAPPERS) } }));
    expect(diagnostics).toEqual([diagnostic("RENDER_EMPTY", "frame=0 rendered no content")]);
  });

  it("frame terakhir tanpa teks kosong walau Main menggambar elemen; frame lain tanpa teks tidak", async () => {
    const { diagnostics } = await runStep(
      resultScript({ perFrame: { 15: sane("", WRAPPERS + 4), 29: sane("", WRAPPERS + 4) } }),
    );
    expect(diagnostics).toEqual([diagnostic("RENDER_EMPTY", "frame=29 rendered no content")]);
  });

  it("teks yang hanya spasi dan baris baru dianggap tanpa teks", async () => {
    const { diagnostics } = await runStep(resultScript({ perFrame: { 29: sane(" \n\t\u00a0\ufeff", 9) } }));
    expect(codes(diagnostics)).toEqual(["RENDER_EMPTY"]);
  });

  it("Main yang hanya mengembalikan teks (count sama dengan pembungkus) tidak kosong", async () => {
    const { diagnostics } = await runStep(resultScript({ perFrame: { 0: sane("x", WRAPPERS), 29: sane("x", WRAPPERS) } }));
    expect(diagnostics).toEqual([]);
  });

  it("frame terakhir yang memenuhi kedua syarat hanya menghasilkan satu temuan", async () => {
    const { diagnostics } = await runStep(resultScript({ perFrame: { 29: sane("", WRAPPERS) } }));
    expect(diagnostics).toEqual([diagnostic("RENDER_EMPTY", "frame=29 rendered no content")]);
  });

  it("satu temuan per frame kosong, menurut urutan frame", async () => {
    const empty = sane("", WRAPPERS);
    const { diagnostics } = await runStep(resultScript({ perFrame: { 0: empty, 7: empty, 15: empty, 22: empty, 29: empty } }));
    expect(diagnostics.map((d) => d.message)).toEqual(LESSON_FRAMES.map((f) => `frame=${f} rendered no content`));
  });

  it("puzzle: hanya frame terakhir (d-1) yang wajib bernas teks, bukan pauseAtFrame", async () => {
    const meta: MainMeta = { ...META, pauseAtFrame: 10 };
    const { diagnostics } = await runStep(
      resultScript({ perFrame: { 10: sane("", WRAPPERS + 2) } }),
      { kind: "puzzle", meta },
    );
    expect(diagnostics).toEqual([]);
  });
});

describe("langkah 6: RENDER_META_MISMATCH (Requirement 9.8)", () => {
  it.each([
    ["meta berbeda", { metaMatches: false, defaultIsFunction: true }],
    ["ekspor default bukan fungsi", { metaMatches: true, defaultIsFunction: false }],
    ["keduanya", { metaMatches: false, defaultIsFunction: false }],
  ])("%s: satu temuan, dan frame tidak diperiksa", async (_name, result) => {
    const { diagnostics } = await runStep(
      resultScript({ result, perFrame: { 0: { error: "Error: ignored" }, 29: sane("", 3) } }),
    );
    expect(diagnostics).toEqual([
      diagnostic(
        "RENDER_META_MISMATCH",
        "executed meta differs from the static meta, or default export is not a function",
      ),
    ]);
  });
});

describe("langkah 6: RENDER_NONDETERMINISTIC (Requirement 9.3, 9.11)", () => {
  it("HTML lintasan kedua berbeda: satu temuan per frame yang berbeda", async () => {
    const { diagnostics } = await runStep(
      resultScript({
        perFrame: { 7: { ...sane(), secondHtml: "<x>" }, 29: { ...sane(), secondHtml: "<y>" } },
      }),
    );
    expect(diagnostics).toEqual([
      diagnostic("RENDER_NONDETERMINISTIC", "frame=7 rendered differently on the second pass"),
      diagnostic("RENDER_NONDETERMINISTIC", "frame=29 rendered differently on the second pass"),
    ]);
  });

  it("tanpa lintasan kedua tidak dianggap berbeda; HTML yang sama tidak dilaporkan", async () => {
    const { diagnostics } = await runStep(
      resultScript({ perFrame: { 0: { html: "<i>a</i>", text: "a", count: 8 } } }),
    );
    expect(diagnostics).toEqual([]);
  });
});

describe("langkah 6: RENDER_FRAME_TIMEOUT, RENDER_RESOURCE_LIMIT (Requirement 9.9, 11.3, 11.8, 11.9)", () => {
  it("timeout saat evaluasi dan pada frame tertentu", async () => {
    expect((await runStep(outcomeScript({ kind: "frame_timeout", at: "evaluate" }))).diagnostics).toEqual([
      diagnostic("RENDER_FRAME_TIMEOUT", "frame=evaluate did not finish in time"),
    ]);
    expect((await runStep(outcomeScript({ kind: "frame_timeout", at: 15 }))).diagnostics).toEqual([
      diagnostic("RENDER_FRAME_TIMEOUT", "frame=15 did not finish in time"),
    ]);
  });

  it("batas sumber daya: satu temuan tanpa nomor frame", async () => {
    expect((await runStep(outcomeScript({ kind: "resource_limit" }))).diagnostics).toEqual([
      diagnostic("RENDER_RESOURCE_LIMIT", "memory limit reached"),
    ]);
  });
});

describe("langkah 6: galat internal, gagal tertutup", () => {
  it("failure dari host menjadi VERIFIER_INTERNAL", async () => {
    expect((await runStep(outcomeScript({ kind: "failure" }))).diagnostics).toEqual([INTERNAL]);
  });

  it("host yang menolak (reject) atau melempar menjadi VERIFIER_INTERNAL tanpa teks exception", async () => {
    const rejecting: RenderHost = { run: () => Promise.reject(new Error("secret source text")) };
    const throwing: RenderHost = {
      run: () => {
        throw new Error("secret source text");
      },
    };
    for (const host of [rejecting, throwing]) {
      const { context } = makeContext();
      const result = await createRenderStep(host).run(context);
      expect(result.diagnostics).toEqual([INTERNAL]);
    }
  });

  it("artefak meta atau bundle yang hilang: VERIFIER_INTERNAL dan host tidak dipanggil", async () => {
    for (const options of [{ meta: null }, { bundle: null }]) {
      const { diagnostics, host } = await runStep(resultScript(), options);
      expect(diagnostics).toEqual([INTERNAL]);
      expect(host.requests).toHaveLength(0);
    }
  });

  it("frame yang diminta tetapi tidak ada di hasil: VERIFIER_INTERNAL", async () => {
    const { diagnostics } = await runStep({
      outcome: {
        kind: "result",
        result: { type: "result", metaMatches: true, defaultIsFunction: true, console: { error: 0, warn: 0 }, frames: { 0: sane() } },
      },
    });
    expect(diagnostics).toEqual([INTERNAL]);
  });

  it("durasi yang tidak menghasilkan frame sampel: VERIFIER_INTERNAL", async () => {
    const { diagnostics, host } = await runStep(resultScript(), { meta: { ...META, durationInFrames: 0 } });
    expect(diagnostics).toEqual([INTERNAL]);
    expect(host.requests).toHaveLength(0);
  });
});

// ---- deadline ----

describe("langkah 6: VERIFIER_DEADLINE (Requirement 9.10, 11.7)", () => {
  it("deadline sudah lewat saat langkah mulai: host tidak dipanggil", async () => {
    const clock = new FakeClock(100);
    const { diagnostics, host } = await runStep(resultScript(), { clock, deadlineAt: 100 });
    expect(diagnostics).toEqual([DEADLINE]);
    expect(host.requests).toHaveLength(0);
  });

  it("host melaporkan deadline (timer): satu temuan, tanpa RENDER_*", async () => {
    expect((await runStep(outcomeScript({ kind: "deadline" }))).diagnostics).toEqual([DEADLINE]);
  });

  it("deadline lewat di tengah langkah (di antara dua frame): dideteksi sebelum frame berikutnya", async () => {
    const clock = new FakeClock();
    const { diagnostics, host } = await runStep(
      (request) => ({
        progress: [
          { type: "progress", at: "evaluate", edge: "start" },
          { type: "progress", at: "evaluate", edge: "end" },
          { type: "progress", at: 0, edge: "start" },
          { type: "progress", at: 0, edge: "end" },
          () => clock.advance(contract.limits.verifier_deadline_ms),
          { type: "progress", at: 7, edge: "start" },
        ],
        // Hasil ini TIDAK boleh sampai ke langkah: deadline mendahuluinya.
        outcome: resultScript({ perFrame: { 29: sane("", 3) } })(request).outcome,
      }),
      { clock },
    );
    expect(diagnostics).toEqual([DEADLINE]);
    expect(host.requests).toHaveLength(1);
  });

  it("deadline yang lewat setelah progress bertepi end tidak menghentikan hasil yang sudah ada", async () => {
    const clock = new FakeClock();
    const { diagnostics } = await runStep(
      (request) => ({
        progress: [
          { type: "progress", at: 29, edge: "start" },
          { type: "progress", at: 29, edge: "end" },
          () => clock.advance(contract.limits.verifier_deadline_ms),
        ],
        outcome: resultScript()(request).outcome,
      }),
      { clock },
    );
    expect(diagnostics).toEqual([]);
  });
});

// ---- tidak ada path, durasi, atau id; satu temuan per kode dan frame ----

describe("langkah 6: bentuk Diagnostic (Requirement 9.12, 6.12, 6.17)", () => {
  const scenarios: Array<[string, Script]> = [
    ["evaluasi gagal", resultScript({ result: { evaluateError: "TypeError: /home/u/main.js:3 took 1500ms" } })],
    ["frame bergalat", resultScript({ perFrame: { 0: { error: "Error: C:\\x\\y.js boom 120 ms" } } })],
    ["semua pemeriksaan frame", resultScript({
      result: { console: { error: 1, warn: 1 } },
      perFrame: { 0: sane("", 3), 7: sane("x", 700), 15: { ...sane(), secondHtml: "<z>" }, 29: sane("", 5) },
    })],
    ["meta", resultScript({ result: { metaMatches: false } })],
    ["timeout", outcomeScript({ kind: "frame_timeout", at: 22 })],
    ["memori", outcomeScript({ kind: "resource_limit" })],
    ["deadline", outcomeScript({ kind: "deadline" })],
    ["failure", outcomeScript({ kind: "failure" })],
  ];

  it.each(scenarios)("%s: pesan pendek tanpa path, durasi, atau posisi", async (_name, script) => {
    const { diagnostics } = await runStep(script);
    expect(diagnostics.length).toBeGreaterThan(0);
    for (const d of diagnostics) {
      expect(d.message.length).toBeLessThanOrEqual(contract.limits.diagnostic_message_max_chars);
      expect(d.message).not.toMatch(/[\\/]|\d\s?m?s\b/);
      expect(d).not.toHaveProperty("line");
      expect(d).not.toHaveProperty("column");
      expect(d.code).toMatch(contract.diagnosticCodeRegex);
    }
  });

  it("paling banyak satu Diagnostic per kode dan per frame", async () => {
    const { diagnostics } = await runStep(
      resultScript({
        result: { console: { error: 5, warn: 5 } },
        perFrame: {
          0: sane("", 3),
          7: { ...sane("x", 9000), secondHtml: "<z>" },
          15: { error: "Error: a" },
          22: sane("", 3),
          29: sane("", 3),
        },
      }),
    );
    const keys = diagnostics.map((d) => `${d.code}|${/frame=(\S+)/.exec(d.message)?.[1] ?? ""}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual([
      "RENDER_CONSOLE_ERROR|",
      "RENDER_CONSOLE_WARN|",
      "RENDER_DOM_LIMIT|7",
      "RENDER_EMPTY|0",
      "RENDER_EMPTY|22",
      "RENDER_EMPTY|29",
      "RENDER_EXCEPTION|15",
      "RENDER_NONDETERMINISTIC|7",
    ]);
  });

  it("deterministik: dua kali jalan memberi Diagnostic identik", async () => {
    const spec = resultScript({ perFrame: { 0: sane("", 3), 15: { error: "Error: a" } } });
    expect((await runStep(spec)).diagnostics).toEqual((await runStep(spec)).diagnostics);
  });
});

// ---- registri ----

describe("langkah 6: registri", () => {
  it("DEFAULT_STEPS memuat renderStep sebagai langkah bernomor 6, dan registri tetap valid", () => {
    expect(renderStep.number).toBe(6);
    expect(DEFAULT_STEPS.find((step) => step.number === 6)).toBe(renderStep);
    expect(indexSteps(DEFAULT_STEPS).ok).toBe(true);
  });
});

// ---- di dalam verify() ----

describe("langkah 6 di dalam verify() (Requirement 9.14, 9.10, 6.7)", () => {
  const EVENT = {
    source: "unused",
    kind: "lesson",
    required_tokens: [],
    forbidden_tokens: [],
    contract_version: contract.contract_version,
  };

  const pass = (number: 1 | 2 | 3 | 4 | 7): VerifierStep => ({ number, run: () => ({ diagnostics: [] }) });
  const bundleStep: VerifierStep = {
    number: 5,
    run(context) {
      context.artifacts.set(BUNDLE_ARTIFACT, "BUNDLE");
      context.artifacts.set(META_ARTIFACT, META);
      return { diagnostics: [] };
    },
  };
  const pipeline = (host: RenderHost): readonly VerifierStep[] => {
    return [pass(1), pass(2), pass(3), pass(4), bundleStep, createRenderStep(host), pass(7)];
  };

  it("RENDER_CONSOLE_WARN memberi ok true, tetap menyertakan bundle dan meta, dan langkah render ok", async () => {
    const result = await verify(EVENT, {
      clock: new FakeClock(),
      contract,
      steps: pipeline(new FakeRenderHost(resultScript({ result: { console: { error: 0, warn: 2 } } }))),
    });
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([
      diagnostic("RENDER_CONSOLE_WARN", "console.warn was called during render", "warning"),
    ]);
    if (result.ok) {
      expect(result.bundle).toBe("BUNDLE");
      expect(result.meta).toEqual(META);
    }
    expect(result.summary.checks.map((check) => check.name)).toEqual([
      "size", "policy", "eslint", "tsc", "esbuild", "render", "fidelity",
    ]);
    expect(result.summary.checks[5]?.ok).toBe(true);
  });

  it("RENDER_META_MISMATCH: ok false tanpa bundle, dan langkah 7 tidak berjalan", async () => {
    const result = await verify(EVENT, {
      clock: new FakeClock(),
      contract,
      steps: pipeline(new FakeRenderHost(resultScript({ result: { metaMatches: false } }))),
    });
    expect(result.ok).toBe(false);
    expect(codes(result.diagnostics)).toEqual(["RENDER_META_MISMATCH"]);
    expect(result).not.toHaveProperty("bundle");
    expect(result.summary.checks.map((check) => check.name)).toEqual([
      "size", "policy", "eslint", "tsc", "esbuild", "render",
    ]);
    expect(result.summary.checks[5]?.ok).toBe(false);
  });

  it("RENDER_NONDETERMINISTIC dan RENDER_CONSOLE_WARN dilaporkan bersama dalam urutan keluaran (kode abjad)", async () => {
    const result = await verify(EVENT, {
      clock: new FakeClock(),
      contract,
      steps: pipeline(
        new FakeRenderHost(
          resultScript({ result: { console: { error: 0, warn: 1 } }, perFrame: { 15: { ...sane(), secondHtml: "<q>" } } }),
        ),
      ),
    });
    expect(result.ok).toBe(false);
    expect(codes(result.diagnostics)).toEqual(["RENDER_CONSOLE_WARN", "RENDER_NONDETERMINISTIC"]);
  });

  it("deadline di tengah langkah 6: VERIFIER_DEADLINE, ok false, dan langkah 7 tidak berjalan", async () => {
    const clock = new FakeClock();
    const host = new FakeRenderHost((request) => ({
      progress: [
        { type: "progress", at: "evaluate", edge: "start" },
        { type: "progress", at: "evaluate", edge: "end" },
        () => clock.advance(contract.limits.verifier_deadline_ms),
        { type: "progress", at: 0, edge: "start" },
      ],
      outcome: resultScript()(request).outcome,
    }));
    const result = await verify(EVENT, { clock, contract, steps: pipeline(host) });
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([DEADLINE]);
    expect(result.summary.checks.map((check) => check.name)).toEqual([
      "size", "policy", "eslint", "tsc", "esbuild", "render",
    ]);
    expect(result.summary.checks[5]?.ok).toBe(false);
  });

  it("langkah 6 tidak berjalan bila langkah 5 melapor galat", async () => {
    const host = new FakeRenderHost(resultScript());
    const failing: VerifierStep = {
      number: 5,
      run: (context) => ({ diagnostics: [context.diagnostic("BUNDLE_FAILED", "error", "nope")] }),
    };
    const result = await verify(EVENT, {
      clock: new FakeClock(),
      contract,
      steps: [pass(1), pass(2), pass(3), pass(4), failing, createRenderStep(host), pass(7)],
    });
    expect(result.ok).toBe(false);
    expect(host.requests).toHaveLength(0);
  });
});

// ---- parseWorkerMessage ----

describe("parseWorkerMessage (batas kepercayaan Worker)", () => {
  const validResult = {
    type: "result",
    metaMatches: true,
    defaultIsFunction: true,
    console: { error: 0, warn: 1 },
    frames: { 0: { html: "<i></i>", text: "", count: 3 } },
    meta: { width: 1280 },
    unknownKey: 1,
  };

  it("menerima progress dan result yang sah, dan membuang kunci tak dikenal", () => {
    expect(parseWorkerMessage({ type: "progress", at: "evaluate", edge: "start" })).toEqual({
      type: "progress",
      at: "evaluate",
      edge: "start",
    });
    expect(parseWorkerMessage({ type: "progress", at: 12, edge: "end" })).toEqual({ type: "progress", at: 12, edge: "end" });
    const parsed = parseWorkerMessage(validResult);
    expect(parsed?.type).toBe("result");
    expect(parsed).not.toHaveProperty("unknownKey");
  });

  it.each([
    ["null", null],
    ["string", "result"],
    ["tipe tak dikenal", { type: "done" }],
    ["at negatif", { type: "progress", at: -1, edge: "start" }],
    ["at pecahan", { type: "progress", at: 1.5, edge: "start" }],
    ["at string lain", { type: "progress", at: "frame", edge: "start" }],
    ["edge tak dikenal", { type: "progress", at: 0, edge: "middle" }],
    ["result tanpa console", { ...validResult, console: undefined }],
    ["result dengan hitungan negatif", { ...validResult, console: { error: -1, warn: 0 } }],
    ["result dengan frame berisi count string", { ...validResult, frames: { 0: { count: "3" } } }],
    ["result dengan metaMatches bukan boolean", { ...validResult, metaMatches: "yes" }],
  ])("menolak %s", (_name, raw) => {
    expect(parseWorkerMessage(raw)).toBeUndefined();
  });
});

// ---- di atas inti Worker nyata (tanpa spawn) ----

/** Host yang menjalankan `runRenderJob` di proses tes: jsdom, React, dan Remotion asli, tanpa Worker. */
const inProcessHost: RenderHost = {
  async run(request) {
    return { kind: "result", result: await runRenderJob(request.job, () => undefined) };
  },
};

async function runReal(bundle: string, options: ContextOptions = {}) {
  const { context } = makeContext({ ...options, bundle });
  const result = await createRenderStep(inProcessHost).run(context);
  return { diagnostics: result.diagnostics, context };
}

describe("langkah 6 di atas inti Worker (jsdom, React, Remotion asli)", () => {
  it("THUMBNAIL_WRAPPER_ELEMENTS sama dengan jumlah elemen kontainer untuk Main yang mengembalikan null", async () => {
    const job: RunMessage = {
      type: "run",
      bundle: handBundle("return null;"),
      frames: [0],
      shim: { allowed_imports: contract.allowed_imports },
      fps: 30,
      width: 1280,
      height: 720,
      staticMeta: META,
    };
    const result = await runRenderJob(job, () => undefined);
    expect(result.frames[0]?.count).toBe(THUMBNAIL_WRAPPER_ELEMENTS);
    expect(result.frames[0]?.text).toBe("");

    const withDiv = await runRenderJob({ ...job, bundle: handBundle('return h("div");') }, () => undefined);
    expect(withDiv.frames[0]?.count).toBe(THUMBNAIL_WRAPPER_ELEMENTS + 1);
  });

  it("Main yang mengembalikan null: RENDER_EMPTY di setiap frame sampel", async () => {
    const { diagnostics } = await runReal(handBundle("return null;"));
    expect(diagnostics.map((d) => d.message)).toEqual(LESSON_FRAMES.map((f) => `frame=${f} rendered no content`));
    expect(new Set(codes(diagnostics))).toEqual(new Set(["RENDER_EMPTY"]));
  });

  it("Main yang hanya menggambar elemen kosong: RENDER_EMPTY hanya di frame terakhir", async () => {
    const { diagnostics } = await runReal(handBundle('return h("div");'));
    expect(diagnostics).toEqual([diagnostic("RENDER_EMPTY", "frame=29 rendered no content")]);
  });

  it("Main yang hanya mengembalikan string: tidak kosong, dan teks masuk ke FRAMES_ARTIFACT", async () => {
    const { diagnostics, context } = await runReal(handBundle('return "just text";'));
    expect(diagnostics).toEqual([]);
    expect(context.artifacts.get(FRAMES_ARTIFACT)?.map((f) => f.frame)).toEqual(LESSON_FRAMES);
    expect(context.artifacts.get(FRAMES_ARTIFACT)?.every((f) => f.text === "just text")).toBe(true);
  });

  it("batas DOM dihitung dari isi kontainer termasuk pembungkus: 600 lolos dan 601 gagal", async () => {
    const tree = (kids: number): string =>
      `const kids = []; for (let i = 0; i < ${kids}; i += 1) kids.push(h("i", { key: i }, i === 0 ? "x" : null)); return h("div", null, kids);`;
    // Isi kontainer = 3 pembungkus + 1 div + `kids` elemen.
    const atLimit = contract.limits.dom_max_elements - THUMBNAIL_WRAPPER_ELEMENTS - 1;
    expect((await runReal(handBundle(tree(atLimit)))).diagnostics).toEqual([]);
    const over = await runReal(handBundle(tree(atLimit + 1)));
    expect(over.diagnostics.map((d) => d.message)).toEqual(
      LESSON_FRAMES.map((f) => `frame=${f} count=${contract.limits.dom_max_elements + 1} exceeds 600 elements`),
    );
  });

  it("console.warn dan console.error dari bundle", async () => {
    const warn = await runReal(handBundle('console.warn("w"); return h("div", null, "x");'));
    expect(warn.diagnostics).toEqual([
      diagnostic("RENDER_CONSOLE_WARN", "console.warn was called during render", "warning"),
    ]);
    const error = await runReal(handBundle('console.error("e"); return h("div", null, "x");'));
    expect(codes(error.diagnostics)).toEqual(["RENDER_CONSOLE_ERROR"]);
  });

  it("exception saat evaluasi, pada satu frame, dan ketidakcocokan meta", async () => {
    const evaluate = await runReal(handBundle("return null;", { top: 'throw new TypeError("top level");' }));
    expect(evaluate.diagnostics).toEqual([diagnostic("RENDER_EXCEPTION", "frame=evaluate render threw TypeError")]);

    const oneFrame = await runReal(
      handBundle('if (R.useCurrentFrame() === 15) throw new RangeError("only here"); return h("div", null, "x");'),
    );
    expect(oneFrame.diagnostics).toEqual([diagnostic("RENDER_EXCEPTION", "frame=15 render threw RangeError")]);

    const mismatch = await runReal(
      handBundle('return h("div", null, "x");', { meta: "{ width: 1280, height: 720, fps: 30, durationInFrames: 31 }" }),
    );
    expect(codes(mismatch.diagnostics)).toEqual(["RENDER_META_MISMATCH"]);
  });

  it("render yang berbeda pada lintasan kedua: RENDER_NONDETERMINISTIC di tiap frame", async () => {
    const { diagnostics } = await runReal(
      handBundle('calls += 1; return h("div", null, "call " + calls);', { top: "let calls = 0;" }),
    );
    expect(diagnostics.map((d) => d.message)).toEqual(
      LESSON_FRAMES.map((f) => `frame=${f} rendered differently on the second pass`),
    );
  });

  describe("fixtures/good", () => {
    const fixtures = loadGoodFixtures();

    it("memuat sedikitnya 8 fixture", () => {
      expect(fixtures.length).toBeGreaterThanOrEqual(8);
    });

    it.each(fixtures.map((fixture) => [fixture.name, fixture] as const))(
      "%s lolos langkah 6 tanpa temuan, dan teks semua frame sampel masuk ke FRAMES_ARTIFACT",
      async (_name, fixture) => {
        const { diagnostics, context } = await runReal(await esbuildBundle(fixture.source), {
          kind: fixture.kind,
          meta: fixture.meta,
        });
        expect(diagnostics).toEqual([]);
        const frames = context.artifacts.get(FRAMES_ARTIFACT);
        expect(frames?.map((f) => f.frame)).toEqual(
          sampleFrames(fixture.meta.durationInFrames, fixture.meta.pauseAtFrame, fixture.kind),
        );
        expect(frames?.at(-1)?.text.trim().length).toBeGreaterThan(0);
      },
    );
  });
});
