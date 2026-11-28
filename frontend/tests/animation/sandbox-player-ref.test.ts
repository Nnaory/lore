/**
 * Tests: PlayerLike and SandboxPlayerRef (task 25.4), design 7.6 and 7.7, Requirements 30.1,
 * 30.2, 30.3 and 39.7.
 *
 * The adaptor is pure logic over `{ send, status }`, so most tests give it a fake source whose
 * status they set by hand. Two groups use real collaborators instead: the real
 * SandboxController (so the queue is proven against a controller that really refuses to send
 * while `loading`, and against the real "status first, then `onMessage`" order), and the real
 * `useCanvasPlayback` hook (the PlayerBar's data path).
 *
 *   1. commands: each method becomes one protocol message; `seekTo` input is made safe;
 *   2. events: `frame`, `paused`, `ended` map to `frameupdate`, `play`, `pause`, `ended`;
 *   3. listeners: add, remove, duplicates, removal during emit, a throwing listener;
 *   4. the 16-call queue before `loaded`;
 *   5. `failed` and `dispose`;
 *   6. with the real SandboxController;
 *   7. with `useCanvasPlayback`, plus the type-level check that `PlayerRef` is a `PlayerLike`.
 *
 * @vitest-environment jsdom
 */

import type { PlayerRef } from "@remotion/player";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { FrameMessage, ParentMessage } from "@/lib/animation/protocol";
import {
  createSandboxController,
  type ParentMessageBody,
  type SandboxStatus,
} from "@/lib/animation/sandbox-controller";
import {
  PLAYER_REF_QUEUE_MAX,
  createSandboxPlayerRef,
  type SandboxPlayerRef,
  type SandboxPlayerRefHandle,
} from "@/lib/animation/sandbox-player-ref";
import type { PlayerEventName, PlayerLike } from "@/lib/stage/player-like";
import { useCanvasPlayback } from "@/lib/stage/use-canvas-playback";

const SESSION = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const ENVELOPE = { source: "lore-sandbox", version: 1, session: SESSION } as const;
const META = { width: 1280, height: 720, fps: 30, duration_in_frames: 210, pause_at_frame: 180 };

const loaded = (): FrameMessage => ({ ...ENVELOPE, type: "loaded", duration_in_frames: 210 });
const frame = (index: number, playing: boolean): FrameMessage => ({
  ...ENVELOPE,
  type: "frame",
  frame: index,
  playing,
});
const paused = (index = 180): FrameMessage => ({
  ...ENVELOPE,
  type: "paused",
  reason: "interaction",
  frame: index,
});
const ended = (): FrameMessage => ({ ...ENVELOPE, type: "ended" });

/** A source whose status the test sets, recording every message the adaptor sends. */
function fakeSource(initial: SandboxStatus = "ready") {
  const sent: ParentMessageBody[] = [];
  let status = initial;
  const ref = createSandboxPlayerRef({
    send: (message) => sent.push(message),
    status: () => status,
  });
  return {
    ref,
    sent,
    setStatus: (next: SandboxStatus) => {
      status = next;
    },
  };
}

type Recorded = [PlayerEventName, unknown];

/** Listens to all four events and returns the log, in arrival order. */
function record(ref: PlayerLike): Recorded[] {
  const log: Recorded[] = [];
  ref.addEventListener("frameupdate", (e) => log.push(["frameupdate", e.detail]));
  ref.addEventListener("play", (e) => log.push(["play", e.detail]));
  ref.addEventListener("pause", (e) => log.push(["pause", e.detail]));
  ref.addEventListener("ended", (e) => log.push(["ended", e.detail]));
  return log;
}

describe("commands", () => {
  it("turns play, pause, seekTo, resume and setMode into one message each", () => {
    const { ref, sent } = fakeSource("ready");
    ref.play();
    ref.pause();
    ref.seekTo(42);
    ref.resume();
    ref.setMode("fast");
    ref.setMode("animate");
    expect(sent).toEqual([
      { type: "play" },
      { type: "pause" },
      { type: "seek", frame: 42 },
      { type: "resume" },
      { type: "setMode", mode: "fast" },
      { type: "setMode", mode: "animate" },
    ]);
  });

  it("sends commands in every live status", () => {
    for (const status of ["ready", "playing", "paused"] as const) {
      const { ref, sent } = fakeSource(status);
      ref.play();
      expect(sent).toEqual([{ type: "play" }]);
    }
  });

  it("sends seek frames the protocol accepts, and drops the ones it cannot", () => {
    const { ref, sent } = fakeSource("ready");
    ref.seekTo(12.9);
    ref.seekTo(-0.5);
    ref.seekTo(-7);
    ref.seekTo(Number.NaN);
    ref.seekTo(Number.POSITIVE_INFINITY);
    ref.seekTo(1e300);
    ref.seekTo(-1e300);
    const frames = sent.map((message) => (message.type === "seek" ? message.frame : null));
    expect(frames).toEqual([12, 0, -7, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER]);
    expect(Object.is(frames[1], 0)).toBe(true);
  });
});

describe("events", () => {
  it("emits frameupdate with the frame for every frame message", () => {
    const { ref } = fakeSource();
    const log = record(ref);
    ref.onFrameMessage(frame(0, false));
    ref.onFrameMessage(frame(7, false));
    expect(log).toEqual([
      ["frameupdate", { frame: 0 }],
      ["frameupdate", { frame: 7 }],
    ]);
  });

  it("emits play and pause only when the playing flag changes, after frameupdate", () => {
    const { ref } = fakeSource();
    const log = record(ref);
    ref.onFrameMessage(frame(1, true));
    ref.onFrameMessage(frame(2, true));
    ref.onFrameMessage(frame(3, false));
    ref.onFrameMessage(frame(3, false));
    ref.onFrameMessage(frame(4, true));
    expect(log.map(([name]) => name)).toEqual([
      "frameupdate",
      "play",
      "frameupdate",
      "frameupdate",
      "pause",
      "frameupdate",
      "frameupdate",
      "play",
    ]);
  });

  it("gives play, pause and ended no detail, like the Remotion player", () => {
    const { ref } = fakeSource();
    const log = record(ref);
    ref.onFrameMessage(frame(1, true));
    ref.onFrameMessage(ended());
    expect(log).toEqual([
      ["frameupdate", { frame: 1 }],
      ["play", undefined],
      ["pause", undefined],
      ["ended", undefined],
    ]);
  });

  it("emits pause for a paused message only while playing", () => {
    const { ref } = fakeSource();
    const log = record(ref);
    ref.onFrameMessage(paused());
    expect(log).toEqual([]);
    ref.onFrameMessage(frame(180, true));
    log.length = 0;
    ref.onFrameMessage(paused());
    ref.onFrameMessage(paused());
    expect(log.map(([name]) => name)).toEqual(["pause"]);
  });

  it("emits pause then ended for ended while playing, and only ended otherwise", () => {
    const { ref } = fakeSource();
    const log = record(ref);
    ref.onFrameMessage(frame(209, true));
    log.length = 0;
    ref.onFrameMessage(ended());
    expect(log.map(([name]) => name)).toEqual(["pause", "ended"]);
    log.length = 0;
    ref.onFrameMessage(ended());
    expect(log.map(([name]) => name)).toEqual(["ended"]);
  });

  it("emits play again after a pause, so replay after ended is seen", () => {
    const { ref } = fakeSource();
    const log = record(ref);
    ref.onFrameMessage(frame(209, true));
    ref.onFrameMessage(ended());
    log.length = 0;
    ref.onFrameMessage(frame(0, true));
    expect(log.map(([name]) => name)).toEqual(["frameupdate", "play"]);
  });

  it("emits nothing for loaded", () => {
    const { ref } = fakeSource();
    const log = record(ref);
    ref.onFrameMessage(loaded());
    expect(log).toEqual([]);
  });
});

describe("listeners", () => {
  it("stops calling a removed listener and calls a duplicate once", () => {
    const { ref } = fakeSource();
    const seen: number[] = [];
    const listener = (e: { detail: { frame: number } }) => seen.push(e.detail.frame);
    ref.addEventListener("frameupdate", listener);
    ref.addEventListener("frameupdate", listener);
    ref.onFrameMessage(frame(1, false));
    ref.removeEventListener("frameupdate", listener);
    ref.onFrameMessage(frame(2, false));
    expect(seen).toEqual([1]);
  });

  it("lets a listener remove another during emit, and the removed one is skipped", () => {
    const { ref } = fakeSource();
    const calls: string[] = [];
    const second = () => calls.push("second");
    ref.addEventListener("frameupdate", () => {
      calls.push("first");
      ref.removeEventListener("frameupdate", second);
    });
    ref.addEventListener("frameupdate", second);
    ref.onFrameMessage(frame(1, false));
    expect(calls).toEqual(["first"]);
  });

  it("keeps calling the other listeners when one throws", () => {
    const { ref } = fakeSource();
    const calls: string[] = [];
    ref.addEventListener("frameupdate", () => {
      throw new Error("boom");
    });
    ref.addEventListener("frameupdate", () => calls.push("after"));
    expect(() => ref.onFrameMessage(frame(1, false))).not.toThrow();
    expect(calls).toEqual(["after"]);
  });
});

describe("queue before loaded", () => {
  it("holds calls while loading and sends them in order when loaded arrives", () => {
    const { ref, sent, setStatus } = fakeSource("loading");
    ref.setMode("fast");
    ref.seekTo(5);
    ref.play();
    ref.resume();
    expect(sent).toEqual([]);
    setStatus("ready");
    ref.onFrameMessage(loaded());
    expect(sent).toEqual([
      { type: "setMode", mode: "fast" },
      { type: "seek", frame: 5 },
      { type: "play" },
      { type: "resume" },
    ]);
  });

  it("sends the queue only once", () => {
    const { ref, sent, setStatus } = fakeSource("loading");
    ref.play();
    setStatus("ready");
    ref.onFrameMessage(loaded());
    ref.onFrameMessage(loaded());
    expect(sent).toEqual([{ type: "play" }]);
  });

  it("keeps the newest 16 and drops the oldest when the queue is full", () => {
    expect(PLAYER_REF_QUEUE_MAX).toBe(16);
    const { ref, sent, setStatus } = fakeSource("loading");
    for (let index = 0; index < 20; index += 1) ref.seekTo(index);
    setStatus("ready");
    ref.onFrameMessage(loaded());
    expect(sent.map((message) => (message.type === "seek" ? message.frame : null))).toEqual(
      Array.from({ length: 16 }, (_, index) => index + 4),
    );
  });

  it("sends a call made right after loaded behind any queued one", () => {
    const { ref, sent, setStatus } = fakeSource("loading");
    ref.setMode("animate");
    setStatus("ready");
    ref.play();
    expect(sent).toEqual([{ type: "setMode", mode: "animate" }, { type: "play" }]);
  });

  it("discards the queue when the frame fails before loaded", () => {
    const { ref, sent, setStatus } = fakeSource("loading");
    ref.play();
    ref.pause();
    setStatus("failed");
    ref.onFrameMessage(loaded());
    expect(sent).toEqual([]);
  });
});

describe("failed", () => {
  it("ignores every call without a message", () => {
    const { ref, sent } = fakeSource("failed");
    ref.play();
    ref.pause();
    ref.seekTo(3);
    ref.resume();
    ref.setMode("fast");
    expect(sent).toEqual([]);
  });

  it("emits no event for a message that arrives while failed", () => {
    const { ref } = fakeSource("failed");
    const log = record(ref);
    ref.onFrameMessage(frame(1, true));
    ref.onFrameMessage(ended());
    expect(log).toEqual([]);
  });

  it("emits nothing once the status turns failed, even to listeners added earlier", () => {
    const { ref, setStatus } = fakeSource("ready");
    const log = record(ref);
    setStatus("failed");
    ref.onFrameMessage(frame(1, true));
    expect(log).toEqual([]);
  });
});

describe("dispose", () => {
  it("removes all listeners and ignores later messages", () => {
    const { ref } = fakeSource();
    const log = record(ref);
    ref.dispose();
    ref.onFrameMessage(frame(1, true));
    ref.onFrameMessage(ended());
    expect(log).toEqual([]);
  });

  it("ignores later calls, drops the queue and refuses new listeners", () => {
    const { ref, sent, setStatus } = fakeSource("loading");
    ref.play();
    ref.dispose();
    setStatus("ready");
    ref.pause();
    ref.onFrameMessage(loaded());
    const log = record(ref);
    ref.onFrameMessage(frame(1, true));
    expect(sent).toEqual([]);
    expect(log).toEqual([]);
  });

  it("can be called twice and lets removeEventListener run afterwards", () => {
    const { ref } = fakeSource();
    ref.dispose();
    expect(() => {
      ref.dispose();
      ref.removeEventListener("play", () => {});
    }).not.toThrow();
  });
});

describe("with the real SandboxController", () => {
  const FRAME_WINDOW = { name: "iframe" };

  function realSetup() {
    const posted: ParentMessage[] = [];
    const failures: string[] = [];
    const holder: { ref: SandboxPlayerRefHandle | null } = { ref: null };
    const controller = createSandboxController({
      session: SESSION,
      frameWindow: FRAME_WINDOW,
      postToFrame: (message) => posted.push(message),
      timers: { set: () => 1, clear: () => {}, now: () => 0 },
      onMessage: (message) => holder.ref?.onFrameMessage(message),
      onFail: (phase) => failures.push(phase),
      bundle: '"use strict";',
      meta: META,
      contractVersion: 1,
    });
    const ref = createSandboxPlayerRef(controller);
    holder.ref = ref;
    const deliver = (data: unknown) =>
      controller.handleEvent({ source: FRAME_WINDOW, origin: "null", data });
    const readyMessage = { source: "lore-sandbox", version: 1, type: "ready", session: "" };
    return { ref, posted, failures, deliver, readyMessage, controller };
  }

  it("keeps commands back until loaded, then posts them with the session", () => {
    const { ref, posted, deliver, readyMessage } = realSetup();
    deliver(readyMessage);
    expect(posted.map((message) => message.type)).toEqual(["load"]);
    ref.setMode("fast");
    ref.seekTo(10);
    ref.play();
    expect(posted.map((message) => message.type)).toEqual(["load"]);
    deliver(loaded());
    expect(posted.map((message) => message.type)).toEqual(["load", "setMode", "seek", "play"]);
    expect(posted[1]).toEqual({ ...ENVELOPE, type: "setMode", mode: "fast" });
    expect(posted[2]).toEqual({ ...ENVELOPE, type: "seek", frame: 10 });
    ref.pause();
    expect(posted[4]).toEqual({ ...ENVELOPE, type: "pause" });
  });

  it("turns the runtime's frame messages into events through the controller", () => {
    const { ref, deliver, readyMessage } = realSetup();
    const log = record(ref);
    deliver(readyMessage);
    deliver(loaded());
    deliver(frame(30, true));
    deliver(paused(31));
    expect(log).toEqual([
      ["frameupdate", { frame: 30 }],
      ["play", undefined],
      ["pause", undefined],
    ]);
  });

  it("goes quiet when the controller fails", () => {
    const { ref, posted, failures, deliver, readyMessage } = realSetup();
    const log = record(ref);
    deliver(readyMessage);
    deliver(loaded());
    deliver({ ...ENVELOPE, type: "error", phase: "runtime", code: "RENDER_THROW" });
    expect(failures).toEqual(["runtime"]);
    const before = posted.length;
    ref.play();
    ref.seekTo(1);
    deliver(frame(5, true));
    expect(posted).toHaveLength(before);
    expect(log).toEqual([]);
  });
});

describe("with useCanvasPlayback", () => {
  function mountHook() {
    const source = fakeSource("ready");
    const view = renderHook(() => useCanvasPlayback(210, 30));
    act(() => view.result.current.playerRef(source.ref));
    return { ...view, ref: source.ref };
  }

  it("follows frameupdate, play, pause and ended from the sandbox", () => {
    const { result, ref } = mountHook();
    expect(result.current).toMatchObject({ playing: false, ended: false, time: "0:00" });

    act(() => ref.onFrameMessage(frame(45, true)));
    expect(result.current.playing).toBe(true);
    expect(result.current.time).toBe("0:01");
    expect(result.current.progress).toBeCloseTo((45 / 210) * 100, 5);

    act(() => ref.onFrameMessage(paused(90)));
    expect(result.current.playing).toBe(false);

    act(() => ref.onFrameMessage(frame(209, true)));
    act(() => ref.onFrameMessage(ended()));
    expect(result.current.playing).toBe(false);
    expect(result.current.ended).toBe(true);

    act(() => ref.onFrameMessage(frame(0, true)));
    expect(result.current.playing).toBe(true);
    expect(result.current.ended).toBe(false);
  });

  it("stops listening when the player ref is cleared", () => {
    const { result, ref } = mountHook();
    act(() => result.current.playerRef(null));
    act(() => ref.onFrameMessage(frame(100, true)));
    expect(result.current.playing).toBe(false);
    expect(result.current.time).toBe("0:00");
  });

  it("stops listening after dispose", () => {
    const { result, ref } = mountHook();
    act(() => ref.dispose());
    act(() => ref.onFrameMessage(frame(100, true)));
    expect(result.current.playing).toBe(false);
  });
});

describe("PlayerLike", () => {
  it("is satisfied by a Remotion PlayerRef and by a SandboxPlayerRef (checked by tsc)", () => {
    const fromRemotion = (player: PlayerRef): PlayerLike => player;
    const fromSandbox = (player: SandboxPlayerRef): PlayerLike => player;
    expect(typeof fromRemotion).toBe("function");
    expect(typeof fromSandbox).toBe("function");
  });
});
