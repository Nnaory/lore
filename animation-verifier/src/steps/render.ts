// Langkah 6 pipeline verifier: uji render (design 5.9, 5.11, 5.12; Requirement 9.2, 9.4 sampai 9.10,
// 9.12 sampai 9.14, 11.3, 11.7, 11.8, 11.9, 6.7, 6.12, 6.17).
// Sisi Worker ada di `render-core.ts` dan sisi induk Worker (watchdog, RSS, terminate) di
// `render-host.ts`. Berkas ini adalah penerjemah: ia memilih frame sampel, menyerahkan bundle ke
// `RenderHost`, lalu mengubah `RenderOutcome` menjadi Diagnostic `RENDER_*` menurut tabel 5.12.
// Langkah ini membawa `RenderHost`-nya sendiri (`createRenderStep(host)`); `renderStep` yang
// terdaftar di registri memakai host nyata, dan tes menyuntikkan `FakeRenderHost`.
//
// Aturan penerjemahan (hasil `result`, urutan pemeriksaan):
//   1. `evaluateError` berawalan "verifier setup failed:" adalah kegagalan lingkungan (jsdom atau shim
//      tak bisa dibangun), bukan salah pengarang: `VERIFIER_INTERNAL`, tanpa Diagnostic lain.
//   2. `console.error` dan `console.warn` selama render: `RENDER_CONSOLE_ERROR` (error) dan
//      `RENDER_CONSOLE_WARN` (warning; tidak mengubah `ok`). Dilaporkan juga bila langkah gagal di bawah.
//   3. `evaluateError` lain: `RENDER_EXCEPTION frame=evaluate`, tanpa frame.
//   4. `meta` tak sama dengan meta statis, atau ekspor default bukan fungsi: `RENDER_META_MISMATCH`.
//   5. Per frame sampel menurut urutan naik: frame bergalat hanya melapor `RENDER_EXCEPTION`
//      (`RENDER_NONDETERMINISTIC` dan sisanya dilewati, Requirement 9.11). Frame sehat diperiksa untuk
//      `RENDER_DOM_LIMIT` (jumlah elemen > `dom_max_elements`), `RENDER_EMPTY`, dan
//      `RENDER_NONDETERMINISTIC` (HTML lintasan kedua berbeda).
//   Hasil bukan `result`: `RENDER_FRAME_TIMEOUT` (`frame=<n|evaluate>`), `RENDER_RESOURCE_LIMIT`,
//   `VERIFIER_DEADLINE`, atau `VERIFIER_INTERNAL` untuk `failure`, host yang melempar, artefak yang
//   hilang, dan frame yang diminta tetapi tidak ada di hasil (pipeline gagal tertutup).
// Paling banyak satu Diagnostic per kode dan per frame, tanpa `line`, dan pesan hanya memuat nomor
// frame, jumlah elemen, dan nama galat: tanpa path, durasi, atau id invokasi (Requirement 6.12).
//
// `RENDER_EMPTY` (keputusan tugas 6.2): `Thumbnail` selalu membungkus keluaran `Main` dengan tepat
// tiga elemen (`THUMBNAIL_WRAPPER_ELEMENTS`, dikunci tes terhadap Worker asli), jadi `count` tidak
// pernah 0. Sebuah frame dianggap kosong bila tidak punya teks (setelah `trim`) dan keluaran `Main`
// tidak menambah elemen (`count <= 3`, mis. `null` atau Fragment kosong); khusus frame terakhir cukup
// tanpa teks, sekalipun `Main` menggambar elemen. `Main` yang hanya mengembalikan string tetap punya
// `count` 3 tetapi punya teks, jadi tidak kosong. `RENDER_DOM_LIMIT` memakai `count` apa adanya
// (isi kontainer `#root` termasuk tiga pembungkus, sesuai design 5.9), bukan `count - 3`.
//
// Langkah ini juga menaruh teks mentah tiap frame sampel di `FRAMES_ARTIFACT` untuk langkah 7
// (kesetiaan data), hanya bila langkah 6 tanpa galat (langkah 7 tidak berjalan sebaliknya);
// normalisasi dan pencocokan token adalah urusan langkah 7.

import type { Diagnostic, Kind } from "../types.js";
import type { FrameCapture, ResultMessage, RunMessage } from "./render-core.js";
import {
  createWorkerRenderHost,
  type RenderHost,
  type RenderOutcome,
  type RenderRequest,
} from "./render-host.js";
import {
  BUNDLE_ARTIFACT,
  META_ARTIFACT,
  artifactKey,
  type StepContext,
  type StepResult,
  type VerifierStep,
} from "./step.js";

export { FakeRenderHost, createWorkerRenderHost } from "./render-host.js";
export type {
  FakeRenderScript,
  RenderHost,
  RenderLimits,
  RenderOutcome,
  RenderRequest,
  WorkerRenderHostOptions,
} from "./render-host.js";

// ---- artefak untuk langkah 7 ----

/** Teks mentah (aturan 5.11, belum dinormalisasi) satu frame sampel. */
export interface RenderedFrame {
  readonly frame: number;
  readonly text: string;
}

/** Semua frame sampel, terurut naik. Diisi langkah 6 hanya bila langkah itu tanpa galat. */
export const FRAMES_ARTIFACT = artifactKey<readonly RenderedFrame[]>("frames");

// ---- sampel frame ----

/**
 * Himpunan frame sampel (design 5.9; Requirement 9.2, 9.13): `{0, floor(d/4), floor(d/2),
 * floor(3d/4), d-1}` ditambah `{p}` bila ada, dan untuk `puzzle` juga `{floor(p/2), p-1}`. Terurut
 * naik, tanpa duplikat, dan hanya bilangan bulat di `[0, d-1]` (masukan di luar itu dibuang, bukan
 * dirender). `kind` yang tidak diberikan dianggap `puzzle` bila `p` ada, sesuai langkah 2 yang
 * mewajibkan `pauseAtFrame` untuk `puzzle` dan melarangnya untuk `lesson`.
 */
export function sampleFrames(d: number, p?: number, kind?: Kind): number[] {
  const last = d - 1;
  const puzzle = (kind ?? (p === undefined ? "lesson" : "puzzle")) === "puzzle";
  const candidates = [0, Math.floor(d / 4), Math.floor(d / 2), Math.floor((3 * d) / 4), last];
  if (p !== undefined) {
    candidates.push(p);
    if (puzzle) candidates.push(Math.floor(p / 2), p - 1);
  }
  return candidates
    .filter((frame) => Number.isInteger(frame) && frame >= 0 && frame <= last)
    .sort((a, b) => a - b)
    .filter((frame, index, sorted) => index === 0 || frame !== sorted[index - 1]);
}

// ---- terjemahan ----

/**
 * Jumlah elemen pembungkus `Thumbnail` di dalam `#root` (tiga `div`: bingkai, lapisan, dan
 * `.__remotion-player`). Terukur pada `@remotion/player` yang dipin; tes menjaganya terhadap
 * Worker asli, sehingga kenaikan versi yang mengubahnya gagal dengan jelas, bukan diam-diam.
 */
export const THUMBNAIL_WRAPPER_ELEMENTS = 3;

/** Awalan `evaluateError` untuk kegagalan lingkungan Worker (lihat `render-core.ts`, `runRenderJob`). */
const SETUP_FAILURE_PREFIX = "verifier setup failed:";

const NAME_PATTERN = /^([A-Za-z_$][\w$]{0,39}):/u;
const FALLBACK_ERROR_NAME = "Error";

const INTERNAL_MESSAGE = "internal verifier error";
const DEADLINE_MESSAGE = "verification deadline reached";

/**
 * Nama galat dari ringkasan Worker ("TypeError: x is not a function"). Hanya nama yang dipakai,
 * bukan pesannya, sesuai templat 5.12; deskripsi tanpa nama (nilai non-Error) menjadi `Error`.
 */
export function errorNameOf(description: string): string {
  return NAME_PATTERN.exec(description)?.[1] ?? FALLBACK_ERROR_NAME;
}

/** Pengumpul Diagnostic satu invokasi; severity ditetapkan oleh nama metode, kode oleh pemanggil. */
class Findings {
  readonly diagnostics: Diagnostic[] = [];
  private readonly context: StepContext;

  constructor(context: StepContext) {
    this.context = context;
  }

  error(code: string, message: string): void {
    this.diagnostics.push(this.context.diagnostic(code, "error", message));
  }

  warning(code: string, message: string): void {
    this.diagnostics.push(this.context.diagnostic(code, "warning", message));
  }
}

function internalFailure(context: StepContext): StepResult {
  return { diagnostics: [context.diagnostic("VERIFIER_INTERNAL", "error", INTERNAL_MESSAGE)] };
}

function hasText(text: string | undefined): boolean {
  return text !== undefined && text.trim().length > 0;
}

/** Memeriksa satu frame yang berhasil dirender: batas DOM, kekosongan, dan determinisme. */
function checkFrame(
  findings: Findings,
  frame: number,
  capture: FrameCapture,
  isLast: boolean,
  domMax: number,
): void {
  const count = capture.count ?? 0;
  if (count > domMax) {
    findings.error("RENDER_DOM_LIMIT", `frame=${frame} count=${count} exceeds ${domMax} elements`);
  }
  const addsElements = count > THUMBNAIL_WRAPPER_ELEMENTS;
  if (!hasText(capture.text) && (isLast || !addsElements)) {
    findings.error("RENDER_EMPTY", `frame=${frame} rendered no content`);
  }
  if (
    capture.html !== undefined &&
    capture.secondHtml !== undefined &&
    capture.secondHtml !== capture.html
  ) {
    findings.error("RENDER_NONDETERMINISTIC", `frame=${frame} rendered differently on the second pass`);
  }
}

/** Menerjemahkan pesan `result` Worker; hasil yang tak dapat dipercaya menjadi `VERIFIER_INTERNAL`. */
function translateResult(
  context: StepContext,
  job: RunMessage,
  result: ResultMessage,
): StepResult {
  if (result.evaluateError?.startsWith(SETUP_FAILURE_PREFIX) === true) return internalFailure(context);

  const findings = new Findings(context);
  if (result.console.error > 0) {
    findings.error("RENDER_CONSOLE_ERROR", "console.error was called during render");
  }
  if (result.console.warn > 0) {
    findings.warning("RENDER_CONSOLE_WARN", "console.warn was called during render");
  }

  if (result.evaluateError !== undefined) {
    findings.error("RENDER_EXCEPTION", `frame=evaluate render threw ${errorNameOf(result.evaluateError)}`);
    return { diagnostics: findings.diagnostics };
  }
  if (!result.metaMatches || !result.defaultIsFunction) {
    findings.error(
      "RENDER_META_MISMATCH",
      "executed meta differs from the static meta, or default export is not a function",
    );
    return { diagnostics: findings.diagnostics };
  }

  const last = job.staticMeta.durationInFrames - 1;
  const domMax = context.contract.limits.dom_max_elements;
  const rendered: Array<{ frame: number; text: string }> = [];
  for (const frame of job.frames) {
    const capture = result.frames[frame];
    if (capture === undefined) return internalFailure(context);
    if (capture.error !== undefined) {
      findings.error("RENDER_EXCEPTION", `frame=${frame} render threw ${errorNameOf(capture.error)}`);
      continue;
    }
    checkFrame(findings, frame, capture, frame === last, domMax);
    rendered.push({ frame, text: capture.text ?? "" });
  }
  if (!findings.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    context.artifacts.set(FRAMES_ARTIFACT, rendered);
  }
  return { diagnostics: findings.diagnostics };
}

function translateOutcome(
  context: StepContext,
  job: RunMessage,
  outcome: RenderOutcome,
): StepResult {
  switch (outcome.kind) {
    case "result":
      return translateResult(context, job, outcome.result);
    case "frame_timeout":
      return {
        diagnostics: [
          context.diagnostic(
            "RENDER_FRAME_TIMEOUT",
            "error",
            `frame=${outcome.at} did not finish in time`,
          ),
        ],
      };
    case "resource_limit":
      return {
        diagnostics: [context.diagnostic("RENDER_RESOURCE_LIMIT", "error", "memory limit reached")],
      };
    case "deadline":
      return deadlineResult(context);
    case "failure":
      return internalFailure(context);
  }
}

function deadlineResult(context: StepContext): StepResult {
  return { diagnostics: [context.diagnostic("VERIFIER_DEADLINE", "error", DEADLINE_MESSAGE)] };
}

// ---- langkah ----

/** Hanya nama dan `values`: itulah yang dibaca shim, dan Worker tidak perlu `types`. */
function shimSpecOf(context: StepContext): RunMessage["shim"] {
  const allowed: Record<string, { values: string[] }> = {};
  for (const [id, entry] of Object.entries(context.contract.allowed_imports)) {
    allowed[id] = { values: [...entry.values] };
  }
  return { allowed_imports: allowed };
}

/** Membuat langkah 6 di atas `host`. Satu host dipakai berulang; Worker baru dibuat per `run`. */
export function createRenderStep(host: RenderHost): VerifierStep {
  return {
    number: 6,
    async run(context) {
      const meta = context.artifacts.get(META_ARTIFACT);
      const bundle = context.artifacts.get(BUNDLE_ARTIFACT);
      if (meta === undefined || bundle === undefined) return internalFailure(context);
      if (context.clock.now() >= context.deadlineAt) return deadlineResult(context);

      const frames = sampleFrames(meta.durationInFrames, meta.pauseAtFrame, context.input.kind);
      if (frames.length === 0) return internalFailure(context);

      const job: RunMessage = {
        type: "run",
        bundle,
        frames,
        shim: shimSpecOf(context),
        fps: meta.fps,
        width: meta.width,
        height: meta.height,
        staticMeta: { ...meta },
      };
      const { limits } = context.contract;
      const request: RenderRequest = {
        job,
        limits: {
          frame_timeout_ms: limits.frame_timeout_ms,
          rss_limit_mb: limits.rss_limit_mb,
          worker_heap_mb: limits.worker_heap_mb,
        },
        remainingMs: Math.max(0, context.deadlineAt - context.clock.now()),
        deadlineReached: () => context.clock.now() >= context.deadlineAt,
      };

      let outcome: RenderOutcome;
      try {
        outcome = await host.run(request);
      } catch {
        return internalFailure(context);
      }
      return translateOutcome(context, job, outcome);
    },
  };
}

/** Langkah 6 produksi: host nyata, Worker dari `render-worker.js` di sebelah modul ini. */
export const renderStep: VerifierStep = createRenderStep(createWorkerRenderHost());
