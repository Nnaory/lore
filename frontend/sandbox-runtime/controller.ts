/**
 * RuntimeController: the playback logic of the Sandbox_Runtime (design 7.8, Requirement 29).
 *
 * The runtime runs inside the sandboxed iframe, mounts the animation's `Player` and obeys the
 * parent's commands (`setMode`, `play`, `pause`, `seek`, `resume`). Deciding what each command
 * and each report of the Player means is the part that can be wrong in subtle ways: a puzzle must
 * stop at its question and must not let a seek reveal the answer, `ended` must come once, and
 * every `frame` the parent sees must be a real frame of the animation. That is all here, as plain
 * logic with no React and no DOM. The Player is reached only through `PlayerPort`, and the
 * outside world through `post` and `now`, so the tests drive it with a fake Player and a fake
 * clock. `main.tsx` (task 26.3) connects it to the real `Player` and to `postMessage`.
 *
 * Meaning of the numbers. `last = durationInFrames - 1`. A puzzle is an animation with
 * `pauseAtFrame` (`p`); it waits at `p` for the player's answer (`hold`) until `resume`. A lesson
 * has no `p` and just plays or shows its last frame.
 *
 * Rules (design 7.8 table). `setMode` remounts the Player, forgets every earlier wait and ended,
 * and starts the new mode from frame 0: `animate` plays; `fast` shows `last` and reports
 * `paused{end}` (lesson) or shows `p` and reports `paused{interaction}` (puzzle). While a puzzle
 * plays, the first frame at or past `p` pauses it, puts it exactly at `p` and reports
 * `paused{interaction}`. Until `resume`, `p` is a wall: `seek` is clamped to it, so scrubbing
 * cannot get past the question (Requirement 29.12), and the frame reported is clamped to it too.
 * `resume` ends a wait once: `animate` plays on to the end and reports `ended`, `fast` shows
 * `last` and reports `paused{end}`. Without a wait it does nothing (Requirement 29.15).
 *
 * Messages sent. A periodic `frame` at most every 100 ms; a forced `frame` (outside that
 * spacing) right before every `paused` and `ended`, and after `pause` and `seek` (Requirement
 * 28.6). Forced frames also count toward the spacing, so a periodic frame never follows any
 * frame by less than 100 ms. Every frame number is an integer in `0..last`; a value from outside
 * (`NaN`, negative, too large) is clamped. `ended` is sent at most once per playback: it is
 * armed again by `setMode` and by a `play` or `resume` that really starts playing.
 *
 * Decisions where the table is silent, all fail-safe:
 * - `play` while a wait is open replays from frame 0, even when `p` is the last frame (the
 *   wait is the more specific rule than "play at the last frame changes nothing");
 * - the Player ending while a puzzle has not been resumed is the pause point being reached, not
 *   an `ended` (this matters when `p` is the last frame);
 * - `resume` in `animate` when the Player is already at the last frame reports `ended` at once
 *   instead of relying on the Player to end again;
 * - fast mode arriving at the last frame marks the end as announced, so an `ended` from the
 *   Player (the real one reports it from inside `seekTo(last)`) adds nothing around `paused{end}`.
 *
 * `halt()` is for after the runtime sent an `error` (Requirement 29.16): it pauses the Player and
 * from then on nothing is sent and the Player is not touched. The controller itself does not
 * throw; `main.tsx` wraps its calls, because the real Player can.
 */

import type { FrameMessage, ParentMessage } from "@/lib/animation/protocol";
import { FRAME_MIN_INTERVAL_MS } from "./page";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type Envelope = "source" | "version" | "session";

/** A message the runtime sends, without the envelope that `main.tsx` adds (`session` etc.). */
export type FrameMessageBody = DistributiveOmit<FrameMessage, Envelope>;

/** The messages this controller sends: the playback ones. */
export type PlaybackMessageBody = Extract<FrameMessageBody, { type: "frame" | "paused" | "ended" }>;

/** A command from the parent, without the envelope. `load` is handled by `main.tsx`, not here. */
export type ParentCommand = DistributiveOmit<Exclude<ParentMessage, { type: "load" }>, Envelope>;

/**
 * What the controller needs from the Player. `remount` makes a new Player at frame 0 (the
 * React `key` goes up); the others act on the current one.
 */
export interface PlayerPort {
  remount(): void;
  play(): void;
  pause(): void;
  seekTo(frame: number): void;
  getCurrentFrame(): number;
  isPlaying(): boolean;
}

/** The two facts about the animation that playback depends on (from the validated `meta`). */
export interface RuntimeMeta {
  durationInFrames: number;
  pauseAtFrame?: number;
}

export interface RuntimeControllerDeps {
  meta: RuntimeMeta;
  port: PlayerPort;
  /** Sends one message to the parent. */
  post(message: PlaybackMessageBody): void;
  /** A monotonic clock in milliseconds. */
  now(): number;
}

export interface RuntimeController {
  /** Applies a command from the parent. */
  command(command: ParentCommand): void;
  /** The Player shows `frame` (called for every `frameupdate`). */
  onPlayerFrame(frame: number): void;
  /** The Player reached the end of the animation. */
  onPlayerEnded(): void;
  /** Stops playback for good, after an `error` was sent. */
  halt(): void;
}

type Mode = "fast" | "animate";

/** `value` as an integer in `0..high`; anything that is not a finite number becomes 0. */
function clampFrame(value: number, high: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(high, Math.max(0, Math.trunc(value)));
}

export function createRuntimeController(deps: RuntimeControllerDeps): RuntimeController {
  const { port } = deps;
  /** Index of the last frame. `main.tsx` has validated the duration; this only keeps it total. */
  const last = Number.isFinite(deps.meta.durationInFrames)
    ? Math.max(0, Math.trunc(deps.meta.durationInFrames) - 1)
    : 0;
  /** The pause point `p`, or `null` for a lesson. */
  const pausePoint =
    deps.meta.pauseAtFrame === undefined ? null : clampFrame(deps.meta.pauseAtFrame, last);

  let mode: Mode = "animate";
  /** A puzzle is waiting at `p` for `resume`. */
  let hold = false;
  /** The wait at `p` was answered: `p` is no longer a wall. */
  let resumed = false;
  let endedSent = false;
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let halted = false;

  /** Highest frame that may be reached or reported now: `p` until the puzzle is resumed. */
  function limit(): number {
    return pausePoint !== null && !resumed ? pausePoint : last;
  }

  function sendFrame(frame: number, playing: boolean): void {
    lastSentAt = deps.now();
    deps.post({ type: "frame", frame, playing });
  }

  /**
   * The puzzle reached `p`: park the Player exactly there and report the wait. `hold` is set
   * before the Player is touched: the real Player reports `ended` from inside `seekTo` when the
   * target is its last frame (possible when `p` is the last frame), and that report must find the
   * wait already open instead of opening it again.
   */
  function enterHold(pauseFirst: boolean): void {
    if (pausePoint === null) return;
    hold = true;
    if (pauseFirst) {
      port.pause();
      port.seekTo(pausePoint);
    } else {
      port.seekTo(pausePoint);
      port.pause();
    }
    sendFrame(pausePoint, false);
    deps.post({ type: "paused", reason: "interaction", frame: pausePoint });
  }

  /**
   * Fast mode, or `resume` in fast mode: show the last frame and report `paused{end}`.
   * `endedSent` is set before the Player is touched, for the same reason as `hold` above: the
   * `ended` the real Player reports from inside `seekTo(last)` must not become an `ended` message.
   */
  function showEnd(): void {
    endedSent = true;
    port.seekTo(last);
    port.pause();
    sendFrame(last, false);
    deps.post({ type: "paused", reason: "end", frame: last });
  }

  /** The animation finished playing: report it, once. */
  function announceEnd(): void {
    if (endedSent) return;
    endedSent = true;
    sendFrame(last, false);
    deps.post({ type: "ended" });
  }

  function setMode(next: Mode): void {
    mode = next;
    hold = false;
    resumed = false;
    endedSent = false;
    port.remount();
    if (next === "animate") {
      port.seekTo(0);
      port.play();
    } else if (pausePoint === null) {
      showEnd();
    } else {
      enterHold(false);
    }
  }

  function play(): void {
    if (hold) {
      hold = false;
      endedSent = false;
      port.seekTo(0);
      port.play();
      return;
    }
    if (clampFrame(port.getCurrentFrame(), last) >= last) return;
    endedSent = false;
    port.play();
  }

  function pause(): void {
    port.pause();
    sendFrame(clampFrame(port.getCurrentFrame(), limit()), false);
  }

  function seek(frame: number): void {
    const target = clampFrame(frame, limit());
    port.seekTo(target);
    sendFrame(target, port.isPlaying());
  }

  function resume(): void {
    if (!hold) return;
    hold = false;
    resumed = true;
    endedSent = false;
    if (mode === "fast") {
      showEnd();
    } else if (clampFrame(port.getCurrentFrame(), last) >= last) {
      announceEnd();
    } else {
      port.play();
    }
  }

  function command(c: ParentCommand): void {
    if (halted) return;
    switch (c.type) {
      case "setMode":
        setMode(c.mode);
        break;
      case "play":
        play();
        break;
      case "pause":
        pause();
        break;
      case "seek":
        seek(c.frame);
        break;
      case "resume":
        resume();
        break;
    }
  }

  function onPlayerFrame(raw: number): void {
    if (halted) return;
    const frame = clampFrame(raw, last);
    const stopsHere =
      pausePoint !== null && !resumed && !hold && frame >= pausePoint && port.isPlaying();
    if (stopsHere) {
      enterHold(true);
      return;
    }
    if (deps.now() - lastSentAt < FRAME_MIN_INTERVAL_MS) return;
    sendFrame(Math.min(frame, limit()), port.isPlaying());
  }

  function onPlayerEnded(): void {
    if (halted) return;
    if (pausePoint !== null && !resumed) {
      if (!hold) enterHold(true);
      return;
    }
    announceEnd();
  }

  function halt(): void {
    if (halted) return;
    halted = true;
    port.pause();
  }

  return { command, onPlayerFrame, onPlayerEnded, halt };
}
