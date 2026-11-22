/**
 * Tests — epilogue and learning evaluation
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { buildLearningSummary } from "@/lib/game/learning-summary";
import { createInitialCampaignState, completeStory } from "@/lib/game/campaign-manager";
import { recordLearningExposure, recordPuzzleSubmission, createInitialKnowledge } from "@/lib/game/knowledge-manager";
import { CampaignPlayer } from "@/components/campaign/CampaignPlayer";
import { CampaignSummary } from "@/components/campaign/CampaignSummary";
import { dummyCampaign, dummyMaterial, dummyStory } from "@/data/dummy-campaign";
import type { StoryBlueprint } from "@/lib/types/story";
import type { CampaignState } from "@/lib/types/game";
import { linearStory, linearStory2 } from "../fixtures/linear-story";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

const STORIES: ReadonlyMap<string, StoryBlueprint> = new Map([
  [linearStory.story_id, linearStory],
  [linearStory2.story_id, linearStory2],
]);

describe("buildLearningSummary", () => {
  const stories = new Map([[dummyStory.story_id, dummyStory]]);
  const base = completeStory(createInitialCampaignState(dummyCampaign), dummyCampaign, dummyStory);

  function withKnowledge(knowledge: CampaignState["player_knowledge"]): CampaignState {
    return { ...base, player_knowledge: knowledge };
  }

  it("classifies each concept from the recorded evidence", () => {
    const lc = recordPuzzleSubmission(createInitialKnowledge("concept_linear_combination"), "puzzle_01", true, 1);
    let span = recordPuzzleSubmission(createInitialKnowledge("concept_vector_span"), "puzzle_02", false, 1);
    span = recordPuzzleSubmission(span, "puzzle_02", true, 2);

    const summary = buildLearningSummary({
      campaign: dummyCampaign,
      stories,
      state: withKnowledge({ concept_linear_combination: lc, concept_vector_span: span }),
      materials: [dummyMaterial],
    });
    expect(summary.concepts.map((c) => [c.concept_id, c.outcome])).toEqual([
      ["concept_linear_combination", "mastered"],
      ["concept_vector_span", "developing"],
    ]);
    expect(summary.counts).toEqual({ mastered: 1, developing: 1, practice: 0, unseen: 0 });
  });

  it("gives a recap and a misconception only where the player stumbled", () => {
    const lc = recordPuzzleSubmission(createInitialKnowledge("concept_linear_combination"), "puzzle_01", true, 1);
    const span = recordPuzzleSubmission(createInitialKnowledge("concept_vector_span"), "puzzle_02", false, 1);
    const summary = buildLearningSummary({
      campaign: dummyCampaign,
      stories,
      state: withKnowledge({ concept_linear_combination: lc, concept_vector_span: span }),
      materials: [dummyMaterial],
    });
    const [mastered, practice] = summary.concepts;
    expect(mastered).toMatchObject({ name: "Linear Combination", watch_out: null });
    expect(practice).toMatchObject({
      outcome: "practice",
      name: "Vector Span",
      definition: dummyMaterial.concepts[1].definition,
      watch_out: dummyMaterial.concepts[1].misconceptions[0],
    });
  });

  it("marks taught-but-untested concepts as not tested", () => {
    const seen = recordLearningExposure(createInitialKnowledge("concept_vector_span"), "scene_09_span_learning", 1);
    const summary = buildLearningSummary({ campaign: dummyCampaign, stories, state: withKnowledge({ concept_vector_span: seen }) });
    expect(summary.concepts.find((c) => c.concept_id === "concept_vector_span")?.outcome).toBe("unseen");
  });

  it("falls back to the lesson title without the source material", () => {
    const summary = buildLearningSummary({ campaign: dummyCampaign, stories, state: base });
    expect(summary.concepts[0].name).toBe("Crystal Vector Resonance — Linear Combinations");
    expect(summary.concepts[0].definition).toBeNull();
  });

  it("uses the good ending, not a bad-branch ending, for the epilogue", () => {
    const summary = buildLearningSummary({ campaign: dummyCampaign, stories, state: base });
    expect(summary.stories).toEqual([
      expect.objectContaining({ story_id: "story_01", ending_title: "The City Holds" }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Through the player
// ---------------------------------------------------------------------------

function playToStoryComplete(wrongFirst = false) {
  let wrongPending = wrongFirst;
  for (let i = 0; i < 100; i++) {
    if (screen.queryByTestId("story-complete-screen")) return;
    if (screen.queryByTestId("puzzle-interaction")) {
      if (wrongPending) {
        act(() => { fireEvent.click(screen.getByTestId("choice-choice_A")); });
        act(() => { fireEvent.click(screen.getByTestId("puzzle-submit")); });
        wrongPending = false;
      }
      act(() => { fireEvent.click(screen.getByTestId("choice-choice_B")); });
      act(() => { fireEvent.click(screen.getByTestId("puzzle-submit")); });
      act(() => { fireEvent.click(screen.getByTestId("puzzle-continue")); });
      continue;
    }
    act(() => { fireEvent.click(screen.getByTestId("story-main")); });
  }
  throw new Error("story never completed");
}

describe("CampaignPlayer — results", () => {
  it("offers the results only after the final story, then shows the evaluation", () => {
    render(<CampaignPlayer campaign={dummyCampaign} stories={STORIES} materials={[dummyMaterial]} homeHref="/" />);
    playToStoryComplete(true); // one mistake on the linear-combination puzzle
    expect(screen.queryByTestId("view-results-button")).toBeNull();
    act(() => { fireEvent.click(screen.getByTestId("continue-campaign-button")); });

    playToStoryComplete();
    act(() => { fireEvent.click(screen.getByTestId("continue-campaign-button")); }); // completes the campaign
    act(() => { fireEvent.click(screen.getByTestId("view-results-button")); });

    expect(screen.getByTestId("campaign-summary")).toBeTruthy();
    expect(screen.getByTestId("epilogue-story_01").textContent).toContain("The Beacon Holds");
    expect(screen.getByTestId("epilogue-story_02").textContent).toContain("The Districts Hold");
    const result = screen.getByTestId("concept-result-concept_linear_combination");
    expect(result.dataset.outcome).toBe("developing");
    expect(result.textContent).toContain("Recap:");
    expect(screen.getByTestId("evaluation-headline").textContent).toBe("You mastered 0 of 1 concept on the first try.");
  });

  it("reaches the results from the lobby of a completed campaign, and back", () => {
    let state = createInitialCampaignState(dummyCampaign);
    state = completeStory(state, dummyCampaign, linearStory, { outcomeDescription: "x" });
    state = completeStory(state, dummyCampaign, linearStory2, { outcomeDescription: "y" });
    render(<CampaignPlayer campaign={dummyCampaign} stories={STORIES} initialState={state} startAtLobby />);

    fireEvent.click(screen.getByTestId("lobby-view-results"));
    expect(screen.getByTestId("campaign-summary")).toBeTruthy();
    fireEvent.click(screen.getByText("Campaign lobby"));
    expect(screen.getByTestId("campaign-lobby")).toBeTruthy();
  });

  it("does not offer results before the campaign is complete", () => {
    render(<CampaignPlayer campaign={dummyCampaign} stories={STORIES} startAtLobby />);
    expect(screen.queryByTestId("lobby-view-results")).toBeNull();
  });
});

describe("CampaignSummary component (task 11.3)", () => {
  it("renders mastered, developing, practice, and unseen concept rows with Kit markers and tokens", () => {
    render(
      <CampaignSummary
        summary={{
          campaign_title: "The Last Beacon",
          stories: [
            {
              story_id: "s1",
              title: "Story 1",
              ending_title: "The City Holds",
              ending_narration: "First paragraph.\nSecond paragraph.",
            },
          ],
          concepts: [
            { concept_id: "c_mastered", name: "Linear Combination", outcome: "mastered", definition: "Def 1", watch_out: "Mis 1" },
            { concept_id: "c_dev", name: "Vector Span", outcome: "developing", definition: "Def 2", watch_out: "Mis 2" },
            { concept_id: "c_prac", name: "Basis Vectors", outcome: "practice", definition: "Def 3", watch_out: "Mis 3" },
            { concept_id: "c_unseen", name: "Eigenvalues", outcome: "unseen", definition: "Def 4", watch_out: null },
          ],
          counts: { mastered: 1, developing: 1, practice: 1, unseen: 1 },
        }}
        homeHref="/"
        onBackToLobby={vi.fn()}
      />
    );

    expect(screen.getByTestId("evaluation-headline").textContent).toBe(
      "You mastered 1 of 4 concepts on the first try."
    );

    const masteredRow = screen.getByTestId("concept-result-c_mastered");
    expect(masteredRow.dataset.outcome).toBe("mastered");
    expect(masteredRow.textContent).toContain("●");
    expect(masteredRow.textContent).toContain("Mastered");
    expect(masteredRow.textContent).toContain("Right on the first try");
    expect(masteredRow.textContent).not.toContain("Recap:");

    const devRow = screen.getByTestId("concept-result-c_dev");
    expect(devRow.dataset.outcome).toBe("developing");
    expect(devRow.textContent).toContain("◐");
    expect(devRow.textContent).toContain("Developing");
    expect(devRow.textContent).toContain("Right after a mistake");
    expect(devRow.textContent).toContain("Recap: Def 2");
    expect(devRow.textContent).toContain("Watch out for: Mis 2");

    const pracRow = screen.getByTestId("concept-result-c_prac");
    expect(pracRow.dataset.outcome).toBe("practice");
    expect(pracRow.textContent).toContain("○");
    expect(pracRow.textContent).toContain("Needs practice");
    expect(pracRow.textContent).toContain("Not answered correctly yet");
    expect(pracRow.textContent).toContain("Recap: Def 3");
    expect(pracRow.textContent).toContain("Watch out for: Mis 3");

    const unseenRow = screen.getByTestId("concept-result-c_unseen");
    expect(unseenRow.dataset.outcome).toBe("unseen");
    expect(unseenRow.textContent).toContain("·");
    expect(unseenRow.textContent).toContain("Not tested");
    expect(unseenRow.textContent).toContain("Taught, but never tested");
    expect(unseenRow.textContent).not.toContain("Recap:");
  });

  it("shows the empty-concepts sentence when no concepts were tested", () => {
    render(
      <CampaignSummary
        summary={{
          campaign_title: "Empty Campaign",
          stories: [],
          concepts: [],
          counts: { mastered: 0, developing: 0, practice: 0, unseen: 0 },
        }}
        onBackToLobby={vi.fn()}
      />
    );
    expect(screen.getByTestId("evaluation-headline").textContent).toBe(
      "No concepts were tested in this campaign."
    );
  });
});

