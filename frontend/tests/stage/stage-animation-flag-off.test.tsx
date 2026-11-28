/**
 * @vitest-environment jsdom
 *
 * stage-animation-flag-off.test.tsx: the Stage with the animation flag off (task 27.3), design 7.6,
 * K-6, Requirements 30.13, 31.2, 36.7.
 *
 * Why: a build without `NEXT_PUBLIC_ANIMATIONS=on` must behave exactly as it did before the
 * feature, even when a story carries `animation` references (a project made by a build with the
 * flag on, opened later by one with it off). So with the flag off:
 *   1. no request goes to `/api/v1/animations` (no GET for the bundle address, no POST), and the
 *      loader is never called;
 *   2. the Fallback_Scene is what is drawn for every reference: a drawn lesson is a `visual`
 *      canvas and a puzzle is a `puzzle` canvas, `data-animation-status` is `off`, and no iframe
 *      exists;
 *   3. `framed` is identical to the one of the same story without references: the scene and the
 *      scene key given to `CanvasPane`, and the canvas markup, are equal at every step.
 * Only the exact string "on" turns the flag on, so "off", "ON", "true", "1", an empty string and an
 * unset variable are all covered. A control run with the flag on shows that the spies would have
 * caught a request.
 *
 * `@remotion/player` is a stand-in `<div>` with its props on data attributes, so the markup is
 * deterministic and can be compared. The real loader runs (wrapped in a spy) and `fetch` is a spy,
 * so a stray load would be seen at both places.
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoryViewer } from "@/components/story/StoryViewer";
import { dummyCampaign } from "@/data/dummy-campaign";
import { CHUNKS, LESSON_REF, animatedStory, withoutAnimations } from "../fixtures/animated-story";

const characters = dummyCampaign.characters;
const FLAG = "NEXT_PUBLIC_ANIMATIONS";

/** The real loader, wrapped so the tests can count its calls. */
const loader = vi.hoisted(() => ({
  loadAnimation: vi.fn(),
  real: null as null | ((...args: unknown[]) => unknown),
}));
vi.mock("@/lib/animation/loader", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/animation/loader")>();
  loader.real = actual.loadAnimation as (...args: unknown[]) => unknown;
  return { ...actual, loadAnimation: loader.loadAnimation };
});

/** What `CanvasPane` was given at each render: the scene and the key of `framed`. */
const panes = vi.hoisted(() => ({ calls: [] as Array<{ scene: unknown; sceneKey: string }> }));
vi.mock("@/components/stage/CanvasPane", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/stage/CanvasPane")>();
  return {
    ...actual,
    CanvasPane: (props: ComponentProps<typeof actual.CanvasPane>) => {
      panes.calls.push({ scene: props.scene, sceneKey: props.sceneKey });
      return createElement(actual.CanvasPane, props);
    },
  };
});

/** A Remotion `Player` stand-in: one `<div>` with its props on data attributes, and a player on `ref`. */
vi.mock("@remotion/player", () => {
  const player = {
    addEventListener: () => {},
    removeEventListener: () => {},
    play: () => {},
    pause: () => {},
    seekTo: () => {},
  };
  return {
    Player: (props: Record<string, unknown>) => {
      const ref = props.ref as ((value: unknown) => void) | undefined;
      return createElement("div", {
        "data-testid": "remotion-player",
        "data-duration": String(props.durationInFrames),
        "data-initial-frame": String(props.initialFrame),
        "data-auto-play": String(props.autoPlay),
        ref: (element: HTMLElement | null) => ref?.(element ? player : null),
      });
    },
  };
});

const fetchSpy = vi.fn();

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
  stubDesktop();
  panes.calls.length = 0;
  loader.loadAnimation.mockReset();
  loader.loadAnimation.mockImplementation((...args: unknown[]) => loader.real!(...args));
  // A 503 for everything: a load that is wrongly started ends as a failure instead of hanging.
  fetchSpy.mockReset();
  fetchSpy.mockImplementation(async () => new Response("{}", { status: 503 }));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
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

/** Press SPACE until `done()` is true; fail the test if it never is. */
function advanceUntil(done: () => boolean) {
  for (let i = 0; i < 80 && !done(); i++) space();
  expect(done()).toBe(true);
}

const lineIs = (text: string) => () => screen.getByTestId("scene-content").textContent === text;

/** What the Stage shows at one step. */
interface Snapshot {
  step: string;
  canvasKind: string | null;
  animationStatus: string | null;
  sceneKey: string | undefined;
  scene: unknown;
  markup: string | undefined;
  hasFrame: boolean;
}

function snapshot(step: string): Snapshot {
  const canvas = screen.queryByTestId("stage-canvas");
  const pane = panes.calls.at(-1);
  return {
    step,
    canvasKind: canvas?.getAttribute("data-canvas-kind") ?? null,
    animationStatus: canvas?.getAttribute("data-animation-status") ?? null,
    sceneKey: pane?.sceneKey,
    scene: pane?.scene,
    markup: canvas?.outerHTML,
    hasFrame: screen.queryByTestId("sandbox-frame") !== null,
  };
}

/** Plays the story from the start and records the canvas at each lesson chunk and at the puzzle. */
function walk(story: ReturnType<typeof animatedStory>): Snapshot[] {
  // The saved pacing of an earlier walk must not change what the next one starts with.
  window.localStorage.clear();
  render(<StoryViewer story={story} characters={characters} />);
  fast();
  const taken: Snapshot[] = [];
  advanceUntil(lineIs(CHUNKS[0]));
  taken.push(snapshot("lesson chunk 1"));
  space();
  expect(lineIs(CHUNKS[1])()).toBe(true);
  taken.push(snapshot("lesson chunk 2"));
  space();
  expect(lineIs(CHUNKS[2])()).toBe(true);
  taken.push(snapshot("lesson chunk 3"));
  advanceUntil(() => screen.queryByTestId("puzzle-interaction") !== null);
  taken.push(snapshot("puzzle"));
  return taken;
}

const animationRequests = () =>
  fetchSpy.mock.calls.filter((call) => String(call[0]).includes("/api/v1/animations"));

describe.each([
  ["off", "off"],
  ["ON", "ON"],
  ["true", "true"],
  ["1", "1"],
  ["an empty string", ""],
  ["unset", undefined],
] as const)("flag %s", (_label, raw) => {
  beforeEach(() => {
    vi.stubEnv(FLAG, raw);
  });

  it("makes no request to /api/v1/animations and never calls the loader, however many references the story has", () => {
    walk(animatedStory());
    expect(animationRequests()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(loader.loadAnimation).not.toHaveBeenCalled();
  });

  it("draws the Fallback_Scene for every reference: a visual lesson, a puzzle canvas, no iframe", () => {
    const taken = walk(animatedStory());
    expect(taken.map((s) => [s.step, s.canvasKind, s.animationStatus, s.hasFrame])).toEqual([
      ["lesson chunk 1", "visual", "off", false],
      ["lesson chunk 2", "visual", "off", false],
      ["lesson chunk 3", "visual", "off", false],
      ["puzzle", "puzzle", "off", false],
    ]);
    expect(screen.getAllByTestId("remotion-player").length).toBeGreaterThan(0);
    for (const { scene } of taken) expect((scene as { kind: string }).kind).not.toBe("animation");
  });

  it("gives CanvasPane the very same framed scene and key as the story without references", () => {
    const withReferences = walk(animatedStory());
    cleanup();
    panes.calls.length = 0;
    const plain = walk(withoutAnimations(animatedStory()));

    expect(withReferences).toHaveLength(4);
    expect(withReferences).toEqual(plain);
    // The keys are the ones the Stage always used: one per lesson step, one per puzzle.
    expect(withReferences.map((s) => s.sceneKey)).toEqual([
      "story_01:scene_02_learning:lesson:0",
      "story_01:scene_02_learning:lesson:0",
      "story_01:scene_02_learning:lesson:0",
      "puzzle:puzzle_01",
    ]);
  });

  it("still lets the player answer the puzzle", () => {
    walk(animatedStory());
    act(() => {
      fireEvent.click(screen.getByTestId("choice-choice_B"));
    });
    act(() => {
      fireEvent.click(screen.getByTestId("puzzle-submit"));
    });
    expect(screen.getByTestId("puzzle-continue")).toBeInTheDocument();
    expect(animationRequests()).toEqual([]);
  });
});

describe("control: flag on", () => {
  it("reaches the loader for the same story, so the checks above would have seen a request", async () => {
    vi.stubEnv(FLAG, "on");
    render(<StoryViewer story={animatedStory({ puzzleRef: null })} characters={characters} />);
    fast();
    advanceUntil(lineIs(CHUNKS[0]));
    expect(loader.loadAnimation).toHaveBeenCalledTimes(1);
    expect(loader.loadAnimation.mock.calls[0]![0]).toEqual(LESSON_REF);
    // The real loader asked for the bundle address with a GET.
    await vi.waitFor(() => expect(animationRequests()).toHaveLength(1));
    expect(String(animationRequests()[0]![0])).toBe(`/api/v1/animations/${LESSON_REF.animation_id}`);
    expect(screen.getByTestId("stage-canvas").getAttribute("data-animation-status")).not.toBe("off");
  });
});
