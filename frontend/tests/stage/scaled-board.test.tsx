/**
 * @vitest-environment jsdom
 *
 * scaled-board.test.tsx - ScaledBoard and the Stage (StoryViewer) composition (task 1.28).
 *
 * Why: the Stage is a fixed board scaled as a whole (`scale(s)`, origin top
 * center). These tests pin the scale/origin, the HUD/dialogue/canvas/sprite
 * composition, the SPACE/F/L shortcuts (ignored while typing in an input),
 * the reduced-motion start in fast mode and the disabled ask input.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ScaledBoard } from "@/components/stage/ScaledBoard";
import { StoryViewer } from "@/components/story/StoryViewer";
import { dummyCampaign } from "@/data/dummy-campaign";
import { linearStory } from "../fixtures/linear-story";

const characters = dummyCampaign.characters;

/** matchMedia stub: desktop width query follows `desktop`, reduced motion follows `reduced`. */
function stubViewport(opts: { width: number; height: number; reduced?: boolean }) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: opts.width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: opts.height });
  window.matchMedia = ((query: string) => ({
    matches: query.includes("min-width") ? opts.width >= 768 : Boolean(opts.reduced),
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
  // jsdom has no canvas; AsciiArt only needs a null context to skip drawing.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  stubViewport({ width: 1440, height: 900 });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function key(k: string, target: Element | Window = window) {
  act(() => {
    fireEvent.keyDown(target, { key: k, code: k === " " ? "Space" : `Key${k.toUpperCase()}` });
  });
}

describe("ScaledBoard", () => {
  it("scales a 1440x900 board by 1 with a top-center origin at the design size", () => {
    render(<ScaledBoard>{() => <i data-testid="child" />}</ScaledBoard>);
    const board = screen.getByTestId("scaled-board");
    expect(board.style.transform).toBe("scale(1)");
    expect(board.style.transformOrigin).toBe("top center");
    expect(board.style.width).toBe("1440px");
    expect(board.style.height).toBe("900px");
    expect(board.dataset.layout).toBe("desktop");
    expect(screen.getByTestId("child")).toBeTruthy();
  });

  it("scales by min(vw/W, vh/H) when the viewport is smaller", () => {
    stubViewport({ width: 1152, height: 450 });
    render(<ScaledBoard>{null}</ScaledBoard>);
    expect(screen.getByTestId("scaled-board").style.transform).toBe("scale(0.5)");
  });

  it("uses the 390x844 phone board under 768px", () => {
    stubViewport({ width: 390, height: 844 });
    render(<ScaledBoard>{(layout) => <i data-testid="layout">{layout}</i>}</ScaledBoard>);
    const board = screen.getByTestId("scaled-board");
    expect(board.dataset.layout).toBe("phone");
    expect(board.style.width).toBe("390px");
    expect(board.style.height).toBe("844px");
    expect(screen.getByTestId("layout").textContent).toBe("phone");
  });
});

describe("Stage background", () => {
  it("uses lore-grid-bg without pumpkins and renders full-screen stage without inner cutout", () => {
    render(<StoryViewer story={linearStory} characters={characters} />);
    const root = screen.getByTestId("scaled-board-root");
    expect(root.style.position).toBe("fixed");
    expect(root.className).toContain("lore-grid-bg");
    expect(root.className).not.toContain("lore-grid-lines");
    expect(screen.getByTestId("stage-panel").className).not.toContain("outline-smoke");
  });

  it("has no pumpkin field inside the Stage", () => {
    render(<StoryViewer story={linearStory} characters={characters} />);
    expect(screen.queryByTestId("stage-backdrop")).toBeNull();
  });

  it("gives the HUD solid bg-ink backing without transparent inline override on desktop and phone", () => {
    const { unmount } = render(<StoryViewer story={linearStory} characters={characters} />);
    expect(screen.getByTestId("stage-hud").className).toContain("bg-ink");
    expect(screen.getByTestId("sidebar-exit-button").style.background).not.toBe("transparent");
    unmount();
    stubViewport({ width: 390, height: 844 });
    render(<StoryViewer story={linearStory} characters={characters} />);
    expect(screen.getByTestId("stage-hud").className).toContain("bg-ink");
    expect(screen.getByTestId("sidebar-exit-button").style.background).not.toBe("transparent");
  });
});

describe("Stage composition", () => {
  it("renders HUD, dialogue, scene and the speaking sprite in front of the canvas pane", () => {
    render(<StoryViewer story={linearStory} characters={characters} />);
    expect(screen.getByTestId("stage-hud")).toBeTruthy();
    expect(screen.getByTestId("hp-value").textContent).toMatch(/5\s*\/\s*5/);
    expect(screen.getByTestId("stage-dialogue")).toBeTruthy();
    expect(screen.getByTestId("stage-scene")).toBeTruthy();
    // A beat without lesson, visual or puzzle has no canvas pane (OQ-12).
    expect(screen.queryByTestId("stage-canvas")).toBeNull();
    expect(screen.getByTestId("stage-character").style.zIndex).toBe("20");
    expect(screen.getByTestId("key-hints")).toBeTruthy();
  });

  it("shows a canvas pane under the sprite and dialogue on a puzzle beat", () => {
    render(<StoryViewer story={linearStory} characters={characters} />);
    for (let i = 0; i < 50 && !screen.queryByTestId("puzzle-interaction"); i++) {
      key(" ");
    }
    expect(screen.getByTestId("puzzle-interaction")).toBeTruthy();
    expect(screen.getByTestId("stage-character").style.zIndex).toBe("20");
    expect(screen.getByTestId("stage-dialogue").style.zIndex).toBe("10");
  });

  it("updates the HUD n/5 after a wrong answer", () => {
    render(<StoryViewer story={linearStory} characters={characters} />);
    for (let i = 0; i < 50 && !screen.queryByTestId("puzzle-interaction"); i++) {
      key(" ");
    }
    expect(screen.getByTestId("hp-value").textContent).toMatch(/5\s*\/\s*5/);
    act(() => {
      fireEvent.click(screen.getByTestId("choice-choice_A"));
    });
    act(() => {
      fireEvent.click(screen.getByTestId("puzzle-submit"));
    });
    expect(screen.getByTestId("hp-value").textContent).toMatch(/4\s*\/\s*5/);
  });
});

describe("Stage shortcuts and input", () => {
  it("F toggles fast/animate and L opens the log", () => {
    render(<StoryViewer story={linearStory} characters={characters} />);
    expect(screen.getByTestId("pacing-animate").getAttribute("aria-pressed")).toBe("true");
    key("f");
    expect(screen.getByTestId("pacing-fast").getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByTestId("chat-log")).toBeNull();
    key("l");
    expect(screen.getByTestId("chat-log")).toBeTruthy();
  });

  it("SPACE advances the story", () => {
    render(<StoryViewer story={linearStory} characters={characters} />);
    const before = screen.getByTestId("scene-content").textContent;
    key(" ");
    expect(screen.getByTestId("scene-content").textContent).not.toBe(before);
  });

  it("ignores SPACE, F and L while an input has focus", () => {
    render(
      <>
        <input data-testid="outside-input" type="text" />
        <StoryViewer story={linearStory} characters={characters} />
      </>,
    );
    const input = screen.getByTestId("outside-input");
    input.focus();
    const before = screen.getByTestId("scene-content").textContent;
    key(" ", input);
    key("f", input);
    key("l", input);
    expect(screen.getByTestId("scene-content").textContent).toBe(before);
    expect(screen.getByTestId("pacing-animate").getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByTestId("chat-log")).toBeNull();
  });

  it("enables the ask input on narration/dialogue beats and disables it on puzzle beats", () => {
    render(<StoryViewer story={linearStory} characters={characters} />);
    const ask = screen.getByTestId("ask-input") as HTMLInputElement;
    expect(ask.disabled).toBe(false);
    expect(ask.placeholder).toContain("Ask ");

    for (let i = 0; i < 50 && !screen.queryByTestId("puzzle-interaction"); i++) {
      key(" ");
    }
    expect((screen.getByTestId("ask-input") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId("ask-input") as HTMLInputElement).placeholder).toContain("Finish the puzzle");
  });
});

describe("Stage pacing start", () => {
  it("starts in fast mode when reduced motion is requested", () => {
    stubViewport({ width: 1440, height: 900, reduced: true });
    render(<StoryViewer story={linearStory} characters={characters} />);
    expect(screen.getByTestId("pacing-fast").getAttribute("aria-pressed")).toBe("true");
  });

  it("starts in animate mode with motion allowed and no saved choice", () => {
    render(<StoryViewer story={linearStory} characters={characters} />);
    expect(screen.getByTestId("pacing-animate").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("Phone puzzle layout", () => {
  it("expands the puzzle box, stacks full-width choices vertically, and pins feedback above choices", () => {
    stubViewport({ width: 390, height: 844 });
    render(<StoryViewer story={linearStory} characters={characters} />);
    for (let i = 0; i < 50 && !screen.queryByTestId("puzzle-interaction"); i++) {
      key(" ");
    }

    const dialogue = screen.getByTestId("stage-dialogue");
    expect(dialogue.style.top).toBe("404px");
    expect(dialogue.style.height).toBe("428px");

    const choices = screen.getByTestId("puzzle-choices");
    expect(choices.className).toContain("flex-col");
    const firstChoice = screen.getByTestId("choice-choice_A");
    expect(firstChoice.className).toContain("w-full");
    expect(firstChoice.querySelector("span")?.className).not.toContain("line-clamp-2");

    act(() => {
      fireEvent.click(firstChoice);
    });
    act(() => {
      fireEvent.click(screen.getByTestId("puzzle-submit"));
    });
    const feedback = screen.getByTestId("puzzle-feedback");
    const storyMain = screen.getByTestId("story-main");
    expect(storyMain.contains(feedback)).toBe(false);
  });
});

