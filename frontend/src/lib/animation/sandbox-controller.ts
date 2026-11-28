/**
 * SandboxController: the parent side of the Sandbox_Protocol (design 7.7, Requirement 28).
 *
 * The Sandbox_Frame (task 27.1) mounts an iframe that runs AI-written code. The page may not
 * trust that iframe or wait on it without limit, so one controller owns every decision about it:
 * which `message` events to believe, the handshake (`ready` -> `load` -> `loaded`), the status the
 * Stage shows, and the timers that give up on a silent or frozen iframe. It is pure logic. The
 * clock (`timers`) and the way a message reaches the iframe (`postToFrame`) are injected, so the
 * tests drive it with a fake clock and no DOM, and the React side stays a thin shell around it.
 *
 * What a `message` event must pass, in this order (Requirement 28.3, 32.11):
 * 1. `e.source` is the iframe's own window (a missing window never matches) and `e.origin` is
 *    `"null"`, the origin of a sandboxed iframe. Failing either: ignored, and nothing changes,
 *    not even the rate counter.
 * 2. Rate limit. Every event that passed step 1 counts, valid or not, in a sliding 1000 ms window.
 *    The 51st fails the frame with phase `runtime` (Requirement 32.11).
 * 3. `decodeMessage` accepts it and it is a message the iframe may send.
 * 4. `session` matches. `ready` is the one message that must carry the empty `session`, because
 *    the runtime has not seen `load` yet when it sends it (Requirement 28.13). The protocol schema
 *    allows an empty `session` on every type; this check is where that is enforced (task 25.1).
 *    `heartbeat` only matters once `loaded` has arrived, and by then it carries our own session,
 *    so an empty-session heartbeat is ignored rather than counted as proof of life.
 * Anything refused in steps 3 and 4 is ignored without touching state or timers.
 *
 * Status (design 7.7 table, Requirement 28.12). `loading` lasts until `loaded`; the status then is
 * `ready` until the first `frame` or `paused`, `playing` while `frame` says so, `paused` after
 * `paused`, `ended` or a `frame` that is not playing, and `failed` for good once anything fails.
 * Frame, paused and ended events that arrive while `loading` are ignored. The status is updated
 * before `onMessage` is called, so a handler that reads `status()` or calls `send` sees the new one.
 *
 * Timers. 8000 ms from mount to `ready`; 8000 ms from `load` to `loaded`; then a 3000 ms heartbeat
 * watchdog that restarts at `loaded` and at every valid `heartbeat` (frames do not restart it).
 * A fired timer fails the frame with phase `timeout`.
 *
 * Failure. `onFail(phase)` is called once, after the status is already `failed` and the timers are
 * cleared. `dispose()` (unmount) does the same without calling `onFail`, and afterwards `status()`
 * reports `failed` so holders of the controller drop their calls. Nothing is posted or reported
 * after either (Requirement 27.14, 28.9).
 *
 * Two small additions to the table, both fail-closed. The `load` message is checked with the
 * protocol schema and the Session_Id length before it is posted: an oversized bundle, a meta out of
 * range or a bad session fails with phase `load` at once, instead of waiting 8000 ms for an iframe
 * that would refuse it. And `send` posts only once the frame is live (`ready`, `playing`,
 * `paused`): before `loaded` the runtime has nothing to receive the command (the player ref
 * queues it, task 25.4), and `load` is sent by the controller itself, so `send` cannot send it.
 *
 * `timers.now()` must be monotonic. The timings and the rate limit are not Main_File rules, so
 * they are constants below rather than contract values. No React, DOM or Next here; `./protocol`
 * is the only import.
 */

import {
  SANDBOX_SOURCE,
  SANDBOX_VERSION,
  SESSION_ID_LENGTH,
  decodeMessage,
  encodeMessage,
  isFrameMessage,
  type FrameMessage,
  type LoadMeta,
  type ParentMessage,
} from "./protocol";

/** Time allowed from mount to the first `ready` (Requirement 28.7). */
export const READY_TIMEOUT_MS = 8000;

/** Time allowed from sending `load` to receiving `loaded` (Requirement 28.7). */
export const LOADED_TIMEOUT_MS = 8000;

/** Silence allowed from `loaded` or the last valid `heartbeat` (Requirement 28.8, 28.12). */
export const HEARTBEAT_WATCHDOG_MS = 3000;

/** Length of the sliding window of the message rate limit (Requirement 32.11). */
export const RATE_WINDOW_MS = 1000;

/** Most messages accepted inside one window; one more fails the frame (Requirement 32.11). */
export const RATE_MAX_MESSAGES = 50;

/** `event.origin` of a document in an iframe sandboxed without `allow-same-origin`. */
export const OPAQUE_ORIGIN = "null";

export type SandboxStatus = "loading" | "ready" | "playing" | "paused" | "failed";

/** Phase passed to `onFail`: same names as the Animation_Scene failure phases (Requirement 31.1). */
export type SandboxFailPhase = "load" | "runtime" | "timeout";

/** The timer functions the controller uses; `now` is a monotonic clock in milliseconds. */
export interface SandboxTimers {
  set(fn: () => void, ms: number): number;
  clear(id: number): void;
  now(): number;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * A command to the runtime without the envelope (`source`, `version`, `session`), which `send`
 * adds. `load` is excluded: the controller sends it by itself, exactly once.
 */
export type ParentMessageBody = DistributiveOmit<
  Exclude<ParentMessage, { type: "load" }>,
  "source" | "version" | "session"
>;

/** The three fields of a `message` event the controller looks at. */
export interface SandboxEvent {
  source: unknown;
  origin: string;
  data: unknown;
}

export interface SandboxControllerDeps {
  /** Session_Id of this mount: 32 lowercase hex characters from `newSessionId()`. */
  session: string;
  /** The iframe's `contentWindow`. `null` or `undefined` means no event can ever match. */
  frameWindow: unknown;
  /** Delivers a message to the iframe (the caller picks the target origin, `*`). */
  postToFrame(msg: ParentMessage): void;
  timers: SandboxTimers;
  /** Receives `loaded`, `frame`, `paused` and `ended` after they changed the status. */
  onMessage(msg: FrameMessage): void;
  /** Called once when the frame fails (not on `dispose`). */
  onFail(phase: SandboxFailPhase): void;
  bundle: string;
  meta: LoadMeta;
  contractVersion: number;
}

export interface SandboxController {
  /** Feeds one `message` event. Total: never throws for any `data`. */
  handleEvent(e: SandboxEvent): void;
  /** Posts a command to the runtime when the frame is live; otherwise does nothing. */
  send(msg: ParentMessageBody): void;
  status(): SandboxStatus;
  /** Stops all timers and ignores everything from now on, without calling `onFail`. */
  dispose(): void;
}

export function createSandboxController(deps: SandboxControllerDeps): SandboxController {
  const { timers } = deps;

  let status: SandboxStatus = "loading";
  /** True once `load` has been posted: from then on a `ready` is a second one. */
  let loadSent = false;
  let readyTimer: number | null = null;
  let loadedTimer: number | null = null;
  let watchdogTimer: number | null = null;
  /** Arrival times (from `timers.now()`) of the messages inside the current window. */
  let arrivals: number[] = [];

  function stop(id: number | null): null {
    if (id !== null) timers.clear(id);
    return null;
  }

  function stopAllTimers(): void {
    readyTimer = stop(readyTimer);
    loadedTimer = stop(loadedTimer);
    watchdogTimer = stop(watchdogTimer);
  }

  function fail(phase: SandboxFailPhase): void {
    if (status === "failed") return;
    status = "failed";
    stopAllTimers();
    deps.onFail(phase);
  }

  function dispose(): void {
    if (status === "failed") return;
    status = "failed";
    stopAllTimers();
  }

  function armWatchdog(): void {
    watchdogTimer = stop(watchdogTimer);
    watchdogTimer = timers.set(() => {
      watchdogTimer = null;
      fail("timeout");
    }, HEARTBEAT_WATCHDOG_MS);
  }

  /** Counts one more arrival and says whether the window now holds more than the limit. */
  function overRateLimit(): boolean {
    const now = timers.now();
    arrivals = arrivals.filter((at) => now - at < RATE_WINDOW_MS);
    arrivals.push(now);
    return arrivals.length > RATE_MAX_MESSAGES;
  }

  function onReady(): void {
    if (status !== "loading" || loadSent) return;
    readyTimer = stop(readyTimer);
    const load: ParentMessage = {
      source: SANDBOX_SOURCE,
      version: SANDBOX_VERSION,
      type: "load",
      session: deps.session,
      bundle: deps.bundle,
      meta: deps.meta,
      contract_version: deps.contractVersion,
    };
    if (deps.session.length !== SESSION_ID_LENGTH || !decodeMessage(load).ok) {
      fail("load");
      return;
    }
    loadSent = true;
    loadedTimer = timers.set(() => {
      loadedTimer = null;
      fail("timeout");
    }, LOADED_TIMEOUT_MS);
    deps.postToFrame(encodeMessage(load));
  }

  function onLoaded(message: Extract<FrameMessage, { type: "loaded" }>): void {
    if (status !== "loading" || !loadSent) return;
    if (message.duration_in_frames !== deps.meta.duration_in_frames) {
      fail("load");
      return;
    }
    loadedTimer = stop(loadedTimer);
    status = "ready";
    armWatchdog();
    deps.onMessage(message);
  }

  function onHeartbeat(): void {
    if (status === "loading") return;
    armWatchdog();
  }

  /** `frame`, `paused` and `ended` after `loaded`: move the status and pass the message on. */
  function onPlayback(
    message: Extract<FrameMessage, { type: "frame" | "paused" | "ended" }>,
  ): void {
    if (status === "loading") return;
    status = message.type === "frame" && message.playing ? "playing" : "paused";
    deps.onMessage(message);
  }

  function handleEvent(e: SandboxEvent): void {
    if (status === "failed") return;
    if (deps.frameWindow == null || e.source !== deps.frameWindow) return;
    if (e.origin !== OPAQUE_ORIGIN) return;
    if (overRateLimit()) {
      fail("runtime");
      return;
    }
    const decoded = decodeMessage(e.data);
    if (!decoded.ok || !isFrameMessage(decoded.message)) return;
    const message = decoded.message;
    if (message.session !== (message.type === "ready" ? "" : deps.session)) return;
    switch (message.type) {
      case "ready":
        onReady();
        break;
      case "loaded":
        onLoaded(message);
        break;
      case "heartbeat":
        onHeartbeat();
        break;
      case "frame":
      case "paused":
      case "ended":
        onPlayback(message);
        break;
      case "error":
        fail(message.phase);
        break;
    }
  }

  function send(body: ParentMessageBody): void {
    if (status === "loading" || status === "failed") return;
    deps.postToFrame(
      encodeMessage({
        ...body,
        source: SANDBOX_SOURCE,
        version: SANDBOX_VERSION,
        session: deps.session,
      }),
    );
  }

  readyTimer = timers.set(() => {
    readyTimer = null;
    fail("timeout");
  }, READY_TIMEOUT_MS);

  return { handleEvent, send, status: () => status, dispose };
}
