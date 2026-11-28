/**
 * scene-status.ts: the status of one Animation_Scene as a pure reducer (design 7.6, K-7,
 * Requirements 30.5, 30.6, 31.1, 31.8, 31.10, 31.11).
 *
 * An Animation_Scene shows the Fallback_Scene (the JSON visual that already exists) until the
 * sandboxed animation is ready, and again whenever the animation fails. Which of the two is on
 * screen, which status the Stage reports (`data-animation-status`), and whether the player has
 * answered the question the animation is paused on, are all decided here, so the React component
 * stays a thin shell around it and the rules can be tested without a DOM or a clock.
 *
 * Stage of the scene (what is on screen):
 * - `loading`: the bundle is being fetched. Fallback_Scene only.
 * - `mounted`: the bundle is verified and the iframe is mounted but `visibility: hidden`, while
 *   the Fallback_Scene is still shown. The status is still `loading`.
 * - `shown`: the iframe answered `loaded`. The iframe is shown, the Fallback_Scene is gone.
 * - `failed`: something failed. The iframe is gone, the Fallback_Scene is shown again. Final:
 *   nothing that arrives afterwards changes the state (Requirement 31.11).
 *
 * Status the Stage sees (`AnimationStatus`): `loading` from mount until `loaded` (the Sandbox_Frame's
 * own `ready` is folded into it, K-7), `paused` right after `loaded`, `playing` while the last
 * `frame` message says so, `paused` after `paused`, `ended` or a `frame` that is not playing, and
 * `failed:<phase>` for good after a failure. "Playing" and "paused" are only reported while the
 * iframe is shown, never for a Fallback_Scene.
 *
 * `pauseEpisode` counts the `paused` messages with reason `interaction`. The component sends
 * `resume` once for each episode, when the answer is correct (`resumeDue`). Counting episodes is
 * what makes "once per pause" hold when the answer was already right before `loaded`, before the
 * pause was reached, or after a `setMode` made the runtime pause again (Requirement 30.15).
 *
 * Nothing here trusts message content beyond the fields the Sandbox_Protocol already validated.
 * A message can move the status, but it can never touch HP, score or `isCorrect`: those live in the
 * game engine, which this module does not import (Requirement 30.17). `loadMetaOf` is the one
 * helper that is not about status: it turns the loader's camelCase `AnimationMeta` into the
 * snake_case `load.meta` of the protocol. Type-only imports, no React, no DOM.
 */

import type { AnimationMeta } from "./loader";
import type { LoadMeta } from "./protocol";

/** Where a failure happened. The first three are loader phases, the last three sandbox phases. */
export type AnimationPhaseName = "urls" | "fetch" | "integrity" | "load" | "runtime" | "timeout";

/** What `data-animation-status` carries for an `animation` scene (Requirement 31.3). */
export type AnimationStatus = "loading" | "playing" | "paused" | `failed:${AnimationPhaseName}`;

/** Time from mount after which a scene that is still `loading` gives up (Requirement 31.11). */
export const LOADING_TIMEOUT_MS = 48000;

export type SceneStage = "loading" | "mounted" | "shown" | "failed";

export interface SceneState {
  readonly stage: SceneStage;
  readonly status: AnimationStatus;
  /** Phase of the failure, or `null` while the scene has not failed. */
  readonly failure: AnimationPhaseName | null;
  /** Number of `paused` messages with reason `interaction` received while the iframe is shown. */
  readonly pauseEpisode: number;
}

export const INITIAL_SCENE_STATE: SceneState = {
  stage: "loading",
  status: "loading",
  failure: null,
  pauseEpisode: 0,
};

export type SceneAction =
  /** The loader returned a verified bundle: mount the (hidden) iframe. */
  | { type: "loader_ok" }
  | { type: "fail"; phase: AnimationPhaseName }
  /** The 48000 ms timer fired. Fails the scene only if it is still `loading`. */
  | { type: "timeout" }
  | { type: "loaded" }
  | { type: "frame"; playing: boolean }
  | { type: "paused"; reason: "interaction" | "end" }
  | { type: "ended" };

function failed(state: SceneState, phase: AnimationPhaseName): SceneState {
  return { ...state, stage: "failed", status: `failed:${phase}`, failure: phase };
}

function withStatus(state: SceneState, status: AnimationStatus): SceneState {
  return state.status === status ? state : { ...state, status };
}

/**
 * Next state. Total and pure; returns `state` itself when nothing changes, so a stream of `frame`
 * messages that keep the same status does not re-render the scene.
 */
export function reduceScene(state: SceneState, action: SceneAction): SceneState {
  if (state.stage === "failed") return state;
  switch (action.type) {
    case "loader_ok":
      return state.stage === "loading" ? { ...state, stage: "mounted" } : state;
    case "fail":
      return failed(state, action.phase);
    case "timeout":
      return state.status === "loading" ? failed(state, "timeout") : state;
    case "loaded":
      return state.stage === "mounted" ? { ...state, stage: "shown", status: "paused" } : state;
    case "frame":
      return state.stage === "shown" ? withStatus(state, action.playing ? "playing" : "paused") : state;
    case "paused":
      if (state.stage !== "shown") return state;
      return {
        ...state,
        status: "paused",
        pauseEpisode: action.reason === "interaction" ? state.pauseEpisode + 1 : state.pauseEpisode,
      };
    case "ended":
      return state.stage === "shown" ? withStatus(state, "paused") : state;
  }
}

/** True while the iframe element exists (hidden or shown). */
export function iframeMounted(state: SceneState): boolean {
  return state.stage === "mounted" || state.stage === "shown";
}

/** True while the Fallback_Scene is rendered: everything except `shown`. */
export function fallbackVisible(state: SceneState): boolean {
  return state.stage !== "shown";
}

/**
 * Whether `resume` must be sent now: the iframe is shown, the answer is correct, and the current
 * pause (`pauseEpisode`) has not been resumed yet (`resumedEpisode` is the last one that was).
 * A wrong answer, or no answer yet, never resumes.
 */
export function resumeDue(
  state: SceneState,
  answerCorrect: boolean | undefined,
  resumedEpisode: number,
): boolean {
  return state.stage === "shown" && answerCorrect === true && state.pauseEpisode > resumedEpisode;
}

/** `load.meta` of the protocol from the loader's `AnimationMeta`; no `pause_at_frame` for a lesson. */
export function loadMetaOf(meta: AnimationMeta): LoadMeta {
  const out: LoadMeta = {
    width: meta.width,
    height: meta.height,
    fps: meta.fps,
    duration_in_frames: meta.durationInFrames,
  };
  if (meta.pauseAtFrame !== undefined) out.pause_at_frame = meta.pauseAtFrame;
  return out;
}
