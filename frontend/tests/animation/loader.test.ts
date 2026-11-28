/**
 * Tests — `loadAnimation`, the bundle loader (task 23.3, Requirement 26, design 7.4).
 *
 * The network is a fake `fetchImpl` ("world") that answers the two kinds of request the loader
 * makes: the API call for the address (`/api/v1/animations/{id}`) and the download of the bundle
 * (an `https://` address). The shared fixture `backend/tests/fixtures/animation/reader-response.json`
 * is the shape of the API answer; only the hashes, the address and `runtime_version` are replaced
 * so that the bundle used here really hashes to `bundle_sha256` (the fixture's own hash belongs to
 * a bundle that is not in the repository). Nothing touches the network.
 *
 * Groups:
 *   1. success: requests made, `meta`, `runtimeMismatch`, a bundle exactly at the size limit;
 *   2. cache: hit without network, same values as a miss, copies, 16-entry LRU, no cache on failure;
 *   3. phase `urls`: every way the API call can fail, and the `https:` rule;
 *   4. integrity before download: hash and source mismatch in the answer;
 *   5. phase `fetch`: status, network, timeout, size limit by header and by stream, 403 renewal;
 *   6. phase `integrity`: hash mismatch, bytes that are not text;
 *   7. cancelling: before, during each phase, shared loads, nothing written to the cache;
 *   8. shared loads: one download for several callers, release after success and failure;
 *   9. no presigned URL, query string or `X-Amz-` in any result or log;
 *  10. robustness: bad reference, throwing fetch, the page-wide `loadAnimation`.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import pkg from "../../package.json";
import {
  CACHE_CAPACITY,
  LOAD_TIMEOUT_MS,
  type LoadResult,
  PINNED_RUNTIME,
  clearAnimationCache,
  createAnimationLoader,
  loadAnimation,
} from "@/lib/animation/loader";
import { CONTRACT } from "@/lib/animation/contract";
import type { AnimationReference } from "@/lib/types/animation";

// ---------------------------------------------------------------------------
// Fixture, bundles and references
// ---------------------------------------------------------------------------

const FIXTURE_DIR = join(__dirname, "..", "..", "..", "backend", "tests", "fixtures", "animation");
const READER_FIXTURE = JSON.parse(readFileSync(join(FIXTURE_DIR, "reader-response.json"), "utf8"));

const MAX_BYTES = CONTRACT.limits.bundle_max_bytes;
const encoder = new TextEncoder();

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The n-th test bundle: text of a few dozen bytes, different for each `n`. */
const bundleText = (n: number): string => `export default function Animation${n}() { return null; }`;

/** A canonical UUID that differs by `n`. */
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A reference to `bytes`. A `pause` makes it a puzzle reference. */
function referenceFor(bytes: Uint8Array, n = 1, pause?: number): AnimationReference {
  const base = READER_FIXTURE.data.animation as AnimationReference;
  const reference: AnimationReference = {
    ...base,
    animation_id: uuid(n),
    bundle_sha256: sha256(bytes),
    source_sha256: sha256(encoder.encode(`source ${n}`)),
  };
  if (pause !== undefined) reference.pause_at_frame = pause;
  return reference;
}

/** The presigned address the n-th API answer carries. The signature differs per answer. */
const presigned = (n: number, host = "https"): string =>
  `${host}://lore-test-animations.s3.ap-southeast-3.amazonaws.com/animations/v1/aa/main.js` +
  `?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=300&X-Amz-Signature=sig${n}`;

/** What the API answers for `reference`: the shared fixture with the test's values put in. */
function readerBody(
  reference: AnimationReference,
  bundleUrl: string,
  runtime: { react: string; remotion: string } = { ...PINNED_RUNTIME },
): Record<string, unknown> {
  const body = structuredClone(READER_FIXTURE);
  body.data.animation = { ...reference };
  body.data.manifest.runtime_version = runtime;
  body.data.urls.bundle = bundleUrl;
  return body;
}

/** The object at `path` inside a JSON-like body, for tests that change one field of an answer. */
function node(body: unknown, ...path: string[]): Record<string, unknown> {
  let current = body as Record<string, unknown>;
  for (const key of path) current = current[key] as Record<string, unknown>;
  return current;
}

// ---------------------------------------------------------------------------
// The fake network
// ---------------------------------------------------------------------------

interface Call {
  url: string;
  init: RequestInit | undefined;
}

type Handler = (ctx: { n: number; url: string; init: RequestInit | undefined }) => Promise<Response> | Response;

interface WorldOptions {
  /** Answers the API call. `n` counts API calls from 1. Default: the fixture answer. */
  reader?: Handler;
  /** Answers a download. `n` counts downloads from 1. Default: the bytes of `bytes`. */
  bundle?: Handler;
}

/** A fake `fetch` for one reference. `reader` and `bundle` can be replaced per test. */
function createWorld(
  reference: AnimationReference,
  bytes: Uint8Array<ArrayBuffer>,
  options: WorldOptions = {},
) {
  const calls: Call[] = [];
  let apiCalls = 0;
  let downloads = 0;

  const defaultReader: Handler = ({ n }) => Response.json(readerBody(reference, presigned(n)));
  const defaultBundle: Handler = () => new Response(bytes);

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith("/api/v1/animations/")) {
      apiCalls += 1;
      return (options.reader ?? defaultReader)({ n: apiCalls, url, init });
    }
    downloads += 1;
    return (options.bundle ?? defaultBundle)({ n: downloads, url, init });
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    calls,
    get apiCalls() {
      return apiCalls;
    },
    get downloads() {
      return downloads;
    },
    /** Requests that went to a presigned address. */
    get downloadCalls() {
      return calls.filter((call) => call.url.startsWith("https://"));
    },
  };
}

/** A promise settled from outside, to hold a request until the test says go. */
function gate() {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Counters for a stream that delivers `chunks` one per read. */
interface Probe {
  pulled: number;
  delivered: number;
  cancelled: boolean;
}

/** A stream that counts what is read from it. `highWaterMark: 0` makes it lazy, so counts are exact. */
function probedStream(chunks: Uint8Array[], probe: Probe, hangAtEnd = false): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (index < chunks.length) {
          const chunk = chunks[index++];
          probe.pulled += 1;
          probe.delivered += chunk.length;
          controller.enqueue(chunk);
          return undefined;
        }
        if (hangAtEnd) return new Promise<void>(() => undefined);
        controller.close();
        return undefined;
      },
      cancel() {
        probe.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
}

const newProbe = (): Probe => ({ pulled: 0, delivered: 0, cancelled: false });

function split(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
  return out;
}

/** A fresh loader per test, so the cache of one test cannot help another. */
const freshLoader = () => createAnimationLoader();

/** The standard case: a lesson reference to `bundleText(1)`. */
function lessonCase(options: WorldOptions = {}) {
  const bytes = encoder.encode(bundleText(1));
  const reference = referenceFor(bytes);
  return { bytes, reference, world: createWorld(reference, bytes, options) };
}

const REASONS = ["status", "invalid_body", "network", "timeout", "too_large", "hash_mismatch", "aborted"];
const PHASES = ["urls", "fetch", "integrity"];

/** A failed result has exactly `{ok, phase, reason}` from the closed sets and nothing about the address. */
function expectClosedFailure(result: LoadResult): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(Object.keys(result).sort()).toEqual(["ok", "phase", "reason"]);
  expect(PHASES).toContain(result.phase);
  expect(REASONS).toContain(result.reason);
  expect(JSON.stringify(result)).not.toMatch(/X-Amz-|amazonaws|https?:|\?|sig\d/i);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearAnimationCache();
});

// ---------------------------------------------------------------------------
// 1. Success
// ---------------------------------------------------------------------------

describe("a successful load", () => {
  it("asks the API, downloads from the address it got, and returns the bundle", async () => {
    const { reference, world } = lessonCase();
    const result = await freshLoader().load(reference, { fetchImpl: world.fetchImpl });

    expect(result).toEqual({
      ok: true,
      bundle: bundleText(1),
      meta: { width: 1280, height: 720, fps: 30, durationInFrames: 150 },
      runtimeMismatch: false,
    });
    expect(world.calls).toHaveLength(2);
    expect(world.calls[0].url).toBe(`/api/v1/animations/${reference.animation_id}`);
    expect(world.calls[1].url).toBe(presigned(1));
  });

  it("sends the API call same-origin with a signal and no body or method override", async () => {
    const { reference, world } = lessonCase();
    await freshLoader().load(reference, { fetchImpl: world.fetchImpl });
    const init = world.calls[0].init;
    expect(init?.credentials).toBe("same-origin");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.method).toBeUndefined();
    expect(init?.body).toBeUndefined();
  });

  it("downloads without credentials and without a referrer", async () => {
    const { reference, world } = lessonCase();
    await freshLoader().load(reference, { fetchImpl: world.fetchImpl });
    const init = world.calls[1].init;
    expect(init?.credentials).toBe("omit");
    expect(init?.referrerPolicy).toBe("no-referrer");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("puts `pauseAtFrame` in `meta` for a puzzle reference and leaves the key out for a lesson", async () => {
    const bytes = encoder.encode(bundleText(2));
    const puzzle = referenceFor(bytes, 2, 100);
    const world = createWorld(puzzle, bytes);
    const result = await freshLoader().load(puzzle, { fetchImpl: world.fetchImpl });
    expect(result.ok && result.meta).toEqual({
      width: 1280,
      height: 720,
      fps: 30,
      durationInFrames: 150,
      pauseAtFrame: 100,
    });

    const { reference, world: lessonWorld } = lessonCase();
    const lesson = await freshLoader().load(reference, { fetchImpl: lessonWorld.fetchImpl });
    expect(lesson.ok && "pauseAtFrame" in lesson.meta).toBe(false);
  });

  it("takes `meta` from the reference, not from the answer", async () => {
    const bytes = encoder.encode(bundleText(3));
    const reference = { ...referenceFor(bytes, 3), duration_in_frames: 90 };
    const world = createWorld(reference, bytes, {
      reader: ({ n }) => {
        const body = readerBody(reference, presigned(n));
        node(body, "data", "manifest").meta = { width: 1280, height: 720, fps: 30, durationInFrames: 777 };
        return Response.json(body);
      },
    });
    const result = await freshLoader().load(reference, { fetchImpl: world.fetchImpl });
    expect(result.ok && result.meta.durationInFrames).toBe(90);
  });

  it("accepts a bundle of exactly the size limit, by header and by stream", async () => {
    const bytes = encoder.encode("a".repeat(MAX_BYTES));
    expect(bytes.length).toBe(131072);
    const reference = referenceFor(bytes, 4);
    const world = createWorld(reference, bytes, {
      bundle: () =>
        new Response(probedStream(split(bytes, 4096), newProbe()), {
          headers: { "Content-Length": String(MAX_BYTES) },
        }),
    });
    const result = await freshLoader().load(reference, { fetchImpl: world.fetchImpl });
    expect(result.ok && result.bundle.length).toBe(MAX_BYTES);
  });

  it("reads a bundle that arrives in many small chunks", async () => {
    const { bytes, reference } = lessonCase();
    const world = createWorld(reference, bytes, {
      bundle: () => new Response(probedStream(split(bytes, 5), newProbe())),
    });
    const result = await freshLoader().load(reference, { fetchImpl: world.fetchImpl });
    expect(result.ok && result.bundle).toBe(bundleText(1));
  });

  it("decodes multi-byte text from the bytes that were hashed", async () => {
    const text = "// Konsep: π ≈ 3,14 — 日本語\nexport default function A() { return null; }";
    const bytes = encoder.encode(text);
    const reference = referenceFor(bytes, 5);
    const world = createWorld(reference, bytes);
    const result = await freshLoader().load(reference, { fetchImpl: world.fetchImpl });
    expect(result.ok && result.bundle).toBe(text);
  });

  it("works when crypto.subtle is missing (pure SHA-256)", async () => {
    vi.stubGlobal("crypto", {});
    const { reference, world } = lessonCase();
    const result = await freshLoader().load(reference, { fetchImpl: world.fetchImpl });
    expect(result.ok).toBe(true);
  });

  it("works when crypto.subtle.digest rejects", async () => {
    vi.spyOn(globalThis.crypto.subtle, "digest").mockRejectedValue(new Error("no"));
    const { reference, world } = lessonCase();
    const result = await freshLoader().load(reference, { fetchImpl: world.fetchImpl });
    expect(result.ok).toBe(true);
  });
});

describe("runtime versions", () => {
  it("pins come from package.json", () => {
    expect(PINNED_RUNTIME).toEqual({
      react: pkg.dependencies.react,
      remotion: pkg.dependencies.remotion,
    });
  });

  it.each([
    ["react", { react: "18.0.0", remotion: PINNED_RUNTIME.remotion }],
    ["remotion", { react: PINNED_RUNTIME.react, remotion: "4.0.1" }],
    ["both", { react: "18.0.0", remotion: "4.0.1" }],
  ])("a different %s version still loads, with runtimeMismatch true", async (_name, runtime) => {
    const { bytes, reference } = lessonCase();
    const world = createWorld(reference, bytes, {
      reader: ({ n }) => Response.json(readerBody(reference, presigned(n), runtime)),
    });
    const result = await freshLoader().load(reference, { fetchImpl: world.fetchImpl });
    expect(result).toMatchObject({ ok: true, bundle: bundleText(1), runtimeMismatch: true });
  });

  it("the same versions give runtimeMismatch false", async () => {
    const { reference, world } = lessonCase();
    const result = await freshLoader().load(reference, { fetchImpl: world.fetchImpl });
    expect(result.ok && result.runtimeMismatch).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Cache
// ---------------------------------------------------------------------------

describe("the cache", () => {
  it("returns a verified bundle again without any request", async () => {
    const { reference, world } = lessonCase();
    const loader = freshLoader();
    const first = await loader.load(reference, { fetchImpl: world.fetchImpl });
    const callsAfterFirst = world.calls.length;

    const throwing = vi.fn(() => {
      throw new Error("the network must not be used");
    }) as unknown as typeof fetch;
    const second = await loader.load(reference, { fetchImpl: throwing });

    expect(throwing).not.toHaveBeenCalled();
    expect(world.calls).toHaveLength(callsAfterFirst);
    expect(second).toEqual(first);
  });

  it("a hit and a miss return the same `meta` and `runtimeMismatch`, mismatch included", async () => {
    const bytes = encoder.encode(bundleText(6));
    const puzzle = referenceFor(bytes, 6, 120);
    const world = createWorld(puzzle, bytes, {
      reader: ({ n }) => Response.json(readerBody(puzzle, presigned(n), { react: "18.0.0", remotion: "4.0.1" })),
    });
    const loader = freshLoader();
    const miss = await loader.load(puzzle, { fetchImpl: world.fetchImpl });
    const hit = await loader.load(puzzle);
    expect(miss).toMatchObject({ ok: true, runtimeMismatch: true });
    expect(hit).toEqual(miss);
  });

  it("returns copies, so a caller that edits `meta` does not change the cache", async () => {
    const { reference, world } = lessonCase();
    const loader = freshLoader();
    const first = await loader.load(reference, { fetchImpl: world.fetchImpl });
    if (!first.ok) throw new Error("expected success");
    first.meta.durationInFrames = 1;
    const second = await loader.load(reference);
    expect(second.ok && second.meta.durationInFrames).toBe(150);
    if (second.ok) second.meta.fps = 1;
    const third = await loader.load(reference);
    expect(third.ok && third.meta.fps).toBe(30);
  });

  it("is keyed by `bundle_sha256`: another animation with the same bundle is a hit", async () => {
    const { reference, world } = lessonCase();
    const loader = freshLoader();
    await loader.load(reference, { fetchImpl: world.fetchImpl });
    const other = { ...reference, animation_id: uuid(99) };
    const second = await loader.load(other);
    expect(second.ok).toBe(true);
    expect(world.calls).toHaveLength(2);
  });

  it("holds 16 verified bundles and drops the least recently used", async () => {
    expect(CACHE_CAPACITY).toBe(16);
    const loader = freshLoader();
    const worlds = Array.from({ length: 17 }, (_, i) => {
      const bytes = encoder.encode(bundleText(100 + i));
      const reference = referenceFor(bytes, 100 + i);
      return { reference, world: createWorld(reference, bytes) };
    });
    for (const { reference, world } of worlds.slice(0, 16)) {
      await loader.load(reference, { fetchImpl: world.fetchImpl });
    }
    // A hit on the oldest entry makes it the newest: entry 1 is now the oldest.
    await loader.load(worlds[0].reference);
    expect(worlds[0].world.calls).toHaveLength(2);
    // The 17th bundle evicts entry 1.
    await loader.load(worlds[16].reference, { fetchImpl: worlds[16].world.fetchImpl });

    await loader.load(worlds[0].reference); // still cached
    expect(worlds[0].world.calls).toHaveLength(2);
    await loader.load(worlds[1].reference, { fetchImpl: worlds[1].world.fetchImpl }); // evicted: loads again
    expect(worlds[1].world.calls).toHaveLength(4);
  });

  it("never stores a bundle that failed to load", async () => {
    const { reference, world } = lessonCase({ bundle: () => new Response("tampered") });
    const loader = freshLoader();
    expect(await loader.load(reference, { fetchImpl: world.fetchImpl })).toEqual({
      ok: false,
      phase: "integrity",
      reason: "hash_mismatch",
    });
    await loader.load(reference, { fetchImpl: world.fetchImpl });
    expect(world.apiCalls).toBe(2);
    expect(world.downloads).toBe(2);
  });

  it("clear() empties the cache", async () => {
    const { reference, world } = lessonCase();
    const loader = freshLoader();
    await loader.load(reference, { fetchImpl: world.fetchImpl });
    loader.clear();
    await loader.load(reference, { fetchImpl: world.fetchImpl });
    expect(world.apiCalls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 3. Phase `urls`
// ---------------------------------------------------------------------------

describe("phase urls", () => {
  it.each([
    [404, "status"],
    [503, "status"],
    [500, "status"],
    [204, "status"],
  ])("status %i is urls / %s and nothing is downloaded", async (status, reason) => {
    const { reference, world } = lessonCase({
      reader: () => new Response(status === 204 ? null : "{}", { status }),
    });
    const result = await freshLoader().load(reference, { fetchImpl: world.fetchImpl });
    expect(result).toEqual({ ok: false, phase: "urls", reason });
    expect(world.downloads).toBe(0);
  });

  it("a body that is not JSON is urls / invalid_body", async () => {
    const { reference, world } = lessonCase({ reader: () => new Response("<html>not json") });
    expect(await freshLoader().load(reference, { fetchImpl: world.fetchImpl })).toEqual({
      ok: false,
      phase: "urls",
      reason: "invalid_body",
    });
  });

  /** Wraps an in-place edit of the good answer so it can be used as a body builder. */
  type Body = Record<string, unknown>;
  const edit =
    (change: (body: Body) => void) =>
    (body: Body): unknown => {
      change(body);
      return body;
    };
  const brokenBodies: Array<[string, (body: Body) => unknown]> = [
    ["not an object", () => "text"],
    ["null", () => null],
    ["no data", () => ({ ok: true })],
    ["no animation", edit((b) => delete node(b, "data").animation)],
    ["animation with a bad hash", edit((b) => (node(b, "data", "animation").bundle_sha256 = "zz"))],
    [
      "animation with a bad id",
      edit((b) => (node(b, "data", "animation").animation_id = "not-a-uuid")),
    ],
    ["no manifest", edit((b) => delete node(b, "data").manifest)],
    ["no runtime_version", edit((b) => delete node(b, "data", "manifest").runtime_version)],
    [
      "runtime_version without remotion",
      edit((b) => delete node(b, "data", "manifest", "runtime_version").remotion),
    ],
    [
      "runtime_version with a number",
      edit((b) => (node(b, "data", "manifest", "runtime_version").react = 19)),
    ],
    ["no urls", edit((b) => delete node(b, "data").urls)],
    ["no urls.bundle", edit((b) => delete node(b, "data", "urls").bundle)],
    ["empty urls.bundle", edit((b) => (node(b, "data", "urls").bundle = ""))],
    ["urls.bundle as a number", edit((b) => (node(b, "data", "urls").bundle = 5))],
  ];

  it.each(brokenBodies)("an answer with %s is urls / invalid_body and nothing is downloaded", async (_name, change) => {
    const { reference, world } = lessonCase({
      reader: ({ n }) => Response.json(change(readerBody(reference, presigned(n)))),
    });
    const result = await freshLoader().load(reference, { fetchImpl: world.fetchImpl });
    expect(result).toEqual({ ok: false, phase: "urls", reason: "invalid_body" });
    expect(world.downloads).toBe(0);
  });

  it("ignores keys it does not know (the schema is not strict)", async () => {
    const { reference, world } = lessonCase({
      reader: ({ n }) => {
        const body = readerBody(reference, presigned(n));
        body.extra = { anything: true };
        node(body, "data").future = [1, 2, 3];
        node(body, "data", "urls").later = "x";
        node(body, "data", "manifest").new_field = 1;
        return Response.json(body);
      },
    });
    expect((await freshLoader().load(reference, { fetchImpl: world.fetchImpl })).ok).toBe(true);
  });

  it("a rejected API call is urls / network", async () => {
    const { reference, world } = lessonCase({
      reader: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    expect(await freshLoader().load(reference, { fetchImpl: world.fetchImpl })).toEqual({
      ok: false,
      phase: "urls",
      reason: "network",
    });
  });

  it.each([
    ["http", "http://lore-test.s3.amazonaws.com/main.js?X-Amz-Signature=a"],
    ["ftp", "ftp://example.com/main.js"],
    ["data", "data:text/javascript,export default 1"],
    ["javascript", "javascript:alert(1)"],
    ["blob", "blob:https://example.com/uuid"],
    ["protocol-relative", "//example.com/main.js"],
    ["relative", "/main.js"],
    ["garbage", "not a url"],
  ])("a %s address is urls / invalid_body and nothing is downloaded", async (_name, address) => {
    const { reference, world } = lessonCase({
      reader: () => Response.json(readerBody(reference, address)),
    });
    const result = await freshLoader().load(reference, { fetchImpl: world.fetchImpl });
    expect(result).toEqual({ ok: false, phase: "urls", reason: "invalid_body" });
    expect(world.downloads).toBe(0);
  });

  it("an https address with upper-case scheme is accepted", async () => {
    const { reference, world } = lessonCase({
      reader: () => Response.json(readerBody(reference, "HTTPS://example.com/main.js?sig=1")),
    });
    expect((await freshLoader().load(reference, { fetchImpl: world.fetchImpl })).ok).toBe(true);
  });

  it("times out after 8000 ms, also for a fetch that ignores the signal", async () => {
    expect(LOAD_TIMEOUT_MS).toBe(8000);
    vi.useFakeTimers();
    const { reference, world } = lessonCase({ reader: () => new Promise<Response>(() => undefined) });
    let settled = false;
    const promise = freshLoader()
      .load(reference, { fetchImpl: world.fetchImpl })
      .then((result) => {
        settled = true;
        return result;
      });

    await vi.advanceTimersByTimeAsync(7999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await promise).toEqual({ ok: false, phase: "urls", reason: "timeout" });
    expect(world.calls[0].init?.signal?.aborted).toBe(true);
    expect(world.downloads).toBe(0);
  });

  it("times out when the body of the API answer never ends", async () => {
    vi.useFakeTimers();
    const { reference, world } = lessonCase({
      reader: () => new Response(probedStream([encoder.encode("{")], newProbe(), true)),
    });
    const promise = freshLoader().load(reference, { fetchImpl: world.fetchImpl });
    await vi.advanceTimersByTimeAsync(8000);
    expect(await promise).toEqual({ ok: false, phase: "urls", reason: "timeout" });
  });
});

// ---------------------------------------------------------------------------
// 4. Integrity before download
// ---------------------------------------------------------------------------

describe("hashes in the API answer", () => {
  it.each(["bundle_sha256", "source_sha256"])(
    "a different %s is integrity / hash_mismatch and the bundle is not downloaded",
    async (key) => {
      const { reference, world } = lessonCase({
        reader: ({ n }) => {
          const body = readerBody(reference, presigned(n));
          node(body, "data", "animation")[key] = "f".repeat(64);
          return Response.json(body);
        },
      });
      const result = await freshLoader().load(reference, { fetchImpl: world.fetchImpl });
      expect(result).toEqual({ ok: false, phase: "integrity", reason: "hash_mismatch" });
      expect(world.apiCalls).toBe(1);
      expect(world.downloads).toBe(0);
    },
  );

  it("compares exactly: a hash in another case does not even pass the schema", async () => {
    const { reference, world } = lessonCase({
      reader: ({ n }) => {
        const body = readerBody(reference, presigned(n));
        node(body, "data", "animation").bundle_sha256 = reference.bundle_sha256.toUpperCase();
        return Response.json(body);
      },
    });
    const result = await freshLoader().load(reference, { fetchImpl: world.fetchImpl });
    expect(result).toEqual({ ok: false, phase: "urls", reason: "invalid_body" });
    expect(world.downloads).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Phase `fetch`
// ---------------------------------------------------------------------------

describe("phase fetch", () => {
  it.each([404, 500, 503, 401])("download status %i is fetch / status", async (status) => {
    const { reference, world } = lessonCase({ bundle: () => new Response("x", { status }) });
    const result = await freshLoader().load(reference, { fetchImpl: world.fetchImpl });
    expect(result).toEqual({ ok: false, phase: "fetch", reason: "status" });
    expect(world.apiCalls).toBe(1);
    expect(world.downloads).toBe(1);
  });

  it("a rejected download is fetch / network", async () => {
    const { reference, world } = lessonCase({ bundle: () => Promise.reject(new TypeError("down")) });
    expect(await freshLoader().load(reference, { fetchImpl: world.fetchImpl })).toEqual({
      ok: false,
      phase: "fetch",
      reason: "network",
    });
  });

  it("a stream that breaks in the middle is fetch / network", async () => {
    const { bytes, reference } = lessonCase();
    const world = createWorld(reference, bytes, {
      bundle: () => {
        let sent = false;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!sent) {
                sent = true;
                controller.enqueue(bytes.slice(0, 5));
                return;
              }
              controller.error(new TypeError("connection reset"));
            },
          }),
        );
      },
    });
    expect(await freshLoader().load(reference, { fetchImpl: world.fetchImpl })).toEqual({
      ok: false,
      phase: "fetch",
      reason: "network",
    });
  });

  it("a download without a body is fetch / invalid_body", async () => {
    const { reference, world } = lessonCase({ bundle: () => new Response(null, { status: 200 }) });
    expect(await freshLoader().load(reference, { fetchImpl: world.fetchImpl })).toEqual({
      ok: false,
      phase: "fetch",
      reason: "invalid_body",
    });
  });

  it("times out after 8000 ms, counted from the request and including the body", async () => {
    vi.useFakeTimers();
    const { bytes, reference } = lessonCase();
    const probe = newProbe();
    const world = createWorld(reference, bytes, {
      bundle: () => new Response(probedStream([bytes.slice(0, 10)], probe, true)),
    });
    let settled = false;
    const promise = freshLoader()
      .load(reference, { fetchImpl: world.fetchImpl })
      .then((result) => {
        settled = true;
        return result;
      });

    await vi.advanceTimersByTimeAsync(7999);
    expect(settled).toBe(false);
    expect(probe.pulled).toBeGreaterThan(0); // the body was being read when time ran out
    await vi.advanceTimersByTimeAsync(1);
    expect(await promise).toEqual({ ok: false, phase: "fetch", reason: "timeout" });
    expect(world.calls[1].init?.signal?.aborted).toBe(true);
    expect(probe.cancelled).toBe(true);
  });

  it("gives each of the two requests its own 8000 ms", async () => {
    vi.useFakeTimers();
    const { bytes, reference } = lessonCase();
    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const world = createWorld(reference, bytes, {
      reader: async ({ n }) => {
        await wait(5000);
        return Response.json(readerBody(reference, presigned(n)));
      },
      bundle: async () => {
        await wait(5000);
        return new Response(bytes);
      },
    });
    const promise = freshLoader().load(reference, { fetchImpl: world.fetchImpl });
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await promise).ok).toBe(true);
  });

  describe("size limit", () => {
    it("Content-Length 131073 is fetch / too_large and the body is not read", async () => {
      const { bytes, reference } = lessonCase();
      const probe = newProbe();
      const world = createWorld(reference, bytes, {
        bundle: () =>
          new Response(probedStream([bytes], probe), { headers: { "Content-Length": String(MAX_BYTES + 1) } }),
      });
      const result = await freshLoader().load(reference, { fetchImpl: world.fetchImpl });
      expect(result).toEqual({ ok: false, phase: "fetch", reason: "too_large" });
      expect(probe.pulled).toBe(0);
      expect(probe.cancelled).toBe(true);
    });

    it("a stream of 131073 bytes is too_large and the read stops at 131073 bytes", async () => {
      const bytes = encoder.encode("b".repeat(MAX_BYTES + 1));
      const reference = referenceFor(bytes, 7);
      const probe = newProbe();
      const world = createWorld(reference, bytes, {
        bundle: () => new Response(probedStream(split(bytes, 1024), probe)),
      });
      const result = await freshLoader().load(reference, { fetchImpl: world.fetchImpl });
      expect(result).toEqual({ ok: false, phase: "fetch", reason: "too_large" });
      expect(probe.delivered).toBe(MAX_BYTES + 1);
      expect(probe.pulled).toBe(129); // 128 chunks of 1024 and then the one byte over the limit
      expect(probe.cancelled).toBe(true);
    });

    it("stops at once on a stream that is far larger and never ends", async () => {
      const { bytes, reference } = lessonCase();
      const probe = newProbe();
      const endless = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            probe.pulled += 1;
            controller.enqueue(new Uint8Array(4096));
          },
          cancel() {
            probe.cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      const world = createWorld(reference, bytes, { bundle: () => new Response(endless) });
      const result = await freshLoader().load(reference, { fetchImpl: world.fetchImpl });
      expect(result).toEqual({ ok: false, phase: "fetch", reason: "too_large" });
      expect(probe.pulled).toBe(33); // 32 x 4096 = 131072, the 33rd chunk crosses the limit
      expect(probe.cancelled).toBe(true);
    });

    it("a Content-Length that understates the size does not help", async () => {
      const bytes = encoder.encode("c".repeat(MAX_BYTES + 5));
      const reference = referenceFor(bytes, 8);
      const world = createWorld(reference, bytes, {
        bundle: () => new Response(probedStream(split(bytes, 2048), newProbe()), { headers: { "Content-Length": "10" } }),
      });
      expect(await freshLoader().load(reference, { fetchImpl: world.fetchImpl })).toEqual({
        ok: false,
        phase: "fetch",
        reason: "too_large",
      });
    });

    it("an unreadable Content-Length is ignored and the stream decides", async () => {
      const { bytes, reference } = lessonCase();
      const world = createWorld(reference, bytes, {
        bundle: () => new Response(bytes, { headers: { "Content-Length": "lots" } }),
      });
      expect((await freshLoader().load(reference, { fetchImpl: world.fetchImpl })).ok).toBe(true);
    });
  });

  describe("403 on the download", () => {
    it("asks for a new address once and downloads again", async () => {
      const { bytes, reference } = lessonCase();
      const world = createWorld(reference, bytes, {
        bundle: ({ n }) => (n === 1 ? new Response("expired", { status: 403 }) : new Response(bytes)),
      });
      const result = await freshLoader().load(reference, { fetchImpl: world.fetchImpl });
      expect(result).toMatchObject({ ok: true, bundle: bundleText(1) });
      expect(world.calls.map((call) => call.url)).toEqual([
        `/api/v1/animations/${reference.animation_id}`,
        presigned(1),
        `/api/v1/animations/${reference.animation_id}`,
        presigned(2), // the second download uses the address of the second answer
      ]);
    });

    it("gives up after the second 403, with no third attempt", async () => {
      const { reference, world } = lessonCase({ bundle: () => new Response("no", { status: 403 }) });
      const result = await freshLoader().load(reference, { fetchImpl: world.fetchImpl });
      expect(result).toEqual({ ok: false, phase: "fetch", reason: "status" });
      expect(world.apiCalls).toBe(2);
      expect(world.downloads).toBe(2);
    });

    it("reports phase urls when the renewed address cannot be fetched", async () => {
      const { reference, world } = lessonCase({
        bundle: () => new Response("expired", { status: 403 }),
        reader: ({ n }) =>
          n === 1
            ? Response.json(readerBody(reference, presigned(n)))
            : new Response("{}", { status: 503 }),
      });
      const result = await freshLoader().load(reference, { fetchImpl: world.fetchImpl });
      expect(result).toEqual({ ok: false, phase: "urls", reason: "status" });
      expect(world.downloads).toBe(1);
    });

    it("checks the hashes of the renewed answer too", async () => {
      const { bytes, reference } = lessonCase();
      const world = createWorld(reference, bytes, {
        bundle: () => new Response("expired", { status: 403 }),
        reader: ({ n }) => {
          const body = readerBody(reference, presigned(n));
          if (n === 2) node(body, "data", "animation").bundle_sha256 = "e".repeat(64);
          return Response.json(body);
        },
      });
      const result = await freshLoader().load(reference, { fetchImpl: world.fetchImpl });
      expect(result).toEqual({ ok: false, phase: "integrity", reason: "hash_mismatch" });
      expect(world.downloads).toBe(1);
    });

    it("a 403 on the API call is a plain status failure with no renewal", async () => {
      const { reference, world } = lessonCase({ reader: () => new Response("{}", { status: 403 }) });
      expect(await freshLoader().load(reference, { fetchImpl: world.fetchImpl })).toEqual({
        ok: false,
        phase: "urls",
        reason: "status",
      });
      expect(world.apiCalls).toBe(1);
    });

    it("a 404 on the download is not renewed", async () => {
      const { reference, world } = lessonCase({ bundle: () => new Response("no", { status: 404 }) });
      await freshLoader().load(reference, { fetchImpl: world.fetchImpl });
      expect(world.apiCalls).toBe(1);
      expect(world.downloads).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Phase `integrity`
// ---------------------------------------------------------------------------

describe("phase integrity", () => {
  it("bytes that differ from bundle_sha256 are rejected and never returned", async () => {
    const { bytes, reference } = lessonCase();
    const tampered = bytes.slice();
    tampered[0] ^= 0x01; // same length, one bit different
    const world = createWorld(reference, bytes, { bundle: () => new Response(tampered) });
    expect(await freshLoader().load(reference, { fetchImpl: world.fetchImpl })).toEqual({
      ok: false,
      phase: "integrity",
      reason: "hash_mismatch",
    });
  });

  it("an empty download is a hash mismatch", async () => {
    const { reference, world } = lessonCase({ bundle: () => new Response("") });
    expect(await freshLoader().load(reference, { fetchImpl: world.fetchImpl })).toEqual({
      ok: false,
      phase: "integrity",
      reason: "hash_mismatch",
    });
  });

  it("works with the pure SHA-256 too: a mismatch is still caught", async () => {
    vi.stubGlobal("crypto", {});
    const { reference, world } = lessonCase({ bundle: () => new Response("tampered") });
    expect(await freshLoader().load(reference, { fetchImpl: world.fetchImpl })).toEqual({
      ok: false,
      phase: "integrity",
      reason: "hash_mismatch",
    });
  });

  it("bytes that match the hash but are not UTF-8 text are integrity / invalid_body", async () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0xfd, 0x80]);
    const reference = referenceFor(bytes, 9);
    const world = createWorld(reference, bytes);
    expect(await freshLoader().load(reference, { fetchImpl: world.fetchImpl })).toEqual({
      ok: false,
      phase: "integrity",
      reason: "invalid_body",
    });
  });
});

// ---------------------------------------------------------------------------
// 7. Cancelling
// ---------------------------------------------------------------------------

describe("cancelling", () => {
  it("a signal that is already aborted ends with aborted and makes no request", async () => {
    const { reference, world } = lessonCase();
    const controller = new AbortController();
    controller.abort();
    expect(await freshLoader().load(reference, { fetchImpl: world.fetchImpl, signal: controller.signal })).toEqual({
      ok: false,
      phase: "urls",
      reason: "aborted",
    });
    expect(world.calls).toHaveLength(0);
  });

  it("an aborted signal wins even when the bundle is cached", async () => {
    const { reference, world } = lessonCase();
    const loader = freshLoader();
    await loader.load(reference, { fetchImpl: world.fetchImpl });
    const controller = new AbortController();
    controller.abort();
    expect(await loader.load(reference, { signal: controller.signal })).toEqual({
      ok: false,
      phase: "urls",
      reason: "aborted",
    });
  });

  it("aborting during the API call gives phase urls and cancels the request", async () => {
    const hold = gate();
    const { reference, world } = lessonCase({
      reader: async ({ n }) => {
        await hold.promise;
        return Response.json(readerBody(reference, presigned(n)));
      },
    });
    const controller = new AbortController();
    const promise = freshLoader().load(reference, { fetchImpl: world.fetchImpl, signal: controller.signal });
    await vi.waitFor(() => expect(world.apiCalls).toBe(1));
    controller.abort();
    expect(await promise).toEqual({ ok: false, phase: "urls", reason: "aborted" });
    expect(world.calls[0].init?.signal?.aborted).toBe(true);
    hold.open();
    await Promise.resolve();
    expect(world.downloads).toBe(0);
  });

  it("aborting during the download gives phase fetch and cancels the request", async () => {
    const hold = gate();
    const { bytes, reference } = lessonCase();
    const world = createWorld(reference, bytes, {
      bundle: async () => {
        await hold.promise;
        return new Response(bytes);
      },
    });
    const controller = new AbortController();
    const promise = freshLoader().load(reference, { fetchImpl: world.fetchImpl, signal: controller.signal });
    await vi.waitFor(() => expect(world.downloads).toBe(1));
    controller.abort();
    expect(await promise).toEqual({ ok: false, phase: "fetch", reason: "aborted" });
    expect(world.calls[1].init?.signal?.aborted).toBe(true);
    hold.open();
  });

  it("aborting while the body is being read cancels the stream", async () => {
    const { bytes, reference } = lessonCase();
    const probe = newProbe();
    const world = createWorld(reference, bytes, {
      bundle: () => new Response(probedStream([bytes.slice(0, 8)], probe, true)),
    });
    const controller = new AbortController();
    const promise = freshLoader().load(reference, { fetchImpl: world.fetchImpl, signal: controller.signal });
    await vi.waitFor(() => expect(probe.pulled).toBe(1));
    controller.abort();
    expect(await promise).toEqual({ ok: false, phase: "fetch", reason: "aborted" });
    await vi.waitFor(() => expect(probe.cancelled).toBe(true));
  });

  it("an abort writes nothing to the cache, even if the answer arrives later", async () => {
    const hold = gate();
    const { bytes, reference } = lessonCase();
    const world = createWorld(reference, bytes, {
      bundle: async () => {
        await hold.promise;
        return new Response(bytes);
      },
    });
    const loader = freshLoader();
    const controller = new AbortController();
    const promise = loader.load(reference, { fetchImpl: world.fetchImpl, signal: controller.signal });
    await vi.waitFor(() => expect(world.downloads).toBe(1));
    controller.abort();
    await promise;
    hold.open();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // A new call must go to the network again: nothing was cached and the dead load is not joined.
    const next = await loader.load(reference, { fetchImpl: world.fetchImpl });
    expect(next.ok).toBe(true);
    expect(world.apiCalls).toBe(2);
  });

  it("an abort while the bytes are being hashed reports phase integrity and writes nothing", async () => {
    const hold = gate();
    const realDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
      await hold.promise;
      return realDigest(algorithm, data);
    });
    const { reference, world } = lessonCase();
    const loader = freshLoader();
    const controller = new AbortController();
    const promise = loader.load(reference, { fetchImpl: world.fetchImpl, signal: controller.signal });
    await vi.waitFor(() => expect(globalThis.crypto.subtle.digest).toHaveBeenCalledTimes(1));
    controller.abort();
    expect(await promise).toEqual({ ok: false, phase: "integrity", reason: "aborted" });

    hold.open(); // the digest now finishes and matches, but nobody is waiting for the bundle
    await new Promise((resolve) => setTimeout(resolve, 20));
    vi.restoreAllMocks();

    const next = await loader.load(reference, { fetchImpl: world.fetchImpl });
    expect(next.ok).toBe(true);
    expect(world.apiCalls).toBe(2); // not served from the cache
  });

  it("the signal of a call that already finished is not listened to any more", async () => {
    const { reference, world } = lessonCase();
    const controller = new AbortController();
    const result = await freshLoader().load(reference, { fetchImpl: world.fetchImpl, signal: controller.signal });
    expect(result.ok).toBe(true);
    controller.abort(); // must not throw or change anything
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. Shared loads
// ---------------------------------------------------------------------------

describe("shared loads", () => {
  it("two callers for the same animation share one API call and one download", async () => {
    const { bytes, reference } = lessonCase();
    const hold = gate();
    const world = createWorld(reference, bytes, {
      bundle: async () => {
        await hold.promise;
        return new Response(bytes);
      },
    });
    const loader = freshLoader();
    const a = loader.load(reference, { fetchImpl: world.fetchImpl });
    const b = loader.load(reference, { fetchImpl: world.fetchImpl });
    await vi.waitFor(() => expect(world.downloads).toBe(1));
    hold.open();
    const [ra, rb] = await Promise.all([a, b]);

    expect(world.apiCalls).toBe(1);
    expect(world.downloads).toBe(1);
    expect(ra).toEqual(rb);
    expect(ra.ok).toBe(true);
    if (ra.ok && rb.ok) expect(ra.meta).not.toBe(rb.meta); // each caller has its own copy
  });

  it("different animations are not shared, even with the same bundle", async () => {
    const { bytes, reference } = lessonCase();
    const world = createWorld(reference, bytes);
    const other = { ...reference, animation_id: uuid(50) };
    const otherWorld = createWorld(other, bytes);
    const loader = freshLoader();
    const [ra, rb] = await Promise.all([
      loader.load(reference, { fetchImpl: world.fetchImpl }),
      loader.load(other, { fetchImpl: otherWorld.fetchImpl }),
    ]);
    expect(ra.ok && rb.ok).toBe(true);
    expect(world.downloads).toBe(1);
    expect(otherWorld.downloads).toBe(1);
  });

  it("one caller aborting does not disturb the other, and the network is not cancelled", async () => {
    const hold = gate();
    const { bytes, reference } = lessonCase();
    const world = createWorld(reference, bytes, {
      bundle: async () => {
        await hold.promise;
        return new Response(bytes);
      },
    });
    const loader = freshLoader();
    const controllerA = new AbortController();
    const a = loader.load(reference, { fetchImpl: world.fetchImpl, signal: controllerA.signal });
    const b = loader.load(reference, { fetchImpl: world.fetchImpl });
    await vi.waitFor(() => expect(world.downloads).toBe(1));

    controllerA.abort();
    expect(await a).toEqual({ ok: false, phase: "fetch", reason: "aborted" });
    expect(world.calls[1].init?.signal?.aborted).toBe(false);

    hold.open();
    expect(await b).toMatchObject({ ok: true, bundle: bundleText(1) });
    expect(world.apiCalls).toBe(1);
    expect(world.downloads).toBe(1);

    // The bundle was cached by the load that B waited for.
    expect((await loader.load(reference)).ok).toBe(true);
  });

  it("the first caller aborting does not disturb a caller that joined later", async () => {
    const hold = gate();
    const { bytes, reference } = lessonCase();
    const world = createWorld(reference, bytes, {
      reader: async ({ n }) => {
        await hold.promise;
        return Response.json(readerBody(reference, presigned(n)));
      },
    });
    const loader = freshLoader();
    const first = new AbortController();
    const a = loader.load(reference, { fetchImpl: world.fetchImpl, signal: first.signal });
    const b = loader.load(reference, { fetchImpl: world.fetchImpl });
    await vi.waitFor(() => expect(world.apiCalls).toBe(1));
    first.abort();
    expect(await a).toEqual({ ok: false, phase: "urls", reason: "aborted" });
    hold.open();
    expect((await b).ok).toBe(true);
  });

  it("the network is cancelled when the last caller leaves, and a later call starts again", async () => {
    const hold = gate();
    const { bytes, reference } = lessonCase();
    const world = createWorld(reference, bytes, {
      bundle: async ({ n }) => {
        if (n === 1) await hold.promise;
        return new Response(bytes);
      },
    });
    const loader = freshLoader();
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const a = loader.load(reference, { fetchImpl: world.fetchImpl, signal: controllerA.signal });
    const b = loader.load(reference, { fetchImpl: world.fetchImpl, signal: controllerB.signal });
    await vi.waitFor(() => expect(world.downloads).toBe(1));

    controllerA.abort();
    expect(world.calls[1].init?.signal?.aborted).toBe(false);
    controllerB.abort();
    expect(await a).toEqual({ ok: false, phase: "fetch", reason: "aborted" });
    expect(await b).toEqual({ ok: false, phase: "fetch", reason: "aborted" });
    expect(world.calls[1].init?.signal?.aborted).toBe(true);

    const again = await loader.load(reference, { fetchImpl: world.fetchImpl });
    expect(again.ok).toBe(true);
    expect(world.apiCalls).toBe(2);
    hold.open();
  });

  it("a caller whose signal is already aborted does not join and does not keep the load alive", async () => {
    const hold = gate();
    const { bytes, reference } = lessonCase();
    const world = createWorld(reference, bytes, {
      bundle: async () => {
        await hold.promise;
        return new Response(bytes);
      },
    });
    const loader = freshLoader();
    const a = loader.load(reference, { fetchImpl: world.fetchImpl });
    await vi.waitFor(() => expect(world.downloads).toBe(1));
    const dead = new AbortController();
    dead.abort();
    expect(await loader.load(reference, { fetchImpl: world.fetchImpl, signal: dead.signal })).toEqual({
      ok: false,
      phase: "urls",
      reason: "aborted",
    });
    hold.open();
    expect((await a).ok).toBe(true);
    expect(world.downloads).toBe(1);
  });

  it("a failed load is released: every waiter gets the failure and the next call starts again", async () => {
    const { reference, world } = lessonCase({ bundle: () => new Response("x", { status: 500 }) });
    const loader = freshLoader();
    const results = await Promise.all([
      loader.load(reference, { fetchImpl: world.fetchImpl }),
      loader.load(reference, { fetchImpl: world.fetchImpl }),
    ]);
    expect(results).toEqual([
      { ok: false, phase: "fetch", reason: "status" },
      { ok: false, phase: "fetch", reason: "status" },
    ]);
    expect(world.downloads).toBe(1);

    await loader.load(reference, { fetchImpl: world.fetchImpl });
    expect(world.downloads).toBe(2);
  });

  it("a finished load is released: with the cache cleared the next call loads again", async () => {
    const { reference, world } = lessonCase();
    const loader = freshLoader();
    await loader.load(reference, { fetchImpl: world.fetchImpl });
    loader.clear();
    await loader.load(reference, { fetchImpl: world.fetchImpl });
    expect(world.downloads).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 9. No presigned URL anywhere
// ---------------------------------------------------------------------------

describe("no address in results or logs", () => {
  const failing: Array<[string, (reference: AnimationReference, bytes: Uint8Array) => WorldOptions]> = [
    ["API status", () => ({ reader: () => new Response("{}", { status: 503 }) })],
    ["API network", () => ({ reader: () => Promise.reject(new TypeError("https://x/?X-Amz-Signature=1")) })],
    ["http address", (r) => ({ reader: () => Response.json(readerBody(r, presigned(1, "http"))) })],
    ["download status", () => ({ bundle: () => new Response("", { status: 500 }) })],
    [
      "download network",
      () => ({ bundle: () => Promise.reject(new TypeError(`failed ${presigned(1)}`)) }),
    ],
    ["hash mismatch", () => ({ bundle: () => new Response("other") })],
    [
      "too large",
      () => ({ bundle: () => new Response("x", { headers: { "Content-Length": String(MAX_BYTES + 1) } }) }),
    ],
  ];

  it.each(failing)("%s", async (_name, make) => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    const bytes = encoder.encode(bundleText(1));
    const reference = referenceFor(bytes);
    const world = createWorld(reference, bytes, make(reference, bytes));
    const result = await freshLoader().load(reference, { fetchImpl: world.fetchImpl });
    expectClosedFailure(result);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("an aborted result and a timeout result are clean too", async () => {
    vi.useFakeTimers();
    const { reference, world } = lessonCase({ bundle: () => new Promise<Response>(() => undefined) });
    const controller = new AbortController();
    const aborted = freshLoader().load(reference, { fetchImpl: world.fetchImpl, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expectClosedFailure(await aborted);

    const timed = freshLoader().load(reference, { fetchImpl: world.fetchImpl });
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS);
    expectClosedFailure(await timed);
  });

  it("a success result has only bundle, meta and runtimeMismatch", async () => {
    const { reference, world } = lessonCase();
    const result = await freshLoader().load(reference, { fetchImpl: world.fetchImpl });
    expect(Object.keys(result).sort()).toEqual(["bundle", "meta", "ok", "runtimeMismatch"]);
  });
});

// ---------------------------------------------------------------------------
// 10. Robustness
// ---------------------------------------------------------------------------

describe("robustness", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "reference"],
    ["an empty object", {}],
    ["an array", []],
    ["a path in animation_id", { ...referenceFor(encoder.encode("x")), animation_id: "../../etc/passwd" }],
    ["a bad bundle hash", { ...referenceFor(encoder.encode("x")), bundle_sha256: "abc" }],
  ])("%s as a reference is urls / invalid_body, with no request and no throw", async (_name, bad) => {
    const world = createWorld(referenceFor(encoder.encode("x")), encoder.encode("x"));
    const result = await freshLoader().load(bad as unknown as AnimationReference, { fetchImpl: world.fetchImpl });
    expect(result).toEqual({ ok: false, phase: "urls", reason: "invalid_body" });
    expect(world.calls).toHaveLength(0);
  });

  it("a fetchImpl that throws instead of rejecting is a network failure", async () => {
    const { reference } = lessonCase();
    const fetchImpl = (() => {
      throw new Error("sync boom");
    }) as unknown as typeof fetch;
    expect(await freshLoader().load(reference, { fetchImpl })).toEqual({
      ok: false,
      phase: "urls",
      reason: "network",
    });
  });

  it("without a fetchImpl it uses the global fetch, looked up when the request is made", async () => {
    const { reference, world } = lessonCase();
    vi.stubGlobal("fetch", world.fetchImpl);
    const result = await freshLoader().load(reference);
    expect(result.ok).toBe(true);
    expect(world.calls).toHaveLength(2);
  });

  it("a missing global fetch is a network failure, not an exception", async () => {
    const { reference } = lessonCase();
    vi.stubGlobal("fetch", undefined);
    expect(await freshLoader().load(reference)).toEqual({ ok: false, phase: "urls", reason: "network" });
  });

  it("the page-wide loadAnimation shares its cache across calls until clearAnimationCache", async () => {
    const { reference, world } = lessonCase();
    expect((await loadAnimation(reference, { fetchImpl: world.fetchImpl })).ok).toBe(true);
    expect(world.calls).toHaveLength(2);
    expect((await loadAnimation(reference, { fetchImpl: world.fetchImpl })).ok).toBe(true);
    expect(world.calls).toHaveLength(2);
    clearAnimationCache();
    expect((await loadAnimation(reference, { fetchImpl: world.fetchImpl })).ok).toBe(true);
    expect(world.calls).toHaveLength(4);
  });

  it("never rejects, whatever the answers look like", async () => {
    const bytes = encoder.encode(bundleText(1));
    const reference = referenceFor(bytes);
    const answers: Array<() => Response | Promise<Response>> = [
      () => Response.json([]),
      () => Response.json(null),
      () => Response.json("text"),
      () => new Response(null, { status: 200 }),
      () => Promise.reject("not an Error"),
      () => Promise.reject(undefined),
    ];
    for (const answer of answers) {
      const world = createWorld(reference, bytes, { reader: answer });
      const result = await freshLoader().load(reference, { fetchImpl: world.fetchImpl });
      expectClosedFailure(result);
    }
  });
});
