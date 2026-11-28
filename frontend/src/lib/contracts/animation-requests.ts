/**
 * Request schema for `POST /api/v1/ai/animations`.
 *
 * The backend model `CreateAnimationRequest` (`backend/app/ai/animation/models.py`) and this schema
 * must accept and reject the same bodies (Requirements 15.2, 15.12, 15.13). Both read the shared
 * fixtures `backend/tests/fixtures/animation/request-{valid,invalid}-*.json`, so a rule that drifts
 * on one side fails a test on the other.
 *
 * Rules, all counted in UTF-16 code units like `String.length` (so an emoji counts 2 and the
 * limits below hold for Python as well, which counts the same way):
 * - `title`: trimmed with `String.prototype.trim`, then 1 to 200. The trimmed text is what the
 *   verifier looks for on screen, so the schema returns it trimmed.
 * - `text`: 1 to 2000, not trimmed. `concepts`: at most 5 strings of 1 to 80, not trimmed.
 * - `forbidden_tokens`: at most 8 strings of 1 to 80, and only for a `puzzle`. A missing list is
 *   `[]`, so it hashes like an empty one (Requirement 15.13).
 * - A lone surrogate anywhere in the body, in a value or in a key (even an unknown one), rejects the
 *   whole request. `JSON.parse` keeps a lone surrogate but UTF-8 cannot carry one, so the backend
 *   would answer 400 before it hashes the request (Requirement 15.12). The check runs on the raw
 *   input, before Zod drops unknown keys, which is why it is a separate step in front of the object.
 * - Unknown keys are dropped, not rejected, like every other contract here.
 *
 * `visual` reuses `LessonVisualSchema`: one definition of a valid lesson visual.
 */

import { z } from "zod";
import type { CreateAnimationRequest } from "@/lib/types/animation";
import { LessonVisualSchema } from "./schemas/visual.schema";

export const ANIMATION_TITLE_MAX = 200;
export const ANIMATION_TEXT_MAX = 2000;
export const ANIMATION_CONCEPTS_MAX = 5;
export const ANIMATION_CONCEPT_MAX = 80;
export const ANIMATION_FORBIDDEN_TOKENS_MAX = 8;
export const ANIMATION_FORBIDDEN_TOKEN_MAX = 80;

/** True when `text` has no unpaired UTF-16 surrogate. Same test as `String.prototype.isWellFormed`. */
function isWellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1); // NaN past the end, so a trailing high surrogate fails
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
        continue;
      }
      return false;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

/**
 * True when any string in `value`, object keys included, holds a lone surrogate. Iterative with a
 * visited set, so a deeply nested or self-referencing input cannot overflow the stack or loop.
 */
export function containsLoneSurrogate(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const item = pending.pop();
    if (typeof item === "string") {
      if (!isWellFormed(item)) return true;
    } else if (typeof item === "object" && item !== null) {
      if (seen.has(item)) continue;
      seen.add(item);
      if (Array.isArray(item)) {
        // A loop, not `push(...item)`: spreading a very long array can overflow the call stack.
        for (const element of item) pending.push(element);
      } else {
        for (const key of Object.keys(item)) {
          if (!isWellFormed(key)) return true;
          pending.push((item as Record<string, unknown>)[key]);
        }
      }
    }
  }
  return false;
}

const RequestBodySchema = z
  .object({
    kind: z.enum(["lesson", "puzzle"]),
    title: z.string().trim().min(1).max(ANIMATION_TITLE_MAX),
    text: z.string().min(1).max(ANIMATION_TEXT_MAX),
    concepts: z.array(z.string().min(1).max(ANIMATION_CONCEPT_MAX)).max(ANIMATION_CONCEPTS_MAX).default([]),
    visual: LessonVisualSchema,
    language: z.enum(["en", "id"]),
    forbidden_tokens: z
      .array(z.string().min(1).max(ANIMATION_FORBIDDEN_TOKEN_MAX))
      .max(ANIMATION_FORBIDDEN_TOKENS_MAX)
      .default([]),
  })
  .superRefine((request, ctx) => {
    if (request.kind === "lesson" && request.forbidden_tokens.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["forbidden_tokens"],
        message: "forbidden_tokens is only allowed for a puzzle",
      });
    }
  });

export const CreateAnimationRequestSchema: z.ZodType<CreateAnimationRequest, z.ZodTypeDef, unknown> = z
  .unknown()
  .superRefine((raw, ctx) => {
    if (containsLoneSurrogate(raw)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "strings must not contain a lone surrogate" });
    }
  })
  .pipe(RequestBodySchema);
