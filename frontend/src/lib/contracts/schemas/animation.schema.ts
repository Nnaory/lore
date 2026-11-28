/**
 * Zod Schemas — Animation_Reference on a story
 *
 * A story block (`learning_info`) or a puzzle may point at an AI-written animation. This file has
 * two layers:
 *
 * - `AnimationReferenceSchema` is strict about values. It is the shape the backend returns on the
 *   `done` event and from the reader, and the shape a story keeps. Canvas size and duration range
 *   come from the contract (`CONTRACT`, Requirement 2.6), never from literals here. Unknown keys
 *   are dropped, not rejected (Zod default, Requirement 22.5), so a reference written by a newer
 *   backend still reads.
 * - `LessonAnimationSchema` and `PuzzleAnimationSchema` are lenient, like the `visual` field next to
 *   them: anything invalid, `null`, or against the pause rule becomes `undefined`. A bad reference
 *   must never make a whole story or a saved project unreadable (Requirements 22.3, 22.9), because
 *   the story is fully playable without the animation.
 *
 * The decisions match `AnimationReference` and the story models on the Python side. Both read the
 * fixtures in `backend/tests/fixtures/animation/reference-*.json` (Requirement 22.6).
 */

import { z } from "zod";
import { CONTRACT } from "@/lib/animation/contract";
import type { AnimationReference } from "@/lib/types/animation";

/** Lower-case canonical UUID: no braces, no `urn:uuid:` prefix, hyphens required (Requirement 22.10). */
export const ANIMATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** SHA-256 as 64 lower-case hex characters. */
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const PAUSE_KEY = "pause_at_frame";

/**
 * Whole numbers only, like Pydantic's `WholeInt`: `30` and `30.0` are the same number after
 * `JSON.parse`, while `30.5`, `"30"`, `true` and `null` fail (Requirement 22.11).
 */
const wholeNumber = z.number().int();

export const AnimationReferenceSchema: z.ZodType<AnimationReference, z.ZodTypeDef, unknown> = z
  .object({
    animation_id: z.string().regex(ANIMATION_ID_PATTERN),
    source_sha256: z.string().regex(SHA256_PATTERN),
    bundle_sha256: z.string().regex(SHA256_PATTERN),
    width: z.literal(CONTRACT.canvas.width),
    height: z.literal(CONTRACT.canvas.height),
    fps: z.literal(CONTRACT.canvas.fps),
    duration_in_frames: wholeNumber.min(CONTRACT.duration.min).max(CONTRACT.duration.max),
    pause_at_frame: wholeNumber.min(1).optional(),
    contract_version: wholeNumber.min(1),
  })
  .superRefine((reference, ctx) => {
    const pause = reference.pause_at_frame;
    if (pause !== undefined && pause > reference.duration_in_frames - 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [PAUSE_KEY],
        message: "pause_at_frame must be at most duration_in_frames - 1",
      });
    }
  });

/**
 * Lenient reader for one story location. `lesson` references must not carry `pause_at_frame`
 * (any value, `null` included) and `puzzle` references must (Requirement 22.4); everything else
 * is the strict schema. Same pattern as the `visual` fields: the input comes from `JSON.parse` or
 * IndexedDB, so a plain "not an object" check is all the inspection it needs.
 */
function lenientReference(rule: "lesson" | "puzzle") {
  return z
    .unknown()
    .transform((value): AnimationReference | undefined => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
      const hasPause = Object.prototype.hasOwnProperty.call(value, PAUSE_KEY);
      if (rule === "lesson" && hasPause) return undefined;
      if (rule === "puzzle" && !hasPause) return undefined;
      const parsed = AnimationReferenceSchema.safeParse(value);
      return parsed.success ? parsed.data : undefined;
    })
    .optional();
}

/** `learning_info.animation`: a reference without `pause_at_frame`, or dropped. */
export const LessonAnimationSchema = lenientReference("lesson");

/** `puzzle.animation`: a reference with `pause_at_frame`, or dropped. */
export const PuzzleAnimationSchema = lenientReference("puzzle");
