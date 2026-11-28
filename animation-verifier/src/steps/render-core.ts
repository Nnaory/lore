// Inti Worker langkah 6, uji render (design 5.9 "Di dalam Worker", 5.11, D-14; Requirement 9, 11).
// Fungsi `runRenderJob` tidak menyentuh `worker_threads`, sehingga tes memanggilnya langsung tanpa
// spawn; berkas `render-worker.ts` hanya memasangnya ke `parentPort`. Sisi induk (watchdog, RSS,
// `RenderHost`) ada di tugas 6.2 dan memakai tipe protokol di berkas ini lewat `import type`.
//
// Urutan kerja: (1) JSDOM dibuat dan globalnya dipasang, API jaringan dihapus; (2) react,
// react-dom, @remotion/player, dan remotion diimpor SETELAH global ada, karena modul-modul itu
// membaca `window` saat dimuat; (3) console Worker ditangkap; (4) shim `require` dibangun dari
// kontrak; (5) bundle dievaluasi di konteks `vm` tanpa `codeGeneration`; (6) `meta` dibandingkan
// dengan `staticMeta`; (7) tiap frame sampel dirender dengan `Thumbnail` dan `flushSync`;
// (8) lintasan kedua menurun hanya mengambil `innerHTML` untuk uji determinisme.
// Pesan `progress` pertama (`evaluate`/`start`) dikirim setelah langkah 1 sampai 4, jadi waktu
// pembuatan jsdom dan pemuatan modul tidak dihitung watchdog (Requirement 9.9). Setiap frame
// dikabari `start` dan `end` pada kedua lintasan agar lintasan kedua tidak sunyi lebih dari 2000 ms.
// Fungsi ini total: kegagalan apa pun menjadi `evaluateError` atau `frames[n].error`, tidak throw.
// `vm` bukan batas keamanan (Requirement 11.10); batasnya Worker, env kosong, dan isolasi Lambda.

import vm from "node:vm";
import { createRequireShim, type ShimSpec } from "../shim.js";
import type { MainMeta } from "../types.js";

// ---- protokol induk <-> Worker (design 5.9) ----

/** Pesan induk ke Worker. Satu Worker menjalankan satu `run`. */
export interface RunMessage {
  type: "run";
  bundle: string;
  /** Frame sampel, tanpa duplikat; Worker mengurutkan sendiri naik (lintasan 1) dan turun (lintasan 2). */
  frames: number[];
  shim: ShimSpec;
  fps: number;
  width: number;
  height: number;
  staticMeta: MainMeta;
}
export type ToWorker = RunMessage;

export interface ProgressMessage {
  type: "progress";
  at: "evaluate" | number;
  edge: "start" | "end";
}

/** Hasil satu frame. Frame yang bergalat pada lintasan pertama hanya punya `error`. */
export interface FrameCapture {
  error?: string;
  /** `innerHTML` kontainer pada lintasan pertama. */
  html?: string;
  /** Teks mentah menurut aturan 5.11; normalisasi dan pencocokan token urusan langkah 7. */
  text?: string;
  /** `container.querySelectorAll("*").length`, termasuk elemen pembungkus `Thumbnail`. */
  count?: number;
  /** `innerHTML` lintasan kedua (menurun). */
  secondHtml?: string;
}

export interface ResultMessage {
  type: "result";
  /** Galat evaluasi bundle atau persiapan Worker; bila ada, tidak ada frame yang dirender. */
  evaluateError?: string;
  /** Salinan polos `module.exports.meta` (hanya nilai primitif), untuk pesan galat. */
  meta?: unknown;
  /** `meta` deep-equal `staticMeta` (kunci dan nilai persis, tanpa memeriksa prototipe). */
  metaMatches: boolean;
  defaultIsFunction: boolean;
  console: { error: number; warn: number };
  frames: Record<number, FrameCapture>;
}

export type FromWorker = ProgressMessage | ResultMessage;

export function isRunMessage(value: unknown): value is RunMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    m.type === "run" &&
    typeof m.bundle === "string" &&
    Array.isArray(m.frames) &&
    typeof m.fps === "number" &&
    typeof m.width === "number" &&
    typeof m.height === "number" &&
    typeof m.shim === "object" &&
    m.shim !== null &&
    typeof m.staticMeta === "object" &&
    m.staticMeta !== null
  );
}

// ---- ekstraksi teks frame (design 5.11, Requirement 10.8) ----

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/** Subtree elemen ini tidak pernah dihitung sebagai teks yang tampak. */
const SKIPPED_TAGS: ReadonlySet<string> = new Set(["title", "desc", "style", "script"]);

/** Bagian DOM yang dibaca pengambil teks; cukup untuk node jsdom tanpa memerlukan tipe DOM. */
export interface TextNodeLike {
  readonly nodeType: number;
  readonly childNodes: ArrayLike<TextNodeLike>;
  readonly data?: string;
  readonly localName?: string;
  readonly style?: { getPropertyValue(name: string): string };
}

/** Elemen yang style inline-nya `display: none`, `visibility: hidden`, atau `opacity: 0`. */
function isHiddenByInlineStyle(element: TextNodeLike): boolean {
  const style = element.style;
  if (style === undefined) return false;
  const read = (name: string): string => style.getPropertyValue(name).trim().toLowerCase();
  if (read("display") === "none" || read("visibility") === "hidden") return true;
  const opacity = read("opacity");
  return opacity !== "" && Number(opacity) === 0;
}

/**
 * Teks frame mentah: `data` semua node teks di bawah `root` menurut urutan dokumen, tanpa
 * pemisah, melewati subtree `title`, `desc`, `style`, `script` dan elemen yang disembunyikan
 * style inline-nya. Telusuran memakai tumpukan eksplisit supaya DOM yang dalam tidak menghabiskan
 * stack Worker (4 MB). Aturan style berlaku pada setiap elemen, termasuk pembungkus; pembungkus
 * `Thumbnail` tidak boleh menyembunyikan konten, dan itu dijamin oleh `style` yang ditimpa saat
 * render (lihat `renderFrame`), bukan oleh pengecualian di sini.
 */
export function extractFrameText(root: TextNodeLike): string {
  const parts: string[] = [];
  const pending: TextNodeLike[] = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) break;
    if (node.nodeType === TEXT_NODE) {
      parts.push(node.data ?? "");
      continue;
    }
    if (node.nodeType !== ELEMENT_NODE) continue;
    if (SKIPPED_TAGS.has((node.localName ?? "").toLowerCase()) || isHiddenByInlineStyle(node)) continue;
    for (let i = node.childNodes.length - 1; i >= 0; i -= 1) {
      const child = node.childNodes[i];
      if (child !== undefined) pending.push(child);
    }
  }
  return parts.join("");
}

// ---- utilitas ----

const MAX_ERROR_CHARS = 200;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) : flat;
}

/** Ringkasan galat tanpa stack (path mesin tidak boleh bocor) dan tanpa `instanceof` (galat dari konteks `vm` lintas realm). */
function describeError(error: unknown): string {
  try {
    if (typeof error === "object" && error !== null) {
      const { name, message } = error as { name?: unknown; message?: unknown };
      if (typeof message === "string") {
        return clip(`${typeof name === "string" ? name : "Error"}: ${message}`, MAX_ERROR_CHARS);
      }
      return "thrown a non-error object";
    }
    return clip(`thrown ${typeof error}: ${String(error)}`, MAX_ERROR_CHARS);
  } catch {
    return "thrown a value that could not be described";
  }
}

type Namespace = Record<string, unknown>;

/** Impor dinamis dengan id variabel: paket tanpa tipe (jsdom, react-dom) tidak perlu deklarasi ambien. */
function load(id: string): Promise<Namespace> {
  return import(id) as Promise<Namespace>;
}

/** Namespace ESM dan `module.exports` CJS digabung, agar nama bernama terbaca di kedua bentuk impor. */
function flatten(namespace: Namespace): Namespace {
  const merged: Namespace = Object.create(null);
  const fallback = namespace.default;
  if ((typeof fallback === "object" || typeof fallback === "function") && fallback !== null) {
    Object.assign(merged, fallback);
  }
  return Object.assign(merged, namespace);
}

function pickFunction<T extends (...args: never[]) => unknown>(module: Namespace, name: string): T {
  const value = module[name];
  if (typeof value !== "function") throw new Error(`host module is missing function ${name}`);
  return value as T;
}

// ---- console ----

interface ConsoleCounts {
  error: number;
  warn: number;
}

const CAPTURED_METHODS = ["log", "info", "debug", "warn", "error"] as const;

/** Metode console lain dibuat tak-berbuat agar `console.table` dan sejenisnya tidak melempar di bundle. */
const SILENT_METHODS = [
  "trace",
  "dir",
  "dirxml",
  "table",
  "group",
  "groupCollapsed",
  "groupEnd",
  "time",
  "timeEnd",
  "timeLog",
  "count",
  "countReset",
  "assert",
  "clear",
] as const;

/** Menukar lima metode console Worker (dipakai React dan jsdom) dengan penghitung; mengembalikan pemulih. */
function captureHostConsole(counts: ConsoleCounts): () => void {
  const target = console as unknown as Record<string, unknown>;
  const saved = CAPTURED_METHODS.map((method) => [method, target[method]] as const);
  for (const method of CAPTURED_METHODS) {
    target[method] = (): void => {
      if (method === "error") counts.error += 1;
      else if (method === "warn") counts.warn += 1;
    };
  }
  return () => {
    for (const [method, original] of saved) target[method] = original;
  };
}

/** `console` yang dilihat bundle: menghitung `error` dan `warn`, membuang teks, tidak menulis apa pun. */
function createSandboxConsole(counts: ConsoleCounts): Readonly<Record<string, () => void>> {
  const sandboxConsole: Record<string, () => void> = Object.create(null);
  for (const method of CAPTURED_METHODS) {
    sandboxConsole[method] = (): void => {
      if (method === "error") counts.error += 1;
      else if (method === "warn") counts.warn += 1;
    };
  }
  for (const method of SILENT_METHODS) sandboxConsole[method] = (): void => undefined;
  return Object.freeze(sandboxConsole);
}

// ---- jsdom dan global ----

/** API jaringan yang tidak boleh terlihat dari window maupun global (Requirement 11.12). */
const NETWORK_NAMES: ReadonlySet<string> = new Set(["XMLHttpRequest", "WebSocket", "fetch", "EventSource"]);

/** Nama yang dipaksa dari jsdom walau Node punya versinya sendiri (kelas Event Node tidak diterima jsdom). */
const JSDOM_OVERRIDES: ReadonlySet<string> = new Set([
  "window",
  "document",
  "navigator",
  "self",
  "Event",
  "EventTarget",
  "CustomEvent",
  "MessageEvent",
  "ErrorEvent",
]);

function stripNetworkApis(win: Namespace): void {
  for (const name of NETWORK_NAMES) {
    try {
      Reflect.deleteProperty(win, name);
    } catch {
      // Properti yang tidak bisa dihapus tidak disalin ke global (lihat installDomGlobals).
    }
  }
}

/**
 * Memasang properti window yang belum dimiliki `globalThis` (ditambah `JSDOM_OVERRIDES`) sebagai
 * accessor malas, sehingga intrinsik realm jsdom (`Object`, `Array`, ...) tidak menimpa milik
 * Worker dan properti yang melempar (mis. `localStorage`) tidak terbaca sebelum dipakai.
 * Mengembalikan pemulih; tes memanggil inti ini di proses vitest, jadi global harus dikembalikan.
 */
function installDomGlobals(win: Namespace): () => void {
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const key of Object.getOwnPropertyNames(win)) {
    if (NETWORK_NAMES.has(key)) continue;
    const existing = Object.getOwnPropertyDescriptor(globalThis, key);
    if (existing !== undefined && (!JSDOM_OVERRIDES.has(key) || existing.configurable === false)) continue;
    previous.set(key, existing);
    Object.defineProperty(globalThis, key, {
      configurable: true,
      enumerable: false,
      get: () => win[key],
      set: (value: unknown) => {
        Object.defineProperty(globalThis, key, { value, writable: true, configurable: true, enumerable: false });
      },
    });
  }
  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
      else Object.defineProperty(globalThis, key, descriptor);
    }
  };
}

// ---- modul host ----

interface ReactRoot {
  render(node: unknown): void;
  unmount(): void;
}

interface RootOptions {
  onCaughtError(error: unknown): void;
  onUncaughtError(error: unknown): void;
}

interface HostModules {
  react: Namespace;
  remotion: Namespace;
  createElement: (type: unknown, props: unknown) => unknown;
  flushSync: (callback: () => void) => void;
  createRoot: (container: unknown, options: RootOptions) => ReactRoot;
  Thumbnail: unknown;
}

async function loadHostModules(): Promise<HostModules> {
  const react = flatten(await load("react"));
  const reactDom = flatten(await load("react-dom"));
  const client = flatten(await load("react-dom/client"));
  const player = flatten(await load("@remotion/player"));
  const remotion = flatten(await load("remotion"));
  const Thumbnail = player.Thumbnail;
  if (Thumbnail === undefined) throw new Error("host module is missing Thumbnail");
  return {
    react,
    remotion,
    createElement: pickFunction(react, "createElement"),
    flushSync: pickFunction(reactDom, "flushSync"),
    createRoot: pickFunction(client, "createRoot"),
    Thumbnail,
  };
}

interface ContainerLike extends TextNodeLike {
  readonly innerHTML: string;
  querySelectorAll(selector: string): { readonly length: number };
}

interface JsdomWindow extends Namespace {
  close(): void;
  readonly document: { getElementById(id: string): ContainerLike | null };
}

interface JsdomModule {
  JSDOM: new (html: string, options: { pretendToBeVisual: boolean; virtualConsole: unknown }) => { window: JsdomWindow };
  VirtualConsole: new () => unknown;
}

const PAGE_HTML = '<!doctype html><div id="root"></div>';

// ---- meta ----

/** Kunci dan nilai persis; prototipe diabaikan karena `meta` berasal dari realm `vm`. */
function metaEquals(actual: unknown, expected: MainMeta): boolean {
  if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return false;
  const want = Object.entries(expected).filter(([, value]) => value !== undefined);
  if (Object.keys(actual).length !== want.length) return false;
  const record = actual as Record<string, unknown>;
  return want.every(([key, value]) => Object.hasOwn(record, key) && record[key] === value);
}

const MAX_META_KEYS = 16;
const MAX_META_STRING = 64;

/** Salinan polos dari realm luar yang aman dikloning `postMessage`: hanya primitif, tanpa fungsi atau getter. */
function snapshotMeta(value: unknown): unknown {
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.slice(0, MAX_META_STRING);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const copy: Record<string, number | boolean | string> = {};
  for (const key of Object.keys(value).slice(0, MAX_META_KEYS)) {
    const entry = (value as Record<string, unknown>)[key];
    if (typeof entry === "number" || typeof entry === "boolean") copy[key.slice(0, MAX_META_STRING)] = entry;
    else if (typeof entry === "string") copy[key.slice(0, MAX_META_STRING)] = entry.slice(0, MAX_META_STRING);
  }
  return copy;
}

// ---- pekerjaan render ----

type Post = (message: ProgressMessage) => void;

/** Keadaan yang `execute` titipkan agar `runRenderJob` dapat membongkar pohon React sebelum global dicabut. */
interface JobState {
  cleanups: Array<() => void>;
  unmount?: () => void;
}

const SETTLE_ROUNDS = 5;

/**
 * Memberi giliran pada tugas terjadwal React (`scheduler` memakai `setImmediate` di Node): setelah
 * commit, React menjadwalkan flush efek pasif yang membaca `window.event`. Tugas itu harus berjalan
 * selagi global jsdom masih terpasang; bila tidak, ia melempar ReferenceError di proses pemanggil.
 */
async function settleScheduler(): Promise<void> {
  for (let round = 0; round < SETTLE_ROUNDS; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function attempt(action: (() => void) | undefined): void {
  try {
    action?.();
  } catch {
    // Pembongkaran best-effort; hasil pekerjaan sudah ada.
  }
}

/**
 * Menjalankan satu pekerjaan render dan mengembalikan pesan `result`. Tidak pernah menolak.
 * `post` menerima pesan `progress`; galat pada `post` ditelan (induk yang menutup port tidak
 * boleh membuat pekerjaan gagal).
 */
export async function runRenderJob(job: RunMessage, post: Post): Promise<ResultMessage> {
  const counts: ConsoleCounts = { error: 0, warn: 0 };
  const result: ResultMessage = {
    type: "result",
    metaMatches: false,
    defaultIsFunction: false,
    console: { error: 0, warn: 0 },
    frames: {},
  };
  const state: JobState = { cleanups: [] };
  const send: Send = (at, edge) => {
    try {
      post({ type: "progress", at, edge });
    } catch {
      // Lihat komentar fungsi.
    }
  };

  try {
    state.cleanups.push(captureHostConsole(counts));
    await execute(job, send, counts, result, state);
  } catch (error) {
    result.evaluateError ??= `verifier setup failed: ${describeError(error)}`;
  } finally {
    attempt(state.unmount);
    await settleScheduler();
    for (const cleanup of state.cleanups.reverse()) attempt(cleanup);
  }

  result.console = { error: counts.error, warn: counts.warn };
  return result;
}

type Send = (at: ProgressMessage["at"], edge: ProgressMessage["edge"]) => void;

async function execute(
  job: RunMessage,
  send: Send,
  counts: ConsoleCounts,
  result: ResultMessage,
  state: JobState,
): Promise<void> {
  // (1) JSDOM, global terpasang, API jaringan dihapus.
  const jsdom = flatten(await load("jsdom")) as unknown as JsdomModule;
  const dom = new jsdom.JSDOM(PAGE_HTML, { pretendToBeVisual: true, virtualConsole: new jsdom.VirtualConsole() });
  state.cleanups.push(() => dom.window.close());
  stripNetworkApis(dom.window);
  state.cleanups.push(installDomGlobals(dom.window));

  // (2) Modul host, diimpor setelah global ada.
  const host = await loadHostModules();

  // (4) Shim `require` dari kontrak; (3) console sudah ditangkap oleh pemanggil.
  const shim = createRequireShim(job.shim, { react: host.react, remotion: host.remotion });
  if (!shim.ok) {
    result.evaluateError = `verifier setup failed: ${shim.reason}`;
    return;
  }

  // (5) Evaluasi bundle di konteks `vm`: string dan WebAssembly dimatikan, `WebAssembly` dihapus.
  const moduleObject: { exports: unknown } = { exports: {} };
  const sandbox = {
    console: createSandboxConsole(counts),
    require: shim.require,
    module: moduleObject,
    exports: moduleObject.exports,
  };
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  new vm.Script("delete globalThis.WebAssembly;", { filename: "lore-context-setup.js" }).runInContext(context);

  send("evaluate", "start");
  try {
    new vm.Script(job.bundle, { filename: "main.js" }).runInContext(context, { timeout: undefined });
  } catch (error) {
    result.evaluateError = describeError(error);
  } finally {
    send("evaluate", "end");
  }
  if (result.evaluateError !== undefined) return;

  // (6) `meta` deep-equal `staticMeta`, dan ekspor default berupa fungsi.
  let meta: unknown;
  let main: unknown;
  try {
    const exported = moduleObject.exports as Namespace | null;
    meta = exported?.meta;
    main = exported?.default;
  } catch (error) {
    result.evaluateError = describeError(error);
    return;
  }
  result.defaultIsFunction = typeof main === "function";
  try {
    result.metaMatches = metaEquals(meta, job.staticMeta);
    result.meta = snapshotMeta(meta);
  } catch {
    result.metaMatches = false;
  }
  if (!result.metaMatches || !result.defaultIsFunction) return;

  // (7) dan (8) Render tiap frame sampel pada dua lintasan.
  const container = dom.window.document.getElementById("root");
  if (container === null) throw new Error("jsdom page has no #root");

  let frameError: string | undefined;
  const record = (error: unknown): void => {
    frameError ??= describeError(error);
  };
  const root = host.createRoot(container, { onCaughtError: record, onUncaughtError: record });
  state.unmount = () => host.flushSync(() => root.unmount());

  /** Merender satu frame pada pohon baru (`key`), supaya galat satu frame tidak mewariskan ErrorBoundary rusak. */
  const renderFrame = (frame: number): string | undefined => {
    frameError = undefined;
    try {
      host.flushSync(() =>
        root.render(
          host.createElement(host.Thumbnail, {
            key: frame,
            component: main,
            compositionWidth: job.width,
            compositionHeight: job.height,
            durationInFrames: job.staticMeta.durationInFrames,
            fps: job.fps,
            frameToDisplay: frame,
            // `Thumbnail` memberi `opacity: 0` pada pembungkus luar selama jsdom belum punya ukuran
            // layout; tanpa ini seluruh teks frame dianggap tersembunyi oleh aturan 5.11.
            style: { opacity: 1 },
          }),
        ),
      );
    } catch (error) {
      record(error);
    }
    return frameError;
  };

  const ascending = [...new Set(job.frames)].sort((a, b) => a - b);

  for (const frame of ascending) {
    send(frame, "start");
    const error = renderFrame(frame);
    result.frames[frame] =
      error !== undefined
        ? { error }
        : {
            html: container.innerHTML,
            text: extractFrameText(container),
            count: container.querySelectorAll("*").length,
          };
    send(frame, "end");
  }

  for (const frame of [...ascending].reverse()) {
    const first = result.frames[frame];
    if (first === undefined || first.error !== undefined) continue;
    send(frame, "start");
    const error = renderFrame(frame);
    if (error !== undefined) first.error = error;
    else first.secondHtml = container.innerHTML;
    send(frame, "end");
  }
}
