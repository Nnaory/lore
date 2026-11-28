/**
 * Tests: RuntimeController (task 26.1), design 7.8, Requirements 29.5 to 29.12, 29.15, 29.16 and
 * 28.6.
 *
 * The controller is the pure playback logic of the Sandbox_Runtime. It is driven here with a fake
 * `PlayerPort` (no React, no DOM, no real Player) and a fake clock, so each test states what the
 * Player was told to do (`calls`) and what the runtime sent to the parent (`posted`).
 *
 * The fake Player keeps a frame and a playing flag. `runPlayback` plays it forward one frame per
 * 34 ms, calls `onPlayerFrame` for each frame, and calls `onPlayerEnded` when it reaches the last
 * frame while still playing, in the order the real `@remotion/player` reports them.
 *
 *   1. `setMode`: lesson and puzzle, `animate` and `fast`, and a second `setMode`;
 *   2. `onPlayerFrame`: clamping, the 100 ms spacing, and the stop at `pauseAtFrame`;
 *   3. `play`, `pause`, `seek` (the pause point is a wall until `resume`), `resume`;
 *   4. `ended` at most once per playback, and no `ended` before a puzzle is resumed;
 *   5. `halt` (after `error` nothing more is sent);
 *   6. invariants: the forced `frame` before `paused` / `ended`, and frames inside `0..last`.
 */

import { describe, expect, it } from "vitest";
import {
  createRuntimeController,
  type PlaybackMessageBody,
  type PlayerPort,
  type RuntimeMeta,
} from "../../sandbox-runtime/controller";
import {
  FRAME_MIN_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
  OPAQUE_ORIGIN,
} from "../../sandbox-runtime/page";

const DURATION = 210;
const LAST = DURATION - 1;
const PAUSE_AT = 120;
/** Milliseconds the fake Player takes per frame (about 30 fps). */
const FRAME_MS = 34;

const LESSON: RuntimeMeta = { durationInFrames: DURATION };
const PUZZLE: RuntimeMeta = { durationInFrames: DURATION, pauseAtFrame: PAUSE_AT };

const frameMsg = (frame: number, playing: boolean): PlaybackMessageBody => ({
  type: "frame",
  frame,
  playing,
});
const pausedMsg = (reason: "interaction" | "end", frame: number): PlaybackMessageBody => ({
  type: "paused",
  reason,
  frame,
});
const ENDED: PlaybackMessageBody = { type: "ended" };

function createHarness(meta: RuntimeMeta) {
  let clock = 5_000;
  const last = meta.durationInFrames - 1;
  /** Calls the controller made on the Player, as `name` or `name(arg)`. */
  const calls: string[] = [];
  const posted: PlaybackMessageBody[] = [];
  const postedAt: number[] = [];
  const player = { frame: 0, playing: false };
  const port: PlayerPort = {
    remount: () => {
      calls.push("remount");
      player.frame = 0;
      player.playing = false;
    },
    play: () => {
      calls.push("play");
      player.playing = true;
    },
    pause: () => {
      calls.push("pause");
      player.playing = false;
    },
    seekTo: (frame) => {
      calls.push(`seekTo(${frame})`);
      player.frame = frame;
    },
    getCurrentFrame: () => player.frame,
    isPlaying: () => player.playing,
  };
  const controller = createRuntimeController({
    meta,
    port,
    post: (message) => {
      posted.push(message);
      postedAt.push(clock);
    },
    now: () => clock,
  });
  return {
    controller,
    calls,
    posted,
    postedAt,
    player,
    last,
    advance(ms: number): void {
      clock += ms;
    },
    /** The Player reports that it is now showing `frame`. */
    reportFrame(frame: number): void {
      player.frame = frame;
      controller.onPlayerFrame(frame);
    },
    /** Plays the fake Player forward until it stops (a pause, the end, or `maxSteps`). */
    runPlayback(maxSteps = 2000): void {
      for (let step = 0; step < maxSteps && player.playing; step += 1) {
        clock += FRAME_MS;
        player.frame = Math.min(player.frame + 1, last);
        controller.onPlayerFrame(player.frame);
        if (player.playing && player.frame === last) {
          player.playing = false;
          controller.onPlayerEnded();
        }
      }
    },
    /** Forgets what happened so far, to assert only on what the next step does. */
    clear(): void {
      calls.length = 0;
      posted.length = 0;
      postedAt.length = 0;
    },
  };
}

type Harness = ReturnType<typeof createHarness>;

const setMode = (h: Harness, mode: "fast" | "animate") =>
  h.controller.command({ type: "setMode", mode });

const endedCount = (posted: PlaybackMessageBody[]) =>
  posted.filter((message) => message.type === "ended").length;

describe("page constants", () => {
  it("spaces periodic frames by 100 ms, beats every 1000 ms and expects the opaque origin", () => {
    expect(FRAME_MIN_INTERVAL_MS).toBe(100);
    expect(HEARTBEAT_INTERVAL_MS).toBe(1000);
    expect(OPAQUE_ORIGIN).toBe("null");
  });
});

describe("setMode on a lesson", () => {
  it("animate: remounts the Player, restarts from frame 0 and sends nothing yet", () => {
    const h = createHarness(LESSON);
    setMode(h, "animate");
    expect(h.calls).toEqual(["remount", "seekTo(0)", "play"]);
    expect(h.posted).toEqual([]);
  });

  it("animate: plays to the last frame, then sends the last frame and ended, and holds it", () => {
    const h = createHarness(LESSON);
    setMode(h, "animate");
    h.runPlayback();
    expect(h.posted.slice(-2)).toEqual([frameMsg(LAST, false), ENDED]);
    expect(endedCount(h.posted)).toBe(1);
    expect(h.player).toEqual({ frame: LAST, playing: false });
    const callsAtEnd = h.calls.length;
    h.runPlayback();
    expect(h.calls).toHaveLength(callsAtEnd);
  });

  it("fast: shows the last frame, pauses, and reports paused with reason end", () => {
    const h = createHarness(LESSON);
    setMode(h, "fast");
    expect(h.calls).toEqual(["remount", `seekTo(${LAST})`, "pause"]);
    expect(h.posted).toEqual([frameMsg(LAST, false), pausedMsg("end", LAST)]);
  });
});

describe("setMode on a puzzle", () => {
  it("animate: remounts and plays from frame 0", () => {
    const h = createHarness(PUZZLE);
    setMode(h, "animate");
    expect(h.calls).toEqual(["remount", "seekTo(0)", "play"]);
    expect(h.posted).toEqual([]);
  });

  it("animate: stops at pauseAtFrame, seeks to exactly it and reports paused interaction", () => {
    const h = createHarness(PUZZLE);
    setMode(h, "animate");
    h.runPlayback();
    expect(h.calls.slice(3)).toEqual(["pause", `seekTo(${PAUSE_AT})`]);
    expect(h.posted.slice(-2)).toEqual([frameMsg(PAUSE_AT, false), pausedMsg("interaction", PAUSE_AT)]);
    expect(endedCount(h.posted)).toBe(0);
    expect(h.player).toEqual({ frame: PAUSE_AT, playing: false });
  });

  it("animate: a Player that jumps past the pause point is brought back to it exactly", () => {
    const h = createHarness(PUZZLE);
    setMode(h, "animate");
    h.clear();
    h.reportFrame(PAUSE_AT + 7);
    expect(h.calls).toEqual(["pause", `seekTo(${PAUSE_AT})`]);
    expect(h.posted).toEqual([frameMsg(PAUSE_AT, false), pausedMsg("interaction", PAUSE_AT)]);
  });

  it("fast: seeks to pauseAtFrame, pauses and reports paused interaction", () => {
    const h = createHarness(PUZZLE);
    setMode(h, "fast");
    expect(h.calls).toEqual(["remount", `seekTo(${PAUSE_AT})`, "pause"]);
    expect(h.posted).toEqual([frameMsg(PAUSE_AT, false), pausedMsg("interaction", PAUSE_AT)]);
  });
});

describe("setMode a second time", () => {
  it("remounts again and applies the new mode from frame 0", () => {
    const h = createHarness(PUZZLE);
    setMode(h, "animate");
    h.runPlayback();
    h.clear();
    setMode(h, "fast");
    expect(h.calls).toEqual(["remount", `seekTo(${PAUSE_AT})`, "pause"]);
    expect(h.posted).toEqual([frameMsg(PAUSE_AT, false), pausedMsg("interaction", PAUSE_AT)]);
  });

  it("clears an earlier resume: the pause point is a wall again and resume works again", () => {
    const h = createHarness(PUZZLE);
    setMode(h, "fast");
    h.controller.command({ type: "resume" });
    h.clear();
    setMode(h, "fast");
    h.clear();
    h.controller.command({ type: "seek", frame: LAST });
    expect(h.calls).toEqual([`seekTo(${PAUSE_AT})`]);
    h.clear();
    h.controller.command({ type: "resume" });
    expect(h.posted).toEqual([frameMsg(LAST, false), pausedMsg("end", LAST)]);
  });

  it("clears an earlier ended: each animate playback reports its own ended", () => {
    const h = createHarness(LESSON);
    setMode(h, "animate");
    h.runPlayback();
    setMode(h, "animate");
    h.runPlayback();
    expect(endedCount(h.posted)).toBe(2);
  });
});

describe("onPlayerFrame", () => {
  it("clamps the frame it reports to 0..last", () => {
    const h = createHarness(LESSON);
    h.controller.onPlayerFrame(-3);
    h.advance(FRAME_MIN_INTERVAL_MS);
    h.controller.onPlayerFrame(5000);
    h.advance(FRAME_MIN_INTERVAL_MS);
    h.controller.onPlayerFrame(Number.NaN);
    expect(h.posted).toEqual([frameMsg(0, false), frameMsg(LAST, false), frameMsg(0, false)]);
  });

  it("sends a periodic frame at most every 100 ms", () => {
    const h = createHarness(LESSON);
    h.controller.onPlayerFrame(1);
    h.advance(FRAME_MIN_INTERVAL_MS - 1);
    h.controller.onPlayerFrame(2);
    expect(h.posted).toEqual([frameMsg(1, false)]);
    h.advance(1);
    h.controller.onPlayerFrame(3);
    expect(h.posted).toEqual([frameMsg(1, false), frameMsg(3, false)]);
  });

  it("keeps every periodic frame of a whole playback at least 100 ms apart", () => {
    const h = createHarness(LESSON);
    setMode(h, "animate");
    h.runPlayback();
    const frames = h.posted
      .map((message, index) => ({ message, at: h.postedAt[index] }))
      .filter((entry) => entry.message.type === "frame");
    expect(frames.length).toBeGreaterThan(5);
    // The last frame is the forced one that precedes `ended`; the rest are periodic.
    const periodic = frames.slice(0, -1);
    for (let i = 1; i < periodic.length; i += 1) {
      expect(periodic[i].at - periodic[i - 1].at).toBeGreaterThanOrEqual(FRAME_MIN_INTERVAL_MS);
    }
  });

  it("reports whether the Player is playing", () => {
    const h = createHarness(LESSON);
    h.controller.command({ type: "play" });
    h.advance(FRAME_MIN_INTERVAL_MS);
    h.reportFrame(5);
    expect(h.posted).toEqual([frameMsg(5, true)]);
  });

  it("does not stop a lesson, and does not stop a puzzle again after resume", () => {
    const lesson = createHarness(LESSON);
    setMode(lesson, "animate");
    lesson.runPlayback();
    expect(lesson.posted.some((message) => message.type === "paused")).toBe(false);

    const puzzle = createHarness(PUZZLE);
    setMode(puzzle, "fast");
    puzzle.controller.command({ type: "resume" });
    expect(puzzle.posted.filter((message) => message.type === "paused")).toHaveLength(2);
    puzzle.clear();
    puzzle.advance(FRAME_MIN_INTERVAL_MS);
    puzzle.player.playing = true;
    puzzle.reportFrame(PAUSE_AT + 10);
    expect(puzzle.calls).toEqual([]);
    expect(puzzle.posted).toEqual([frameMsg(PAUSE_AT + 10, true)]);
  });

  it("does not stop a puzzle that is not playing", () => {
    const h = createHarness(PUZZLE);
    h.reportFrame(PAUSE_AT);
    expect(h.calls).toEqual([]);
    expect(h.posted).toEqual([frameMsg(PAUSE_AT, false)]);
  });

  it("never reports a frame past the pause point while the puzzle is unanswered", () => {
    const h = createHarness(PUZZLE);
    setMode(h, "fast");
    h.clear();
    h.advance(FRAME_MIN_INTERVAL_MS);
    h.controller.onPlayerFrame(PAUSE_AT + 40);
    expect(h.posted).toEqual([frameMsg(PAUSE_AT, false)]);
  });
});

describe("play", () => {
  it("starts the Player from where it is", () => {
    const h = createHarness(LESSON);
    h.player.frame = 5;
    h.controller.command({ type: "play" });
    expect(h.calls).toEqual(["play"]);
  });

  it("at the last frame changes nothing and sends nothing", () => {
    const h = createHarness(LESSON);
    h.player.frame = LAST;
    h.controller.command({ type: "play" });
    expect(h.calls).toEqual([]);
    expect(h.posted).toEqual([]);
  });

  it("while the puzzle waits at its pause point, replays from frame 0 up to it again", () => {
    const h = createHarness(PUZZLE);
    setMode(h, "fast");
    h.clear();
    h.controller.command({ type: "play" });
    expect(h.calls).toEqual(["seekTo(0)", "play"]);
    expect(h.posted).toEqual([]);
    h.runPlayback();
    expect(h.posted.slice(-2)).toEqual([frameMsg(PAUSE_AT, false), pausedMsg("interaction", PAUSE_AT)]);
    expect(h.player).toEqual({ frame: PAUSE_AT, playing: false });
  });

  it("after an ended, seek to 0 and play replay the animation and report a second ended", () => {
    const h = createHarness(LESSON);
    setMode(h, "animate");
    h.runPlayback();
    h.controller.command({ type: "seek", frame: 0 });
    h.controller.command({ type: "play" });
    h.runPlayback();
    expect(endedCount(h.posted)).toBe(2);
  });
});

describe("pause", () => {
  it("pauses the Player and sends a forced frame, even inside the 100 ms spacing", () => {
    const h = createHarness(LESSON);
    h.controller.command({ type: "play" });
    h.reportFrame(40);
    h.clear();
    h.controller.command({ type: "pause" });
    h.controller.command({ type: "pause" });
    expect(h.calls).toEqual(["pause", "pause"]);
    expect(h.posted).toEqual([frameMsg(40, false), frameMsg(40, false)]);
  });

  it("makes the next periodic frame wait 100 ms after the forced one", () => {
    const h = createHarness(LESSON);
    h.player.frame = 40;
    h.controller.command({ type: "pause" });
    h.advance(FRAME_MIN_INTERVAL_MS - 1);
    h.controller.onPlayerFrame(41);
    expect(h.posted).toEqual([frameMsg(40, false)]);
  });
});

describe("seek", () => {
  it("clamps to 0..last on a lesson and sends a forced frame each time", () => {
    const h = createHarness(LESSON);
    h.controller.command({ type: "seek", frame: -50 });
    h.controller.command({ type: "seek", frame: Number.MAX_SAFE_INTEGER });
    h.controller.command({ type: "seek", frame: Number.MIN_SAFE_INTEGER });
    expect(h.calls).toEqual(["seekTo(0)", `seekTo(${LAST})`, "seekTo(0)"]);
    expect(h.posted).toEqual([frameMsg(0, false), frameMsg(LAST, false), frameMsg(0, false)]);
  });

  it("keeps playing and says so in the forced frame", () => {
    const h = createHarness(LESSON);
    h.controller.command({ type: "play" });
    h.controller.command({ type: "seek", frame: 30 });
    expect(h.posted).toEqual([frameMsg(30, true)]);
  });

  it("cannot pass the pause point of an unanswered puzzle", () => {
    const h = createHarness(PUZZLE);
    h.controller.command({ type: "seek", frame: 1000 });
    h.controller.command({ type: "seek", frame: Number.MAX_SAFE_INTEGER });
    expect(h.calls).toEqual([`seekTo(${PAUSE_AT})`, `seekTo(${PAUSE_AT})`]);
    expect(h.posted).toEqual([frameMsg(PAUSE_AT, false), frameMsg(PAUSE_AT, false)]);
  });

  it("is limited to the pause point while the puzzle waits, and does not release the wait", () => {
    const h = createHarness(PUZZLE);
    setMode(h, "fast");
    h.clear();
    h.controller.command({ type: "seek", frame: LAST });
    h.controller.command({ type: "seek", frame: 3 });
    expect(h.posted).toEqual([frameMsg(PAUSE_AT, false), frameMsg(3, false)]);
    h.clear();
    h.controller.command({ type: "resume" });
    expect(h.posted).toEqual([frameMsg(LAST, false), pausedMsg("end", LAST)]);
  });

  it("can reach the last frame after resume", () => {
    const h = createHarness(PUZZLE);
    setMode(h, "fast");
    h.controller.command({ type: "resume" });
    h.clear();
    h.controller.command({ type: "seek", frame: 1000 });
    expect(h.calls).toEqual([`seekTo(${LAST})`]);
    expect(h.posted).toEqual([frameMsg(LAST, false)]);
  });
});

describe("resume", () => {
  it("with no wait does nothing on a lesson", () => {
    const h = createHarness(LESSON);
    setMode(h, "animate");
    h.clear();
    h.controller.command({ type: "resume" });
    expect(h.calls).toEqual([]);
    expect(h.posted).toEqual([]);
  });

  it("before the puzzle reached its pause point does nothing, and the pause still happens", () => {
    const h = createHarness(PUZZLE);
    setMode(h, "animate");
    h.clear();
    h.controller.command({ type: "resume" });
    expect(h.calls).toEqual([]);
    expect(h.posted).toEqual([]);
    h.runPlayback();
    expect(h.posted.slice(-2)).toEqual([frameMsg(PAUSE_AT, false), pausedMsg("interaction", PAUSE_AT)]);
  });

  it("animate: plays on to the last frame and reports ended", () => {
    const h = createHarness(PUZZLE);
    setMode(h, "animate");
    h.runPlayback();
    h.clear();
    h.controller.command({ type: "resume" });
    expect(h.calls).toEqual(["play"]);
    h.runPlayback();
    expect(h.posted.slice(-2)).toEqual([frameMsg(LAST, false), ENDED]);
    expect(endedCount(h.posted)).toBe(1);
    expect(h.posted.some((message) => message.type === "paused")).toBe(false);
  });

  it("fast: seeks to the last frame, pauses and reports paused with reason end", () => {
    const h = createHarness(PUZZLE);
    setMode(h, "fast");
    h.clear();
    h.controller.command({ type: "resume" });
    expect(h.calls).toEqual([`seekTo(${LAST})`, "pause"]);
    expect(h.posted).toEqual([frameMsg(LAST, false), pausedMsg("end", LAST)]);
  });

  it("answers a wait only once: a second resume changes nothing", () => {
    for (const mode of ["fast", "animate"] as const) {
      const h = createHarness(PUZZLE);
      setMode(h, mode);
      h.runPlayback();
      h.controller.command({ type: "resume" });
      h.runPlayback();
      h.clear();
      h.controller.command({ type: "resume" });
      expect(h.calls).toEqual([]);
      expect(h.posted).toEqual([]);
    }
  });
});

describe("ended", () => {
  it("is sent at most once per playback", () => {
    const h = createHarness(LESSON);
    setMode(h, "animate");
    h.runPlayback();
    h.controller.onPlayerEnded();
    h.controller.onPlayerEnded();
    expect(endedCount(h.posted)).toBe(1);
  });

  it("is not sent after fast mode already reported paused with reason end", () => {
    const h = createHarness(LESSON);
    setMode(h, "fast");
    h.clear();
    h.controller.onPlayerEnded();
    expect(h.posted).toEqual([]);
  });

  it("is not sent by a puzzle before it is resumed, even when the pause point is the last frame", () => {
    const h = createHarness({ durationInFrames: 60, pauseAtFrame: 59 });
    setMode(h, "animate");
    h.runPlayback();
    expect(h.posted.slice(-2)).toEqual([frameMsg(59, false), pausedMsg("interaction", 59)]);
    expect(endedCount(h.posted)).toBe(0);
    h.controller.onPlayerEnded();
    expect(endedCount(h.posted)).toBe(0);
  });

  it("is sent at once by a resume that has nothing left to play", () => {
    const h = createHarness({ durationInFrames: 60, pauseAtFrame: 59 });
    setMode(h, "animate");
    h.runPlayback();
    h.clear();
    h.controller.command({ type: "resume" });
    expect(h.calls).toEqual([]);
    expect(h.posted).toEqual([frameMsg(59, false), ENDED]);
  });

  it("holds the pause point when the Player reports the end before the last frameupdate", () => {
    const h = createHarness({ durationInFrames: 60, pauseAtFrame: 59 });
    setMode(h, "animate");
    h.player.frame = 59;
    h.player.playing = false;
    h.clear();
    h.controller.onPlayerEnded();
    expect(h.posted).toEqual([frameMsg(59, false), pausedMsg("interaction", 59)]);
  });
});

describe("halt (after an error was sent)", () => {
  it("pauses the Player and ignores every later command and Player event", () => {
    const h = createHarness(PUZZLE);
    setMode(h, "animate");
    h.reportFrame(10);
    h.clear();
    h.controller.halt();
    expect(h.calls).toEqual(["pause"]);
    h.controller.command({ type: "play" });
    h.controller.command({ type: "pause" });
    h.controller.command({ type: "seek", frame: 5 });
    h.controller.command({ type: "resume" });
    setMode(h, "fast");
    h.advance(1000);
    h.controller.onPlayerFrame(PAUSE_AT + 1);
    h.controller.onPlayerEnded();
    h.controller.halt();
    expect(h.posted).toEqual([]);
    expect(h.calls).toEqual(["pause"]);
  });
});

describe("invariants", () => {
  /** Each scenario drives a fresh harness; the invariants then look at everything it sent. */
  const scenarios: Array<[string, RuntimeMeta, (h: Harness) => void]> = [
    [
      "lesson animate",
      LESSON,
      (h) => {
        setMode(h, "animate");
        h.runPlayback();
      },
    ],
    ["lesson fast", LESSON, (h) => setMode(h, "fast")],
    [
      "puzzle animate",
      PUZZLE,
      (h) => {
        setMode(h, "animate");
        h.runPlayback();
      },
    ],
    ["puzzle fast", PUZZLE, (h) => setMode(h, "fast")],
    [
      "puzzle animate then resume",
      PUZZLE,
      (h) => {
        setMode(h, "animate");
        h.runPlayback();
        h.controller.command({ type: "resume" });
        h.runPlayback();
      },
    ],
    [
      "puzzle fast then resume",
      PUZZLE,
      (h) => {
        setMode(h, "fast");
        h.controller.command({ type: "resume" });
      },
    ],
    [
      "seeks, pause and play in between",
      PUZZLE,
      (h) => {
        setMode(h, "animate");
        h.runPlayback(20);
        h.controller.command({ type: "seek", frame: -5 });
        h.controller.command({ type: "seek", frame: 99999 });
        h.controller.command({ type: "pause" });
        h.controller.command({ type: "play" });
        h.runPlayback();
      },
    ],
  ];

  it.each(scenarios)("%s: a forced frame comes right before every paused and ended", (_name, meta, run) => {
    const h = createHarness(meta);
    run(h);
    h.posted.forEach((message, index) => {
      if (message.type !== "paused" && message.type !== "ended") return;
      const before = h.posted[index - 1];
      expect(before?.type).toBe("frame");
      if (before?.type !== "frame") return;
      expect(before.playing).toBe(false);
      expect(before.frame).toBe(message.type === "paused" ? message.frame : h.last);
    });
  });

  it.each(scenarios)("%s: every frame sent is inside 0..last", (_name, meta, run) => {
    const h = createHarness(meta);
    run(h);
    for (const message of h.posted) {
      if (message.type === "frame" || message.type === "paused") {
        expect(Number.isInteger(message.frame)).toBe(true);
        expect(message.frame).toBeGreaterThanOrEqual(0);
        expect(message.frame).toBeLessThanOrEqual(h.last);
      }
    }
  });
});

/**
 * Added with task 26.3. The real `@remotion/player` reports `ended` from inside `seekTo(last)`,
 * before the call returns. The controller must not treat that as a playback ending (fast mode),
 * and must not open the same wait twice or loop (a pause point on the last frame).
 */
describe("a Player that reports ended from inside seekTo(last)", () => {
  function createReentrantHarness(meta: RuntimeMeta) {
    const last = meta.durationInFrames - 1;
    const posted: PlaybackMessageBody[] = [];
    const player = { frame: 0, playing: false };
    let seekCalls = 0;
    /** Connects the Player's `ended` to the controller, which is created after the port. */
    const wiring = { onEnded: () => {} };
    const port: PlayerPort = {
      remount: () => {
        player.frame = 0;
        player.playing = false;
      },
      play: () => {
        player.playing = true;
      },
      pause: () => {
        player.playing = false;
      },
      seekTo: (frame) => {
        seekCalls += 1;
        if (seekCalls > 50) throw new Error("seekTo is looping");
        player.frame = frame;
        if (frame === last) wiring.onEnded();
      },
      getCurrentFrame: () => player.frame,
      isPlaying: () => player.playing,
    };
    const controller = createRuntimeController({
      meta,
      port,
      post: (message) => posted.push(message),
      now: () => 1_000,
    });
    wiring.onEnded = () => controller.onPlayerEnded();
    return { controller, posted, player, last };
  }

  it("lesson, fast: paused{end} and no ended", () => {
    const h = createReentrantHarness(LESSON);
    h.controller.command({ type: "setMode", mode: "fast" });
    expect(h.posted).toEqual([frameMsg(LAST, false), pausedMsg("end", LAST)]);
  });

  it("puzzle, fast, resume: paused{end} and no ended", () => {
    const h = createReentrantHarness(PUZZLE);
    h.controller.command({ type: "setMode", mode: "fast" });
    h.posted.length = 0;
    h.controller.command({ type: "resume" });
    expect(h.posted).toEqual([frameMsg(LAST, false), pausedMsg("end", LAST)]);
  });

  it("pause point on the last frame, fast: one interaction pause", () => {
    const h = createReentrantHarness({ durationInFrames: DURATION, pauseAtFrame: LAST });
    h.controller.command({ type: "setMode", mode: "fast" });
    expect(h.posted).toEqual([frameMsg(LAST, false), pausedMsg("interaction", LAST)]);
  });

  it("pause point on the last frame, animate: one interaction pause, no loop, then one ended", () => {
    const h = createReentrantHarness({ durationInFrames: DURATION, pauseAtFrame: LAST });
    h.controller.command({ type: "setMode", mode: "animate" });
    h.player.playing = true;
    h.player.frame = LAST;
    expect(() => h.controller.onPlayerFrame(LAST)).not.toThrow();
    expect(h.posted).toEqual([frameMsg(LAST, false), pausedMsg("interaction", LAST)]);

    h.posted.length = 0;
    h.controller.command({ type: "resume" });
    expect(h.posted).toEqual([frameMsg(LAST, false), ENDED]);
  });
});
