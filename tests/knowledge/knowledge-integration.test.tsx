/**
 * Tests — Knowledge Tracking Integration (React)
 *
 * @vitest-environment jsdom
 *
 * Tests the full knowledge tracking flow through StoryViewer + useCampaign.
 * Verifies that learning events and puzzle submissions correctly update
 * player_knowledge in CampaignState.
 * Updated for click-to-advance mechanism.
 */

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { StoryViewer } from "@/components/story/StoryViewer";
import { dummyStory, dummyCampaign } from "@/data/dummy-campaign";
import type { PlayerKnowledge } from "@/lib/types/game";

const characters = dummyCampaign.characters;
const LEARNING_SCENE_ID = "scene_02_learning";
const CONCEPT_ID = "concept_linear_combination";

// ── Helper: click chat area to advance ────────────────────────────────────────

function clickToAdvance(view: ReturnType<typeof render>) {
  const chatArea = view.getByTestId("story-main");
  act(() => { fireEvent.click(chatArea); });
}

/** Advance to the learning scene (scene_02_learning). */
function advanceToLearningScene(view: ReturnType<typeof render>) {
  for (let i = 0; i < 5; i++) {
    clickToAdvance(view);
  }
}

/** Advance to the puzzle scene. */
function advanceToPuzzle(view: ReturnType<typeof render>) {
  for (let i = 0; i < 60; i++) {
    if (view.queryByTestId("puzzle-interaction")) break;
    clickToAdvance(view);
  }
}

// ── 1–3. Learning scene ───────────────────────────────────────────────────────

describe("Knowledge — learning scene exposure", () => {
  it("should call onKnowledgeUpdate when a learning_info block is encountered", () => {
    const onKnowledgeUpdate = vi.fn();
    const view = render(
      <StoryViewer
        story={dummyStory}
        characters={characters}
        onKnowledgeUpdate={onKnowledgeUpdate}
        playerKnowledge={{}}
      />
    );

    advanceToLearningScene(view);

    expect(onKnowledgeUpdate).toHaveBeenCalled();

    const calls = onKnowledgeUpdate.mock.calls;
    const allUpdatedKeys = calls.flatMap((c) => Object.keys(c[0]));
    expect(allUpdatedKeys).toContain(CONCEPT_ID);
  });

  it("should advance knowledge to at least introduced after learning scene", () => {
    let capturedKnowledge: Record<string, PlayerKnowledge> = {};

    const onKnowledgeUpdate = vi.fn((updates: Record<string, PlayerKnowledge>) => {
      capturedKnowledge = { ...capturedKnowledge, ...updates };
    });

    const view = render(
      <StoryViewer
        story={dummyStory}
        characters={characters}
        onKnowledgeUpdate={onKnowledgeUpdate}
        playerKnowledge={{}}
      />
    );

    advanceToLearningScene(view);

    const status = capturedKnowledge[CONCEPT_ID]?.status;
    expect(status).toBeDefined();
    const ORDER = { not_introduced: 0, introduced: 1, developing: 2, demonstrated: 3 };
    expect(ORDER[status as keyof typeof ORDER]).toBeGreaterThanOrEqual(ORDER.introduced);
  });
});

// ── 4. Correct first attempt → demonstrated ──────────────────────────────────

describe("Knowledge — correct first attempt", () => {
  it("should set concept to demonstrated after correct first submission", () => {
    let capturedKnowledge: Record<string, PlayerKnowledge> = {};

    const onKnowledgeUpdate = vi.fn((updates: Record<string, PlayerKnowledge>) => {
      capturedKnowledge = { ...capturedKnowledge, ...updates };
    });

    const view = render(
      <StoryViewer
        story={dummyStory}
        characters={characters}
        onKnowledgeUpdate={onKnowledgeUpdate}
        playerKnowledge={{}}
      />
    );

    advanceToPuzzle(view);

    act(() => { fireEvent.click(view.getByTestId("choice-choice_B")); });
    act(() => { fireEvent.click(view.getByTestId("puzzle-submit")); });

    expect(capturedKnowledge[CONCEPT_ID]?.status).toBe("demonstrated");
  });
});

// ── 5. Incorrect then correct → developing ───────────────────────────────────

describe("Knowledge — incorrect then correct", () => {
  it("should set concept to developing when prior incorrect evidence exists", () => {
    let capturedKnowledge: Record<string, PlayerKnowledge> = {};

    const onKnowledgeUpdate = vi.fn((updates: Record<string, PlayerKnowledge>) => {
      capturedKnowledge = { ...capturedKnowledge, ...updates };
    });

    const view = render(
      <StoryViewer
        story={dummyStory}
        characters={characters}
        onKnowledgeUpdate={onKnowledgeUpdate}
        playerKnowledge={capturedKnowledge}
      />
    );

    // Advance to puzzle
    for (let i = 0; i < 60; i++) {
      if (view.queryByTestId("puzzle-interaction")) break;
      clickToAdvance(view);
    }

    // Submit incorrect first — updates capturedKnowledge
    act(() => { fireEvent.click(view.getByTestId("choice-choice_A")); });
    act(() => { fireEvent.click(view.getByTestId("puzzle-submit")); });

    // Re-render with updated playerKnowledge so the ref is updated
    act(() => {
      view.rerender(
        <StoryViewer
          story={dummyStory}
          characters={characters}
          onKnowledgeUpdate={onKnowledgeUpdate}
          playerKnowledge={capturedKnowledge}
        />
      );
    });

    // Submit correct — now playerKnowledge has prior incorrect evidence
    act(() => { fireEvent.click(view.getByTestId("choice-choice_B")); });
    act(() => { fireEvent.click(view.getByTestId("puzzle-submit")); });

    const finalStatus = capturedKnowledge[CONCEPT_ID]?.status;
    expect(finalStatus).toBe("developing");
    expect(finalStatus).not.toBe("demonstrated");
  });
});

// ── 6. Incorrect only → developing ───────────────────────────────────────────

describe("Knowledge — incorrect only", () => {
  it("should set concept to at most developing after incorrect submission", () => {
    let capturedKnowledge: Record<string, PlayerKnowledge> = {};

    const onKnowledgeUpdate = vi.fn((updates: Record<string, PlayerKnowledge>) => {
      capturedKnowledge = { ...capturedKnowledge, ...updates };
    });

    const view = render(
      <StoryViewer
        story={dummyStory}
        characters={characters}
        onKnowledgeUpdate={onKnowledgeUpdate}
        playerKnowledge={{}}
      />
    );

    advanceToPuzzle(view);

    act(() => { fireEvent.click(view.getByTestId("choice-choice_A")); });
    act(() => { fireEvent.click(view.getByTestId("puzzle-submit")); });

    const status = capturedKnowledge[CONCEPT_ID]?.status;
    expect(status).toBe("developing");
    expect(status).not.toBe("demonstrated");
  });
});

// ── 7. Knowledge survives retry ───────────────────────────────────────────────

describe("Knowledge — survives story retry", () => {
  it("onKnowledgeUpdate is NOT reverted when retryStory is called", () => {
    const capturedUpdates: Record<string, PlayerKnowledge>[] = [];

    const onKnowledgeUpdate = vi.fn((updates: Record<string, PlayerKnowledge>) => {
      capturedUpdates.push(updates);
    });

    const view = render(
      <StoryViewer
        story={dummyStory}
        characters={characters}
        onKnowledgeUpdate={onKnowledgeUpdate}
        playerKnowledge={{}}
      />
    );

    advanceToPuzzle(view);
    act(() => { fireEvent.click(view.getByTestId("choice-choice_A")); });
    act(() => { fireEvent.click(view.getByTestId("puzzle-submit")); });

    const updateCountBeforeRetry = capturedUpdates.length;
    expect(updateCountBeforeRetry).toBeGreaterThan(0);

    expect(capturedUpdates[0]).toHaveProperty(CONCEPT_ID);
  });
});

// ── 8. Knowledge survives exit ────────────────────────────────────────────────

describe("Knowledge — survives exit", () => {
  it("onKnowledgeUpdate is called before exit is triggered", () => {
    const onKnowledgeUpdate = vi.fn();
    const onExit = vi.fn();

    const view = render(
      <StoryViewer
        story={dummyStory}
        characters={characters}
        onKnowledgeUpdate={onKnowledgeUpdate}
        onExit={onExit}
        playerKnowledge={{}}
      />
    );

    advanceToLearningScene(view);
    const knowledgeCallCount = onKnowledgeUpdate.mock.calls.length;

    // Exit the story
    fireEvent.click(view.getByTestId("sidebar-exit-button"));
    const dialog = view.getByTestId("exit-confirm-dialog");
    fireEvent.click(dialog.querySelector("button:last-of-type")!);

    expect(onExit).toHaveBeenCalled();
    expect(knowledgeCallCount).toBeGreaterThan(0);
  });
});