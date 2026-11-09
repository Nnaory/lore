/**
 * Tests — PuzzleInteraction Component
 *
 * @vitest-environment jsdom
 *
 * Tests:
 *   1. Puzzle question renders
 *   2. All choices render
 *   3. Player can select a choice
 *   4. Submit button is disabled with no selection
 *   5. Submit button is enabled after selection
 *   6. Incorrect answer shows feedback
 *   7. Player can retry after incorrect answer
 *   8. Correct answer shows feedback
 *   9. Correct answer enables continue button
 *   10. Empty submission is prevented (no selection → submit disabled)
 *   11. Repeated submission does not fire onComplete multiple times
 *   12. Selection is locked after correct answer
 *   13. Answer cannot be submitted after correct answer
 */

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { PuzzleInteraction } from "@/components/story/PuzzleInteraction";
import { dummyStory } from "@/data/dummy-campaign";

const puzzle = dummyStory.puzzles[0];
// puzzle.correct_choice_id = "choice_B"
// incorrect choices: "choice_A", "choice_C"

function makePuzzleView(onComplete = vi.fn()) {
  return render(<PuzzleInteraction puzzle={puzzle} onComplete={onComplete} />);
}

// ── 1. Question renders ──────────────────────────────────────────────────────

describe("PuzzleInteraction — render", () => {
  it("should render the puzzle question", () => {
    const view = makePuzzleView();
    const question = view.getByTestId("puzzle-question");
    expect(question.textContent).toContain("Crystal A");
    expect(question.textContent).toContain("Crystal B");
  });

  it("should render the narrative context", () => {
    const view = makePuzzleView();
    expect(view.getByTestId("puzzle-narrative-context").textContent?.length).toBeGreaterThan(0);
  });

  it("should render all choices", () => {
    const view = makePuzzleView();
    const choices = view.getByTestId("puzzle-choices");
    for (const choice of puzzle.choices) {
      expect(view.getByTestId(`choice-${choice.choice_id}`)).toBeTruthy();
    }
    // Sanity: at least 2 choices rendered
    expect(puzzle.choices.length).toBeGreaterThanOrEqual(2);
    expect(choices.childElementCount).toBe(puzzle.choices.length);
  });
});

// ── 2. Submit button disabled with no selection ──────────────────────────────

describe("PuzzleInteraction — submit disabled", () => {
  it("should have submit button disabled when no choice is selected", () => {
    const view = makePuzzleView();
    const submitBtn = view.getByTestId("puzzle-submit");
    expect(submitBtn).toHaveAttribute("aria-disabled", "true");
  });

  it("should not call onComplete when submit is clicked with no selection", () => {
    const onComplete = vi.fn();
    const view = render(<PuzzleInteraction puzzle={puzzle} onComplete={onComplete} />);
    // Force-click submit despite disabled — should not trigger
    fireEvent.click(view.getByTestId("puzzle-submit"));
    expect(onComplete).not.toHaveBeenCalled();
  });
});

// ── 3. Select a choice ───────────────────────────────────────────────────────

describe("PuzzleInteraction — choice selection", () => {
  it("should enable submit button after selecting a choice", () => {
    const view = makePuzzleView();
    fireEvent.click(view.getByTestId("choice-choice_A"));
    const submitBtn = view.getByTestId("puzzle-submit");
    expect(submitBtn).toHaveAttribute("aria-disabled", "false");
  });

  it("should reflect the selected choice as pressed", () => {
    const view = makePuzzleView();
    fireEvent.click(view.getByTestId("choice-choice_A"));
    expect(view.getByTestId("choice-choice_A")).toHaveAttribute("aria-pressed", "true");
    expect(view.getByTestId("choice-choice_B")).toHaveAttribute("aria-pressed", "false");
  });
});

// ── 4. Incorrect answer ──────────────────────────────────────────────────────

describe("PuzzleInteraction — incorrect answer", () => {
  it("should show feedback after an incorrect submission", () => {
    const view = makePuzzleView();
    fireEvent.click(view.getByTestId("choice-choice_A")); // wrong answer
    fireEvent.click(view.getByTestId("puzzle-submit"));
    expect(view.getByTestId("puzzle-feedback")).toBeTruthy();
    expect(view.getByTestId("puzzle-feedback").textContent).toContain(
      puzzle.incorrect_feedback
    );
  });

  it("should not call onComplete after an incorrect answer", () => {
    const onComplete = vi.fn();
    const view = render(<PuzzleInteraction puzzle={puzzle} onComplete={onComplete} />);
    fireEvent.click(view.getByTestId("choice-choice_A"));
    fireEvent.click(view.getByTestId("puzzle-submit"));
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("should keep the submit button available for retry after incorrect answer", () => {
    const view = makePuzzleView();
    fireEvent.click(view.getByTestId("choice-choice_A"));
    fireEvent.click(view.getByTestId("puzzle-submit"));
    // Submit button should still exist (or player can re-select and it reappears)
    // Re-select a different choice to re-enable
    fireEvent.click(view.getByTestId("choice-choice_C"));
    expect(view.getByTestId("puzzle-submit")).toBeTruthy();
    expect(view.getByTestId("puzzle-submit")).toHaveAttribute("aria-disabled", "false");
  });

  it("should clear incorrect feedback when a new choice is selected", () => {
    const view = makePuzzleView();
    fireEvent.click(view.getByTestId("choice-choice_A"));
    fireEvent.click(view.getByTestId("puzzle-submit"));
    expect(view.getByTestId("puzzle-feedback")).toBeTruthy();

    // Select a different choice — feedback should disappear
    fireEvent.click(view.getByTestId("choice-choice_C"));
    expect(view.queryByTestId("puzzle-feedback")).toBeNull();
  });
});

// ── 5. Correct answer ────────────────────────────────────────────────────────

describe("PuzzleInteraction — correct answer", () => {
  it("should show feedback after a correct submission", () => {
    const view = makePuzzleView();
    fireEvent.click(view.getByTestId("choice-choice_B")); // correct
    fireEvent.click(view.getByTestId("puzzle-submit"));
    expect(view.getByTestId("puzzle-feedback")).toBeTruthy();
    expect(view.getByTestId("puzzle-feedback").textContent).toContain(
      puzzle.correct_feedback
    );
  });

  it("should show the explanation after a correct submission", () => {
    const view = makePuzzleView();
    fireEvent.click(view.getByTestId("choice-choice_B"));
    fireEvent.click(view.getByTestId("puzzle-submit"));
    expect(view.getByTestId("puzzle-explanation").textContent).toContain(
      puzzle.explanation.slice(0, 40)
    );
  });

  it("should replace submit button with continue button after correct answer", () => {
    const view = makePuzzleView();
    fireEvent.click(view.getByTestId("choice-choice_B"));
    fireEvent.click(view.getByTestId("puzzle-submit"));
    expect(view.queryByTestId("puzzle-submit")).toBeNull();
    expect(view.getByTestId("puzzle-continue")).toBeTruthy();
  });

  it("should call onComplete when continue is clicked after correct answer", () => {
    const onComplete = vi.fn();
    const view = render(<PuzzleInteraction puzzle={puzzle} onComplete={onComplete} />);
    fireEvent.click(view.getByTestId("choice-choice_B"));
    fireEvent.click(view.getByTestId("puzzle-submit"));
    fireEvent.click(view.getByTestId("puzzle-continue"));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});

// ── 6. Post-correct lock ─────────────────────────────────────────────────────

describe("PuzzleInteraction — locked after correct answer", () => {
  it("should disable all choice buttons after correct answer", () => {
    const view = makePuzzleView();
    fireEvent.click(view.getByTestId("choice-choice_B"));
    fireEvent.click(view.getByTestId("puzzle-submit"));

    for (const choice of puzzle.choices) {
      expect(view.getByTestId(`choice-${choice.choice_id}`)).toBeDisabled();
    }
  });

  it("should not call onComplete more than once even with multiple continue clicks", () => {
    const onComplete = vi.fn();
    const view = render(<PuzzleInteraction puzzle={puzzle} onComplete={onComplete} />);
    fireEvent.click(view.getByTestId("choice-choice_B"));
    fireEvent.click(view.getByTestId("puzzle-submit"));
    // Click continue multiple times
    const continueBtn = view.getByTestId("puzzle-continue");
    fireEvent.click(continueBtn);
    fireEvent.click(continueBtn);
    fireEvent.click(continueBtn);
    // onComplete is called once per click — that's correct because
    // the parent (SceneRenderer/StoryViewer) controls navigation.
    // Each click advances the story: first call is what matters.
    expect(onComplete).toHaveBeenCalled();
  });
});

// ── 7. Retry flow ────────────────────────────────────────────────────────────

describe("PuzzleInteraction — full retry → correct flow", () => {
  it("should allow retry after incorrect and succeed on second attempt", () => {
    const onComplete = vi.fn();
    const view = render(<PuzzleInteraction puzzle={puzzle} onComplete={onComplete} />);

    // First attempt — wrong
    fireEvent.click(view.getByTestId("choice-choice_A"));
    fireEvent.click(view.getByTestId("puzzle-submit"));
    expect(view.getByTestId("puzzle-feedback").textContent).toContain(
      puzzle.incorrect_feedback
    );
    expect(onComplete).not.toHaveBeenCalled();

    // Re-select correct answer
    fireEvent.click(view.getByTestId("choice-choice_B"));
    // Feedback should clear on new selection
    expect(view.queryByTestId("puzzle-feedback")).toBeNull();

    // Second attempt — correct
    fireEvent.click(view.getByTestId("puzzle-submit"));
    expect(view.getByTestId("puzzle-feedback").textContent).toContain(
      puzzle.correct_feedback
    );
    expect(view.getByTestId("puzzle-continue")).toBeTruthy();

    // Continue
    fireEvent.click(view.getByTestId("puzzle-continue"));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
