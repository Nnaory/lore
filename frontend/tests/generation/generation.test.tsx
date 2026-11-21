/**
 * Tests — staged generation (reducer, helpers, and the useGeneration hook)
 *
 * @vitest-environment jsdom
 *
 * The hook runs against the real AI route handlers (dummy provider).
 */

import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import {
  generationReducer,
  initialGenerationState,
  postBlueprint,
  selectConcepts,
} from "@/lib/generation/generation";
import { useGeneration, type GenerationResult } from "@/lib/generation/use-generation";
import { MaterialBlueprintSchema } from "@/lib/contracts/schemas/material.schema";
import { BUILD_MESSAGES, messageForCode } from "@/lib/contracts/error-messages";
import { aiUrl } from "@/lib/generation/ai-endpoints";
import type { GenerationRequest } from "@/lib/contracts/generation-request";
import { dummyMaterial } from "@/data/dummy-campaign";
import { routeFetch } from "../fixtures/route-fetch";

// The dummy provider recognises linear-algebra material and returns two concepts.
const input: GenerationRequest = {
  materials: [{ material: "Linear algebra notes: a linear combination scales vectors; the vector span is every combination." }],
  campaignOptions: { genre: "fantasy" },
  storyOptions: { conceptsPerChapter: 1 },
};

const busy = () => new Response(JSON.stringify({ ok: false, error: { code: "PROVIDER_UNAVAILABLE", message: "x" } }), { status: 503 });

describe("selectConcepts", () => {
  it("keeps only the chosen concepts and drops prerequisites to removed ones", () => {
    // concept_vector_span requires concept_linear_combination
    const only = selectConcepts(dummyMaterial, ["concept_vector_span"]);
    expect(only.concepts.map((c) => c.concept_id)).toEqual(["concept_vector_span"]);
    expect(only.concepts[0].prerequisites).toEqual([]);
    expect(dummyMaterial.concepts[1].prerequisites).toEqual(["concept_linear_combination"]); // input untouched
  });
});

describe("generationReducer", () => {
  it("selects every concept when the material arrives and waits for review", () => {
    const state = generationReducer(initialGenerationState, { type: "material_ready", material: dummyMaterial });
    expect(state).toMatchObject({ stage: "reviewing", status: "waiting", selectedConceptIds: ["concept_linear_combination", "concept_vector_span"] });
  });

  it("only toggles concepts during review", () => {
    expect(generationReducer(initialGenerationState, { type: "concept_toggled", conceptId: "x" })).toBe(initialGenerationState);
  });

  it("records failures without losing finished results", () => {
    let state = generationReducer(initialGenerationState, { type: "material_ready", material: dummyMaterial });
    state = generationReducer(state, { type: "stage_started", stage: "planning" });
    state = generationReducer(state, { type: "failed", message: "busy" });
    expect(state).toMatchObject({ stage: "planning", status: "failed", error: "busy" });
    expect(state.material).toBe(dummyMaterial);
  });
});

describe("postBlueprint", () => {
  it("maps an error envelope to a user message", async () => {
    const fetchImpl = vi.fn(async () => busy()) as unknown as typeof fetch;
    expect(await postBlueprint("/x", {}, MaterialBlueprintSchema, { fetchImpl })).toEqual({ ok: false, message: BUILD_MESSAGES.busy });
  });

  it("maps a 429 RATE_LIMITED envelope from the api backend to the busy message", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: false, error: { code: "RATE_LIMITED", message: "x" } }), { status: 429 })
    ) as unknown as typeof fetch;
    const url = aiUrl("analyze-material", "api");
    expect(await postBlueprint(url, {}, MaterialBlueprintSchema, { fetchImpl })).toEqual({
      ok: false,
      message: messageForCode("RATE_LIMITED"),
    });
    expect(fetchImpl).toHaveBeenCalledWith("/api/v1/ai/analyze-material", expect.objectContaining({ method: "POST" }));
    expect(messageForCode("RATE_LIMITED")).toBe(BUILD_MESSAGES.busy);
  });

  it("maps a 503 PROVIDER_NOT_CONFIGURED envelope from the api backend to the not-set-up message", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, error: { code: "PROVIDER_NOT_CONFIGURED", message: "x" } }), { status: 503 })
    ) as unknown as typeof fetch;
    const result = await postBlueprint(aiUrl("plan-campaign", "api"), {}, MaterialBlueprintSchema, { fetchImpl });
    expect(result).toEqual({ ok: false, message: BUILD_MESSAGES.notConfigured });
    expect(BUILD_MESSAGES.notConfigured).toMatch(/isn't set up/);
  });

  it("rejects a success envelope whose blueprint is invalid", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { blueprint: { title: "?" } } }))) as unknown as typeof fetch;
    expect(await postBlueprint("/x", {}, MaterialBlueprintSchema, { fetchImpl })).toEqual({ ok: false, message: BUILD_MESSAGES.unexpected });
  });
});

describe("useGeneration", () => {
  function setup(override?: Parameters<typeof routeFetch>[0]) {
    const route = routeFetch(override);
    const onDone = vi.fn<(result: GenerationResult) => void>();
    const hook = renderHook(() => useGeneration({ onDone, fetchImpl: route.fetchImpl }));
    return { ...route, onDone, hook };
  }

  it("stops for review after analysis, then plans and writes with the kept concepts", async () => {
    const { hook, calls, onDone } = setup();
    act(() => hook.result.current.start(input));
    await waitFor(() => expect(hook.result.current.state.stage).toBe("reviewing"));
    expect(calls.map((c) => c.path)).toEqual(["/api/ai/analyze-material"]); // nothing written yet

    const [first, second] = hook.result.current.state.material!.concepts;
    act(() => hook.result.current.toggleConcept(first.concept_id));
    act(() => hook.result.current.confirmConcepts());
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));

    expect(calls.map((c) => c.path)).toEqual([
      "/api/ai/analyze-material",
      "/api/ai/plan-campaign",
      "/api/ai/generate-story",
    ]);
    const planned = calls[1].body as { materials: Array<{ concepts: Array<{ concept_id: string }> }> };
    expect(planned.materials[0].concepts.map((c) => c.concept_id)).toEqual([second.concept_id]);

    const result = onDone.mock.calls[0][0];
    const story = [...result.stories.values()][0];
    expect(story.knowledge_mapping.map((m) => m.concept_id)).toEqual([second.concept_id]);
    expect(hook.result.current.state.stage).toBe("done");
  });

  it("retries only the failed stage", async () => {
    let failPlanning = true;
    const { hook, calls, onDone } = setup((call) => {
      if (call.path === "/api/ai/plan-campaign" && failPlanning) {
        failPlanning = false;
        return busy();
      }
      return undefined;
    });

    act(() => hook.result.current.start(input));
    await waitFor(() => expect(hook.result.current.state.stage).toBe("reviewing"));
    act(() => hook.result.current.confirmConcepts());
    await waitFor(() => expect(hook.result.current.state.status).toBe("failed"));
    expect(hook.result.current.state).toMatchObject({ stage: "planning", error: BUILD_MESSAGES.busy });

    act(() => hook.result.current.retry());
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    // analysis was not repeated
    expect(calls.filter((c) => c.path === "/api/ai/analyze-material")).toHaveLength(1);
  });

  it("ignores results that arrive after cancel", async () => {
    const { hook } = setup();
    act(() => hook.result.current.start(input));
    act(() => hook.result.current.cancel());
    await new Promise((r) => setTimeout(r, 50));
    expect(hook.result.current.state.stage).toBe("analyzing");
    expect(hook.result.current.state.material).toBeNull();
  });

  it("starts fresh on a second run", async () => {
    const { hook, onDone } = setup();
    act(() => hook.result.current.start(input));
    await waitFor(() => expect(hook.result.current.state.stage).toBe("reviewing"));
    act(() => hook.result.current.confirmConcepts());
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));

    act(() => hook.result.current.start(input));
    expect(hook.result.current.state.campaign).toBeNull();
    await waitFor(() => expect(hook.result.current.state.stage).toBe("reviewing"));
  });
});
