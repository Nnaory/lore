/**
 * Tests: the `animating` generation stage (reducer rows of design 7.5, `nextStartDelay`)
 *
 * The reducer table is checked row by row, including the rows that must change nothing (an action
 * whose precondition is not met returns the same state object). A property test throws random
 * action orders at the reducer and checks the totality rule of Requirement 24.12: the stage
 * reaches `done` only when no job is `pending` or `running`, and the status is never `failed`.
 * The reducer tests that existed before the stage (`generation.test.tsx`) are untouched.
 *
 * Requirements 24.1, 24.4, 24.12, 24.13, 24.15, 24.16.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  generationReducer,
  initialGenerationState,
  type AnimationJob,
  type AnimationJobStage,
  type AnimationJobStatus,
  type AnimationPhase,
  type GenerationAction,
  type GenerationStage,
  type GenerationState,
} from "@/lib/generation/generation";
import { nextStartDelay } from "@/lib/generation/animating";
import type { AnimationReference } from "@/lib/types/animation";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const reference: AnimationReference = {
  animation_id: "0b0a4c1e-0000-4000-8000-000000000001",
  source_sha256: "a".repeat(64),
  bundle_sha256: "b".repeat(64),
  width: 1280,
  height: 720,
  fps: 30,
  duration_in_frames: 150,
  contract_version: 1,
};

function job(id: string, status: AnimationJobStatus = "pending", extra: Partial<AnimationJob> = {}): AnimationJob {
  return {
    id,
    storyId: "story_01",
    target: { kind: "puzzle", puzzle_id: id },
    title: `Title ${id}`,
    status,
    stage: null,
    attempt: 0,
    ...extra,
  };
}

/** Freezes a value and everything inside it, so a reducer that mutates its input throws. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const writing = (): GenerationState => ({ ...initialGenerationState, stage: "writing" });

/** A state in the animating stage with exactly these jobs. `status` only matters when compared. */
function animating(jobs: AnimationJob[], skipRequested = false): GenerationState {
  return deepFreeze({
    ...initialGenerationState,
    stage: "animating",
    status: "running",
    animation: { jobs, skipRequested },
  });
}

const reduce = (state: GenerationState, action: GenerationAction) => generationReducer(state, action);

const jobOf = (state: GenerationState, id: string): AnimationJob => {
  const found = state.animation?.jobs.find((j) => j.id === id);
  if (!found) throw new Error(`no job ${id}`);
  return found;
};

const statuses = (state: GenerationState) => state.animation?.jobs.map((j) => j.status);

const isActive = (j: AnimationJob) => j.status === "pending" || j.status === "running";

// ---------------------------------------------------------------------------
// Initial state and compatibility
// ---------------------------------------------------------------------------

describe("initial state", () => {
  it("has no animation phase", () => {
    expect(initialGenerationState.animation).toBeNull();
  });

  it("keeps the old actions working without an animation phase", () => {
    let state = reduce(initialGenerationState, { type: "stage_started", stage: "writing" });
    expect(state).toMatchObject({ stage: "writing", status: "running", animation: null });
    state = reduce(state, { type: "all_stories_ready" });
    expect(state).toMatchObject({ stage: "done", status: "waiting", animation: null });
    expect(reduce(state, { type: "reset" })).toBe(initialGenerationState);
  });

  it("drops an animation phase when an earlier stage starts again", () => {
    const state = reduce(animating([job("a", "failed", { code: "X" })]), { type: "stage_started", stage: "planning" });
    expect(state).toMatchObject({ stage: "planning", status: "running", animation: null });
  });
});

// ---------------------------------------------------------------------------
// One test group per row of the transition table
// ---------------------------------------------------------------------------

describe("animating_started", () => {
  const jobs = [job("a"), job("b")];

  it("enters the animating stage from writing with every job pending", () => {
    const state = reduce({ ...writing(), error: "old", status: "failed" }, { type: "animating_started", jobs });
    expect(state).toMatchObject({ stage: "animating", status: "running", error: null });
    expect(state.animation).toEqual({ jobs, skipRequested: false });
  });

  it("copies the jobs so the caller's list cannot change the state", () => {
    const mine = [job("a")];
    const state = reduce(writing(), { type: "animating_started", jobs: mine });
    mine[0].status = "ready";
    mine.push(job("late"));
    expect(statuses(state)).toEqual(["pending"]);
  });

  it.each<GenerationStage>(["analyzing", "reviewing", "planning", "animating", "done"])(
    "does nothing from the %s stage",
    (stage) => {
      const before = deepFreeze({ ...initialGenerationState, stage });
      expect(reduce(before, { type: "animating_started", jobs })).toBe(before);
    }
  );
});

describe("animation_job_started", () => {
  it("starts a pending job and resets its stage and attempt", () => {
    const state = reduce(animating([job("a", "pending", { stage: "verifying", attempt: 3 }), job("b")]), {
      type: "animation_job_started",
      jobId: "a",
    });
    expect(jobOf(state, "a")).toMatchObject({ status: "running", stage: null, attempt: 0 });
    expect(jobOf(state, "b").status).toBe("pending");
    expect(state.status).toBe("running");
  });

  it.each<AnimationJobStatus>(["running", "ready", "failed", "skipped"])("ignores a %s job", (status) => {
    const before = animating([job("a", status)]);
    expect(reduce(before, { type: "animation_job_started", jobId: "a" })).toBe(before);
  });

  it("ignores an unknown job id", () => {
    const before = animating([job("a")]);
    expect(reduce(before, { type: "animation_job_started", jobId: "zzz" })).toBe(before);
  });
});

describe("animation_job_progress", () => {
  it("records the stage and attempt of a running job", () => {
    const state = reduce(animating([job("a", "running")]), {
      type: "animation_job_progress",
      jobId: "a",
      stage: "repairing",
      attempt: 2,
    });
    expect(jobOf(state, "a")).toMatchObject({ status: "running", stage: "repairing", attempt: 2 });
  });

  it.each<AnimationJobStatus>(["pending", "ready", "failed", "skipped"])("ignores a %s job", (status) => {
    const before = animating([job("a", status)]);
    const action: GenerationAction = { type: "animation_job_progress", jobId: "a", stage: "verifying", attempt: 1 };
    expect(reduce(before, action)).toBe(before);
  });
});

describe("animation_job_ready", () => {
  it("marks a running job ready and keeps its reference", () => {
    const state = reduce(animating([job("a", "running", { stage: "publishing", attempt: 1 })]), {
      type: "animation_job_ready",
      jobId: "a",
      reference,
    });
    expect(jobOf(state, "a")).toMatchObject({ status: "ready", reference });
    expect(jobOf(state, "a").code).toBeUndefined();
  });

  it.each<AnimationJobStatus>(["pending", "ready", "failed", "skipped"])(
    "ignores a %s job (a late result changes nothing)",
    (status) => {
      const before = animating([job("a", status)]);
      expect(reduce(before, { type: "animation_job_ready", jobId: "a", reference })).toBe(before);
    }
  );
});

describe("animation_job_failed", () => {
  it("marks a running job failed with its code", () => {
    const state = reduce(animating([job("a", "running", { stage: "verifying", attempt: 2 })]), {
      type: "animation_job_failed",
      jobId: "a",
      code: "ANIMATION_VERIFICATION_FAILED",
    });
    expect(jobOf(state, "a")).toMatchObject({ status: "failed", code: "ANIMATION_VERIFICATION_FAILED" });
  });

  it("marks a ready job failed and drops its reference (attachAnimation refused it)", () => {
    const state = reduce(animating([job("a", "ready", { reference })]), {
      type: "animation_job_failed",
      jobId: "a",
      code: "ATTACH_FAILED",
    });
    expect(jobOf(state, "a")).toMatchObject({ status: "failed", code: "ATTACH_FAILED" });
    expect(jobOf(state, "a").reference).toBeUndefined();
  });

  it("keeps the timeout code when ABORTED arrives afterwards", () => {
    let state = reduce(animating([job("a", "running")]), {
      type: "animation_job_failed",
      jobId: "a",
      code: "ANIMATION_TIMEOUT",
    });
    const afterTimeout = state;
    state = reduce(state, { type: "animation_job_failed", jobId: "a", code: "ABORTED" });
    expect(state).toBe(afterTimeout);
    expect(jobOf(state, "a").code).toBe("ANIMATION_TIMEOUT");
  });

  it.each<AnimationJobStatus>(["pending", "skipped"])("ignores a %s job", (status) => {
    const before = animating([job("a", status)]);
    expect(reduce(before, { type: "animation_job_failed", jobId: "a", code: "X" })).toBe(before);
  });
});

describe("animation_jobs_skipped", () => {
  it("skips pending and running jobs and leaves the others as they are", () => {
    const before = animating([
      job("p", "pending"),
      job("r", "running"),
      job("d", "ready", { reference }),
      job("f", "failed", { code: "X" }),
      job("s", "skipped"),
    ]);
    const state = reduce(before, { type: "animation_jobs_skipped", jobIds: ["p", "r", "d", "f", "s", "unknown"] });
    expect(statuses(state)).toEqual(["skipped", "skipped", "ready", "failed", "skipped"]);
    expect(jobOf(state, "d").reference).toEqual(reference);
    expect(jobOf(state, "f").code).toBe("X");
  });

  it("skips only the listed jobs", () => {
    const state = reduce(animating([job("a"), job("b")]), { type: "animation_jobs_skipped", jobIds: ["b"] });
    expect(statuses(state)).toEqual(["pending", "skipped"]);
  });

  it("returns the same state when nothing can be skipped", () => {
    const before = animating([job("a", "ready", { reference }), job("b", "failed", { code: "X" })]);
    expect(reduce(before, { type: "animation_jobs_skipped", jobIds: ["a", "b", "zzz"] })).toBe(before);
    expect(reduce(before, { type: "animation_jobs_skipped", jobIds: [] })).toBe(before);
  });
});

describe("animation_skip_requested", () => {
  it("sets the flag", () => {
    const state = reduce(animating([job("a", "running")]), { type: "animation_skip_requested" });
    expect(state.animation?.skipRequested).toBe(true);
  });

  it("is idempotent", () => {
    const once = reduce(animating([job("a", "running")]), { type: "animation_skip_requested" });
    expect(reduce(once, { type: "animation_skip_requested" })).toBe(once);
  });

  it("lets the flow finish instead of waiting for a decision", () => {
    const waiting = reduce(animating([job("a", "running"), job("b", "ready", { reference })]), {
      type: "animation_job_failed",
      jobId: "a",
      code: "X",
    });
    expect(waiting.status).toBe("waiting");
    expect(reduce(waiting, { type: "animation_skip_requested" }).status).toBe("running");
  });
});

describe("animation_retry", () => {
  const before = () =>
    animating(
      [
        job("ok", "ready", { reference, stage: "publishing", attempt: 1 }),
        job("bad", "failed", { code: "ANIMATION_TIMEOUT", stage: "generating", attempt: 2 }),
        job("skip", "skipped", { stage: "verifying", attempt: 1 }),
      ],
      true
    );

  it("puts failed and skipped jobs back to pending and keeps the ready one", () => {
    const state = reduce(before(), { type: "animation_retry" });
    expect(statuses(state)).toEqual(["ready", "pending", "pending"]);
    expect(jobOf(state, "ok").reference).toEqual(reference);
    for (const id of ["bad", "skip"]) {
      expect(jobOf(state, id)).toMatchObject({ stage: null, attempt: 0 });
      expect(jobOf(state, id).code).toBeUndefined();
    }
  });

  it("clears the skip request and runs again", () => {
    const state = reduce(before(), { type: "animation_retry" });
    expect(state.animation?.skipRequested).toBe(false);
    expect(state.status).toBe("running");
  });

  it("does nothing when no job failed or was skipped", () => {
    const same = animating([job("a", "ready", { reference }), job("b", "running")]);
    expect(reduce(same, { type: "animation_retry" })).toBe(same);
  });
});

describe("animating_finished", () => {
  it("ends the stage when no job is pending or running", () => {
    const state = reduce(animating([job("a", "ready", { reference }), job("b", "failed", { code: "X" })], true), {
      type: "animating_finished",
    });
    expect(state).toMatchObject({ stage: "done", status: "waiting" });
  });

  it("ends the stage when there are no jobs at all", () => {
    expect(reduce(animating([]), { type: "animating_finished" })).toMatchObject({ stage: "done", status: "waiting" });
  });

  it.each<AnimationJobStatus>(["pending", "running"])("is refused while a job is %s", (status) => {
    const before = animating([job("a", "ready", { reference }), job("b", status)]);
    expect(reduce(before, { type: "animating_finished" })).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Status, the all_stories_ready guard, and actions outside the stage
// ---------------------------------------------------------------------------

describe("derived status", () => {
  it("is running while a job is pending or running", () => {
    let state = reduce(writing(), { type: "animating_started", jobs: [job("a"), job("b")] });
    state = reduce(state, { type: "animation_job_started", jobId: "a" });
    state = reduce(state, { type: "animation_job_failed", jobId: "a", code: "VERIFY" });
    expect(statuses(state)).toEqual(["failed", "pending"]);
    expect(state.status).toBe("running");
  });

  it("is waiting once only failed or skipped jobs are left, and running again after a retry", () => {
    let state = reduce(writing(), { type: "animating_started", jobs: [job("a"), job("b")] });
    state = reduce(state, { type: "animation_job_started", jobId: "a" });
    state = reduce(state, { type: "animation_job_ready", jobId: "a", reference });
    expect(state.status).toBe("running"); // b is still pending
    state = reduce(state, { type: "animation_jobs_skipped", jobIds: ["b"] });
    expect(state.status).toBe("waiting");
    state = reduce(state, { type: "animation_retry" });
    expect(state.status).toBe("running");
  });

  it("is running, not waiting, when every job is ready", () => {
    let state = reduce(writing(), { type: "animating_started", jobs: [job("a")] });
    state = reduce(state, { type: "animation_job_started", jobId: "a" });
    state = reduce(state, { type: "animation_job_ready", jobId: "a", reference });
    expect(state.status).toBe("running");
    expect(reduce(state, { type: "animating_finished" })).toMatchObject({ stage: "done", status: "waiting" });
  });

  it("is never failed for an animation error", () => {
    let state = reduce(writing(), { type: "animating_started", jobs: [job("a"), job("b")] });
    for (const id of ["a", "b"]) {
      state = reduce(state, { type: "animation_job_started", jobId: id });
      state = reduce(state, { type: "animation_job_failed", jobId: id, code: "ANIMATION_NOT_CONFIGURED" });
      expect(state.status).not.toBe("failed");
      expect(state.error).toBeNull();
    }
  });
});

describe("all_stories_ready while animating", () => {
  it.each<AnimationJobStatus>(["pending", "running"])("keeps the same state while a job is %s", (status) => {
    const before = animating([job("a", status)]);
    expect(reduce(before, { type: "all_stories_ready" })).toBe(before);
  });

  it("ends the stage when no job is active", () => {
    const state = reduce(animating([job("a", "ready", { reference })]), { type: "all_stories_ready" });
    expect(state).toMatchObject({ stage: "done", status: "waiting" });
  });

  it("behaves as before from the writing stage", () => {
    expect(reduce(writing(), { type: "all_stories_ready" })).toMatchObject({ stage: "done", status: "waiting" });
  });
});

describe("animation actions outside the animating stage", () => {
  const phase: AnimationPhase = { jobs: [job("a", "failed", { code: "X" }), job("b", "running")], skipRequested: false };
  const actions: GenerationAction[] = [
    { type: "animation_job_started", jobId: "b" },
    { type: "animation_job_progress", jobId: "b", stage: "generating", attempt: 1 },
    { type: "animation_job_ready", jobId: "b", reference },
    { type: "animation_job_failed", jobId: "b", code: "X" },
    { type: "animation_jobs_skipped", jobIds: ["a", "b"] },
    { type: "animation_skip_requested" },
    { type: "animation_retry" },
    { type: "animating_finished" },
  ];
  const stages: GenerationStage[] = ["analyzing", "reviewing", "planning", "writing", "done"];

  for (const stage of stages) {
    for (const action of actions) {
      it(`${action.type} leaves a ${stage} state unchanged`, () => {
        const withPhase = deepFreeze({ ...initialGenerationState, stage, animation: phase });
        const withoutPhase = deepFreeze({ ...initialGenerationState, stage });
        expect(reduce(withPhase, action)).toBe(withPhase);
        expect(reduce(withoutPhase, action)).toBe(withoutPhase);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Property: any order of actions
// ---------------------------------------------------------------------------

const jobIds = ["j1", "j2", "j3"] as const;
const jobIdArb = fc.constantFrom<string>(...jobIds, "unknown");
const stageArb = fc.constantFrom<AnimationJobStage | null>("generating", "verifying", "repairing", "publishing", null);
const codeArb = fc.constantFrom("ANIMATION_TIMEOUT", "ABORTED", "RATE_LIMITED", "ANIMATION_VERIFICATION_FAILED");

const animationActionArb: fc.Arbitrary<GenerationAction> = fc.oneof(
  fc.record({ type: fc.constant("animation_job_started" as const), jobId: jobIdArb }),
  fc.record({
    type: fc.constant("animation_job_progress" as const),
    jobId: jobIdArb,
    stage: stageArb,
    attempt: fc.integer({ min: 1, max: 4 }),
  }),
  fc.record({ type: fc.constant("animation_job_ready" as const), jobId: jobIdArb, reference: fc.constant(reference) }),
  fc.record({ type: fc.constant("animation_job_failed" as const), jobId: jobIdArb, code: codeArb }),
  fc.record({ type: fc.constant("animation_jobs_skipped" as const), jobIds: fc.array(jobIdArb, { maxLength: 4 }) }),
  fc.constant<GenerationAction>({ type: "animation_skip_requested" }),
  fc.constant<GenerationAction>({ type: "animation_retry" }),
  fc.constant<GenerationAction>({ type: "animating_finished" }),
  fc.constant<GenerationAction>({ type: "all_stories_ready" }),
  fc.constant<GenerationAction>({ type: "animating_started", jobs: jobIds.map((id) => job(id)) })
);

/** The status the table derives from the jobs, written out independently of the reducer. */
function expectedStatus(phase: AnimationPhase): GenerationState["status"] {
  if (phase.jobs.some(isActive)) return "running";
  const needsDecision = phase.jobs.some((j) => j.status === "failed" || j.status === "skipped");
  return needsDecision && !phase.skipRequested ? "waiting" : "running";
}

function expectValid(state: GenerationState) {
  const phase = state.animation;
  // Totality (Requirement 24.12): `done` only without pending or running jobs.
  if (state.stage === "done" && phase) expect(phase.jobs.some(isActive)).toBe(false);
  if (!phase) return;
  expect(phase.jobs).toHaveLength(jobIds.length);
  for (const j of phase.jobs) {
    expect(j.reference !== undefined).toBe(j.status === "ready");
    expect(j.code !== undefined).toBe(j.status === "failed");
    if (j.status === "pending") expect([j.stage, j.attempt]).toEqual([null, 0]);
  }
  if (state.stage === "animating") expect(state.status).toBe(expectedStatus(phase));
}

describe("any order of actions", () => {
  it("keeps the state valid, never fails, and reaches done only without active jobs", () => {
    fc.assert(
      fc.property(fc.array(animationActionArb, { maxLength: 60 }), (actions) => {
        let state: GenerationState = deepFreeze(writing());
        for (const action of actions) {
          state = deepFreeze(generationReducer(state, deepFreeze(action)));
          expect(state.status).not.toBe("failed");
          expect(state.error).toBeNull();
          expectValid(state);
        }
      }),
      { numRuns: 300 }
    );
  });

  it("does not throw for any mix of old and new actions from any stage", () => {
    const anyActionArb = fc.oneof(
      { weight: 4, arbitrary: animationActionArb },
      fc.constant<GenerationAction>({ type: "reset" }),
      fc.constantFrom("analyzing" as const, "planning" as const, "writing" as const).map(
        (stage): GenerationAction => ({ type: "stage_started", stage })
      ),
      fc.constant<GenerationAction>({ type: "concept_toggled", conceptId: "c" }),
      fc.constant<GenerationAction>({ type: "failed", message: "boom" })
    );
    const startArb = fc.constantFrom<GenerationStage>("analyzing", "reviewing", "planning", "writing", "animating", "done");
    fc.assert(
      fc.property(startArb, fc.array(anyActionArb, { maxLength: 60 }), (stage, actions) => {
        let state: GenerationState = deepFreeze({ ...initialGenerationState, stage });
        for (const action of actions) {
          state = deepFreeze(generationReducer(state, deepFreeze(action)));
          if (state.stage === "done" && state.animation) expect(state.animation.jobs.some(isActive)).toBe(false);
        }
      }),
      { numRuns: 300 }
    );
  });
});

// ---------------------------------------------------------------------------
// nextStartDelay
// ---------------------------------------------------------------------------

describe("nextStartDelay", () => {
  it("is 0 with no starts and with fewer than four starts in the window", () => {
    expect(nextStartDelay([], 1_000)).toBe(0);
    expect(nextStartDelay([0, 10_000, 20_000], 30_000)).toBe(0);
  });

  it("waits until the oldest start leaves the window once four starts are in it", () => {
    const starts = [0, 10_000, 20_000, 30_000];
    expect(nextStartDelay(starts, 40_000)).toBe(20_000);
    expect(nextStartDelay(starts, 59_999)).toBe(1);
  });

  it("is 0 exactly 60000 ms after the oldest start", () => {
    expect(nextStartDelay([0, 10_000, 20_000, 30_000], 60_000)).toBe(0);
  });

  it("ignores starts older than the window", () => {
    expect(nextStartDelay([-5_000, 10_000, 20_000, 30_000], 56_000)).toBe(0);
  });

  it("waits for enough starts to leave when more than four are in the window", () => {
    // five starts: two must leave so that three remain; the second oldest (1000) decides
    expect(nextStartDelay([0, 1_000, 2_000, 3_000, 4_000], 5_000)).toBe(1_000 + 60_000 - 5_000);
  });

  it("does not depend on the order of `starts` and does not change it", () => {
    const starts = deepFreeze([30_000, 0, 20_000, 10_000]);
    expect(nextStartDelay(starts, 40_000)).toBe(20_000);
  });

  it("takes the limit and window as parameters", () => {
    expect(nextStartDelay([100, 200], 300, 2, 1_000)).toBe(800);
    expect(nextStartDelay([100], 300, 2, 1_000)).toBe(0);
  });

  it("reads a limit below 1 as 1", () => {
    expect(nextStartDelay([], 0, 0)).toBe(0);
    expect(nextStartDelay([0], 10_000, 0)).toBe(50_000);
  });

  it("never starts a fifth request inside a 60 second window (property)", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 90_000 }), { minLength: 1, maxLength: 24 }), (gaps) => {
        const starts: number[] = [];
        let now = 0;
        for (const gap of gaps) {
          now += gap; // the player (or a fast target) is ready after `gap` ms
          now += nextStartDelay(starts, now);
          starts.push(now);
        }
        for (let i = 4; i < starts.length; i += 1) {
          expect(starts[i] - starts[i - 4]).toBeGreaterThanOrEqual(60_000);
        }
      }),
      { numRuns: 200 }
    );
  });

  it("returns a delay between 0 and the window for starts that are not in the future (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.array(fc.integer({ min: 0, max: 200_000 }), { maxLength: 12 }),
        (now, ages) => {
          const delay = nextStartDelay(
            ages.map((age) => now - age),
            now
          );
          expect(delay).toBeGreaterThanOrEqual(0);
          expect(delay).toBeLessThanOrEqual(60_000);
        }
      ),
      { numRuns: 200 }
    );
  });
});
