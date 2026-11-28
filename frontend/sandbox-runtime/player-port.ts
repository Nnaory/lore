/**
 * The `PlayerPort` of the Sandbox_Runtime: the link between `RuntimeController` and the real
 * Remotion `Player` (design 7.8).
 *
 * The controller decides what to do and tells the Player through `PlayerPort`. Two facts about the
 * real Player make a plain pass-through wrong, and this module deals with both so that neither the
 * controller nor `main.tsx` has to:
 *
 * - `remount()` is not instant. It asks React for a new Player (the `key` goes up), and the new
 *   one exists only after React has committed. The controller calls `remount()` and then
 *   `seekTo`, `play` or `pause` in the same breath, so those calls are held back and applied, in
 *   order, to the new Player when it mounts (`attach`). They must never reach the old Player,
 *   which is about to go away, and while they wait `getCurrentFrame()` and `isPlaying()` answer
 *   from what those calls will have done, so the controller sees a consistent Player.
 * - The Player reports its own state changes. Applying the held calls would make it report
 *   `ended` (it does that from inside `seekTo(last)`) and `frameupdate`, which are consequences of
 *   the controller's own commands, not playback. The listeners are therefore added only after the
 *   held calls are applied.
 *
 * From then on the Player's `frameupdate` and `ended` events go to `onFrame` and `onEnded`.
 * `onFrame` gets `getCurrentFrame()` and not the number in the event: the effect that reports a
 * frame can run after a later `seekTo`, and the current frame is the truth.
 *
 * Failure. A call that throws while the held calls are applied, or a listener that throws, is
 * passed to `onFault` instead of escaping (the first runs inside React's commit, the second inside
 * the Player's emitter). Calls made directly by the controller are not caught here: the caller
 * (`main.tsx`) wraps the controller and turns an exception into an `error` message.
 *
 * Only types are imported, so this file adds nothing to the bundle by itself.
 */

import type { PlayerRef } from "@remotion/player";
import type { PlayerPort } from "./controller";

export interface DeferredPortDeps {
  /** Asks the host for a new Player at frame 0 (the React `key` goes up). */
  requestRemount(): void;
  /** The Player shows `frame` (`getCurrentFrame()` at the time of the `frameupdate`). */
  onFrame(frame: number): void;
  /** The Player reached the end of the animation. */
  onEnded(): void;
  /** Something threw while applying held calls or inside a Player listener. */
  onFault(error: unknown): void;
}

export interface DeferredPort {
  readonly port: PlayerPort;
  /**
   * The ref callback of the `<Player>`: `player` when one mounts, `null` when it unmounts. A new
   * Player is the one the held calls were waiting for.
   */
  attach(player: PlayerRef | null): void;
}

type Operation = (player: PlayerRef) => void;

export function createDeferredPort(deps: DeferredPortDeps): DeferredPort {
  /** The mounted Player. After `remount()` it is stale until `attach` brings the new one. */
  let current: PlayerRef | null = null;
  /** `remount()` was called and the new Player has not mounted yet. */
  let awaitingMount = false;
  let held: Operation[] = [];
  /** What the held calls will have done, for `getCurrentFrame` and `isPlaying` meanwhile. */
  let pendingFrame = 0;
  let pendingPlaying = false;
  let unsubscribe: (() => void) | null = null;

  /** The Player that may be touched now, or `null` while calls must wait. */
  function ready(): PlayerRef | null {
    return awaitingMount ? null : current;
  }

  function stopListening(): void {
    const stop = unsubscribe;
    unsubscribe = null;
    stop?.();
  }

  function startListening(player: PlayerRef): void {
    const guarded = (fn: () => void) => () => {
      try {
        fn();
      } catch (error) {
        deps.onFault(error);
      }
    };
    const onFrameUpdate = guarded(() => deps.onFrame(player.getCurrentFrame()));
    const onEnded = guarded(() => deps.onEnded());
    player.addEventListener("frameupdate", onFrameUpdate);
    player.addEventListener("ended", onEnded);
    unsubscribe = () => {
      try {
        player.removeEventListener("frameupdate", onFrameUpdate);
        player.removeEventListener("ended", onEnded);
      } catch {
        // The Player is going away; there is nothing left to unhook.
      }
    };
  }

  function attach(player: PlayerRef | null): void {
    stopListening();
    current = player;
    if (player === null) return;
    awaitingMount = false;
    const pending = held;
    held = [];
    try {
      for (const operation of pending) operation(player);
    } catch (error) {
      deps.onFault(error);
      return;
    }
    startListening(player);
  }

  const port: PlayerPort = {
    remount() {
      awaitingMount = true;
      held = [];
      pendingFrame = 0;
      pendingPlaying = false;
      deps.requestRemount();
    },
    play() {
      const player = ready();
      if (player) {
        player.play();
        return;
      }
      held.push((p) => p.play());
      pendingPlaying = true;
    },
    pause() {
      const player = ready();
      if (player) {
        player.pause();
        return;
      }
      held.push((p) => p.pause());
      pendingPlaying = false;
    },
    seekTo(frame) {
      const player = ready();
      if (player) {
        player.seekTo(frame);
        return;
      }
      held.push((p) => p.seekTo(frame));
      pendingFrame = frame;
    },
    getCurrentFrame() {
      const player = ready();
      return player ? player.getCurrentFrame() : pendingFrame;
    },
    isPlaying() {
      const player = ready();
      return player ? player.isPlaying() : pendingPlaying;
    },
  };

  return { port, attach };
}
