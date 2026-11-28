/**
 * animating.ts: the pure helpers of the `animating` generation stage (no React, no timers).
 *
 * Why: the stage sends one animation request per target, and a few decisions in that flow are
 * plain functions of their input. Keeping them here lets `use-generation.ts` stay a thin hook and
 * lets the tests check each rule without a component:
 *
 * - `nextStartDelay` says when the next request may start. The backend allows four requests per
 *   minute per client (Requirement 16.1); a fifth inside the same minute would be answered
 *   `RATE_LIMITED` and the flow would skip every remaining target. So the flow asks before each
 *   start and waits that many milliseconds first (Requirement 24.15, design 7.5). Targets stay
 *   `pending` during the wait. The function only does arithmetic on the start times it is given:
 *   the caller owns the clock (`now`), the list of starts, and the timer that waits.
 * - `buildAnimationJobs` turns the written stories into the list of jobs, in the order of
 *   `campaign.story_sequence` and, inside a story, the order `selectAnimationTargets` gives
 *   (Requirement 24.3). Ids are stable, so the screen and the tests can name a job.
 * - `stopsAnimationStage` names the three server codes that make every later request pointless:
 *   the backend is off, the owner's quota is used up, or the rate limit is hit (Requirement 24.5).
 * - `toAnimationLanguage` reduces the free-text `storyOptions.language` to the two languages the
 *   animation endpoint accepts.
 * - `ANIMATION_CLIENT_TIMEOUT_MS` is the time limit per request. `createAnimation` has no timer of
 *   its own (Requirement 25.11); the flow aborts the request when this much time has passed.
 */

import { selectAnimationTargets } from "@/lib/animation/targets";
import type { AnimationTarget } from "@/lib/types/animation";
import type { StoryBlueprint } from "@/lib/types/story";
import type { AnimationJob } from "./generation";

/** Requests the backend lets one client start per window (Requirement 16.1). */
export const ANIMATION_STARTS_PER_WINDOW = 4;

/** Length of that window in milliseconds. */
export const ANIMATION_START_WINDOW_MS = 60_000;

/** A request that has produced no final event after this long is aborted (Requirement 24.9). */
export const ANIMATION_CLIENT_TIMEOUT_MS = 270_000;

/**
 * Milliseconds to wait before the next request may start; 0 when it may start now.
 *
 * `starts` are the times (ms, same clock as `now`) at which earlier requests started. A start
 * counts while `now - start < windowMs`. When fewer than `max` starts count, there is no wait.
 * Otherwise the wait lasts until enough of the oldest counted starts leave the window, so that
 * `max - 1` remain. At exactly `windowMs` after a start, that start no longer counts.
 *
 * `starts` may be in any order and is not changed. A `max` below 1 is read as 1.
 */
export function nextStartDelay(
  starts: readonly number[],
  now: number,
  max: number = ANIMATION_STARTS_PER_WINDOW,
  windowMs: number = ANIMATION_START_WINDOW_MS
): number {
  const limit = Math.max(1, Math.floor(max));
  const recent = starts.filter((start) => now - start < windowMs).sort((a, b) => a - b);
  if (recent.length < limit) return 0;
  return Math.max(0, recent[recent.length - limit] + windowMs - now);
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/** `lesson:<scene_id>:<block_index>` or `puzzle:<puzzle_id>`: names a target inside one story. */
export function animationTargetKey(target: AnimationTarget): string {
  return target.kind === "lesson" ? `lesson:${target.scene_id}:${target.block_index}` : `puzzle:${target.puzzle_id}`;
}

/** `${storyId}:${targetKey}`: unique inside one generation run (design 7.5). */
export function animationJobId(storyId: string, target: AnimationTarget): string {
  return `${storyId}:${animationTargetKey(target)}`;
}

/**
 * The text the generation screen shows for a job: the lesson title or the puzzle question. A
 * target the story does not hold (it should not happen: the targets come from this story) falls
 * back to its key, so the screen never shows an empty row.
 */
function jobTitle(story: StoryBlueprint, target: AnimationTarget): string {
  if (target.kind === "puzzle") {
    const puzzle = story.puzzles.find((candidate) => candidate.puzzle_id === target.puzzle_id);
    return puzzle?.question ?? animationTargetKey(target);
  }
  for (const chapter of story.chapters) {
    for (const scene of chapter.scenes) {
      if (scene.scene_id !== target.scene_id) continue;
      const block = "content" in scene ? scene.content[target.block_index] : undefined;
      return block?.type === "learning_info" ? block.title : animationTargetKey(target);
    }
  }
  return animationTargetKey(target);
}

/**
 * Every job of a run, all `pending`, in the order of `stories` (the caller passes them in
 * `campaign.story_sequence` order) and, inside a story, in selection order (Requirement 24.3).
 * A story id that appears twice contributes once: ids are keys, and a second copy could not be
 * told apart from the first.
 */
export function buildAnimationJobs(
  stories: ReadonlyArray<{ storyId: string; story: StoryBlueprint }>
): AnimationJob[] {
  const seen = new Set<string>();
  const jobs: AnimationJob[] = [];
  for (const { storyId, story } of stories) {
    if (seen.has(storyId)) continue;
    seen.add(storyId);
    for (const target of selectAnimationTargets(story)) {
      jobs.push({
        id: animationJobId(storyId, target),
        storyId,
        target,
        title: jobTitle(story, target),
        status: "pending",
        stage: null,
        attempt: 0,
      });
    }
  }
  return jobs;
}

// ---------------------------------------------------------------------------
// Decisions on a request result
// ---------------------------------------------------------------------------

/** Server codes after which no later request can work (Requirement 24.5). */
const STOP_CODES: ReadonlySet<string> = new Set([
  "ANIMATION_NOT_CONFIGURED",
  "ANIMATION_QUOTA_EXCEEDED",
  "RATE_LIMITED",
]);

/** True when `code` means the remaining targets must be skipped instead of tried. */
export function stopsAnimationStage(code: string): boolean {
  return STOP_CODES.has(code);
}

/** `"id"` stays `"id"`; anything else, including a missing value, is `"en"`. */
export function toAnimationLanguage(raw: string | undefined): "en" | "id" {
  return raw?.trim().toLowerCase() === "id" ? "id" : "en";
}
