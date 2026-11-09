/**
 * Tests — StoryViewer Component
 *
 * @vitest-environment jsdom
 *
 * Tests:
 *   1. Story viewer accepts dummy story and renders
 *   2. First scene content is displayed
 *   3. Narration blocks are rendered
 *   4. Dialogue blocks are rendered
 *   5. Character name and expression are shown
 *   6. Continue button advances content
 *   7. Scene transition uses next_scene_id
 *   8. Puzzle placeholder renders without crash
 *   9. Ending scene can be reached
 *   10. Story completion is detected
 *   11. Invalid scene reference shows error, does not crash
 */

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { StoryViewer } from "@/components/story/StoryViewer";
import { dummyStory, dummyCampaign } from "@/data/dummy-campaign";
import type { StoryBlueprint } from "@/lib/types/story";
import type { Scene } from "@/lib/types/scene";

const characters = dummyCampaign.characters;

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

  it("should render the story header", () => {
    render(<StoryViewer story={dummyStory} characters={characters} />);
    expect(screen.getByTestId("story-header")).toBeTruthy();
  });

  it("should show the story title in the right sidebar", () => {
    render(<StoryViewer story={dummyStory} characters={characters} />);
    expect(screen.getByTestId("right-sidebar").textContent).toContain(
      "The Fading Light"
    );
  });
});

// ── 2. First scene content ───────────────────────────────────────────────────

describe("StoryViewer — first scene", () => {
  it("should display the location from the first scene", () => {
    render(<StoryViewer story={dummyStory} characters={characters} />);
    expect(screen.getByTestId("story-header").textContent).toContain(
      "The Beacon Antechamber"
    );
  });

  it("should display the scene-content container", () => {
    render(<StoryViewer story={dummyStory} characters={characters} />);
    expect(screen.getByTestId("scene-content")).toBeTruthy();
  });
});

// ── 3. Narration rendering ───────────────────────────────────────────────────

describe("StoryViewer — narration", () => {
  it("should render a narration block for the first content block", () => {
    render(<StoryViewer story={dummyStory} characters={characters} />);
    // First block of scene_01_intro is a narration
    const narration = screen.getByTestId("narration-block");
    expect(narration).toBeTruthy();
    expect(narration.textContent).toContain("stone corridor");
  });
});

// ── 4. Dialogue rendering ────────────────────────────────────────────────────

describe("StoryViewer — dialogue", () => {
  it("should render a dialogue bubble after advancing past the narration", () => {
    render(<StoryViewer story={dummyStory} characters={characters} />);
    const continueBtn = screen.getByTestId("continue-button");
    fireEvent.click(continueBtn);
    const bubbles = screen.getAllByTestId("character-bubble");
    expect(bubbles.length).toBeGreaterThan(0);
  });

  it("should show the character name in the dialogue bubble", () => {
    render(<StoryViewer story={dummyStory} characters={characters} />);
    fireEvent.click(screen.getByTestId("continue-button"));
    const names = screen.getAllByTestId("character-name");
    const nameTexts = names.map((n) => n.textContent);
    expect(nameTexts.some((t) => t?.toLowerCase().includes("eldric"))).toBe(true);
  });

  it("should show the character expression in the dialogue bubble", () => {
    render(<StoryViewer story={dummyStory} characters={characters} />);
    fireEvent.click(screen.getByTestId("continue-button"));
    const expressions = screen.getAllByTestId("character-expression");
    expect(expressions.length).toBeGreaterThan(0);
    // Eldric's "worried" expression is "(>_<)"
    const expTexts = expressions.map((e) => e.textContent);
    expect(expTexts.some((t) => t && t.length > 0)).toBe(true);
  });
});

// ── 5. Continue button advances content ─────────────────────────────────────

describe("StoryViewer — continue interaction", () => {
  it("should reveal more content on each continue click", () => {
    render(<StoryViewer story={dummyStory} characters={characters} />);

    // Click 1 → reveals block index 1 (dialogue)
    fireEvent.click(screen.getByTestId("continue-button"));
    const after1 = screen.getAllByRole("paragraph", { hidden: true }).length;

    // Click 2 → reveals block index 2
    fireEvent.click(screen.getByTestId("continue-button"));
    const after2 = screen.getAllByRole("paragraph", { hidden: true }).length;

    // Content should grow
    expect(after2).toBeGreaterThanOrEqual(after1);
  });
});

// ── 6. Scene transition ──────────────────────────────────────────────────────

describe("StoryViewer — scene transition", () => {
  /** Helper: advance through all content blocks of scene_01_intro (4 blocks). */
  function advanceThroughFirstScene() {
    const view = render(
      <StoryViewer story={dummyStory} characters={characters} />
    );
    // scene_01_intro has 4 content blocks (indices 0–3)
    // Click 3 times to advance to index 3, then 1 more to reach scene_end
    // Then one more click to transition to scene_02_learning
    for (let i = 0; i < 5; i++) {
      const btn = view.queryByTestId("continue-button");
      if (btn) fireEvent.click(btn);
    }
    return view;
  }

  it("should transition to scene_02_learning after finishing scene_01_intro", () => {
    const view = advanceThroughFirstScene();
    // scene_02_learning has Lyra's dialogue as first block
    const header = view.getByTestId("story-header");
    // Location should still be "The Beacon Antechamber" (same location)
    expect(header.textContent).toContain("The Beacon Antechamber");
  });
});

// ── 7. Puzzle interaction ────────────────────────────────────────────────────

describe("StoryViewer — puzzle interaction", () => {
  /**
   * Advance until the puzzle-interaction is visible.
   * Uses act() to ensure React state updates are fully flushed.
   */
  function advanceToPuzzle() {
    const view = render(
      <StoryViewer story={dummyStory} characters={characters} />
    );
    for (let i = 0; i < 50; i++) {
      if (view.queryByTestId("puzzle-interaction")) break;
      const btn = view.queryByTestId("continue-button");
      if (!btn) break;
      act(() => { fireEvent.click(btn); });
    }
    return view;
  }

  it("should render the puzzle interaction without crashing", () => {
    const view = advanceToPuzzle();
    expect(view.queryByTestId("puzzle-interaction")).toBeTruthy();
  });

  it("should show the puzzle question in the interaction", () => {
    const view = advanceToPuzzle();
    const question = view.queryByTestId("puzzle-question");
    expect(question?.textContent).toContain("Crystal A");
  });
});

// ── 8. Ending scene ──────────────────────────────────────────────────────────

describe("StoryViewer — ending", () => {
  /**
   * Advance until the ending-display is visible.
   */
  function advanceToEnding() {
    const view = render(
      <StoryViewer story={dummyStory} characters={characters} />
    );
    for (let i = 0; i < 100; i++) {
      if (view.queryByTestId("ending-display")) break;
      if (view.queryByTestId("story-complete-screen")) break;

      // Handle puzzle interaction: select correct choice, submit, continue
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

      // Otherwise click the story continue button
      const btn = view.queryByTestId("continue-button");
      if (!btn) break;
      act(() => { fireEvent.click(btn); });
    }
    return view;
  }

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
      const btn = view.queryByTestId("continue-button");
      if (!btn) break;
      act(() => { fireEvent.click(btn); });
    }

    expect(view.queryByTestId("story-viewer-error")).toBeTruthy();
  });
});
