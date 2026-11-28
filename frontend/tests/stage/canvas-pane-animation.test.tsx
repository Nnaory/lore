// @vitest-environment jsdom
/**
 * Tests: StageCanvas and CanvasPane with an `animation` scene (task 27.2), design 7.6 and 3.2,
 * Requirements 30.4, 30.7, 30.8, 30.14, 31.3, 31.7, 31.14, 39.7, 39.14.
 *
 * The loader is a mock, the iframe's window is the fake one of `tests/fixtures/sandbox-harness.ts`,
 * and `@remotion/player` is a stand-in whose Player attaches one fake player object to the `ref` it
 * is given (so the PlayerBar can be driven and the player hand-over can be seen). The real
 * `AnimationScene`, `SandboxFrame`, `SandboxController`, `SandboxPlayerRef`, `StageCanvas`,
 * `CanvasPane` and `useCanvasPlayback` run. This proves the components' logic, not a real browser:
 * [belum diverifikasi] the iframe's layout inside the 16:9 box in Chromium and Firefox
 * (checklist of Requirement 27.9).
 *
 *   1. scenes that are not animations: wrapper, Player props and `data-canvas-kind` as before;
 *   2. an animation scene in `StageCanvas`: Fallback_Scene, kind and status at every step, each
 *      failure phase, a report from the previous scene;
 *   3. `CanvasPane`: `keyframes` and the length of the bar during `loading`, `failed` and `playing`,
 *      the player hand-over, the Play button, `answerCorrect`, `setMode`;
 *   4. a page that `<Activity>` hid and shows again (cacheComponents), the limitation recorded for
 *      task 27.1: a scene that has not failed is mounted afresh, a failed one is left alone.
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Activity, StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnimationScene } from "@/components/animation/AnimationScene";
import { CanvasPane, PuzzleActions, PuzzleChoices, type FramedScene } from "@/components/stage/CanvasPane";
import { CANVAS_FPS, CANVAS_HEIGHT, CANVAS_WIDTH } from "@/components/stage/canvas-layout";
import { DECISION_DURATION } from "@/components/stage/compositions";
import {
  StageCanvas,
  sceneDurationFrames,
  type AnimationSceneProps,
  type CanvasScene,
} from "@/components/stage/StageCanvas";
import { usePuzzleInteraction } from "@/components/story/use-puzzle-interaction";
import { dummyStory } from "@/data/dummy-campaign";
import { CONTRACT } from "@/lib/animation/contract";
import type { LoadResult } from "@/lib/animation/loader";
import type { Pacing } from "@/lib/story/pacing";
import type { AnimationReference } from "@/lib/types/animation";
import { createSandboxHarness, type SandboxHarness } from "../fixtures/sandbox-harness";

const loader = vi.hoisted(() => ({ loadAnimation: vi.fn() }));
vi.mock("@/lib/animation/loader", () => ({ loadAnimation: loader.loadAnimation }));

/** What the mocked Remotion `Player` saw, and the one player object it hands to its `ref`. */
const remotion = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>>, player: null as unknown }));
vi.mock("@remotion/player", async () => {
  const { createElement } = await vi.importActual<typeof import("react")>("react");
  return {
    Player: (props: Record<string, unknown>) => {
      remotion.props.push(props);
      const ref = props.ref as ((player: unknown) => void) | undefined;
      return createElement("div", {
        "data-testid": "remotion-player",
        ref: (element: HTMLElement | null) => ref?.(element ? remotion.player : null),
      });
    },
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A player the PlayerBar can listen to: tests fire its events with `emit`. */
function makeFakePlayer() {
  type Listener = (event: { detail: unknown }) => void;
  const listeners = new Map<string, Set<Listener>>();
  const of = (name: string): Set<Listener> => {
    let set = listeners.get(name);
    if (!set) {
      set = new Set();
      listeners.set(name, set);
    }
    return set;
  };
  return {
    addEventListener: vi.fn((name: string, cb: Listener) => void of(name).add(cb)),
    removeEventListener: vi.fn((name: string, cb: Listener) => void of(name).delete(cb)),
    play: vi.fn(),
    pause: vi.fn(),
    seekTo: vi.fn(),
    emit(name: string, detail?: unknown) {
      act(() => {
        for (const cb of [...of(name)]) cb({ detail });
      });
    },
    listenerCount: (name: string) => of(name).size,
  };
}
type FakePlayer = ReturnType<typeof makeFakePlayer>;

const DURATION = 210;
const PAUSE = 150;
const BUNDLE = '"use strict";module.exports.default=function(){return null};';

const LESSON_REF: AnimationReference = {
  animation_id: "00000000-0000-4000-8000-000000000001",
  source_sha256: "a".repeat(64),
  bundle_sha256: "b".repeat(64),
  width: CONTRACT.canvas.width,
  height: CONTRACT.canvas.height,
  fps: CONTRACT.canvas.fps,
  duration_in_frames: DURATION,
  contract_version: CONTRACT.contract_version,
};
const PUZZLE_REF: AnimationReference = { ...LESSON_REF, pause_at_frame: PAUSE };

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

const visualFallback = {
  kind: "visual",
  props: { title: "Vectors", seed: 1, visual: { kind: "vectors", vectors: [{ from: [0, 0], to: [2, 1] }] } },
} satisfies AnimationSceneProps["fallback"];
const lessonFallback = {
  kind: "lesson",
  props: { title: "Vectors", body: "Arrows with length.", seed: 1 },
} satisfies AnimationSceneProps["fallback"];
const decisionFallback = { kind: "decision", props: { label: "", seed: 1 } } satisfies AnimationSceneProps["fallback"];
const puzzleFallback = {
  kind: "puzzle",
  props: { question: "Which arrow is longer?", seed: 1, visual: visualFallback.props.visual },
} satisfies AnimationSceneProps["fallback"];
const ambient: CanvasScene = { kind: "ambient", props: { title: "The Hall", seed: 1 } };

function animation(reference: AnimationReference, fallback: AnimationSceneProps["fallback"]): FramedScene {
  return { kind: "animation", props: { animation: reference, fallback } };
}

const puzzle = dummyStory.puzzles[0]; // correct: choice_B; wrong: choice_A, choice_C

let harness: SandboxHarness;
let remotionPlayer: FakePlayer;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  harness = createSandboxHarness();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  remotion.props = [];
  remotionPlayer = makeFakePlayer();
  remotion.player = remotionPlayer;
  loader.loadAnimation.mockReset();
});

afterEach(() => {
  cleanup();
  harness.restore();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Lets the mocked loader's promise reach the component. */
const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
/** Yields to the microtask queue, as a real navigation does between hiding and showing a page. */
const yieldToMicrotasks = () => act(async () => {});
const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

const canvas = () => screen.getByTestId("stage-canvas");
const canvasKind = () => canvas().getAttribute("data-canvas-kind");
const animationStatus = () => canvas().getAttribute("data-animation-status");
const iframe = (): HTMLIFrameElement | null => screen.queryByTestId("sandbox-frame") as HTMLIFrameElement | null;
const hasRemotionPlayer = () => screen.queryByTestId("remotion-player") !== null;
const lastPlayerProps = () => remotion.props.at(-1)!;

/** Messages of the runtime for the session of the most recent `load` (a remount makes a new one). */
const latestSession = () => harness.postedOfType("load").at(-1)!.session;
const deliverLatest = (type: string, fields: Record<string, unknown> = {}) =>
  harness.deliver(harness.build(type, fields, latestSession()));

/** The gold diamonds of the PlayerBar, as `left` values. */
const diamonds = (): string[] =>
  [...document.querySelectorAll<HTMLElement>(".rotate-45.bg-gold")].map((element) => element.style.left);
/** Width of the ember progress fill of the PlayerBar. */
const fill = (): string => document.querySelector<HTMLElement>(".h-1 > .bg-ember")!.style.width;
const clock = (): string => document.querySelector(".order-last")!.textContent ?? "";

const pane = (
  scene: FramedScene,
  { sceneKey = "scene", pacing = "animate" as Pacing, layout = "desktop" as "desktop" | "phone" } = {},
): ReactNode => <CanvasPane scene={scene} sceneKey={sceneKey} pacing={pacing} layout={layout} label="Vectors" />;

/**
 * A puzzle pane: the real `usePuzzleInteraction` decides right and wrong. On the phone layout the
 * pane draws no choices (the dialogue box does), so this draws them beside it, as StoryViewer does.
 */
function PuzzlePane({
  scene,
  pacing = "animate",
  layout = "desktop",
}: {
  scene: FramedScene;
  pacing?: Pacing;
  layout?: "desktop" | "phone";
}) {
  const interaction = usePuzzleInteraction(puzzle, {});
  const onComplete = () => {};
  return (
    <>
      <CanvasPane
        scene={scene}
        sceneKey="puzzle:puzzle_01"
        pacing={pacing}
        layout={layout}
        label="Crystals"
        puzzle={{ puzzle, interaction, onComplete }}
      />
      {layout === "phone" && (
        <>
          <PuzzleChoices puzzle={puzzle} interaction={interaction} />
          <PuzzleActions interaction={interaction} onComplete={onComplete} />
        </>
      )}
    </>
  );
}

/** Brings a mounted scene to `loaded`. */
async function reachLoaded() {
  await flush();
  harness.ready();
  harness.loaded(DURATION);
}

// ---------------------------------------------------------------------------
// 1. Scenes that are not animations
// ---------------------------------------------------------------------------

/** The props the Remotion `Player` got before animations existed (the `key` is not a prop). */
const OLD_PLAYER_PROPS = [
  "acknowledgeRemotionLicense",
  "autoPlay",
  "clickToPlay",
  "component",
  "compositionHeight",
  "compositionWidth",
  "controls",
  "doubleClickToFullscreen",
  "durationInFrames",
  "fps",
  "initialFrame",
  "inputProps",
  "loop",
  "moveToBeginningWhenEnded",
  "ref",
  "spaceKeyToPlayOrPause",
  "style",
].sort();

const OLD_SCENES: Array<[string, CanvasScene]> = [
  ["ambient", ambient],
  ["lesson", lessonFallback],
  ["visual", visualFallback],
  ["puzzle", puzzleFallback],
  ["decision", decisionFallback],
];
/** The scenes a CanvasFrame can hold (no ambient, OQ-12). */
const OLD_FRAMED_SCENES: Array<[string, FramedScene]> = [
  ["lesson", lessonFallback],
  ["visual", visualFallback],
  ["puzzle", puzzleFallback],
  ["decision", decisionFallback],
];

/** Asserts the wrapper has the 16:9 box of the old code: same `style` as the same declaration. */
function expectSixteenByNineBox(element: HTMLElement) {
  const probe = render(
    <div
      style={{
        aspectRatio: `${CANVAS_WIDTH} / ${CANVAS_HEIGHT}`,
        width: `min(100%, calc(100cqh * ${CANVAS_WIDTH} / ${CANVAS_HEIGHT}))`,
      }}
    />,
  );
  expect(element.getAttribute("style")).toBe(probe.container.firstElementChild!.getAttribute("style"));
  probe.unmount();
}

describe("scenes that are not animations", () => {
  it.each(OLD_SCENES)("%s: same wrapper, same Player props, same data-canvas-kind as before", (kind, scene) => {
    render(<StageCanvas scene={scene} sceneKey="k" pacing="animate" playerRef={() => {}} />);
    expect(canvasKind()).toBe(kind);
    expect(animationStatus()).toBe("off");
    // The one attribute that is new is data-animation-status (Requirement 31.3).
    expect(canvas().getAttributeNames().sort()).toEqual([
      "class",
      "data-animation-status",
      "data-canvas-kind",
      "data-testid",
      "style",
    ]);
    expect(canvas().className).toBe("relative mx-auto overflow-hidden border border-smoke");
    expectSixteenByNineBox(canvas());
    // The Player is the only child, and no animation scene is in the tree.
    expect(canvas().children).toHaveLength(1);
    expect(canvas().firstElementChild).toBe(screen.getByTestId("remotion-player"));
    expect(screen.queryByTestId("animation-scene")).toBeNull();
    expect(screen.queryByTestId("sandbox-frame")).toBeNull();

    const props = lastPlayerProps();
    expect(Object.keys(props).sort()).toEqual(OLD_PLAYER_PROPS);
    expect(props.inputProps).toBe(scene.props);
    expect(props).toMatchObject({
      durationInFrames: sceneDurationFrames(scene),
      fps: CANVAS_FPS,
      compositionWidth: CANVAS_WIDTH,
      compositionHeight: CANVAS_HEIGHT,
      style: { width: "100%", height: "100%" },
      controls: false,
      clickToPlay: false,
      doubleClickToFullscreen: false,
      spaceKeyToPlayOrPause: false,
      moveToBeginningWhenEnded: false,
      acknowledgeRemotionLicense: true,
    });
  });

  it("keeps the bare wrapper class and the overlay box", () => {
    render(
      <StageCanvas scene={lessonFallback} sceneKey="k" pacing="animate" bare>
        <p data-testid="overlay">over the canvas</p>
      </StageCanvas>,
    );
    expect(canvas().className).toBe("relative mx-auto overflow-hidden");
    expect(canvas().lastElementChild!.className).toBe("absolute inset-0");
    expect(canvas().lastElementChild).toContainElement(screen.getByTestId("overlay"));
  });

  it("never calls onAnimationStatus and never loads anything", async () => {
    const onAnimationStatus = vi.fn();
    render(<StageCanvas scene={visualFallback} sceneKey="k" pacing="animate" onAnimationStatus={onAnimationStatus} />);
    await flush();
    expect(onAnimationStatus).not.toHaveBeenCalled();
    expect(loader.loadAnimation).not.toHaveBeenCalled();
  });

  it.each(OLD_FRAMED_SCENES)("%s in CanvasPane: bar length and markers as before, status off", (kind, scene) => {
    render(pane(scene));
    expect(animationStatus()).toBe("off");
    expect(canvasKind()).toBe(kind);
    expect(diamonds()).toEqual(kind === "puzzle" || kind === "decision" ? ["100%"] : []);
    // The bar follows the Remotion player over the scene's own length.
    remotionPlayer.emit("frameupdate", { frame: sceneDurationFrames(scene) / 2 });
    expect(fill()).toBe("50%");
  });
});

// ---------------------------------------------------------------------------
// 2. An animation scene in StageCanvas
// ---------------------------------------------------------------------------

describe("StageCanvas with an animation scene", () => {
  it("draws the Fallback_Scene exactly as the same scene is drawn without a reference", () => {
    loader.loadAnimation.mockReturnValue(new Promise(() => {}));
    const view = render(
      <StageCanvas scene={animation(LESSON_REF, visualFallback)} sceneKey="k" pacing="animate" playerRef={() => {}} />,
    );
    const { ref: animationRef, ...inAnimation } = lastPlayerProps();
    view.unmount();
    render(<StageCanvas scene={visualFallback} sceneKey="k" pacing="animate" playerRef={() => {}} />);
    const { ref: plainRef, ...plain } = lastPlayerProps();
    expect(typeof animationRef).toBe("function");
    expect(typeof plainRef).toBe("function");
    expect(inAnimation).toEqual(plain);
    expect(inAnimation.inputProps).toBe(visualFallback.props);
  });

  it("keeps the same wrapper and 16:9 box, with the animation scene inside it", () => {
    loader.loadAnimation.mockReturnValue(new Promise(() => {}));
    render(<StageCanvas scene={animation(LESSON_REF, visualFallback)} sceneKey="k" pacing="animate" />);
    expect(screen.getAllByTestId("stage-canvas")).toHaveLength(1);
    expect(canvas().className).toBe("relative mx-auto overflow-hidden border border-smoke");
    expectSixteenByNineBox(canvas());
    expect(canvas().firstElementChild).toBe(screen.getByTestId("animation-scene"));
    expect(screen.getByTestId("animation-scene")).toContainElement(screen.getByTestId("remotion-player"));
  });

  it("reports loading with the Fallback_Scene's kind until the iframe is shown", async () => {
    loader.loadAnimation.mockResolvedValue(okResult(LESSON_REF));
    const onAnimationStatus = vi.fn();
    render(
      <StageCanvas
        scene={animation(LESSON_REF, visualFallback)}
        sceneKey="k"
        pacing="animate"
        onAnimationStatus={onAnimationStatus}
      />,
    );
    expect(animationStatus()).toBe("loading");
    expect(canvasKind()).toBe("visual");
    await flush();
    // The iframe is mounted but hidden, the Fallback_Scene is still drawn.
    expect(iframe()).not.toBeNull();
    expect(iframe()!.style.visibility).toBe("hidden");
    expect(hasRemotionPlayer()).toBe(true);
    expect(animationStatus()).toBe("loading");
    expect(canvasKind()).toBe("visual");
    expect(onAnimationStatus.mock.calls.map((call) => call[0])).toEqual(["loading"]);
  });

  it("reports animation, paused and playing once the iframe is shown, inside the same 16:9 box", async () => {
    loader.loadAnimation.mockResolvedValue(okResult(LESSON_REF));
    const onAnimationStatus = vi.fn();
    render(
      <StageCanvas
        scene={animation(LESSON_REF, visualFallback)}
        sceneKey="k"
        pacing="animate"
        onAnimationStatus={onAnimationStatus}
      />,
    );
    await reachLoaded();
    expect(animationStatus()).toBe("paused");
    expect(canvasKind()).toBe("animation");
    expect(hasRemotionPlayer()).toBe(false);
    expect(iframe()!.style.visibility).toBe("visible");
    expect(canvas()).toContainElement(iframe());
    expect(screen.getByTestId("animation-scene").className).toBe("absolute inset-0");

    harness.frame(3, true);
    expect(animationStatus()).toBe("playing");
    expect(canvasKind()).toBe("animation");
    expect(onAnimationStatus.mock.calls.map((call) => call[0])).toEqual(["loading", "paused", "playing"]);
  });

  it("goes back to the Fallback_Scene and its kind when the animation fails after it was shown", async () => {
    loader.loadAnimation.mockResolvedValue(okResult(LESSON_REF));
    const onAnimationStatus = vi.fn();
    render(
      <StageCanvas
        scene={animation(LESSON_REF, lessonFallback)}
        sceneKey="k"
        pacing="animate"
        onAnimationStatus={onAnimationStatus}
      />,
    );
    await reachLoaded();
    harness.error("runtime");
    expect(animationStatus()).toBe("failed:runtime");
    expect(canvasKind()).toBe("lesson");
    expect(iframe()).toBeNull();
    expect(hasRemotionPlayer()).toBe(true);
    expect(lastPlayerProps().inputProps).toBe(lessonFallback.props);
    expect(onAnimationStatus.mock.calls.map((call) => call[0]).at(-1)).toBe("failed:runtime");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("animation failed:runtime");
  });

  describe.each([
    ["urls", { ok: false, phase: "urls", reason: "bad_urls" }],
    ["fetch", { ok: false, phase: "fetch", reason: "network" }],
    ["integrity", { ok: false, phase: "integrity", reason: "mismatch" }],
  ] as const)("failure %s", (phase, result) => {
    it("draws the Fallback_Scene with status failed:<phase> and the fallback's kind", async () => {
      loader.loadAnimation.mockResolvedValue(result);
      render(<StageCanvas scene={animation(LESSON_REF, decisionFallback)} sceneKey="k" pacing="animate" />);
      await flush();
      expect(animationStatus()).toBe(`failed:${phase}`);
      expect(canvasKind()).toBe("decision");
      expect(hasRemotionPlayer()).toBe(true);
      expect(iframe()).toBeNull();
    });
  });

  it.each(["load", "runtime"] as const)("failure %s reported by the sandbox", async (phase) => {
    loader.loadAnimation.mockResolvedValue(okResult(LESSON_REF));
    render(<StageCanvas scene={animation(LESSON_REF, decisionFallback)} sceneKey="k" pacing="animate" />);
    await flush();
    harness.ready();
    harness.error(phase);
    expect(animationStatus()).toBe(`failed:${phase}`);
    expect(canvasKind()).toBe("decision");
    expect(iframe()).toBeNull();
  });

  it("failure timeout: 48000 ms without loaded", async () => {
    loader.loadAnimation.mockReturnValue(new Promise(() => {}));
    render(<StageCanvas scene={animation(LESSON_REF, decisionFallback)} sceneKey="k" pacing="animate" />);
    advance(47999);
    expect(animationStatus()).toBe("loading");
    advance(1);
    expect(animationStatus()).toBe("failed:timeout");
    expect(canvasKind()).toBe("decision");
  });

  it("does not believe a status report of the previous scene when the scene changes", async () => {
    loader.loadAnimation.mockResolvedValue(okResult(LESSON_REF));
    const first = animation(LESSON_REF, visualFallback);
    const view = render(<StageCanvas scene={first} sceneKey="lesson:a" pacing="animate" />);
    await reachLoaded();
    expect(animationStatus()).toBe("paused");

    loader.loadAnimation.mockReturnValue(new Promise(() => {}));
    view.rerender(<StageCanvas scene={animation(PUZZLE_REF, puzzleFallback)} sceneKey="puzzle:b" pacing="animate" />);
    expect(animationStatus()).toBe("loading");
    expect(canvasKind()).toBe("puzzle");
    expect(iframe()).toBeNull();
  });

  it("goes to a non-animation scene: status off, kind of the scene", async () => {
    loader.loadAnimation.mockResolvedValue(okResult(LESSON_REF));
    const view = render(<StageCanvas scene={animation(LESSON_REF, visualFallback)} sceneKey="a" pacing="animate" />);
    await reachLoaded();
    view.rerender(<StageCanvas scene={lessonFallback} sceneKey="b" pacing="animate" />);
    expect(animationStatus()).toBe("off");
    expect(canvasKind()).toBe("lesson");
    expect(screen.queryByTestId("animation-scene")).toBeNull();
    expect(iframe()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. CanvasPane with an animation scene
// ---------------------------------------------------------------------------

describe("CanvasPane bar during an animation scene", () => {
  it("loading: the bar has the Fallback_Scene's markers and length (decision: [100], 50 frames)", async () => {
    loader.loadAnimation.mockReturnValue(new Promise(() => {}));
    render(pane(animation(PUZZLE_REF, decisionFallback)));
    expect(animationStatus()).toBe("loading");
    expect(diamonds()).toEqual(["100%"]);
    remotionPlayer.emit("frameupdate", { frame: DECISION_DURATION / 2 });
    expect(fill()).toBe("50%");
  });

  it("loading with a visual fallback: no marker, and the length of the visual", () => {
    loader.loadAnimation.mockReturnValue(new Promise(() => {}));
    render(pane(animation(LESSON_REF, visualFallback)));
    expect(diamonds()).toEqual([]);
    remotionPlayer.emit("frameupdate", { frame: sceneDurationFrames(visualFallback) / 4 });
    expect(fill()).toBe("25%");
  });

  it("loading with a puzzle fallback: [100] and the length of the puzzle picture", () => {
    loader.loadAnimation.mockReturnValue(new Promise(() => {}));
    render(pane(animation(PUZZLE_REF, puzzleFallback)));
    expect(diamonds()).toEqual(["100%"]);
    remotionPlayer.emit("frameupdate", { frame: sceneDurationFrames(puzzleFallback) / 2 });
    expect(fill()).toBe("50%");
  });

  it("playing a puzzle animation: one marker at pause_at_frame / duration, and the animation's length", async () => {
    loader.loadAnimation.mockResolvedValue(okResult(PUZZLE_REF));
    render(pane(animation(PUZZLE_REF, decisionFallback)));
    await reachLoaded();
    expect(animationStatus()).toBe("paused");
    expect(diamonds()).toEqual([`${(PAUSE / DURATION) * 100}%`]);
    // Frames of the iframe move the bar over 210 frames, not over the fallback's 50.
    harness.frame(DURATION / 2, true);
    expect(fill()).toBe("50%");
    expect(clock()).toBe("0:03");
    harness.frame(PAUSE, true);
    expect(fill()).toBe(`${(PAUSE / DURATION) * 100}%`);
  });

  it("playing a lesson animation: no marker at all, even over a puzzle-kind fallback", async () => {
    loader.loadAnimation.mockResolvedValue(okResult(LESSON_REF));
    render(pane(animation(LESSON_REF, puzzleFallback)));
    expect(diamonds()).toEqual(["100%"]); // while loading it is the fallback's
    await reachLoaded();
    expect(diamonds()).toEqual([]);
    harness.frame(DURATION / 2, true);
    expect(fill()).toBe("50%");
  });

  it("failed after it was shown: the bar goes back to the fallback's markers and length", async () => {
    loader.loadAnimation.mockResolvedValue(okResult(PUZZLE_REF));
    render(pane(animation(PUZZLE_REF, decisionFallback)));
    await reachLoaded();
    expect(diamonds()).toEqual([`${(PAUSE / DURATION) * 100}%`]);

    harness.error("runtime");
    expect(animationStatus()).toBe("failed:runtime");
    expect(diamonds()).toEqual(["100%"]);
    remotionPlayer.emit("frameupdate", { frame: DECISION_DURATION / 2 });
    expect(fill()).toBe("50%");
  });

  it.each(["urls", "fetch", "integrity"] as const)("failed:%s before any iframe: the fallback's markers", async (phase) => {
    loader.loadAnimation.mockResolvedValue({ ok: false, phase, reason: "x" });
    render(pane(animation(PUZZLE_REF, decisionFallback)));
    await flush();
    expect(animationStatus()).toBe(`failed:${phase}`);
    expect(diamonds()).toEqual(["100%"]);
  });

  it("a status report of the previous scene does not move the bar of the next one", async () => {
    loader.loadAnimation.mockResolvedValue(okResult(PUZZLE_REF));
    const view = render(pane(animation(PUZZLE_REF, decisionFallback), { sceneKey: "puzzle:a" }));
    await reachLoaded();
    expect(diamonds()).toEqual([`${(PAUSE / DURATION) * 100}%`]);

    loader.loadAnimation.mockReturnValue(new Promise(() => {}));
    view.rerender(pane(animation(PUZZLE_REF, decisionFallback), { sceneKey: "puzzle:b" }));
    expect(animationStatus()).toBe("loading");
    expect(diamonds()).toEqual(["100%"]);
  });
});

describe("CanvasPane hands the bar from one player to the other", () => {
  it("the bar listens to the Remotion player first, then to the sandbox player, then back", async () => {
    loader.loadAnimation.mockResolvedValue(okResult(LESSON_REF));
    render(pane(animation(LESSON_REF, decisionFallback)));
    expect(remotionPlayer.listenerCount("frameupdate")).toBe(1);

    await reachLoaded();
    expect(remotionPlayer.listenerCount("frameupdate")).toBe(0);
    remotionPlayer.emit("frameupdate", { frame: 40 }); // a stale player is not heard
    expect(fill()).toBe("0%");
    harness.frame(21, true);
    expect(fill()).toBe("10%");

    harness.error("runtime");
    expect(remotionPlayer.listenerCount("frameupdate")).toBe(1);
    remotionPlayer.emit("frameupdate", { frame: 25 });
    expect(fill()).toBe("50%");
    // The sandbox player was disposed: more messages from the iframe change nothing.
    harness.frame(105, true);
    expect(fill()).toBe("50%");
  });

  it("the Play button drives the Remotion player while the Fallback_Scene is drawn, and the sandbox when shown", async () => {
    loader.loadAnimation.mockResolvedValue(okResult(LESSON_REF));
    render(pane(animation(LESSON_REF, decisionFallback)));
    fireEvent.click(screen.getByRole("button", { name: "Play animation" }));
    expect(remotionPlayer.play).toHaveBeenCalledTimes(1);
    expect(harness.postedOfType("play")).toHaveLength(0);

    await reachLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Play animation" }));
    expect(harness.postedOfType("play")).toHaveLength(1);
    expect(remotionPlayer.play).toHaveBeenCalledTimes(1);

    harness.error("runtime");
    fireEvent.click(screen.getByRole("button", { name: "Play animation" }));
    expect(remotionPlayer.play).toHaveBeenCalledTimes(2);
    expect(harness.postedOfType("play")).toHaveLength(1);
  });
});

describe("CanvasPane forwards the answer and the pacing to the animation", () => {
  const pick = (id: string) => fireEvent.click(screen.getByTestId(`choice-${id}`));
  const submit = () => fireEvent.click(screen.getByTestId("puzzle-submit"));

  it("resumes the animation once for a correct answer and sends nothing for a wrong one", async () => {
    loader.loadAnimation.mockResolvedValue(okResult(PUZZLE_REF));
    render(<PuzzlePane scene={animation(PUZZLE_REF, decisionFallback)} />);
    await reachLoaded();
    harness.paused("interaction", PAUSE);
    expect(harness.postedOfType("resume")).toHaveLength(0);

    pick("choice_A");
    submit();
    expect(screen.getByTestId("puzzle-feedback")).toBeTruthy();
    expect(harness.postedOfType("resume")).toHaveLength(0);

    pick("choice_B");
    submit();
    expect(screen.getByText("RESUMED")).toBeTruthy();
    expect(harness.postedOfType("resume")).toHaveLength(1);
  });

  it("resumes at the pause when the answer was already correct before the pause was reached", async () => {
    loader.loadAnimation.mockResolvedValue(okResult(PUZZLE_REF));
    render(<PuzzlePane scene={animation(PUZZLE_REF, decisionFallback)} />);
    await flush();
    pick("choice_B");
    submit();
    expect(harness.postedOfType("resume")).toHaveLength(0);
    harness.ready();
    harness.loaded(DURATION);
    expect(harness.postedOfType("resume")).toHaveLength(0); // no pause reached yet
    harness.paused("interaction", PAUSE);
    expect(harness.postedOfType("resume")).toHaveLength(1);
  });

  it("does the same on the phone layout, where the choices are drawn outside the pane", async () => {
    loader.loadAnimation.mockResolvedValue(okResult(PUZZLE_REF));
    render(<PuzzlePane scene={animation(PUZZLE_REF, decisionFallback)} layout="phone" />);
    await reachLoaded();
    harness.paused("interaction", PAUSE);
    expect(screen.queryByTestId("puzzle-interaction")).toBeNull(); // not inside the pane
    pick("choice_A");
    submit();
    expect(harness.postedOfType("resume")).toHaveLength(0);
    pick("choice_B");
    submit();
    expect(harness.postedOfType("resume")).toHaveLength(1);
  });

  it("sends no resume for a lesson animation (no answer)", async () => {
    loader.loadAnimation.mockResolvedValue(okResult(LESSON_REF));
    render(pane(animation(LESSON_REF, visualFallback)));
    await reachLoaded();
    harness.paused("end", DURATION - 1);
    expect(harness.postedOfType("resume")).toHaveLength(0);
  });

  it("sends setMode with the current pacing at loaded and again on a change, in the same iframe", async () => {
    loader.loadAnimation.mockResolvedValue(okResult(LESSON_REF));
    const scene = animation(LESSON_REF, visualFallback);
    const view = render(pane(scene, { pacing: "animate" }));
    await reachLoaded();
    expect(harness.postedOfType("setMode").map((message) => message.mode)).toEqual(["animate"]);
    const frame = iframe();

    view.rerender(pane(scene, { pacing: "fast" }));
    expect(harness.postedOfType("setMode").map((message) => message.mode)).toEqual(["animate", "fast"]);
    expect(iframe()).toBe(frame);
    expect(harness.postedOfType("load")).toHaveLength(1);
  });

  it("does not change what the puzzle decides when the animation fails", async () => {
    loader.loadAnimation.mockResolvedValue(okResult(PUZZLE_REF));
    render(<PuzzlePane scene={animation(PUZZLE_REF, decisionFallback)} />);
    await reachLoaded();
    pick("choice_B");
    harness.error("runtime");
    expect(animationStatus()).toBe("failed:runtime");
    expect(screen.getByTestId("choice-choice_B")).toHaveAttribute("aria-pressed", "true");
    submit();
    expect(screen.getByText("RESUMED")).toBeTruthy();
    expect(screen.getByTestId("puzzle-continue")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 4. A page that <Activity> hid and shows again
// ---------------------------------------------------------------------------

describe("a page hidden and shown again by <Activity> (cacheComponents)", () => {
  const page = (mode: "visible" | "hidden", scene: FramedScene, wrap?: (node: ReactNode) => ReactNode): ReactNode => {
    const node = <Activity mode={mode}>{pane(scene)}</Activity>;
    return wrap ? wrap(node) : node;
  };

  it("mounts a shown animation afresh instead of waiting for a ready that never comes", async () => {
    loader.loadAnimation.mockResolvedValue(okResult(PUZZLE_REF));
    const scene = animation(PUZZLE_REF, decisionFallback);
    const view = render(page("visible", scene));
    await reachLoaded();
    const oldFrame = iframe()!;
    const oldScene = screen.getByTestId("animation-scene");
    expect(animationStatus()).toBe("paused");
    expect(diamonds()).toEqual([`${(PAUSE / DURATION) * 100}%`]);

    view.rerender(page("hidden", scene));
    await yieldToMicrotasks();
    view.rerender(page("visible", scene));
    await yieldToMicrotasks();
    await flush();

    // A new scene, a new iframe, the Fallback_Scene and the fallback's bar until it is loaded again.
    expect(screen.getByTestId("animation-scene")).not.toBe(oldScene);
    expect(oldFrame.isConnected).toBe(false);
    expect(iframe()).not.toBeNull();
    expect(iframe()).not.toBe(oldFrame);
    expect(iframe()!.style.visibility).toBe("hidden");
    expect(animationStatus()).toBe("loading");
    expect(canvasKind()).toBe("decision");
    expect(hasRemotionPlayer()).toBe(true);
    expect(diamonds()).toEqual(["100%"]);

    // The new iframe's runtime says ready once (just inside its 8 s) and loaded: shown again.
    advance(7999);
    expect(animationStatus()).toBe("loading");
    harness.ready();
    expect(harness.postedOfType("load")).toHaveLength(2);
    expect(latestSession()).not.toBe(harness.postedOfType("load")[0].session);
    deliverLatest("loaded", { duration_in_frames: DURATION });
    expect(animationStatus()).toBe("paused");
    expect(canvasKind()).toBe("animation");
    expect(diamonds()).toEqual([`${(PAUSE / DURATION) * 100}%`]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("control: a bare AnimationScene that is hidden and shown again ends in failed:timeout, which is why StageCanvas remounts it", async () => {
    // The limitation of 27.1 in its own words: the controller is disposed on hide, its replacement
    // waits for a `ready` the still-running iframe will not send again. If SandboxFrame is ever made
    // to survive a reveal by itself, this test fails and the remount in StageCanvas can go.
    loader.loadAnimation.mockResolvedValue(okResult(LESSON_REF));
    const onStatus = vi.fn();
    const bare = (mode: "visible" | "hidden") => (
      <Activity mode={mode}>
        <AnimationScene
          reference={LESSON_REF}
          pacing="animate"
          onStatus={onStatus}
          renderFallback={() => <div data-testid="fallback" />}
        />
      </Activity>
    );
    const view = render(bare("visible"));
    await reachLoaded();
    expect(onStatus).toHaveBeenLastCalledWith("paused");

    view.rerender(bare("hidden"));
    await yieldToMicrotasks();
    view.rerender(bare("visible"));
    await yieldToMicrotasks();
    advance(7999);
    expect(onStatus).toHaveBeenLastCalledWith("paused");
    advance(1);
    expect(onStatus).toHaveBeenLastCalledWith("failed:timeout");
    expect(screen.queryByTestId("fallback")).not.toBeNull();
  });

  it("resumes a puzzle animation once after a reveal, for an answer that was correct before it", async () => {
    loader.loadAnimation.mockResolvedValue(okResult(PUZZLE_REF));
    const scene = animation(PUZZLE_REF, decisionFallback);
    function Page({ mode }: { mode: "visible" | "hidden" }) {
      return (
        <Activity mode={mode}>
          <PuzzlePane scene={scene} />
        </Activity>
      );
    }
    const view = render(<Page mode="visible" />);
    await reachLoaded();
    harness.paused("interaction", PAUSE);
    fireEvent.click(screen.getByTestId("choice-choice_B"));
    fireEvent.click(screen.getByTestId("puzzle-submit"));
    expect(harness.postedOfType("resume")).toHaveLength(1);

    view.rerender(<Page mode="hidden" />);
    await yieldToMicrotasks();
    view.rerender(<Page mode="visible" />);
    await yieldToMicrotasks();
    await flush();
    harness.ready();
    deliverLatest("loaded", { duration_in_frames: DURATION });
    deliverLatest("paused", { reason: "interaction", frame: PAUSE });
    // The answer is still right, so the new pause is resumed, once.
    expect(harness.postedOfType("resume")).toHaveLength(2);
  });

  it("also mounts afresh a scene that is still loading", async () => {
    loader.loadAnimation.mockReturnValue(new Promise(() => {}));
    const scene = animation(LESSON_REF, visualFallback);
    const view = render(page("visible", scene));
    const oldScene = screen.getByTestId("animation-scene");
    view.rerender(page("hidden", scene));
    await yieldToMicrotasks();
    view.rerender(page("visible", scene));
    await yieldToMicrotasks();
    expect(screen.getByTestId("animation-scene")).not.toBe(oldScene);
    expect(animationStatus()).toBe("loading");
    // The new mount has its own 48000 ms.
    advance(47999);
    expect(animationStatus()).toBe("loading");
    advance(1);
    expect(animationStatus()).toBe("failed:timeout");
  });

  it("leaves a scene that already failed alone: same scene, Fallback_Scene kept, no second warning", async () => {
    loader.loadAnimation.mockResolvedValue({ ok: false, phase: "fetch", reason: "network" });
    const scene = animation(LESSON_REF, decisionFallback);
    const view = render(page("visible", scene));
    await flush();
    expect(animationStatus()).toBe("failed:fetch");
    const sameScene = screen.getByTestId("animation-scene");

    view.rerender(page("hidden", scene));
    await yieldToMicrotasks();
    view.rerender(page("visible", scene));
    await yieldToMicrotasks();
    await flush();
    expect(screen.getByTestId("animation-scene")).toBe(sameScene);
    expect(animationStatus()).toBe("failed:fetch");
    expect(canvasKind()).toBe("decision");
    expect(iframe()).toBeNull();
    expect(diamonds()).toEqual(["100%"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not touch a scene that is not an animation", async () => {
    const view = render(page("visible", lessonFallback));
    const before = canvas();
    const playerBefore = screen.getByTestId("remotion-player");
    view.rerender(page("hidden", lessonFallback));
    await yieldToMicrotasks();
    view.rerender(page("visible", lessonFallback));
    await yieldToMicrotasks();
    expect(canvas()).toBe(before);
    expect(screen.getByTestId("remotion-player")).toBe(playerBefore);
    expect(animationStatus()).toBe("off");
    expect(loader.loadAnimation).not.toHaveBeenCalled();
  });

  it("does not remount on first mount in Strict Mode, which runs the effects twice", async () => {
    loader.loadAnimation.mockResolvedValue(okResult(LESSON_REF));
    const strict = (node: ReactNode) => <StrictMode>{node}</StrictMode>;
    render(page("visible", animation(LESSON_REF, visualFallback), strict));
    await flush();
    const mounted = screen.getByTestId("animation-scene");
    const frame = iframe();
    await yieldToMicrotasks();
    expect(screen.getByTestId("animation-scene")).toBe(mounted);
    expect(iframe()).toBe(frame);
    harness.ready();
    harness.loaded(DURATION);
    expect(harness.postedOfType("load")).toHaveLength(1);
    expect(animationStatus()).toBe("paused");
  });
});
