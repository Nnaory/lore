/**
 * useGeneration — runs the staged generation (see generation.ts)
 *
 * Generation starts only from `start(input)` (a click), never from an
 * effect: React's dev-mode double effects would otherwise send every paid
 * AI request twice. Results that arrive after `cancel()` or unmount are
 * ignored.
 *
 * Animating (design 7.5, Requirement 24). When the animation build flag is on and the written
 * stories hold targets, the hook adds a stage between `writing` and `done`. `animateLoop` sends
 * one `createAnimation` request per target, one at a time, never more than four starts in 60 s.
 * A target that cannot be animated becomes a `failed` or `skipped` job; the story stays playable
 * without that animation, and `state.status` never turns `failed`. When jobs are left over, the
 * hook holds `onDone` and waits for the player: `retryAnimation()` runs the `failed` and `skipped`
 * jobs again, `skipAnimation()` gives up on them. Only then are the finished animations attached
 * to the stories (`attachAnimation`) and `onDone` called, once. With the flag off, or without
 * targets, the path is the one that existed before the stage: `all_stories_ready`, then `onDone`.
 *
 * The loop keeps its own copy of the job statuses (`AnimationRun.jobs`). The reducer state is
 * only updated by React between renders, so control flow cannot read it right after a dispatch.
 */

"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import { createAnimation } from "@/lib/animation/animation-client";
import { readAnimationsFlag } from "@/lib/animation/flags";
import { attachAnimation, buildAnimationRequest } from "@/lib/animation/targets";
import type { CampaignBlueprint } from "@/lib/types/campaign";
import type { MaterialBlueprint } from "@/lib/types/material";
import type { StoryBlueprint } from "@/lib/types/story";
import type { PreviousStorySummary } from "@/lib/types/game";
import type { AnimationReference } from "@/lib/types/animation";
import {
  api,
  generationReducer,
  initialGenerationState,
  selectConcepts,
  type AnimationJob,
  type GenerationInput,
} from "./generation";
import {
  ANIMATION_CLIENT_TIMEOUT_MS,
  ANIMATION_START_WINDOW_MS,
  buildAnimationJobs,
  nextStartDelay,
  stopsAnimationStage,
  toAnimationLanguage,
} from "./animating";

export type GenerationResult = {
  material: MaterialBlueprint;
  campaign: CampaignBlueprint;
  stories: ReadonlyMap<string, StoryBlueprint>;
};

/** Code of a job whose request could not be built (Requirement 24.2, design 7.5 step 2). */
const REQUEST_INVALID = "REQUEST_INVALID";

/** Code of a `ready` job whose reference `attachAnimation` refused (Requirement 24.17). */
const ATTACH_FAILED = "ANIMATION_ATTACH_FAILED";

/**
 * What the animating stage needs besides the reducer state. One object per generation run; the
 * loop and the player's controls (`retryAnimation`, `skipAnimation`) share it through a ref.
 */
type AnimationRun = {
  /** Aborts on `cancel()`, unmount and a new run. Replaced by `retryAnimation()`. */
  signal: AbortSignal;
  material: MaterialBlueprint;
  campaign: CampaignBlueprint;
  /** The stories as written, before any animation is attached. */
  stories: ReadonlyMap<string, StoryBlueprint>;
  language: "en" | "id";
  /** The loop's own copy of the job statuses, kept in step with the dispatched actions. */
  jobs: AnimationJob[];
  /** The player chose to skip the rest. Cleared by a retry. */
  skipRequested: boolean;
  /** The wait or request in flight; the skip control aborts it. */
  step: AbortController | null;
  /** True while `animateLoop` is working, false while it waits for the player. */
  looping: boolean;
  /** True once the stories were attached and `onDone` was called. */
  finished: boolean;
};

/** What `runJob` tells the loop to do next. */
type JobOutcome = "next" | "stop" | "cancelled";

const isActive = (job: AnimationJob) => job.status === "pending" || job.status === "running";
const needsDecision = (job: AnimationJob) => job.status === "failed" || job.status === "skipped";

/** Resolves `true` after `ms`, or `false` at once when `signal` aborts first. */
function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function useGeneration(options: {
  onDone: (result: GenerationResult) => void;
  fetchImpl?: typeof fetch;
}) {
  const [state, dispatch] = useReducer(generationReducer, initialGenerationState);
  const inputRef = useRef<GenerationInput | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const stateRef = useRef(state);
  const optionsRef = useRef(options);
  /** The animating stage of the current run; `null` before it starts. */
  const animationRef = useRef<AnimationRun | null>(null);
  /** When the animation requests started (ms), for the 60 s window. Outlives a run on purpose:
   *  the backend counts per client, not per run. */
  const startsRef = useRef<number[]>([]);
  /** Guards the animating path: `onDone` runs once per run (Requirement 24.8). */
  const doneRef = useRef(false);
  useEffect(() => {
    stateRef.current = state;
    optionsRef.current = options;
  });
  useEffect(() => () => controllerRef.current?.abort(), []);

  /** A fresh signal for a run; aborts any run still in flight. */
  const newRun = () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    return { signal: controller.signal, fetchImpl: optionsRef.current.fetchImpl };
  };

  const analyze = useCallback(async () => {
    const input = inputRef.current;
    if (!input) return;
    const run = newRun();
    dispatch({ type: "stage_started", stage: "analyzing" });
    const result = await api.analyze(input, run);
    if (run.signal.aborted) return;
    if (!result.ok) dispatch({ type: "failed", message: result.message });
    else dispatch({ type: "material_ready", material: result.value });
  }, []);

  // -------------------------------------------------------------------------
  // Animating stage
  // -------------------------------------------------------------------------

  /** A `running` job (and only a running one, like the reducer) becomes `ready`. */
  const markReady = useCallback((job: AnimationJob, reference: AnimationReference) => {
    if (job.status !== "running") return;
    job.status = "ready";
    job.reference = reference;
    delete job.code;
    dispatch({ type: "animation_job_ready", jobId: job.id, reference });
  }, []);

  /** A `running` job becomes `failed` with `code`. */
  const markFailed = useCallback((job: AnimationJob, code: string) => {
    if (job.status !== "running") return;
    job.status = "failed";
    job.code = code;
    delete job.reference;
    dispatch({ type: "animation_job_failed", jobId: job.id, code });
  }, []);

  /** Every `pending` or `running` job becomes `skipped`. Nothing is dispatched when none is. */
  const skipActiveJobs = useCallback((anim: AnimationRun) => {
    const ids = anim.jobs.filter(isActive).map((job) => job.id);
    if (ids.length === 0) return;
    for (const job of anim.jobs) if (isActive(job)) job.status = "skipped";
    dispatch({ type: "animation_jobs_skipped", jobIds: ids });
  }, []);

  /**
   * Attaches every `ready` animation, then ends the stage and calls `onDone` once (Requirement
   * 24.8, 24.17). A reference that `attachAnimation` refuses turns its job `failed` and leaves
   * that story as it was.
   */
  const finalize = useCallback((anim: AnimationRun) => {
    if (anim.finished || anim.signal.aborted) return;
    anim.finished = true;
    const stories = new Map(anim.stories);
    for (const job of anim.jobs) {
      if (job.status !== "ready" || job.reference === undefined) continue;
      const story = stories.get(job.storyId);
      const attached = story ? attachAnimation(story, job.target, job.reference) : { ok: false as const };
      if (attached.ok) {
        stories.set(job.storyId, attached.story);
      } else {
        job.status = "failed";
        job.code = ATTACH_FAILED;
        delete job.reference;
        dispatch({ type: "animation_job_failed", jobId: job.id, code: ATTACH_FAILED });
      }
    }
    dispatch({ type: "animating_finished" });
    if (doneRef.current) return;
    doneRef.current = true;
    optionsRef.current.onDone({ material: anim.material, campaign: anim.campaign, stories });
  }, []);

  /**
   * After the last job: end the stage when every job is `ready` or the player chose to skip;
   * otherwise stop and wait for `retryAnimation()` or `skipAnimation()` (Requirement 24.13).
   */
  const conclude = useCallback(
    (anim: AnimationRun) => {
      if (anim.signal.aborted || anim.jobs.some(isActive)) return;
      if (anim.jobs.some(needsDecision) && !anim.skipRequested) return;
      finalize(anim);
    },
    [finalize]
  );

  /** One target: wait for the window, send the request, record the result. */
  const runJob = useCallback(
    async (anim: AnimationRun, job: AnimationJob): Promise<JobOutcome> => {
      const story = anim.stories.get(job.storyId);
      const built = story
        ? buildAnimationRequest(job.target, story, anim.material, anim.language)
        : ({ ok: false } as const);
      if (!built.ok) {
        // Nothing is sent, so there is nothing to wait for. `running` first: the reducer only
        // fails a running job.
        job.status = "running";
        dispatch({ type: "animation_job_started", jobId: job.id });
        markFailed(job, REQUEST_INVALID);
        return "next";
      }

      // One controller covers the wait and the request. Skip, cancel and the timer abort it.
      const step = new AbortController();
      anim.step = step;
      const relay = () => step.abort();
      anim.signal.addEventListener("abort", relay, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (anim.signal.aborted) return "cancelled";

        // The job stays `pending` while it waits for the 60 s window. The delay is read again
        // after each wait, so a timer that fires a little early never starts a request too soon.
        for (let delay = nextStartDelay(startsRef.current, Date.now()); delay > 0; ) {
          if (!(await pause(delay, step.signal))) {
            // Aborted while waiting: cancel and unmount end the run; skip has already skipped the jobs.
            return anim.signal.aborted ? "cancelled" : "stop";
          }
          delay = nextStartDelay(startsRef.current, Date.now());
        }

        const startedAt = Date.now();
        startsRef.current = startsRef.current.filter((t) => startedAt - t < ANIMATION_START_WINDOW_MS);
        startsRef.current.push(startedAt);
        job.status = "running";
        job.stage = null;
        job.attempt = 0;
        dispatch({ type: "animation_job_started", jobId: job.id });

        let timedOut = false;
        timer = setTimeout(() => {
          timedOut = true;
          step.abort();
        }, ANIMATION_CLIENT_TIMEOUT_MS);

        const result = await createAnimation(built.request, {
          signal: step.signal,
          fetchImpl: optionsRef.current.fetchImpl,
          onEvent: (event) => {
            if (event.event !== "stage" || step.signal.aborted) return;
            dispatch({
              type: "animation_job_progress",
              jobId: job.id,
              stage: event.data.stage,
              attempt: event.data.attempt,
            });
          },
        });
        if (anim.signal.aborted) return "cancelled"; // cancel or unmount: ignore the late result

        if (result.ok) {
          markReady(job, result.animation);
          return "next";
        }
        if (result.code === "ABORTED") {
          if (timedOut) {
            // The `ABORTED` that follows our own abort is not a second event (Requirement 24.14).
            markFailed(job, "ANIMATION_TIMEOUT");
            return "next";
          }
          if (anim.skipRequested) {
            skipActiveJobs(anim);
            return "stop";
          }
        }
        markFailed(job, result.code);
        if (stopsAnimationStage(result.code)) {
          skipActiveJobs(anim);
          return "stop";
        }
        return "next";
      } finally {
        clearTimeout(timer);
        anim.signal.removeEventListener("abort", relay);
        anim.step = null;
      }
    },
    [markFailed, markReady, skipActiveJobs]
  );

  /** Processes the `pending` jobs one at a time, then decides how the stage ends. */
  const animateLoop = useCallback(
    async (anim: AnimationRun) => {
      anim.looping = true;
      try {
        for (;;) {
          if (anim.signal.aborted) return;
          const job = anim.jobs.find((candidate) => candidate.status === "pending");
          if (job === undefined) break;
          const outcome = await runJob(anim, job);
          if (outcome === "cancelled") return;
          if (outcome === "stop") break;
        }
        conclude(anim);
      } finally {
        anim.looping = false;
      }
    },
    [conclude, runJob]
  );

  /** Run again only the `failed` and `skipped` jobs; the `ready` ones stay (Requirement 24.7). */
  const retryAnimation = useCallback(() => {
    const anim = animationRef.current;
    if (!anim || anim.finished || anim.looping || anim.signal.aborted) return;
    if (!anim.jobs.some(needsDecision)) return;
    anim.signal = newRun().signal;
    anim.skipRequested = false;
    for (const job of anim.jobs) {
      if (!needsDecision(job)) continue;
      job.status = "pending";
      job.stage = null;
      job.attempt = 0;
      delete job.code;
    }
    dispatch({ type: "animation_retry" });
    void animateLoop(anim);
  }, [animateLoop]);

  /**
   * Give up on what is not done (Requirement 24.6). The order matters: the reducer learns of the
   * skip first, then the request in flight is aborted (its `ABORTED` result must find the skip
   * already recorded), then every unfinished job is marked `skipped`. A loop that is running ends
   * the stage itself; one that waits for the player is concluded here.
   */
  const skipAnimation = useCallback(() => {
    const anim = animationRef.current;
    if (!anim || anim.finished || anim.skipRequested || anim.signal.aborted) return;
    anim.skipRequested = true;
    dispatch({ type: "animation_skip_requested" });
    anim.step?.abort();
    skipActiveJobs(anim);
    if (!anim.looping) conclude(anim);
  }, [conclude, skipActiveJobs]);

  /** Plan (if not yet planned) and write every story not yet written. */
  const write = useCallback(async () => {
    const input = inputRef.current;
    const current = stateRef.current;
    if (!input || !current.material) return;
    const material = selectConcepts(current.material, current.selectedConceptIds);
    const run = newRun();

    let campaign = current.campaign;
    if (!campaign) {
      dispatch({ type: "stage_started", stage: "planning" });
      const planned = await api.plan(input, material, run);
      if (run.signal.aborted) return;
      if (!planned.ok) {
        dispatch({ type: "failed", message: planned.message });
        return;
      }
      campaign = planned.value;
      dispatch({ type: "campaign_ready", campaign });
    }

    dispatch({ type: "stage_started", stage: "writing" });
    const stories = new Map(Object.entries(current.stories));
    const summaries: PreviousStorySummary[] = [];
    for (const entry of campaign.story_sequence) {
      let story = stories.get(entry.story_id);
      if (!story) {
        const written = await api.story(input, campaign, entry.story_id, material, summaries, run);
        if (run.signal.aborted) return;
        if (!written.ok) {
          dispatch({ type: "failed", message: written.message });
          return;
        }
        story = written.value;
        stories.set(entry.story_id, story);
        dispatch({ type: "story_ready", story });
      }
      const cs = story.continuity_summary;
      if (cs) {
        summaries.push({
          story_id: entry.story_id,
          title: entry.title,
          outcome_description: cs.outcome_description,
          world_state_snapshot: cs.world_state_snapshot,
          relationship_snapshot: cs.relationship_snapshot,
        });
      }
    }

    // Flag off (or nothing to animate): the path that existed before the animating stage.
    const jobs = readAnimationsFlag()
      ? buildAnimationJobs(
          campaign.story_sequence.flatMap((entry) => {
            const story = stories.get(entry.story_id);
            return story ? [{ storyId: entry.story_id, story }] : [];
          })
        )
      : [];
    if (jobs.length === 0) {
      dispatch({ type: "all_stories_ready" });
      optionsRef.current.onDone({ material, campaign, stories });
      return;
    }

    const anim: AnimationRun = {
      signal: run.signal,
      material,
      campaign,
      stories,
      language: toAnimationLanguage(input.storyOptions?.language),
      jobs: jobs.map((job) => ({ ...job })),
      skipRequested: false,
      step: null,
      looping: false,
      finished: false,
    };
    animationRef.current = anim;
    dispatch({ type: "animating_started", jobs });
    await animateLoop(anim);
  }, [animateLoop]);

  const start = useCallback(
    (input: GenerationInput) => {
      inputRef.current = input;
      stateRef.current = initialGenerationState; // a new run never reuses old results
      animationRef.current = null;
      doneRef.current = false;
      dispatch({ type: "reset" });
      void analyze();
    },
    [analyze]
  );

  /** Re-run the stage that failed, keeping everything finished before it. */
  const retry = useCallback(() => {
    if (stateRef.current.stage === "analyzing") void analyze();
    else void write();
  }, [analyze, write]);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  /** Abort any run and forget all results. */
  const reset = useCallback(() => {
    controllerRef.current?.abort();
    inputRef.current = null;
    stateRef.current = initialGenerationState;
    animationRef.current = null;
    doneRef.current = false;
    dispatch({ type: "reset" });
  }, []);

  return {
    state,
    start,
    retry,
    cancel,
    reset,
    /** Run the `failed` and `skipped` animations again (the player's "try again"). */
    retryAnimation,
    /** Stop animating and finish with what is ready (the player's "skip"). */
    skipAnimation,
    /** Confirm the reviewed concepts and write the story. */
    confirmConcepts: useCallback(() => void write(), [write]),
    toggleConcept: useCallback((conceptId: string) => dispatch({ type: "concept_toggled", conceptId }), []),
  };
}
