/**
 * AnimationScene: plays an AI-written animation in the Stage canvas and falls back to the existing
 * JSON visual whenever it cannot (design 7.6, K-7, Requirements 30.5, 30.6, 30.9, 30.10, 30.15,
 * 30.16, 31.1, 31.4 to 31.6, 31.8, 31.10 to 31.13).
 *
 * Why it exists. A story can point at an animation (`AnimationReference`), but the animation is
 * code that has to be downloaded, checked and run in a sandbox, and any step can fail. The player
 * must never see a broken canvas, so this component always has something to show: the
 * Fallback_Scene, which the caller renders with `renderFallback` and which is exactly the scene the
 * Stage would draw if there were no reference (Requirement 31.2). The animation replaces it only
 * after the sandbox says `loaded`, and the Fallback_Scene comes back on any failure.
 *
 * What happens, in order:
 * 1. At mount `loadAnimation` runs, with an `AbortSignal` that unmounting aborts. A failed load is
 *    the failure `urls`, `fetch` or `integrity`. A 48000 ms timer starts at the same time: if the
 *    scene is still `loading` when it fires, the scene fails with `timeout`.
 * 2. A verified bundle mounts a `SandboxFrame` with `visibility: hidden`, in the same box as the
 *    Fallback_Scene, which stays on screen. The loader's camelCase `AnimationMeta` becomes the
 *    snake_case `load.meta` here (`loadMetaOf`).
 * 3. `loaded` shows the iframe and stops rendering the Fallback_Scene. The sandbox player ref goes
 *    to `playerRef` (the Stage's PlayerBar reads it) and the current pacing is sent with `setMode`.
 *    From then on `frame` messages move the status between `playing` and `paused`.
 * 4. A change of `pacing` while the iframe is shown sends `setMode` again. The iframe is not
 *    remounted: the runtime remounts its own Player.
 * 5. When the runtime pauses at the question (`paused`, reason `interaction`) and the answer is
 *    already correct, or becomes correct later, `resume` is sent once for that pause. A wrong
 *    answer sends nothing.
 * 6. A failure (load, a sandbox `error`, a watchdog, the 48000 ms timer, the error boundary)
 *    removes the iframe and renders the Fallback_Scene again, and `playerRef` goes back to the
 *    Fallback_Scene's player in the same commit, so the PlayerBar never points at a dead player.
 *    One `console.warn("animation failed:<phase>")` is written per mount, with no URL, bundle or
 *    message text. A failed scene never retries by itself; a new mount loads again.
 * 7. An error boundary around the frame turns anything it throws into the failure `runtime`.
 *
 * Handing over the player. The Fallback_Scene's own `ref` callback (the `playerRef` prop, passed to
 * `renderFallback`) owns the Stage's player while the Fallback_Scene is on screen. When the iframe
 * is shown, a layout effect gives it the sandbox ref after React has detached the Fallback_Scene's
 * (detaching happens first), and when the scene fails, the effect's cleanup clears it before React
 * attaches the new Fallback_Scene's. That order is why the Stage never sees the old player after
 * the new one.
 *
 * Pure parts (the stage and status rules, `resumeDue`, the meta conversion) are in
 * `lib/animation/scene-status.ts`. Nothing here reads or changes HP, score or `isCorrect`: the only
 * game input is the `answerCorrect` flag the Stage passes in, and no message from the iframe
 * reaches the game engine (Requirement 30.17). No `@remotion/player` import: the Fallback_Scene is
 * rendered by the caller.
 */

"use client";

import {
  Component,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { SandboxFrame } from "@/components/animation/SandboxFrame";
import { CONTRACT } from "@/lib/animation/contract";
import { loadAnimation } from "@/lib/animation/loader";
import type { FrameMessage, LoadMeta } from "@/lib/animation/protocol";
import type { SandboxFailPhase } from "@/lib/animation/sandbox-controller";
import type { SandboxPlayerRefHandle } from "@/lib/animation/sandbox-player-ref";
import {
  INITIAL_SCENE_STATE,
  LOADING_TIMEOUT_MS,
  fallbackVisible,
  iframeMounted,
  loadMetaOf,
  reduceScene,
  resumeDue,
  type AnimationStatus,
} from "@/lib/animation/scene-status";
import type { PlayerLike } from "@/lib/stage/player-like";
import type { Pacing } from "@/lib/story/pacing";
import type { AnimationReference } from "@/lib/types/animation";

export type { AnimationPhaseName, AnimationStatus } from "@/lib/animation/scene-status";

export type AnimationSceneViewProps = {
  reference: AnimationReference;
  pacing: Pacing;
  /** `interaction.isCorrect` of the puzzle the animation belongs to; `undefined` for a lesson. */
  answerCorrect?: boolean;
  /** Receives the player the PlayerBar should drive: the sandbox's, or the Fallback_Scene's. */
  playerRef?: (player: PlayerLike | null) => void;
  /** Called with the status at mount and each time it changes. */
  onStatus: (status: AnimationStatus) => void;
  /** Renders the Fallback_Scene; pass `ref` to its Remotion `Player` as the `ref` callback. */
  renderFallback: (ref: (player: PlayerLike | null) => void) => ReactNode;
};

/** What the sandbox needs, taken from the loader's result once. */
type SandboxInput = { bundle: string; meta: LoadMeta };

/** Catches anything the frame throws while rendering or in its effects: the failure `runtime`. */
class SandboxBoundary extends Component<
  { onError: () => void; children: ReactNode },
  { crashed: boolean }
> {
  state = { crashed: false };

  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true };
  }

  componentDidCatch(): void {
    this.props.onError();
  }

  render(): ReactNode {
    return this.state.crashed ? null : this.props.children;
  }
}

const NO_PLAYER_REF = (): void => {};

export function AnimationScene({
  reference,
  pacing,
  answerCorrect,
  playerRef,
  onStatus,
  renderFallback,
}: AnimationSceneViewProps) {
  const [state, dispatch] = useReducer(reduceScene, INITIAL_SCENE_STATE);
  const [input, setInput] = useState<SandboxInput | null>(null);
  /** The player ref made by the mounted SandboxFrame (null until it is mounted). */
  const sandbox = useRef<SandboxPlayerRefHandle | null>(null);
  /** Last pause episode `resume` was sent for. */
  const resumedEpisode = useRef(0);
  const warned = useRef(false);

  const shown = state.stage === "shown";

  // 1. Load the bundle; give up after 48000 ms if the scene is still loading.
  useEffect(() => {
    const controller = new AbortController();
    loadAnimation(reference, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (!result.ok) {
          dispatch({ type: "fail", phase: result.phase });
          return;
        }
        setInput((previous) => previous ?? { bundle: result.bundle, meta: loadMetaOf(result.meta) });
        dispatch({ type: "loader_ok" });
      })
      .catch(() => {
        // `loadAnimation` never rejects; an unexpected exception is a runtime fault.
        if (!controller.signal.aborted) dispatch({ type: "fail", phase: "runtime" });
      });
    const timer = window.setTimeout(() => {
      // Only a scene that is still loading fails; the abort then also stops a late download.
      controller.abort();
      dispatch({ type: "timeout" });
    }, LOADING_TIMEOUT_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [reference]);

  // Report the status at mount and on every change.
  const reportStatus = useEffectEvent((status: AnimationStatus) => onStatus(status));
  useEffect(() => {
    reportStatus(state.status);
  }, [state.status]);

  // 6. One warning per mount, whatever the phase and however many failures follow.
  useEffect(() => {
    if (state.failure === null || warned.current) return;
    warned.current = true;
    console.warn(`animation failed:${state.failure}`);
  }, [state.failure]);

  // 3. Give the Stage the sandbox player while the iframe is shown. The cleanup runs before React
  // attaches a new Fallback_Scene player (item 6), so the last call the Stage gets is the right one.
  // `givePlayer` always calls the latest `playerRef`, so a parent that passes a new function on
  // every render (CanvasPane does) does not make this effect hand the player over again.
  const givePlayer = useEffectEvent((player: PlayerLike | null) => playerRef?.(player));
  useLayoutEffect(() => {
    const ref = sandbox.current;
    if (!shown || ref === null) return;
    givePlayer(ref);
    return () => givePlayer(null);
  }, [shown]);

  // 3 and 4. The current pacing goes to the iframe when it is shown and whenever it changes.
  useEffect(() => {
    if (shown) sandbox.current?.setMode(pacing);
  }, [shown, pacing]);

  // 5. Continue past the question once per pause, when the answer is right.
  useEffect(() => {
    if (!resumeDue(state, answerCorrect, resumedEpisode.current)) return;
    resumedEpisode.current = state.pauseEpisode;
    sandbox.current?.resume();
  }, [state, answerCorrect]);

  function onFrameMessage(message: FrameMessage): void {
    switch (message.type) {
      case "loaded":
        dispatch({ type: "loaded" });
        break;
      case "frame":
        dispatch({ type: "frame", playing: message.playing });
        break;
      case "paused":
        dispatch({ type: "paused", reason: message.reason });
        break;
      case "ended":
        dispatch({ type: "ended" });
        break;
      default:
        break;
    }
  }

  function onFrameFail(phase: SandboxFailPhase): void {
    dispatch({ type: "fail", phase });
  }

  return (
    <div data-testid="animation-scene" className="absolute inset-0">
      {fallbackVisible(state) && renderFallback(playerRef ?? NO_PLAYER_REF)}
      {input !== null && iframeMounted(state) && (
        <div className="absolute inset-0">
          <SandboxBoundary onError={() => dispatch({ type: "fail", phase: "runtime" })}>
            <SandboxFrame
              bundle={input.bundle}
              meta={input.meta}
              contractVersion={CONTRACT.contract_version}
              hidden={!shown}
              onPlayerRef={(ref) => {
                sandbox.current = ref;
              }}
              onMessage={onFrameMessage}
              onFail={onFrameFail}
            />
          </SandboxBoundary>
        </div>
      )}
    </div>
  );
}
