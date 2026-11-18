/**
 * Tests — CampaignPlayer (story-to-story transition)
 *
 * @vitest-environment jsdom
 *
 * Plays a two-story campaign end to end through the real useCampaign hook,
 * the way /game does. Guards the "Continue Campaign" transition: the next
 * story must start fresh (first scene, full HP) and must not be marked
 * complete until it is actually played.
 */

import { describe, it, expect } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { CampaignPlayer } from "@/components/campaign/CampaignPlayer";
import { dummyCampaign } from "@/data/dummy-campaign";
import type { StoryBlueprint } from "@/lib/types/story";
import { linearStory, linearStory2 } from "../fixtures/linear-story";

const STORIES: ReadonlyMap<string, StoryBlueprint> = new Map([
  [linearStory.story_id, linearStory],
  [linearStory2.story_id, linearStory2],
]);

type View = ReturnType<typeof render>;

function clickToAdvance(view: View) {
  act(() => { fireEvent.click(view.getByTestId("story-main")); });
}

function answer(view: View, choiceId: string) {
  act(() => { fireEvent.click(view.getByTestId(`choice-${choiceId}`)); });
  act(() => { fireEvent.click(view.getByTestId("puzzle-submit")); });
}

/**
 * Advance until the story-complete panel appears. Puzzles are answered
 * correctly (choice_B); pass `wrongFirst` to submit choice_A once before that.
 */
function playToStoryComplete(view: View, { wrongFirst = false } = {}) {
  let wrongPending = wrongFirst;
  for (let i = 0; i < 100; i++) {
    if (view.queryByTestId("story-complete-screen")) return;
    if (view.queryByTestId("puzzle-interaction")) {
      if (wrongPending) {
        answer(view, "choice_A");
        wrongPending = false;
      }
      answer(view, "choice_B");
      act(() => { fireEvent.click(view.getByTestId("puzzle-continue")); });
      continue;
    }
    clickToAdvance(view);
  }
  throw new Error("story-complete-screen never appeared");
}

function continueCampaign(view: View) {
  act(() => { fireEvent.click(view.getByTestId("continue-campaign-button")); });
}

describe("CampaignPlayer — Continue Campaign transition", () => {
  it("starts the next story at its first scene", () => {
    const view = render(<CampaignPlayer campaign={dummyCampaign} stories={STORIES} />);
    playToStoryComplete(view);
    continueCampaign(view);

    expect(view.getByTestId("sidebar-story-title").textContent).toContain(
      linearStory2.title
    );
    expect(view.queryByText("Loading scene…")).toBeNull();
    expect(view.getByTestId("narration-block").textContent).toContain(
      "The outer ward is quieter"
    );
  });

  it("does not show the completion panel for a story that has not been played", () => {
    const view = render(<CampaignPlayer campaign={dummyCampaign} stories={STORIES} />);
    playToStoryComplete(view);
    continueCampaign(view);

    expect(view.queryByTestId("story-complete-screen")).toBeNull();
    expect(view.queryByTestId("ending-display")).toBeNull();
  });

  it("restores full HP for the next story", () => {
    const view = render(<CampaignPlayer campaign={dummyCampaign} stories={STORIES} />);
    playToStoryComplete(view, { wrongFirst: true });
    expect(view.getByTestId("hp-value").textContent).toContain("4 / 5");

    continueCampaign(view);
    expect(view.getByTestId("hp-value").textContent).toContain("5 / 5");
  });

  it("reaches campaign complete only after both stories are played", () => {
    const view = render(<CampaignPlayer campaign={dummyCampaign} stories={STORIES} />);
    playToStoryComplete(view);
    continueCampaign(view);

    playToStoryComplete(view);
    expect(view.getByTestId("ending-display").textContent).toContain(
      "The Districts Hold"
    );
    expect(view.getByTestId("story-complete-title").textContent).toContain(
      linearStory2.title
    );
    expect(view.queryByTestId("campaign-complete-message")).toBeNull();

    continueCampaign(view);
    expect(view.getByTestId("campaign-complete-message")).toBeTruthy();
  });
});
