/**
 * Sandbox_Protocol: the messages between the Sandbox_Frame (parent page) and the Sandbox_Runtime
 * (the sandboxed iframe), design 7.7 / 10.6, Requirement 28.
 *
 * Both sides read `postMessage` data they do not control, so every message is checked against a
 * strict Zod schema before it is used. This module is the single definition of the message set.
 * It holds no state and makes no timing decisions: the SandboxController (task 25.3) decides which
 * messages it accepts when (session equality, `ready` before `load`, watchdogs).
 *
 * Shape rules:
 * - every message carries `source: "lore-sandbox"`, `version: 1`, `type` and `session`;
 * - the schemas are `.strict()`, so an unknown key rejects the whole message;
 * - `session` is empty or 32 lowercase hex characters for every `type`. The schema does not say
 *   which of the two a given message must use. `ready` and `heartbeat` before `load` use the empty
 *   one (Requirement 28.13); the controller compares the rest against its own Session_Id;
 * - `frame` and `duration_in_frames` limits, and the `bundle` size limit, come from `CONTRACT`
 *   (Requirement 2.6) and are never written down as literals here;
 * - `seek.frame` is any safe integer because the runtime clamps it to the animation.
 *
 * `decodeMessage` never throws and returns `{ ok: false }` for anything that is not a valid message
 * (Requirement 28.10). `encodeMessage` returns a plain object made of plain objects, which is
 * what `postMessage` clones, and `decodeMessage(encodeMessage(m))` equals `m`.
 *
 * The Sandbox_Runtime bundle includes this file and `session.ts`, so neither may import React, the
 * DOM or Next. `zod` and `./contract` are the only imports allowed.
 */

import { z } from "zod";
import { CONTRACT } from "./contract";

/** Value of `source` on every message. */
export const SANDBOX_SOURCE = "lore-sandbox" as const;

/** Value of `version` on every message. */
export const SANDBOX_VERSION = 1 as const;

/** Length of a Session_Id: 16 random bytes written as lowercase hex. */
export const SESSION_ID_LENGTH = 32;

/** `session` is empty (before `load`) or a Session_Id. Has no `g` flag, so `test` is stateless. */
export const SESSION_PATTERN = new RegExp(`^([0-9a-f]{${SESSION_ID_LENGTH}})?$`);

/** `error.code`: 1 to 64 characters of upper case letters, digits and underscore. */
export const ERROR_CODE_PATTERN = /^[A-Z0-9_]{1,64}$/;

/** Longest `load.bundle`, in characters: the contract's bundle size limit. */
export const MAX_BUNDLE_CHARS = CONTRACT.limits.bundle_max_bytes;

/** Shortest and longest animation, in frames. */
export const MIN_DURATION_IN_FRAMES = CONTRACT.duration.min;
export const MAX_DURATION_IN_FRAMES = CONTRACT.duration.max;

/** Last frame index an animation can have (`MAX_DURATION_IN_FRAMES - 1`). */
export const MAX_FRAME_INDEX = CONTRACT.duration.max - 1;

const sessionSchema = z.string().regex(SESSION_PATTERN);

/** Frame index reported by the runtime: 0 up to the last frame of the longest animation. */
const frameIndexSchema = z.number().int().min(0).max(MAX_FRAME_INDEX);

const durationInFramesSchema = z
  .number()
  .int()
  .min(MIN_DURATION_IN_FRAMES)
  .max(MAX_DURATION_IN_FRAMES);

const positiveIntSchema = z.number().int().min(1);

/** What the parent tells the runtime about the animation it is sending (`load.meta`). */
export const LoadMetaSchema = z
  .object({
    width: positiveIntSchema,
    height: positiveIntSchema,
    fps: positiveIntSchema,
    duration_in_frames: durationInFramesSchema,
    /** Frame where a puzzle waits for the player; `durationInFrames - 1` at most. */
    pause_at_frame: z.number().int().min(1).max(MAX_FRAME_INDEX).optional(),
  })
  .strict();

const envelope = z.object({
  source: z.literal(SANDBOX_SOURCE),
  version: z.literal(SANDBOX_VERSION),
  session: sessionSchema,
});

// Parent -> iframe.

const LoadSchema = envelope
  .extend({
    type: z.literal("load"),
    bundle: z.string().max(MAX_BUNDLE_CHARS),
    meta: LoadMetaSchema,
    contract_version: positiveIntSchema,
  })
  .strict();

const PlaySchema = envelope.extend({ type: z.literal("play") }).strict();
const PauseSchema = envelope.extend({ type: z.literal("pause") }).strict();
const ResumeSchema = envelope.extend({ type: z.literal("resume") }).strict();

const SeekSchema = envelope
  .extend({ type: z.literal("seek"), frame: z.number().int().safe() })
  .strict();

const SetModeSchema = envelope
  .extend({ type: z.literal("setMode"), mode: z.enum(["fast", "animate"]) })
  .strict();

// Iframe -> parent.

const ReadySchema = envelope.extend({ type: z.literal("ready") }).strict();
const EndedSchema = envelope.extend({ type: z.literal("ended") }).strict();
const HeartbeatSchema = envelope.extend({ type: z.literal("heartbeat") }).strict();

const LoadedSchema = envelope
  .extend({ type: z.literal("loaded"), duration_in_frames: durationInFramesSchema })
  .strict();

const FrameSchema = envelope
  .extend({ type: z.literal("frame"), frame: frameIndexSchema, playing: z.boolean() })
  .strict();

const PausedSchema = envelope
  .extend({
    type: z.literal("paused"),
    reason: z.enum(["interaction", "end"]),
    frame: frameIndexSchema,
  })
  .strict();

const ErrorSchema = envelope
  .extend({
    type: z.literal("error"),
    phase: z.enum(["load", "runtime"]),
    code: z.string().regex(ERROR_CODE_PATTERN),
  })
  .strict();

/** Messages the Sandbox_Frame sends and the Sandbox_Runtime accepts (Requirement 28.4). */
export const ParentMessageSchema = z.discriminatedUnion("type", [
  LoadSchema,
  PlaySchema,
  PauseSchema,
  ResumeSchema,
  SeekSchema,
  SetModeSchema,
]);

/** Messages the Sandbox_Runtime sends and the Sandbox_Frame accepts (Requirement 28.3). */
export const FrameMessageSchema = z.discriminatedUnion("type", [
  ReadySchema,
  LoadedSchema,
  FrameSchema,
  PausedSchema,
  EndedSchema,
  ErrorSchema,
  HeartbeatSchema,
]);

/** Every message in either direction. The `type` values of the two directions do not overlap. */
export const SandboxMessageSchema = z.discriminatedUnion("type", [
  LoadSchema,
  PlaySchema,
  PauseSchema,
  ResumeSchema,
  SeekSchema,
  SetModeSchema,
  ReadySchema,
  LoadedSchema,
  FrameSchema,
  PausedSchema,
  EndedSchema,
  ErrorSchema,
  HeartbeatSchema,
]);

export type LoadMeta = z.infer<typeof LoadMetaSchema>;
export type ParentMessage = z.infer<typeof ParentMessageSchema>;
export type FrameMessage = z.infer<typeof FrameMessageSchema>;
export type SandboxMessage = z.infer<typeof SandboxMessageSchema>;

/** Outcome of `decodeMessage`: the message, or a bare refusal (callers just ignore the data). */
export type DecodeResult = { ok: true; message: SandboxMessage } | { ok: false };

const PARENT_TYPES: ReadonlySet<string> = new Set(
  ParentMessageSchema.options.map((option) => option.shape.type.value),
);
const FRAME_TYPES: ReadonlySet<string> = new Set(
  FrameMessageSchema.options.map((option) => option.shape.type.value),
);

/** True for a message the parent sends. Decoding does not check direction; callers do. */
export function isParentMessage(message: SandboxMessage): message is ParentMessage {
  return PARENT_TYPES.has(message.type);
}

/** True for a message the iframe sends. Decoding does not check direction; callers do. */
export function isFrameMessage(message: SandboxMessage): message is FrameMessage {
  return FRAME_TYPES.has(message.type);
}

/**
 * Checks `data` (the `data` of a `message` event) against the protocol. Total: any value,
 * including `null`, arrays, strings, numbers and objects with throwing getters, yields
 * `{ ok: true, message }` or `{ ok: false }` and never throws.
 */
export function decodeMessage(data: unknown): DecodeResult {
  try {
    const parsed = SandboxMessageSchema.safeParse(data);
    return parsed.success ? { ok: true, message: parsed.data } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/**
 * Plain-object form of `message`, ready for `postMessage` (structured clone). A copy, so changing
 * `message` afterwards does not change what was sent.
 */
export function encodeMessage<T extends SandboxMessage>(message: T): T {
  if (message.type === "load") return { ...message, meta: { ...message.meta } };
  return { ...message };
}
