/**
 * Tests — Puzzle + Story Integration
 *
 * @vitest-environment jsdom
 *
 * Verifies that the puzzle system integrates correctly with the
 * existing story navigation:
 *   1. Player can navigate from previous scene to puzzle scene
 *   2. Puzzle scene renders the actual interaction (not placeholder)
 *   3. Incorrect answer keeps player in puzzle scene
 *   4. Correct answer advances to the correct next scene
 *   5. Existing ending and story completion still work
 */

import { describe, it, expect } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { StoryViewer } from "@/components/story/StoryViewer";
import { dummyStory, dummyCampaign } from "@/data/dummy-campaign";

const characters = dummyCampaign.characters;

/** Click continue until the puzzle interaction is visible. */
function advanceToPuzzle() {
  const view = render(<StoryViewer story={dummyStory} characters={characters} />);
  for (let i = 0; i < 50; i++) {
    if (view.queryByTestId("puzzle-interaction")) break;
    const btn = view.queryByTestId("continue-button");
    if (!btn) break;
    act(() => { fireEvent.click(btn); });
  }
  return view;
}

/** Advance all the way to the ending (correct answer path). */
function advanceToEnding() {
  const view = render(<StoryViewer story={dummyStory} characters={characters} />);
  for (let i = 0; i < 100; i++) {
    if (view.queryByTestId("ending-display")) break;
    if (view.queryByTestId("story-complete-screen")) break;

    // Handle puzzle interaction
    const puzzleInteraction = view.queryByTestId("puzzle-interaction");
    if (puzzleInteraction) {
      // Select correct choice and submit
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

    const btn = view.queryByTestId("continue-button");
    if (!btn) break;
    act(() => { fireEvent.click(btn); });
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

    // Submit incorrect answer
    act(() => { fireEvent.click(view.getByTestId("choice-choice_A")); });
    act(() => { fireEvent.click(view.getByTestId("puzzle-submit")); });

    // Puzzle interaction still visible
    expect(view.queryByTestId("puzzle-interaction")).toBeTruthy();
    // No ending, no consequence scene yet
    expect(view.queryByTestId("ending-display")).toBeNull();
  });

  it("should not advance to next scene on incorrect answer", () => {
    const view = advanceToPuzzle();

    act(() => { fireEvent.click(view.getByTestId("choice-choice_A")); });
    act(() => { fireEvent.click(view.getByTestId("puzzle-submit")); });

    // Continue button should not appear (still in puzzle, not in content scene)
    expect(view.queryByTestId("continue-button")).toBeNull();
    // Puzzle interaction should remain
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

    // Should now be in the consequence scene which has a continue-button
    // or showing content (no longer puzzle-interaction)
    expect(view.queryByTestId("puzzle-interaction")).toBeNull();
    expect(view.queryByTestId("scene-content")).toBeTruthy();
  });
});

// ── 4. Full path to ending still works ───────────────────────────────────────

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
