/**
 * chapter-choices.ts — the five CHAPTERS boxes on the Prep screen.
 *
 * Why: the canvas draws boxes 1..5 (default 3), but lib/setup only knows
 * StoryLength = "short" (3 chapters) | "medium" (5 chapters), and lib/setup must
 * not change (OQ-6). So all five boxes are drawn, only 3 and 5 are enabled
 * (3 -> short, 5 -> medium) and 1, 2, 4 are disabled (aria-disabled in the UI).
 * Pure functions that return result unions and never throw. The caller turns a
 * click on an enabled box into the existing `length_set` action.
 */
import type { StoryLength } from "@/lib/setup/create-form";

/** Number of boxes drawn. */
export const CHAPTER_BOX_COUNT = 5;

export interface ChapterSquare {
  /** Chapter count shown in the box, 1..5. */
  n: number;
  /** true for exactly the box that matches the current length. */
  selected: boolean;
  /** false for boxes with no StoryLength mapping (1, 2, 4). */
  enabled: boolean;
}

export type ChapterSquaresResult =
  | { ok: true; squares: readonly ChapterSquare[] }
  | { ok: false; reason: "invalid_length" };

export type LengthForChaptersResult =
  | { ok: true; length: StoryLength }
  | { ok: false; reason: "unsupported_chapter_count" };

const LENGTH_TO_CHAPTERS: Readonly<Record<StoryLength, number>> = { short: 3, medium: 5 };

export function lengthForChapters(n: number): LengthForChaptersResult {
  if (n === 3) return { ok: true, length: "short" };
  if (n === 5) return { ok: true, length: "medium" };
  return { ok: false, reason: "unsupported_chapter_count" };
}

export function chapterSquares(length: StoryLength): ChapterSquaresResult {
  if (length !== "short" && length !== "medium") {
    return { ok: false, reason: "invalid_length" };
  }
  const active = LENGTH_TO_CHAPTERS[length];
  const squares = Array.from({ length: CHAPTER_BOX_COUNT }, (_, i): ChapterSquare => {
    const n = i + 1;
    return { n, selected: n === active, enabled: lengthForChapters(n).ok };
  });
  return { ok: true, squares };
}
