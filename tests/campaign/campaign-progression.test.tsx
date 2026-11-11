/**
 * Tests — Campaign Progression (Integration)
 *
 * @vitest-environment jsdom
 *
 * Tests story completion, campaign advancement, and exit behavior
 * using StoryViewer and the useCampaign hook via GamePage-like setup.
 * Updated for click-to-advance mechanism.
 */

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { StoryViewer } from "@/components/story/StoryViewer";
import { CampaignLobby } from "@/components/campaign/CampaignLobby";
import {
  dummyStory,
  dummyStory2,
  dummyCampaign,
  dummyCampaignState,
} from "@/data/dummy-campaign";
import {
  completeStory,
  createInitialCampaignState,
} from "@/lib/game/campaign-manager";

const characters = dummyCampaign.characters;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Click the chat area to advance story. */
function clickToAdvance(view: ReturnType<typeof render>) {
  const chatArea = view.getByTestId("chat-area");
  act(() => { fireEvent.click(chatArea); });
}

/** Advance through all scenes of dummyStory and reach the ending. */
function advanceToEnding(view: ReturnType<typeof render>) {
  for (let i = 0; i < 100; i++) {
    if (view.queryByTestId("story-complete-screen")) break;
    if (view.queryByTestId("ending-display")) {
      clickToAdvance(view);
      break;
    }
    const puzzleInteraction = view.queryByTestId("puzzle-interaction");
    if (puzzleInteraction) {
      const correct = view.queryByTestId("choice-choice_B");
      if (correct) {
        act(() => { fireEvent.click(correct); });
        const submit = view.queryByTestId("puzzle-submit");
        if (submit) act(() => { fireEvent.click(submit); });
        const continueBtn = view.queryByTestId("puzzle-continue");
        if (continueBtn) act(() => { fireEvent.click(continueBtn); });
        continue;
      }
    }
    clickToAdvance(view);
  }
}

/** Advance until puzzle interaction is visible. */
function advanceToPuzzle(view: ReturnType<typeof render>) {
  for (let i = 0; i < 60; i++) {
    if (view.queryByTestId("puzzle-interaction")) break;
    clickToAdvance(view);
  }
}

// ── Story completion screen ───────────────────────────────────────────────────

describe("StoryViewer — story completion screen", () => {
  it("should show story-complete-screen after reaching the ending", () => {
    const view = render(
      <StoryViewer story={dummyStory} characters={characters} onStoryComplete={vi.fn()} onExit={vi.fn()} />
    );
    advanceToEnding(view);
    expect(view.queryByTestId("story-complete-screen")).toBeTruthy();
  });

  it("should show the story title on the completion screen", () => {
    const view = render(
      <StoryViewer story={dummyStory} characters={characters} onStoryComplete={vi.fn()} onExit={vi.fn()} />
    );
    advanceToEnding(view);
    expect(view.queryByTestId("story-complete-title")?.textContent).toContain(
      dummyStory.title
    );
  });

  it("should show Continue Campaign button when campaign is not complete", () => {
    const view = render(
      <StoryViewer
        story={dummyStory}
        characters={characters}
        onStoryComplete={vi.fn()}
        onExit={vi.fn()}
        isCampaignComplete={false}
      />
    );
    advanceToEnding(view);
    expect(view.queryByTestId("continue-campaign-button")).toBeTruthy();
  });

  it("should call onStoryComplete when Continue Campaign is clicked", () => {
    const onStoryComplete = vi.fn();
    const view = render(
      <StoryViewer
        story={dummyStory}
        characters={characters}
        onStoryComplete={onStoryComplete}
        onExit={vi.fn()}
      />
    );
    advanceToEnding(view);
    const continueBtn = view.queryByTestId("continue-campaign-button");
    if (continueBtn) act(() => { fireEvent.click(continueBtn); });
    expect(onStoryComplete).toHaveBeenCalledTimes(1);
  });

  it("should call onExit when Exit Story is clicked from completion screen", () => {
    const onExit = vi.fn();
    const view = render(
      <StoryViewer story={dummyStory} characters={characters} onStoryComplete={vi.fn()} onExit={onExit} />
    );
    advanceToEnding(view);
    const exitBtn = view.queryByTestId("exit-button");
    if (exitBtn) act(() => { fireEvent.click(exitBtn); });
    expect(onExit).toHaveBeenCalled();
  });

  it("should show campaign complete message on final story", () => {
    const view = render(
      <StoryViewer
        story={dummyStory}
        characters={characters}
        onStoryComplete={vi.fn()}
        onExit={vi.fn()}
        isCampaignComplete={true}
      />
    );
    advanceToEnding(view);
    expect(view.queryByTestId("campaign-complete-message")).toBeTruthy();
    expect(view.queryByTestId("continue-campaign-button")).toBeNull();
  });
});

// ── Exit mid-story ────────────────────────────────────────────────────────────

describe("StoryViewer — exit mid-story", () => {
  it("should render the sidebar exit button", () => {
    const view = render(
      <StoryViewer story={dummyStory} characters={characters} onExit={vi.fn()} />
    );
    expect(view.queryByTestId("sidebar-exit-button")).toBeTruthy();
  });

  it("should call onExit when sidebar exit button is clicked", () => {
    const onExit = vi.fn();
    const view = render(
      <StoryViewer story={dummyStory} characters={characters} onExit={onExit} />
    );
    fireEvent.click(view.getByTestId("sidebar-exit-button"));
    const dialog = view.getByTestId("exit-confirm-dialog");
    fireEvent.click(dialog.querySelector("button:last-of-type")!); // Exit Anyway
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("should not call onStoryComplete when exit is clicked mid-story", () => {
    const onStoryComplete = vi.fn();
    const onExit = vi.fn();
    const view = render(
      <StoryViewer
        story={dummyStory}
        characters={characters}
        onStoryComplete={onStoryComplete}
        onExit={onExit}
      />
    );
    fireEvent.click(view.getByTestId("sidebar-exit-button"));
    const dialog = view.getByTestId("exit-confirm-dialog");
    fireEvent.click(dialog.querySelector("button:last-of-type")!); // Exit Anyway
    expect(onStoryComplete).not.toHaveBeenCalled();
  });
});

// ── Retry does not affect campaign ────────────────────────────────────────────

describe("StoryViewer — retry isolation from campaign", () => {
  function submitNIncorrect(view: ReturnType<typeof render>, n: number) {
    for (let i = 0; i < n; i++) {
      if (view.queryByTestId("story-failure")) break;
      if (!view.queryByTestId("puzzle-interaction")) break;
      const choice = i % 2 === 0 ? "choice-choice_A" : "choice-choice_C";
      const choiceBtn = view.queryByTestId(`${choice}`);
      if (!choiceBtn) break;
      act(() => { fireEvent.click(choiceBtn); });
      act(() => { fireEvent.click(view.getByTestId("puzzle-submit")); });
      const clearChoice = i % 2 === 0 ? "choice-choice_C" : "choice-choice_A";
      const clearBtn = view.queryByTestId(`${clearChoice}`);
      if (clearBtn && !view.queryByTestId("story-failure")) {
        act(() => { fireEvent.click(clearBtn); });
      }
    }
  }

  it("should not call onStoryComplete when player retries after failure", () => {
    const onStoryComplete = vi.fn();
    const view = render(
      <StoryViewer
        story={dummyStory}
        characters={characters}
        onStoryComplete={onStoryComplete}
        onExit={vi.fn()}
      />
    );
    advanceToPuzzle(view);
    submitNIncorrect(view, 5);
    act(() => { fireEvent.click(view.getByTestId("retry-button")); });
    expect(onStoryComplete).not.toHaveBeenCalled();
  });
});

// ── CampaignLobby ─────────────────────────────────────────────────────────────

describe("CampaignLobby", () => {
  it("should show the campaign title", () => {
    const view = render(
      <CampaignLobby
        campaign={dummyCampaign}
        campaignState={dummyCampaignState}
        onStartStory={vi.fn()}
      />
    );
    expect(view.getByTestId("campaign-title").textContent).toContain(
      dummyCampaign.title
    );
  });

  it("should render all stories in the sequence", () => {
    const view = render(
      <CampaignLobby
        campaign={dummyCampaign}
        campaignState={dummyCampaignState}
        onStartStory={vi.fn()}
      />
    );
    expect(view.queryByTestId("story-entry-story_01")).toBeTruthy();
    expect(view.queryByTestId("story-entry-story_02")).toBeTruthy();
  });

  it("should show Start Story button for the first (unlocked) story", () => {
    const view = render(
      <CampaignLobby
        campaign={dummyCampaign}
        campaignState={dummyCampaignState}
        onStartStory={vi.fn()}
      />
    );
    expect(view.queryByTestId("start-story-story_01")).toBeTruthy();
  });

  it("should NOT show Start Story button for a locked story", () => {
    const view = render(
      <CampaignLobby
        campaign={dummyCampaign}
        campaignState={dummyCampaignState}
        onStartStory={vi.fn()}
      />
    );
    expect(view.queryByTestId("start-story-story_02")).toBeNull();
  });

  it("should show Locked badge for story_02 when story_01 is not completed", () => {
    const view = render(
      <CampaignLobby
        campaign={dummyCampaign}
        campaignState={dummyCampaignState}
        onStartStory={vi.fn()}
      />
    );
    expect(view.queryByTestId("story-badge-story_02")?.textContent).toContain(
      "Locked"
    );
  });

  it("should call onStartStory with the correct story_id when Start is clicked", () => {
    const onStartStory = vi.fn();
    const view = render(
      <CampaignLobby
        campaign={dummyCampaign}
        campaignState={dummyCampaignState}
        onStartStory={onStartStory}
      />
    );
    fireEvent.click(view.getByTestId("start-story-story_01"));
    expect(onStartStory).toHaveBeenCalledWith("story_01");
  });

  it("should show Available (or Current) badge for story_02 after story_01 is completed with demonstrated knowledge", () => {
    const afterS1 = completeStory(
      createInitialCampaignState(dummyCampaign),
      dummyCampaign,
      dummyStory
    );
    const state = {
      ...afterS1,
      player_knowledge: {
        concept_linear_combination: {
          concept_id: "concept_linear_combination",
          status: "demonstrated" as const,
          evidence: [],
        },
      },
    };
    const view = render(
      <CampaignLobby
        campaign={dummyCampaign}
        campaignState={state}
        onStartStory={vi.fn()}
      />
    );
    const badge = view.queryByTestId("story-badge-story_02");
    expect(badge?.textContent).toMatch(/Current|Available/);
    expect(view.queryByTestId("start-story-story_02")).toBeTruthy();
  });
});

// ── Regression ────────────────────────────────────────────────────────────────

describe("Regression — existing features still work with new props", () => {
  it("puzzle interaction still works (correct answer, no HP deduction)", () => {
    const view = render(
      <StoryViewer story={dummyStory} characters={characters} onExit={vi.fn()} onStoryComplete={vi.fn()} />
    );
    advanceToPuzzle(view);
    act(() => { fireEvent.click(view.getByTestId("choice-choice_B")); });
    act(() => { fireEvent.click(view.getByTestId("puzzle-submit")); });
    expect(view.queryByTestId("puzzle-continue")).toBeTruthy();
    expect(view.getByTestId("hp-value").textContent).toContain("5");
  });

  it("HP failure still works with new props", () => {
    const view = render(
      <StoryViewer story={dummyStory} characters={characters} onExit={vi.fn()} onStoryComplete={vi.fn()} />
    );
    advanceToPuzzle(view);
    for (let i = 0; i < 5; i++) {
      if (view.queryByTestId("story-failure")) break;
      if (!view.queryByTestId("puzzle-interaction")) break;
      const choice = i % 2 === 0 ? "choice-choice_A" : "choice-choice_C";
      act(() => { fireEvent.click(view.getByTestId(`${choice}`)); });
      act(() => { fireEvent.click(view.getByTestId("puzzle-submit")); });
      const clear = i % 2 === 0 ? "choice-choice_C" : "choice-choice_A";
      const clearBtn = view.queryByTestId(`${clear}`);
      if (clearBtn && !view.queryByTestId("story-failure")) {
        act(() => { fireEvent.click(clearBtn); });
      }
    }
    expect(view.queryByTestId("story-failure")).toBeTruthy();
  });
});