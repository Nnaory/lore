// @vitest-environment jsdom
/**
 * Tests: AnimationScene (task 27.1), design 7.6, K-7, Requirements 27.1, 27.8, 27.14, 28.5, 30.5,
 * 30.6, 30.9, 30.10, 30.15, 30.16, 31.1, 31.4, 31.5, 31.6, 31.8, 31.10 to 31.13, 31.15, 36.7.
 *
 * The loader is a mock that returns what a test says, and the iframe's window is fake
 * (`tests/fixtures/sandbox-harness.ts`), so these tests prove the component's logic against the
 * real SandboxFrame, SandboxController and SandboxPlayerRef, but not a real browser:
 * [belum diverifikasi] `window.origin === "null"` inside the sandboxed iframe, Remotion's Player
 * layout inside it, and the Chromium and Firefox checklist (Requirement 27.9).
 *
 *   1. from mount to `loaded`: what is on screen at each step, `load.meta`, `setMode`, status, and
 *      the player the Stage is given (also when the parent's `playerRef` function changes);
 *   2. pacing: `setMode` again, same iframe element;
 *   3. a failure in each phase (`urls`, `fetch`, `integrity`, `load`, `runtime`, `timeout`), with
 *      the Fallback_Scene back, one `console.warn`, and the player handed back in the same commit;
 *   4. after a failure: nothing changes it, nothing warns again;
 *   5. `resume`: once per pause, only for a correct answer, also when the answer came early;
 *   6. unmount before and after the result;
 *   7. the error boundary, React StrictMode, the `renderFallback` contract, and the no-Remotion rule.
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Activity, StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AnimationScene,
  type AnimationSceneViewProps,
} from "@/components/animation/AnimationScene";
import { CONTRACT } from "@/lib/animation/contract";
import type { LoadResult } from "@/lib/animation/loader";
import type { AnimationPhaseName } from "@/lib/animation/scene-status";
import type { PlayerLike } from "@/lib/stage/player-like";
import type { AnimationReference } from "@/lib/types/animation";
import { createSandboxHarness, type SandboxHarness } from "../fixtures/sandbox-harness";

const loader = vi.hoisted(() => ({ loadAnimation: vi.fn() }));
vi.mock("@/lib/animation/loader", () => ({ loadAnimation: loader.loadAnimation }));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
  const meta: LoadResult extends infer R ? (R extends { ok: true; meta: infer M } ? M : never) : never = {
    width: reference.width,
    height: reference.height,
    fps: reference.fps,
    durationInFrames: reference.duration_in_frames,
    ...(reference.pause_at_frame !== undefined ? { pauseAtFrame: reference.pause_at_frame } : {}),
  };
  return { ok: true, bundle: BUNDLE, meta, runtimeMismatch: false };
}

/** Something that fits `PlayerLike`: the stand-in for the Fallback_Scene's Remotion player. */
const fallbackPlayer: PlayerLike = {
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  play: vi.fn(),
  pause: vi.fn(),
  seekTo: vi.fn(),
};

let harness: SandboxHarness;
let warn: ReturnType<typeof vi.spyOn>;
let playerRef: ReturnType<typeof vi.fn<(player: PlayerLike | null) => void>>;
let onStatus: ReturnType<typeof vi.fn<(status: string) => void>>;

beforeEach(() => {
  vi.useFakeTimers();
  harness = createSandboxHarness();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  playerRef = vi.fn();
  onStatus = vi.fn();
  loader.loadAnimation.mockReset();
});

afterEach(() => {
  cleanup();
  harness.restore();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The Fallback_Scene of the tests: a div whose `ref` callback hands out `fallbackPlayer`. */
function renderFallback(ref: (player: PlayerLike | null) => void): ReactNode {
  return (
    <div
      data-testid="fallback"
      ref={(element) => {
        ref(element ? fallbackPlayer : null);
      }}
    />
  );
}

function scene(overrides: Partial<AnimationSceneViewProps> = {}) {
  return (
    <AnimationScene
      reference={LESSON_REF}
      pacing="animate"
      playerRef={playerRef}
      onStatus={onStatus}
      renderFallback={renderFallback}
      {...overrides}
    />
  );
}

/** Lets the mocked loader's promise reach the component. */
const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

const statuses = (): string[] => onStatus.mock.calls.map((call) => call[0]);
const lastStatus = (): string | undefined => statuses().at(-1);
const hasFallback = (): boolean => screen.queryByTestId("fallback") !== null;
const iframe = (): HTMLIFrameElement | null =>
  screen.queryByTestId("sandbox-frame") as HTMLIFrameElement | null;
const sentTypes = (): string[] => harness.posted().map((message) => message.type);
const sentOf = (type: string) => harness.postedOfType(type);

/** Mounts the scene with a verified bundle and brings the sandbox up to `loaded`. */
async function mountShown(overrides: Partial<AnimationSceneViewProps> = {}) {
  const reference = overrides.reference ?? LESSON_REF;
  loader.loadAnimation.mockResolvedValue(okResult(reference));
  const view = render(scene(overrides));
  await flush();
  harness.ready();
  harness.loaded(DURATION);
  return view;
}

/** Mounts the scene with a verified bundle, iframe mounted but the runtime silent. */
async function mountMounted(overrides: Partial<AnimationSceneViewProps> = {}) {
  const reference = overrides.reference ?? LESSON_REF;
  loader.loadAnimation.mockResolvedValue(okResult(reference));
  const view = render(scene(overrides));
  await flush();
  return view;
}

/** The player that was handed to `playerRef`, other than the Fallback_Scene's and `null`. */
const sandboxPlayers = (): PlayerLike[] =>
  playerRef.mock.calls
    .map((call) => call[0])
    .filter((player): player is PlayerLike => player !== null && player !== fallbackPlayer);

// ---------------------------------------------------------------------------
// 1. From mount to loaded
// ---------------------------------------------------------------------------

describe("from mount to loaded", () => {
  it("loads the reference with an AbortSignal, shows only the Fallback_Scene and reports loading", async () => {
    loader.loadAnimation.mockReturnValue(new Promise(() => {}));
    render(scene());
    expect(loader.loadAnimation).toHaveBeenCalledTimes(1);
    const [reference, options] = loader.loadAnimation.mock.calls[0]!;
    expect(reference).toBe(LESSON_REF);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal.aborted).toBe(false);
    expect(hasFallback()).toBe(true);
    expect(iframe()).toBeNull();
    expect(statuses()).toEqual(["loading"]);
    expect(playerRef).toHaveBeenLastCalledWith(fallbackPlayer);
  });

  it("mounts the iframe hidden beside the still visible Fallback_Scene when the bundle is verified", async () => {
    await mountMounted();
    expect(iframe()).not.toBeNull();
    expect(iframe()!.style.visibility).toBe("hidden");
    expect(iframe()!.style.display).not.toBe("none");
    expect(hasFallback()).toBe(true);
    expect(lastStatus()).toBe("loading");
    // The runtime has not said ready, so nothing has been posted.
    expect(harness.posted()).toEqual([]);
  });

  it("answers ready with load: bundle, snake_case meta from the loader, contract version, origin *", async () => {
    await mountMounted();
    harness.ready();
    expect(sentOf("load")).toEqual([
      expect.objectContaining({
        bundle: BUNDLE,
        meta: {
          width: CONTRACT.canvas.width,
          height: CONTRACT.canvas.height,
          fps: CONTRACT.canvas.fps,
          duration_in_frames: DURATION,
        },
        contract_version: CONTRACT.contract_version,
      }),
    ]);
    expect(harness.targets()).toEqual(["*"]);
    expect(hasFallback()).toBe(true);
    expect(lastStatus()).toBe("loading");
  });

  it("puts pause_at_frame in load.meta for a puzzle reference", async () => {
    loader.loadAnimation.mockResolvedValue(okResult(PUZZLE_REF));
    render(scene({ reference: PUZZLE_REF }));
    await flush();
    harness.ready();
    expect(sentOf("load")[0]!.meta).toEqual(expect.objectContaining({ pause_at_frame: PAUSE }));
  });

  it("on loaded: shows the iframe once, drops the Fallback_Scene, hands over the sandbox player and sends setMode", async () => {
    await mountShown({ pacing: "fast" });
    expect(iframe()!.style.visibility).toBe("visible");
    expect(hasFallback()).toBe(false);
    expect(lastStatus()).toBe("paused");
    expect(sandboxPlayers()).toHaveLength(1);
    expect(playerRef).toHaveBeenLastCalledWith(sandboxPlayers()[0]);
    expect(sentOf("setMode")).toEqual([expect.objectContaining({ mode: "fast" })]);
  });

  it("follows frame, paused and ended messages with playing and paused", async () => {
    await mountShown();
    harness.frame(10, true);
    harness.frame(20, true);
    harness.frame(30, false);
    harness.frame(40, true);
    harness.paused("end", 209);
    harness.frame(50, true);
    harness.ended();
    expect(statuses()).toEqual([
      "loading",
      "paused",
      "playing",
      "paused",
      "playing",
      "paused",
      "playing",
      "paused",
    ]);
  });

  it("lets the PlayerBar listen to the sandbox player: frameupdate, play, pause and ended reach it", async () => {
    await mountShown();
    const events: string[] = [];
    const player = sandboxPlayers()[0]!;
    player.addEventListener("frameupdate", (event) => events.push(`frameupdate:${event.detail.frame}`));
    player.addEventListener("play", () => events.push("play"));
    player.addEventListener("pause", () => events.push("pause"));
    player.addEventListener("ended", () => events.push("ended"));
    harness.frame(10, true);
    harness.frame(20, true);
    harness.ended();
    expect(events).toEqual(["frameupdate:10", "play", "frameupdate:20", "pause", "ended"]);
  });

  it("sends the PlayerBar's commands to the iframe", async () => {
    await mountShown();
    const player = sandboxPlayers()[0]!;
    player.play();
    player.seekTo(0);
    player.pause();
    expect(sentTypes().slice(-3)).toEqual(["play", "seek", "pause"]);
  });

  it("ignores messages that do not come from its own iframe", async () => {
    await mountMounted();
    harness.ready();
    harness.deliver(harness.build("loaded", { duration_in_frames: DURATION }), { source: window });
    harness.deliver(harness.build("loaded", { duration_in_frames: DURATION }), { origin: "https://x.example" });
    expect(hasFallback()).toBe(true);
    expect(lastStatus()).toBe("loading");
  });
});

// ---------------------------------------------------------------------------
// 1b. The Stage's player
// ---------------------------------------------------------------------------

describe("a parent that passes a new playerRef function on every render", () => {
  it("does not hand the sandbox player over again, and clears it through the latest function", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const third = vi.fn();
    const view = await mountShown({ playerRef: first });
    const handedOver = first.mock.calls.length;
    expect(first).toHaveBeenLastCalledWith(sandboxPlayersOf(first)[0]);

    view.rerender(scene({ playerRef: second }));
    view.rerender(scene({ playerRef: third }));
    expect(first).toHaveBeenCalledTimes(handedOver);
    expect(second).not.toHaveBeenCalled();
    expect(third).not.toHaveBeenCalled();

    view.unmount();
    expect(third).toHaveBeenCalledTimes(1);
    expect(third).toHaveBeenCalledWith(null);
  });
});

const sandboxPlayersOf = (spy: { mock: { calls: unknown[][] } }): PlayerLike[] =>
  spy.mock.calls
    .map((call) => call[0] as PlayerLike | null)
    .filter((player): player is PlayerLike => player !== null && player !== fallbackPlayer);

// ---------------------------------------------------------------------------
// 2. Pacing
// ---------------------------------------------------------------------------

describe("pacing", () => {
  it("sends setMode with the new value without remounting the iframe", async () => {
    const view = await mountShown({ pacing: "animate" });
    const element = iframe();
    view.rerender(scene({ pacing: "fast" }));
    expect(iframe()).toBe(element);
    view.rerender(scene({ pacing: "animate" }));
    expect(iframe()).toBe(element);
    expect(sentOf("setMode").map((message) => message.mode)).toEqual(["animate", "fast", "animate"]);
    expect(sentOf("load")).toHaveLength(1);
  });

  it("sends the pacing of the moment on loaded when it changed while the iframe was hidden", async () => {
    const view = await mountMounted({ pacing: "animate" });
    harness.ready();
    view.rerender(scene({ pacing: "fast" }));
    harness.loaded(DURATION);
    expect(sentOf("setMode").map((message) => message.mode)).toEqual(["fast"]);
  });

  it("sends nothing about pacing before loaded", async () => {
    const view = await mountMounted({ pacing: "animate" });
    harness.ready();
    view.rerender(scene({ pacing: "fast" }));
    expect(sentOf("setMode")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Failure in each phase
// ---------------------------------------------------------------------------

type PhaseCase = { phase: AnimationPhaseName; trigger: () => Promise<void> };

/** Each way a scene can fail, by phase. Every trigger starts from a fresh mount. */
const PHASE_CASES: PhaseCase[] = [
  ...(["urls", "fetch", "integrity"] as const).map(
    (phase): PhaseCase => ({
      phase,
      trigger: async () => {
        loader.loadAnimation.mockResolvedValue({ ok: false, phase, reason: "network" });
        render(scene());
        await flush();
      },
    }),
  ),
  {
    phase: "load",
    trigger: async () => {
      await mountMounted();
      harness.ready();
      harness.error("load", "CONTRACT_INVALID");
    },
  },
  {
    phase: "runtime",
    trigger: async () => {
      await mountShown();
      harness.error("runtime", "RENDER_THROW");
    },
  },
  {
    phase: "timeout",
    trigger: async () => {
      loader.loadAnimation.mockReturnValue(new Promise(() => {}));
      render(scene());
      await advance(48000);
    },
  },
];

describe("a failure in each phase", () => {
  it.each(PHASE_CASES)("fails with phase $phase: Fallback_Scene back, one warning, no iframe", async ({ phase, trigger }) => {
    await trigger();
    expect(lastStatus()).toBe(`failed:${phase}`);
    expect(hasFallback()).toBe(true);
    expect(iframe()).toBeNull();
    expect(screen.getByTestId("animation-scene")).toBeInTheDocument();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(`animation failed:${phase}`);
    expect(warn.mock.calls[0]).toHaveLength(1);
    // The Stage's player is the Fallback_Scene's.
    expect(playerRef).toHaveBeenLastCalledWith(fallbackPlayer);
  });

  it("does not put a URL, bundle text or message in the warning", async () => {
    await PHASE_CASES[0]!.trigger();
    const text = String(warn.mock.calls[0]![0]);
    expect(text).toBe("animation failed:urls");
    expect(text).not.toContain(BUNDLE);
    expect(text).not.toMatch(/https?:/);
  });

  it("fails with phase timeout when the runtime never says ready (8000 ms)", async () => {
    await mountMounted();
    await advance(8000);
    expect(lastStatus()).toBe("failed:timeout");
    expect(hasFallback()).toBe(true);
    expect(iframe()).toBeNull();
    expect(warn).toHaveBeenCalledWith("animation failed:timeout");
  });

  it("fails with phase timeout when loaded does not follow load (8000 ms)", async () => {
    await mountMounted();
    harness.ready();
    await advance(8000);
    expect(lastStatus()).toBe("failed:timeout");
    expect(hasFallback()).toBe(true);
  });

  it("fails with phase timeout when the heartbeat stops after loaded (3000 ms)", async () => {
    await mountShown();
    expect(hasFallback()).toBe(false);
    await advance(3000);
    expect(lastStatus()).toBe("failed:timeout");
    expect(hasFallback()).toBe(true);
    expect(iframe()).toBeNull();
  });

  it("fails with phase load when loaded reports another duration", async () => {
    await mountMounted();
    harness.ready();
    harness.loaded(DURATION + 1);
    expect(lastStatus()).toBe("failed:load");
    expect(hasFallback()).toBe(true);
  });

  it("is still loading at 47999 ms and fails at 48000 ms when the loader never answers", async () => {
    loader.loadAnimation.mockReturnValue(new Promise(() => {}));
    render(scene());
    await advance(47999);
    expect(lastStatus()).toBe("loading");
    expect(warn).not.toHaveBeenCalled();
    await advance(1);
    expect(lastStatus()).toBe("failed:timeout");
    expect(loader.loadAnimation.mock.calls[0]![1].signal.aborted).toBe(true);
  });

  it("does not fail at 48000 ms once loaded has arrived", async () => {
    await mountShown();
    for (let elapsed = 0; elapsed < 48000; elapsed += 1000) {
      await advance(1000);
      harness.heartbeat();
    }
    expect(lastStatus()).toBe("paused");
    expect(hasFallback()).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("hands the player back to the Fallback_Scene in the commit that removes the iframe", async () => {
    await mountShown();
    const sandboxPlayer = sandboxPlayers()[0]!;
    const before = playerRef.mock.calls.length;
    harness.error("runtime");

    const calls = playerRef.mock.calls.slice(before).map((call) => call[0]);
    // The sandbox player is cleared first, the Fallback_Scene's player arrives last, and the Stage
    // is never left holding the old one.
    expect(calls.at(-1)).toBe(fallbackPlayer);
    expect(calls).not.toContain(sandboxPlayer);
    expect(calls.indexOf(null)).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf(null)).toBeLessThan(calls.lastIndexOf(fallbackPlayer));
    expect(hasFallback()).toBe(true);
  });

  it("releases the listeners of the sandbox player and ignores its commands after a failure", async () => {
    await mountShown();
    const player = sandboxPlayers()[0]!;
    const frameupdate = vi.fn();
    player.addEventListener("frameupdate", frameupdate);
    harness.error("runtime");
    const posted = harness.posted().length;
    player.play();
    player.seekTo(5);
    expect(harness.posted()).toHaveLength(posted);
    expect(frameupdate).not.toHaveBeenCalled();
  });

  it("never gives the Stage a sandbox player when the failure comes before loaded", async () => {
    await PHASE_CASES[3]!.trigger();
    expect(sandboxPlayers()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. After a failure
// ---------------------------------------------------------------------------

describe("after a failure", () => {
  it("ignores every later message and timer, and warns only once", async () => {
    await mountShown();
    harness.error("runtime");
    expect(warn).toHaveBeenCalledTimes(1);

    harness.frame(10, true);
    harness.paused("interaction", PAUSE);
    harness.ended();
    harness.error("load");
    harness.ready();
    await advance(60000);

    expect(lastStatus()).toBe("failed:runtime");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(hasFallback()).toBe(true);
    expect(iframe()).toBeNull();
  });

  it("does not let a late loader result or the 48000 ms timer change a failed scene", async () => {
    let resolveLoad!: (result: LoadResult) => void;
    loader.loadAnimation.mockReturnValue(new Promise<LoadResult>((resolve) => (resolveLoad = resolve)));
    render(scene());
    await advance(48000);
    expect(lastStatus()).toBe("failed:timeout");

    resolveLoad(okResult(LESSON_REF));
    await flush();
    expect(iframe()).toBeNull();
    expect(lastStatus()).toBe("failed:timeout");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("never retries by itself: one load call for the whole mount", async () => {
    loader.loadAnimation.mockResolvedValue({ ok: false, phase: "fetch", reason: "network" });
    render(scene());
    await flush();
    await advance(120000);
    expect(loader.loadAnimation).toHaveBeenCalledTimes(1);
  });

  it("calls resume or setMode for nothing once failed, whatever the props do", async () => {
    const view = await mountShown({ reference: PUZZLE_REF });
    harness.error("runtime");
    const posted = harness.posted().length;
    view.rerender(scene({ reference: PUZZLE_REF, pacing: "fast", answerCorrect: true }));
    expect(harness.posted()).toHaveLength(posted);
  });
});

// ---------------------------------------------------------------------------
// 5. resume
// ---------------------------------------------------------------------------

describe("resume", () => {
  const resumes = () => sentOf("resume");

  it("sends nothing for a wrong answer, however many pauses", async () => {
    const view = await mountShown({ reference: PUZZLE_REF, answerCorrect: false });
    harness.paused("interaction", PAUSE);
    view.rerender(scene({ reference: PUZZLE_REF, answerCorrect: false, pacing: "fast" }));
    harness.paused("interaction", PAUSE);
    expect(resumes()).toEqual([]);
  });

  it("sends nothing for a lesson, which has no answer", async () => {
    await mountShown();
    harness.frame(10, true);
    harness.paused("end", DURATION - 1);
    expect(resumes()).toEqual([]);
  });

  it("resumes once when the answer turns correct while the animation waits at the question", async () => {
    const view = await mountShown({ reference: PUZZLE_REF, answerCorrect: false });
    harness.paused("interaction", PAUSE);
    expect(resumes()).toEqual([]);
    view.rerender(scene({ reference: PUZZLE_REF, answerCorrect: true }));
    expect(resumes()).toHaveLength(1);
    // The same pause is not resumed again, by a render or by a flip of the answer.
    view.rerender(scene({ reference: PUZZLE_REF, answerCorrect: true }));
    view.rerender(scene({ reference: PUZZLE_REF, answerCorrect: false }));
    view.rerender(scene({ reference: PUZZLE_REF, answerCorrect: true }));
    expect(resumes()).toHaveLength(1);
  });

  it("resumes at the pause when the answer was already correct before loaded", async () => {
    await mountShown({ reference: PUZZLE_REF, answerCorrect: true });
    expect(resumes()).toEqual([]);
    harness.paused("interaction", PAUSE);
    expect(resumes()).toHaveLength(1);
  });

  it("resumes at the pause when the answer turned correct before the pause was reached", async () => {
    const view = await mountShown({ reference: PUZZLE_REF, answerCorrect: false });
    harness.frame(30, true);
    view.rerender(scene({ reference: PUZZLE_REF, answerCorrect: true }));
    expect(resumes()).toEqual([]);
    harness.frame(120, true);
    harness.paused("interaction", PAUSE);
    expect(resumes()).toHaveLength(1);
  });

  it("resumes again after setMode made the runtime pause a second time", async () => {
    const view = await mountShown({ reference: PUZZLE_REF, answerCorrect: true, pacing: "animate" });
    harness.paused("interaction", PAUSE);
    expect(resumes()).toHaveLength(1);

    view.rerender(scene({ reference: PUZZLE_REF, answerCorrect: true, pacing: "fast" }));
    expect(resumes()).toHaveLength(1);
    harness.paused("interaction", PAUSE);
    expect(resumes()).toHaveLength(2);
  });

  it("does not resume for a pause whose reason is end", async () => {
    await mountShown({ reference: PUZZLE_REF, answerCorrect: true });
    harness.paused("end", DURATION - 1);
    expect(resumes()).toEqual([]);
  });

  it("sends resume with the live Session_Id after the pause, never before", async () => {
    await mountShown({ reference: PUZZLE_REF, answerCorrect: true });
    const before = sentTypes().length;
    harness.paused("interaction", PAUSE);
    const afterPause = sentTypes().slice(before);
    expect(afterPause).toEqual(["resume"]);
    expect(sentOf("resume")[0]!.session).toBe(harness.session());
  });
});

// ---------------------------------------------------------------------------
// 6. Unmount
// ---------------------------------------------------------------------------

describe("unmount", () => {
  it("before the loader answers: aborts the signal, warns about nothing, and ignores the late result", async () => {
    let resolveLoad!: (result: LoadResult) => void;
    loader.loadAnimation.mockReturnValue(new Promise<LoadResult>((resolve) => (resolveLoad = resolve)));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = render(scene());
    const signal = loader.loadAnimation.mock.calls[0]![1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    view.unmount();
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    resolveLoad(okResult(LESSON_REF));
    await flush();
    await advance(60000);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(iframe()).toBeNull();
    expect(statuses()).toEqual(["loading"]);
  });

  it("before the loader fails: no warning for a result nobody waits for", async () => {
    let resolveLoad!: (result: LoadResult) => void;
    loader.loadAnimation.mockReturnValue(new Promise<LoadResult>((resolve) => (resolveLoad = resolve)));
    const view = render(scene());
    view.unmount();
    resolveLoad({ ok: false, phase: "urls", reason: "aborted" });
    await flush();
    expect(warn).not.toHaveBeenCalled();
    expect(statuses()).toEqual(["loading"]);
  });

  it("while the hidden iframe waits: no warning, no timer, no message afterwards", async () => {
    const view = await mountMounted();
    harness.ready();
    const posted = harness.posted().length;
    view.unmount();
    expect(iframe()).toBeNull();
    harness.loaded(DURATION);
    harness.error("runtime");
    await advance(60000);
    expect(warn).not.toHaveBeenCalled();
    expect(harness.posted()).toHaveLength(posted);
    expect(vi.getTimerCount()).toBe(0);
    expect(statuses()).toEqual(["loading"]);
  });

  it("while the animation is shown: clears the Stage's player and posts nothing afterwards", async () => {
    const view = await mountShown({ reference: PUZZLE_REF, answerCorrect: true });
    const posted = harness.posted().length;
    view.unmount();
    expect(playerRef).toHaveBeenLastCalledWith(null);
    harness.paused("interaction", PAUSE);
    harness.frame(1, true);
    await advance(60000);
    expect(harness.posted()).toHaveLength(posted);
    expect(warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the Stage's player when the Fallback_Scene unmounts", async () => {
    loader.loadAnimation.mockReturnValue(new Promise(() => {}));
    const view = render(scene());
    expect(playerRef).toHaveBeenLastCalledWith(fallbackPlayer);
    view.unmount();
    expect(playerRef).toHaveBeenLastCalledWith(null);
  });

  it("a new mount loads again and uses a new Session_Id", async () => {
    const first = await mountShown();
    const oldSession = harness.session();
    first.unmount();
    harness.fakeWindow.postMessage.mockClear();

    loader.loadAnimation.mockResolvedValue(okResult(LESSON_REF));
    render(scene());
    await flush();
    expect(loader.loadAnimation).toHaveBeenCalledTimes(2);
    harness.ready();
    expect(harness.session()).not.toBe(oldSession);
  });
});

// ---------------------------------------------------------------------------
// 7. Error boundary, StrictMode, renderFallback and the no-Remotion rule
// ---------------------------------------------------------------------------

describe("the error boundary", () => {
  it("turns an exception while rendering the frame into failed:runtime with the Fallback_Scene", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(() => {
      throw new Error("no entropy");
    });
    loader.loadAnimation.mockResolvedValue(okResult(LESSON_REF));
    render(scene());
    await flush();
    expect(lastStatus()).toBe("failed:runtime");
    expect(hasFallback()).toBe(true);
    expect(iframe()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("animation failed:runtime");
    expect(error).toHaveBeenCalled(); // React logs a caught error
    expect(playerRef).toHaveBeenLastCalledWith(fallbackPlayer);
  });

  it("an unexpected rejection of the loader is failed:runtime, never an unhandled rejection", async () => {
    loader.loadAnimation.mockRejectedValue(new Error("boom"));
    render(scene());
    await flush();
    expect(lastStatus()).toBe("failed:runtime");
    expect(hasFallback()).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("React StrictMode", () => {
  it("runs the whole flow with one load message, one setMode and one warning on failure", async () => {
    loader.loadAnimation.mockResolvedValue(okResult(LESSON_REF));
    render(<StrictMode>{scene()}</StrictMode>);
    await flush();
    harness.ready();
    harness.loaded(DURATION);
    expect(sentOf("load")).toHaveLength(1);
    expect(sentOf("setMode")).toHaveLength(1);
    expect(hasFallback()).toBe(false);
    expect(lastStatus()).toBe("paused");

    harness.error("runtime");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(lastStatus()).toBe("failed:runtime");
    expect(hasFallback()).toBe(true);
  });
});

describe("a page that is hidden and shown again (cacheComponents keeps it mounted)", () => {
  it("does not warn a second time for a failure that happened before it was hidden", async () => {
    loader.loadAnimation.mockResolvedValue({ ok: false, phase: "fetch", reason: "network" });
    const view = render(<Activity mode="visible">{scene()}</Activity>);
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);

    view.rerender(<Activity mode="hidden">{scene()}</Activity>);
    view.rerender(<Activity mode="visible">{scene()}</Activity>);
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(lastStatus()).toBe("failed:fetch");
    expect(hasFallback()).toBe(true);
  });
});

describe("the renderFallback contract", () => {
  it("passes the playerRef prop itself, so the Fallback_Scene feeds the Stage's player directly", () => {
    loader.loadAnimation.mockReturnValue(new Promise(() => {}));
    const given: Array<(player: PlayerLike | null) => void> = [];
    render(
      scene({
        renderFallback: (ref) => {
          given.push(ref);
          return null;
        },
      }),
    );
    expect(given.length).toBeGreaterThan(0);
    expect(given.every((ref) => ref === playerRef)).toBe(true);
  });

  it("gives a function that does nothing when there is no playerRef", () => {
    loader.loadAnimation.mockReturnValue(new Promise(() => {}));
    let given: ((player: PlayerLike | null) => void) | undefined;
    render(
      scene({
        playerRef: undefined,
        renderFallback: (ref) => {
          given = ref;
          return null;
        },
      }),
    );
    expect(typeof given).toBe("function");
    expect(() => given!(fallbackPlayer)).not.toThrow();
  });

  it("renders the Fallback_Scene exactly as renderFallback returns it, inside the scene box", () => {
    loader.loadAnimation.mockReturnValue(new Promise(() => {}));
    render(scene({ renderFallback: () => <p data-testid="custom-fallback">drawn by the Stage</p> }));
    expect(screen.getByTestId("animation-scene")).toContainElement(screen.getByTestId("custom-fallback"));
  });
});

describe("what the scene must not import", () => {
  const read = (relative: string) =>
    readFileSync(join(__dirname, "..", "..", "src", relative), "utf8");

  it.each([
    "components/animation/AnimationScene.tsx",
    "components/animation/SandboxFrame.tsx",
    "lib/animation/scene-status.ts",
  ])("%s has no import from @remotion/player and none of the game engine", (file) => {
    const source = read(file);
    expect(source).not.toMatch(/from\s+["']@remotion\/player["']/);
    expect(source).not.toMatch(/from\s+["']@\/lib\/game\//);
    expect(source).not.toMatch(/validateMultipleChoice/);
  });
});
