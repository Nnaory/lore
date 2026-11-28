/**
 * Tests: SandboxController (task 25.3), design 7.7, Requirements 28.3, 28.5, 28.7, 28.8, 28.9,
 * 28.12, 28.14, 32.11 and 27.8.
 *
 * The controller is pure logic with an injected clock and transport, so every test drives it with
 * a fake clock (`createClock`) and plain objects for the iframe window and the posted messages.
 * No DOM and no real timers:
 *
 *   1. mount, handshake and the `ready` / `loaded` timers (design 7.7 table, rows 1 to 6);
 *   2. the heartbeat watchdog;
 *   3. status transitions for `frame`, `paused` and `ended`, and the `error` row;
 *   4. what is accepted: source, origin, schema, session, and that a refused event changes nothing;
 *   5. the 50 messages per 1000 ms limit;
 *   6. `send`, `failed` and `dispose`;
 *   7. the fail-closed check of the `load` message.
 *
 * Timer deadlines are asserted through `clock.deadlines()` (absolute times of pending timers), so
 * "does not change a timer" is a direct comparison of before and after.
 */

import { describe, expect, it } from "vitest";
import { MAX_BUNDLE_CHARS, type FrameMessage, type ParentMessage } from "@/lib/animation/protocol";
import {
  HEARTBEAT_WATCHDOG_MS,
  LOADED_TIMEOUT_MS,
  RATE_MAX_MESSAGES,
  READY_TIMEOUT_MS,
  createSandboxController,
  type SandboxController,
  type SandboxFailPhase,
  type SandboxStatus,
} from "@/lib/animation/sandbox-controller";

const SESSION = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const OLD_SESSION = "0123456789abcdef0123456789abcdef";
const BUNDLE = '"use strict";var main=1;';
const META = { width: 1280, height: 720, fps: 30, duration_in_frames: 210, pause_at_frame: 180 };
const ENVELOPE = { source: "lore-sandbox", version: 1 } as const;

/** A fake clock: `set` records a timer, `advance` runs the due ones in order. */
function createClock() {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      set(fn: () => void, ms: number): number {
        const id = nextId++;
        pending.set(id, { at: now + ms, fn });
        return id;
      },
      clear(id: number): void {
        pending.delete(id);
      },
      now: () => now,
    },
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        let dueId: number | null = null;
        for (const [id, timer] of pending) {
          if (timer.at <= target && (dueId === null || timer.at < pending.get(dueId)!.at)) {
            dueId = id;
          }
        }
        if (dueId === null) break;
        const due = pending.get(dueId)!;
        pending.delete(dueId);
        now = due.at;
        due.fn();
      }
      now = target;
    },
    deadlines: (): number[] => [...pending.values()].map((timer) => timer.at).sort((a, b) => a - b),
    now: () => now,
  };
}

/** Frame-to-parent message with the given fields; `session` defaults to the live one. */
function msg(type: string, fields: Record<string, unknown> = {}, session = SESSION) {
  return { ...ENVELOPE, type, session, ...fields };
}

const ready = () => msg("ready", {}, "");
const loaded = (duration = META.duration_in_frames) =>
  msg("loaded", { duration_in_frames: duration });
const heartbeat = () => msg("heartbeat");
const frame = (index: number, playing: boolean) => msg("frame", { frame: index, playing });
const paused = (reason: "interaction" | "end" = "interaction", index = 180) =>
  msg("paused", { reason, frame: index });
const ended = () => msg("ended");
const errorMessage = (phase: "load" | "runtime") => msg("error", { phase, code: "RENDER_THROW" });

function setup(overrides: { session?: string; bundle?: string; frameWindow?: unknown } = {}) {
  const clock = createClock();
  const frameWindow = "frameWindow" in overrides ? overrides.frameWindow : { name: "iframe" };
  const posted: ParentMessage[] = [];
  const forwarded: FrameMessage[] = [];
  const failures: SandboxFailPhase[] = [];
  const controller = createSandboxController({
    session: overrides.session ?? SESSION,
    frameWindow,
    postToFrame: (message) => posted.push(message),
    timers: clock.timers,
    onMessage: (message) => forwarded.push(message),
    onFail: (phase) => failures.push(phase),
    bundle: overrides.bundle ?? BUNDLE,
    meta: META,
    contractVersion: 1,
  });
  /** Delivers `data` as a message event from the iframe; `over` replaces source or origin. */
  const deliver = (data: unknown, over: { source?: unknown; origin?: string } = {}) =>
    controller.handleEvent({
      source: "source" in over ? over.source : frameWindow,
      origin: over.origin ?? "null",
      data,
    });
  return { clock, frameWindow, posted, forwarded, failures, controller, deliver };
}

type Harness = ReturnType<typeof setup>;

/** Moves a fresh harness to `status` through valid messages only. */
function reach(h: Harness, status: Exclude<SandboxStatus, "failed">): void {
  if (status === "loading") return;
  h.deliver(ready());
  h.deliver(loaded());
  if (status === "playing") h.deliver(frame(1, true));
  if (status === "paused") h.deliver(paused());
}

describe("mount, handshake and the ready / loaded timers", () => {
  it("starts in loading, posts nothing and waits 8000 ms for ready", () => {
    const h = setup();
    expect(h.controller.status()).toBe("loading");
    expect(h.posted).toEqual([]);
    expect(h.clock.deadlines()).toEqual([READY_TIMEOUT_MS]);
    expect(READY_TIMEOUT_MS).toBe(8000);
  });

  it("fails with phase timeout when ready does not arrive within 8000 ms", () => {
    const h = setup();
    h.clock.advance(READY_TIMEOUT_MS - 1);
    expect(h.failures).toEqual([]);
    h.clock.advance(1);
    expect(h.failures).toEqual(["timeout"]);
    expect(h.controller.status()).toBe("failed");
    expect(h.clock.deadlines()).toEqual([]);
  });

  it("answers the first ready with one load message and starts the 8000 ms loaded timer", () => {
    const h = setup();
    h.clock.advance(1000);
    h.deliver(ready());
    expect(h.posted).toEqual([
      {
        ...ENVELOPE,
        type: "load",
        session: SESSION,
        bundle: BUNDLE,
        meta: META,
        contract_version: 1,
      },
    ]);
    expect(h.controller.status()).toBe("loading");
    expect(h.clock.deadlines()).toEqual([1000 + LOADED_TIMEOUT_MS]);
    expect(LOADED_TIMEOUT_MS).toBe(8000);
  });

  it("ignores a second ready: no second load and the loaded timer is not extended", () => {
    const h = setup();
    h.deliver(ready());
    h.clock.advance(2000);
    h.deliver(ready());
    expect(h.posted).toHaveLength(1);
    expect(h.clock.deadlines()).toEqual([LOADED_TIMEOUT_MS]);
  });

  it("fails with phase timeout when loaded does not arrive within 8000 ms of load", () => {
    const h = setup();
    h.clock.advance(3000);
    h.deliver(ready());
    h.clock.advance(LOADED_TIMEOUT_MS - 1);
    expect(h.failures).toEqual([]);
    h.clock.advance(1);
    expect(h.failures).toEqual(["timeout"]);
  });

  it("moves to ready on loaded with the same duration, stops the timer and starts the watchdog", () => {
    const h = setup();
    h.deliver(ready());
    h.clock.advance(500);
    h.deliver(loaded());
    expect(h.controller.status()).toBe("ready");
    expect(h.forwarded).toEqual([loaded()]);
    expect(h.clock.deadlines()).toEqual([500 + HEARTBEAT_WATCHDOG_MS]);
    expect(HEARTBEAT_WATCHDOG_MS).toBe(3000);
  });

  it("fails with phase load on a loaded whose duration differs from meta", () => {
    const h = setup();
    h.deliver(ready());
    h.deliver(loaded(META.duration_in_frames + 1));
    expect(h.failures).toEqual(["load"]);
    expect(h.controller.status()).toBe("failed");
    expect(h.forwarded).toEqual([]);
    expect(h.clock.deadlines()).toEqual([]);
  });

  it("ignores a second loaded", () => {
    const h = setup();
    reach(h, "ready");
    const before = h.clock.deadlines();
    h.deliver(loaded());
    h.deliver(loaded(META.duration_in_frames + 1));
    expect(h.forwarded).toEqual([loaded()]);
    expect(h.failures).toEqual([]);
    expect(h.clock.deadlines()).toEqual(before);
  });

  it("ignores loaded that arrives before load was sent", () => {
    const h = setup();
    h.deliver(loaded());
    expect(h.controller.status()).toBe("loading");
    expect(h.forwarded).toEqual([]);
    expect(h.clock.deadlines()).toEqual([READY_TIMEOUT_MS]);
  });

  it.each([
    ["frame", frame(3, true)],
    ["paused", paused()],
    ["ended", ended()],
    ["heartbeat", heartbeat()],
  ])("ignores %s while loading, before and after load was sent", (_name, data) => {
    const h = setup();
    h.deliver(data);
    h.deliver(ready());
    h.deliver(data);
    expect(h.controller.status()).toBe("loading");
    expect(h.forwarded).toEqual([]);
    expect(h.failures).toEqual([]);
    expect(h.clock.deadlines()).toEqual([LOADED_TIMEOUT_MS]);
  });
});

describe("heartbeat watchdog (Requirement 28.8)", () => {
  it.each(["ready", "playing", "paused"] as const)(
    "fails with phase timeout after 3000 ms without heartbeat in %s",
    (status) => {
      const h = setup();
      reach(h, status);
      h.clock.advance(HEARTBEAT_WATCHDOG_MS - 1);
      expect(h.failures).toEqual([]);
      h.clock.advance(1);
      expect(h.failures).toEqual(["timeout"]);
      expect(h.controller.status()).toBe("failed");
    },
  );

  it("restarts the 3000 ms count at every valid heartbeat", () => {
    const h = setup();
    reach(h, "playing");
    h.clock.advance(2999);
    h.deliver(heartbeat());
    h.clock.advance(2999);
    h.deliver(heartbeat());
    expect(h.failures).toEqual([]);
    expect(h.clock.deadlines()).toEqual([2999 + 2999 + HEARTBEAT_WATCHDOG_MS]);
    h.clock.advance(HEARTBEAT_WATCHDOG_MS);
    expect(h.failures).toEqual(["timeout"]);
  });

  it("does not restart the count for a frame message, and does not forward the heartbeat", () => {
    const h = setup();
    reach(h, "playing");
    h.clock.advance(1000);
    h.deliver(frame(5, true));
    expect(h.clock.deadlines()).toEqual([HEARTBEAT_WATCHDOG_MS]);
    h.deliver(heartbeat());
    expect(h.clock.deadlines()).toEqual([1000 + HEARTBEAT_WATCHDOG_MS]);
    expect(h.forwarded.map((message) => message.type)).toEqual(["loaded", "frame", "frame"]);
  });

  it("ignores a heartbeat with an empty or foreign session once loaded", () => {
    const h = setup();
    reach(h, "ready");
    h.clock.advance(2000);
    h.deliver(msg("heartbeat", {}, ""));
    h.deliver(msg("heartbeat", {}, OLD_SESSION));
    expect(h.clock.deadlines()).toEqual([HEARTBEAT_WATCHDOG_MS]);
  });
});

describe("status transitions for frame, paused and ended (Requirement 28.12)", () => {
  type Live = Exclude<SandboxStatus, "loading" | "failed">;
  const cases: Array<[Live, string, SandboxStatus, unknown]> = [
    ["ready", "frame playing", "playing", frame(1, true)],
    ["ready", "frame not playing", "paused", frame(0, false)],
    ["ready", "paused", "paused", paused()],
    ["ready", "ended", "paused", ended()],
    ["playing", "frame playing", "playing", frame(2, true)],
    ["playing", "frame not playing", "paused", frame(2, false)],
    ["playing", "paused", "paused", paused("end", 209)],
    ["playing", "ended", "paused", ended()],
    ["paused", "frame playing", "playing", frame(3, true)],
    ["paused", "frame not playing", "paused", frame(3, false)],
    ["paused", "paused", "paused", paused()],
    ["paused", "ended", "paused", ended()],
  ];

  it.each(cases)("from %s, %s leads to %s and is forwarded", (from, _name, to, data) => {
    const h = setup();
    reach(h, from);
    h.forwarded.length = 0;
    h.deliver(data);
    expect(h.controller.status()).toBe(to);
    expect(h.forwarded).toEqual([data]);
  });

  it("changes the status before onMessage runs, so a handler can read it and send", () => {
    const clock = createClock();
    const win = {};
    const posted: ParentMessage[] = [];
    const seen: string[] = [];
    const ref: { current: SandboxController | null } = { current: null };
    const controller = createSandboxController({
      session: SESSION,
      frameWindow: win,
      postToFrame: (message) => posted.push(message),
      timers: clock.timers,
      onMessage: (message) => {
        if (ref.current === null) return;
        seen.push(`${message.type}:${ref.current.status()}`);
        if (message.type === "loaded") ref.current.send({ type: "play" });
      },
      onFail: () => undefined,
      bundle: BUNDLE,
      meta: META,
      contractVersion: 1,
    });
    ref.current = controller;
    for (const data of [ready(), loaded(), frame(1, true), paused(), frame(2, true), ended()]) {
      controller.handleEvent({ source: win, origin: "null", data });
    }
    expect(seen).toEqual([
      "loaded:ready",
      "frame:playing",
      "paused:paused",
      "frame:playing",
      "ended:paused",
    ]);
    expect(posted.map((message) => message.type)).toEqual(["load", "play"]);
  });

  const phases = ["load", "runtime"] as const;
  const statuses = ["loading", "ready", "playing", "paused"] as const;
  const errorCases = statuses.flatMap((status) => phases.map((phase) => [status, phase] as const));

  it.each(errorCases)("in %s, an error of phase %s fails with that phase", (status, phase) => {
    const h = setup();
    reach(h, status);
    h.deliver(errorMessage(phase));
    expect(h.failures).toEqual([phase]);
    expect(h.controller.status()).toBe("failed");
    expect(h.clock.deadlines()).toEqual([]);
    expect(h.forwarded.some((message) => message.type === "error")).toBe(false);
  });
});

describe("what the controller accepts (Requirement 28.3)", () => {
  it.each([
    ["another object", {}],
    ["null", null],
    ["undefined", undefined],
    ["a string", "window"],
  ])("ignores a message whose source is %s", (_name, source) => {
    const h = setup();
    h.deliver(ready(), { source });
    expect(h.posted).toEqual([]);
    expect(h.clock.deadlines()).toEqual([READY_TIMEOUT_MS]);
  });

  it.each(["", "https://lore.example", "http://localhost:3000", "NULL", "null "])(
    "ignores a message whose origin is %j",
    (origin) => {
      const h = setup();
      h.deliver(ready(), { origin });
      expect(h.posted).toEqual([]);
      expect(h.clock.deadlines()).toEqual([READY_TIMEOUT_MS]);
    },
  );

  it("never matches when the frame window is missing, even for a null source", () => {
    for (const frameWindow of [null, undefined]) {
      const h = setup({ frameWindow });
      h.deliver(ready(), { source: frameWindow });
      expect(h.posted).toEqual([]);
      expect(h.controller.status()).toBe("loading");
    }
  });

  it("changes neither state nor timers for events from a wrong source or origin, and does not count them", () => {
    const h = setup();
    reach(h, "playing");
    h.clock.advance(1000);
    const before = { status: h.controller.status(), deadlines: h.clock.deadlines() };
    const forwarded = h.forwarded.length;
    for (let i = 0; i < 4 * RATE_MAX_MESSAGES; i++) {
      h.deliver(errorMessage("runtime"), { source: {} });
      h.deliver(errorMessage("runtime"), { origin: "https://evil.example" });
    }
    expect({ status: h.controller.status(), deadlines: h.clock.deadlines() }).toEqual(before);
    expect(h.forwarded).toHaveLength(forwarded);
    expect(h.failures).toEqual([]);
    h.deliver(frame(9, true));
    expect(h.failures).toEqual([]);
    expect(h.forwarded).toHaveLength(forwarded + 1);
  });

  const hostile: Array<[string, () => unknown]> = [
    ["null", () => null],
    ["an array", () => [ready()]],
    ["a string", () => "ready"],
    ["a number", () => 7],
    ["an unknown key", () => ({ ...heartbeat(), extra: 1 })],
    ["a wrong source field", () => ({ ...heartbeat(), source: "other" })],
    ["a command meant for the iframe", () => msg("play")],
    ["a frame index out of range", () => frame(900, true)],
    [
      "an object with a throwing getter",
      () =>
        Object.defineProperty({}, "type", {
          get() {
            throw new Error("boom");
          },
          enumerable: true,
        }),
    ],
  ];

  it.each(hostile)("ignores %s without changing state or timers", (_name, make) => {
    const h = setup();
    reach(h, "playing");
    const before = { status: h.controller.status(), deadlines: h.clock.deadlines() };
    const forwarded = h.forwarded.length;
    expect(() => h.deliver(make())).not.toThrow();
    expect({ status: h.controller.status(), deadlines: h.clock.deadlines() }).toEqual(before);
    expect(h.forwarded).toHaveLength(forwarded);
    expect(h.failures).toEqual([]);
  });

  it("ignores messages that carry the session of an earlier iframe", () => {
    const h = setup();
    h.deliver(ready());
    h.deliver(msg("loaded", { duration_in_frames: META.duration_in_frames }, OLD_SESSION));
    expect(h.controller.status()).toBe("loading");
    h.deliver(loaded());
    h.deliver(msg("frame", { frame: 4, playing: true }, OLD_SESSION));
    h.deliver(msg("error", { phase: "runtime", code: "OLD" }, OLD_SESSION));
    expect(h.controller.status()).toBe("ready");
    expect(h.forwarded).toEqual([loaded()]);
    expect(h.failures).toEqual([]);
  });

  it("accepts ready only with an empty session", () => {
    const h = setup();
    h.deliver(msg("ready", {}, SESSION));
    h.deliver(msg("ready", {}, OLD_SESSION));
    expect(h.posted).toEqual([]);
    h.deliver(ready());
    expect(h.posted).toHaveLength(1);
  });

  it("does not accept an empty session on messages other than ready", () => {
    const h = setup();
    h.deliver(ready());
    h.deliver(msg("loaded", { duration_in_frames: META.duration_in_frames }, ""));
    expect(h.controller.status()).toBe("loading");
    h.deliver(msg("error", { phase: "runtime", code: "X" }, ""));
    expect(h.failures).toEqual([]);
  });
});

describe("message rate limit (Requirement 32.11)", () => {
  it("allows 50 messages in 1000 ms and fails with phase runtime on the 51st", () => {
    const h = setup();
    reach(h, "playing"); // 2 messages already counted: ready and loaded; frame makes 3
    const counted = 3;
    for (let i = counted; i < RATE_MAX_MESSAGES; i++) h.deliver(heartbeat());
    expect(h.failures).toEqual([]);
    expect(h.controller.status()).toBe("playing");
    h.deliver(frame(7, true));
    expect(h.failures).toEqual(["runtime"]);
    expect(h.controller.status()).toBe("failed");
    expect(h.clock.deadlines()).toEqual([]);
    expect(h.forwarded.map((message) => message.type)).toEqual(["loaded", "frame"]);
  });

  it("counts messages that fail the schema or the session once they pass source and origin", () => {
    const h = setup();
    for (let i = 0; i < RATE_MAX_MESSAGES; i++) h.deliver("garbage");
    expect(h.failures).toEqual([]);
    h.deliver("garbage");
    expect(h.failures).toEqual(["runtime"]);
  });

  it("slides the window: 30 + 30 inside one second fail, 30 + 30 a second apart do not", () => {
    const over = setup();
    for (let i = 0; i < 30; i++) over.deliver("x");
    over.clock.advance(500);
    for (let i = 0; i < 30; i++) over.deliver("x");
    expect(over.failures).toEqual(["runtime"]);

    const apart = setup();
    for (let i = 0; i < 30; i++) apart.deliver("x");
    apart.clock.advance(1000);
    for (let i = 0; i < 30; i++) apart.deliver("x");
    expect(apart.failures).toEqual([]);
  });

  it("stays quiet for a normal flow: a frame every 100 ms and a heartbeat every second", () => {
    const h = setup();
    reach(h, "playing");
    for (let second = 0; second < 20; second++) {
      for (let tick = 0; tick < 10; tick++) {
        h.clock.advance(100);
        h.deliver(frame(tick, true));
      }
      h.deliver(heartbeat());
    }
    expect(h.failures).toEqual([]);
    expect(h.controller.status()).toBe("playing");
  });
});

describe("send, failed and dispose", () => {
  it.each(["ready", "playing", "paused"] as const)("posts commands with the envelope in %s", (status) => {
    const h = setup();
    reach(h, status);
    h.posted.length = 0;
    h.controller.send({ type: "play" });
    h.controller.send({ type: "pause" });
    h.controller.send({ type: "resume" });
    h.controller.send({ type: "seek", frame: -40 });
    h.controller.send({ type: "setMode", mode: "animate" });
    expect(h.posted).toEqual([
      { ...ENVELOPE, type: "play", session: SESSION },
      { ...ENVELOPE, type: "pause", session: SESSION },
      { ...ENVELOPE, type: "resume", session: SESSION },
      { ...ENVELOPE, type: "seek", session: SESSION, frame: -40 },
      { ...ENVELOPE, type: "setMode", session: SESSION, mode: "animate" },
    ]);
  });

  it("posts a copy, so changing the message afterwards changes nothing that was sent", () => {
    const h = setup();
    reach(h, "ready");
    h.posted.length = 0;
    const body = { type: "seek", frame: 10 } as const;
    h.controller.send(body);
    expect(h.posted[0]).not.toBe(body);
    expect(Object.getPrototypeOf(h.posted[0])).toBe(Object.prototype);
  });

  it("does not post a command while loading, and cannot be used to send load", () => {
    const h = setup();
    h.controller.send({ type: "play" });
    h.deliver(ready());
    h.controller.send({ type: "play" });
    expect(h.posted.map((message) => message.type)).toEqual(["load"]);
    // @ts-expect-error `load` is not a ParentMessageBody: the controller sends it by itself
    h.controller.send({ type: "load" });
  });

  it("ignores every message once failed: no status change, forward, callback or post", () => {
    const h = setup();
    reach(h, "playing");
    h.deliver(errorMessage("runtime"));
    expect(h.failures).toEqual(["runtime"]);
    const forwarded = h.forwarded.length;
    const posted = h.posted.length;
    for (const data of [ready(), loaded(), heartbeat(), frame(1, true), paused(), ended()]) {
      h.deliver(data);
    }
    h.deliver(errorMessage("load"));
    h.controller.send({ type: "play" });
    h.clock.advance(60_000);
    expect(h.controller.status()).toBe("failed");
    expect(h.failures).toEqual(["runtime"]);
    expect(h.forwarded).toHaveLength(forwarded);
    expect(h.posted).toHaveLength(posted);
  });

  it("does not count messages toward the rate limit once failed", () => {
    const h = setup();
    h.deliver(errorMessage("runtime"));
    for (let i = 0; i < 4 * RATE_MAX_MESSAGES; i++) h.deliver("x");
    expect(h.failures).toEqual(["runtime"]);
  });

  it.each(["loading", "ready", "playing", "paused"] as const)(
    "dispose in %s clears every timer, calls nothing and ignores later events",
    (status) => {
      const h = setup();
      reach(h, status);
      const forwarded = h.forwarded.length;
      const posted = h.posted.length;
      h.controller.dispose();
      h.controller.dispose();
      expect(h.clock.deadlines()).toEqual([]);
      expect(h.controller.status()).toBe("failed");
      h.deliver(ready());
      h.deliver(frame(2, true));
      h.deliver(errorMessage("runtime"));
      h.controller.send({ type: "pause" });
      h.clock.advance(60_000);
      expect(h.failures).toEqual([]);
      expect(h.forwarded).toHaveLength(forwarded);
      expect(h.posted).toHaveLength(posted);
    },
  );

  it("dispose after a failure does not call onFail again", () => {
    const h = setup();
    h.clock.advance(READY_TIMEOUT_MS);
    h.controller.dispose();
    expect(h.failures).toEqual(["timeout"]);
  });
});

describe("the load message is checked before it is posted", () => {
  it("fails with phase load, posting nothing, when the bundle exceeds the protocol limit", () => {
    const h = setup({ bundle: "x".repeat(MAX_BUNDLE_CHARS + 1) });
    h.deliver(ready());
    expect(h.failures).toEqual(["load"]);
    expect(h.posted).toEqual([]);
    expect(h.clock.deadlines()).toEqual([]);
  });

  it("posts a bundle of exactly the limit", () => {
    const h = setup({ bundle: "x".repeat(MAX_BUNDLE_CHARS) });
    h.deliver(ready());
    expect(h.failures).toEqual([]);
    expect(h.posted).toHaveLength(1);
  });

  it.each(["", "not-a-session", "A1B2C3D4E5F60718293A4B5C6D7E8F90", SESSION.slice(1)])(
    "fails with phase load, posting nothing, for the session %j",
    (session) => {
      const h = setup({ session });
      h.deliver(ready());
      expect(h.failures).toEqual(["load"]);
      expect(h.posted).toEqual([]);
    },
  );
});
