/**
 * useGeneration — runs the staged generation (see generation.ts)
 *
 * Generation starts only from `start(input)` (a click), never from an
 * effect: React's dev-mode double effects would otherwise send every paid
 * AI request twice. Results that arrive after `cancel()` or unmount are
 * ignored.
 */

"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import type { CampaignBlueprint } from "@/lib/types/campaign";
import type { MaterialBlueprint } from "@/lib/types/material";
import type { StoryBlueprint } from "@/lib/types/story";
import type { PreviousStorySummary } from "@/lib/types/game";
import {
  api,
  generationReducer,
  initialGenerationState,
  selectConcepts,
  type GenerationInput,
} from "./generation";

export type GenerationResult = {
  material: MaterialBlueprint;
  campaign: CampaignBlueprint;
  stories: ReadonlyMap<string, StoryBlueprint>;
};

export function useGeneration(options: {
  onDone: (result: GenerationResult) => void;
  fetchImpl?: typeof fetch;
}) {
  const [state, dispatch] = useReducer(generationReducer, initialGenerationState);
  const inputRef = useRef<GenerationInput | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const stateRef = useRef(state);
  const optionsRef = useRef(options);
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

    dispatch({ type: "all_stories_ready" });
    optionsRef.current.onDone({ material, campaign, stories });
  }, []);

  const start = useCallback(
    (input: GenerationInput) => {
      inputRef.current = input;
      stateRef.current = initialGenerationState; // a new run never reuses old results
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
    dispatch({ type: "reset" });
  }, []);

  return {
    state,
    start,
    retry,
    cancel,
    reset,
    /** Confirm the reviewed concepts and write the story. */
    confirmConcepts: useCallback(() => void write(), [write]),
    toggleConcept: useCallback((conceptId: string) => dispatch({ type: "concept_toggled", conceptId }), []),
  };
}
