// @vitest-environment jsdom
/**
 * Tests: the entry point of the Sandbox_Runtime (task 26.3), design 7.8 "Alur main.tsx",
 * Requirements 27.15, 28.4, 28.8, 28.13, 29.1 to 29.5, 29.13, 29.14, 29.16, 29.17 and 2.6.
 *
 * `startRuntime` is driven with a fake window (its `parent` records every message, its listeners
 * are plain sets, `onerror` is a property) and fake interval timers, so each test says what the
 * runtime sent to the parent and in what order. The animation is a real bundle in esbuild's
 * CommonJS shape, rendered by the real `@remotion/player` and React in jsdom, so `loaded`, the
 * `Player` props and the playback messages come from the real thing. `@remotion/player` is
 * wrapped only to record the props it gets and how often a Player mounts.
 *
 *   1. start-up: an origin other than "null" stops everything; otherwise listeners, `onerror`,
 *      `unhandledrejection`, one `ready` (empty session) and a 1000 ms heartbeat, in that order;
 *   2. which messages are believed: only `event.source === window.parent`, only the protocol,
 *      commands only after `loaded` and only with the session of the first `load`;
 *   3. `load` refusals: unsupported contract version, invalid contract, `meta` that differs from
 *      `load.meta` or breaks the contract, wrong default export, evaluation that throws;
 *   4. `loaded` comes after `Main` rendered, and nothing is played before the first command;
 *   5. playback through the real Player: lesson and puzzle, `animate` and `fast`, `resume`, a
 *      second `setMode`, and a pause point on the last frame;
 *   6. errors: a render exception, `window.onerror`, `unhandledrejection` and an exception inside
 *      the runtime each send one `error` and then nothing, not even a heartbeat;
 *   7. the runtime makes no network call, and the real window is wired by `browserDeps`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTRACT_READ, readContract, type ReadContractResult } from "@/lib/animation/contract";
import {
  browserDeps,
  startRuntime,
  type RuntimeDeps,
  type RuntimeWindow,
  type StartResult,
} from "../../sandbox-runtime/main";
import { cjsBundle, throwingMain } from "../fixtures/sandbox-bundles";

const player = vi.hoisted(() => ({
  props: [] as Array<Record<string, unknown>>,
  mounts: 0,
  unmounts: 0,
}));

vi.mock("@remotion/player", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@remotion/player")>();
  const react = await import("react");
  const Recording = react.forwardRef((props: Record<string, unknown>, ref: unknown) => {
    player.props.push(props);
    react.useEffect(() => {
      player.mounts += 1;
      return () => {
        player.unmounts += 1;
      };
    }, []);
    return react.createElement(actual.Player as never, { ...props, ref } as never);
  });
  return { ...actual, Player: Recording };
});

vi.setConfig({ testTimeout: 20_000 });

const SESSION = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const OTHER_SESSION = "00000000000000000000000000000001";

const LESSON = { width: 1280, height: 720, fps: 30, durationInFrames: 30 };
const PUZZLE = { width: 1280, height: 720, fps: 30, durationInFrames: 45, pauseAtFrame: 15 };
/** A puzzle whose pause point is its last frame. */
const PUZZLE_AT_END = { ...LESSON, pauseAtFrame: 29 };

type Meta = Record<string, unknown>;
type Sent = { source: string; version: number; session: string; type: string } & Record<string, unknown>;

const globals = globalThis as Record<string, unknown>;

function loadMetaOf(meta: Meta): Meta {
  const loadMeta: Meta = {
    width: meta.width,
    height: meta.height,
    fps: meta.fps,
    duration_in_frames: meta.durationInFrames,
  };
  if (meta.pauseAtFrame !== undefined) loadMeta.pause_at_frame = meta.pauseAtFrame;
  return loadMeta;
}

const envelope = (session: string) => ({ source: "lore-sandbox", version: 1, session });

function loadMessage(
  meta: Meta,
  options: { bundle?: string; version?: number; session?: string; loadMeta?: Meta } = {},
): Meta {
  return {
    ...envelope(options.session ?? SESSION),
    type: "load",
    bundle: options.bundle ?? cjsBundle(meta),
    meta: options.loadMeta ?? loadMetaOf(meta),
    contract_version: options.version ?? 1,
  };
}

const command = (type: string, extra: Meta = {}, session = SESSION): Meta => ({
  ...envelope(session),
  type,
  ...extra,
});
const setMode = (mode: "fast" | "animate", session = SESSION) => command("setMode", { mode }, session);

interface HostOptions {
  origin?: string;
  contract?: ReadContractResult;
  now?: () => number;
}

/** A fake window and timers around `startRuntime`; records everything the runtime does. */
function createHost(options: HostOptions = {}) {
  const sent: Sent[] = [];
  const targets: string[] = [];
  const log: string[] = [];
  let rendersAtLoaded: unknown = undefined;
  let mainInDomAtLoaded = false;
  const root = document.createElement("div");
  root.id = "root";
  document.body.appendChild(root);

  const parent = {
    postMessage: (message: Sent, target: string) => {
      sent.push(message);
      targets.push(target);
      log.push(`post:${message.type}`);
      if (message.type === "loaded") {
        rendersAtLoaded = globals.__mainRenders;
        mainInDomAtLoaded = root.querySelector('[data-testid="main"]') !== null;
      }
    },
  };
  const listeners = {
    message: new Set<(event: MessageEvent) => void>(),
    unhandledrejection: new Set<(event: PromiseRejectionEvent) => void>(),
  };
  let onerror: OnErrorEventHandler = null;
  const win = {
    origin: options.origin ?? "null",
    parent,
    get onerror(): OnErrorEventHandler {
      return onerror;
    },
    set onerror(value: OnErrorEventHandler) {
      onerror = value;
      log.push("onerror");
    },
    addEventListener(type: "message" | "unhandledrejection", listener: never) {
      log.push(`listen:${type}`);
      (listeners[type] as Set<unknown>).add(listener);
    },
    removeEventListener(type: "message" | "unhandledrejection", listener: never) {
      (listeners[type] as Set<unknown>).delete(listener);
    },
  };

  const intervals = new Map<number, { callback: () => void; ms: number }>();
  const timers = { created: [] as number[], cleared: [] as number[] };
  let nextId = 1;
  const deps: RuntimeDeps = {
    win: win as unknown as RuntimeWindow,
    getRoot: () => root,
    contract: options.contract ?? CONTRACT_READ,
    now: options.now ?? (() => performance.now()),
    setInterval: (callback, ms) => {
      const id = nextId++;
      intervals.set(id, { callback, ms });
      timers.created.push(ms);
      return id;
    },
    clearInterval: (id) => {
      intervals.delete(id as number);
      timers.cleared.push(id as number);
    },
  };

  const host = {
    deps,
    win,
    root,
    sent,
    targets,
    log,
    timers,
    get rendersAtLoaded() {
      return rendersAtLoaded;
    },
    get mainInDomAtLoaded() {
      return mainInDomAtLoaded;
    },
    /** Delivers a `message` event; by default from the parent window. */
    deliver(data: unknown, source: unknown = parent): void {
      for (const listener of [...listeners.message]) listener({ source, data } as MessageEvent);
    },
    rejectUnhandled(): void {
      for (const listener of [...listeners.unhandledrejection]) listener({} as PromiseRejectionEvent);
    },
    /** Fires every heartbeat interval that is still running. */
    tick(): void {
      for (const { callback } of [...intervals.values()]) callback();
    },
    activeIntervals: () => intervals.size,
    listenerCount: () => listeners.message.size + listeners.unhandledrejection.size,
    types: () => sent.map((message) => message.type),
    ofType: (type: string) => sent.filter((message) => message.type === type),
    errors: () => sent.filter((message) => message.type === "error"),
  };
  return host;
}

type Host = ReturnType<typeof createHost>;

const cleanups: Array<() => void> = [];

function start(host: Host): Extract<StartResult, { ok: true }> {
  const result = startRuntime(host.deps);
  if (!result.ok) throw new Error("the runtime did not start");
  cleanups.push(result.stop);
  return result;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const until = (check: () => void, timeout = 8000) => vi.waitFor(check, { timeout, interval: 10 });

/** Starts the runtime, sends `load` and waits for `loaded`. */
async function loadAnimation(host: Host, meta: Meta, options: Parameters<typeof loadMessage>[1] = {}) {
  start(host);
  host.deliver(loadMessage(meta, options));
  await until(() => expect(host.types()).toContain("loaded"));
}

/**
 * Waits until `count` Players have mounted in all. `setMode` answers at once but the new Player
 * exists only after React commits; commands sent before that are held and applied to it, so tests
 * that want to drive the mounted Player (not the held queue) wait here first.
 */
const untilMounted = (count: number) => until(() => expect(player.mounts).toBe(count));

/** Waits until `count` messages of `type` have been sent. */
const untilCount = (host: Host, type: string, count: number, timeout?: number) =>
  until(() => expect(host.ofType(type).length).toBeGreaterThanOrEqual(count), timeout);

/** The messages that are not heartbeats, as `[type, ...]` summaries for readable assertions. */
function summary(host: Host): string[] {
  return host.sent.map((message) => {
    if (message.type === "frame") return `frame:${message.frame}:${message.playing ? "play" : "still"}`;
    if (message.type === "paused") return `paused:${message.reason}:${message.frame}`;
    if (message.type === "error") return `error:${message.phase}:${message.code}`;
    return message.type;
  });
}

beforeEach(() => {
  player.props.length = 0;
  player.mounts = 0;
  player.unmounts = 0;
  delete globals.__mainRenders;
  delete globals.__evaluated;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("start-up", () => {
  it.each([
    ["a page origin", "http://localhost:3000"],
    ["an https origin", "https://lore.example"],
    ["an empty origin", ""],
    ["the string with other case", "NULL"],
    ["null with a space", "null "],
  ])("with %s it stops completely", (_label, origin) => {
    const host = createHost({ origin });
    const result = startRuntime(host.deps);
    expect(result).toEqual({ ok: false, reason: "origin" });
    expect(host.log).toEqual([]);
    expect(host.sent).toEqual([]);
    expect(host.timers.created).toEqual([]);
    expect(host.listenerCount()).toBe(0);
    expect(host.win.onerror).toBeNull();
    // Even a perfectly good load is not looked at: there is no listener to receive it.
    host.deliver(loadMessage(LESSON, { bundle: cjsBundle(LESSON, { extra: "globalThis.__evaluated = true;" }) }));
    expect(globals.__evaluated).toBeUndefined();
    expect(host.sent).toEqual([]);
  });

  it("installs the listeners and onerror before it sends the one ready", () => {
    const host = createHost();
    start(host);
    expect(host.log).toEqual(["listen:message", "onerror", "listen:unhandledrejection", "post:ready"]);
    expect(host.sent).toEqual([{ source: "lore-sandbox", version: 1, session: "", type: "ready" }]);
    expect(host.targets).toEqual(["*"]);
    expect(typeof host.win.onerror).toBe("function");
  });

  it("starts a heartbeat every 1000 ms, with an empty session before load", () => {
    const host = createHost();
    start(host);
    expect(host.timers.created).toEqual([1000]);
    host.tick();
    host.tick();
    expect(host.ofType("heartbeat")).toEqual([
      { source: "lore-sandbox", version: 1, session: "", type: "heartbeat" },
      { source: "lore-sandbox", version: 1, session: "", type: "heartbeat" },
    ]);
    expect(host.ofType("ready")).toHaveLength(1);
  });

  it("uses the session of the load message in every message it sends afterwards", async () => {
    const host = createHost();
    await loadAnimation(host, LESSON);
    host.tick();
    const afterLoad = host.sent.slice(1);
    expect(afterLoad.map((message) => message.type)).toEqual(["loaded", "heartbeat"]);
    for (const message of afterLoad) expect(message.session).toBe(SESSION);
    expect(host.sent[0].session).toBe("");
  });

  it("answers `ready` once even when messages arrive before load", () => {
    const host = createHost();
    start(host);
    host.deliver(command("play"));
    host.deliver(command("pause"));
    host.deliver(setMode("animate"));
    expect(host.types()).toEqual(["ready"]);
  });
});

describe("which messages the runtime believes", () => {
  it("ignores a load that does not come from window.parent, then accepts the real one", async () => {
    const host = createHost();
    start(host);
    const stranger = { postMessage: () => {} };
    host.deliver(loadMessage(LESSON, { bundle: cjsBundle(LESSON, { extra: "globalThis.__evaluated = true;" }) }), stranger);
    host.deliver(loadMessage(LESSON), null);
    host.deliver(loadMessage(LESSON), undefined);
    expect(globals.__evaluated).toBeUndefined();
    expect(host.types()).toEqual(["ready"]);

    host.deliver(loadMessage(LESSON));
    await until(() => expect(host.types()).toContain("loaded"));
  });

  it.each([
    ["a string", "load"],
    ["null", null],
    ["a number", 7],
    ["an array", []],
    ["an object without the envelope", { type: "load" }],
    ["a load with an unknown key", { ...loadMessage(LESSON), extra: 1 }],
    ["a load with a bad session", loadMessage(LESSON, { session: "NOT-HEX" })],
    ["a load with an oversized bundle", loadMessage(LESSON, { bundle: "x".repeat(131073) })],
    ["a load with a bad meta", loadMessage(LESSON, { loadMeta: { ...loadMetaOf(LESSON), duration_in_frames: 5 } })],
    ["a message of the wrong direction", { ...envelope(""), type: "ready" }],
    ["a loaded message", { ...envelope(SESSION), type: "loaded", duration_in_frames: 30 }],
  ])("ignores %s", (_label, data) => {
    const host = createHost();
    start(host);
    host.deliver(data);
    expect(host.types()).toEqual(["ready"]);
  });

  it("evaluates only the first load; a second one changes nothing", async () => {
    const host = createHost();
    start(host);
    const counted = (extra: string) => cjsBundle(LESSON, { extra: `globalThis.__evaluated = (globalThis.__evaluated || 0) + 1; ${extra}` });
    host.deliver(loadMessage(LESSON, { bundle: counted("") }));
    host.deliver(loadMessage(LESSON, { bundle: counted(""), session: OTHER_SESSION }));
    await until(() => expect(host.types()).toContain("loaded"));
    host.deliver(loadMessage(LESSON, { bundle: counted(""), session: OTHER_SESSION }));
    await wait(100);
    expect(globals.__evaluated).toBe(1);
    expect(host.ofType("loaded")).toHaveLength(1);
    expect(host.errors()).toEqual([]);
    // The session is still the first one.
    host.tick();
    expect(host.ofType("heartbeat").at(-1)?.session).toBe(SESSION);
  });

  it("ignores commands that arrive before loaded", async () => {
    const host = createHost();
    start(host);
    host.deliver(loadMessage(LESSON));
    // Right now the Player has not rendered; these must be dropped, not queued.
    expect(host.types()).toEqual(["ready"]);
    host.deliver(setMode("animate"));
    host.deliver(command("play"));
    host.deliver(command("seek", { frame: 10 }));
    host.deliver(command("resume"));
    await until(() => expect(host.types()).toContain("loaded"));
    await wait(200);
    expect(host.types()).toEqual(["ready", "loaded"]);
  });

  it("ignores commands with another session", async () => {
    const host = createHost();
    await loadAnimation(host, LESSON);
    host.deliver(setMode("animate", OTHER_SESSION));
    host.deliver(command("play", {}, "")); // an empty session is not the session either
    host.deliver(command("seek", { frame: 3 }, OTHER_SESSION));
    await wait(200);
    expect(host.types()).toEqual(["ready", "loaded"]);
  });

  it("ignores commands that do not come from window.parent", async () => {
    const host = createHost();
    await loadAnimation(host, LESSON);
    host.deliver(setMode("animate"), { postMessage: () => {} });
    await wait(200);
    expect(host.types()).toEqual(["ready", "loaded"]);
  });

  it("ignores commands the schema refuses (a seek that is not an integer)", async () => {
    const host = createHost();
    await loadAnimation(host, LESSON);
    host.deliver(command("seek", { frame: 1.5 }));
    host.deliver(command("seek", { frame: "3" }));
    host.deliver(command("setMode", { mode: "slow" }));
    await wait(150);
    expect(host.types()).toEqual(["ready", "loaded"]);
    expect(host.errors()).toEqual([]);
  });
});

describe("load refusals", () => {
  it("an unsupported contract_version is CONTRACT_UNSUPPORTED and the bundle is not evaluated", () => {
    const host = createHost();
    start(host);
    host.deliver(
      loadMessage(LESSON, { version: 2, bundle: cjsBundle(LESSON, { extra: "globalThis.__evaluated = true;" }) }),
    );
    expect(host.errors()).toEqual([
      { ...envelope(SESSION), type: "error", phase: "load", code: "CONTRACT_UNSUPPORTED" },
    ]);
    expect(globals.__evaluated).toBeUndefined();
    expect(player.props).toEqual([]);
  });

  it("an invalid contract copy is CONTRACT_INVALID and the bundle is not evaluated", () => {
    const host = createHost({ contract: readContract({ nonsense: true }) });
    start(host);
    host.deliver(loadMessage(LESSON, { bundle: cjsBundle(LESSON, { extra: "globalThis.__evaluated = true;" }) }));
    expect(host.errors()).toEqual([
      { ...envelope(SESSION), type: "error", phase: "load", code: "CONTRACT_INVALID" },
    ]);
    expect(globals.__evaluated).toBeUndefined();
  });

  it("a meta that differs from load.meta is META_INVALID", () => {
    const host = createHost();
    start(host);
    host.deliver(loadMessage(LESSON, { loadMeta: { ...loadMetaOf(LESSON), duration_in_frames: 31 } }));
    expect(summary(host)).toEqual(["ready", "error:load:META_INVALID"]);
  });

  it("a meta that breaks the contract is META_INVALID", () => {
    const host = createHost();
    start(host);
    const wide = { ...LESSON, width: 1920 };
    host.deliver(loadMessage(wide));
    expect(summary(host)).toEqual(["ready", "error:load:META_INVALID"]);
  });

  it("a pause point past the last frame is META_INVALID", () => {
    const host = createHost();
    start(host);
    host.deliver(loadMessage({ ...LESSON, pauseAtFrame: 30 }));
    expect(summary(host)).toEqual(["ready", "error:load:META_INVALID"]);
  });

  it("a default export that is not a function is EXPORT_INVALID", () => {
    const host = createHost();
    start(host);
    const bundle = `exports.meta = ${JSON.stringify(LESSON)}; exports.default = { not: "a function" };`;
    host.deliver(loadMessage(LESSON, { bundle }));
    expect(summary(host)).toEqual(["ready", "error:load:EXPORT_INVALID"]);
  });

  it("a bundle that throws while it is evaluated is EVAL_THROW", () => {
    const host = createHost();
    start(host);
    host.deliver(loadMessage(LESSON, { bundle: cjsBundle(LESSON, { extra: `throw new Error("boom");` }) }));
    expect(summary(host)).toEqual(["ready", "error:load:EVAL_THROW"]);
  });

  it("a bundle that requires a module that is not allowed is EVAL_THROW", () => {
    const host = createHost();
    start(host);
    host.deliver(loadMessage(LESSON, { bundle: cjsBundle(LESSON, { extra: `require("react-dom");` }) }));
    expect(summary(host)).toEqual(["ready", "error:load:EVAL_THROW"]);
  });

  it("a syntax error is EVAL_THROW", () => {
    const host = createHost();
    start(host);
    host.deliver(loadMessage(LESSON, { bundle: "var = ;" }));
    expect(summary(host)).toEqual(["ready", "error:load:EVAL_THROW"]);
  });

  it("a page without the root element is reported, not thrown", () => {
    const host = createHost();
    host.deps.getRoot = () => null;
    start(host);
    expect(() => host.deliver(loadMessage(LESSON))).not.toThrow();
    expect(summary(host)).toEqual(["ready", "error:runtime:RUNTIME_INTERNAL"]);
  });

  it("after a load refusal nothing more is sent: not a heartbeat, not an answer to a command", () => {
    const host = createHost();
    start(host);
    host.deliver(loadMessage(LESSON, { version: 9 }));
    expect(host.activeIntervals()).toBe(0);
    host.tick();
    host.deliver(setMode("animate"));
    host.deliver(loadMessage(LESSON));
    host.rejectUnhandled();
    host.win.onerror?.("later");
    expect(summary(host)).toEqual(["ready", "error:load:CONTRACT_UNSUPPORTED"]);
  });
});

describe("loaded and the first frame", () => {
  it("sends loaded with the duration after Main has rendered into the page", async () => {
    const host = createHost();
    await loadAnimation(host, LESSON);
    expect(host.ofType("loaded")).toEqual([
      { ...envelope(SESSION), type: "loaded", duration_in_frames: 30 },
    ]);
    expect(Number(host.rendersAtLoaded)).toBeGreaterThanOrEqual(1);
    expect(host.mainInDomAtLoaded).toBe(true);
    expect(host.root.querySelector('[data-testid="main"]')?.getAttribute("data-frame")).toBe("0");
  });

  it("stays on frame 0 and sends nothing but heartbeats until the first command", async () => {
    const host = createHost();
    await loadAnimation(host, PUZZLE);
    await wait(300);
    host.tick();
    expect(host.types()).toEqual(["ready", "loaded", "heartbeat"]);
    expect(host.root.querySelector('[data-testid="main"]')?.getAttribute("data-frame")).toBe("0");
  });

  it("gives the Player the props of design 7.8", async () => {
    const host = createHost();
    await loadAnimation(host, PUZZLE);
    const props = player.props.at(-1);
    expect(props).toMatchObject({
      compositionWidth: 1280,
      compositionHeight: 720,
      fps: 30,
      durationInFrames: 45,
      controls: false,
      clickToPlay: false,
      doubleClickToFullscreen: false,
      spaceKeyToPlayOrPause: false,
      loop: false,
      moveToBeginningWhenEnded: false,
      autoPlay: false,
      acknowledgeRemotionLicense: true,
      style: { width: "100%", height: "100%" },
    });
    expect(typeof props?.component).toBe("function");
    expect(player.mounts).toBe(1);
  });

  it("takes the canvas and length of the Player from the validated meta", async () => {
    const host = createHost();
    await loadAnimation(host, { ...LESSON, durationInFrames: 31 });
    expect(player.props.at(-1)).toMatchObject({ durationInFrames: 31, compositionWidth: 1280 });
  });
});

describe("lesson playback through the real Player", () => {
  it("animate: frames inside 0..last, a forced frame before one ended, then it holds the end", async () => {
    const host = createHost();
    await loadAnimation(host, LESSON);
    host.deliver(setMode("animate"));
    await untilCount(host, "ended", 1);
    await wait(300);

    const frames = host.ofType("frame");
    expect(frames.length).toBeGreaterThanOrEqual(2);
    for (const message of frames) {
      expect(Number.isInteger(message.frame)).toBe(true);
      expect(message.frame as number).toBeGreaterThanOrEqual(0);
      expect(message.frame as number).toBeLessThanOrEqual(29);
    }
    expect(host.ofType("ended")).toHaveLength(1);
    const endedAt = host.types().indexOf("ended");
    expect(host.sent[endedAt - 1]).toMatchObject({ type: "frame", frame: 29, playing: false });
    expect(host.types().slice(endedAt + 1).filter((type) => type !== "heartbeat")).toEqual([]);
    expect(host.ofType("paused")).toEqual([]);
    expect(host.errors()).toEqual([]);
    expect(host.root.querySelector('[data-testid="main"]')?.getAttribute("data-frame")).toBe("29");
  });

  it("animate: the controller spaces periodic frames with the clock it is given", async () => {
    // A clock that never moves lets only the first periodic frame through; the forced frame
    // before `ended` is sent regardless (Requirement 28.6).
    const frozen = createHost({ now: () => 5 });
    await loadAnimation(frozen, LESSON);
    frozen.deliver(setMode("animate"));
    await untilCount(frozen, "ended", 1);
    expect(frozen.ofType("frame").filter((message) => message.playing).length).toBeLessThanOrEqual(1);
    expect(frozen.sent[frozen.types().indexOf("ended") - 1]).toMatchObject({ frame: 29, playing: false });

    // A clock that jumps a second at every read lets every Player update through.
    let clock = 0;
    const racing = createHost({ now: () => (clock += 1000) });
    await loadAnimation(racing, LESSON);
    racing.deliver(setMode("animate"));
    await untilCount(racing, "ended", 1);
    expect(racing.ofType("frame").filter((message) => message.playing).length).toBeGreaterThanOrEqual(5);
  });

  it("fast: shows the last frame and reports paused{end}, with no ended", async () => {
    const host = createHost();
    await loadAnimation(host, LESSON);
    host.deliver(setMode("fast"));
    await until(() => expect(host.types()).toContain("paused"));
    await wait(300);
    expect(summary(host)).toEqual(["ready", "loaded", "frame:29:still", "paused:end:29"]);
    expect(host.root.querySelector('[data-testid="main"]')?.getAttribute("data-frame")).toBe("29");
  });

  it("seek and pause answer with a frame inside the animation", async () => {
    const host = createHost();
    await loadAnimation(host, LESSON);
    host.deliver(setMode("fast"));
    await until(() => expect(host.types()).toContain("paused"));
    await untilMounted(2);
    host.sent.length = 0;
    host.deliver(command("seek", { frame: -50 }));
    host.deliver(command("seek", { frame: Number.MAX_SAFE_INTEGER }));
    host.deliver(command("seek", { frame: 12 }));
    host.deliver(command("pause"));
    const frames = host.ofType("frame");
    expect(frames.map((message) => message.frame)).toEqual([0, 29, 12, 12]);
    expect(host.errors()).toEqual([]);
  });

  it("a second setMode remounts the Player and plays the new mode from frame 0", async () => {
    const host = createHost();
    await loadAnimation(host, LESSON);
    expect(player.mounts).toBe(1);
    host.deliver(setMode("fast"));
    await until(() => expect(host.ofType("paused")).toHaveLength(1));
    await until(() => expect(player.mounts).toBe(2));
    expect(player.unmounts).toBe(1);

    host.deliver(setMode("animate"));
    await untilCount(host, "ended", 1);
    expect(player.mounts).toBe(3);
    await wait(200);
    expect(host.ofType("ended")).toHaveLength(1);
    expect(host.ofType("paused")).toHaveLength(1);

    host.deliver(setMode("animate"));
    await untilCount(host, "ended", 2);
    await wait(200);
    expect(host.ofType("ended")).toHaveLength(2);
    expect(host.errors()).toEqual([]);
  });
});

describe("puzzle playback through the real Player", () => {
  it("fast: waits at the pause point, seek cannot pass it, resume shows the end without ended", async () => {
    const host = createHost();
    await loadAnimation(host, PUZZLE);
    host.deliver(setMode("fast"));
    await until(() => expect(host.types()).toContain("paused"));
    expect(summary(host)).toEqual(["ready", "loaded", "frame:15:still", "paused:interaction:15"]);
    await untilMounted(2);

    host.sent.length = 0;
    host.deliver(command("seek", { frame: 40 }));
    host.deliver(command("seek", { frame: 3 }));
    host.deliver(command("seek", { frame: Number.MAX_SAFE_INTEGER }));
    expect(host.ofType("frame").map((message) => message.frame)).toEqual([15, 3, 15]);

    host.sent.length = 0;
    host.deliver(command("resume"));
    // The real Player reports `ended` from inside seekTo(last); that must not become a message.
    await wait(300);
    expect(summary(host)).toEqual(["frame:44:still", "paused:end:44"]);
    expect(host.root.querySelector('[data-testid="main"]')?.getAttribute("data-frame")).toBe("44");
  });

  it("fast: resume without a pause, or a second time, sends nothing", async () => {
    const host = createHost();
    await loadAnimation(host, PUZZLE);
    host.deliver(setMode("fast"));
    await until(() => expect(host.types()).toContain("paused"));
    await untilMounted(2);
    host.deliver(command("resume"));
    await wait(100);
    host.sent.length = 0;
    host.deliver(command("resume"));
    host.deliver(command("resume"));
    await wait(100);
    expect(host.sent).toEqual([]);
  });

  it("animate: stops exactly at the pause point, and resume plays on to a single ended", async () => {
    const host = createHost();
    await loadAnimation(host, PUZZLE);
    host.deliver(setMode("animate"));
    await until(() => expect(host.types()).toContain("paused"));
    await wait(200);

    const beforeResume = summary(host);
    expect(beforeResume.filter((entry) => entry.startsWith("paused"))).toEqual(["paused:interaction:15"]);
    expect(host.ofType("ended")).toEqual([]);
    const pausedAt = host.types().indexOf("paused");
    expect(host.sent[pausedAt - 1]).toMatchObject({ type: "frame", frame: 15, playing: false });
    for (const message of host.ofType("frame")) expect(message.frame as number).toBeLessThanOrEqual(15);
    expect(host.root.querySelector('[data-testid="main"]')?.getAttribute("data-frame")).toBe("15");

    host.deliver(command("resume"));
    await untilCount(host, "ended", 1);
    await wait(300);
    expect(host.ofType("ended")).toHaveLength(1);
    expect(host.ofType("paused")).toHaveLength(1);
    const frames = host.ofType("frame").map((message) => message.frame as number);
    expect(Math.max(...frames)).toBe(44);
    expect(frames.every((frame) => frame >= 0 && frame <= 44)).toBe(true);
    expect(host.errors()).toEqual([]);
  });

  it("animate: play during the wait replays from frame 0 up to the pause point", async () => {
    const host = createHost();
    await loadAnimation(host, PUZZLE);
    host.deliver(setMode("animate"));
    await until(() => expect(host.ofType("paused")).toHaveLength(1));
    host.deliver(command("play"));
    await until(() => expect(host.ofType("paused")).toHaveLength(2));
    await wait(200);
    expect(host.ofType("paused").map((message) => message.reason)).toEqual(["interaction", "interaction"]);
    expect(host.ofType("ended")).toEqual([]);
    for (const message of host.ofType("frame")) expect(message.frame as number).toBeLessThanOrEqual(15);
  });

  it("a pause point on the last frame: one pause, no ended, and resume then ends once", async () => {
    const host = createHost();
    await loadAnimation(host, PUZZLE_AT_END);
    host.deliver(setMode("animate"));
    await until(() => expect(host.types()).toContain("paused"));
    await wait(300);
    expect(host.ofType("paused")).toEqual([
      { ...envelope(SESSION), type: "paused", reason: "interaction", frame: 29 },
    ]);
    expect(host.ofType("ended")).toEqual([]);

    host.deliver(command("resume"));
    await untilCount(host, "ended", 1);
    await wait(200);
    expect(host.ofType("ended")).toHaveLength(1);
    expect(host.ofType("paused")).toHaveLength(1);
    expect(host.errors()).toEqual([]);
  });

  it("a pause point on the last frame in fast mode is one interaction pause", async () => {
    const host = createHost();
    await loadAnimation(host, PUZZLE_AT_END);
    host.deliver(setMode("fast"));
    await until(() => expect(host.types()).toContain("paused"));
    await wait(200);
    expect(summary(host)).toEqual(["ready", "loaded", "frame:29:still", "paused:interaction:29"]);
  });
});

describe("errors end everything", () => {
  it("a render exception on the first render is one RENDER_THROW and there is no loaded", async () => {
    const host = createHost();
    start(host);
    host.deliver(loadMessage(LESSON, { bundle: cjsBundle(LESSON, { main: throwingMain(0) }) }));
    await until(() => expect(host.errors()).toHaveLength(1));
    await wait(200);
    expect(summary(host)).toEqual(["ready", "error:runtime:RENDER_THROW"]);
    expect(host.activeIntervals()).toBe(0);
    host.tick();
    host.deliver(setMode("animate"));
    await wait(100);
    expect(summary(host)).toEqual(["ready", "error:runtime:RENDER_THROW"]);
  });

  it("a render exception during playback is one error, then nothing", async () => {
    const host = createHost();
    start(host);
    host.deliver(loadMessage(LESSON, { bundle: cjsBundle(LESSON, { main: throwingMain(6) }) }));
    await until(() => expect(host.types()).toContain("loaded"));
    host.deliver(setMode("animate"));
    await until(() => expect(host.errors()).toHaveLength(1));
    const count = host.sent.length;
    await wait(400);
    expect(host.sent).toHaveLength(count);
    expect(host.errors()).toEqual([
      { ...envelope(SESSION), type: "error", phase: "runtime", code: "RENDER_THROW" },
    ]);
    expect(host.sent.at(-1)?.type).toBe("error");
    expect(host.ofType("ended")).toEqual([]);
    expect(host.activeIntervals()).toBe(0);
  });

  it("window.onerror sends one UNCAUGHT_ERROR; later errors and rejections add nothing", async () => {
    const host = createHost();
    await loadAnimation(host, LESSON);
    host.win.onerror?.("Uncaught Error: boom");
    host.win.onerror?.("Uncaught Error: again");
    host.rejectUnhandled();
    host.tick();
    host.deliver(setMode("animate"));
    await wait(200);
    expect(summary(host)).toEqual(["ready", "loaded", "error:runtime:UNCAUGHT_ERROR"]);
    expect(host.activeIntervals()).toBe(0);
  });

  it("unhandledrejection sends one UNHANDLED_REJECTION", async () => {
    const host = createHost();
    await loadAnimation(host, LESSON);
    host.rejectUnhandled();
    host.rejectUnhandled();
    host.win.onerror?.("later");
    expect(summary(host)).toEqual(["ready", "loaded", "error:runtime:UNHANDLED_REJECTION"]);
  });

  it("an error before load carries the empty session", () => {
    const host = createHost();
    start(host);
    host.win.onerror?.("early");
    expect(host.errors()).toEqual([
      { ...envelope(""), type: "error", phase: "runtime", code: "UNCAUGHT_ERROR" },
    ]);
    host.deliver(loadMessage(LESSON));
    expect(host.errors()).toHaveLength(1);
    expect(host.types()).toEqual(["ready", "error"]);
  });

  it("an error stops playback and heartbeat: the Player is paused and stays silent", async () => {
    const host = createHost();
    await loadAnimation(host, LESSON);
    host.deliver(setMode("animate"));
    await until(() => expect(host.ofType("frame").length).toBeGreaterThanOrEqual(1));
    host.win.onerror?.("stop");
    const count = host.sent.length;
    expect(host.sent.at(-1)?.type).toBe("error");
    await wait(600);
    expect(host.sent).toHaveLength(count);
    const frame = host.root.querySelector('[data-testid="main"]')?.getAttribute("data-frame");
    await wait(200);
    expect(host.root.querySelector('[data-testid="main"]')?.getAttribute("data-frame")).toBe(frame);
  });

  it("an exception inside the runtime's own logic is RUNTIME_INTERNAL, not an escaped exception", async () => {
    let broken = false;
    const host = createHost({
      now: () => {
        if (broken) throw new Error("clock failed");
        return performance.now();
      },
    });
    await loadAnimation(host, LESSON);
    broken = true;
    expect(() => host.deliver(command("pause"))).not.toThrow();
    expect(summary(host)).toEqual(["ready", "loaded", "error:runtime:RUNTIME_INTERNAL"]);
    expect(host.activeIntervals()).toBe(0);
    host.deliver(command("seek", { frame: 2 }));
    expect(host.sent).toHaveLength(3);
  });

  it("an exception from a heartbeat post is contained", () => {
    const host = createHost();
    start(host);
    host.win.parent.postMessage = () => {
      throw new Error("detached");
    };
    expect(() => host.tick()).not.toThrow();
  });
});

describe("no network and no outside access", () => {
  it("never calls fetch, XMLHttpRequest, WebSocket, EventSource or sendBeacon", async () => {
    const spies = {
      fetch: vi.fn(),
      XMLHttpRequest: vi.fn(),
      WebSocket: vi.fn(),
      EventSource: vi.fn(),
    };
    for (const [name, spy] of Object.entries(spies)) vi.stubGlobal(name, spy);
    const sendBeacon = vi.fn();
    Object.defineProperty(navigator, "sendBeacon", { value: sendBeacon, configurable: true });
    cleanups.push(() => {
      delete (navigator as unknown as Record<string, unknown>).sendBeacon;
    });

    const host = createHost();
    await loadAnimation(host, LESSON);
    host.deliver(setMode("animate"));
    await untilCount(host, "ended", 1);
    host.deliver(setMode("fast"));
    await until(() => expect(host.ofType("paused")).toHaveLength(1));
    await untilMounted(3);
    host.deliver(command("seek", { frame: 3 }));
    host.deliver(command("play"));

    for (const [name, spy] of Object.entries(spies)) expect(spy, name).not.toHaveBeenCalled();
    expect(sendBeacon).not.toHaveBeenCalled();
  });

  it("does not leak the window to the bundle through the shim", async () => {
    const host = createHost();
    start(host);
    const extra = `if (typeof require("react").useState !== "undefined") throw new Error("leak");`;
    host.deliver(loadMessage(LESSON, { bundle: cjsBundle(LESSON, { extra }) }));
    await until(() => expect(host.types()).toContain("loaded"));
  });
});

describe("the real window", () => {
  /** Overrides a property of the jsdom window for one test and puts the original back after it. */
  function overrideWindow(name: string, descriptor: PropertyDescriptor): void {
    const original = Object.getOwnPropertyDescriptor(window, name);
    Object.defineProperty(window, name, { configurable: true, ...descriptor });
    cleanups.push(() => {
      if (original) Object.defineProperty(window, name, original);
      else delete (window as unknown as Record<string, unknown>)[name];
    });
  }

  it("browserDeps reads the contract and the root element of the page", () => {
    const element = document.createElement("div");
    element.id = "root";
    document.body.appendChild(element);
    const deps = browserDeps();
    expect(deps.win).toBe(window);
    expect(deps.getRoot()).toBe(element);
    expect(deps.contract).toBe(CONTRACT_READ);
    const before = deps.now();
    expect(deps.now()).toBeGreaterThanOrEqual(before);
    const id = deps.setInterval(() => {}, 100000);
    expect(() => deps.clearInterval(id)).not.toThrow();
  });

  it("loading the module in a page whose origin is not null does nothing", async () => {
    expect(window.origin).not.toBe("null");
    const add = vi.spyOn(window, "addEventListener");
    const post = vi.spyOn(window, "postMessage");
    const interval = vi.spyOn(window, "setInterval");
    const onerrorBefore = window.onerror;
    vi.resetModules();
    await import("../../sandbox-runtime/main");
    expect(add.mock.calls.filter(([type]) => type === "message" || type === "unhandledrejection")).toEqual([]);
    expect(post).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
    expect(window.onerror).toBe(onerrorBefore);
  });

  it("in an iframe it starts by itself: ready goes to window.parent and a load from it is served", async () => {
    // jsdom's window is its own parent. Its `postMessage` is replaced so the messages the runtime
    // sends are recorded and not delivered back to it, and the heartbeat timer is not started.
    const posted = vi.spyOn(window, "postMessage").mockImplementation(() => {});
    vi.spyOn(window, "setInterval").mockImplementation((() => 1) as never);
    vi.spyOn(window, "clearInterval").mockImplementation(() => {});
    overrideWindow("origin", { get: () => "null", set: () => {} });
    cleanups.push(() => {
      window.onerror = null;
    });
    const element = document.createElement("div");
    element.id = "root";
    document.body.appendChild(element);

    vi.resetModules();
    await import("../../sandbox-runtime/main");
    expect(posted).toHaveBeenCalledWith(
      { source: "lore-sandbox", version: 1, session: "", type: "ready" },
      "*",
    );
    expect(typeof window.onerror).toBe("function");

    window.dispatchEvent(
      new MessageEvent("message", { data: loadMessage(LESSON), source: window.parent as MessageEventSource }),
    );
    await until(() => {
      const types = posted.mock.calls.map(([message]) => (message as Sent).type);
      expect(types).toContain("loaded");
    });
    // The page now holds the rendered animation.
    expect(element.querySelector('[data-testid="main"]')).not.toBeNull();
  });
});
