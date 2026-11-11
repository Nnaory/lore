/**
 * Tests — Puzzle + Story Integration
 *
 * @vitest-environment jsdom
 *
 * Verifies that the puzzle system integrates correctly with the
 * existing story navigation. Updated for click-to-advance mechanism.
 */

import { describe, it, expect } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { StoryViewer } from "@/components/story/StoryViewer";
import { dummyStory, dummyCampaign } from "@/data/dummy-campaign";

const characters = dummyCampaign.characters;

// ── Helpers ────────────────────────────────────────────────────────────────

function clickToAdvance(view: ReturnType<typeof render>) {
  const chatArea = view.getByTestId("story-main");
  act(() => { fireEvent.click(chatArea); });
}

/** Click until the puzzle interaction is visible. */
function advanceToPuzzle() {
  const view = render(<StoryViewer story={dummyStory} characters={characters} />);
  for (let i = 0; i < 50; i++) {
    if (view.queryByTestId("puzzle-interaction")) break;
    clickToAdvance(view);
  }
  return view;
}

/** Advance all the way to the ending (correct answer path). */
function advanceToEnding() {
  const view = render(<StoryViewer story={dummyStory} characters={characters} />);
  for (let i = 0; i < 100; i++) {
    if (view.queryByTestId("ending-display")) break;
    if (view.queryByTestId("story-complete-screen")) break;

    const puzzleInteraction = view.queryByTestId("puzzle-interaction");
    if (puzzleInteraction) {
      const correctChoiceBtn = view.queryByTestId("choice-choice_B");
      if (correctChoiceBtn) {
        act(() => { fireEvent.click(correctChoiceBtn); });
        const submitBtn = view.queryByTestId("puzzle-submit");
        if (submitBtn) act(() => { fireEvent.click(submitBtn); });
        const continueBtn = view.queryByTestId("puzzle-continue");
        if (continueBtn) act(() => { fireEvent.click(continueBtn); });
        continue;
      }
    }

    clickToAdvance(view);
  }
  return view;
}

// ── 1. Navigate from previous scene to puzzle ────────────────────────────────

describe("Puzzle story integration — navigation to puzzle", () => {
  it("should reach the puzzle interaction from the story beginning", () => {
    const view = advanceToPuzzle();
    expect(view.queryByTestId("puzzle-interaction")).toBeTruthy();
  });

  it("should render PuzzleInteraction, not the old placeholder", () => {
    const view = advanceToPuzzle();
    expect(view.queryByTestId("puzzle-placeholder")).toBeNull();
    expect(view.queryByTestId("puzzle-interaction")).toBeTruthy();
  });

  it("should show the correct puzzle question in the interaction", () => {
    const view = advanceToPuzzle();
    const puzzle = dummyStory.puzzles[0];
    expect(view.getByTestId("puzzle-question").textContent).toContain(
      puzzle.question.slice(0, 20)
    );
  });
});

// ── 2. Incorrect answer keeps player in puzzle scene ─────────────────────────

describe("Puzzle story integration — incorrect answer", () => {
  it("should stay in puzzle scene after incorrect answer", () => {
    const view = advanceToPuzzle();

    act(() => { fireEvent.click(view.getByTestId("choice-choice_A")); });
    act(() => { fireEvent.click(view.getByTestId("puzzle-submit")); });

    expect(view.queryByTestId("puzzle-interaction")).toBeTruthy();
    expect(view.queryByTestId("ending-display")).toBeNull();
  });

  it("should not advance to next scene on incorrect answer", () => {
    const view = advanceToPuzzle();

    act(() => { fireEvent.click(view.getByTestId("choice-choice_A")); });
    act(() => { fireEvent.click(view.getByTestId("puzzle-submit")); });

    // Click hint should not appear (still in puzzle)
    expect(view.queryByText("Click anywhere to continue")).toBeFalsy();
    expect(view.queryByTestId("puzzle-interaction")).toBeTruthy();
  });

  it("should show incorrect feedback inline", () => {
    const view = advanceToPuzzle();
    act(() => { fireEvent.click(view.getByTestId("choice-choice_A")); });
    act(() => { fireEvent.click(view.getByTestId("puzzle-submit")); });
    expect(view.getByTestId("puzzle-feedback")).toBeTruthy();
  });
});

// ── 3. Correct answer advances to consequence scene ──────────────────────────

describe("Puzzle story integration — correct answer advances scene", () => {
  it("should show puzzle feedback and continue button after correct answer", () => {
    const view = advanceToPuzzle();
    act(() => { fireEvent.click(view.getByTestId("choice-choice_B")); });
    act(() => { fireEvent.click(view.getByTestId("puzzle-submit")); });
    expect(view.getByTestId("puzzle-continue")).toBeTruthy();
  });

  it("should advance to consequence scene (scene_04) after correct answer + continue", () => {
    const view = advanceToPuzzle();
    act(() => { fireEvent.click(view.getByTestId("choice-choice_B")); });
    act(() => { fireEvent.click(view.getByTestId("puzzle-submit")); });
    act(() => { fireEvent.click(view.getByTestId("puzzle-continue")); });

    expect(view.queryByTestId("puzzle-interaction")).toBeNull();
    expect(view.queryByTestId("scene-content")).toBeTruthy();
  });
});

// ── 4. Full path to ending still works ──────────────────────────────────────

describe("Puzzle story integration — full story completion", () => {
  it("should reach the ending after solving the puzzle", () => {
    const view = advanceToEnding();
    expect(view.queryByTestId("ending-display")).toBeTruthy();
  });

  it("should show the correct ending title", () => {
    const view = advanceToEnding();
    expect(view.queryByTestId("ending-display")?.textContent).toContain(
      "The Beacon Holds"
    );
  });

  it("should show story-complete message", () => {
    const view = advanceToEnding();
    expect(view.queryByTestId("story-complete-screen")).toBeTruthy();
  });
});