/**
 * Schemas for the events of the animation stream and for its final result.
 *
 * `POST /api/v1/ai/animations` answers with Server-Sent Events (design 10.4). The backend models
 * (`StartedEvent`, `StageEvent`, `DiagnosticsEvent`, `DoneEvent`, `ErrorEvent` in
 * `backend/app/ai/animation/models.py`) and these schemas decide alike on the shared stream
 * fixture `backend/tests/fixtures/animation/sse-stream.txt`. Each payload is one line of JSON.
 *
 * What the client does with a payload that fails here (Requirement 25.3): a `started`, `stage` or
 * `diagnostics` event is skipped, and a `done` or `error` event ends the call with `UNEXPECTED`.
 * That decision belongs to `animation-client.ts`; this file only says what is valid. Unknown keys
 * are dropped, not rejected, so a newer backend that adds a key still reads.
 *
 * `error.code` is any non-empty string on purpose. The client never branches on a closed list of
 * codes: `messageForCode` maps what it knows and falls back to a generic sentence for the rest.
 *
 * Nothing here carries source code, a prompt, a token, a URL or a Diagnostic message. The
 * `diagnostics` event lists `tool`, `code` and `line` only (Requirement 17.3).
 *
 * `AnimationResultSchema` is the shape `createAnimation` returns, so the job state and the tests
 * can check a result the same way as any other boundary value.
 */

import { z } from "zod";
import { AnimationReferenceSchema } from "./schemas/animation.schema";

/** A run makes at most four model calls (Requirement 13.4), so `attempt` is 1 to 4 everywhere. */
export const ANIMATION_ATTEMPTS_MAX = 4;

/** The server clamps the run deadline to 240 seconds (Requirement 16.1). */
export const ANIMATION_DEADLINE_MS_MAX = 240_000;

/** A `diagnostics` event lists at most ten items (Requirement 17.3). */
export const ANIMATION_DIAGNOSTIC_ITEMS_MAX = 10;

const wholeNumber = z.number().int();
const attempt = wholeNumber.min(1).max(ANIMATION_ATTEMPTS_MAX);

export const StartedSchema = z.object({
  max_attempts: attempt,
  deadline_ms: wholeNumber.min(1).max(ANIMATION_DEADLINE_MS_MAX),
  cached: z.boolean(),
});

export const StageSchema = z.object({
  stage: z.enum(["generating", "verifying", "repairing", "publishing"]),
  attempt,
});

export const DiagnosticsSchema = z.object({
  attempt,
  ok: z.boolean(),
  error_count: wholeNumber.min(0),
  warning_count: wholeNumber.min(0),
  items: z
    .array(z.object({ tool: z.string(), code: z.string(), line: wholeNumber.min(1).optional() }))
    .max(ANIMATION_DIAGNOSTIC_ITEMS_MAX),
});

export const DoneSchema = z.object({
  animation: AnimationReferenceSchema,
  cached: z.boolean(),
  attempts: attempt,
});

export const ErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  attempts: wholeNumber.min(0).max(ANIMATION_ATTEMPTS_MAX),
});

// `Payload`, not `Event`: `ErrorEvent` is also a DOM type and would be easy to confuse.
export type StartedPayload = z.infer<typeof StartedSchema>;
export type StagePayload = z.infer<typeof StageSchema>;
export type DiagnosticsPayload = z.infer<typeof DiagnosticsSchema>;
export type DonePayload = z.infer<typeof DoneSchema>;
export type ErrorPayload = z.infer<typeof ErrorSchema>;

/** Payload schema per event name. Names not listed here are ignored by the client. */
export const ANIMATION_EVENT_SCHEMAS = {
  started: StartedSchema,
  stage: StageSchema,
  diagnostics: DiagnosticsSchema,
  done: DoneSchema,
  error: ErrorSchema,
} as const;

export type AnimationEventName = keyof typeof ANIMATION_EVENT_SCHEMAS;

/** A valid event, tagged by name. This is what `createAnimation` hands to `onEvent`. */
export type AnimationEvent =
  | { event: "started"; data: StartedPayload }
  | { event: "stage"; data: StagePayload }
  | { event: "diagnostics"; data: DiagnosticsPayload }
  | { event: "done"; data: DonePayload }
  | { event: "error"; data: ErrorPayload };

export type ReadAnimationEventResult =
  | { ok: true; event: AnimationEvent }
  | { ok: false; reason: "unknown_event" | "invalid_json" | "invalid_payload"; event: string };

function isEventName(name: string): name is AnimationEventName {
  return Object.prototype.hasOwnProperty.call(ANIMATION_EVENT_SCHEMAS, name);
}

/**
 * Reads one parsed SSE event (`event` name and `data` text). Total: bad JSON or a bad payload is
 * `{ ok: false }` with the reason, never an exception. `event` is echoed back on failure so the
 * caller can tell a broken terminal event (`done`, `error`) from a broken progress event.
 */
export function readAnimationEvent(raw: { event: string; data: string }): ReadAnimationEventResult {
  const name = raw.event;
  if (!isEventName(name)) return { ok: false, reason: "unknown_event", event: name };
  let json: unknown;
  try {
    json = JSON.parse(raw.data);
  } catch {
    return { ok: false, reason: "invalid_json", event: name };
  }
  const parsed = ANIMATION_EVENT_SCHEMAS[name].safeParse(json);
  if (!parsed.success) return { ok: false, reason: "invalid_payload", event: name };
  // The schema is picked by `name`, so the pairing is right; TypeScript cannot follow the lookup.
  return { ok: true, event: { event: name, data: parsed.data } as AnimationEvent };
}

/**
 * Result of `createAnimation` (design 7.3). On failure `code` is a server code (`RATE_LIMITED`,
 * `ANIMATION_QUOTA_EXCEEDED`, ...) or a client one (`ABORTED`, `NETWORK`, `STREAM_INTERRUPTED`,
 * `UNEXPECTED`). `retryAfterSeconds` is set only for an HTTP 429 with a usable `Retry-After`.
 */
export const AnimationResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    animation: AnimationReferenceSchema,
    cached: z.boolean(),
    attempts: attempt,
  }),
  z.object({
    ok: z.literal(false),
    code: z.string().min(1),
    message: z.string(),
    retryAfterSeconds: wholeNumber.min(0).optional(),
  }),
]);

export type AnimationResult = z.infer<typeof AnimationResultSchema>;
