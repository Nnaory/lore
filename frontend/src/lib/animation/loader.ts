/**
 * `loadAnimation`: fetch an AI-written animation bundle and check it before it can run
 * (design 7.4, Requirement 26).
 *
 * A story keeps only a pointer (`AnimationReference`). Showing the animation means getting its
 * bundle from S3 and handing it to the sandbox iframe, which evaluates it. The bundle is code, so
 * this module makes sure the bytes are exactly the ones the verifier published: it asks the API
 * for the bundle's address, downloads the bundle, and compares the SHA-256 of what arrived with
 * `bundle_sha256` from the reference. Nothing is returned as `ok: true` before that comparison
 * passes (D-19).
 *
 * Result. `loadAnimation` never throws and never rejects. It returns
 *
 *   { ok: true, bundle, meta, runtimeMismatch }
 *   { ok: false, phase: "urls" | "fetch" | "integrity", reason }
 *
 * `phase` says which step failed: `urls` is the API call that returns the presigned address,
 * `fetch` is the download, `integrity` is the hash check. `reason` is one of seven fixed words
 * (`LoadReason`). A result carries no URL, query string or message, because the address is a
 * presigned S3 URL and must not reach a log or the screen (Requirements 26.11, 26.14). It lives in
 * local variables of one load and nowhere else.
 *
 * Steps, in order (a caller whose signal is already aborted gets `aborted` before step 1):
 * 1. A bundle already verified in this page is returned from the cache without any request.
 * 2. A load already running for the same `animation_id` and `bundle_sha256` is joined, not repeated.
 * 3. `GET /api/v1/animations/{id}` (8000 ms). Zod checks `data.animation`,
 *    `data.manifest.runtime_version` and `data.urls.bundle` (unknown keys are ignored). A status
 *    other than 200, a bad body, a network error or a timeout is `urls`. A bundle address that is
 *    not `https:` is `urls` / `invalid_body`, and nothing is downloaded.
 * 4. `bundle_sha256` and `source_sha256` in the answer must equal the reference, else
 *    `integrity` / `hash_mismatch` without a download.
 * 5. Download the address (`credentials: "omit"`, `referrerPolicy: "no-referrer"`, 8000 ms for the
 *    request AND the body). `Content-Length` above the limit, or a stream that passes the limit,
 *    is `fetch` / `too_large`; the read stops at the first byte past the limit. A 403 means the
 *    address expired: ask step 3 again once and download once more. Any other failing status is
 *    `fetch` / `status`.
 * 6. Hash the bytes with `sha256Hex`. A different digest is `integrity` / `hash_mismatch`. Only
 *    then are the bytes decoded as UTF-8 text.
 * 7. Store the bundle in the cache and return it.
 *
 * `meta` is derived from the reference, not from the bundle, in the shape the sandbox expects
 * (`durationInFrames`, `pauseAtFrame`). `runtimeMismatch` is true when `react` or `remotion` in the
 * answer's `runtime_version` differs from the versions this build is pinned to (read from
 * `package.json`, so there is one source). A mismatch does not stop the load; the player decides
 * what to do. Both values are stored with the cache entry, so a cache hit and a cache miss return
 * the same thing (Requirement 26.15).
 *
 * Sharing and cancelling. Every caller has its own `signal`. Aborting it ends that caller's call
 * at once with `aborted` and the phase that was running, and does not disturb the others. The
 * network work is cancelled only when no caller is left. Such a load does not write the cache. A
 * finished load, failed or not, is forgotten, so the next call starts again.
 *
 * Cache. 16 entries, least recently used out, keyed by `bundle_sha256`. Only verified bundles go
 * in. State is kept per loader made by `createAnimationLoader`, and `loadAnimation` is the
 * shared page-wide one. The module imports no React or Next code; it uses the global `fetch`
 * only when the caller gives no `fetchImpl`.
 */

import { AnimationReferenceSchema } from "@/lib/contracts/schemas/animation.schema";
import type { AnimationReference } from "@/lib/types/animation";
import { z } from "zod";
import pkg from "../../../package.json";
import { CONTRACT } from "./contract";
import { LruCache } from "./lru";
import { sha256Hex } from "./sha256";

/** Step of a load. Failures and aborts are reported with the one that was running. */
export type LoadPhase = "urls" | "fetch" | "integrity";

/** The only reasons a failed load reports (Requirement 26.14). */
export type LoadReason =
  | "status"
  | "invalid_body"
  | "network"
  | "timeout"
  | "too_large"
  | "hash_mismatch"
  | "aborted";

/**
 * What the sandbox needs to play the bundle, derived from the reference. `pauseAtFrame` exists
 * only for a puzzle. (`sandbox-runtime` has its own `RuntimeMeta`, with the last two fields.)
 */
export interface AnimationMeta {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  pauseAtFrame?: number;
}

export type LoadResult =
  | { ok: true; bundle: string; meta: AnimationMeta; runtimeMismatch: boolean }
  | { ok: false; phase: LoadPhase; reason: LoadReason };

export interface LoadOptions {
  /** Replaces the global `fetch` (tests). */
  fetchImpl?: typeof fetch;
  /** Aborting it ends this caller's call with `aborted`. */
  signal?: AbortSignal;
}

/** Limit of each of the two requests, body included (Requirements 26.3, 26.5, 26.17). */
export const LOAD_TIMEOUT_MS = 8000;

/** Verified bundles kept in memory (Requirement 26.8). */
export const CACHE_CAPACITY = 16;

/** Largest bundle, in bytes: the contract's limit. */
const MAX_BUNDLE_BYTES = CONTRACT.limits.bundle_max_bytes;

/** `react` and `remotion` versions this build is pinned to; the one source is `package.json`. */
export const PINNED_RUNTIME = {
  react: pkg.dependencies.react,
  remotion: pkg.dependencies.remotion,
} as const;

/**
 * Answer of `GET /api/v1/animations/{id}`, reduced to what the loader reads. Not `.strict()`: the
 * server may add keys (`manifest` carries many more, `urls.manifest`, `expires_in`).
 */
const ReaderResponseSchema = z.object({
  data: z.object({
    animation: AnimationReferenceSchema,
    manifest: z.object({
      runtime_version: z.object({ react: z.string(), remotion: z.string() }),
    }),
    urls: z.object({ bundle: z.string().min(1) }),
  }),
});

/** A bundle that passed the hash check, as the cache keeps it. */
interface Verified {
  bundle: string;
  meta: AnimationMeta;
  runtimeMismatch: boolean;
}

const failure = (phase: LoadPhase, reason: LoadReason): LoadResult => ({
  ok: false,
  phase,
  reason,
});

/** A fresh copy, so a caller that edits `meta` cannot change the cache or another caller's result. */
function copyResult(result: LoadResult): LoadResult {
  if (!result.ok) return { ...result };
  return { ...result, meta: { ...result.meta } };
}

function success(verified: Verified): LoadResult {
  return copyResult({ ok: true, ...verified });
}

/** `meta` from the reference. `pauseAtFrame` is left out, not `undefined`, for a lesson. */
function metaOf(reference: AnimationReference): AnimationMeta {
  const meta: AnimationMeta = {
    width: reference.width,
    height: reference.height,
    fps: reference.fps,
    durationInFrames: reference.duration_in_frames,
  };
  if (reference.pause_at_frame !== undefined) meta.pauseAtFrame = reference.pause_at_frame;
  return meta;
}

// ---------------------------------------------------------------------------
// One time-boxed, cancellable step
// ---------------------------------------------------------------------------

/**
 * How a step ended. `done` holds what the work returned. The other three never carry a value:
 * `timeout` (the limit passed), `aborted` (the load was cancelled), `error` (the work threw or
 * rejected for another reason, which for a network call means the network failed).
 */
type Bounded<T> =
  | { kind: "done"; value: T }
  | { kind: "timeout" }
  | { kind: "aborted" }
  | { kind: "error" };

/**
 * Runs `work` with a time limit and with the load's cancellation. `work` gets a signal that
 * aborts on either, to pass to `fetch`. The step also stops waiting by itself, so a `fetchImpl`
 * or stream that ignores the signal cannot hold the load past the limit. When the step ended by
 * timeout or abort, that is what is reported, even if `work` failed first with something else
 * (an aborted `fetch` rejects with its own error).
 */
async function bounded<T>(
  parent: AbortSignal,
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<Bounded<T>> {
  if (parent.aborted) return { kind: "aborted" };

  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = (): void => controller.abort();
  parent.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  const stopped = new Promise<"stopped">((resolve) => {
    controller.signal.addEventListener("abort", () => resolve("stopped"), { once: true });
  });

  const classify = (): Bounded<never> | null => {
    if (parent.aborted) return { kind: "aborted" };
    if (timedOut) return { kind: "timeout" };
    return null;
  };

  try {
    const raced = await Promise.race([
      work(controller.signal).then((value) => ({ value })),
      stopped,
    ]);
    const ended = classify();
    if (ended) return ended;
    if (raced === "stopped") return { kind: "error" }; // not reachable: only timeout and abort stop it
    return { kind: "done", value: raced.value };
  } catch {
    return classify() ?? { kind: "error" };
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", onParentAbort);
  }
}

/** Reason for a step that did not finish with a value. */
function reasonOf(ended: Bounded<unknown>): LoadReason {
  if (ended.kind === "timeout") return "timeout";
  if (ended.kind === "aborted") return "aborted";
  return "network";
}

// ---------------------------------------------------------------------------
// Steps 3 and 5: the two requests
// ---------------------------------------------------------------------------

type UrlsOutcome =
  | { ok: true; bundleUrl: string; runtimeVersion: { react: string; remotion: string } }
  | { ok: false; reason: LoadReason };

/** Step 3 and 4: ask for the address and check the answer against the reference. */
async function requestUrls(
  reference: AnimationReference,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<{ phase: "urls" | "integrity"; outcome: UrlsOutcome }> {
  const ended = await bounded(signal, LOAD_TIMEOUT_MS, async (stepSignal) => {
    const response = await fetchImpl(`/api/v1/animations/${encodeURIComponent(reference.animation_id)}`, {
      credentials: "same-origin",
      signal: stepSignal,
    });
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => undefined);
      return { kind: "status" as const };
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      // A body that is not JSON. If the cause was an abort or the timer, `bounded` says so.
      if (stepSignal.aborted) throw new Error("stopped");
      return { kind: "invalid_body" as const };
    }
    return { kind: "json" as const, json };
  });

  if (ended.kind !== "done") return { phase: "urls", outcome: { ok: false, reason: reasonOf(ended) } };
  if (ended.value.kind !== "json") {
    return { phase: "urls", outcome: { ok: false, reason: ended.value.kind } };
  }

  const parsed = ReaderResponseSchema.safeParse(ended.value.json);
  if (!parsed.success) return { phase: "urls", outcome: { ok: false, reason: "invalid_body" } };
  const { animation, manifest, urls } = parsed.data.data;

  // Requirement 26.16: the bundle must come over https. Nothing is requested otherwise.
  let secure = false;
  try {
    secure = new URL(urls.bundle).protocol === "https:";
  } catch {
    secure = false;
  }
  if (!secure) return { phase: "urls", outcome: { ok: false, reason: "invalid_body" } };

  // Requirement 26.4: the server must be talking about the same files as the story's reference.
  if (
    animation.bundle_sha256 !== reference.bundle_sha256 ||
    animation.source_sha256 !== reference.source_sha256
  ) {
    return { phase: "integrity", outcome: { ok: false, reason: "hash_mismatch" } };
  }

  return {
    phase: "urls",
    outcome: { ok: true, bundleUrl: urls.bundle, runtimeVersion: manifest.runtime_version },
  };
}

type DownloadOutcome =
  | { kind: "ok"; bytes: Uint8Array }
  | { kind: "forbidden" }
  | { kind: "failed"; reason: LoadReason };

/** `Content-Length` as a number, or `null` when it is missing or not a plain count. */
function declaredLength(headers: Headers): number | null {
  const raw = headers.get("Content-Length")?.trim();
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Reads at most `MAX_BUNDLE_BYTES` from the body. Stops and cancels the stream at the first byte
 * past the limit (so at most `MAX_BUNDLE_BYTES + 1` bytes are counted, and none past the limit is
 * kept). An abort cancels the reader and ends the read; `bounded` then reports why.
 */
async function readBody(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<{ kind: "ok"; bytes: Uint8Array } | { kind: "too_large" } | { kind: "stopped" }> {
  const reader = body.getReader();
  const cancel = (): void => {
    void Promise.resolve()
      .then(() => reader.cancel())
      .catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (signal.aborted) return { kind: "stopped" };
      if (chunk.done) break;
      if (total + chunk.value.length > MAX_BUNDLE_BYTES) {
        cancel();
        return { kind: "too_large" };
      }
      chunks.push(chunk.value);
      total += chunk.value.length;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { kind: "ok", bytes };
}

/** Step 5: one download of the presigned address. */
async function download(
  bundleUrl: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<DownloadOutcome> {
  const ended = await bounded(signal, LOAD_TIMEOUT_MS, async (stepSignal): Promise<DownloadOutcome> => {
    const response = await fetchImpl(bundleUrl, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: stepSignal,
    });
    if (response.status === 403) {
      void response.body?.cancel().catch(() => undefined);
      return { kind: "forbidden" };
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return { kind: "failed", reason: "status" };
    }
    const declared = declaredLength(response.headers);
    if (declared !== null && declared > MAX_BUNDLE_BYTES) {
      void response.body?.cancel().catch(() => undefined);
      return { kind: "failed", reason: "too_large" };
    }
    if (!response.body) return { kind: "failed", reason: "invalid_body" };
    const read = await readBody(response.body, stepSignal);
    if (read.kind === "ok") return { kind: "ok", bytes: read.bytes };
    if (read.kind === "too_large") return { kind: "failed", reason: "too_large" };
    throw new Error("stopped"); // aborted mid-read: `bounded` reports timeout or abort
  });
  if (ended.kind !== "done") return { kind: "failed", reason: reasonOf(ended) };
  return ended.value;
}

// ---------------------------------------------------------------------------
// The loader: cache, shared loads, per-caller cancellation
// ---------------------------------------------------------------------------

/** A load in progress, shared by every caller that asked for the same animation. */
interface Load {
  key: string;
  /** Aborts the network work. Only fires when `waiters` has dropped to zero. */
  controller: AbortController;
  /** Callers still waiting for the result. */
  waiters: number;
  /** Step running now, so an abort can say where it happened. */
  phase: LoadPhase;
  /** The result of the load. Never rejects. */
  promise: Promise<LoadResult>;
}

export interface AnimationLoader {
  load(reference: AnimationReference, options?: LoadOptions): Promise<LoadResult>;
  /** Empties the cache. Loads in progress are not touched. */
  clear(): void;
}

/**
 * Makes a loader with its own cache and its own list of loads in progress. The app uses the one
 * behind `loadAnimation`; a test makes its own so that nothing leaks between tests.
 */
export function createAnimationLoader(capacity: number = CACHE_CAPACITY): AnimationLoader {
  const cache = new LruCache<string, Verified>(capacity);
  const inflight = new Map<string, Load>();

  /** Steps 3 to 7 for one load. */
  async function runLoad(
    reference: AnimationReference,
    load: Load,
    fetchImpl: typeof fetch,
  ): Promise<LoadResult> {
    const signal = load.controller.signal;
    let renewed = false; // the address is asked for again at most once (Requirement 26.6)
    let bytes: Uint8Array | null = null;
    let runtimeVersion = { react: "", remotion: "" };

    while (bytes === null) {
      load.phase = "urls";
      const urls = await requestUrls(reference, fetchImpl, signal);
      if (!urls.outcome.ok) return failure(urls.phase, urls.outcome.reason);
      runtimeVersion = urls.outcome.runtimeVersion;

      load.phase = "fetch";
      const got = await download(urls.outcome.bundleUrl, fetchImpl, signal);
      if (got.kind === "forbidden") {
        if (renewed) return failure("fetch", "status");
        renewed = true;
        continue;
      }
      if (got.kind === "failed") return failure("fetch", got.reason);
      bytes = got.bytes;
    }

    load.phase = "integrity";
    const digest = await sha256Hex(bytes);
    if (digest !== reference.bundle_sha256) return failure("integrity", "hash_mismatch");

    let bundle: string;
    try {
      bundle = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return failure("integrity", "invalid_body");
    }

    const verified: Verified = {
      bundle,
      meta: metaOf(reference),
      runtimeMismatch:
        runtimeVersion.react !== PINNED_RUNTIME.react ||
        runtimeVersion.remotion !== PINNED_RUNTIME.remotion,
    };
    // A load nobody waits for any more must not write the cache (Requirement 26.13).
    if (signal.aborted) return failure("integrity", "aborted");
    cache.set(reference.bundle_sha256, verified);
    return success(verified);
  }

  function start(reference: AnimationReference, key: string, fetchImpl: typeof fetch): Load {
    const load: Load = {
      key,
      controller: new AbortController(),
      waiters: 0,
      phase: "urls",
      promise: Promise.resolve(failure("urls", "invalid_body")),
    };
    inflight.set(key, load);
    load.promise = (async (): Promise<LoadResult> => {
      try {
        return await runLoad(reference, load, fetchImpl);
      } catch {
        // Unexpected: every known failure is already a result. Reported as a bad answer.
        return failure(load.phase, "invalid_body");
      } finally {
        // Forget the load, failed or not (Requirement 26.8), unless a newer one took its place.
        if (inflight.get(key) === load) inflight.delete(key);
      }
    })();
    return load;
  }

  /** Waits for `load` on behalf of one caller. The caller's own abort ends only this wait. */
  function wait(load: Load, signal: AbortSignal | undefined): Promise<LoadResult> {
    load.waiters += 1;
    return new Promise<LoadResult>((resolve) => {
      let settled = false;
      const settle = (result: LoadResult): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      function onAbort(): void {
        if (settled) return;
        load.waiters -= 1;
        if (load.waiters === 0) {
          // Nobody else wants it: stop the network work and let a later call start fresh.
          if (inflight.get(load.key) === load) inflight.delete(load.key);
          load.controller.abort();
        }
        settle(failure(load.phase, "aborted"));
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      void load.promise.then((result) => settle(copyResult(result)));
    });
  }

  async function loadOne(reference: unknown, options: LoadOptions): Promise<LoadResult> {
    const { signal } = options;
    if (signal?.aborted) return failure("urls", "aborted");

    // The reference comes from a story, but it builds a URL, so it is checked again.
    const checked = AnimationReferenceSchema.safeParse(reference);
    if (!checked.success) return failure("urls", "invalid_body");
    const ref = checked.data;

    // 1. Verified earlier in this page.
    const hit = cache.get(ref.bundle_sha256);
    if (hit) return success(hit);

    // 2. Join a load of the same animation, or start one.
    const key = `${ref.animation_id}:${ref.bundle_sha256}`;
    const running = inflight.get(key);
    // The global `fetch` is looked up when a request is made, so a missing one is a `network`
    // failure of that request and not an exception here.
    const fetchImpl: typeof fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
    const load = running ?? start(ref, key, fetchImpl);
    return wait(load, signal);
  }

  return {
    async load(reference, options = {}) {
      try {
        return await loadOne(reference, options);
      } catch {
        return failure("urls", "invalid_body");
      }
    },
    clear() {
      cache.clear();
    },
  };
}

/** The loader the app uses: one cache and one list of loads for the whole page. */
const pageLoader = createAnimationLoader();

export function loadAnimation(
  reference: AnimationReference,
  options?: LoadOptions,
): Promise<LoadResult> {
  return pageLoader.load(reference, options);
}

/** Empties the page-wide cache (tests, and a future "sign out"). */
export function clearAnimationCache(): void {
  pageLoader.clear();
}
