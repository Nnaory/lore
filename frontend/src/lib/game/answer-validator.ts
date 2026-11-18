/**
 * Answer Validator
 *
 * Pure, deterministic validation of player answers against puzzle data.
 * This is the single source of truth for correctness — no UI component
 * may determine correctness independently.
 *
 * Currently supports: multiple-choice puzzles.
 * The Puzzle type (from Milestone 1) only defines a choices[] / correct_choice_id
 * contract, so multiple-choice is the only supported type.
 *
 * Short-answer support would require additions to the Puzzle data contract,
 * which is out of scope for this milestone.
 */

import type { Puzzle } from "@/lib/types/puzzle";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** A validated, correct answer. */
export type CorrectResult = {
  outcome: "correct";
  /** The feedback text from the puzzle's correct_feedback field. */
  feedback: string;
  /** The academic explanation of why this answer is correct. */
  explanation: string;
};

/** A validated, incorrect answer. */
export type IncorrectResult = {
  outcome: "incorrect";
  /** The feedback text from the puzzle's incorrect_feedback field. */
  feedback: string;
  /** Whether the puzzle allows another attempt. */
  retryAllowed: boolean;
};

/** The submitted answer was empty or otherwise invalid as input. */
export type EmptyResult = {
  outcome: "empty";
  feedback: string;
};

/** The submitted choice_id does not correspond to any choice in the puzzle. */
export type UnknownChoiceResult = {
  outcome: "unknown_choice";
  feedback: string;
  submittedChoiceId: string;
};

export type ValidationResult =
  | CorrectResult
  | IncorrectResult
  | EmptyResult
  | UnknownChoiceResult;

// ---------------------------------------------------------------------------
// Multiple-choice validation
// ---------------------------------------------------------------------------

/**
 * Validates a multiple-choice answer against a puzzle.
 *
 * @param puzzle - The puzzle being answered.
 * @param submittedChoiceId - The choice_id selected by the player.
 *   Pass an empty string or null/undefined to represent an unanswered state.
 * @returns A structured ValidationResult.
 */
export function validateMultipleChoice(
  puzzle: Puzzle,
  submittedChoiceId: string | null | undefined
): ValidationResult {
  // ── Guard: empty submission ──────────────────────────────────────────────
  if (!submittedChoiceId || submittedChoiceId.trim() === "") {
    return {
      outcome: "empty",
      feedback: "Please select an answer before submitting.",
    };
  }

  // ── Guard: unknown choice_id ─────────────────────────────────────────────
  const choiceExists = puzzle.choices.some(
    (c) => c.choice_id === submittedChoiceId
  );
  if (!choiceExists) {
    return {
      outcome: "unknown_choice",
      feedback: `Choice "${submittedChoiceId}" is not a valid option for this puzzle.`,
      submittedChoiceId,
    };
  }

  // ── Evaluate correctness ─────────────────────────────────────────────────
  if (submittedChoiceId === puzzle.correct_choice_id) {
    return {
      outcome: "correct",
      feedback: puzzle.correct_feedback,
      explanation: puzzle.explanation,
    };
  }

  return {
    outcome: "incorrect",
    feedback: puzzle.incorrect_feedback,
    retryAllowed: puzzle.retry_allowed,
  };
}
