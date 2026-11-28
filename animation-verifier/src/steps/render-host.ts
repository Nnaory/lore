// Sisi induk Worker render untuk langkah 6 (design 5.9 "Protokol induk dan Worker"; Requirement
// 9.4, 9.9, 9.10, 11.1, 11.3, 11.7, 11.8, 11.9, 11.11).
// `RenderHost` adalah satu-satunya hal yang diketahui langkah 6 (`render.ts`) tentang Worker: ia
// menerima `RenderRequest` dan mengembalikan `RenderOutcome`, tidak pernah menolak (reject).
// Implementasi nyata (`createWorkerRenderHost`) membuat Worker BARU per invokasi, sehingga Worker dan
// konteks `vm` tidak pernah dipakai ulang (Requirement 11.7):
//   - `new Worker(url, { resourceLimits, env: {}, stdout: true, stderr: true })`; `stdout` dan
//     `stderr` Worker dikuras dan dibuang, jadi satu byte pun tidak mencapai stdout proses (11.11);
//   - watchdog `frame_timeout_ms` (2000 ms) yang dipasang pada pesan `progress` pertama
//     (`evaluate:start`, bukan saat spawn: pembuatan jsdom dan pemuatan modul tidak dihitung, 9.9) dan
//     di-reset oleh tiap `progress`; bila habis, Worker dimatikan dan hasilnya `frame_timeout` dengan
//     frame yang sedang berjalan (`evaluate` atau nomor frame);
//   - pemeriksa RSS tiap 50 ms (`rss_limit_mb`), dan galat `ERR_WORKER_OUT_OF_MEMORY` dari Worker:
//     keduanya `resource_limit` (11.3, 11.9);
//   - timer deadline total dan pemeriksaan `deadlineReached()` pada setiap `progress` bertepi `start`
//     (sebelum tiap frame, 9.10): keduanya `deadline`;
//   - setelah keputusan apa pun (termasuk `result`, karena Worker tidak menutup port sendiri) Worker
//     dihentikan dengan `terminate()` dan hasil dikembalikan paling lambat 1000 ms sejak keputusan (11.7).
// Pesan dari Worker divalidasi dengan Zod: Worker menjalankan kode pengarang di thread lain, jadi
// pesannya adalah batas kepercayaan. Pesan yang rusak menjadi `failure` (galat internal), bukan
// kesalahan pengarang. Semua callback timer dan event dibungkus agar exception tidak pernah menjadi
// uncaught exception yang mematikan proses Lambda.
// Lokasi Worker: `render-worker.js` HASIL `tsc` di sebelah modul ini (`dist/steps/`). Worker tidak bisa
// menjalankan `.ts`, jadi saat modul ini dimuat dari `src/` (tes) berkas itu tidak ada dan hasilnya
// `failure`; tes nyata mengompilasi Worker ke direktori sementara dan memberi `workerUrl` (lihat
// `tests/support/compile-render-worker.ts`).

import { Worker } from "node:worker_threads";
import { z } from "zod";
import type { Contract } from "../contract.js";
import type { FromWorker, ProgressMessage, ResultMessage, RunMessage } from "./render-core.js";

// ---- antarmuka ----

/** Batas dari kontrak yang dibaca host (`limits` pada `animation-contract.json`). */
export type RenderLimits = Pick<
  Contract["limits"],
  "frame_timeout_ms" | "rss_limit_mb" | "worker_heap_mb"
>;

export interface RenderRequest {
  readonly job: RunMessage;
  readonly limits: RenderLimits;
  /** Milidetik sampai deadline total; host mematikan Worker saat habis. Tak hingga berarti tanpa timer. */
  readonly remainingMs: number;
  /** Dibaca host pada setiap `progress` bertepi `start`; true bila deadline total sudah lewat. */
  deadlineReached(): boolean;
}

/**
 * Hasil satu pekerjaan. Hanya `result` yang membawa data frame; semua yang lain berarti Worker
 * dihentikan sebelum selesai dan tidak ada frame yang dapat dipercaya.
 */
export type RenderOutcome =
  | { kind: "result"; result: ResultMessage }
  /** Tidak ada `progress` selama `frame_timeout_ms`; `at` adalah frame (atau `evaluate`) yang berjalan. */
  | { kind: "frame_timeout"; at: "evaluate" | number }
  /** RSS melewati batas, atau Worker melaporkan `ERR_WORKER_OUT_OF_MEMORY`. */
  | { kind: "resource_limit" }
  /** Deadline total habis. */
  | { kind: "deadline" }
  /** Galat infrastruktur: Worker gagal start, keluar tanpa hasil, atau mengirim pesan rusak. */
  | { kind: "failure" };

export interface RenderHost {
  /** Total: tidak pernah menolak. */
  run(request: RenderRequest): Promise<RenderOutcome>;
}

// ---- pesan Worker ----

const ProgressSchema = z.object({
  type: z.literal("progress"),
  at: z.union([z.literal("evaluate"), z.number().int().min(0)]),
  edge: z.enum(["start", "end"]),
});

const FrameCaptureSchema = z.object({
  error: z.string().optional(),
  html: z.string().optional(),
  text: z.string().optional(),
  count: z.number().int().min(0).optional(),
  secondHtml: z.string().optional(),
});

const ResultSchema = z.object({
  type: z.literal("result"),
  evaluateError: z.string().optional(),
  meta: z.unknown().optional(),
  metaMatches: z.boolean(),
  defaultIsFunction: z.boolean(),
  console: z.object({ error: z.number().int().min(0), warn: z.number().int().min(0) }),
  frames: z.record(FrameCaptureSchema),
});

const FromWorkerSchema = z.discriminatedUnion("type", [ProgressSchema, ResultSchema]);

/** Total: pesan apa pun menjadi pesan sah atau `undefined`. */
export function parseWorkerMessage(raw: unknown): FromWorker | undefined {
  try {
    const parsed = FromWorkerSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

// ---- host nyata ----

/** Dua batas heap lain dan stack yang tidak ada di kontrak; nilai heap tua datang dari `worker_heap_mb`. */
const MAX_YOUNG_GENERATION_MB = 64;
const STACK_SIZE_MB = 4;

/** Selang pemeriksa RSS (Requirement 11.9). */
export const RSS_POLL_MS = 50;

/** Batas waktu antara keputusan menghentikan Worker dan hasil dikembalikan (Requirement 11.7). */
export const TERMINATE_GRACE_MS = 1000;

/** `setTimeout` mengubah nilai di atas ini menjadi 1 ms; waktu sisa sebesar itu setara tanpa timer. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const BYTES_PER_MB = 1024 * 1024;

/** `render-worker.js` di sebelah modul ini: `dist/steps/` pada image Lambda. */
export const DEFAULT_WORKER_URL = new URL("./render-worker.js", import.meta.url);

export interface WorkerRenderHostOptions {
  /** Berkas `render-worker.js` hasil `tsc`. Bawaan: `DEFAULT_WORKER_URL`. */
  readonly workerUrl?: URL;
  /** RSS proses dalam byte. Bawaan `process.memoryUsage.rss()`; tes menyuntikkan nilai tetap. */
  readonly readRssBytes?: () => number;
}

function isOutOfMemory(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ERR_WORKER_OUT_OF_MEMORY"
  );
}

/** Menghentikan Worker; selesai saat `terminate()` selesai atau setelah `TERMINATE_GRACE_MS`, mana yang lebih dulu. */
function stopWorker(worker: Worker | undefined): Promise<void> {
  if (worker === undefined) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const grace = setTimeout(resolve, TERMINATE_GRACE_MS);
    const done = (): void => {
      clearTimeout(grace);
      resolve();
    };
    try {
      worker.terminate().then(done, done);
    } catch {
      done();
    }
  });
}

function runInWorker(
  workerUrl: URL,
  readRssBytes: () => number,
  request: RenderRequest,
): Promise<RenderOutcome> {
  return new Promise<RenderOutcome>((resolve) => {
    const { limits } = request;
    const rssLimitBytes = limits.rss_limit_mb * BYTES_PER_MB;
    let worker: Worker | undefined;
    let settled = false;
    let current: "evaluate" | number = "evaluate";
    let watchdog: NodeJS.Timeout | undefined;
    let rssTimer: NodeJS.Timeout | undefined;
    let deadlineTimer: NodeJS.Timeout | undefined;

    /** Keputusan pertama menang; sisanya diabaikan. Worker dihentikan sebelum hasil dikembalikan. */
    const settle = (outcome: RenderOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      clearInterval(rssTimer);
      clearTimeout(deadlineTimer);
      void stopWorker(worker).then(() => resolve(outcome));
    };

    /** Callback timer dan event tidak boleh melempar: itu akan menjadi uncaught exception. */
    const guarded =
      <Args extends unknown[]>(action: (...args: Args) => void) =>
      (...args: Args): void => {
        try {
          action(...args);
        } catch {
          settle({ kind: "failure" });
        }
      };

    const armWatchdog = (): void => {
      clearTimeout(watchdog);
      watchdog = setTimeout(
        guarded(() => settle({ kind: "frame_timeout", at: current })),
        limits.frame_timeout_ms,
      );
    };

    const onProgress = (message: ProgressMessage): void => {
      current = message.at;
      armWatchdog();
      if (message.edge === "start" && request.deadlineReached()) settle({ kind: "deadline" });
    };

    const onMessage = guarded((raw: unknown): void => {
      if (settled) return;
      const message = parseWorkerMessage(raw);
      if (message === undefined) settle({ kind: "failure" });
      else if (message.type === "result") settle({ kind: "result", result: message });
      else onProgress(message);
    });

    try {
      worker = new Worker(workerUrl, {
        resourceLimits: {
          maxOldGenerationSizeMb: limits.worker_heap_mb,
          maxYoungGenerationSizeMb: MAX_YOUNG_GENERATION_MB,
          stackSizeMb: STACK_SIZE_MB,
        },
        env: {},
        execArgv: [],
        stdout: true,
        stderr: true,
      });
      worker.stdout.resume();
      worker.stderr.resume();
      worker.on("message", onMessage);
      worker.on("error", guarded((error: unknown) => {
        settle(isOutOfMemory(error) ? { kind: "resource_limit" } : { kind: "failure" });
      }));
      worker.on("exit", guarded(() => settle({ kind: "failure" })));

      rssTimer = setInterval(
        guarded(() => {
          if (readRssBytes() > rssLimitBytes) settle({ kind: "resource_limit" });
        }),
        RSS_POLL_MS,
      );
      if (Number.isFinite(request.remainingMs) && request.remainingMs < MAX_TIMER_MS) {
        deadlineTimer = setTimeout(
          guarded(() => settle({ kind: "deadline" })),
          Math.max(0, request.remainingMs),
        );
      }
      worker.postMessage(request.job);
    } catch {
      settle({ kind: "failure" });
    }
  });
}

/** Host produksi. Tidak membuat Worker sampai `run` dipanggil, jadi aman dibuat saat modul dimuat. */
export function createWorkerRenderHost(options: WorkerRenderHostOptions = {}): RenderHost {
  const workerUrl = options.workerUrl ?? DEFAULT_WORKER_URL;
  const readRssBytes = options.readRssBytes ?? ((): number => process.memoryUsage.rss());
  return { run: (request) => runInWorker(workerUrl, readRssBytes, request) };
}

// ---- host palsu untuk tes ----

/** Satu skenario: pesan `progress` (atau aksi di antaranya, mis. memajukan `FakeClock`) lalu hasil. */
export interface FakeRenderScript {
  readonly progress?: ReadonlyArray<ProgressMessage | (() => void)>;
  readonly outcome: RenderOutcome;
}

/**
 * Pengganti `RenderHost` tanpa Worker. Skenario dijalankan menurut urutan: tiap fungsi dipanggil,
 * dan tiap `progress` bertepi `start` menanyakan `deadlineReached()` persis seperti host nyata, jadi
 * tes deadline tengah langkah mengisi skenario dengan aksi yang memajukan jam di antara dua frame.
 * Semua permintaan yang diterima dicatat di `requests`.
 */
export class FakeRenderHost implements RenderHost {
  readonly requests: RenderRequest[] = [];
  private readonly script: FakeRenderScript | ((request: RenderRequest, index: number) => FakeRenderScript);

  constructor(script: FakeRenderScript | ((request: RenderRequest, index: number) => FakeRenderScript)) {
    this.script = script;
  }

  run(request: RenderRequest): Promise<RenderOutcome> {
    const index = this.requests.length;
    this.requests.push(request);
    const script = typeof this.script === "function" ? this.script(request, index) : this.script;
    for (const item of script.progress ?? []) {
      if (typeof item === "function") {
        item();
      } else if (item.edge === "start" && request.deadlineReached()) {
        return Promise.resolve({ kind: "deadline" });
      }
    }
    return Promise.resolve(script.outcome);
  }
}
