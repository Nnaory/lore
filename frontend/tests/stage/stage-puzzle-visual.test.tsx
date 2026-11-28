/**
 * @vitest-environment jsdom
 *
 * stage-puzzle-visual.test.tsx — the Stage with an AI-designed puzzle and with a chunked lesson.
 *
 * Why: StoryViewer must pick the puzzle canvas from the puzzle's own `visual`, fall back to the
 * question alone when there is none, show the question large on the canvas (the chip strip keeps
 * it for screen readers only), and treat the chunks of one lesson step as one step.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StoryViewer } from "@/components/story/StoryViewer";
import { dummyCampaign } from "@/data/dummy-campaign";
import type { StoryBlueprint } from "@/lib/types/story";
import type { LessonVisual } from "@/lib/types/visual";
import { linearStory } from "../fixtures/linear-story";

const characters = dummyCampaign.characters;

const picture: LessonVisual = {
  kind: "vectors",
  vectors: [
    { from: [0, 0], to: [2, 1], label: "A" },
    { from: [0, 0], to: [5, 4], label: "?", tone: "muted" },
  ],
};

function stubDesktop() {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
  window.matchMedia = ((query: string) => ({
    matches: query.includes("min-width"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  stubDesktop();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function space() {
  act(() => {
    fireEvent.keyDown(window, { key: " ", code: "Space" });
  });
}

/** F switches the typewriter to `fast`, so every line shows in full at once. */
function fast() {
  act(() => {
    fireEvent.keyDown(window, { key: "f", code: "KeyF" });
  });
}

/** Press SPACE (pages and lines) until `done()` is true; fail the test if it never is. */
function advanceUntil(done: () => boolean) {
  for (let i = 0; i < 80 && !done(); i++) space();
  expect(done()).toBe(true);
}

describe("puzzle canvas", () => {
  it("uses the puzzle's own picture when the AI drew one", () => {
    const story: StoryBlueprint = {
      ...linearStory,
      puzzles: linearStory.puzzles.map((p) => ({ ...p, visual: picture })),
    };
    render(<StoryViewer story={story} characters={characters} />);
    advanceUntil(() => screen.queryByTestId("puzzle-interaction") !== null);
    expect(screen.getByTestId("stage-canvas").getAttribute("data-canvas-kind")).toBe("puzzle");
  });

  it("shows the voice council instead of a picture when the puzzle has no picture", () => {
    render(<StoryViewer story={linearStory} characters={characters} />);
    advanceUntil(() => screen.queryByTestId("puzzle-interaction") !== null);
    expect(screen.getByTestId("voice-council")).toBeTruthy();
    expect(screen.queryByTestId("stage-canvas")).toBeNull();
  });

  it("keeps the question for screen readers only, since the canvas draws it", () => {
    render(<StoryViewer story={linearStory} characters={characters} />);
    advanceUntil(() => screen.queryByTestId("puzzle-interaction") !== null);
    const question = screen.getByTestId("puzzle-question");
    expect(question.className).toContain("sr-only");
    expect(question.textContent).toBe(linearStory.puzzles[0].question);
  });

  it("still lets the player answer with the chips", () => {
    const story: StoryBlueprint = {
      ...linearStory,
      puzzles: linearStory.puzzles.map((p) => ({ ...p, visual: picture })),
    };
    render(<StoryViewer story={story} characters={characters} />);
    advanceUntil(() => screen.queryByTestId("puzzle-interaction") !== null);
    act(() => {
      fireEvent.click(screen.getByTestId("choice-choice_B"));
    });
    act(() => {
      fireEvent.click(screen.getByTestId("puzzle-submit"));
    });
    expect(screen.getByTestId("puzzle-continue")).toBeTruthy();
  });
});

describe("chunked lesson", () => {
  const lesson = (body: string) => ({
    type: "learning_info" as const,
    title: "Crystal Vector Resonance",
    body,
    concept_ids: ["concept_linear_combination"],
    visual: picture,
  });
  const chunks = ["First chunk of the step.", "Second chunk of the step.", "Third chunk of the step."];

  function chunkedStory(): StoryBlueprint {
    return {
      ...linearStory,
      chapters: linearStory.chapters.map((chapter) => ({
        ...chapter,
        scenes: chapter.scenes.map((scene) => {
          if (scene.scene_id !== "scene_02_learning" || !("content" in scene)) return scene;
          const rest = scene.content.filter((b) => b.type !== "learning_info");
          return { ...scene, content: [lesson(chunks[0]), lesson(chunks[1]), lesson(chunks[2]), ...rest] };
        }),
      })),
    };
  }

  it("shows one chunk per line, with the title beside the tag and not in the text", () => {
    render(<StoryViewer story={chunkedStory()} characters={characters} />);
    fast();
    // Intro scene first, then the companion line of the learning scene, then the lesson chunks.
    advanceUntil(() => screen.getByTestId("scene-content").textContent === chunks[0]);
    expect(screen.getByTestId("character-name").textContent).toContain("LESSON");
    expect(screen.getByTestId("character-name").textContent).toContain("Crystal Vector Resonance");
    expect(screen.getByTestId("scene-content").textContent).not.toContain("Crystal Vector Resonance");

    space();
    expect(screen.getByTestId("scene-content").textContent).toBe(chunks[1]);
    space();
    expect(screen.getByTestId("scene-content").textContent).toBe(chunks[2]);
  });

  it("keeps the same canvas (one step) across the chunks of a drawn lesson", () => {
    render(<StoryViewer story={chunkedStory()} characters={characters} />);
    fast();
    advanceUntil(() => screen.getByTestId("scene-content").textContent === chunks[0]);
    const canvas = screen.getByTestId("stage-canvas");
    expect(canvas.getAttribute("data-canvas-kind")).toBe("visual");
    const player = canvas.firstElementChild;
    expect(player).not.toBeNull();
    space();
    // The same player node: it was not remounted, so the drawing did not restart on the next chunk.
    expect(screen.getByTestId("stage-canvas").firstElementChild).toBe(player);
    expect(screen.getByTestId("scene-content").textContent).toBe(chunks[1]);
  });
});
