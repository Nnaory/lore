/**
 * Tests: the deferred `PlayerPort` of the Sandbox_Runtime (task 26.3), design 7.8.
 *
 * `RuntimeController` calls `port.remount()` and then `seekTo`, `play` or `pause` at once, but the
 * real Player is replaced only after React commits. The port must hold those calls and apply them,
 * in order, to the new Player, never to the old one. These tests use a fake Player that records
 * every call, and mimic the real one where it matters: it reports `ended` from inside
 * `seekTo(last)`.
 *
 *   1. without a pending remount the calls go straight through;
 *   2. after `remount()` calls wait, the old Player is not touched, and `getCurrentFrame()` /
 *      `isPlaying()` answer from what the held calls will do;
 *   3. `attach` of the new Player applies the held calls in order and then starts listening;
 *      events caused by those calls are not reported;
 *   4. a second `remount()` before the new Player mounts drops the first batch;
 *   5. before the first Player mounts, calls wait too;
 *   6. listeners follow the current Player only, and report the current frame;
 *   7. a throwing call or listener goes to `onFault` and does not escape.
 */

import { describe, expect, it, vi } from "vitest";
import type { PlayerRef } from "@remotion/player";
import { createDeferredPort } from "../../sandbox-runtime/player-port";

type Listener = (event?: unknown) => void;

/** A Player that records calls and, like the real one, dispatches `ended` from `seekTo(last)`. */
function createFakePlayer(name: string, lastFrame = 99) {
  const calls: string[] = [];
  const listeners = new Map<string, Set<Listener>>();
  const state = { frame: 0, playing: false };
  const emit = (event: string) => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener({ detail: { frame: state.frame } });
  };
  const player = {
    play: () => {
      calls.push("play");
      state.playing = true;
    },
    pause: () => {
      calls.push("pause");
      state.playing = false;
    },
    seekTo: (frame: number) => {
      calls.push(`seekTo(${frame})`);
      state.frame = frame;
      if (frame === lastFrame) emit("ended");
    },
    getCurrentFrame: () => state.frame,
    isPlaying: () => state.playing,
    addEventListener: (event: string, listener: Listener) => {
      calls.push(`on:${event}`);
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    },
    removeEventListener: (event: string, listener: Listener) => {
      calls.push(`off:${event}`);
      listeners.get(event)?.delete(listener);
    },
  };
  return {
    name,
    player: player as unknown as PlayerRef,
    calls,
    state,
    emit,
    listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
  };
}

type FakePlayer = ReturnType<typeof createFakePlayer>;

function createHarness() {
  const frames: number[] = [];
  const faults: unknown[] = [];
  const counters = { ended: 0, remounts: 0 };
  const deferred = createDeferredPort({
    requestRemount: () => {
      counters.remounts += 1;
    },
    onFrame: (frame) => frames.push(frame),
    onEnded: () => {
      counters.ended += 1;
    },
    onFault: (error) => faults.push(error),
  });
  return { ...deferred, frames, faults, counters };
}

/** The usual React sequence for a remount: the old Player unmounts, the new one mounts. */
function swapPlayer(h: ReturnType<typeof createHarness>, next: FakePlayer): void {
  h.attach(null);
  h.attach(next.player);
}

describe("deferred port: no remount pending", () => {
  it("passes calls straight to the mounted Player", () => {
    const h = createHarness();
    const a = createFakePlayer("a");
    h.attach(a.player);
    a.calls.length = 0;
    h.port.seekTo(5);
    h.port.play();
    h.port.pause();
    expect(a.calls).toEqual(["seekTo(5)", "play", "pause"]);
  });

  it("answers getCurrentFrame and isPlaying from the Player", () => {
    const h = createHarness();
    const a = createFakePlayer("a");
    h.attach(a.player);
    a.state.frame = 42;
    a.state.playing = true;
    expect(h.port.getCurrentFrame()).toBe(42);
    expect(h.port.isPlaying()).toBe(true);
  });

  it("starts listening only to the mounted Player", () => {
    const h = createHarness();
    const a = createFakePlayer("a");
    h.attach(a.player);
    expect(a.listenerCount("frameupdate")).toBe(1);
    expect(a.listenerCount("ended")).toBe(1);
  });
});

describe("deferred port: remount", () => {
  it("asks the host for a new Player once per call", () => {
    const h = createHarness();
    h.attach(createFakePlayer("a").player);
    h.port.remount();
    expect(h.counters.remounts).toBe(1);
    h.port.remount();
    expect(h.counters.remounts).toBe(2);
  });

  it("holds calls: the old Player is not touched, the new one gets them in order", () => {
    const h = createHarness();
    const a = createFakePlayer("a");
    const b = createFakePlayer("b");
    h.attach(a.player);
    a.calls.length = 0;

    h.port.remount();
    h.port.seekTo(0);
    h.port.play();
    expect(a.calls).toEqual([]);
    expect(b.calls).toEqual([]);

    swapPlayer(h, b);
    expect(a.calls).toEqual(["off:frameupdate", "off:ended"]);
    expect(b.calls.filter((call) => !call.startsWith("on:"))).toEqual(["seekTo(0)", "play"]);
    expect(b.state).toEqual({ frame: 0, playing: true });
  });

  it("applies the held calls before it starts listening", () => {
    const h = createHarness();
    const b = createFakePlayer("b");
    h.attach(createFakePlayer("a").player);
    h.port.remount();
    h.port.seekTo(7);
    h.port.pause();
    swapPlayer(h, b);
    expect(b.calls).toEqual(["seekTo(7)", "pause", "on:frameupdate", "on:ended"]);
  });

  it("goes straight through again once the new Player has mounted", () => {
    const h = createHarness();
    const b = createFakePlayer("b");
    h.attach(createFakePlayer("a").player);
    h.port.remount();
    h.port.play();
    swapPlayer(h, b);
    b.calls.length = 0;
    h.port.pause();
    h.port.seekTo(3);
    expect(b.calls).toEqual(["pause", "seekTo(3)"]);
  });

  it("answers from the held calls while it waits", () => {
    const h = createHarness();
    const a = createFakePlayer("a");
    a.state.frame = 50;
    a.state.playing = true;
    h.attach(a.player);

    h.port.remount();
    expect(h.port.getCurrentFrame()).toBe(0);
    expect(h.port.isPlaying()).toBe(false);

    h.port.seekTo(99);
    expect(h.port.getCurrentFrame()).toBe(99);
    h.port.play();
    expect(h.port.isPlaying()).toBe(true);
    h.port.pause();
    expect(h.port.isPlaying()).toBe(false);
    // The stale Player was never asked or told anything.
    expect(a.state).toEqual({ frame: 50, playing: true });
  });

  it("a second remount drops the calls held for the first", () => {
    const h = createHarness();
    const b = createFakePlayer("b");
    h.attach(createFakePlayer("a").player);
    h.port.remount();
    h.port.seekTo(80);
    h.port.play();
    h.port.remount();
    h.port.seekTo(1);
    swapPlayer(h, b);
    expect(b.calls.filter((call) => !call.startsWith("on:"))).toEqual(["seekTo(1)"]);
    expect(b.state.playing).toBe(false);
  });

  it("does not report the ended that its own seekTo(last) causes", () => {
    const h = createHarness();
    const b = createFakePlayer("b", 99);
    h.attach(createFakePlayer("a").player);
    h.port.remount();
    h.port.seekTo(99);
    h.port.pause();
    swapPlayer(h, b);
    expect(h.counters.ended).toBe(0);
  });
});

describe("deferred port: before the first Player", () => {
  it("holds calls until the first Player mounts", () => {
    const h = createHarness();
    const a = createFakePlayer("a");
    h.port.seekTo(4);
    h.port.play();
    expect(h.port.getCurrentFrame()).toBe(4);
    expect(h.port.isPlaying()).toBe(true);
    h.attach(a.player);
    expect(a.calls.filter((call) => !call.startsWith("on:"))).toEqual(["seekTo(4)", "play"]);
  });

  it("after the last Player unmounts, calls wait instead of reaching a dead Player", () => {
    const h = createHarness();
    const a = createFakePlayer("a");
    h.attach(a.player);
    h.attach(null);
    a.calls.length = 0;
    h.port.play();
    expect(a.calls).toEqual([]);
  });
});

describe("deferred port: events", () => {
  it("reports the Player's current frame on frameupdate, not the number in the event", () => {
    const h = createHarness();
    const a = createFakePlayer("a");
    h.attach(a.player);
    a.state.frame = 12;
    a.emit("frameupdate");
    expect(h.frames).toEqual([12]);
  });

  it("reports ended", () => {
    const h = createHarness();
    const a = createFakePlayer("a");
    h.attach(a.player);
    a.emit("ended");
    expect(h.counters.ended).toBe(1);
  });

  it("stops listening to a Player that was replaced", () => {
    const h = createHarness();
    const a = createFakePlayer("a");
    const b = createFakePlayer("b");
    h.attach(a.player);
    h.port.remount();
    swapPlayer(h, b);
    expect(a.listenerCount("frameupdate")).toBe(0);
    expect(a.listenerCount("ended")).toBe(0);
    a.emit("frameupdate");
    a.emit("ended");
    expect(h.frames).toEqual([]);
    expect(h.counters.ended).toBe(0);
    b.state.frame = 3;
    b.emit("frameupdate");
    expect(h.frames).toEqual([3]);
  });

  it("stops listening when the Player unmounts", () => {
    const h = createHarness();
    const a = createFakePlayer("a");
    h.attach(a.player);
    h.attach(null);
    expect(a.listenerCount("frameupdate")).toBe(0);
    expect(a.listenerCount("ended")).toBe(0);
  });

  it("does not stack listeners when the same Player is attached again", () => {
    const h = createHarness();
    const a = createFakePlayer("a");
    h.attach(a.player);
    h.attach(a.player);
    expect(a.listenerCount("frameupdate")).toBe(1);
  });
});

describe("deferred port: failures", () => {
  it("reports a held call that throws and does not listen to that Player", () => {
    const h = createHarness();
    const b = createFakePlayer("b");
    (b.player as unknown as { play: () => void }).play = () => {
      throw new Error("play failed");
    };
    h.attach(createFakePlayer("a").player);
    h.port.remount();
    h.port.play();
    h.port.seekTo(9);
    expect(() => swapPlayer(h, b)).not.toThrow();
    expect(h.faults).toHaveLength(1);
    expect((h.faults[0] as Error).message).toBe("play failed");
    // The calls after the failing one were not applied.
    expect(b.calls).not.toContain("seekTo(9)");
    expect(b.listenerCount("frameupdate")).toBe(0);
  });

  it("reports a listener that throws, and the other listener still works", () => {
    const faults: unknown[] = [];
    const deferred = createDeferredPort({
      requestRemount: () => {},
      onFrame: () => {
        throw new Error("frame handler failed");
      },
      onEnded: vi.fn(),
      onFault: (error) => faults.push(error),
    });
    const a = createFakePlayer("a");
    deferred.attach(a.player);
    expect(() => a.emit("frameupdate")).not.toThrow();
    expect(faults).toHaveLength(1);
    a.emit("ended");
    expect(faults).toHaveLength(1);
  });

  it("lets a direct call that throws reach the caller (the runtime wraps the controller)", () => {
    const h = createHarness();
    const a = createFakePlayer("a");
    (a.player as unknown as { pause: () => void }).pause = () => {
      throw new Error("pause failed");
    };
    h.attach(a.player);
    expect(() => h.port.pause()).toThrow("pause failed");
    expect(h.faults).toEqual([]);
  });

  it("survives a Player whose removeEventListener throws", () => {
    const h = createHarness();
    const a = createFakePlayer("a");
    (a.player as unknown as { removeEventListener: () => void }).removeEventListener = () => {
      throw new Error("gone");
    };
    h.attach(a.player);
    expect(() => h.attach(null)).not.toThrow();
  });
});
