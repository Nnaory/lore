/**
 * Tests — Answer Validator
 *
 * Tests the pure validation logic without any React or DOM.
 * Covers:
 *   1. Correct multiple-choice answer
 *   2. Incorrect multiple-choice answer
 *   3. Empty answer (null)
 *   4. Empty answer (empty string)
 *   5. Whitespace-only answer
 *   6. Unknown choice_id
 *   7. retry_allowed: false is propagated to IncorrectResult
 *   8. retry_allowed: true is propagated to IncorrectResult
 *   9. Correct answer returns explanation and feedback
 *   10. Incorrect answer returns incorrect_feedback from puzzle
 */

import { describe, it, expect } from "vitest";
import { validateMultipleChoice } from "@/lib/game/answer-validator";
import { dummyStory } from "@/data/dummy-campaign";
import type { Puzzle } from "@/lib/types/puzzle";

const puzzle = dummyStory.puzzles[0]; // puzzle_01, correct_choice_id = "choice_B"

// ── 1. Correct answer ────────────────────────────────────────────────────────

describe("validateMultipleChoice — correct answer", () => {
  it("should return outcome 'correct' for the right choice_id", () => {
    const result = validateMultipleChoice(puzzle, "choice_B");
    expect(result.outcome).toBe("correct");
  });

  it("should return the puzzle's correct_feedback", () => {
    const result = validateMultipleChoice(puzzle, "choice_B");
    expect(result.outcome).toBe("correct");
    if (result.outcome === "correct") {
      expect(result.feedback).toBe(puzzle.correct_feedback);
    }
  });

  it("should return the puzzle's explanation", () => {
    const result = validateMultipleChoice(puzzle, "choice_B");
    expect(result.outcome).toBe("correct");
    if (result.outcome === "correct") {
      expect(result.explanation).toBe(puzzle.explanation);
      expect(result.explanation.length).toBeGreaterThan(0);
    }
  });
});

// ── 2. Incorrect answer ──────────────────────────────────────────────────────

describe("validateMultipleChoice — incorrect answer", () => {
  it("should return outcome 'incorrect' for a wrong choice_id", () => {
    const result = validateMultipleChoice(puzzle, "choice_A");
    expect(result.outcome).toBe("incorrect");
  });

  it("should return the puzzle's incorrect_feedback", () => {
    const result = validateMultipleChoice(puzzle, "choice_A");
    expect(result.outcome).toBe("incorrect");
    if (result.outcome === "incorrect") {
      expect(result.feedback).toBe(puzzle.incorrect_feedback);
    }
  });

  it("should return incorrect for every wrong choice", () => {
    const wrongChoices = puzzle.choices
      .filter((c) => c.choice_id !== puzzle.correct_choice_id)
      .map((c) => c.choice_id);

    for (const choiceId of wrongChoices) {
      const result = validateMultipleChoice(puzzle, choiceId);
      expect(result.outcome, `choice "${choiceId}" should be incorrect`).toBe(
        "incorrect"
      );
    }
  });
});

// ── 3–5. Empty answer ────────────────────────────────────────────────────────

describe("validateMultipleChoice — empty answer", () => {
  it("should return outcome 'empty' for null", () => {
    const result = validateMultipleChoice(puzzle, null);
    expect(result.outcome).toBe("empty");
  });

  it("should return outcome 'empty' for undefined", () => {
    const result = validateMultipleChoice(puzzle, undefined);
    expect(result.outcome).toBe("empty");
  });

  it("should return outcome 'empty' for an empty string", () => {
    const result = validateMultipleChoice(puzzle, "");
    expect(result.outcome).toBe("empty");
  });

  it("should return outcome 'empty' for a whitespace-only string", () => {
    const result = validateMultipleChoice(puzzle, "   ");
    expect(result.outcome).toBe("empty");
  });
});

// ── 6. Unknown choice_id ─────────────────────────────────────────────────────

describe("validateMultipleChoice — unknown choice_id", () => {
  it("should return outcome 'unknown_choice' for a choice_id not in the puzzle", () => {
    const result = validateMultipleChoice(puzzle, "choice_NONEXISTENT");
    expect(result.outcome).toBe("unknown_choice");
  });

  it("should include the submitted choice_id in the result", () => {
    const result = validateMultipleChoice(puzzle, "choice_NONEXISTENT");
    expect(result.outcome).toBe("unknown_choice");
    if (result.outcome === "unknown_choice") {
      expect(result.submittedChoiceId).toBe("choice_NONEXISTENT");
    }
  });
});

// ── 7–8. retry_allowed propagation ──────────────────────────────────────────

describe("validateMultipleChoice — retry_allowed propagation", () => {
  it("should propagate retry_allowed: true from the puzzle", () => {
    const retryPuzzle: Puzzle = { ...puzzle, retry_allowed: true };
    const result = validateMultipleChoice(retryPuzzle, "choice_A");
    expect(result.outcome).toBe("incorrect");
    if (result.outcome === "incorrect") {
      expect(result.retryAllowed).toBe(true);
    }
  });

  it("should propagate retry_allowed: false from the puzzle", () => {
    const noRetryPuzzle: Puzzle = { ...puzzle, retry_allowed: false };
    const result = validateMultipleChoice(noRetryPuzzle, "choice_A");
    expect(result.outcome).toBe("incorrect");
    if (result.outcome === "incorrect") {
      expect(result.retryAllowed).toBe(false);
    }
  });
});
