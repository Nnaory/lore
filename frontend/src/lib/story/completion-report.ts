/**
 * Completion report — what the end-of-story screen shows about this run
 *
 * Why: the Stage's "story complete" screen lists accuracy, how many concepts
 * the player got right and, per concept, whether it came first try, after a
 * retry, or still needs another go. The numbers come only from the answers the
 * game engine already judged (`validateMultipleChoice`), recorded per run, so a
 * retried story starts from a clean report. Pure functions, no React.
 */

import type { StoryBlueprint } from "@/lib/types/story";

/** One judged puzzle submission in the current run. */
export type RunAnswer = { puzzleId: string; correct: boolean };

/**
 * direct:  answered right with no earlier mistake on a puzzle of this concept
 * retried: answered right, but only after a mistake
 * repeat:  tested, never answered right
 * taught:  no puzzle for this concept was answered in this run
 */
export type ConceptResult = "direct" | "retried" | "repeat" | "taught";

export type CompletionConcept = { concept_id: string; name: string; result: ConceptResult };

export type CompletionReport = {
  answersCorrect: number;
  answersTotal: number;
  concepts: CompletionConcept[];
  /** Concepts answered right (direct or retried). */
  understood: number;
  /** First concept that still needs another go, in story order. */
  weakest: CompletionConcept | null;
};

/** The learning_info title that introduces a concept (used as its display name). */
function lessonTitle(story: StoryBlueprint, conceptId: string): string | null {
  for (const scene of story.chapters.flatMap((c) => c.scenes)) {
    if (!("content" in scene)) continue;
    for (const block of scene.content) {
      if (block.type === "learning_info" && block.concept_ids.includes(conceptId)) return block.title;
    }
  }
  return null;
}

function resultFor(story: StoryBlueprint, conceptId: string, answers: readonly RunAnswer[]): ConceptResult {
  const puzzleIds = new Set(story.puzzles.filter((p) => p.concept_ids.includes(conceptId)).map((p) => p.puzzle_id));
  const relevant = answers.filter((a) => puzzleIds.has(a.puzzleId));
  if (relevant.length === 0) return "taught";
  const firstCorrect = relevant.findIndex((a) => a.correct);
  if (firstCorrect === -1) return "repeat";
  return firstCorrect === 0 ? "direct" : "retried";
}

export function buildCompletionReport(story: StoryBlueprint, answers: readonly RunAnswer[]): CompletionReport {
  const mapped = story.knowledge_mapping.map((m) => m.concept_id);
  const conceptIds = [...new Set(mapped.length > 0 ? mapped : story.puzzles.flatMap((p) => p.concept_ids))];
  const concepts = conceptIds.map((id) => ({
    concept_id: id,
    name: lessonTitle(story, id) ?? id,
    result: resultFor(story, id, answers),
  }));
  return {
    answersCorrect: answers.filter((a) => a.correct).length,
    answersTotal: answers.length,
    concepts,
    understood: concepts.filter((c) => c.result === "direct" || c.result === "retried").length,
    weakest: concepts.find((c) => c.result === "repeat") ?? null,
  };
}

/** "45s" under a minute, otherwise whole minutes ("21m"). */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}
