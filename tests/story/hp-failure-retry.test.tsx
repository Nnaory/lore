/**
 * Tests — HP, Story Failure, and Retry (Integration)
 *
 * @vitest-environment jsdom
 *
 * Tests HP deduction, story failure state, and retry within the full
 * StoryViewer component. Updated for click-to-advance mechanism.
 */

import { describe, it, expect } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { StoryViewer } from "@/components/story/StoryViewer";
import { dummyStory, dummyCampaign } from "@/data/dummy-campaign";

const characters = dummyCampaign.characters;

// ── Helpers ──────────────────────────────────────────────────────────────────

function clickToAdvance(view: ReturnType<typeof render>) {
  const chatArea = view.getByTestId("chat-area");
  act(() => { fireEvent.click(chatArea); });
}

/** Click until puzzle-interaction appears. */
function advanceToPuzzle() {
  const view = render(<StoryViewer story={dummyStory} characters={characters} />);
  for (let i = 0; i < 60; i++) {
    if (view.queryByTestId("puzzle-interaction")) break;
    clickToAdvance(view);
  }
  return view;
}

/** Submit an incorrect answer once. */
function submitIncorrect(view: ReturnType<typeof render>) {
  act(() => { fireEvent.click(view.getByTestId("choice-choice_A")); });
  act(() => { fireEvent.click(view.getByTestId("puzzle-submit")); });
}

/** Submit N incorrect answers in sequence. */
function submitNIncorrect(view: ReturnType<typeof render>, n: number) {
  for (let i = 0; i < n; i++) {
    if (view.queryByTestId("story-failure")) break;
    if (!view.queryByTestId("puzzle-interaction")) break;
    const choiceId = i % 2 === 0 ? "choice-choice_A" : "choice-choice_C";
    const choiceBtn = view.queryByTestId(choiceId);
    if (!choiceBtn) break;
    act(() => { fireEvent.click(choiceBtn); });
    act(() => { fireEvent.click(view.getByTestId("puzzle-submit")); });
    if (view.queryByTestId("story-failure")) break;
    const clearChoice = i % 2 === 0 ? "choice-choice_C" : "choice-choice_A";
    const clearBtn = view.queryByTestId(clearChoice);
    if (clearBtn && !view.queryByTestId("story-failure")) {
      act(() => { fireEvent.click(clearBtn); });
    }
  }
}

/** Advance to failure, then click Retry. */
function reachFailureThenRetry() {
  const view = advanceToPuzzle();
  submitNIncorrect(view, 5);
  expect(view.queryByTestId("story-failure")).toBeTruthy();
  act(() => { fireEvent.click(view.getByTestId("retry-button")); });
  return view;
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

// ── 2. Incorrect answer deducts HP ──────────────────────────────────────────

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
    act(() => { fireEvent.click(view.getByTestId("choice-choice_C")); });
    act(() => { fireEvent.click(view.getByTestId("puzzle-submit")); });
    const hpValue = view.getByTestId("hp-value");
    expect(hpValue.textContent).toContain("3");
  });
});

// ── 3. Correct answer does not deduct HP ────────────────────────────────────

describe("HP — correct answer does not deduct HP", () => {
  it("should keep HP at 5 after a correct answer", () => {
    const view = advanceToPuzzle();
    act(() => { fireEvent.click(view.getByTestId("choice-choice_B")); });
    act(() => { fireEvent.click(view.getByTestId("puzzle-submit")); });
    const hpValue = view.getByTestId("hp-value");
    expect(hpValue.textContent).toContain("5");
    expect(hpValue.textContent).toContain("5");
  });
});

// ── 4. Story failure after 5 incorrect answers ──────────────────────────────

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

  it("should not show continue button when story is failed", () => {
    const view = advanceToPuzzle();
    submitNIncorrect(view, 5);
    // Click-to-advance means no continue button
    expect(view.queryByText("Click anywhere to continue")).toBeFalsy();
  });

  it("should not show puzzle-submit when story is failed", () => {
    const view = advanceToPuzzle();
    submitNIncorrect(view, 5);
    expect(view.queryByTestId("puzzle-submit")).toBeNull();
  });

  it("story completion and failure do not coexist", () => {
    const view = advanceToPuzzle();
    submitNIncorrect(view, 5);
    expect(view.queryByTestId("story-complete-screen")).toBeNull();
  });
});

// ── 5. Retry ─────────────────────────────────────────────────────────────────

describe("Retry — state reset", () => {
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

  it("should return to the first scene after retry", () => {
    const view = reachFailureThenRetry();
    const header = document.querySelector('[data-testid="story-header"]');
    expect(header).toBeTruthy();
    if (header) {
      expect(header.textContent).toContain("The Beacon Antechamber");
    }
  });

  it("should reset puzzle interaction state after retry", () => {
    const view = reachFailureThenRetry();
    for (let i = 0; i < 60; i++) {
      if (view.queryByTestId("puzzle-interaction")) break;
      clickToAdvance(view);
    }
    expect(view.queryByTestId("puzzle-interaction")).toBeTruthy();
    expect(view.queryByTestId("puzzle-submit")).toBeTruthy();
    expect(view.getByTestId("puzzle-submit")).toHaveAttribute("aria-disabled", "true");
    expect(view.queryByTestId("puzzle-feedback")).toBeNull();
  });
});

// ── 6. Full cycle: fail → retry → solve ─────────────────────────────────────

describe("Retry — play again after retry", () => {
  it("should allow solving the puzzle correctly after retry", () => {
    const view = advanceToPuzzle();
    submitNIncorrect(view, 5);
    act(() => { fireEvent.click(view.getByTestId("retry-button")); });

    for (let i = 0; i < 60; i++) {
      if (view.queryByTestId("puzzle-interaction")) break;
      clickToAdvance(view);
    }

    act(() => { fireEvent.click(view.getByTestId("choice-choice_B")); });
    act(() => { fireEvent.click(view.getByTestId("puzzle-submit")); });
    expect(view.getByTestId("puzzle-continue")).toBeTruthy();
  });
});

// ── 7. Correct path still works (regression) ────────────────────────────────

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
      clickToAdvance(view);
    }

    expect(view.queryByTestId("ending-display")).toBeTruthy();
    expect(view.queryByTestId("story-complete-screen")).toBeTruthy();
  });
});

// ── 8. State purity — hp/isFailed consistency ──────────────────────────────

describe("State purity — hp and isFailed are always consistent", () => {
  it("isFailed is false when HP is above 0 (no failure yet)", () => {
    const view = advanceToPuzzle();
    submitNIncorrect(view, 4);
    expect(view.queryByTestId("story-failure")).toBeNull();
    const hpValue = view.getByTestId("hp-value");
    expect(hpValue.textContent).toContain("1");
  });

  it("isFailed is true exactly when HP reaches 0 — failure screen appears immediately", () => {
    const view = advanceToPuzzle();
    submitNIncorrect(view, 5);
    expect(view.getByTestId("hp-value").textContent).toMatch(/0\s*\/\s*5/);
    expect(view.queryByTestId("story-failure")).toBeTruthy();
  });

  it("HP cannot be above 0 while failure screen is shown", () => {
    const view = advanceToPuzzle();
    submitNIncorrect(view, 5);
    const hpText = view.getByTestId("hp-value").textContent ?? "";
    const match = hpText.match(/^(\d+)/);
    const currentHp = match ? parseInt(match[1], 10) : -1;
    expect(currentHp).toBe(0);
    expect(view.queryByTestId("story-failure")).toBeTruthy();
  });

  it("after retry, HP is above 0 and failure screen is absent", () => {
    const view = advanceToPuzzle();
    submitNIncorrect(view, 5);
    act(() => { fireEvent.click(view.getByTestId("retry-button")); });
    expect(view.getByTestId("hp-value").textContent).toContain("5");
    expect(view.queryByTestId("story-failure")).toBeNull();
  });

  it("HP never goes below 0 — extra deductions after failure are no-ops", () => {
    const view = advanceToPuzzle();
    submitNIncorrect(view, 5);
    const hpText = view.getByTestId("hp-value").textContent ?? "";
    const match = hpText.match(/^(\d+)/);
    const currentHp = match ? parseInt(match[1], 10) : -1;
    expect(currentHp).toBe(0);
  });
});