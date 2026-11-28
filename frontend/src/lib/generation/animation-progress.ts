/**
 * animation-progress.ts: what the generation screen shows for the `animating` stage (pure).
 *
 * Why: `AnimationProgress` (components/animation) only draws. Which controls exist, what each
 * row says and how many jobs are settled are decisions about the generation state, so they live
 * here where a test can check them without a component (design 7.5 UI, Requirement 24.4, 24.6,
 * 24.7, 24.13).
 *
 * The four modes follow the reducer state, they do not add rules of their own:
 * - `running`: a job is pending or running. The player may skip.
 * - `waiting`: every job is settled, some are `failed` or `skipped`, and the player has not yet
 *   chosen. The flow holds `onDone` (Requirement 24.13), so the screen must say so and offer
 *   both choices. This is also where a stop code lands (`ANIMATION_NOT_CONFIGURED`, quota, rate
 *   limit): the first job is `failed`, the rest `skipped`, and nothing happens until the player
 *   decides (Requirement 36.6 against 24.13: the hold wins).
 * - `skipping`: the player asked to skip and the flow is winding down (the request in flight is
 *   being aborted). The skip control stays but is disabled; nothing else can be done.
 * - `closed`: the stage is over (`done`). The rows stay as a record, with no controls.
 *
 * `failed` jobs show `messageForCode(job.code)`; the other statuses show a short fixed word. A
 * `running` job shows the backend stage and the attempt number.
 */

import { messageForCode } from "@/lib/contracts/error-messages";
import type {
  AnimationJob,
  AnimationJobStage,
  AnimationJobStatus,
  GenerationState,
} from "./generation";

export type AnimationProgressMode = "running" | "waiting" | "skipping" | "closed";

/** The look of a row's status square. Same names as `StepMarker` takes, so a row can pass it on. */
export type AnimationRowMarker = "done" | "active" | "failed" | "pending" | "skipped";

/** One row of the job list. */
export type AnimationRowView = {
  id: string;
  title: string;
  status: AnimationJobStatus;
  marker: AnimationRowMarker;
  detail: string;
};

export type AnimationProgressView = {
  mode: AnimationProgressMode;
  /** Jobs in the list. */
  total: number;
  /** Jobs that are `ready`, `failed` or `skipped`: the `k` of `k / n`. */
  settled: number;
  /** Jobs that are `failed` or `skipped`: what the player decides about. */
  unfinished: number;
  /** The skip control exists (while running or waiting, and while skipping, disabled). */
  showSkip: boolean;
  /** The skip control cannot be used (the skip is already under way). */
  skipDisabled: boolean;
  /** The retry control exists and can be used (only while waiting). */
  showRetry: boolean;
  /** Text of the skip control for the mode. */
  skipLabel: string;
  /** Short heading of the held state; `null` in the other modes. */
  noticeLead: string | null;
  /** What the player can choose while the flow waits; `null` in the other modes. */
  notice: string | null;
  rows: AnimationRowView[];
};

const STAGE_LABEL: Record<AnimationJobStage, string> = {
  generating: "Writing",
  verifying: "Checking",
  repairing: "Fixing",
  publishing: "Saving",
};

const MARKER: Record<AnimationJobStatus, AnimationRowMarker> = {
  pending: "pending",
  running: "active",
  ready: "done",
  failed: "failed",
  skipped: "skipped",
};

/** The second line of a row. */
export function animationJobDetail(job: AnimationJob): string {
  switch (job.status) {
    case "pending":
      return "Waiting";
    case "running": {
      const label = job.stage === null ? "Starting" : STAGE_LABEL[job.stage];
      return job.attempt > 0 ? `${label} · attempt ${job.attempt}` : label;
    }
    case "ready":
      return "Ready";
    case "skipped":
      return "Skipped";
    case "failed":
      return messageForCode(job.code ?? "UNKNOWN");
  }
}

function modeOf(state: Pick<GenerationState, "stage" | "status" | "animation">): AnimationProgressMode {
  if (state.stage !== "animating" || state.animation === null) return "closed";
  if (state.animation.skipRequested) return "skipping";
  return state.status === "waiting" ? "waiting" : "running";
}

/** The held-state text: how many jobs are not ready and what each choice does. */
function noticeFor(unfinished: number, total: number): string {
  const one = unfinished === 1;
  return (
    `${unfinished} of ${total} animations ${one ? "is" : "are"} not ready. ` +
    `Try again, or skip and open the story with the standard drawing${one ? "" : "s"} for ${one ? "it" : "them"}.`
  );
}

/**
 * The view of the animating stage, or `null` when this run has none (the flag was off, or the
 * stage has not started): the screen then shows exactly what it showed before the stage existed.
 */
export function buildAnimationProgressView(
  state: Pick<GenerationState, "stage" | "status" | "animation">
): AnimationProgressView | null {
  const phase = state.animation;
  if (phase === null) return null;
  const mode = modeOf(state);
  const total = phase.jobs.length;
  const unfinished = phase.jobs.filter((job) => job.status === "failed" || job.status === "skipped").length;
  const settled = phase.jobs.filter((job) => job.status === "ready").length + unfinished;
  const waiting = mode === "waiting";
  return {
    mode,
    total,
    settled,
    unfinished,
    showSkip: mode !== "closed",
    skipDisabled: mode === "skipping",
    showRetry: waiting,
    skipLabel: mode === "skipping" ? "Skipping…" : waiting ? "Skip and continue" : "Skip animations",
    noticeLead: waiting ? "Waiting for your choice" : null,
    notice: waiting ? noticeFor(unfinished, total) : null,
    rows: phase.jobs.map((job) => ({
      id: job.id,
      title: job.title,
      status: job.status,
      marker: MARKER[job.status],
      detail: animationJobDetail(job),
    })),
  };
}
