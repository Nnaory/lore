// @vitest-environment jsdom
/**
 * Tests: SandboxFrame (task 27.1), design 7.7, Requirements 27.1, 27.8, 27.14, 28.3, 28.5, 28.9.
 *
 * The iframe's window is fake (`tests/fixtures/sandbox-harness.ts`), so nothing here proves how a
 * real browser treats `sandbox="allow-scripts"`: [belum diverifikasi] `window.origin === "null"`
 * inside the iframe, `event.source === window.parent` there, and that the page loads under the
 * policy in Chromium and Firefox. That is the manual checklist of Requirement 27.9.
 *
 *   1. the iframe element: attributes, visibility, no `display: none`;
 *   2. the handshake: `load` is posted to target origin `*`, with a new Session_Id per mount;
 *   3. what is refused: another source, another origin, a bad message, another session;
 *   4. forwarding: `ref.onFrameMessage` sees a message before `onMessage` does;
 *   5. failure: the ref is disposed, the iframe leaves the DOM, `onFail` is called once;
 *   6. unmount: no callback and no `postMessage` afterwards;
 *   7. a missing `contentWindow` and a throwing `postMessage`.
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxFrame, type SandboxFrameProps } from "@/components/animation/SandboxFrame";
import policy from "@/lib/animation/sandbox-policy.json";
import type { SandboxPlayerRefHandle } from "@/lib/animation/sandbox-player-ref";
import { createSandboxHarness, type SandboxHarness } from "../fixtures/sandbox-harness";

const META = { width: 1280, height: 720, fps: 30, duration_in_frames: 210, pause_at_frame: 150 };
const BUNDLE = '"use strict";module.exports.default=function(){return null};';

let harness: SandboxHarness;

beforeEach(() => {
  vi.useFakeTimers();
  harness = createSandboxHarness();
});

afterEach(() => {
  cleanup();
  harness.restore();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup(overrides: Partial<SandboxFrameProps> = {}) {
  const log: string[] = [];
  const players: SandboxPlayerRefHandle[] = [];
  const props: SandboxFrameProps = {
    bundle: BUNDLE,
    meta: META,
    contractVersion: 1,
    hidden: true,
    onPlayerRef: vi.fn((ref: SandboxPlayerRefHandle) => {
      players.push(ref);
    }),
    onMessage: vi.fn((message) => log.push(`onMessage:${message.type}`)),
    onFail: vi.fn(),
    ...overrides,
  };
  const view = render(<SandboxFrame {...props} />);
  return { props, view, log, players };
}

/** The frame is live: `ready` answered by `load`, then `loaded`. */
function bringUp(durationInFrames = META.duration_in_frames) {
  harness.ready();
  harness.loaded(durationInFrames);
}

describe("the iframe element", () => {
  it("has exactly the attributes of the policy and nothing that widens the sandbox", () => {
    setup();
    const iframe = screen.getByTestId("sandbox-frame");
    expect(iframe.tagName).toBe("IFRAME");
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.getAttribute("sandbox")).toBe(policy.sandbox_attribute);
    expect(iframe.getAttribute("src")).toBe("/sandbox/runtime.html");
    expect(iframe.getAttribute("src")).toBe(policy.src);
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(iframe.getAttribute("title")?.trim().length).toBeGreaterThan(0);
    expect(iframe.getAttribute("tabindex")).toBe("-1");
    expect((iframe as HTMLIFrameElement).style.pointerEvents).toBe("none");
    for (const token of [
      "allow-same-origin",
      "allow-top-navigation",
      "allow-popups",
      "allow-forms",
      "allow-modals",
    ]) {
      expect(iframe.getAttribute("sandbox")).not.toContain(token);
    }
  });

  it("hides with visibility, never with display, and keeps the same element", () => {
    const { props, view } = setup({ hidden: true });
    const iframe = screen.getByTestId("sandbox-frame") as HTMLIFrameElement;
    expect(iframe.style.visibility).toBe("hidden");
    expect(iframe.style.display).not.toBe("none");

    view.rerender(<SandboxFrame {...props} hidden={false} />);
    expect(screen.getByTestId("sandbox-frame")).toBe(iframe);
    expect(iframe.style.visibility).toBe("visible");
    expect(iframe.style.display).not.toBe("none");
  });

  it("hands the player ref to the owner once, at mount", () => {
    const { props, players } = setup();
    expect(props.onPlayerRef).toHaveBeenCalledTimes(1);
    expect(players).toHaveLength(1);
  });
});

describe("the handshake", () => {
  it("posts nothing until the runtime says ready", () => {
    setup();
    expect(harness.posted()).toEqual([]);
  });

  it("answers ready with load, to target origin *, carrying the bundle, meta and a Session_Id", () => {
    setup({ contractVersion: 1 });
    harness.ready();
    const loads = harness.postedOfType("load");
    expect(loads).toHaveLength(1);
    expect(loads[0]).toEqual({
      source: "lore-sandbox",
      version: 1,
      type: "load",
      session: expect.stringMatching(/^[0-9a-f]{32}$/),
      bundle: BUNDLE,
      meta: META,
      contract_version: 1,
    });
    expect(harness.targets()).toEqual(["*"]);
  });

  it("uses a new Session_Id for every mount and ignores messages of an earlier one", () => {
    const first = setup();
    harness.ready();
    const oldSession = harness.session();
    first.view.unmount();

    const second = setup();
    harness.fakeWindow.postMessage.mockClear();
    harness.ready();
    const newSession = harness.session();
    expect(newSession).not.toBe(oldSession);

    harness.deliver(harness.build("loaded", { duration_in_frames: META.duration_in_frames }, oldSession));
    expect(second.props.onMessage).not.toHaveBeenCalled();
    harness.deliver(harness.build("loaded", { duration_in_frames: META.duration_in_frames }, newSession));
    expect(second.props.onMessage).toHaveBeenCalledTimes(1);
  });

  it("fails with phase load when the bundle or meta could never be accepted by the runtime", () => {
    const { props } = setup({ meta: { ...META, duration_in_frames: 5 } });
    harness.ready();
    expect(harness.postedOfType("load")).toEqual([]);
    expect(props.onFail).toHaveBeenCalledWith("load");
  });
});

describe("what is refused", () => {
  it("ignores another source, another origin, bad data and another session", () => {
    const { props } = setup();
    harness.ready();
    const good = harness.build("loaded", { duration_in_frames: META.duration_in_frames });

    harness.deliver(good, { source: {} });
    harness.deliver(good, { source: null });
    harness.deliver(good, { origin: "https://evil.example" });
    harness.deliver(good, { origin: "" });
    harness.deliver({ ...good, extra: 1 });
    harness.deliver("loaded");
    harness.deliver(null);
    harness.deliver(harness.build("loaded", { duration_in_frames: META.duration_in_frames }, "f".repeat(32)));
    expect(props.onMessage).not.toHaveBeenCalled();
    expect(props.onFail).not.toHaveBeenCalled();

    harness.deliver(good);
    expect(props.onMessage).toHaveBeenCalledTimes(1);
  });
});

describe("forwarding", () => {
  it("gives a message to the ref before the owner and passes loaded, frame, paused and ended", () => {
    const { log, players } = setup();
    players[0]!.addEventListener("frameupdate", () => log.push("ref:frameupdate"));
    players[0]!.addEventListener("pause", () => log.push("ref:pause"));
    players[0]!.addEventListener("ended", () => log.push("ref:ended"));

    bringUp();
    harness.frame(10, true);
    harness.frame(20, false);
    harness.paused("interaction", 150);
    harness.ended();

    expect(log).toEqual([
      "onMessage:loaded",
      "ref:frameupdate",
      "onMessage:frame",
      "ref:frameupdate",
      "ref:pause",
      "onMessage:frame",
      "onMessage:paused",
      "ref:ended",
      "onMessage:ended",
    ]);
  });

  it("sends the commands of the player ref to the iframe once it is live", () => {
    const { players } = setup();
    bringUp();
    players[0]!.setMode("fast");
    players[0]!.resume();
    const sent = harness.posted().filter((m) => m.type !== "load");
    expect(sent).toEqual([
      expect.objectContaining({ type: "setMode", mode: "fast", session: harness.session() }),
      expect.objectContaining({ type: "resume", session: harness.session() }),
    ]);
    expect(harness.targets().every((target) => target === "*")).toBe(true);
  });
});

describe("failure", () => {
  it("removes the iframe, disposes the ref and calls onFail once on an error message", () => {
    const { props, players } = setup();
    bringUp();
    const frameupdate = vi.fn();
    players[0]!.addEventListener("frameupdate", frameupdate);

    harness.error("runtime");
    expect(props.onFail).toHaveBeenCalledTimes(1);
    expect(props.onFail).toHaveBeenCalledWith("runtime");
    expect(screen.queryByTestId("sandbox-frame")).toBeNull();

    // Disposed: no listener is called and no command is posted.
    const before = harness.posted().length;
    players[0]!.play();
    expect(harness.posted()).toHaveLength(before);
    harness.frame(3, true);
    harness.error("load");
    expect(frameupdate).not.toHaveBeenCalled();
    expect(props.onFail).toHaveBeenCalledTimes(1);
  });

  it("fails with the phase the runtime reports for an error before loaded", () => {
    const { props } = setup();
    harness.ready();
    harness.error("load", "CONTRACT_INVALID");
    expect(props.onFail).toHaveBeenCalledWith("load");
    expect(screen.queryByTestId("sandbox-frame")).toBeNull();
  });

  it("fails with a different duration in loaded, with phase load", () => {
    const { props } = setup();
    bringUp(META.duration_in_frames + 1);
    expect(props.onFail).toHaveBeenCalledWith("load");
  });

  it("times out when the runtime never says ready (8000 ms)", () => {
    const { props } = setup();
    act(() => {
      vi.advanceTimersByTime(7999);
    });
    expect(props.onFail).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(props.onFail).toHaveBeenCalledTimes(1);
    expect(props.onFail).toHaveBeenCalledWith("timeout");
    expect(screen.queryByTestId("sandbox-frame")).toBeNull();
  });

  it("times out when the heartbeat stops after loaded (3000 ms)", () => {
    const { props } = setup();
    bringUp();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(props.onFail).toHaveBeenCalledWith("timeout");
  });

  it("counts a valid heartbeat as proof of life", () => {
    const { props } = setup();
    bringUp();
    for (let i = 0; i < 5; i += 1) {
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      harness.heartbeat();
    }
    expect(props.onFail).not.toHaveBeenCalled();
  });
});

describe("unmount", () => {
  it("calls no callback and posts nothing afterwards, however long it waits", () => {
    const { props, view } = setup();
    bringUp();
    const posted = harness.posted().length;
    vi.mocked(props.onMessage).mockClear();
    const removeListener = vi.spyOn(window, "removeEventListener");

    view.unmount();
    expect(removeListener).toHaveBeenCalledWith("message", expect.any(Function));
    expect(screen.queryByTestId("sandbox-frame")).toBeNull();

    harness.frame(1, true);
    harness.error("runtime");
    harness.ready();
    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(props.onMessage).not.toHaveBeenCalled();
    expect(props.onFail).not.toHaveBeenCalled();
    expect(harness.posted()).toHaveLength(posted);
  });

  it("drops the timers before ready, so no failure is reported after unmount", () => {
    const { props, view } = setup();
    view.unmount();
    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(props.onFail).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disposes the player ref", () => {
    const { view, players } = setup();
    bringUp();
    const frameupdate = vi.fn();
    players[0]!.addEventListener("frameupdate", frameupdate);
    view.unmount();
    players[0]!.play();
    expect(harness.postedOfType("play")).toEqual([]);
    expect(frameupdate).not.toHaveBeenCalled();
  });
});

describe("a browser that gives no window, or a window that throws", () => {
  it("fails with phase load at once when contentWindow is null, and shows no iframe", () => {
    harness.setFrameWindow(null);
    const { props } = setup();
    expect(props.onFail).toHaveBeenCalledTimes(1);
    expect(props.onFail).toHaveBeenCalledWith("load");
    expect(props.onPlayerRef).not.toHaveBeenCalled();
    expect(screen.queryByTestId("sandbox-frame")).toBeNull();
  });

  it("does not let a throwing postMessage escape; the watchdog fails the frame instead", () => {
    harness.fakeWindow.postMessage.mockImplementation(() => {
      throw new Error("DataCloneError");
    });
    const { props } = setup();
    expect(() => harness.ready()).not.toThrow();
    expect(props.onFail).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(props.onFail).toHaveBeenCalledWith("timeout");
  });
});
