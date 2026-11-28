/**
 * Staged campaign generation — client side
 *
 * Calls the three AI endpoints one at a time so the player sees real
 * progress, reviews the extracted concepts before any story is written,
 * and can retry a failed stage without redoing earlier ones:
 *
 *   analyzing  → POST /api/v1/ai/analyze-material   (Layer 1)
 *   reviewing  → player keeps/removes concepts      (no request)
 *   planning   → POST /api/v1/ai/plan-campaign      (Layer 2)
 *   writing    → POST /api/v1/ai/generate-story     (Layer 3, once per story)
 *   animating  → POST /api/v1/ai/animations         (one request per animation target; only
 *                                                    when the animation flag is on, design 7.5)
 *   done
 *
 * The endpoints are served by the FastAPI backend (see ai-endpoints.ts).
 *
 * Pure reducer + small async API helpers; the React hook lives in
 * use-generation.ts.
 *
 * The `animating` stage never fails the run. A target that cannot be animated becomes a job with
 * status `failed` or `skipped`, and the story stays playable without that animation (Requirement
 * 24.16). So the `animation_*` actions never set `status: "failed"`; the status is derived from
 * the jobs: `running` while a job is `pending` or `running`, `waiting` when only `failed` or
 * `skipped` jobs are left and the player has not asked to skip (the flow then holds `onDone` and
 * offers retry or skip). An action whose precondition is not met returns the same state object,
 * so a late result (for example `ABORTED` after the 270000 ms timeout) cannot change anything.
 */

import { z } from "zod";
import { MaterialBlueprintSchema } from "@/lib/contracts/schemas/material.schema";
import { CampaignBlueprintSchema } from "@/lib/contracts/schemas/campaign.schema";
import { StoryBlueprintSchema } from "@/lib/contracts/schemas/story.schema";
import type { GenerationRequest } from "@/lib/contracts/generation-request";
import type { MaterialBlueprint } from "@/lib/types/material";
import type { CampaignBlueprint } from "@/lib/types/campaign";
import type { StoryBlueprint } from "@/lib/types/story";
import type { PreviousStorySummary } from "@/lib/types/game";
import type { AnimationReference, AnimationTarget } from "@/lib/types/animation";
import { BUILD_MESSAGES, messageForCode } from "@/lib/contracts/error-messages";
import { aiUrl } from "./ai-endpoints";

export type GenerationStage = "analyzing" | "reviewing" | "planning" | "writing" | "animating" | "done";

/** Where one animation target stands (Requirement 24.4). */
export type AnimationJobStatus = "pending" | "running" | "ready" | "failed" | "skipped";

/** The stage label of a running job, from the backend `stage` event. */
export type AnimationJobStage = "generating" | "verifying" | "repairing" | "publishing";

/** One target to animate. `ready` keeps the reference until it is attached to the story. */
export type AnimationJob = {
  /** `${storyId}:${targetKey}`; unique inside one run. */
  id: string;
  storyId: string;
  target: AnimationTarget;
  /** Shown on the generation screen. */
  title: string;
  status: AnimationJobStatus;
  /** Latest `stage` event of the running request; `null` before the first one. */
  stage: AnimationJobStage | null;
  /** Latest attempt number from the `stage` event; 0 before the first one. */
  attempt: number;
  /** Set while `ready`. */
  reference?: AnimationReference;
  /** Set while `failed`: the error code (for `messageForCode`). */
  code?: string;
};

/** The animating stage: its jobs and whether the player asked to skip the rest. */
export type AnimationPhase = { jobs: AnimationJob[]; skipRequested: boolean };

export type GenerationState = {
  stage: GenerationStage;
  /** running: a request is in flight; waiting: the player must act; failed: see `error`. */
  status: "running" | "waiting" | "failed";
  error: string | null;
  material: MaterialBlueprint | null;
  selectedConceptIds: string[];
  campaign: CampaignBlueprint | null;
  stories: Record<string, StoryBlueprint>;
  /** `null` until the animating stage starts (and always `null` when the animation flag is off). */
  animation: AnimationPhase | null;
};

export const initialGenerationState: GenerationState = {
  stage: "analyzing",
  status: "running",
  error: null,
  material: null,
  selectedConceptIds: [],
  campaign: null,
  stories: {},
  animation: null,
};

export type GenerationAction =
  | { type: "reset" }
  | { type: "stage_started"; stage: Exclude<GenerationStage, "reviewing" | "animating" | "done"> }
  | { type: "material_ready"; material: MaterialBlueprint }
  | { type: "concept_toggled"; conceptId: string }
  | { type: "campaign_ready"; campaign: CampaignBlueprint }
  | { type: "story_ready"; story: StoryBlueprint }
  | { type: "all_stories_ready" }
  | { type: "failed"; message: string }
  | { type: "animating_started"; jobs: AnimationJob[] }
  | { type: "animation_job_started"; jobId: string }
  | { type: "animation_job_progress"; jobId: string; stage: AnimationJobStage | null; attempt: number }
  | { type: "animation_job_ready"; jobId: string; reference: AnimationReference }
  | { type: "animation_job_failed"; jobId: string; code: string }
  | { type: "animation_jobs_skipped"; jobIds: string[] }
  | { type: "animation_skip_requested" }
  | { type: "animation_retry" }
  | { type: "animating_finished" };

// ---------------------------------------------------------------------------
// Animating stage helpers (private to the reducer)
// ---------------------------------------------------------------------------

/** A job that still has work to do: the stage cannot end while one exists. */
const isActive = (job: AnimationJob) => job.status === "pending" || job.status === "running";

/** A job the player has to decide about (retry or skip). */
const needsDecision = (job: AnimationJob) => job.status === "failed" || job.status === "skipped";

/** `running` while work remains or the player already chose to skip; `waiting` for a decision. */
function deriveStatus(phase: AnimationPhase): GenerationState["status"] {
  if (phase.jobs.some(isActive)) return "running";
  return phase.jobs.some(needsDecision) && !phase.skipRequested ? "waiting" : "running";
}

/** The state with a new phase and the status that follows from it. */
function withPhase(state: GenerationState, phase: AnimationPhase): GenerationState {
  return { ...state, animation: phase, status: deriveStatus(phase) };
}

/**
 * Applies `patch` to the first job with `jobId` when its status is one of `allowed`. Any other
 * case (wrong stage, no phase, unknown id, status not allowed) returns `state` itself.
 */
function patchJob(
  state: GenerationState,
  jobId: string,
  allowed: readonly AnimationJobStatus[],
  patch: (job: AnimationJob) => AnimationJob
): GenerationState {
  const phase = state.animation;
  if (state.stage !== "animating" || phase === null) return state;
  const index = phase.jobs.findIndex((job) => job.id === jobId);
  if (index < 0 || !allowed.includes(phase.jobs[index].status)) return state;
  const jobs = phase.jobs.map((job, i) => (i === index ? patch(job) : job));
  return withPhase(state, { ...phase, jobs });
}

/** A job back at the start: no stage, no attempt, no error code, no reference. */
function pendingJob(job: AnimationJob): AnimationJob {
  const next: AnimationJob = { ...job, status: "pending", stage: null, attempt: 0 };
  delete next.code;
  delete next.reference;
  return next;
}

/** A failed job. A `ready` job that failed to attach loses its reference: it is not in the story. */
function failedJob(job: AnimationJob, code: string): AnimationJob {
  const next: AnimationJob = { ...job, status: "failed", code };
  delete next.reference;
  return next;
}

export function generationReducer(state: GenerationState, action: GenerationAction): GenerationState {
  switch (action.type) {
    case "reset":
      return initialGenerationState;
    case "stage_started":
      // Starting an earlier stage makes any animating phase from a previous attempt obsolete.
      return { ...state, stage: action.stage, status: "running", error: null, animation: null };
    case "material_ready":
      return {
        ...state,
        material: action.material,
        selectedConceptIds: action.material.concepts.map((c) => c.concept_id),
        stage: "reviewing",
        status: "waiting",
      };
    case "concept_toggled": {
      if (state.stage !== "reviewing") return state;
      const has = state.selectedConceptIds.includes(action.conceptId);
      return {
        ...state,
        selectedConceptIds: has
          ? state.selectedConceptIds.filter((id) => id !== action.conceptId)
          : [...state.selectedConceptIds, action.conceptId],
      };
    }
    case "campaign_ready":
      return { ...state, campaign: action.campaign };
    case "story_ready":
      return { ...state, stories: { ...state.stories, [action.story.story_id]: action.story } };
    case "all_stories_ready":
      // While animating, a job that is still pending or running keeps the stage open.
      if (state.stage === "animating" && state.animation?.jobs.some(isActive)) return state;
      return { ...state, stage: "done", status: "waiting" };
    case "failed":
      return { ...state, status: "failed", error: action.message };

    case "animating_started":
      if (state.stage !== "writing") return state;
      return {
        ...state,
        stage: "animating",
        status: "running",
        error: null,
        animation: { jobs: action.jobs.map((job) => ({ ...job })), skipRequested: false },
      };
    case "animation_job_started":
      return patchJob(state, action.jobId, ["pending"], (job) => ({
        ...job,
        status: "running",
        stage: null,
        attempt: 0,
      }));
    case "animation_job_progress":
      return patchJob(state, action.jobId, ["running"], (job) => ({
        ...job,
        stage: action.stage,
        attempt: action.attempt,
      }));
    case "animation_job_ready":
      return patchJob(state, action.jobId, ["running"], (job) => {
        const next: AnimationJob = { ...job, status: "ready", reference: action.reference };
        delete next.code;
        return next;
      });
    case "animation_job_failed":
      // `ready` is allowed on purpose: a reference that `attachAnimation` refuses turns its job
      // `failed` (Requirement 24.17). A job that is already `failed` or `skipped` stays as it is,
      // which is how the `ABORTED` that follows a timeout changes nothing (Requirement 24.14).
      return patchJob(state, action.jobId, ["running", "ready"], (job) => failedJob(job, action.code));
    case "animation_jobs_skipped": {
      const phase = state.animation;
      if (state.stage !== "animating" || phase === null) return state;
      const ids = new Set(action.jobIds);
      if (!phase.jobs.some((job) => ids.has(job.id) && isActive(job))) return state;
      const jobs = phase.jobs.map((job) =>
        ids.has(job.id) && isActive(job) ? { ...job, status: "skipped" as const } : job
      );
      return withPhase(state, { ...phase, jobs });
    }
    case "animation_skip_requested": {
      const phase = state.animation;
      if (state.stage !== "animating" || phase === null || phase.skipRequested) return state;
      return withPhase(state, { ...phase, skipRequested: true });
    }
    case "animation_retry": {
      const phase = state.animation;
      if (state.stage !== "animating" || phase === null || !phase.jobs.some(needsDecision)) return state;
      const jobs = phase.jobs.map((job) => (needsDecision(job) ? pendingJob(job) : job));
      return withPhase(state, { jobs, skipRequested: false });
    }
    case "animating_finished":
      if (state.stage !== "animating" || state.animation?.jobs.some(isActive)) return state;
      return { ...state, stage: "done", status: "waiting" };
  }
}

/**
 * The material with only the selected concepts. Prerequisites pointing at a
 * removed concept are dropped so the planner never sees a dangling reference.
 */
export function selectConcepts(material: MaterialBlueprint, conceptIds: readonly string[]): MaterialBlueprint {
  const keep = new Set(conceptIds);
  return {
    ...material,
    concepts: material.concepts
      .filter((c) => keep.has(c.concept_id))
      .map((c) => ({ ...c, prerequisites: c.prerequisites.filter((p) => keep.has(p)) })),
  };
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

export type ApiResult<T> = { ok: true; value: T } | { ok: false; message: string };

const ErrorEnvelope = z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) });
const SuccessEnvelope = z.object({ ok: z.literal(true), data: z.object({ blueprint: z.unknown() }) });

/** POST JSON to an AI route and validate `data.blueprint` with `schema`. */
export async function postBlueprint<T>(
  url: string,
  body: unknown,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}
): Promise<ApiResult<T>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch {
    return { ok: false, message: BUILD_MESSAGES.network };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { ok: false, message: BUILD_MESSAGES.unexpected };
  }

  const failure = ErrorEnvelope.safeParse(json);
  if (failure.success) return { ok: false, message: messageForCode(failure.data.error.code) };

  const envelope = SuccessEnvelope.safeParse(json);
  const blueprint = envelope.success ? schema.safeParse(envelope.data.data.blueprint) : null;
  if (!response.ok || !blueprint?.success) return { ok: false, message: BUILD_MESSAGES.unexpected };
  return { ok: true, value: blueprint.data };
}

export type GenerationInput = GenerationRequest;

export const api = {
  analyze: (input: GenerationInput, o?: { signal?: AbortSignal; fetchImpl?: typeof fetch }) =>
    postBlueprint(aiUrl("analyze-material"), input.materials[0], MaterialBlueprintSchema, o),

  plan: (input: GenerationInput, material: MaterialBlueprint, o?: { signal?: AbortSignal; fetchImpl?: typeof fetch }) =>
    postBlueprint(
      aiUrl("plan-campaign"),
      { materials: [material], options: input.campaignOptions },
      CampaignBlueprintSchema,
      o
    ),

  story: (
    input: GenerationInput,
    campaign: CampaignBlueprint,
    storyId: string,
    material: MaterialBlueprint,
    previousSummaries: PreviousStorySummary[],
    o?: { signal?: AbortSignal; fetchImpl?: typeof fetch }
  ) =>
    postBlueprint(
      aiUrl("generate-story"),
      {
        campaign,
        story: campaign.story_sequence.find((s) => s.story_id === storyId),
        material,
        previousSummaries,
        options: input.storyOptions,
      },
      StoryBlueprintSchema,
      o
    ),
};
