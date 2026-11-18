/**
 * Tests — Bad branches (wrong-choice consequence sequences)
 *
 * @vitest-environment jsdom
 *
 * Uses the demo story ("The Fading Light" in dummy-campaign.ts), whose
 * puzzles map some wrong choices to multi-scene consequence branches via
 * `on_incorrect_scene_id`:
 *
 *   puzzle_01 (scene_05_puzzle): choice_B correct
 *     choice_A → scene_bad_A_start → scene_bad_A_collapse → scene_bad_A_ending
 *     choice_C → scene_bad_C_start → scene_bad_C_inversion → scene_bad_C_ending
 *   puzzle_02 (scene_11_puzzle2): choice_Q correct
 *
 * Expected flow for a branching wrong choice:
 *   HP − 1 → play every scene of the branch, including its ending →
 *   "Try a different choice" → back to a fresh puzzle (HP stays deducted).
 */

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { StoryViewer } from "@/components/story/StoryViewer";
import { dummyStory, dummyCampaign } from "@/data/dummy-campaign";
import type { PlayerKnowledge } from "@/lib/types/game";
import type { StoryBlueprint } from "@/lib/types/story";

const characters = dummyCampaign.characters;

type View = ReturnType<typeof render>;

function clickToAdvance(view: View) {
  act(() => { fireEvent.click(view.getByTestId("story-main")); });
}

function advanceToPuzzle(view: View) {
  for (let i = 0; i < 80; i++) {
    if (view.queryByTestId("puzzle-interaction")) return;
    clickToAdvance(view);
  }
  throw new Error("puzzle never appeared");
}

function submit(view: View, choiceId: string) {
  act(() => { fireEvent.click(view.getByTestId(`choice-${choiceId}`)); });
  act(() => { fireEvent.click(view.getByTestId("puzzle-submit")); });
}

function returnButton(view: View) {
  return (
    view.queryByTestId("bad-ending-return-btn") ??
    view.queryByTestId("bad-branch-return-btn")
  );
}

/**
 * Click through a bad branch until a "Try a different choice" button shows.
 * Returns the text of every scene seen on the way.
 */
function playBranchToEnd(view: View): string[] {
  const seen: string[] = [];
  for (let i = 0; i < 50; i++) {
    seen.push(view.getByTestId("story-main").textContent ?? "");
    if (returnButton(view)) return seen;
    clickToAdvance(view);
  }
  throw new Error("bad branch never offered a way back to the puzzle");
}

function renderDemo(props: Partial<React.ComponentProps<typeof StoryViewer>> = {}) {
  return render(<StoryViewer story={dummyStory} characters={characters} {...props} />);
}

describe("Bad branch — entering the branch", () => {
  it("labels the submit button differently for a branching wrong choice", () => {
    const view = renderDemo();
    advanceToPuzzle(view);

    act(() => { fireEvent.click(view.getByTestId("choice-choice_A")); });
    expect(view.getByTestId("puzzle-submit").textContent).toBe("Confirm choice →");

    act(() => { fireEvent.click(view.getByTestId("choice-choice_B")); });
    expect(view.getByTestId("puzzle-submit").textContent).toBe("Submit Answer");
  });

  it("costs 1 HP and leaves the puzzle for the consequence scene", () => {
    const view = renderDemo();
    advanceToPuzzle(view);
    submit(view, "choice_A");

    expect(view.getByTestId("hp-value").textContent).toContain("4 / 5");
    expect(view.queryByTestId("puzzle-interaction")).toBeNull();
    expect(view.getByTestId("scene-content").textContent).toContain(
      "You place one Crystal A and one Crystal B"
    );
  });

  it("records the wrong answer as knowledge evidence", () => {
    let knowledge: Record<string, PlayerKnowledge> = {};
    const onKnowledgeUpdate = vi.fn((updates: Record<string, PlayerKnowledge>) => {
      knowledge = { ...knowledge, ...updates };
    });
    const view = renderDemo({ onKnowledgeUpdate, playerKnowledge: {} });
    advanceToPuzzle(view);
    submit(view, "choice_A");

    expect(knowledge.concept_linear_combination?.status).toBe("developing");
  });
});

describe("Bad branch — playing it out", () => {
  it("plays every scene of the branch, including its ending", () => {
    const view = renderDemo();
    advanceToPuzzle(view);
    submit(view, "choice_A");
    const seen = playBranchToEnd(view);

    // scene_bad_A_collapse
    expect(seen.some((t) => t.includes("The Southern Ward just went dark."))).toBe(true);
    // scene_bad_A_ending → ending_bad_underpowered
    expect(view.getByTestId("ending-display").textContent).toContain("The City Dims");
    expect(view.getByTestId("bad-ending-return-btn")).toBeTruthy();
  });

  it("stops at a branch scene with no next scene and offers the way back", () => {
    const story: StoryBlueprint = JSON.parse(JSON.stringify(dummyStory));
    const start = story.chapters
      .flatMap((c) => c.scenes)
      .find((s) => s.scene_id === "scene_bad_A_start");
    if (!start || start.type !== "consequence") throw new Error("fixture changed: scene_bad_A_start");
    start.next_scene_id = null;

    const view = render(<StoryViewer story={story} characters={characters} />);
    advanceToPuzzle(view);
    submit(view, "choice_A");
    playBranchToEnd(view);

    expect(view.getByTestId("bad-branch-return-btn")).toBeTruthy();
    expect(view.queryByText("Click anywhere to continue")).toBeNull();
    // Further clicks do not move past the dead end.
    clickToAdvance(view);
    expect(view.getByTestId("bad-branch-return-btn")).toBeTruthy();
    expect(view.queryByTestId("ending-display")).toBeNull();
  });

  it("never shows the story-complete panel at a bad ending", () => {
    const view = renderDemo({ onStoryComplete: vi.fn(), onExit: vi.fn() });
    advanceToPuzzle(view);
    submit(view, "choice_C");
    playBranchToEnd(view);

    expect(view.getByTestId("ending-display").textContent).toContain("The Fracture");
    expect(view.queryByTestId("story-complete-screen")).toBeNull();
  });
});

describe("Bad branch — returning to the puzzle", () => {
  it("gives a fresh attempt and keeps the HP already lost", () => {
    const view = renderDemo();
    advanceToPuzzle(view);
    submit(view, "choice_A");
    playBranchToEnd(view);
    act(() => { fireEvent.click(returnButton(view)!); });

    expect(view.getByTestId("puzzle-interaction")).toBeTruthy();
    expect(view.queryByTestId("puzzle-feedback")).toBeNull();
    expect(view.getByTestId("puzzle-submit")).toHaveAttribute("aria-disabled", "true");
    expect(view.getByTestId("hp-value").textContent).toContain("4 / 5");

    submit(view, "choice_B");
    expect(view.getByTestId("puzzle-continue")).toBeTruthy();
    expect(view.getByTestId("hp-value").textContent).toContain("4 / 5");
  });

  it("fails the story after five wrong answers through bad branches", () => {
    const view = renderDemo();
    advanceToPuzzle(view);
    for (let i = 0; i < 5; i++) {
      submit(view, i % 2 === 0 ? "choice_A" : "choice_C");
      if (view.queryByTestId("story-failure")) break;
      playBranchToEnd(view);
      act(() => { fireEvent.click(returnButton(view)!); });
    }

    expect(view.getByTestId("story-failure")).toBeTruthy();
    expect(view.getByTestId("hp-value").textContent).toMatch(/0\s*\/\s*5/);
  });
});

describe("Demo story — correct path", () => {
  it("reaches the good ending when both puzzles are answered correctly", () => {
    const correct: Record<string, string> = {
      puzzle_01: "choice_B",
      puzzle_02: "choice_Q",
    };
    const view = renderDemo({ onStoryComplete: vi.fn(), onExit: vi.fn() });

    for (let i = 0; i < 200; i++) {
      if (view.queryByTestId("story-complete-screen")) break;
      if (view.queryByTestId("puzzle-interaction")) {
        const choiceId = view.queryByTestId("choice-choice_B") ? correct.puzzle_01 : correct.puzzle_02;
        submit(view, choiceId);
        act(() => { fireEvent.click(view.getByTestId("puzzle-continue")); });
        continue;
      }
      clickToAdvance(view);
    }

    expect(view.getByTestId("ending-display").textContent).toContain("The City Holds");
    expect(view.getByTestId("story-complete-screen")).toBeTruthy();
    expect(view.getByTestId("hp-value").textContent).toContain("5 / 5");
  });
});
