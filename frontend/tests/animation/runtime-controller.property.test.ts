/**
 * Property tests: RuntimeController is total and keeps its frames in range (task 26.2, design
 * Property 9). Validates Requirement 29.18, and with it 29.12, 29.15, 29.16 and 28.6.
 *
 * Property 9: for every random sequence of `play`, `pause`, `seek` (any safe integer, negative
 * ones included), `setMode` and `resume`, mixed with the Player running and reporting, the
 * controller never throws, only reports frames in `0..durationInFrames-1`, and reports `ended`
 * at most once per playback.
 *
 * The controller is driven with the same kind of fake as `runtime-controller.test.ts`: a
 * `PlayerPort` that keeps a frame and a playing flag, a fake clock, and no `@remotion/player`.
 * Everything the controller does is written to one log (the Player calls it made, the messages it
 * posted and when, and a marker per step), and each property reads that log. The invariants are
 * stated on what is observable (calls and messages), not on the controller's private flags:
 *   - range: every `frame` and `paused` it posts, and every frame it passes to `seekTo`, is a
 *     whole number in `0..last`;
 *   - once per playback: `ended` and `paused{end}` are the two ways a playback is reported as
 *     over, and two of them never follow each other without the Player being restarted (a
 *     `remount`, which `setMode` causes, or a `play`) in between;
 *   - forced frame: a `frame` with `playing: false` is posted right before every `paused` and
 *     `ended`, carrying the same frame (the last frame for `ended`); `paused{interaction}` exists
 *     only for a puzzle, at exactly its `pause_at_frame`, with the Player parked there;
 *   - the wall: until a `resume` answers a wait (a `paused{interaction}` was posted since the
 *     last `remount`), a puzzle never reports or seeks past `pause_at_frame` and never reports its
 *     end. This is what keeps a scrub from showing the answer (Requirement 29.12);
 *   - spacing: a periodic `frame` follows the previous `frame` by at least 100 ms (28.6);
 *   - `resume` with no wait open changes nothing (29.15), and after `halt` nothing is posted and
 *     the Player is not touched (29.16).
 *
 * Two kinds of runs, because a real Player only reports what it did. "Realistic" runs let time
 * pass in `tick` steps that play the fake Player forward and report its `frameupdate` and `ended`
 * the way `@remotion/player` does. "Chaotic" runs also push arbitrary values into `onPlayerFrame`
 * and `onPlayerEnded` at any moment (NaN, negative, huge, an end while stopped). Both kinds also
 * run against a Player that reports `ended` from inside `seekTo(last)` (the real one does, see
 * the end of `runtime-controller.test.ts`).
 *
 * 300 fast-check runs per property (the task asks for at least 100).
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  createRuntimeController,
  type ParentCommand,
  type PlaybackMessageBody,
  type PlayerPort,
  type RuntimeMeta,
} from "../../sandbox-runtime/controller";
import { FRAME_MIN_INTERVAL_MS } from "../../sandbox-runtime/page";

const RUNS = 300;
/** Milliseconds the fake Player takes per frame (about 30 fps). */
const FRAME_MS = 34;

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

type Op =
  | { k: "play" }
  | { k: "pause" }
  | { k: "resume" }
  | { k: "seek"; frame: number }
  | { k: "mode"; mode: "fast" | "animate" }
  /** The Player plays forward for `n` frames' worth of time, reporting as the real one does. */
  | { k: "tick"; n: number }
  | { k: "wait"; ms: number }
  /** Chaotic only: the Player reports `raw` as its frame. */
  | { k: "playerFrame"; raw: number }
  /** Chaotic only: the Player says it ended. */
  | { k: "playerEnded" }
  | { k: "halt" };

interface Scenario {
  meta: RuntimeMeta;
  /** The Player reports `ended` from inside `seekTo(last)`. */
  reentrant: boolean;
  ops: Op[];
}

type Entry =
  | { k: "op"; op: Op }
  | { k: "call"; name: "remount" | "play" | "pause" | "seekTo"; arg?: number }
  | { k: "msg"; msg: PlaybackMessageBody; at: number; via: "cmd" | "player" };

interface Run {
  scenario: Scenario;
  last: number;
  /** Index of the `pause_at_frame`, or `undefined` for a lesson. */
  pausePoint: number | undefined;
  log: Entry[];
}

/** Plays `scenario` against the fake Player and returns the log. Anything the controller throws propagates. */
function runScenario(scenario: Scenario): Run {
  const { meta } = scenario;
  const last = meta.durationInFrames - 1;
  const log: Entry[] = [];
  let clock = 5_000;
  let via: "cmd" | "player" = "cmd";
  const player = { frame: 0, playing: false };
  const wiring = { onEnded: () => {} };

  const port: PlayerPort = {
    remount: () => {
      log.push({ k: "call", name: "remount" });
      player.frame = 0;
      player.playing = false;
    },
    play: () => {
      log.push({ k: "call", name: "play" });
      player.playing = true;
    },
    pause: () => {
      log.push({ k: "call", name: "pause" });
      player.playing = false;
    },
    seekTo: (frame) => {
      log.push({ k: "call", name: "seekTo", arg: frame });
      player.frame = frame;
      if (scenario.reentrant && frame === last) wiring.onEnded();
    },
    getCurrentFrame: () => player.frame,
    isPlaying: () => player.playing,
  };
  const controller = createRuntimeController({
    meta,
    port,
    post: (msg) => log.push({ k: "msg", msg, at: clock, via }),
    now: () => clock,
  });
  wiring.onEnded = () => controller.onPlayerEnded();

  const command = (c: ParentCommand) => {
    via = "cmd";
    controller.command(c);
  };

  for (const op of scenario.ops) {
    log.push({ k: "op", op });
    switch (op.k) {
      case "play":
      case "pause":
      case "resume":
        command({ type: op.k });
        break;
      case "seek":
        command({ type: "seek", frame: op.frame });
        break;
      case "mode":
        command({ type: "setMode", mode: op.mode });
        break;
      case "wait":
        clock += op.ms;
        break;
      case "tick": {
        via = "player";
        for (let step = 0; step < op.n; step += 1) {
          clock += FRAME_MS;
          if (!player.playing) {
            clock += FRAME_MS * (op.n - step - 1);
            break;
          }
          player.frame = Math.min(player.frame + 1, last);
          controller.onPlayerFrame(player.frame);
          if (player.playing && player.frame === last) {
            player.playing = false;
            controller.onPlayerEnded();
          }
        }
        break;
      }
      case "playerFrame":
        via = "player";
        controller.onPlayerFrame(op.raw);
        break;
      case "playerEnded":
        via = "player";
        controller.onPlayerEnded();
        break;
      case "halt":
        controller.halt();
        break;
    }
  }
  return { scenario, last, pausePoint: meta.pauseAtFrame, log };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const intIn = (low: number, high: number) => fc.integer({ min: low, max: high });

/** An animation: a lesson or a puzzle, mostly short so a whole playback is quick to simulate. */
const metaArb: fc.Arbitrary<RuntimeMeta> = fc
  .oneof({ weight: 5, arbitrary: intIn(30, 120) }, { weight: 1, arbitrary: intIn(30, 900) })
  .chain((durationInFrames) =>
    fc
      .oneof(
        { weight: 2, arbitrary: fc.constant<number | undefined>(undefined) },
        { weight: 3, arbitrary: intIn(1, durationInFrames - 1) },
        { weight: 1, arbitrary: fc.constantFrom(1, durationInFrames - 1, durationInFrames - 2) },
      )
      .map((pauseAtFrame): RuntimeMeta => ({
        durationInFrames,
        ...(pauseAtFrame !== undefined ? { pauseAtFrame: Math.max(1, pauseAtFrame) } : {}),
      })),
  );

/** `seek` targets: the whole safe-integer range, and the frames around the interesting points. */
const seekArb = (meta: RuntimeMeta): fc.Arbitrary<number> => {
  const last = meta.durationInFrames - 1;
  const pause = meta.pauseAtFrame ?? last;
  return fc.oneof(
    { weight: 3, arbitrary: intIn(-3, last + 3) },
    { weight: 2, arbitrary: fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }) },
    {
      weight: 2,
      arbitrary: fc.constantFrom(
        0,
        -1,
        pause - 1,
        pause,
        pause + 1,
        last - 1,
        last,
        last + 1,
        Number.MAX_SAFE_INTEGER,
        Number.MIN_SAFE_INTEGER,
      ),
    },
  );
};

const waitArb = fc.oneof(intIn(0, 250), fc.constantFrom(0, 99, 100, 101));
const tickArb = fc.oneof(
  { weight: 3, arbitrary: intIn(1, 6) },
  { weight: 2, arbitrary: intIn(1, 60) },
  { weight: 2, arbitrary: intIn(100, 1000) },
);

/** The operations a parent and a real Player can cause. */
const realisticOpArb = (meta: RuntimeMeta): fc.Arbitrary<Op> =>
  fc.oneof(
    { weight: 2, arbitrary: fc.constant<Op>({ k: "play" }) },
    { weight: 2, arbitrary: fc.constant<Op>({ k: "pause" }) },
    { weight: 3, arbitrary: fc.constant<Op>({ k: "resume" }) },
    { weight: 4, arbitrary: seekArb(meta).map((frame): Op => ({ k: "seek", frame })) },
    { weight: 3, arbitrary: fc.constantFrom<"fast" | "animate">("fast", "animate").map((mode): Op => ({ k: "mode", mode })) },
    { weight: 6, arbitrary: tickArb.map((n): Op => ({ k: "tick", n })) },
    { weight: 2, arbitrary: waitArb.map((ms): Op => ({ k: "wait", ms })) },
  );

/** Reports a real Player never makes, on top of the realistic operations. */
const chaoticOpArb = (meta: RuntimeMeta): fc.Arbitrary<Op> => {
  const last = meta.durationInFrames - 1;
  const rawFrame = fc.oneof(
    intIn(-5, last + 5),
    fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
    fc.double(),
    fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, 0.5, last, last + 1),
  );
  return fc.oneof(
    { weight: 6, arbitrary: realisticOpArb(meta) },
    { weight: 3, arbitrary: rawFrame.map((raw): Op => ({ k: "playerFrame", raw })) },
    { weight: 2, arbitrary: fc.constant<Op>({ k: "playerEnded" }) },
  );
};

const scenarioArb = (
  opArb: (meta: RuntimeMeta) => fc.Arbitrary<Op>,
  maxOps = 40,
): fc.Arbitrary<Scenario> =>
  fc.record({ meta: metaArb, reentrant: fc.boolean() }).chain(({ meta, reentrant }) =>
    fc
      .array(opArb(meta), { minLength: 1, maxLength: maxOps })
      .map((ops): Scenario => ({ meta, reentrant, ops })),
  );

const realistic = scenarioArb(realisticOpArb);
const chaotic = scenarioArb(chaoticOpArb);

// ---------------------------------------------------------------------------
// The invariants, each read from the log
// ---------------------------------------------------------------------------

type MsgEntry = Extract<Entry, { k: "msg" }>;

const messages = (run: Run): MsgEntry[] =>
  run.log.filter((entry): entry is MsgEntry => entry.k === "msg");

const isWholeFrame = (value: number, last: number): boolean =>
  Number.isInteger(value) && value >= 0 && value <= last;

function expectFramesInRange(run: Run): void {
  for (const entry of run.log) {
    if (entry.k === "msg" && (entry.msg.type === "frame" || entry.msg.type === "paused")) {
      expect(isWholeFrame(entry.msg.frame, run.last), `${entry.msg.type} frame ${entry.msg.frame}`).toBe(true);
    }
    if (entry.k === "call" && entry.name === "seekTo") {
      expect(isWholeFrame(entry.arg as number, run.last), `seekTo(${entry.arg})`).toBe(true);
    }
  }
}

/** `ended` and `paused{end}` are the two reports that a playback is over. */
const isTerminal = (msg: PlaybackMessageBody): boolean =>
  msg.type === "ended" || (msg.type === "paused" && msg.reason === "end");

function expectOneReportPerPlayback(run: Run): void {
  let restarted = true; // before the first playback nothing has been reported
  for (const entry of run.log) {
    if (entry.k === "call" && (entry.name === "remount" || entry.name === "play")) restarted = true;
    if (entry.k === "msg" && isTerminal(entry.msg)) {
      expect(restarted, `a second report of the end (${entry.msg.type}) with no restart before it`).toBe(true);
      restarted = false;
    }
  }
}

function expectForcedFrameBeforeStops(run: Run): void {
  const posted = messages(run).map((entry) => entry.msg);
  const calls = run.log.filter((entry) => entry.k === "call");
  posted.forEach((msg, index) => {
    if (msg.type !== "paused" && msg.type !== "ended") return;
    const before = posted[index - 1];
    expect(before?.type, `${msg.type} not preceded by a frame`).toBe("frame");
    if (before?.type !== "frame") return;
    expect(before.playing).toBe(false);
    expect(before.frame).toBe(msg.type === "paused" ? msg.frame : run.last);
    if (msg.type === "paused" && msg.reason === "end") expect(msg.frame).toBe(run.last);
    if (msg.type === "paused" && msg.reason === "interaction") {
      expect(run.pausePoint, "paused{interaction} on a lesson").toBeDefined();
      expect(msg.frame).toBe(run.pausePoint);
    }
  });
  // The Player is parked at the pause point when a puzzle reports it: the last `seekTo` says so.
  let lastSeek: number | undefined;
  for (const entry of run.log) {
    if (entry.k === "call" && entry.name === "seekTo") lastSeek = entry.arg;
    if (entry.k === "msg" && entry.msg.type === "paused" && entry.msg.reason === "interaction") {
      expect(lastSeek, "the Player was not seeked to the pause point").toBe(run.pausePoint);
    }
  }
  expect(calls.length).toBeGreaterThanOrEqual(0);
}

/**
 * The wall. `waitOpen` is true once a `paused{interaction}` was posted since the last `remount`;
 * a `resume` step in that state may release the puzzle. This can only say "released" when the
 * controller might have been, never the other way round, so it never blames the controller for
 * something it was allowed to do.
 */
function expectWallHolds(run: Run): void {
  const pause = run.pausePoint;
  if (pause === undefined) return;
  let waitOpen = false;
  let released = false;
  for (const entry of run.log) {
    if (entry.k === "call" && entry.name === "remount") {
      waitOpen = false;
      released = false;
    }
    if (entry.k === "op" && entry.op.k === "resume" && waitOpen) released = true;
    if (entry.k === "msg" && entry.msg.type === "paused" && entry.msg.reason === "interaction") waitOpen = true;
    if (released) continue;
    if (entry.k === "msg") {
      const { msg } = entry;
      if (msg.type === "frame" || msg.type === "paused") {
        expect(msg.frame, `${msg.type} past the pause point before resume`).toBeLessThanOrEqual(pause);
      }
      expect(isTerminal(msg), `the end reported (${msg.type}) before the question was answered`).toBe(false);
    }
    if (entry.k === "call" && entry.name === "seekTo") {
      expect(entry.arg, "seekTo past the pause point before resume").toBeLessThanOrEqual(pause);
    }
  }
}

function expectPeriodicFramesSpaced(run: Run): void {
  const posted = messages(run);
  let previousFrameAt: number | null = null;
  posted.forEach((entry, index) => {
    if (entry.msg.type !== "frame") return;
    const next = posted[index + 1]?.msg;
    const forced = next !== undefined && (next.type === "paused" || next.type === "ended");
    if (entry.via === "player" && !forced && previousFrameAt !== null) {
      expect(entry.at - previousFrameAt, "periodic frames closer than 100 ms").toBeGreaterThanOrEqual(
        FRAME_MIN_INTERVAL_MS,
      );
    }
    previousFrameAt = entry.at;
  });
}

/** A `resume` when no wait was ever opened since the last `remount` does nothing at all. */
function expectResumeWithoutWaitIsQuiet(run: Run): void {
  let waitOpen = false;
  run.log.forEach((entry, index) => {
    if (entry.k === "call" && entry.name === "remount") waitOpen = false;
    if (entry.k === "msg" && entry.msg.type === "paused" && entry.msg.reason === "interaction") waitOpen = true;
    if (entry.k === "op" && entry.op.k === "resume" && !waitOpen) {
      const next = run.log[index + 1];
      expect(next === undefined || next.k === "op", "resume with no wait did something").toBe(true);
    }
  });
}

/** After `halt`: only the single `pause` call it makes, and no message. */
function expectSilentAfterHalt(run: Run): void {
  const at = run.log.findIndex((entry) => entry.k === "op" && entry.op.k === "halt");
  if (at === -1) return;
  const after = run.log.slice(at + 1).filter((entry) => entry.k !== "op");
  expect(after.filter((entry) => entry.k === "msg")).toEqual([]);
  expect(after.filter((entry) => entry.k === "call")).toEqual([{ k: "call", name: "pause" }]);
}

const checkAll = (run: Run): void => {
  expectFramesInRange(run);
  expectOneReportPerPlayback(run);
  expectForcedFrameBeforeStops(run);
  expectWallHolds(run);
  expectPeriodicFramesSpaced(run);
  expectResumeWithoutWaitIsQuiet(run);
};

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe("Property 9: the generators", () => {
  it("make lessons and puzzles, both kinds of Player, and every kind of step", () => {
    const sample = fc.sample(realistic, { numRuns: 400, seed: 9 });
    expect(sample.some((s) => s.meta.pauseAtFrame === undefined)).toBe(true);
    expect(sample.some((s) => s.meta.pauseAtFrame !== undefined)).toBe(true);
    expect(sample.some((s) => s.meta.pauseAtFrame === s.meta.durationInFrames - 1)).toBe(true);
    expect(sample.some((s) => s.reentrant)).toBe(true);
    expect(sample.some((s) => !s.reentrant)).toBe(true);
    const kinds = new Set(sample.flatMap((s) => s.ops.map((op) => op.k)));
    for (const kind of ["play", "pause", "resume", "seek", "mode", "tick", "wait"]) {
      expect(kinds.has(kind as Op["k"])).toBe(true);
    }
    const seeks = sample.flatMap((s) => s.ops.flatMap((op) => (op.k === "seek" ? [op.frame] : [])));
    expect(seeks.some((frame) => frame < 0)).toBe(true);
    expect(seeks.some((frame) => Math.abs(frame) > 1e12)).toBe(true);
  });

  it("reach the states the invariants are about: waits, resumes, ends and fast stops", () => {
    const runs = fc.sample(realistic, { numRuns: 400, seed: 9 }).map(runScenario);
    const count = (predicate: (msg: PlaybackMessageBody) => boolean) =>
      runs.filter((run) => messages(run).some((entry) => predicate(entry.msg))).length;
    expect(count((m) => m.type === "ended")).toBeGreaterThan(20);
    expect(count((m) => m.type === "paused" && m.reason === "end")).toBeGreaterThan(20);
    expect(count((m) => m.type === "paused" && m.reason === "interaction")).toBeGreaterThan(20);
    expect(runs.filter((run) => run.log.some((e) => e.k === "op" && e.op.k === "resume")).length).toBeGreaterThan(50);
    // A puzzle that was answered and then played on to its end.
    const finished = runs.filter((run) => {
      let waited = false;
      return messages(run).some(({ msg }) => {
        if (msg.type === "paused" && msg.reason === "interaction") waited = true;
        return waited && isTerminal(msg);
      });
    });
    expect(finished.length).toBeGreaterThan(5);
  });
});

describe("Property 9: totality and frame range", () => {
  it("never throws and reports only whole frames in 0..last, for any commands and Player", () => {
    fc.assert(
      fc.property(realistic, (scenario) => {
        expectFramesInRange(runScenario(scenario));
      }),
      { numRuns: RUNS },
    );
  });

  it("also holds when the Player reports arbitrary frames and ends at any moment", () => {
    fc.assert(
      fc.property(chaotic, (scenario) => {
        expectFramesInRange(runScenario(scenario));
      }),
      { numRuns: RUNS },
    );
  });

  it("stays total for metas that are not valid: a frame is still a whole number and never negative", () => {
    const oddMeta = fc.record({
      durationInFrames: fc.oneof(
        fc.double(),
        fc.integer({ min: -5, max: 5 }),
        fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, 0, 1, 2.5),
      ),
      pauseAtFrame: fc.option(fc.oneof(fc.double(), fc.integer({ min: -5, max: 50 })), { nil: undefined }),
    });
    const odd = oddMeta.chain((meta) =>
      fc
        .array(chaoticOpArb({ durationInFrames: 10 }), { minLength: 1, maxLength: 20 })
        .map((ops): Scenario => ({ meta, reentrant: false, ops })),
    );
    fc.assert(
      fc.property(odd, (scenario) => {
        const run = runScenario(scenario);
        for (const entry of run.log) {
          if (entry.k === "msg" && (entry.msg.type === "frame" || entry.msg.type === "paused")) {
            expect(Number.isInteger(entry.msg.frame) && entry.msg.frame >= 0).toBe(true);
          }
          if (entry.k === "call" && entry.name === "seekTo") {
            expect(Number.isInteger(entry.arg) && (entry.arg as number) >= 0).toBe(true);
          }
        }
      }),
      { numRuns: RUNS },
    );
  });
});

describe("Property 9: ended at most once per playback", () => {
  it("never reports the end twice without the Player being restarted in between", () => {
    fc.assert(
      fc.property(realistic, (scenario) => {
        expectOneReportPerPlayback(runScenario(scenario));
      }),
      { numRuns: RUNS },
    );
  });

  it("holds against a Player that ends at any moment too", () => {
    fc.assert(
      fc.property(chaotic, (scenario) => {
        expectOneReportPerPlayback(runScenario(scenario));
      }),
      { numRuns: RUNS },
    );
  });

  it("counts a full animate playback as one ended, whatever commands came before it", () => {
    const lesson = fc.record({
      durationInFrames: intIn(30, 200),
      prefix: fc.array(fc.constantFrom<Op>({ k: "pause" }, { k: "resume" }, { k: "seek", frame: -7 }, { k: "wait", ms: 30 }), {
        maxLength: 6,
      }),
      reentrant: fc.boolean(),
    });
    fc.assert(
      fc.property(lesson, ({ durationInFrames, prefix, reentrant }) => {
        const run = runScenario({
          meta: { durationInFrames },
          reentrant,
          ops: [...prefix, { k: "mode", mode: "animate" }, { k: "tick", n: durationInFrames + 20 }, { k: "tick", n: 50 }],
        });
        const ended = messages(run).filter((entry) => entry.msg.type === "ended");
        expect(ended).toHaveLength(1);
      }),
      { numRuns: RUNS },
    );
  });
});

describe("Property 9: a forced frame comes right before paused and ended", () => {
  it("posts the same frame, not playing, and parks a puzzle exactly at its pause point", () => {
    fc.assert(
      fc.property(realistic, (scenario) => {
        expectForcedFrameBeforeStops(runScenario(scenario));
      }),
      { numRuns: RUNS },
    );
  });

  it("holds for a Player that reports arbitrary frames and ends", () => {
    fc.assert(
      fc.property(chaotic, (scenario) => {
        expectForcedFrameBeforeStops(runScenario(scenario));
      }),
      { numRuns: RUNS },
    );
  });
});

describe("Property 9: the pause point is a wall until resume", () => {
  it("reports and seeks no frame past pause_at_frame, and never the end, before the question is answered", () => {
    fc.assert(
      fc.property(realistic, (scenario) => {
        expectWallHolds(runScenario(scenario));
      }),
      { numRuns: RUNS },
    );
  });

  it("holds against arbitrary Player reports", () => {
    fc.assert(
      fc.property(chaotic, (scenario) => {
        expectWallHolds(runScenario(scenario));
      }),
      { numRuns: RUNS },
    );
  });

  it("holds for a puzzle that is never resumed: no sequence of other commands gets past the question", () => {
    const puzzle = metaArb.filter((meta) => meta.pauseAtFrame !== undefined).chain((meta) =>
      fc
        .array(
          realisticOpArb(meta).filter((op) => op.k !== "resume"),
          { minLength: 1, maxLength: 40 },
        )
        .map((ops): Scenario => ({ meta, reentrant: false, ops })),
    );
    fc.assert(
      fc.property(puzzle, (scenario) => {
        const run = runScenario(scenario);
        const pause = run.pausePoint as number;
        for (const entry of run.log) {
          if (entry.k === "msg") {
            expect(isTerminal(entry.msg)).toBe(false);
            if (entry.msg.type === "frame" || entry.msg.type === "paused") {
              expect(entry.msg.frame).toBeLessThanOrEqual(pause);
            }
          }
          if (entry.k === "call" && entry.name === "seekTo") expect(entry.arg).toBeLessThanOrEqual(pause);
        }
      }),
      { numRuns: RUNS },
    );
  });
});

describe("Property 9: spacing, resume without a wait, and halt", () => {
  it("keeps periodic frames at least 100 ms apart", () => {
    fc.assert(
      fc.property(realistic, (scenario) => {
        expectPeriodicFramesSpaced(runScenario(scenario));
      }),
      { numRuns: RUNS },
    );
    fc.assert(
      fc.property(chaotic, (scenario) => {
        expectPeriodicFramesSpaced(runScenario(scenario));
      }),
      { numRuns: RUNS },
    );
  });

  it("does nothing for a resume that no wait is open for", () => {
    fc.assert(
      fc.property(realistic, (scenario) => {
        expectResumeWithoutWaitIsQuiet(runScenario(scenario));
      }),
      { numRuns: RUNS },
    );
  });

  it("posts nothing and leaves the Player alone after halt, whatever comes next", () => {
    const halting = chaotic.chain((scenario) =>
      fc.nat(scenario.ops.length).map((at): Scenario => ({
        ...scenario,
        ops: [...scenario.ops.slice(0, at), { k: "halt" }, ...scenario.ops.slice(at)],
      })),
    );
    fc.assert(
      fc.property(halting, (scenario) => {
        expectSilentAfterHalt(runScenario(scenario));
      }),
      { numRuns: RUNS },
    );
  });

  it("keeps every invariant together on one run, so a pair of rules cannot hide each other", () => {
    fc.assert(
      fc.property(fc.oneof(realistic, chaotic), (scenario) => {
        checkAll(runScenario(scenario));
      }),
      { numRuns: RUNS },
    );
  });
});
