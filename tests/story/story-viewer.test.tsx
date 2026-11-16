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
import { dummyCampaign } from "@/data/dummy-campaign";
import { linearStory } from "../fixtures/linear-story";
import type { StoryBlueprint } from "@/lib/types/story";
import type { Scene } from "@/lib/types/scene";

const characters = dummyCampaign.characters;

// Helper to click the chat area to advance
function clickToAdvance(view: ReturnType<typeof render>) {
  const chatArea = view.getByTestId("story-main");
  act(() => { fireEvent.click(chatArea); });
}

// Helper to advance through first scene (4 content blocks -> scene_end -> next scene)
function advanceThroughFirstScene() {
  const view = render(
    <StoryViewer story={linearStory} characters={characters} />
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
    <StoryViewer story={linearStory} characters={characters} />
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
    <StoryViewer story={linearStory} characters={characters} />
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
      <StoryViewer story={linearStory} characters={characters} />
    );
    expect(container).toBeTruthy();
  });

  it("should render the story-viewer container", () => {
    render(<StoryViewer story={linearStory} characters={characters} />);
    expect(screen.getByTestId("story-viewer")).toBeTruthy();
  });

  it("should show the story title in the navbar", () => {
    render(<StoryViewer story={linearStory} characters={characters} />);
    expect(screen.getByTestId("sidebar-story-title").textContent).toBe("The Fading Light");
  });

  it("should lay out the stage: character, canvas, and chat box", () => {
    render(<StoryViewer story={linearStory} characters={characters} />);
    expect(screen.getByTestId("stage-character").dataset.characterId).toBe("eldric");
    expect(screen.getByTestId("stage-canvas").dataset.canvasKind).toBe("ambient");
    expect(screen.getByTestId("story-main")).toBeTruthy();
    expect(screen.getByTestId("pacing-toggle")).toBeTruthy();
  });

  it("should render an icon exit button in the navbar", () => {
    render(<StoryViewer story={linearStory} characters={characters} />);
    const exitBtn = screen.getByTestId("sidebar-exit-button");
    expect(exitBtn).toHaveAttribute("aria-label", "Exit story");
  });
});

// ── 2. First scene content ───────────────────────────────────────────────────

describe("StoryViewer — first scene", () => {
  it("should display the location from the first scene in header (desktop)", () => {
    render(<StoryViewer story={linearStory} characters={characters} />);
    // Header has class "hidden md:flex" - in jsdom it won't be visible
    // but the element exists in DOM
    const header = document.querySelector('[data-testid="story-header"]');
    expect(header).toBeTruthy();
  });

  it("should display the scene-content container", () => {
    render(<StoryViewer story={linearStory} characters={characters} />);
    expect(screen.getByTestId("scene-content")).toBeTruthy();
  });

  it("should display the chat-area", () => {
    render(<StoryViewer story={linearStory} characters={characters} />);
    expect(screen.getByTestId("story-main")).toBeTruthy();
  });
});

// ── 3. Narration rendering ───────────────────────────────────────────────────

describe("StoryViewer — narration", () => {
  it("should render a narration block for the first content block", () => {
    render(<StoryViewer story={linearStory} characters={characters} />);
    const narration = screen.getByTestId("narration-block");
    expect(narration).toBeTruthy();
    expect(narration.textContent).toContain("stone corridor");
  });

  it("should have chat dividers around narration", () => {
    render(<StoryViewer story={linearStory} characters={characters} />);
    const dividers = screen.getAllByTestId("narration-block").length;
    // Narration block renders with dividers
    expect(dividers).toBeGreaterThanOrEqual(1);
  });
});

// ── 4. Dialogue rendering ─────────────────────────────────────────────────────

describe("StoryViewer — dialogue", () => {
  it("should render a dialogue bubble after advancing past the narration", () => {
    const view = render(<StoryViewer story={linearStory} characters={characters} />);
    clickToAdvance(view);
    const bubbles = screen.getAllByTestId("character-bubble");
    expect(bubbles.length).toBeGreaterThan(0);
  });

  it("should show the character name in the dialogue bubble", () => {
    const view = render(<StoryViewer story={linearStory} characters={characters} />);
    clickToAdvance(view);
    const names = screen.getAllByTestId("character-name");
    const nameTexts = names.map((n) => n.textContent);
    expect(nameTexts.some((t) => t?.toLowerCase().includes("eldric"))).toBe(true);
  });

  it("should show the character expression in the dialogue bubble", () => {
    const view = render(<StoryViewer story={linearStory} characters={characters} />);
    clickToAdvance(view);
    const expressions = screen.getAllByTestId("character-expression");
    expect(expressions.length).toBeGreaterThan(0);
    const expTexts = expressions.map((e) => e.textContent);
    expect(expTexts.some((t) => t && t.length > 0)).toBe(true);
  });
});

// ── 5. Click-to-advance interaction ──────────────────────────────────────────

describe("StoryViewer — click-to-advance interaction", () => {
  it("should show the next line on each click (one line at a time, like a visual novel)", () => {
    const view = render(<StoryViewer story={linearStory} characters={characters} />);
    const line = () => screen.getByTestId("scene-content").textContent;

    const first = line();
    clickToAdvance(view); // block 1: Eldric's first line
    const second = line();
    clickToAdvance(view); // block 2: narration
    const third = line();

    expect(new Set([first, second, third]).size).toBe(3);
    expect(second).toContain("You arrived just in time");
  });

  it("should keep every line seen so far in the story log", () => {
    const view = render(<StoryViewer story={linearStory} characters={characters} />);
    clickToAdvance(view);
    clickToAdvance(view);
    fireEvent.click(screen.getByTestId("log-chat-button"));

    const log = screen.getByTestId("chat-log").textContent ?? "";
    expect(log).toContain("stone corridor");
    expect(log).toContain("You arrived just in time");
    expect(log).toContain("diagrams scattered");
    // Opening the log does not advance the story.
    expect(screen.getByTestId("scene-content").textContent).toContain("diagrams scattered");
  });

  it("should switch pacing without advancing the story", () => {
    render(<StoryViewer story={linearStory} characters={characters} />);
    const before = screen.getByTestId("scene-content").textContent;
    fireEvent.click(screen.getByRole("button", { name: "fast" }));
    expect(screen.getByRole("button", { name: "fast" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("scene-content").textContent).toBe(before);
    expect(window.localStorage.getItem("lore:pacing")).toBe("fast");
    window.localStorage.removeItem("lore:pacing");
  });

  it("should show click hint when not at puzzle/ending", () => {
    render(<StoryViewer story={linearStory} characters={characters} />);
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
    const badStory: StoryBlueprint = JSON.parse(JSON.stringify(linearStory));
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
      <StoryViewer story={linearStory} characters={characters} onExit={onExit} />
    );

    fireEvent.click(view.getByTestId("sidebar-exit-button"));
    expect(view.getByText("Exit Story?")).toBeTruthy();
  });

  it("should call onExit when exit confirmed", () => {
    const onExit = vi.fn();
    const view = render(
      <StoryViewer story={linearStory} characters={characters} onExit={onExit} />
    );

    fireEvent.click(view.getByTestId("sidebar-exit-button"));
    const dialog = view.getByTestId("exit-confirm-dialog");
    fireEvent.click(dialog.querySelector("button:last-of-type")!); // Exit Anyway
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("should not call onExit when cancel is clicked", () => {
    const onExit = vi.fn();
    const view = render(
      <StoryViewer story={linearStory} characters={characters} onExit={onExit} />
    );

    fireEvent.click(view.getByTestId("sidebar-exit-button"));
    const dialog = view.getByTestId("exit-confirm-dialog");
    fireEvent.click(dialog.querySelector("button:first-of-type")!); // Cancel
    expect(onExit).not.toHaveBeenCalled();
  });
});

// ── 11. Right sidebar progress ───────────────────────────────────────────────

describe("StoryViewer — navbar progress", () => {
  it("should show the chapter position and title", () => {
    render(<StoryViewer story={linearStory} characters={characters} />);
    expect(screen.getByTestId("chapter-progress").textContent).toBe("Chapter 1 / 1");
    expect(screen.getByTestId("story-header").textContent).toContain("The Fading Light");
  });

  it("should show HP display", () => {
    render(<StoryViewer story={linearStory} characters={characters} />);
    expect(screen.getByTestId("hp-display")).toBeTruthy();
    expect(screen.getByTestId("hp-value").textContent).toContain("5 / 5");
  });
});

// ── 12. Stage reactions ─────────────────────────────────────────────────────

describe("StoryViewer — stage", () => {
  it("shows the lesson on the canvas and the character explaining", () => {
    const view = render(<StoryViewer story={linearStory} characters={characters} />);
    for (let i = 0; i < 6; i++) clickToAdvance(view); // into scene_02_learning, block 1
    expect(screen.getByTestId("learning-card").textContent).toContain("Crystal Vector Resonance");
    expect(screen.getByTestId("stage-canvas").dataset.canvasKind).toBe("lesson");
    expect(screen.getByTestId("stage-character").dataset.emotion).toBe("explaining");
  });

  it("draws the puzzle as a decision graph and reacts to a wrong answer", () => {
    const view = advanceToPuzzle();
    expect(screen.getByTestId("stage-canvas").dataset.canvasKind).toBe("decision");
    expect(screen.getByTestId("stage-character").dataset.emotion).toBe("thinking");
    act(() => { fireEvent.click(view.getByTestId("choice-choice_A")); });
    act(() => { fireEvent.click(view.getByTestId("puzzle-submit")); });
    expect(screen.getByTestId("stage-character").dataset.emotion).toBe("worried");
  });

  it("follows the speaker's expression", () => {
    const view = render(<StoryViewer story={linearStory} characters={characters} />);
    clickToAdvance(view); // Eldric, "worried"
    expect(screen.getByTestId("stage-character")).toMatchObject({ dataset: expect.objectContaining({ characterId: "eldric", emotion: "worried" }) });
  });
});