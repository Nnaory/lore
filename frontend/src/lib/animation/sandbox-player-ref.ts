/**
 * SandboxPlayerRef: makes the sandboxed animation look like a Remotion player to the Stage
 * (design 7.7, D-16, Requirement 30.1 and 30.2).
 *
 * `CanvasPane`, `useCanvasPlayback` and the PlayerBar already know how to drive a player: listen
 * for `frameupdate`, `play`, `pause`, `ended`, and call `play`, `pause`, `seekTo`. The animation
 * runs in an iframe, so this adaptor turns those calls into Sandbox_Protocol commands and the
 * runtime's messages back into those events. There is no second player component and no second
 * progress/clock path.
 *
 * Commands out. `play`, `pause`, `seekTo`, `resume` and `setMode` become one message each through
 * `c.send`. The SandboxController only sends once the frame is live, and before `loaded` the
 * runtime has nothing to receive a command. So while the controller reports `loading` the calls
 * wait in a queue of at most 16 (the oldest is dropped when it is full) and are sent in order
 * when `loaded` arrives. While the controller reports `failed`, or after `dispose()`, a call does
 * nothing: no message, no event.
 *
 * Events in. The host (SandboxFrame) passes every message the controller forwards to
 * `onFrameMessage`; the controller has already moved its status when it does. The adaptor keeps
 * only one fact, whether the runtime is playing:
 * - `frame`: `frameupdate`, then `play` or `pause` if `playing` differs from the last known value;
 * - `paused`: `pause`, if it was playing;
 * - `ended`: `pause` if it was playing, then `ended`;
 * - `loaded`: sends the queued commands, emits nothing.
 * `frameupdate` carries `detail: { frame }`; `play`, `pause` and `ended` carry no detail, exactly
 * like Remotion's player (see `player-like.ts`).
 *
 * No game rules. HP, score and correctness are decided elsewhere; nothing here reads an answer.
 * Listener errors are caught, so one throwing listener cannot stop the others or throw through
 * the controller's message handler. Every import is a type, and there is no React or DOM.
 */

import type {
  PlayerEventDetail,
  PlayerEventListener,
  PlayerEventName,
  PlayerLike,
} from "@/lib/stage/player-like";
import type { Pacing } from "@/lib/story/pacing";
import type { FrameMessage } from "./protocol";
import type { ParentMessageBody, SandboxStatus } from "./sandbox-controller";

/** Most commands kept before `loaded`; one more drops the oldest (Requirement 30.2). */
export const PLAYER_REF_QUEUE_MAX = 16;

/** What the adaptor needs from the SandboxController. */
export interface SandboxPlayerRefSource {
  send(msg: ParentMessageBody): void;
  status(): SandboxStatus;
}

/** A player the Stage can drive, plus the two sandbox-only commands and the teardown. */
export interface SandboxPlayerRef extends PlayerLike {
  /** Tells the runtime to continue from a pause at `pause_at_frame` (design 7.6, item 5). */
  resume(): void;
  /** Switches the runtime between `animate` and `fast` without remounting the iframe. */
  setMode(mode: Pacing): void;
  /** Drops every listener and queued command; later calls and messages do nothing. */
  dispose(): void;
}

export type SandboxPlayerRefHandle = SandboxPlayerRef & {
  /** Feeds one message the SandboxController forwarded (`loaded`, `frame`, `paused`, `ended`). */
  onFrameMessage(m: FrameMessage): void;
};

type ListenerSets = { [Q in PlayerEventName]: Set<PlayerEventListener<Q>> };

export function createSandboxPlayerRef(c: SandboxPlayerRefSource): SandboxPlayerRefHandle {
  const listeners: ListenerSets = {
    frameupdate: new Set(),
    play: new Set(),
    pause: new Set(),
    ended: new Set(),
  };
  let queue: ParentMessageBody[] = [];
  let disposed = false;
  let playing = false;

  function emit<Q extends PlayerEventName>(name: Q, detail: PlayerEventDetail[Q]): void {
    if (disposed) return;
    const set: Set<PlayerEventListener<Q>> = listeners[name];
    // A copy, so a listener may remove itself; a listener removed meanwhile is skipped.
    for (const cb of [...set]) {
      if (!set.has(cb)) continue;
      try {
        cb({ detail });
      } catch {
        // Ignored on purpose: see the header.
      }
    }
  }

  /** Sends the queue in order once the frame is live; drops it if the frame has failed. */
  function flush(): void {
    if (queue.length === 0) return;
    const status = c.status();
    if (status === "loading") return;
    const pending = queue;
    queue = [];
    if (status === "failed") return;
    for (const body of pending) c.send(body);
  }

  function dispatch(body: ParentMessageBody): void {
    if (disposed) return;
    const status = c.status();
    if (status === "failed") {
      queue = [];
      return;
    }
    if (status === "loading") {
      queue.push(body);
      if (queue.length > PLAYER_REF_QUEUE_MAX) queue.shift();
      return;
    }
    flush();
    c.send(body);
  }

  function onFrameMessage(m: FrameMessage): void {
    if (disposed) return;
    if (c.status() === "failed") {
      queue = [];
      return;
    }
    switch (m.type) {
      case "loaded":
        flush();
        break;
      case "frame":
        emit("frameupdate", { frame: m.frame });
        if (m.playing !== playing) {
          playing = m.playing;
          emit(playing ? "play" : "pause", undefined);
        }
        break;
      case "paused":
        if (playing) {
          playing = false;
          emit("pause", undefined);
        }
        break;
      case "ended":
        if (playing) {
          playing = false;
          emit("pause", undefined);
        }
        emit("ended", undefined);
        break;
      default:
        // `ready`, `heartbeat` and `error` are the controller's business, not the player's.
        break;
    }
  }

  return {
    addEventListener(name, cb) {
      if (disposed) return;
      listeners[name].add(cb);
    },
    removeEventListener(name, cb) {
      listeners[name].delete(cb);
    },
    play: () => dispatch({ type: "play" }),
    pause: () => dispatch({ type: "pause" }),
    seekTo(frame) {
      // The protocol takes a safe integer and the runtime clamps it to the animation. A number
      // that cannot become one would only be refused by the runtime, so it is dropped here.
      if (!Number.isFinite(frame)) return;
      const whole = Math.trunc(frame) || 0; // `|| 0` turns -0 into 0
      dispatch({
        type: "seek",
        frame: Math.max(-Number.MAX_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, whole)),
      });
    },
    resume: () => dispatch({ type: "resume" }),
    setMode: (mode) => dispatch({ type: "setMode", mode }),
    dispose() {
      disposed = true;
      queue = [];
      listeners.frameupdate.clear();
      listeners.play.clear();
      listeners.pause.clear();
      listeners.ended.clear();
    },
    onFrameMessage,
  };
}
