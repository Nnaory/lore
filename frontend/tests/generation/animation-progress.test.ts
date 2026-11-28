/**
 * Tests: the view model of the animating stage (lib/generation/animation-progress.ts)
 *
 * The states come from the real reducer, so the modes are the ones the flow can reach: `running`,
 * `waiting` (the held state, Requirement 24.13), `skipping` and `closed`. Also checked: the `k / n`
 * count, the text of each row, which controls exist per mode, and the stop-code case where the
 * first job is `failed` and the rest are `skipped` while `onDone` is held (Requirement 36.6).
 *
 * Requirements 24.4, 24.6, 24.7, 24.13.
 */

import { describe, expect, it } from "vitest";
import { BUILD_MESSAGES, messageForCode } from "@/lib/contracts/error-messages";
import { animationJobDetail, buildAnimationProgressView } from "@/lib/generation/animation-progress";
import {
  generationReducer,
  initialGenerationState,
  type AnimationJob,
  type GenerationAction,
  type GenerationState,
} from "@/lib/generation/generation";
import type { AnimationReference } from "@/lib/types/animation";

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

function job(id: string, extra: Partial<AnimationJob> = {}): AnimationJob {
  return {
    id,
    storyId: "story_01",
    target: { kind: "puzzle", puzzle_id: id },
    title: `Title ${id}`,
    status: "pending",
    stage: null,
    attempt: 0,
    ...extra,
  };
}

/** The state after `actions`, starting at the writing stage with `ids` as pending jobs. */
function animating(ids: string[], ...actions: GenerationAction[]): GenerationState {
  const start: GenerationState = { ...initialGenerationState, stage: "writing", status: "running" };
  return [{ type: "animating_started", jobs: ids.map((id) => job(id)) } as GenerationAction, ...actions].reduce(
    generationReducer,
    start
  );
}

const started = (jobId: string): GenerationAction => ({ type: "animation_job_started", jobId });
const ready = (jobId: string): GenerationAction => ({ type: "animation_job_ready", jobId, reference });
const failed = (jobId: string, code: string): GenerationAction => ({ type: "animation_job_failed", jobId, code });

describe("buildAnimationProgressView: no stage", () => {
  it("is null while the run has no animating phase (flag off, or not reached yet)", () => {
    expect(buildAnimationProgressView(initialGenerationState)).toBeNull();
    expect(buildAnimationProgressView({ ...initialGenerationState, stage: "done", status: "waiting" })).toBeNull();
  });
});

describe("buildAnimationProgressView: counts and rows", () => {
  it("counts ready, failed and skipped jobs as settled, in job order", () => {
    const state = animating(
      ["a", "b", "c", "d"],
      started("a"),
      ready("a"),
      started("b"),
      failed("b", "NETWORK"),
      { type: "animation_jobs_skipped", jobIds: ["c"] },
      started("d")
    );
    const view = buildAnimationProgressView(state)!;
    expect(view.total).toBe(4);
    expect(view.settled).toBe(3);
    expect(view.unfinished).toBe(2);
    expect(view.rows.map((row) => [row.id, row.status, row.marker])).toEqual([
      ["a", "ready", "done"],
      ["b", "failed", "failed"],
      ["c", "skipped", "skipped"],
      ["d", "running", "active"],
    ]);
    expect(view.rows.map((row) => row.title)).toEqual(["Title a", "Title b", "Title c", "Title d"]);
  });

  it("starts at 0 / n with every row pending", () => {
    const view = buildAnimationProgressView(animating(["a", "b"]))!;
    expect(view.settled).toBe(0);
    expect(view.total).toBe(2);
    expect(view.rows.every((row) => row.status === "pending" && row.marker === "pending")).toBe(true);
  });
});

describe("animationJobDetail", () => {
  it("names the status in plain words", () => {
    expect(animationJobDetail(job("a"))).toBe("Waiting");
    expect(animationJobDetail(job("a", { status: "ready", reference }))).toBe("Ready");
    expect(animationJobDetail(job("a", { status: "skipped" }))).toBe("Skipped");
  });

  it("shows the stage and the attempt of a running job", () => {
    expect(animationJobDetail(job("a", { status: "running" }))).toBe("Starting");
    expect(animationJobDetail(job("a", { status: "running", stage: "generating", attempt: 1 }))).toBe(
      "Writing · attempt 1"
    );
    expect(animationJobDetail(job("a", { status: "running", stage: "verifying", attempt: 2 }))).toBe(
      "Checking · attempt 2"
    );
    expect(animationJobDetail(job("a", { status: "running", stage: "repairing", attempt: 3 }))).toBe(
      "Fixing · attempt 3"
    );
    expect(animationJobDetail(job("a", { status: "running", stage: "publishing", attempt: 3 }))).toBe(
      "Saving · attempt 3"
    );
    // A stage without an attempt number yet: the stage alone.
    expect(animationJobDetail(job("a", { status: "running", stage: "generating", attempt: 0 }))).toBe("Writing");
  });

  it("shows the message of the failure code, and never an empty line", () => {
    expect(animationJobDetail(job("a", { status: "failed", code: "ANIMATION_TIMEOUT" }))).toBe(
      messageForCode("ANIMATION_TIMEOUT")
    );
    expect(animationJobDetail(job("a", { status: "failed" }))).toBe(BUILD_MESSAGES.unexpected);
  });
});

describe("buildAnimationProgressView: modes and controls", () => {
  it("running: only the skip control, with the skip label and no notice", () => {
    const view = buildAnimationProgressView(animating(["a", "b"], started("a")))!;
    expect(view.mode).toBe("running");
    expect([view.showSkip, view.skipDisabled, view.showRetry]).toEqual([true, false, false]);
    expect(view.skipLabel).toBe("Skip animations");
    expect(view.notice).toBeNull();
    expect(view.noticeLead).toBeNull();
  });

  it("running stays the mode while jobs remain, even after one failed", () => {
    const view = buildAnimationProgressView(animating(["a", "b"], started("a"), failed("a", "NETWORK")))!;
    expect(view.mode).toBe("running");
    expect(view.showRetry).toBe(false);
  });

  it("waiting: both controls and a notice that counts the jobs that are not ready", () => {
    const state = animating(["a", "b", "c"], started("a"), ready("a"), started("b"), failed("b", "NETWORK"), {
      type: "animation_jobs_skipped",
      jobIds: ["c"],
    });
    expect(state.status).toBe("waiting");
    const view = buildAnimationProgressView(state)!;
    expect(view.mode).toBe("waiting");
    expect([view.showSkip, view.skipDisabled, view.showRetry]).toEqual([true, false, true]);
    expect(view.skipLabel).toBe("Skip and continue");
    expect(view.noticeLead).toBe("Waiting for your choice");
    expect(view.notice).toBe(
      "2 of 3 animations are not ready. Try again, or skip and open the story with the standard drawings for them."
    );
  });

  it("waiting with one job left uses the singular", () => {
    const view = buildAnimationProgressView(animating(["a", "b"], started("a"), ready("a"), started("b"), failed("b", "NETWORK")))!;
    expect(view.notice).toBe(
      "1 of 2 animations is not ready. Try again, or skip and open the story with the standard drawing for it."
    );
  });

  it("waiting after a stop code: the first job failed, the rest skipped, and the player is asked", () => {
    const state = animating(
      ["a", "b", "c"],
      started("a"),
      failed("a", "ANIMATION_NOT_CONFIGURED"),
      { type: "animation_jobs_skipped", jobIds: ["b", "c"] }
    );
    const view = buildAnimationProgressView(state)!;
    expect(state.stage).toBe("animating");
    expect(view.mode).toBe("waiting");
    expect(view.rows.map((row) => row.detail)).toEqual([
      BUILD_MESSAGES.animationNotConfigured,
      "Skipped",
      "Skipped",
    ]);
    expect(view.showRetry).toBe(true);
    expect(view.showSkip).toBe(true);
    expect(view.settled).toBe(3);
  });

  it("skipping: the skip control stays but is disabled, retry is gone", () => {
    const state = animating(["a", "b"], started("a"), { type: "animation_skip_requested" });
    const view = buildAnimationProgressView(state)!;
    expect(view.mode).toBe("skipping");
    expect([view.showSkip, view.skipDisabled, view.showRetry]).toEqual([true, true, false]);
    expect(view.skipLabel).toBe("Skipping…");
  });

  it("skipping wins over waiting when the player skipped a held stage", () => {
    const held = animating(["a"], started("a"), failed("a", "NETWORK"), { type: "animation_skip_requested" });
    expect(buildAnimationProgressView(held)!.mode).toBe("skipping");
  });

  it("closed: after the stage ended there are no controls and no notice", () => {
    const state = animating(["a"], started("a"), ready("a"), { type: "animating_finished" });
    expect(state.stage).toBe("done");
    const view = buildAnimationProgressView(state)!;
    expect(view.mode).toBe("closed");
    expect([view.showSkip, view.skipDisabled, view.showRetry]).toEqual([false, false, false]);
    expect(view.notice).toBeNull();
    expect(view.rows).toHaveLength(1);
  });

  it("retry returns the view to running with the unfinished jobs pending again", () => {
    const held = animating(["a", "b"], started("a"), ready("a"), started("b"), failed("b", "NETWORK"));
    const retried = generationReducer(held, { type: "animation_retry" });
    const view = buildAnimationProgressView(retried)!;
    expect(view.mode).toBe("running");
    expect(view.rows.map((row) => row.status)).toEqual(["ready", "pending"]);
    expect(view.settled).toBe(1);
  });
});

describe("messageForCode: ANIMATION_ATTACH_FAILED", () => {
  it("has its own plain message, within 160 characters, that is not the generic one", () => {
    const message = messageForCode("ANIMATION_ATTACH_FAILED");
    expect(message).toBe(BUILD_MESSAGES.animationAttachFailed);
    expect(message.length).toBeGreaterThan(0);
    expect(message.length).toBeLessThanOrEqual(160);
    expect(message).not.toBe(BUILD_MESSAGES.unexpected);
  });

  it("is what a row shows for a reference that could not be attached", () => {
    expect(animationJobDetail(job("a", { status: "failed", code: "ANIMATION_ATTACH_FAILED" }))).toBe(
      BUILD_MESSAGES.animationAttachFailed
    );
  });
});
