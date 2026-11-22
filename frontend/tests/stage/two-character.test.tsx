/**
 * @vitest-environment jsdom
 *
 * two-character.test.tsx — two-character mode on the Stage (task 17.5).
 *
 * Why: when at least two campaign characters are present in an ambient scene
 * (a beat without a CanvasFrame), desktop draws the active speaker at 100%
 * opacity and the other character at 40% opacity (8px cells at 694,47) with
 * accessible label `{name}, calm`. Neither phone nor beats with a canvas
 * (lesson, visual, decision) draw the secondary sprite.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StoryViewer } from "@/components/story/StoryViewer";
import { dummyCampaign } from "@/data/dummy-campaign";
import { linearStory } from "../fixtures/linear-story";
import type { StoryBlueprint } from "@/lib/types/story";

const characters = dummyCampaign.characters;

function stubViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
  window.matchMedia = ((query: string) => ({
    matches: query.includes("min-width") ? width >= 768 : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function twoCharStory(): StoryBlueprint {
  const copy: StoryBlueprint = JSON.parse(JSON.stringify(linearStory));
  for (const scene of copy.chapters.flatMap((c) => c.scenes)) {
    scene.characters_present = ["eldric", "lyra"];
  }
  return copy;
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem("lore:pacing", "fast");
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  stubViewport(1440, 900);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Two-character mode on Stage (task 17.5)", () => {
  it("draws the active speaker at 100% and the other character at 40% with accessible label on desktop ambient beats", () => {
    render(<StoryViewer story={twoCharStory()} characters={characters} />);

    const active = screen.getByTestId("stage-character");
    const other = screen.getByTestId("stage-character-other");

    expect(active.dataset.characterId).toBe("eldric");
    expect(active.style.opacity).toBe("1");

    expect(other.dataset.characterId).toBe("lyra");
    expect(other.dataset.expression).toBe("calm");
    expect(other.style.opacity).toBe("0.4");
    expect(other.style.left).toBe("694px");
    expect(other.style.top).toBe("47px");
    expect(other.style.width).toBe("211px");
    expect(other.style.height).toBe("384px");

    const otherImg = other.querySelector('[role="img"]');
    expect(otherImg?.getAttribute("aria-label")).toBe("Lyra, calm");
  });

  it("hides the other character when a CanvasFrame is on screen (lesson or puzzle beat)", () => {
    const view = render(<StoryViewer story={twoCharStory()} characters={characters} />);
    expect(screen.getByTestId("stage-character-other")).toBeTruthy();

    // Advance into scene_02_learning (block 1 is learning_info -> CanvasFrame is shown)
    for (let i = 0; i < 6; i++) {
      act(() => {
        fireEvent.click(view.getByTestId("story-main"));
      });
    }

    expect(screen.getByTestId("stage-canvas")).toBeTruthy();
    expect(screen.queryByTestId("stage-character-other")).toBeNull();
  });

  it("never draws the other character on phone viewports", () => {
    stubViewport(390, 844);
    render(<StoryViewer story={twoCharStory()} characters={characters} />);

    expect(screen.getByTestId("stage-character")).toBeTruthy();
    expect(screen.queryByTestId("stage-character-other")).toBeNull();
  });
});
