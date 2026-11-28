/**
 * @vitest-environment jsdom
 *
 * story-viewer-animation.test.tsx: the Stage with the animation flag on (task 27.3), design 7.6,
 * K-6, Requirements 30.11, 30.12, 30.13, 30.17, 31.2, 36.7.
 *
 * Why: with `NEXT_PUBLIC_ANIMATIONS=on`, `StoryViewer` must wrap the scene it would have drawn in an
 * `animation` scene, and nothing else about the Stage may change. These tests run the real
 * `StoryViewer`, `CanvasPane`, `StageCanvas`, `AnimationScene`, `SandboxFrame`, `SandboxController`
 * and game engine, with the loader as a mock, the iframe's window as the fake of
 * `tests/fixtures/sandbox-harness.ts`, and `@remotion/player` as a stand-in `<div>`.
 *
 *   1. what is wrapped: a visual lesson with a reference on its step, a puzzle with an animation;
 *      not a lesson without a visual, not a story without references; the fallback and the key are
 *      the ones the Stage had before, and the reference is the one stored in the story;
 *   2. a lesson step stored as three chunks: the reference on the first chunk serves all three,
 *      one iframe and one load for the whole step, and the iframe goes when the step ends;
 *   3. a puzzle: `resume` goes to the iframe once, only after the right answer, and HP and the
 *      answer check are the engine's alone: iframe messages (valid, forged or malformed) change
 *      neither HP nor `isCorrect` and never reach `validateMultipleChoice`;
 *   4. the API says the feature is not configured (`ANIMATION_NOT_CONFIGURED`, HTTP 503): the real
 *      loader fails with phase `urls` and the Fallback_Scene plays, the story goes on.
 *
 * [belum diverifikasi] a real browser: the iframe's layout and `window.origin === "null"` (the
 * checklist of Requirement 27.9).
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { visualDuration } from "@/components/stage/visual-layout";
import { StoryViewer } from "@/components/story/StoryViewer";
import { dummyCampaign } from "@/data/dummy-campaign";
import { CONTRACT } from "@/lib/animation/contract";
import type { LoadResult } from "@/lib/animation/loader";
import type { AnimationReference } from "@/lib/types/animation";
import {
  CHUNKS,
  DURATION,
  LESSON_REF,
  PAUSE,
  PICTURE,
  PUZZLE_REF,
  animatedStory,
  withoutAnimations,
} from "../fixtures/animated-story";
import { linearStory } from "../fixtures/linear-story";
import { createSandboxHarness, type SandboxHarness } from "../fixtures/sandbox-harness";

const characters = dummyCampaign.characters;
const FLAG = "NEXT_PUBLIC_ANIMATIONS";
const BUNDLE = '"use strict";module.exports.default=function(){return null};';

/** The loader: a mock by default, the real one (`real`) in the tests that stub `fetch`. */
const loader = vi.hoisted(() => ({
  loadAnimation: vi.fn(),
  real: null as null | ((...args: unknown[]) => unknown),
}));
vi.mock("@/lib/animation/loader", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/animation/loader")>();
  loader.real = actual.loadAnimation as (...args: unknown[]) => unknown;
  return { ...actual, loadAnimation: loader.loadAnimation };
});

/** The answer check of the game engine, wrapped so its calls can be counted. */
vi.mock("@/lib/game/answer-validator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/game/answer-validator")>();
  return { ...actual, validateMultipleChoice: vi.fn(actual.validateMultipleChoice) };
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

/** What the stand-in Remotion `Player` was given, per render. */
const remotion = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));
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
      remotion.props.push(props);
      const ref = props.ref as ((value: unknown) => void) | undefined;
      return createElement("div", {
        "data-testid": "remotion-player",
        ref: (element: HTMLElement | null) => ref?.(element ? player : null),
      });
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function okResult(reference: AnimationReference): LoadResult {
  return {
    ok: true,
    bundle: BUNDLE,
    meta: {
      width: reference.width,
      height: reference.height,
      fps: reference.fps,
      durationInFrames: reference.duration_in_frames,
      ...(reference.pause_at_frame !== undefined ? { pauseAtFrame: reference.pause_at_frame } : {}),
    },
    runtimeMismatch: false,
  };
}

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

let harness: SandboxHarness;
let warn: ReturnType<typeof vi.spyOn>;
let validate: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  window.localStorage.clear();
  stubDesktop();
  vi.stubEnv(FLAG, "on");
  harness = createSandboxHarness();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  panes.calls.length = 0;
  remotion.props.length = 0;
  loader.loadAnimation.mockReset();
  loader.loadAnimation.mockImplementation(async (reference: AnimationReference) => okResult(reference));
  validate = (await import("@/lib/game/answer-validator")).validateMultipleChoice as unknown as ReturnType<typeof vi.fn>;
  validate.mockClear();
});

afterEach(() => {
  cleanup();
  harness.restore();
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
const atPuzzle = () => screen.queryByTestId("puzzle-interaction") !== null;

/** Lets the mocked loader's promise reach the component. */
const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

const canvas = () => screen.getByTestId("stage-canvas");
const kind = () => canvas().getAttribute("data-canvas-kind");
const status = () => canvas().getAttribute("data-animation-status");
const frame = () => screen.queryByTestId("sandbox-frame");
const lastPane = () => panes.calls.at(-1)!;
const hp = () => screen.getByTestId("hp-value").textContent;

/** The rest of the flow once a scene is mounted: the runtime says ready, then loaded. */
async function bringUp(duration: number = DURATION) {
  await flush();
  harness.ready();
  harness.loaded(duration);
}

function mountStage(story = animatedStory()) {
  render(<StoryViewer story={story} characters={characters} />);
  fast();
}

function answer(choiceId: string) {
  act(() => {
    fireEvent.click(screen.getByTestId(`choice-${choiceId}`));
  });
  act(() => {
    fireEvent.click(screen.getByTestId("puzzle-submit"));
  });
}

// ---------------------------------------------------------------------------
// 1. What is wrapped
// ---------------------------------------------------------------------------

describe("what the Stage wraps", () => {
  it("wraps a visual lesson that has a reference: the fallback is the visual scene, the reference is the stored one", async () => {
    const story = animatedStory();
    mountStage(story);
    advanceUntil(lineIs(CHUNKS[0]));

    const { scene, sceneKey } = lastPane();
    expect(scene).toEqual({
      kind: "animation",
      props: { animation: LESSON_REF, fallback: expect.objectContaining({ kind: "visual" }) },
    });
    const wrapped = scene as { props: { animation: AnimationReference; fallback: { props: Record<string, unknown> } } };
    expect(wrapped.props.animation).toBe(
      (story.chapters[0].scenes[1] as { content: Array<{ animation?: AnimationReference }> }).content[1].animation,
    );
    expect(wrapped.props.fallback.props).toMatchObject({ title: "Crystal Vector Resonance", visual: PICTURE });
    // The key is the step key the Stage used before the feature, not a new one.
    expect(sceneKey).toBe("story_01:scene_02_learning:lesson:0");
    // Until the bundle is verified the canvas is the Fallback_Scene.
    expect(kind()).toBe("visual");
    expect(status()).toBe("loading");
    expect(screen.getAllByTestId("remotion-player").length).toBeGreaterThan(0);
    expect(frame()).toBeNull();
    await flush();
  });

  it("loads the reference once for the step and shows the iframe after loaded", async () => {
    mountStage();
    advanceUntil(lineIs(CHUNKS[0]));
    expect(loader.loadAnimation).toHaveBeenCalledTimes(1);
    expect(loader.loadAnimation.mock.calls[0]![0]).toEqual(LESSON_REF);

    await bringUp();
    expect(kind()).toBe("animation");
    expect(status()).toBe("paused");
    expect(frame()).not.toBeNull();
    expect(screen.queryByTestId("remotion-player")).toBeNull();
  });

  it("gives the fallback of a puzzle with a picture the same scene the Stage drew before", async () => {
    const story = animatedStory({ lessonRef: null });
    mountStage(story);
    advanceUntil(atPuzzle);
    const { scene, sceneKey } = lastPane();
    const puzzle = story.puzzles[0];
    expect(sceneKey).toBe("puzzle:puzzle_01");
    expect(scene).toEqual({
      kind: "animation",
      props: {
        animation: PUZZLE_REF,
        fallback: { kind: "puzzle", props: { question: puzzle.question, visual: PICTURE, seed: expect.any(Number) } },
      },
    });
    expect(kind()).toBe("puzzle");
    expect(status()).toBe("loading");
    await flush();
  });

  it("uses the question alone as the fallback of a puzzle that has an animation but no picture", async () => {
    mountStage(animatedStory({ lessonRef: null, puzzleVisual: false }));
    advanceUntil(atPuzzle);
    expect((lastPane().scene as { props: { fallback: { kind: string } } }).props.fallback.kind).toBe("decision");
    expect(kind()).toBe("decision");
    expect(status()).toBe("loading");
    await flush();
  });

  it("does not wrap a lesson without a reference, a story without references, or a lesson without a visual", () => {
    // No reference on the lesson step.
    mountStage(animatedStory({ lessonRef: null, puzzleRef: null }));
    advanceUntil(lineIs(CHUNKS[0]));
    expect(kind()).toBe("visual");
    expect(status()).toBe("off");
    advanceUntil(atPuzzle);
    expect(kind()).toBe("puzzle");
    expect(status()).toBe("off");
    expect(loader.loadAnimation).not.toHaveBeenCalled();
    cleanup();

    // A reference on a lesson that has no visual: only a drawn lesson can be animated.
    mountStage(animatedStory({ lessonVisual: false, puzzleRef: null }));
    advanceUntil(lineIs(CHUNKS[0]));
    expect(kind()).toBe("lesson");
    expect(status()).toBe("off");
    expect(loader.loadAnimation).not.toHaveBeenCalled();
  });

  it("gives CanvasPane the same fallback scenes and keys as the story without references", async () => {
    const observed = (story: ReturnType<typeof animatedStory>) => {
      cleanup();
      panes.calls.length = 0;
      window.localStorage.clear();
      mountStage(story);
      advanceUntil(lineIs(CHUNKS[0]));
      const lesson = lastPane();
      advanceUntil(atPuzzle);
      return { lesson, puzzle: lastPane() };
    };
    const plain = observed(withoutAnimations(animatedStory()));
    const wrapped = observed(animatedStory());

    for (const step of ["lesson", "puzzle"] as const) {
      expect(wrapped[step].sceneKey).toBe(plain[step].sceneKey);
      expect((wrapped[step].scene as { kind: string }).kind).toBe("animation");
      expect((wrapped[step].scene as { props: { fallback: unknown } }).props.fallback).toEqual(plain[step].scene);
    }
    await flush();
  });
});

// ---------------------------------------------------------------------------
// 2. One step stored as several chunks
// ---------------------------------------------------------------------------

describe("a lesson step stored as three chunks (design K-6)", () => {
  it("serves all three chunks with the reference of the first: one iframe, one load, one key", async () => {
    mountStage();
    advanceUntil(lineIs(CHUNKS[0]));
    await bringUp();
    const element = frame();
    expect(element).not.toBeNull();

    for (const chunk of [CHUNKS[1], CHUNKS[2]]) {
      space();
      expect(lineIs(chunk)()).toBe(true);
      // The reference is only on the first chunk, but the step is the same.
      expect(lastPane().sceneKey).toBe("story_01:scene_02_learning:lesson:0");
      expect((lastPane().scene as { kind: string; props: { animation: unknown } }).props.animation).toEqual(LESSON_REF);
      expect(frame()).toBe(element);
      expect(kind()).toBe("animation");
    }
    expect(loader.loadAnimation).toHaveBeenCalledTimes(1);
    expect(harness.postedOfType("load")).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("drops the iframe when the step ends and the dialogue goes on", async () => {
    mountStage();
    advanceUntil(lineIs(CHUNKS[0]));
    await bringUp();
    space();
    space();
    expect(lineIs(CHUNKS[2])()).toBe(true);
    space();
    expect(screen.queryByTestId("stage-canvas")).toBeNull();
    expect(frame()).toBeNull();
  });

  it("keeps the iframe, and sends setMode, when the player switches the text pacing", async () => {
    mountStage();
    advanceUntil(lineIs(CHUNKS[0]));
    await bringUp();
    const element = frame();
    const before = harness.postedOfType("setMode").length;
    fast(); // toggles back to `animate`
    expect(frame()).toBe(element);
    expect(harness.postedOfType("setMode").length).toBe(before + 1);
    expect(harness.postedOfType("load")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. A puzzle: the engine decides, the iframe only listens
// ---------------------------------------------------------------------------

describe("a puzzle with an animation", () => {
  async function toQuestion() {
    mountStage(animatedStory({ lessonRef: null }));
    advanceUntil(atPuzzle);
    expect(loader.loadAnimation).toHaveBeenCalledTimes(1);
    expect(loader.loadAnimation.mock.calls[0]![0]).toEqual(PUZZLE_REF);
    await bringUp();
    harness.frame(10, true);
    harness.paused("interaction", PAUSE);
    expect(kind()).toBe("animation");
    expect(status()).toBe("paused");
  }

  it("sends resume once, only after the engine says the answer is right", async () => {
    await toQuestion();
    expect(hp()).toBe("5/5");
    expect(harness.postedOfType("resume")).toHaveLength(0);

    // A wrong answer costs one HP and sends nothing to the iframe.
    answer("choice_A");
    expect(hp()).toBe("4/5");
    expect(harness.postedOfType("resume")).toHaveLength(0);
    expect(screen.queryByTestId("puzzle-continue")).toBeNull();

    // The right one makes `isCorrect` true and the animation continues, once.
    answer("choice_B");
    expect(screen.getByTestId("puzzle-continue")).toBeInTheDocument();
    expect(hp()).toBe("4/5");
    expect(harness.postedOfType("resume")).toHaveLength(1);
    expect(harness.postedOfType("resume")[0]!.session).toBe(harness.session());
    // The engine, not the component, checked both answers.
    expect(validate).toHaveBeenCalledTimes(2);

    // The runtime then plays to the end; nothing sends resume again.
    harness.frame(PAUSE + 1, true);
    harness.ended();
    expect(harness.postedOfType("resume")).toHaveLength(1);
    expect(screen.getByTestId("puzzle-continue")).toBeInTheDocument();
  });

  it("resumes at the question when the answer was right before the animation got there", async () => {
    mountStage(animatedStory({ lessonRef: null }));
    advanceUntil(atPuzzle);
    answer("choice_B");
    expect(screen.getByTestId("puzzle-continue")).toBeInTheDocument();
    await bringUp();
    expect(harness.postedOfType("resume")).toHaveLength(0);
    harness.paused("interaction", PAUSE);
    expect(harness.postedOfType("resume")).toHaveLength(1);
  });

  it("leaves HP and the answer check alone for every message the iframe can send", async () => {
    await toQuestion();

    harness.frame(PAUSE, false);
    harness.paused("interaction", PAUSE);
    harness.paused("end", DURATION - 1);
    harness.ended();
    harness.heartbeat();
    // Forged and malformed messages, from the iframe and from elsewhere.
    harness.deliver({ source: "lore-sandbox", version: 1, type: "answer", session: harness.session(), correct: true });
    harness.deliver({ source: "lore-sandbox", version: 1, type: "frame", session: harness.session(), frame: -1, playing: "yes" });
    harness.deliver({ isCorrect: true, hp: 99, type: "paused", reason: "interaction", frame: PAUSE });
    harness.deliver("correct");
    harness.deliver(null);
    harness.deliver(harness.build("paused", { reason: "interaction", frame: PAUSE }), { source: window });

    expect(hp()).toBe("5/5");
    expect(screen.queryByTestId("puzzle-continue")).toBeNull();
    expect(screen.getByTestId("puzzle-submit")).toBeInTheDocument();
    expect(harness.postedOfType("resume")).toHaveLength(0);
    expect(validate).not.toHaveBeenCalled();
  });

  it("goes on with the Fallback_Scene when the iframe fails mid-question, and the answer still counts", async () => {
    await toQuestion();
    harness.error("runtime", "RENDER_THROW");
    expect(status()).toBe("failed:runtime");
    expect(kind()).toBe("puzzle");
    expect(frame()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("animation failed:runtime");
    expect(hp()).toBe("5/5");

    answer("choice_A");
    expect(hp()).toBe("4/5");
    answer("choice_B");
    expect(screen.getByTestId("puzzle-continue")).toBeInTheDocument();
    expect(harness.postedOfType("resume")).toHaveLength(0);
  });

  it("completes the puzzle and goes on to the next scene while the animation is shown", async () => {
    await toQuestion();
    answer("choice_B");
    act(() => {
      fireEvent.click(screen.getByTestId("puzzle-continue"));
    });
    // The consequence scene has no canvas, so the iframe is gone with it.
    expect(screen.queryByTestId("puzzle-interaction")).toBeNull();
    expect(frame()).toBeNull();
    expect(screen.getByTestId("scene-content")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 4. The API says the feature is not configured
// ---------------------------------------------------------------------------

describe("ANIMATION_NOT_CONFIGURED from the API", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    // The real loader asks the API; the API answers 503 with the error envelope.
    loader.loadAnimation.mockReset();
    loader.loadAnimation.mockImplementation((...args: unknown[]) => loader.real!(...args));
    fetchSpy.mockReset();
    fetchSpy.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: { code: "ANIMATION_NOT_CONFIGURED", message: "Animations are not set up on this server." },
          }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);
  });

  it("plays a drawn lesson through the Fallback_Scene and lets the story go on", async () => {
    mountStage(animatedStory({ puzzleRef: null }));
    advanceUntil(lineIs(CHUNKS[0]));
    await waitFor(() => expect(status()).toBe("failed:urls"));

    expect(kind()).toBe("visual");
    expect(frame()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("animation failed:urls");
    // The Remotion player of the fallback is on screen with the lesson's own picture.
    const player = remotion.props.at(-1)!;
    expect(player.durationInFrames).toBe(visualDuration(PICTURE));
    expect(player.inputProps).toMatchObject({ title: "Crystal Vector Resonance", visual: PICTURE });

    space();
    expect(lineIs(CHUNKS[1])()).toBe(true);
    expect(kind()).toBe("visual");
    expect(status()).toBe("failed:urls");
    // One request for the whole step: no retry, no second load for the next chunk.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("plays a puzzle through the Fallback_Scene and the player can still answer it", async () => {
    mountStage(animatedStory({ lessonRef: null }));
    advanceUntil(atPuzzle);
    await waitFor(() => expect(status()).toBe("failed:urls"));

    expect(kind()).toBe("puzzle");
    expect(frame()).toBeNull();
    expect(warn).toHaveBeenCalledWith("animation failed:urls");
    const player = remotion.props.at(-1)!;
    expect(player.durationInFrames).toBe(visualDuration(PICTURE));
    expect(player.inputProps).toMatchObject({ question: linearStory.puzzles[0].question, visual: PICTURE });

    answer("choice_A");
    expect(hp()).toBe("4/5");
    answer("choice_B");
    expect(screen.getByTestId("puzzle-continue")).toBeInTheDocument();

    // The only request was the GET for the bundle address; nothing was posted.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe(`/api/v1/animations/${PUZZLE_REF.animation_id}`);
    expect((init as RequestInit | undefined)?.method ?? "GET").toBe("GET");
  });
});

// The contract the references in the fixtures follow, so a change of it fails here and not later.
describe("the fixtures", () => {
  it("use the contract's canvas and version", () => {
    for (const reference of [LESSON_REF, PUZZLE_REF]) {
      expect(reference.width).toBe(CONTRACT.canvas.width);
      expect(reference.height).toBe(CONTRACT.canvas.height);
      expect(reference.contract_version).toBe(CONTRACT.contract_version);
    }
    expect(LESSON_REF.pause_at_frame).toBeUndefined();
    expect(PUZZLE_REF.pause_at_frame).toBe(PAUSE);
  });
});
