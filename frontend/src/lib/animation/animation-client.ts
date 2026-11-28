/**
 * `createAnimation`: the client of `POST /api/v1/ai/animations` (design 7.3, Requirement 25).
 *
 * The endpoint answers with a Server-Sent Events stream (progress events, then exactly one `done`
 * or `error`). This module sends the request, reads the stream, and returns one result that
 * always has a defined shape, so the generation flow never has to handle an exception or a
 * half-read stream:
 *
 *   { ok: true, animation, cached, attempts }
 *   { ok: false, code, message, retryAfterSeconds? }
 *
 * Failure codes come from two places. A server code (`RATE_LIMITED`, `ANIMATION_QUOTA_EXCEEDED`,
 * `ANIMATION_TIMEOUT`, ...) is passed through as it arrived. The client adds four of its own:
 * `ABORTED` (the caller's signal fired), `NETWORK` (no response), `STREAM_INTERRUPTED` (the stream
 * ended or broke before a final event), and `UNEXPECTED` (a response that is not what the contract
 * says). `ABORTED` wins over the other two client codes when the signal is aborted, because an
 * aborted fetch also looks like a network error and an interrupted stream.
 *
 * How the stream is read:
 * - Bytes are decoded with one streaming `TextDecoder`, so a multi-byte character cut between two
 *   chunks is put back together, and the text goes to the incremental parser in `sse-parser.ts`.
 * - Each event is read with `readAnimationEvent` (Zod). A `started`, `stage`, or `diagnostics`
 *   event with a broken payload is skipped without a call to `onEvent`. A broken `done` or `error`
 *   ends the call with `UNEXPECTED`, because the result cannot be trusted. Other event names (a
 *   newer backend may add some) and comment lines (`: ping`) are ignored.
 * - `onEvent` gets every valid event in arrival order, the final one included. If it throws, the
 *   error is swallowed and reading goes on (Requirement 25.10).
 * - The first valid `done` or `error` ends the call. The reader is cancelled so the connection is
 *   released, and anything after that event is ignored.
 *
 * There is no timer in this file (Requirement 25.11). The 270000 ms limit per target belongs to
 * the caller, which aborts the signal it passes in. The signal is also raced against every wait
 * (response, body, stream read), so the call returns `ABORTED` at once even when a `fetch`
 * implementation does not reject on abort.
 *
 * It does not validate `request` (the caller builds it with `buildAnimationRequest`, and the
 * server checks it again), and it never puts the request or a URL in a result.
 */

import {
  type AnimationEvent,
  type AnimationResult,
  readAnimationEvent,
} from "@/lib/contracts/animation-events";
import { BUILD_MESSAGES, messageForCode } from "@/lib/contracts/error-messages";
import { aiUrl } from "@/lib/generation/ai-endpoints";
import type { CreateAnimationRequest } from "@/lib/types/animation";
import { z } from "zod";
import { createSseParser } from "./sse-parser";

/** Same as `AnimationResult`; the name design 7.3 gives to what `createAnimation` returns. */
export type CreateAnimationResult = AnimationResult;

export interface CreateAnimationOptions {
  /** Aborting it ends the call with `ABORTED`. The caller owns any time limit. */
  signal?: AbortSignal;
  /** Replaces the global `fetch` (tests). */
  fetchImpl?: typeof fetch;
  /** Called for every valid event, in order. Exceptions it throws are swallowed. */
  onEvent?: (event: AnimationEvent) => void;
}

type Failure = Extract<AnimationResult, { ok: false }>;

/**
 * Body of a non-200 answer. Only `code` and `message` are read; the backend also sends `detail`.
 * A body without both is not an envelope, so the call ends with `UNEXPECTED`.
 */
const ErrorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string().min(1), message: z.string() }),
});

/** Shown for `ABORTED`. The caller chose to cancel, so the generation flow does not display it. */
const ABORTED_MESSAGE = "The animation request was cancelled.";

// A fresh object per call, so a caller that changes a result cannot change the next one.
const failure = (code: string, message: string, retryAfterSeconds?: number): Failure =>
  retryAfterSeconds === undefined
    ? { ok: false, code, message }
    : { ok: false, code, message, retryAfterSeconds };
const aborted = (): Failure => failure("ABORTED", ABORTED_MESSAGE);
const network = (): Failure => failure("NETWORK", messageForCode("NETWORK"));
const interrupted = (): Failure =>
  failure("STREAM_INTERRUPTED", messageForCode("STREAM_INTERRUPTED"));
const unexpected = (): Failure => failure("UNEXPECTED", BUILD_MESSAGES.unexpected);

/** What a raced wait resolves to when the signal wins. */
const ABORT: unique symbol = Symbol("abort");

interface AbortGate {
  /** Resolves to `promise`, or to `ABORT` as soon as the signal aborts, whichever is first. */
  guard<T>(promise: Promise<T>): Promise<T | typeof ABORT>;
  /** Removes the listener. Call once the call is over. */
  dispose(): void;
}

function createAbortGate(signal: AbortSignal | undefined): AbortGate {
  if (signal === undefined) return { guard: (promise) => promise, dispose: () => undefined };
  let listener: () => void = () => undefined;
  const fired = new Promise<typeof ABORT>((resolve) => {
    listener = () => resolve(ABORT);
    signal.addEventListener("abort", listener, { once: true });
  });
  return {
    // `Promise.race` also handles a later rejection of the loser, so it is never reported as unhandled.
    guard: (promise) => Promise.race([promise, fired]),
    dispose: () => signal.removeEventListener("abort", listener),
  };
}

/** `Retry-After` as whole seconds, or `undefined` when it is missing or not a whole number >= 0. */
function retryAfterSeconds(headers: Headers): number | undefined {
  const raw = headers.get("Retry-After")?.trim();
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const seconds = Number(raw);
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}

/** Releases the connection. Never throws and never waits for the answer. */
function cancelQuietly(reader: { cancel(): Promise<void> }): void {
  try {
    void Promise.resolve(reader.cancel()).catch(() => undefined);
  } catch {
    // Nothing left to release.
  }
}

/** Calls the listener and drops whatever it throws (Requirement 25.10). */
function emit(onEvent: CreateAnimationOptions["onEvent"], event: AnimationEvent): void {
  if (onEvent === undefined) return;
  try {
    onEvent(event);
  } catch {
    // A faulty listener must not break the stream.
  }
}

/** The answer to a non-200 status: the envelope's code and message, or `UNEXPECTED`. */
async function readFailureEnvelope(
  response: Response,
  gate: AbortGate,
  isAborted: () => boolean,
): Promise<AnimationResult> {
  let json: unknown;
  try {
    const got = await gate.guard<unknown>(response.json());
    if (got === ABORT) return aborted();
    json = got;
  } catch {
    return isAborted() ? aborted() : unexpected();
  }
  if (isAborted()) return aborted();

  const envelope = ErrorEnvelopeSchema.safeParse(json);
  if (!envelope.success) return unexpected();
  const { code, message } = envelope.data.error;
  // Only a 429 carries a wait time; the header on any other status is not used.
  return failure(code, message, response.status === 429 ? retryAfterSeconds(response.headers) : undefined);
}

async function run(
  request: CreateAnimationRequest,
  opts: CreateAnimationOptions,
  gate: AbortGate,
): Promise<AnimationResult> {
  const { signal, onEvent } = opts;
  const isAborted = (): boolean => signal?.aborted === true;

  // 1. Already cancelled: do not touch the network.
  if (isAborted()) return aborted();

  let body: string;
  try {
    body = JSON.stringify(request);
  } catch {
    return unexpected();
  }

  // 2. One POST. `send` is async so a `fetchImpl` that throws instead of rejecting is caught too.
  const send = async (): Promise<Response> => {
    const fetchImpl = opts.fetchImpl ?? fetch;
    return fetchImpl(aiUrl("animations"), {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body,
      signal,
    });
  };
  let response: Response;
  try {
    const got = await gate.guard(send());
    if (got === ABORT) return aborted();
    response = got;
  } catch {
    return isAborted() ? aborted() : network();
  }
  if (isAborted()) return aborted();

  // 3. Anything but 200 is a JSON envelope, not a stream.
  if (response.status !== 200) return readFailureEnvelope(response, gate, isAborted);

  // 4. A 200 without a body has no stream to read.
  const stream = response.body;
  if (!stream) return interrupted();
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = stream.getReader();
  } catch {
    return interrupted();
  }

  const decoder = new TextDecoder("utf-8");
  const parser = createSseParser();

  /** Handles the events that `text` completed. Returns the result once a final event shows up. */
  const consume = (text: string): AnimationResult | undefined => {
    for (const raw of parser.push(text)) {
      // A cancel that arrives while a chunk is being handled must not be followed by more events.
      if (isAborted()) return aborted();
      const read = readAnimationEvent(raw);
      if (!read.ok) {
        // `read.event` is the event name. A final event that cannot be read leaves no result.
        if (read.event === "done" || read.event === "error") return unexpected();
        continue; // unknown name, or a broken progress event: skip it (Requirement 25.3)
      }
      emit(onEvent, read.event);
      if (read.event.event === "done") {
        const { animation, cached, attempts } = read.event.data;
        return { ok: true, animation, cached, attempts };
      }
      if (read.event.event === "error") {
        return failure(read.event.data.code, read.event.data.message);
      }
    }
    return undefined;
  };

  // 5. Read until a final event, the end of the stream, or a cancel.
  let drained = false;
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>> | typeof ABORT;
      try {
        chunk = await gate.guard(reader.read());
      } catch {
        return isAborted() ? aborted() : interrupted();
      }
      if (chunk === ABORT || isAborted()) return aborted();
      if (chunk.done) {
        drained = true;
        break;
      }
      const result = consume(decoder.decode(chunk.value, { stream: true }));
      if (result !== undefined) return result;
    }
  } finally {
    // Leaving before the end of the stream (final event, cancel, error): free the connection.
    if (!drained) cancelQuietly(reader);
  }

  // 6. The stream ended. The decoder may still hold bytes of a character that was cut off.
  const last = consume(decoder.decode());
  parser.end(); // drops an event that never got its closing blank line
  if (last !== undefined) return last;
  return isAborted() ? aborted() : interrupted();
}

/**
 * Creates an animation and reports progress. Never throws: every failure, including one this
 * module did not foresee, comes back as `{ ok: false, code, message }`.
 */
export async function createAnimation(
  request: CreateAnimationRequest,
  opts: CreateAnimationOptions = {},
): Promise<CreateAnimationResult> {
  const gate = createAbortGate(opts.signal);
  try {
    return await run(request, opts, gate);
  } catch {
    return opts.signal?.aborted === true ? aborted() : unexpected();
  } finally {
    gate.dispose();
  }
}
