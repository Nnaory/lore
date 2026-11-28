/**
 * Tests: scene-status.ts (task 27.1), design 7.6 and K-7, Requirements 30.15, 31.1, 31.10, 31.11.
 *
 * The reducer is pure, so every test feeds it actions and reads the state back:
 *
 *   1. the happy path: loading, mounted, shown, and the status after each message;
 *   2. failure: every phase, and that a failed scene never changes again;
 *   3. the 48000 ms timeout: it fails only a scene that is still `loading`;
 *   4. `pauseEpisode` and `resumeDue` (resume once per pause, only for a correct answer);
 *   5. `loadMetaOf` (camelCase `AnimationMeta` to snake_case `load.meta`);
 *   6. a property over random action streams: the status always matches the stage, and `failed`
 *      is final.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AnimationMeta } from "@/lib/animation/loader";
import { LoadMetaSchema } from "@/lib/animation/protocol";
import {
  INITIAL_SCENE_STATE,
  LOADING_TIMEOUT_MS,
  fallbackVisible,
  iframeMounted,
  loadMetaOf,
  reduceScene,
  resumeDue,
  type AnimationPhaseName,
  type SceneAction,
  type SceneState,
} from "@/lib/animation/scene-status";

const PHASES: AnimationPhaseName[] = ["urls", "fetch", "integrity", "load", "runtime", "timeout"];

function run(actions: SceneAction[], from: SceneState = INITIAL_SCENE_STATE): SceneState {
  return actions.reduce(reduceScene, from);
}

const shown = (): SceneState => run([{ type: "loader_ok" }, { type: "loaded" }]);

describe("the happy path", () => {
  it("starts loading with the Fallback_Scene and no iframe", () => {
    expect(INITIAL_SCENE_STATE).toEqual({
      stage: "loading",
      status: "loading",
      failure: null,
      pauseEpisode: 0,
    });
    expect(fallbackVisible(INITIAL_SCENE_STATE)).toBe(true);
    expect(iframeMounted(INITIAL_SCENE_STATE)).toBe(false);
    expect(LOADING_TIMEOUT_MS).toBe(48000);
  });

  it("mounts the iframe after the loader, keeps the status loading and the Fallback_Scene", () => {
    const state = run([{ type: "loader_ok" }]);
    expect(state).toMatchObject({ stage: "mounted", status: "loading" });
    expect(iframeMounted(state)).toBe(true);
    expect(fallbackVisible(state)).toBe(true);
  });

  it("shows the iframe on loaded: status paused, Fallback_Scene gone", () => {
    const state = shown();
    expect(state).toMatchObject({ stage: "shown", status: "paused" });
    expect(iframeMounted(state)).toBe(true);
    expect(fallbackVisible(state)).toBe(false);
  });

  it("follows frame, paused and ended once shown", () => {
    const playing = reduceScene(shown(), { type: "frame", playing: true });
    expect(playing.status).toBe("playing");
    expect(reduceScene(playing, { type: "frame", playing: false }).status).toBe("paused");
    expect(reduceScene(playing, { type: "paused", reason: "end" }).status).toBe("paused");
    expect(reduceScene(playing, { type: "ended" }).status).toBe("paused");
  });

  it("returns the same object when nothing changes, so frame messages do not re-render", () => {
    const playing = reduceScene(shown(), { type: "frame", playing: true });
    expect(reduceScene(playing, { type: "frame", playing: true })).toBe(playing);
    const idle = shown();
    expect(reduceScene(idle, { type: "frame", playing: false })).toBe(idle);
    expect(reduceScene(idle, { type: "ended" })).toBe(idle);
  });

  it("ignores loaded, frame, paused and ended before the iframe has said loaded", () => {
    const before = INITIAL_SCENE_STATE;
    const mounted = run([{ type: "loader_ok" }]);
    const messages: SceneAction[] = [
      { type: "loaded" },
      { type: "frame", playing: true },
      { type: "paused", reason: "interaction" },
      { type: "ended" },
    ];
    for (const message of messages) {
      expect(reduceScene(before, message)).toBe(before);
    }
    for (const message of messages.slice(1)) {
      expect(reduceScene(mounted, message)).toBe(mounted);
    }
  });

  it("ignores a second loader_ok and a second loaded", () => {
    const state = shown();
    expect(reduceScene(state, { type: "loader_ok" })).toBe(state);
    expect(reduceScene(state, { type: "loaded" })).toBe(state);
  });
});

describe("failure", () => {
  it.each(PHASES)("fails with phase %s from loading, mounted and shown", (phase) => {
    for (const from of [INITIAL_SCENE_STATE, run([{ type: "loader_ok" }]), shown()]) {
      const state = reduceScene(from, { type: "fail", phase });
      expect(state).toMatchObject({ stage: "failed", status: `failed:${phase}`, failure: phase });
      expect(iframeMounted(state)).toBe(false);
      expect(fallbackVisible(state)).toBe(true);
    }
  });

  it("never changes after a failure, whatever arrives", () => {
    const state = reduceScene(shown(), { type: "fail", phase: "runtime" });
    const later: SceneAction[] = [
      { type: "loader_ok" },
      { type: "loaded" },
      { type: "frame", playing: true },
      { type: "paused", reason: "interaction" },
      { type: "ended" },
      { type: "timeout" },
      { type: "fail", phase: "urls" },
    ];
    for (const action of later) expect(reduceScene(state, action)).toBe(state);
  });
});

describe("the 48000 ms timeout", () => {
  it("fails a scene that is still loading, with or without the iframe mounted", () => {
    expect(reduceScene(INITIAL_SCENE_STATE, { type: "timeout" })).toMatchObject({
      stage: "failed",
      status: "failed:timeout",
    });
    expect(reduceScene(run([{ type: "loader_ok" }]), { type: "timeout" })).toMatchObject({
      stage: "failed",
      status: "failed:timeout",
    });
  });

  it("does nothing once the iframe is shown", () => {
    const state = shown();
    expect(reduceScene(state, { type: "timeout" })).toBe(state);
    const playing = reduceScene(state, { type: "frame", playing: true });
    expect(reduceScene(playing, { type: "timeout" })).toBe(playing);
  });
});

describe("pause episodes and resumeDue", () => {
  const paused = (state: SceneState) => reduceScene(state, { type: "paused", reason: "interaction" });

  it("counts only pauses with reason interaction", () => {
    let state = shown();
    state = reduceScene(state, { type: "paused", reason: "end" });
    expect(state.pauseEpisode).toBe(0);
    state = paused(state);
    expect(state.pauseEpisode).toBe(1);
    state = paused(reduceScene(state, { type: "frame", playing: true }));
    expect(state.pauseEpisode).toBe(2);
  });

  it("is due only for a correct answer and an episode that was not resumed", () => {
    const state = paused(shown());
    expect(resumeDue(state, true, 0)).toBe(true);
    expect(resumeDue(state, true, 1)).toBe(false);
    expect(resumeDue(state, false, 0)).toBe(false);
    expect(resumeDue(state, undefined, 0)).toBe(false);
  });

  it("is not due before the pause is reached, and is due again after a new pause", () => {
    const state = shown();
    expect(resumeDue(state, true, 0)).toBe(false);
    const again = paused(reduceScene(paused(state), { type: "frame", playing: true }));
    expect(resumeDue(again, true, 1)).toBe(true);
  });

  it("is never due outside the shown stage", () => {
    const failed = reduceScene(paused(shown()), { type: "fail", phase: "timeout" });
    expect(resumeDue(failed, true, 0)).toBe(false);
    expect(resumeDue(INITIAL_SCENE_STATE, true, -1)).toBe(false);
  });
});

describe("loadMetaOf", () => {
  const lesson: AnimationMeta = { width: 1280, height: 720, fps: 30, durationInFrames: 210 };

  it("renames durationInFrames and leaves out pause_at_frame for a lesson", () => {
    const meta = loadMetaOf(lesson);
    expect(meta).toEqual({ width: 1280, height: 720, fps: 30, duration_in_frames: 210 });
    expect("pause_at_frame" in meta).toBe(false);
    expect(LoadMetaSchema.safeParse(meta).success).toBe(true);
  });

  it("renames pauseAtFrame for a puzzle", () => {
    const meta = loadMetaOf({ ...lesson, pauseAtFrame: 150 });
    expect(meta).toEqual({
      width: 1280,
      height: 720,
      fps: 30,
      duration_in_frames: 210,
      pause_at_frame: 150,
    });
    expect(LoadMetaSchema.safeParse(meta).success).toBe(true);
  });
});

describe("property: any action stream", () => {
  const action: fc.Arbitrary<SceneAction> = fc.oneof(
    fc.constant<SceneAction>({ type: "loader_ok" }),
    fc.constantFrom(...PHASES).map((phase): SceneAction => ({ type: "fail", phase })),
    fc.constant<SceneAction>({ type: "timeout" }),
    fc.constant<SceneAction>({ type: "loaded" }),
    fc.boolean().map((playing): SceneAction => ({ type: "frame", playing })),
    fc.constantFrom("interaction", "end").map((reason): SceneAction => ({ type: "paused", reason })),
    fc.constant<SceneAction>({ type: "ended" }),
  );

  it("keeps the status in step with the stage, and failed is final", () => {
    fc.assert(
      fc.property(fc.array(action, { maxLength: 40 }), (actions) => {
        let state = INITIAL_SCENE_STATE;
        let episodes = 0;
        for (const next of actions) {
          const before = state;
          state = reduceScene(state, next);
          // The count of pauses never goes down.
          expect(state.pauseEpisode).toBeGreaterThanOrEqual(episodes);
          episodes = state.pauseEpisode;
          if (before.stage === "failed") expect(state).toBe(before);
          if (state.stage === "loading" || state.stage === "mounted") {
            expect(state.status).toBe("loading");
          }
          if (state.stage === "shown") expect(["playing", "paused"]).toContain(state.status);
          if (state.stage === "failed") {
            expect(state.status).toBe(`failed:${state.failure}`);
          } else {
            expect(state.failure).toBeNull();
          }
        }
        // Playing and paused only appear while the iframe is shown; the Fallback_Scene is on
        // screen exactly when it is not.
        expect(fallbackVisible(state)).toBe(state.stage !== "shown");
      }),
    );
  });
});
