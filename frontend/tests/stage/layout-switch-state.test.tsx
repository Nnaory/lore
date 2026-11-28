/**
 * @vitest-environment jsdom
 *
 * layout-switch-state.test.tsx - switching phone/desktop keeps Stage state (task 2.5).
 *
 * Why: one StoryViewer tree serves both layouts, so a `matchMedia` change must
 * not remount it. HP, story position and the answered puzzle choice must
 * survive the switch, the new layout must show within 300 ms of the last
 * resize, and the phone layout must draw exactly one `stage-character`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StoryViewer } from "@/components/story/StoryViewer";
import { dummyCampaign } from "@/data/dummy-campaign";
import { linearStory } from "../fixtures/linear-story";

const characters = dummyCampaign.characters;
const SWITCH_BUDGET_MS = 300;

type Listener = () => void;
const listeners = new Set<Listener>();

/** matchMedia stub whose `change` listeners can be fired by `resizeTo`. */
function installViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
  window.matchMedia = ((query: string) => ({
    matches: query.includes("min-width") ? window.innerWidth >= 768 : false,
    media: query,
    addEventListener: (_: string, fn: Listener) => listeners.add(fn),
    removeEventListener: (_: string, fn: Listener) => listeners.delete(fn),
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/** Resize the window, fire the media change, and return ms until `layout` shows. */
async function resizeTo(width: number, height: number, layout: "desktop" | "phone") {
  const start = performance.now();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
  act(() => {
    listeners.forEach((fn) => fn());
    window.dispatchEvent(new Event("resize"));
  });
  await waitFor(
    () => expect(screen.getByTestId("scaled-board").dataset.layout).toBe(layout),
    { timeout: SWITCH_BUDGET_MS },
  );
  return performance.now() - start;
}

function key(k: string) {
  act(() => {
    fireEvent.keyDown(window, { key: k, code: k === " " ? "Space" : `Key${k.toUpperCase()}` });
  });
}

beforeEach(() => {
  listeners.clear();
  window.localStorage.clear();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  installViewport(1440, 900);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Stage layout switch keeps state", () => {
  it("keeps HP, story position and the answered choice across desktop -> phone -> desktop", async () => {
    render(<StoryViewer story={linearStory} characters={characters} />);
    key("f"); // fast pacing: no typewriter, so scene text is stable to compare
    for (let i = 0; i < 50 && !screen.queryByTestId("puzzle-interaction"); i++) key(" ");
    expect(screen.getByTestId("puzzle-interaction")).toBeTruthy();

    act(() => {
      fireEvent.click(screen.getByTestId("choice-choice_A"));
    });
    act(() => {
      fireEvent.click(screen.getByTestId("puzzle-submit"));
    });
    expect(screen.getByTestId("hp-value").textContent).toMatch(/4\s*\/\s*5/);

    const sceneBefore = screen.getByTestId("scene-content").textContent;
    const pressedBefore = screen.getByTestId("choice-choice_A").getAttribute("aria-pressed");
    const feedbackBefore = screen.getByTestId("puzzle-feedback").textContent;
    expect(pressedBefore).toBe("true");

    const toPhone = await resizeTo(390, 844, "phone");
    expect(toPhone).toBeLessThan(SWITCH_BUDGET_MS);
    expect(screen.getAllByTestId("stage-character")).toHaveLength(1);
    expect(screen.getByTestId("hp-value").textContent).toMatch(/4\s*\/\s*5/);
    // The phone box scrolls the whole line; the desktop box showed the first page of it.
    expect(screen.getByTestId("scene-content").textContent).toContain(sceneBefore ?? "");
    expect(screen.getByTestId("choice-choice_A").getAttribute("aria-pressed")).toBe(pressedBefore);
    expect(screen.getByTestId("puzzle-feedback").textContent).toBe(feedbackBefore);

    const toDesktop = await resizeTo(1440, 900, "desktop");
    expect(toDesktop).toBeLessThan(SWITCH_BUDGET_MS);
    expect(screen.getByTestId("hp-value").textContent).toMatch(/4\s*\/\s*5/);
    expect(screen.getByTestId("scene-content").textContent).toBe(sceneBefore);
    expect(screen.getByTestId("choice-choice_A").getAttribute("aria-pressed")).toBe(pressedBefore);
  });

  it("keeps the story position when switching mid-story, before any puzzle", async () => {
    render(<StoryViewer story={linearStory} characters={characters} />);
    key("f");
    key(" ");
    const sceneBefore = screen.getByTestId("scene-content").textContent;
    await resizeTo(390, 844, "phone");
    expect(screen.getByTestId("scene-content").textContent).toBe(sceneBefore);
    expect(screen.getByTestId("hp-value").textContent).toMatch(/5\s*\/\s*5/);
    expect(screen.getAllByTestId("stage-character")).toHaveLength(1);
  });
});
