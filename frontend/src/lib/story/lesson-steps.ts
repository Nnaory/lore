/**
 * lesson-steps.ts — which lesson step a `learning_info` block belongs to (pure).
 *
 * Why: a lesson step longer than one dialogue chunk is stored as several consecutive
 * `learning_info` blocks that share the same title and visual (the backend splits long
 * bodies at sentence ends). The Stage must treat those blocks as ONE step: the heading says
 * "Lesson · 2 / 4" (steps, not chunks) and a drawn visual keeps playing instead of restarting
 * on every chunk. Steps are found by comparing a block with the previous lesson block:
 * same title and same visual means the same step.
 */

import type { SceneContent } from "@/lib/types/scene";

type Learning = Extract<SceneContent, { type: "learning_info" }>;

export interface LessonStepInfo {
  /** Zero-based index of the step among the scene's steps. */
  readonly index: number;
  /** Number of steps in the scene. */
  readonly total: number;
  /** Zero-based chunk of this step that `blockIndex` is. */
  readonly chunk: number;
  /** Number of blocks (chunks) in this step. */
  readonly chunks: number;
}

function isLearning(block: SceneContent | undefined): block is Learning {
  return block !== undefined && block.type === "learning_info";
}

function sameStep(a: Learning, b: Learning): boolean {
  return a.title === b.title && JSON.stringify(a.visual ?? null) === JSON.stringify(b.visual ?? null);
}

/**
 * Step information for the block at `blockIndex`, or `null` when that block is not a
 * lesson block (or the index is out of range).
 */
export function lessonStepInfo(blocks: readonly SceneContent[], blockIndex: number): LessonStepInfo | null {
  if (!isLearning(blocks[blockIndex])) return null;

  // Group index per learning block, in order.
  const groups: number[] = [];
  const members: number[] = []; // blocks per group
  let previous: Learning | null = null;
  let group = -1;
  for (const block of blocks) {
    if (!isLearning(block)) {
      groups.push(-1);
      continue;
    }
    if (previous === null || !sameStep(previous, block)) {
      group += 1;
      members[group] = 0;
    }
    members[group] += 1;
    groups.push(group);
    previous = block;
  }

  const index = groups[blockIndex];
  let chunk = 0;
  for (let i = 0; i < blockIndex; i++) if (groups[i] === index) chunk += 1;
  return { index, total: group + 1, chunk, chunks: members[index] };
}
