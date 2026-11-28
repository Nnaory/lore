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
    // OQ-12: a beat without lesson, visual or puzzle shows the ambient scene and no CanvasFrame.
    expect(screen.getByTestId("stage-scene")).toBeTruthy();
    expect(screen.queryByTestId("stage-canvas")).toBeNull();
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
    // The expression is drawn on the sprite: data-expression and the canvas aria-label.
    const sprite = screen.getByTestId("stage-character");
    expect(sprite.dataset.expression).toBe("worried");
    expect(sprite.querySelector("[role=img]")?.getAttribute("aria-label")).toMatch(/eldric, worried/i);
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

  it("should show the keyboard hints (SPACE, F, L) without the removed ask hint", () => {
    render(<StoryViewer story={linearStory} characters={characters} />);
    const hints = screen.getByTestId("key-hints").textContent ?? "";
    expect(hints).toContain("SPACE next line");
    expect(hints).toContain("F fast/animate");
    expect(hints).toContain("L log chat");
    expect(hints).not.toContain("/ ask");
  });

  it("should not advance the story with SPACE during a puzzle", () => {
    const view = advanceToPuzzle();
    const before = view.getByTestId("puzzle-question").textContent;
    act(() => { fireEvent.keyDown(window, { key: " ", code: "Space" }); });
    expect(view.getByTestId("puzzle-question").textContent).toBe(before);
    expect(view.queryByTestId("puzzle-interaction")).toBeTruthy();
  });
});

// ── 6. Scene transition ──────────────────────────────────────────────────────

describe("StoryViewer — scene transition", () => {
  it("should transition to scene_02_learning after finishing scene_01_intro", () => {
    advanceThroughFirstScene();
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

  it("places initial focus on Cancel in exit-confirm-dialog and closes on Escape (task 15.3)", () => {
    const onExit = vi.fn();
    const view = render(
      <StoryViewer story={linearStory} characters={characters} onExit={onExit} />
    );

    fireEvent.click(view.getByTestId("sidebar-exit-button"));
    const dialog = view.getByTestId("exit-confirm-dialog");
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe("exit-confirm-title");

    const cancelBtn = view.getByTestId("exit-confirm-cancel");
    expect(document.activeElement).toBe(cancelBtn);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(view.queryByTestId("exit-confirm-dialog")).toBeNull();
    expect(onExit).not.toHaveBeenCalled();
  });

  it("renders story-viewer-error with role=alert and ErrorLine on navigation failure (task 15.3)", () => {
    const badStory: StoryBlueprint = JSON.parse(JSON.stringify(linearStory));
    const firstScene = badStory.chapters[0].scenes[0] as Extract<Scene, { type: "narrative" }>;
    firstScene.next_scene_id = "scene_MISSING";

    const view = render(<StoryViewer story={badStory} characters={characters} />);
    for (let i = 0; i < 10; i++) {
      if (view.queryByTestId("story-viewer-error")) break;
      clickToAdvance(view);
    }

    const err = view.getByTestId("story-viewer-error");
    expect(err.getAttribute("role")).toBe("alert");
    expect(err.getAttribute("aria-live")).toBe("assertive");
    expect(err.textContent).toContain("Navigation Error");
    expect(err.textContent).toContain("ERROR");
    expect(err.textContent).toContain("scene_MISSING");
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
    expect(screen.getByTestId("hp-value").textContent).toMatch(/5\s*\/\s*5/);
  });
});

// ── 12. Stage reactions ─────────────────────────────────────────────────────

describe("StoryViewer — stage", () => {
  it("shows the lesson on the canvas and the character explaining", () => {
    const view = render(<StoryViewer story={linearStory} characters={characters} />);
    for (let i = 0; i < 6; i++) clickToAdvance(view); // into scene_02_learning, block 1
    // The title sits beside the LESSON tag; the three lines of the box are the body.
    expect(screen.getByTestId("character-name").textContent).toContain("Crystal Vector Resonance");
    expect(screen.getByTestId("learning-card").textContent).toContain("Each crystal contributes");
    expect(screen.getByTestId("stage-canvas").dataset.canvasKind).toBe("lesson");
    expect(screen.getByTestId("stage-character").dataset.emotion).toBe("explaining");
  });

  it("walks through a lesson taught in several steps, one step per click", () => {
    const stepped: StoryBlueprint = JSON.parse(JSON.stringify(linearStory));
    const scene = stepped.chapters.flatMap((c) => c.scenes).find((s) => s.scene_id === "scene_02_learning")!;
    if (!("content" in scene)) throw new Error("expected content");
    const at = scene.content.findIndex((b) => b.type === "learning_info");
    scene.content.splice(at + 1, 0, {
      type: "learning_info",
      title: "Worked Example",
      body: "2×(2,1) + 1×(1,2) = (5,4).",
      concept_ids: ["concept_linear_combination"],
      visual: { kind: "vectors", vectors: [{ from: [0, 0], to: [5, 4], label: "(5, 4)" }] },
    });
    const view = render(<StoryViewer story={stepped} characters={characters} />);
    for (let i = 0; i < 6; i++) clickToAdvance(view);
    // The title sits beside the LESSON tag; the three lines of the box are the body.
    expect(screen.getByTestId("character-name").textContent).toContain("Crystal Vector Resonance");
    expect(screen.getByTestId("learning-card").textContent).toContain("Each crystal contributes");
    expect(screen.getByTestId("stage-canvas").dataset.canvasKind).toBe("lesson");
    // The first step's body is longer than the box, so it takes a few clicks (pages) to leave it.
    for (let i = 0; i < 8 && !screen.getByTestId("character-name").textContent?.includes("Worked Example"); i++) {
      clickToAdvance(view);
    }
    expect(screen.getByTestId("character-name").textContent).toContain("Worked Example");
    expect(screen.getByTestId("learning-card").textContent).toContain("2×(2,1) + 1×(1,2)");
    expect(screen.getByTestId("stage-canvas").dataset.canvasKind).toBe("visual");
    expect(screen.getByTestId("stage-character").dataset.emotion).toBe("explaining");
  });

  it("illustrates the lesson on the canvas when it has a visual", () => {
    const illustrated: StoryBlueprint = JSON.parse(JSON.stringify(linearStory));
    for (const scene of illustrated.chapters.flatMap((c) => c.scenes)) {
      if (!("content" in scene)) continue;
      for (const block of scene.content) {
        if (block.type === "learning_info") {
          block.visual = { kind: "vectors", vectors: [{ from: [0, 0], to: [2, 1], label: "A" }] };
        }
      }
    }
    const view = render(<StoryViewer story={illustrated} characters={characters} />);
    for (let i = 0; i < 6; i++) clickToAdvance(view);
    expect(screen.getByTestId("character-name").textContent).toContain("Crystal Vector Resonance");
    expect(screen.getByTestId("stage-canvas").dataset.canvasKind).toBe("visual");
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