/**
 * Puzzle Types
 *
 * Represents a learning challenge embedded within a scene.
 * The game engine is responsible for evaluating answers — not the AI.
 */

import type { LessonVisual } from "./visual";

/** One selectable option within a puzzle. */
export type PuzzleChoice = {
  choice_id: string;
  text: string;
};

/**
 * A puzzle challenge linked to one or more learning concepts.
 *
 * Invariant: `correct_choice_id` must match one of the `choice_id`
 * values in `choices`. Enforced by semantic validation.
 *
 * Invariant: `choices` must contain at least two entries.
 */
export type Puzzle = {
  puzzle_id: string;
  /** IDs of concepts from the MaterialBlueprint that this puzzle tests. */
  concept_ids: string[];
  /** In-world framing of the problem (narrative context, not the raw question). */
  narrative_context: string;
  question: string;
  choices: PuzzleChoice[];
  /** The `choice_id` of the correct answer. */
  correct_choice_id: string;
  /** Academic explanation of why the correct answer is right. */
  explanation: string;
  /** Feedback shown to the player when they choose incorrectly. */
  incorrect_feedback: string;
  /** Feedback shown to the player when they choose correctly. */
  correct_feedback: string;
  retry_allowed: boolean;
  /**
   * Optional picture of the problem, drawn on the stage canvas. The AI picks one primitive and
   * fills in the data; it must not show the answer. Without it the canvas shows the question only.
   */
  visual?: LessonVisual;
};
