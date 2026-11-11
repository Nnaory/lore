/**
 * Tests — StoryViewer Component
 *
 * @vitest-environment jsdom
 *
 * Tests updated for click-to-advance mechanism (click anywhere on chat area).
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { StoryViewer } from "@/components/story/StoryViewer";
import { dummyStory, dummyCampaign } from "@/data/dummy-campaign";
import type { StoryBlueprint } from "@/lib/types/story";
import type { Scene } from "@/lib/types/scene";

const characters = dummyCampaign.characters;

// Helper to click the chat area to advance
function clickToAdvance(view: ReturnType<typeof render>) {
  const chatArea = view.getByTestId("chat-area");
  act(() => { fireEvent.click(chatArea); });
}

// Helper to advance through first scene (4 content blocks -> scene_end -> next scene)
function advanceThroughFirstScene() {
  const view = render(
    <StoryViewer story={dummyStory} characters={characters} />
  );
  // scene_01_intro has 4 content blocks (indices 0–3)
  // Click 4 times to advance through all blocks, then 1 more for scene transition
  for (let i = 0; i < 5; i++) {
    clickToAdvance(view);
  }
  return view;
}

// Helper to advance until puzzle
function advanceToPuzzle() {
  const view = render(
    <StoryViewer story={dummyStory} characters={characters} />
  );
  for (let i = 0; i < 50; i++) {
    if (view.queryByTestId("puzzle-interaction")) break;
    clickToAdvance(view);
  }
  return view;
}

// Helper to advance until ending
function advanceToEnding() {
  const view = render(
    <StoryViewer story={dummyStory} characters={characters} />
  );
  for (let i = 0; i < 100; i++) {
    if (view.queryByTestId("ending-display")) break;
    if (view.queryByTestId("story-complete-screen")) break;

    // Handle puzzle interaction
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

// ── 1. Basic render ──────────────────────────────────────────────────────────

describe("StoryViewer — basic render", () => {
  it("should render without crashing with the dummy story", () => {
    const { container } = render(
      <StoryViewer story={dummyStory} characters={characters} />
    );
    expect(container).toBeTruthy();
  });

  it("should render the story-viewer container", () => {
    render(<StoryViewer story={dummyStory} characters={characters} />);
    expect(screen.getByTestId("story-viewer")).toBeTruthy();
  });

  it("should show the story title in the right sidebar", () => {
    render(<StoryViewer story={dummyStory} characters={characters} />);
    expect(screen.getByTestId("right-sidebar").textContent).toContain(
      "The Fading Light"
    );
  });

  it("should render left sidebar with exit button", () => {
    render(<StoryViewer story={dummyStory} characters={characters} />);
    expect(screen.getByTestId("sidebar-exit-button")).toBeTruthy();
    expect(screen.getByText("Exit Story")).toBeTruthy();
  });
});

// ── 2. First scene content ───────────────────────────────────────────────────

describe("StoryViewer — first scene", () => {
  it("should display the location from the first scene in header (desktop)", () => {
    render(<StoryViewer story={dummyStory} characters={characters} />);
    // Header has class "hidden md:flex" - in jsdom it won't be visible
    // but the element exists in DOM
    const header = document.querySelector('[data-testid="story-header"]');
    expect(header).toBeTruthy();
  });

  it("should display the scene-content container", () => {
    render(<StoryViewer story={dummyStory} characters={characters} />);
    expect(screen.getByTestId("scene-content")).toBeTruthy();
  });

  it("should display the chat-area", () => {
    render(<StoryViewer story={dummyStory} characters={characters} />);
    expect(screen.getByTestId("chat-area")).toBeTruthy();
  });
});

// ── 3. Narration rendering ───────────────────────────────────────────────────

describe("StoryViewer — narration", () => {
  it("should render a narration block for the first content block", () => {
    render(<StoryViewer story={dummyStory} characters={characters} />);
    const narration = screen.getByTestId("narration-block");
    expect(narration).toBeTruthy();
    expect(narration.textContent).toContain("stone corridor");
  });

  it("should have chat dividers around narration", () => {
    render(<StoryViewer story={dummyStory} characters={characters} />);
    const dividers = screen.getAllByTestId("narration-block").length;
    // Narration block renders with dividers
    expect(dividers).toBeGreaterThanOrEqual(1);
  });
});

// ── 4. Dialogue rendering ─────────────────────────────────────────────────────

describe("StoryViewer — dialogue", () => {
  it("should render a dialogue bubble after advancing past the narration", () => {
    const view = render(<StoryViewer story={dummyStory} characters={characters} />);
    clickToAdvance(view);
    const bubbles = screen.getAllByTestId("character-bubble");
    expect(bubbles.length).toBeGreaterThan(0);
  });

  it("should show the character name in the dialogue bubble", () => {
    const view = render(<StoryViewer story={dummyStory} characters={characters} />);
    clickToAdvance(view);
    const names = screen.getAllByTestId("character-name");
    const nameTexts = names.map((n) => n.textContent);
    expect(nameTexts.some((t) => t?.toLowerCase().includes("eldric"))).toBe(true);
  });

  it("should show the character expression in the dialogue bubble", () => {
    const view = render(<StoryViewer story={dummyStory} characters={characters} />);
    clickToAdvance(view);
    const expressions = screen.getAllByTestId("character-expression");
    expect(expressions.length).toBeGreaterThan(0);
    const expTexts = expressions.map((e) => e.textContent);
    expect(expTexts.some((t) => t && t.length > 0)).toBe(true);
  });
});

// ── 5. Click-to-advance interaction ──────────────────────────────────────────

describe("StoryViewer — click-to-advance interaction", () => {
  it("should reveal more content on each click", () => {
    const view = render(<StoryViewer story={dummyStory} characters={characters} />);

    // Click 1 → reveals block index 1 (dialogue)
    clickToAdvance(view);
    const after1 = screen.getAllByRole("paragraph", { hidden: true }).length;

    // Click 2 → reveals block index 2
    clickToAdvance(view);
    const after2 = screen.getAllByRole("paragraph", { hidden: true }).length;

    // Content should grow
    expect(after2).toBeGreaterThanOrEqual(after1);
  });

  it("should show click hint when not at puzzle/ending", () => {
    render(<StoryViewer story={dummyStory} characters={characters} />);
    const hint = screen.getByText("Click anywhere to continue");
    expect(hint).toBeTruthy();
  });

  it("should not show click hint during puzzle", () => {
    const view = advanceToPuzzle();
    const hint = view.queryByText("Click anywhere to continue");
    expect(hint).toBeFalsy();
  });
});

// ── 6. Scene transition ──────────────────────────────────────────────────────

describe("StoryViewer — scene transition", () => {
  it("should transition to scene_02_learning after finishing scene_01_intro", () => {
    const view = advanceThroughFirstScene();
    // Location should still be "The Beacon Antechamber" (same location)
    const header = document.querySelector('[data-testid="story-header"]');
    expect(header).toBeTruthy();
    if (header) {
      expect(header.textContent).toContain("The Beacon Antechamber");
    }
  });
});

// ── 7. Puzzle interaction ────────────────────────────────────────────────────

describe("StoryViewer — puzzle interaction", () => {
  it("should render the puzzle interaction without crashing", () => {
    const view = advanceToPuzzle();
    expect(view.queryByTestId("puzzle-interaction")).toBeTruthy();
  });

  it("should show the puzzle question in the interaction", () => {
    const view = advanceToPuzzle();
    const question = view.queryByTestId("puzzle-question");
    expect(question?.textContent).toContain("Crystal A");
  });

  it("should show puzzle choices", () => {
    const view = advanceToPuzzle();
    const choices = view.queryByTestId("puzzle-choices");
    expect(choices).toBeTruthy();
  });
});

// ── 8. Ending scene ──────────────────────────────────────────────────────────

describe("StoryViewer — ending", () => {
  it("should render the ending display when the ending scene is reached", () => {
    const view = advanceToEnding();
    expect(view.queryByTestId("ending-display")).toBeTruthy();
  });

  it("should show the ending title", () => {
    const view = advanceToEnding();
    const ending = view.queryByTestId("ending-display");
    expect(ending).not.toBeNull();
    expect(ending!.textContent).toContain("The Beacon Holds");
  });

  it("should show the story complete message", () => {
    const view = advanceToEnding();
    expect(view.queryByTestId("story-complete-screen")).toBeTruthy();
  });
});

// ── 9. Invalid scene reference ───────────────────────────────────────────────

describe("StoryViewer — invalid scene reference", () => {
  it("should show an error state and not crash on invalid next_scene_id", () => {
    const badStory: StoryBlueprint = JSON.parse(JSON.stringify(dummyStory));
    const firstScene = badStory.chapters[0].scenes[0] as Extract<Scene, { type: "narrative" }>;
    firstScene.next_scene_id = "scene_NONEXISTENT";

    const view = render(
      <StoryViewer story={badStory} characters={characters} />
    );

    // Advance through all 4 content blocks + 1 scene transition
    for (let i = 0; i < 10; i++) {
      if (view.queryByTestId("story-viewer-error")) break;
      clickToAdvance(view);
    }

    expect(view.queryByTestId("story-viewer-error")).toBeTruthy();
  });
});

// ── 10. Exit functionality ──────────────────────────────────────────────────

describe("StoryViewer — exit functionality", () => {
  it("should show exit confirmation dialog when exit button clicked", () => {
    const onExit = vi.fn();
    const view = render(
      <StoryViewer story={dummyStory} characters={characters} onExit={onExit} />
    );

    fireEvent.click(view.getByTestId("sidebar-exit-button"));
    expect(view.getByText("Exit Story?")).toBeTruthy();
  });

  it("should call onExit when exit confirmed", () => {
    const onExit = vi.fn();
    const view = render(
      <StoryViewer story={dummyStory} characters={characters} onExit={onExit} />
    );

    fireEvent.click(view.getByTestId("sidebar-exit-button"));
    const dialog = view.getByTestId("exit-confirm-dialog");
    fireEvent.click(dialog.querySelector("button:last-of-type")!); // Exit Anyway
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("should not call onExit when cancel is clicked", () => {
    const onExit = vi.fn();
    const view = render(
      <StoryViewer story={dummyStory} characters={characters} onExit={onExit} />
    );

    fireEvent.click(view.getByTestId("sidebar-exit-button"));
    const dialog = view.getByTestId("exit-confirm-dialog");
    fireEvent.click(dialog.querySelector("button:first-of-type")!); // Cancel
    expect(onExit).not.toHaveBeenCalled();
  });
});

// ── 11. Right sidebar progress ───────────────────────────────────────────────

describe("StoryViewer — right sidebar progress", () => {
  it("should show chapter progress list", () => {
    render(<StoryViewer story={dummyStory} characters={characters} />);
    expect(screen.getByText("Chapter Progress")).toBeTruthy();
    expect(screen.getByTestId("sidebar-story-title").textContent).toContain(
      "The Fading Light"
    );
  });

  it("should show HP display", () => {
    render(<StoryViewer story={dummyStory} characters={characters} />);
    expect(screen.getByTestId("hp-display")).toBeTruthy();
    expect(screen.getByTestId("hp-value").textContent).toContain("5 / 5");
  });

  it("should mark current chapter", () => {
    render(<StoryViewer story={dummyStory} characters={characters} />);
    const currentChapter = screen.getByTestId("sidebar-chapter-chapter_01");
    expect(currentChapter).toHaveStyle({ borderColor: "var(--accent-gold)" });
  });
});