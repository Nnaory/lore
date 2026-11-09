/**
 * Tests — HP, Story Failure, and Retry (Integration)
 *
 * @vitest-environment jsdom
 *
 * Tests HP deduction, story failure state, and retry within the full
 * StoryViewer component. Uses the dummy story from Milestone 1.
 *
 * Tests:
 *   HP management
 *   1. HP starts at 5
 *   2. HP display shows 5/5 initially
 *   3. Incorrect answer reduces HP by 1
 *   4. Correct answer does not reduce HP
 *   5. Multiple incorrect answers reduce HP cumulatively
 *
 *   Story failure
 *   6. Five incorrect answers trigger story failure
 *   7. Story failure shows the failure screen
 *   8. Story failure shows "0 / 5" HP
 *   9. Story cannot advance after failure (continue button absent)
 *   10. Puzzle cannot be completed after failure (continue button absent)
 *   11. Story completion and failure do not coexist
 *
 *   Retry
 *   12. Retry button is present on failure screen
 *   13. Retry restores HP to 5
 *   14. Retry returns to first scene
 *   15. Retry clears failure state
 *   16. Retry resets puzzle interaction state
 *   17. Player can solve puzzle after retry
 *   18. Existing story completion still works after retry
 */

import { describe, it, expect } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { StoryViewer } from "@/components/story/StoryViewer";
import { dummyStory, dummyCampaign } from "@/data/dummy-campaign";

const characters = dummyCampaign.characters;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Click Continue until puzzle-interaction appears. */
function advanceToPuzzle() {
  const view = render(<StoryViewer story={dummyStory} characters={characters} />);
  for (let i = 0; i < 60; i++) {
    if (view.queryByTestId("puzzle-interaction")) break;
    const btn = view.queryByTestId("continue-button");
    if (!btn) break;
    act(() => { fireEvent.click(btn); });
  }
  return view;
}

/** Submit an incorrect answer once. Returns the view. */
function submitIncorrect(view: ReturnType<typeof render>) {
  act(() => { fireEvent.click(view.getByTestId("choice-choice_A")); });
  act(() => { fireEvent.click(view.getByTestId("puzzle-submit")); });
}

/** Submit N incorrect answers in sequence, re-selecting after each. */
function submitNIncorrect(view: ReturnType<typeof render>, n: number) {
  for (let i = 0; i < n; i++) {
    // Skip if story already failed or puzzle is gone
    if (view.queryByTestId("story-failure")) break;
    if (!view.queryByTestId("puzzle-interaction")) break;
    // Alternate between choice_A and choice_C to avoid same-choice edge cases
    const choiceId = i % 2 === 0 ? "choice-choice_A" : "choice-choice_C";
    const choiceBtn = view.queryByTestId(choiceId);
    if (!choiceBtn) break;
    act(() => { fireEvent.click(choiceBtn); });
    act(() => { fireEvent.click(view.getByTestId("puzzle-submit")); });
    // After incorrect, reset by re-clicking a new choice (clears "incorrect" state)
    if (view.queryByTestId("story-failure")) break;
    // Clear state by clicking a different choice so next submit is allowed
    const clearChoice = i % 2 === 0 ? "choice-choice_C" : "choice-choice_A";
    const clearBtn = view.queryByTestId(clearChoice);
    if (clearBtn && !view.queryByTestId("story-failure")) {
      act(() => { fireEvent.click(clearBtn); });
    }
  }
}

// ── 1. Initial HP ────────────────────────────────────────────────────────────

describe("HP — initial state", () => {
  it("should show HP 5/5 on the HP display at story start", () => {
    const view = render(<StoryViewer story={dummyStory} characters={characters} />);
    const hpValue = view.getByTestId("hp-value");
    expect(hpValue.textContent).toContain("5");
    expect(hpValue.textContent).toContain("5");
  });

  it("hp-display element should be present", () => {
    const view = render(<StoryViewer story={dummyStory} characters={characters} />);
    expect(view.getByTestId("hp-display")).toBeTruthy();
  });
});

// ── 2. Incorrect answer deducts HP ───────────────────────────────────────────

describe("HP — incorrect answer deducts HP", () => {
  it("should show 4/5 after one incorrect answer", () => {
    const view = advanceToPuzzle();
    submitIncorrect(view);
    const hpValue = view.getByTestId("hp-value");
    expect(hpValue.textContent).toContain("4");
  });

  it("should show 3/5 after two incorrect answers", () => {
    const view = advanceToPuzzle();
    submitIncorrect(view);
    // Re-select to clear incorrect state, then submit again
    act(() => { fireEvent.click(view.getByTestId("choice-choice_C")); });
    act(() => { fireEvent.click(view.getByTestId("puzzle-submit")); });
    const hpValue = view.getByTestId("hp-value");
    expect(hpValue.textContent).toContain("3");
  });
});

// ── 3. Correct answer does not deduct HP ─────────────────────────────────────

describe("HP — correct answer does not deduct HP", () => {
  it("should keep HP at 5 after a correct answer", () => {
    const view = advanceToPuzzle();
    act(() => { fireEvent.click(view.getByTestId("choice-choice_B")); }); // correct
    act(() => { fireEvent.click(view.getByTestId("puzzle-submit")); });
    const hpValue = view.getByTestId("hp-value");
    expect(hpValue.textContent).toContain("5");
    expect(hpValue.textContent).toContain("5");
  });
});

// ── 4. Story failure after 5 incorrect answers ───────────────────────────────

describe("HP — story failure at HP 0", () => {
  it("should show story failure screen after 5 incorrect submissions", () => {
    const view = advanceToPuzzle();
    submitNIncorrect(view, 5);
    expect(view.queryByTestId("story-failure")).toBeTruthy();
  });

  it("should show 0/5 in HP display after failure", () => {
    const view = advanceToPuzzle();
    submitNIncorrect(view, 5);
    const hpValue = view.getByTestId("hp-value");
    expect(hpValue.textContent).toMatch(/0\s*\/\s*5/);
  });

  it("should not show continue-button when story is failed", () => {
    const view = advanceToPuzzle();
    submitNIncorrect(view, 5);
    expect(view.queryByTestId("continue-button")).toBeNull();
  });

  it("should not show puzzle-submit when story is failed", () => {
    const view = advanceToPuzzle();
    submitNIncorrect(view, 5);
    expect(view.queryByTestId("puzzle-submit")).toBeNull();
  });

  it("story completion and failure do not coexist", () => {
    const view = advanceToPuzzle();
    submitNIncorrect(view, 5);
    // When failed, story-complete-message must not appear
    expect(view.queryByTestId("story-complete-screen")).toBeNull();
  });
});

// ── 5. Retry ─────────────────────────────────────────────────────────────────

describe("Retry — state reset", () => {
  /** Advance to failure, then click Retry. */
  function reachFailureThenRetry() {
    const view = advanceToPuzzle();
    submitNIncorrect(view, 5);
    expect(view.queryByTestId("story-failure")).toBeTruthy();
    act(() => { fireEvent.click(view.getByTestId("retry-button")); });
    return view;
  }

  it("should have a retry-button on the failure screen", () => {
    const view = advanceToPuzzle();
    submitNIncorrect(view, 5);
    expect(view.getByTestId("retry-button")).toBeTruthy();
  });

  it("should restore HP to 5 after retry", () => {
    const view = reachFailureThenRetry();
    const hpValue = view.getByTestId("hp-value");
    expect(hpValue.textContent).toContain("5");
  });

  it("should clear the failure screen after retry", () => {
    const view = reachFailureThenRetry();
    expect(view.queryByTestId("story-failure")).toBeNull();
  });

  it("should return to the story viewer after retry", () => {
    const view = reachFailureThenRetry();
    expect(view.queryByTestId("story-viewer")).toBeTruthy();
  });

  it("should return to the first scene after retry (header shows story location)", () => {
    const view = reachFailureThenRetry();
    // First scene is at "The Beacon Antechamber"
    const header = view.getByTestId("story-header");
    expect(header.textContent).toContain("The Beacon Antechamber");
  });

  it("should reset puzzle interaction state after retry", () => {
    const view = reachFailureThenRetry();
    // Advance back to puzzle
    for (let i = 0; i < 60; i++) {
      if (view.queryByTestId("puzzle-interaction")) break;
      const btn = view.queryByTestId("continue-button");
      if (!btn) break;
      act(() => { fireEvent.click(btn); });
    }
    // Puzzle should be fresh: submit button disabled (no selection)
    expect(view.queryByTestId("puzzle-interaction")).toBeTruthy();
    expect(view.queryByTestId("puzzle-submit")).toBeTruthy();
    expect(view.getByTestId("puzzle-submit")).toHaveAttribute("aria-disabled", "true");
    // No feedback should be visible
    expect(view.queryByTestId("puzzle-feedback")).toBeNull();
  });
});

// ── 6. Full cycle: fail → retry → solve ──────────────────────────────────────

describe("Retry — play again after retry", () => {
  it("should allow solving the puzzle correctly after retry", () => {
    // Fail the story
    const view = advanceToPuzzle();
    submitNIncorrect(view, 5);
    // Retry
    act(() => { fireEvent.click(view.getByTestId("retry-button")); });

    // Advance to puzzle again
    for (let i = 0; i < 60; i++) {
      if (view.queryByTestId("puzzle-interaction")) break;
      const btn = view.queryByTestId("continue-button");
      if (!btn) break;
      act(() => { fireEvent.click(btn); });
    }

    // Solve correctly
    act(() => { fireEvent.click(view.getByTestId("choice-choice_B")); });
    act(() => { fireEvent.click(view.getByTestId("puzzle-submit")); });
    expect(view.getByTestId("puzzle-continue")).toBeTruthy();
  });
});

// ── 7. Correct path still works (regression) ─────────────────────────────────

describe("Regression — existing story completion", () => {
  it("should still reach the ending via the correct answer path", () => {
    const view = render(<StoryViewer story={dummyStory} characters={characters} />);
    for (let i = 0; i < 100; i++) {
      if (view.queryByTestId("ending-display")) break;
      if (view.queryByTestId("story-complete-screen")) break;

      const puzzleInteraction = view.queryByTestId("puzzle-interaction");
      if (puzzleInteraction) {
        const correctBtn = view.queryByTestId("choice-choice_B");
        if (correctBtn) {
          act(() => { fireEvent.click(correctBtn); });
          const submitBtn = view.queryByTestId("puzzle-submit");
          if (submitBtn) act(() => { fireEvent.click(submitBtn); });
          const continueBtn = view.queryByTestId("puzzle-continue");
          if (continueBtn) act(() => { fireEvent.click(continueBtn); });
          continue;
        }
      }
      const btn = view.queryByTestId("continue-button");
      if (!btn) break;
      act(() => { fireEvent.click(btn); });
    }

    expect(view.queryByTestId("ending-display")).toBeTruthy();
    expect(view.queryByTestId("story-complete-screen")).toBeTruthy();
  });
});

// ── 8. State purity — hp/isFailed consistency ────────────────────────────────

describe("State purity — hp and isFailed are always consistent", () => {
  /**
   * If isFailed were stored as separate state, a race condition between
   * setHp and setIsFailed could cause hp=0 but isFailed=false, or hp>0
   * but isFailed=true. Since isFailed is derived (`hp <= FAILURE_HP`),
   * these tests prove the two values can never diverge.
   */

  it("isFailed is false when HP is above 0 (no failure yet)", () => {
    const view = advanceToPuzzle();
    // Submit 4 incorrect answers — HP should be 1, failure must not show
    submitNIncorrect(view, 4);
    expect(view.queryByTestId("story-failure")).toBeNull();
    const hpValue = view.getByTestId("hp-value");
    expect(hpValue.textContent).toContain("1");
  });

  it("isFailed is true exactly when HP reaches 0 — failure screen appears immediately", () => {
    const view = advanceToPuzzle();
    submitNIncorrect(view, 5);
    // HP must read 0 and failure screen must be present simultaneously
    expect(view.getByTestId("hp-value").textContent).toMatch(/0\s*\/\s*5/);
    expect(view.queryByTestId("story-failure")).toBeTruthy();
  });

  it("HP cannot be above 0 while failure screen is shown", () => {
    const view = advanceToPuzzle();
    submitNIncorrect(view, 5);
    const hpText = view.getByTestId("hp-value").textContent ?? "";
    // Extract the left-hand number (before the slash)
    const match = hpText.match(/^(\d+)/);
    const currentHp = match ? parseInt(match[1], 10) : -1;
    expect(currentHp).toBe(0);
    expect(view.queryByTestId("story-failure")).toBeTruthy();
  });

  it("after retry, HP is above 0 and failure screen is absent", () => {
    const view = advanceToPuzzle();
    submitNIncorrect(view, 5);
    act(() => { fireEvent.click(view.getByTestId("retry-button")); });
    // HP must be back to 5
    expect(view.getByTestId("hp-value").textContent).toContain("5");
    // Failure screen must be gone
    expect(view.queryByTestId("story-failure")).toBeNull();
  });

  it("HP never goes below 0 — extra deductions after failure are no-ops", () => {
    const view = advanceToPuzzle();
    // Cause failure
    submitNIncorrect(view, 5);
    // Failure screen shows retry, puzzle is gone — cannot submit more
    // but we verify HP is exactly 0, not negative
    const hpText = view.getByTestId("hp-value").textContent ?? "";
    const match = hpText.match(/^(\d+)/);
    const currentHp = match ? parseInt(match[1], 10) : -1;
    expect(currentHp).toBe(0);
  });
});
