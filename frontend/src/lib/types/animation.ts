/**
 * Animation Types
 *
 * What a story keeps about an AI-written Remotion animation (`AnimationReference`), how a lesson
 * or puzzle is picked for animating (`AnimationTarget`), and the body sent to
 * `POST /api/v1/ai/animations` (`CreateAnimationRequest`). The runtime schemas live in
 * `lib/contracts/schemas/animation.schema.ts` (reference) and `lib/contracts/animation-requests.ts`
 * (request).
 *
 * The canvas numbers (`width`, `height`, `fps`) are typed as `number` on purpose. Their only
 * allowed value is whatever `animation-contract.json` says (Requirement 2.6), and the schema checks
 * it against `CONTRACT` at runtime, so a type that spelled out 1280, 720 and 30 would be a second
 * copy of the contract that could drift from it.
 */

import type { LessonVisual } from "./visual";

/**
 * Pointer from a story block to a published animation. Keys are snake_case like the JSON in the
 * database. `pause_at_frame` exists only on a puzzle reference (Requirement 22.4); it is absent,
 * never `null`, on a lesson reference.
 */
export type AnimationReference = {
  /** Lower-case UUID of the row in the animation registry. */
  animation_id: string;
  /** Lower-case SHA-256 hex of `main.ts`. */
  source_sha256: string;
  /** Lower-case SHA-256 hex of the bundled `main.js`; the client checks it before running. */
  bundle_sha256: string;
  /** Canvas size and frame rate; must equal the contract's canvas. */
  width: number;
  height: number;
  fps: number;
  /** Whole frames, inside the contract's duration range. */
  duration_in_frames: number;
  /** Puzzle only: the frame where playback stops. 1 to `duration_in_frames - 1`. */
  pause_at_frame?: number;
  /** Version of the contract the animation was verified against. */
  contract_version: number;
};

/** Stable identity of a story part that can get an animation (Requirement 23.1). */
export type AnimationTarget =
  | { kind: "lesson"; scene_id: string; block_index: number }
  | { kind: "puzzle"; puzzle_id: string };

/** Body of `POST /api/v1/ai/animations`. `forbidden_tokens` is for puzzles only (Requirement 15.12). */
export type CreateAnimationRequest = {
  kind: "lesson" | "puzzle";
  title: string;
  text: string;
  concepts: string[];
  visual: LessonVisual;
  language: "en" | "id";
  forbidden_tokens?: string[];
};
