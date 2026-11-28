/**
 * Tests: `createAnimation`, the client of `POST /api/v1/ai/animations` (task 22.3).
 *
 * Covers Requirements 25.1 and 25.3 to 25.11, and 17.4:
 *
 *   1. the request: one POST with the right URL, headers, credentials, body and signal;
 *   2. success: `done` gives `{ ok: true, ... }` from its own payload, `onEvent` sees the valid
 *      events in order, unknown events and comments are ignored, the reader is cancelled, and
 *      bytes after the final event are not read. The shared stream fixture
 *      `backend/tests/fixtures/animation/sse-stream.txt` must give `ok: true` (2 attempts) and its
 *      `notice` event must not reach `onEvent`, whatever the chunk size;
 *   3. a status other than 200: the envelope's code and message, `Retry-After` on a 429 only, and
 *      `UNEXPECTED` for anything that is not an envelope;
 *   4. a stream that does not finish: no body, no final event, a read error, an `error` event, a
 *      `done` or `error` event that does not validate, broken progress events that are skipped;
 *   5. the signal: cancelled before, during the request, during the stream and inside `onEvent`;
 *      `ABORTED` wins over `NETWORK` and `STREAM_INTERRUPTED`, also with a `fetch` that ignores it;
 *   6. a throwing `onEvent`, no timer of its own, and a result that is always valid.
 *
 * The test double is a real `Response` around a `ReadableStream`, so the code under test runs on the
 * same stream, header and decoder types as in the browser. Cutting the stream at EVERY offset is the
 * property test of task 22.2 and is not done here; only a few fixed chunk sizes are.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAnimation } from "@/lib/animation/animation-client";
import {
  type AnimationEvent,
  AnimationResultSchema,
} from "@/lib/contracts/animation-events";
import { BUILD_MESSAGES, messageForCode } from "@/lib/contracts/error-messages";
import { AnimationReferenceSchema } from "@/lib/contracts/schemas/animation.schema";
import type { CreateAnimationRequest } from "@/lib/types/animation";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DIR = join(__dirname, "..", "..", "..", "backend", "tests", "fixtures", "animation");
const loadJson = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(DIR, name), "utf8")) as Record<string, unknown>;

const STREAM_BYTES = new Uint8Array(readFileSync(join(DIR, "sse-stream.txt")));
const REQUEST = loadJson("request-valid-puzzle-full.json") as unknown as CreateAnimationRequest;
const LESSON_REFERENCE = loadJson("reference-valid-lesson.json");
/** What a valid `done` becomes after the strict reference schema (unknown keys dropped). */
const LESSON_EXPECTED = AnimationReferenceSchema.parse(LESSON_REFERENCE);

const STARTED = { max_attempts: 4, deadline_ms: 240000, cached: false };
const stage = (name: string, attempt: number) => ({ stage: name, attempt });
const DIAGNOSTICS = {
  attempt: 1,
  ok: false,
  error_count: 1,
  warning_count: 0,
  items: [{ tool: "tsc", code: "TSC_2322", line: 7 }],
};
const DONE = { animation: LESSON_REFERENCE, cached: false, attempts: 2 };
const ERROR_PAYLOAD = {
  code: "ANIMATION_VERIFICATION_FAILED",
  message: "The animation could not be verified. The lesson will use the standard drawing.",
  attempts: 4,
};

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);

/** One event as the backend writes it. */
const ev = (event: string, payload: unknown, nl = "\n"): string =>
  `event: ${event}${nl}data: ${JSON.stringify(payload)}${nl}${nl}`;

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type Piece = string | Uint8Array;

interface StreamOptions {
  /** Leave the stream open after the pieces (a server that keeps the connection). */
  keepOpen?: boolean;
  /** Called when the reader cancels the stream. */
  onCancel?: () => void;
  /** Error the stream the way a real `fetch` does when the signal aborts. */
  signal?: AbortSignal;
}

function streamOf(pieces: Piece[], options: StreamOptions = {}): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) {
        controller.enqueue(typeof piece === "string" ? bytes(piece) : piece);
      }
      if (options.keepOpen !== true) controller.close();
      options.signal?.addEventListener(
        "abort",
        () => controller.error(new DOMException("The operation was aborted.", "AbortError")),
        { once: true },
      );
    },
    cancel() {
      options.onCancel?.();
    },
  });
}

const sse = (pieces: Piece[], options: StreamOptions = {}, init: ResponseInit = {}): Response =>
  new Response(streamOf(pieces, options), {
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8" },
    ...init,
  });

/** A backend error envelope. */
const envelope = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ ok: false, error: { code, message, detail: [] } }), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

/** A `fetchImpl` that records its calls and answers with what `answer` returns. */
function fakeFetch(answer: (init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return answer(call.init);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Runs `createAnimation` against one response and checks the result is always a valid result. */
async function call(
  respond: () => Response | Promise<Response>,
  options: { signal?: AbortSignal; onEvent?: (e: AnimationEvent) => void } = {},
) {
  const { fetchImpl, calls } = fakeFetch(respond);
  const result = await createAnimation(REQUEST, { fetchImpl, ...options });
  expect(AnimationResultSchema.safeParse(result).success).toBe(true);
  return { result, calls };
}

/** Collects the names of the events `onEvent` receives. */
function recorder() {
  const events: AnimationEvent[] = [];
  return { events, onEvent: (e: AnimationEvent) => void events.push(e), names: () => events.map((e) => e.event) };
}

/** Lets the pending promises of the code under test run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const SUCCESS_TEXT = [
  ev("started", STARTED),
  ev("stage", stage("generating", 1)),
  ev("stage", stage("verifying", 1)),
  ev("diagnostics", DIAGNOSTICS),
  ev("stage", stage("publishing", 1)),
  ev("done", DONE),
].join("");

// ---------------------------------------------------------------------------
// 1. The request (Requirement 25.1, 25.9)
// ---------------------------------------------------------------------------

describe("the request", () => {
  it("sends one POST to /api/v1/ai/animations with the headers, credentials, body and signal", async () => {
    const controller = new AbortController();
    const { result, calls } = await call(() => sse([SUCCESS_TEXT]), { signal: controller.signal });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe("/api/v1/ai/animations");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    });
    expect(init.signal).toBe(controller.signal);
    expect(JSON.parse(init.body as string)).toEqual(REQUEST);
  });

  it("works without any option but `fetchImpl`", async () => {
    const { fetchImpl } = fakeFetch(() => sse([SUCCESS_TEXT]));
    const result = await createAnimation(REQUEST, { fetchImpl });
    expect(result.ok).toBe(true);
  });

  it("uses the global fetch when no `fetchImpl` is given", async () => {
    const original = globalThis.fetch;
    const spy = vi.fn(async () => sse([SUCCESS_TEXT]));
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const result = await createAnimation(REQUEST);
      expect(result.ok).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Success (Requirement 25.3, 25.6, 25.8, 17.4)
// ---------------------------------------------------------------------------

describe("success", () => {
  it("returns animation, cached and attempts from the `done` payload, not from `started`", async () => {
    const text = ev("started", { ...STARTED, cached: false }) + ev("done", { ...DONE, cached: true, attempts: 3 });
    const { result } = await call(() => sse([text]));
    expect(result).toStrictEqual({ ok: true, animation: LESSON_EXPECTED, cached: true, attempts: 3 });
  });

  it("keeps the pause frame of a puzzle reference", async () => {
    const puzzle = loadJson("reference-valid-puzzle.json");
    const { result } = await call(() => sse([ev("started", STARTED) + ev("done", { ...DONE, animation: puzzle })]));
    expect(result.ok && result.animation.pause_at_frame).toBe(puzzle.pause_at_frame);
  });

  it("answers a cache hit, which is only `started` and `done`", async () => {
    const text = ev("started", { ...STARTED, cached: true }) + ev("done", { ...DONE, cached: true, attempts: 1 });
    const { result } = await call(() => sse([text]));
    expect(result).toMatchObject({ ok: true, cached: true, attempts: 1 });
  });

  it("calls onEvent for every valid event in arrival order, the final one included", async () => {
    const seen = recorder();
    await call(() => sse([SUCCESS_TEXT]), { onEvent: seen.onEvent });
    expect(seen.names()).toEqual(["started", "stage", "stage", "diagnostics", "stage", "done"]);
    expect(seen.events[0]).toEqual({ event: "started", data: STARTED });
    expect(seen.events[1]).toEqual({ event: "stage", data: stage("generating", 1) });
    expect(seen.events[3]).toEqual({ event: "diagnostics", data: DIAGNOSTICS });
    expect(seen.events[5]).toEqual({ event: "done", data: { ...DONE, animation: LESSON_EXPECTED } });
  });

  it("ignores unknown event names, default-named events and comment lines", async () => {
    const text = [
      ": ping\n\n",
      ev("started", STARTED),
      ev("notice", { text: "hello" }),
      "data: {}\n\n", // an event with no name is `message`
      ": ping\r\n\r\n",
      "id: 4\nretry: 1000\nevent: stage\ndata: " + JSON.stringify(stage("generating", 1)) + "\n\n",
      ev("done", DONE),
    ].join("");
    const seen = recorder();
    const { result } = await call(() => sse([text]), { onEvent: seen.onEvent });
    expect(result.ok).toBe(true);
    expect(seen.names()).toEqual(["started", "stage", "done"]);
  });

  it("reads the same result from CRLF and CR line ends", async () => {
    for (const nl of ["\r\n", "\r"]) {
      const text = ev("started", STARTED, nl) + ev("done", DONE, nl) + ": end" + nl + nl;
      const { result } = await call(() => sse([text]));
      expect(result, JSON.stringify(nl)).toMatchObject({ ok: true, attempts: 2 });
    }
  });

  it("returns the first final event and ignores every byte after it (Requirement 25.8)", async () => {
    const text =
      ev("started", STARTED) +
      ev("done", { ...DONE, attempts: 1 }) +
      ev("done", { ...DONE, attempts: 4 }) +
      ev("error", ERROR_PAYLOAD) +
      ev("stage", stage("generating", 1));
    const seen = recorder();
    const { result } = await call(() => sse([text]), { onEvent: seen.onEvent });
    expect(result).toMatchObject({ ok: true, attempts: 1 });
    expect(seen.names()).toEqual(["started", "done"]);
  });

  it("ignores a later chunk that is not even valid text", async () => {
    const { result } = await call(() =>
      sse([ev("started", STARTED) + ev("done", DONE), new Uint8Array([0xff, 0xfe, 0x00, 0xc3])]),
    );
    expect(result).toMatchObject({ ok: true, attempts: 2 });
  });

  it("cancels the reader on `done` and does not wait for the stream to close", async () => {
    const onCancel = vi.fn();
    const { result } = await call(() => sse([SUCCESS_TEXT], { keepOpen: true, onCancel }));
    expect(result.ok).toBe(true);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("the shared stream fixture sse-stream.txt (Requirement 25.3, 25.7)", () => {
  const expectedNames = [
    "started",
    "stage",
    "stage",
    "diagnostics",
    "stage",
    "stage",
    "diagnostics",
    "stage",
    "done",
  ];

  it("gives ok: true after 2 attempts and skips the `notice` event", async () => {
    const seen = recorder();
    const { result } = await call(() => sse([STREAM_BYTES]), { onEvent: seen.onEvent });
    expect(result).toStrictEqual({
      ok: true,
      animation: {
        animation_id: "3f8e2b1c-6d4a-4e5f-9a7b-0c1d2e3f4a5b",
        source_sha256: "a27321c1c0f1407c835394676fb809e185474ec0c0ce213e0c7cffedfa857750",
        bundle_sha256: "9aecee4acec55281859c57184dec790783d3c59b71aaf923de28e1d8b0dc9b73",
        width: 1280,
        height: 720,
        fps: 30,
        duration_in_frames: 150,
        contract_version: 1,
      },
      cached: false,
      attempts: 2,
    });
    expect(seen.names()).toEqual(expectedNames);
    expect(seen.names()).not.toContain("notice");
  });

  // Not every offset (that is task 22.2): one byte at a time puts a cut inside every multi-byte
  // character and between the `\r` and `\n` of every CRLF; the other sizes cut at odd places.
  it.each([1, 2, 3, 7, 64, STREAM_BYTES.length])("gives the same result in chunks of %i bytes", async (size) => {
    const pieces: Uint8Array[] = [];
    for (let i = 0; i < STREAM_BYTES.length; i += size) pieces.push(STREAM_BYTES.slice(i, i + size));
    const whole = await call(() => sse([STREAM_BYTES]));
    const seen = recorder();
    const { result } = await call(() => sse(pieces), { onEvent: seen.onEvent });
    expect(result).toStrictEqual(whole.result);
    expect(seen.names()).toEqual(expectedNames);
  });

  it("reads a multi-byte character that a chunk boundary cuts in half", async () => {
    const message = "Animasi \u65e5\u672c\u8a9e \u{1F600} gagal";
    const encoded = bytes(ev("error", { code: "ANIMATION_TIMEOUT", message, attempts: 1 }));
    const at = encoded.indexOf(0xf0) + 2; // inside the 4-byte emoji
    const { result } = await call(() => sse([encoded.slice(0, at), encoded.slice(at)]));
    expect(result).toStrictEqual({ ok: false, code: "ANIMATION_TIMEOUT", message });
  });
});

// ---------------------------------------------------------------------------
// 3. A status other than 200 (Requirement 25.4)
// ---------------------------------------------------------------------------

describe("a status other than 200", () => {
  it.each([
    [400, "INVALID_REQUEST", "The request was not valid."],
    [413, "INVALID_REQUEST", "Body too large."],
    [503, "ANIMATION_NOT_CONFIGURED", "Animations are not set up."],
    [503, "PROVIDER_NOT_CONFIGURED", "No key."],
    [500, "UNKNOWN", "Something broke."],
  ])("returns the envelope's code and message for %i %s", async (status, code, message) => {
    const { result } = await call(() => envelope(status, code, message));
    expect(result).toStrictEqual({ ok: false, code, message });
  });

  it("does not read the body of such an answer as a stream and never calls onEvent", async () => {
    const seen = recorder();
    const { result } = await call(() => envelope(400, "INVALID_REQUEST", "x"), { onEvent: seen.onEvent });
    expect(result.ok).toBe(false);
    expect(seen.events).toEqual([]);
  });

  it.each([
    ["7", 7],
    ["0", 0],
    [" 30 ", 30],
    ["120", 120],
  ])("gives retryAfterSeconds for a 429 with Retry-After %j", async (header, seconds) => {
    const { result } = await call(() => envelope(429, "RATE_LIMITED", "Slow down.", { "Retry-After": header }));
    expect(result).toStrictEqual({ ok: false, code: "RATE_LIMITED", message: "Slow down.", retryAfterSeconds: seconds });
  });

  it.each([
    ["no header", undefined],
    ["a negative number", "-1"],
    ["a fraction", "1.5"],
    ["text", "soon"],
    ["a number with text", "5 seconds"],
    ["an HTTP date", "Wed, 21 Oct 2026 07:28:00 GMT"],
    ["an empty value", ""],
    ["an exponent", "1e3"],
    ["a number too large for a safe integer", "99999999999999999999"],
  ])("leaves retryAfterSeconds out for a 429 with %s", async (_label, header) => {
    const headers: Record<string, string> = header === undefined ? {} : { "Retry-After": header };
    const { result } = await call(() => envelope(429, "RATE_LIMITED", "Slow down.", headers));
    expect(result).toStrictEqual({ ok: false, code: "RATE_LIMITED", message: "Slow down." });
    expect(Object.keys(result)).not.toContain("retryAfterSeconds");
  });

  it("does not copy Retry-After from a status other than 429", async () => {
    const { result } = await call(() => envelope(503, "TIMEOUT", "Busy.", { "Retry-After": "9" }));
    expect(result).toStrictEqual({ ok: false, code: "TIMEOUT", message: "Busy." });
  });

  it.each([
    ["an HTML page", () => new Response("<html>Bad gateway</html>", { status: 502 })],
    ["an empty body", () => new Response(null, { status: 500 })],
    ["JSON that is not an object", () => new Response("[1,2]", { status: 400 })],
    ["null", () => new Response("null", { status: 400 })],
    ["an object with no `ok`", () => new Response('{"error":{"code":"X","message":"m"}}', { status: 400 })],
    ["`ok: true`", () => new Response('{"ok":true,"data":{}}', { status: 400 })],
    ["no error object", () => new Response('{"ok":false}', { status: 400 })],
    ["an error without a message", () => new Response('{"ok":false,"error":{"code":"X"}}', { status: 400 })],
    ["an error without a code", () => new Response('{"ok":false,"error":{"message":"m"}}', { status: 400 })],
    ["an empty code", () => new Response('{"ok":false,"error":{"code":"","message":"m"}}', { status: 400 })],
    ["a numeric code", () => new Response('{"ok":false,"error":{"code":7,"message":"m"}}', { status: 400 })],
    ["a 202 that carries a stream", () => sse([SUCCESS_TEXT], {}, { status: 202 })],
    ["a 204", () => new Response(null, { status: 204 })],
  ])("returns UNEXPECTED for %s", async (_label, respond) => {
    const { result } = await call(respond);
    expect(result).toStrictEqual({ ok: false, code: "UNEXPECTED", message: BUILD_MESSAGES.unexpected });
  });
});

// ---------------------------------------------------------------------------
// 4. A stream that does not finish well (Requirement 25.3, 25.5, 25.8)
// ---------------------------------------------------------------------------

describe("a stream that does not finish", () => {
  const interrupted = {
    ok: false,
    code: "STREAM_INTERRUPTED",
    message: messageForCode("STREAM_INTERRUPTED"),
  };

  it("returns STREAM_INTERRUPTED for a 200 with no body", async () => {
    const { result } = await call(() => new Response(null, { status: 200 }));
    expect(result).toStrictEqual(interrupted);
  });

  it("returns STREAM_INTERRUPTED for an empty stream", async () => {
    const { result } = await call(() => sse([]));
    expect(result).toStrictEqual(interrupted);
  });

  it("returns STREAM_INTERRUPTED when the stream ends without a final event, after calling onEvent", async () => {
    const seen = recorder();
    const text = ev("started", STARTED) + ev("stage", stage("generating", 1)) + ": ping\n\n";
    const { result } = await call(() => sse([text]), { onEvent: seen.onEvent });
    expect(result).toStrictEqual(interrupted);
    expect(seen.names()).toEqual(["started", "stage"]);
  });

  it("drops a final event that never got its closing blank line", async () => {
    const text = ev("started", STARTED) + `event: done\ndata: ${JSON.stringify(DONE)}\n`;
    const { result } = await call(() => sse([text]));
    expect(result).toStrictEqual(interrupted);
  });

  it("returns STREAM_INTERRUPTED when reading the body fails, keeping the events read before", async () => {
    const seen = recorder();
    const { result } = await call(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes(ev("started", STARTED)));
            },
            pull(controller) {
              controller.error(new TypeError("network error"));
            },
          }),
          { status: 200 },
        ),
      { onEvent: seen.onEvent },
    );
    expect(result).toStrictEqual(interrupted);
    expect(seen.names()).toEqual(["started"]);
  });

  it("returns STREAM_INTERRUPTED when the response has no readable body object", async () => {
    const { result } = await call(() => ({ status: 200, headers: new Headers() }) as unknown as Response);
    expect(result).toStrictEqual(interrupted);
  });

  it("returns the error event's code and message", async () => {
    const message = "Animasinya terlalu lama dibuat \u2014 pakai gambar standar. \u{1F600}";
    const text = ev("started", STARTED) + ev("error", { code: "ANIMATION_TIMEOUT", message, attempts: 3 });
    const seen = recorder();
    const { result } = await call(() => sse([text]), { onEvent: seen.onEvent });
    expect(result).toStrictEqual({ ok: false, code: "ANIMATION_TIMEOUT", message });
    expect(seen.names()).toEqual(["started", "error"]);
  });

  it("passes on a code it does not know and cancels the reader", async () => {
    const onCancel = vi.fn();
    const { result } = await call(() =>
      sse([ev("error", { code: "SOMETHING_NEW", message: "m", attempts: 0 })], { keepOpen: true, onCancel }),
    );
    expect(result).toStrictEqual({ ok: false, code: "SOMETHING_NEW", message: "m" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  describe("a final event that does not validate returns UNEXPECTED", () => {
    const unexpected = { ok: false, code: "UNEXPECTED", message: BUILD_MESSAGES.unexpected };
    const bad: [string, string][] = [
      ["`done` that is not JSON", "event: done\ndata: {not json\n\n"],
      ["`done` without an animation", ev("done", { cached: false, attempts: 1 })],
      ["`done` with an uppercase animation id", ev("done", { ...DONE, animation: loadJson("reference-invalid-id-uppercase.json") })],
      ["`done` with fps 24", ev("done", { ...DONE, animation: loadJson("reference-invalid-fps-24.json") })],
      ["`done` with five attempts", ev("done", { ...DONE, attempts: 5 })],
      ["`error` that is not JSON", "event: error\ndata: oops\n\n"],
      ["`error` with an empty code", ev("error", { ...ERROR_PAYLOAD, code: "" })],
      ["`error` without a message", ev("error", { code: "X", attempts: 0 })],
    ];
    it.each(bad)("for a %s, without calling onEvent for it", async (_label, tail) => {
      const text = ev("started", STARTED) + tail;
      const seen = recorder();
      const { result } = await call(() => sse([text]), { onEvent: seen.onEvent });
      expect(result).toStrictEqual(unexpected);
      expect(seen.names()).toEqual(["started"]);
    });

    it("and does not read what comes after it", async () => {
      const text = ev("started", STARTED) + ev("done", { ...DONE, attempts: 9 }) + ev("done", DONE);
      const { result } = await call(() => sse([text]));
      expect(result).toStrictEqual(unexpected);
    });

    it("but an event with no data line is dropped by the parser, so a good `done` after it counts", async () => {
      const text = ev("started", STARTED) + "event: done\n\n" + ev("done", DONE);
      const { result } = await call(() => sse([text]));
      expect(result).toMatchObject({ ok: true, attempts: 2 });
    });
  });

  it("skips a progress event whose payload is not JSON or fails the schema, without calling onEvent", async () => {
    const text = [
      ev("started", STARTED),
      "event: stage\ndata: {broken\n\n",
      ev("stage", { stage: "dancing", attempt: 1 }),
      ev("stage", { stage: "verifying", attempt: 5 }),
      ev("diagnostics", { ...DIAGNOSTICS, items: Array.from({ length: 11 }, () => DIAGNOSTICS.items[0]) }),
      ev("started", { max_attempts: 0, deadline_ms: 1, cached: false }),
      ev("stage", stage("verifying", 1)),
      ev("done", DONE),
    ].join("");
    const seen = recorder();
    const { result } = await call(() => sse([text]), { onEvent: seen.onEvent });
    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(seen.events.map((e) => e.event)).toEqual(["started", "stage", "done"]);
    expect(seen.events[1]).toEqual({ event: "stage", data: stage("verifying", 1) });
  });
});

// ---------------------------------------------------------------------------
// 5. The signal (Requirement 25.5, 25.9, 25.11)
// ---------------------------------------------------------------------------

describe("the signal", () => {
  const ABORTED = { ok: false, code: "ABORTED", message: expect.any(String) };
  const abortError = () => new DOMException("The operation was aborted.", "AbortError");

  it("returns ABORTED without calling fetchImpl when it is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetchImpl, calls } = fakeFetch(() => sse([SUCCESS_TEXT]));
    const result = await createAnimation(REQUEST, { fetchImpl, signal: controller.signal });
    expect(result).toStrictEqual(ABORTED);
    expect(calls).toHaveLength(0);
  });

  it("returns ABORTED when the signal aborts during the request and fetch rejects", async () => {
    const controller = new AbortController();
    const { fetchImpl } = fakeFetch(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(abortError()));
        }),
    );
    const pending = createAnimation(REQUEST, { fetchImpl, signal: controller.signal });
    await settle();
    controller.abort();
    expect(await pending).toStrictEqual(ABORTED);
  });

  it("returns ABORTED at once even when fetch ignores the signal and never answers", async () => {
    const controller = new AbortController();
    const { fetchImpl } = fakeFetch(() => new Promise<Response>(() => undefined));
    const pending = createAnimation(REQUEST, { fetchImpl, signal: controller.signal });
    await settle();
    controller.abort();
    expect(await pending).toStrictEqual(ABORTED);
  });

  it("returns ABORTED, not NETWORK, when fetch rejects and the signal is aborted", async () => {
    const controller = new AbortController();
    const { fetchImpl } = fakeFetch(() => {
      controller.abort();
      return Promise.reject(new TypeError("Failed to fetch"));
    });
    expect(await createAnimation(REQUEST, { fetchImpl, signal: controller.signal })).toStrictEqual(ABORTED);
  });

  it("returns ABORTED when the signal aborts while the stream is being read", async () => {
    const controller = new AbortController();
    const seen = recorder();
    const { fetchImpl } = fakeFetch((init) => sse([ev("started", STARTED)], { keepOpen: true, signal: init.signal ?? undefined }));
    const pending = createAnimation(REQUEST, { fetchImpl, signal: controller.signal, onEvent: seen.onEvent });
    await settle();
    expect(seen.names()).toEqual(["started"]);
    controller.abort();
    expect(await pending).toStrictEqual(ABORTED);
  });

  it("returns ABORTED, not STREAM_INTERRUPTED, when the read fails because of the abort", async () => {
    const controller = new AbortController();
    // A reader whose read rejects, as a real one does after an abort, with the signal already aborted.
    const reader = {
      read: () => {
        controller.abort();
        return Promise.reject(new TypeError("terminated"));
      },
      cancel: vi.fn(async () => undefined),
    };
    const { fetchImpl } = fakeFetch(
      () => ({ status: 200, headers: new Headers(), body: { getReader: () => reader } }) as unknown as Response,
    );
    expect(await createAnimation(REQUEST, { fetchImpl, signal: controller.signal })).toStrictEqual(ABORTED);
  });

  it("returns ABORTED at once when the stream ignores the signal and stays silent, and cancels the reader", async () => {
    const controller = new AbortController();
    const onCancel = vi.fn();
    const { fetchImpl } = fakeFetch(() => sse([ev("started", STARTED)], { keepOpen: true, onCancel }));
    const pending = createAnimation(REQUEST, { fetchImpl, signal: controller.signal });
    await settle();
    controller.abort();
    expect(await pending).toStrictEqual(ABORTED);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("returns ABORTED while the envelope of an error answer is being read", async () => {
    const controller = new AbortController();
    const { fetchImpl } = fakeFetch(
      () =>
        ({
          status: 400,
          headers: new Headers(),
          json: () => new Promise(() => undefined),
        }) as unknown as Response,
    );
    const pending = createAnimation(REQUEST, { fetchImpl, signal: controller.signal });
    await settle();
    controller.abort();
    expect(await pending).toStrictEqual(ABORTED);
  });

  it("returns ABORTED and stops calling onEvent when onEvent aborts in the middle of a chunk", async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    const onEvent = (e: AnimationEvent) => {
      seen.push(e.event);
      if (e.event === "started") controller.abort();
    };
    const { fetchImpl } = fakeFetch(() => sse([SUCCESS_TEXT]));
    const result = await createAnimation(REQUEST, { fetchImpl, signal: controller.signal, onEvent });
    expect(result).toStrictEqual(ABORTED);
    expect(seen).toEqual(["started"]);
  });

  it("returns ABORTED when the signal is aborted by a time limit (the caller's 270000 ms)", async () => {
    const controller = new AbortController();
    const { fetchImpl } = fakeFetch((init) => sse([ev("started", STARTED)], { keepOpen: true, signal: init.signal ?? undefined }));
    const pending = createAnimation(REQUEST, { fetchImpl, signal: controller.signal });
    await settle();
    controller.abort(new DOMException("timed out", "TimeoutError"));
    expect(await pending).toStrictEqual(ABORTED);
  });

  it("is not changed by an abort that comes after the result", async () => {
    const controller = new AbortController();
    const { fetchImpl } = fakeFetch(() => sse([SUCCESS_TEXT]));
    const result = await createAnimation(REQUEST, { fetchImpl, signal: controller.signal });
    controller.abort();
    expect(result.ok).toBe(true);
  });

  it("removes its listener from the signal when it is done", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const { fetchImpl } = fakeFetch(() => sse([SUCCESS_TEXT]));
    await createAnimation(REQUEST, { fetchImpl, signal: controller.signal });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

// ---------------------------------------------------------------------------
// 6. NETWORK, onEvent that throws, timers, and never throwing
// ---------------------------------------------------------------------------

describe("failures of the request itself", () => {
  const network = { ok: false, code: "NETWORK", message: messageForCode("NETWORK") };

  it("returns NETWORK when fetch rejects", async () => {
    const { fetchImpl } = fakeFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await createAnimation(REQUEST, { fetchImpl })).toStrictEqual(network);
  });

  it("returns NETWORK when fetchImpl throws instead of rejecting", async () => {
    const fetchImpl = vi.fn(() => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    expect(await createAnimation(REQUEST, { fetchImpl })).toStrictEqual(network);
  });

  it("returns UNEXPECTED and does not call fetchImpl when the request cannot be serialised", async () => {
    const { fetchImpl, calls } = fakeFetch(() => sse([SUCCESS_TEXT]));
    const circular: Record<string, unknown> = {};
    circular.self = circular; // JSON.stringify throws on a cycle
    const unserialisable = { ...REQUEST, visual: circular } as unknown as CreateAnimationRequest;
    expect(await createAnimation(unserialisable, { fetchImpl })).toStrictEqual({
      ok: false,
      code: "UNEXPECTED",
      message: BUILD_MESSAGES.unexpected,
    });
    expect(calls).toHaveLength(0);
  });
});

describe("onEvent that throws (Requirement 25.10)", () => {
  it("is swallowed: later events are still delivered and the result is the same", async () => {
    const quiet = await call(() => sse([SUCCESS_TEXT]));
    const names: string[] = [];
    const { result } = await call(() => sse([SUCCESS_TEXT]), {
      onEvent: (e) => {
        names.push(e.event);
        throw new Error("listener broke");
      },
    });
    expect(result).toStrictEqual(quiet.result);
    expect(names).toEqual(["started", "stage", "stage", "diagnostics", "stage", "done"]);
  });

  it("does not hide an `error` event", async () => {
    const { result } = await call(() => sse([ev("started", STARTED) + ev("error", ERROR_PAYLOAD)]), {
      onEvent: () => {
        throw new Error("listener broke");
      },
    });
    expect(result).toStrictEqual({ ok: false, code: ERROR_PAYLOAD.code, message: ERROR_PAYLOAD.message });
  });
});

describe("no timer of its own (Requirement 25.11)", () => {
  it("never calls setTimeout or setInterval", async () => {
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const interval = vi.spyOn(globalThis, "setInterval");
    try {
      await call(() => sse([STREAM_BYTES]));
      await call(() => envelope(429, "RATE_LIMITED", "x", { "Retry-After": "3" }));
      await call(() => sse([ev("started", STARTED)]));
      expect(timeout).not.toHaveBeenCalled();
      expect(interval).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
      interval.mockRestore();
    }
  });
});
