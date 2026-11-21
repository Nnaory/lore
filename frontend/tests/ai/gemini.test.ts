/**
 * Tests — Gemini providers (mocked fetch; no network, no cost)
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { clearProvidersForTest } from "@/lib/ai/providers";
import { generateJson, geminiConfigFromEnv, type GeminiConfig } from "@/lib/ai/providers/gemini-client";
import { GeminiMaterialProvider, normalizeMaterialBlueprint } from "@/lib/ai/providers/gemini-material-provider";
import { GeminiCampaignPlannerProvider } from "@/lib/ai/providers/gemini-campaign-planner-provider";
import { GeminiStoryGeneratorProvider, mergeStoryContent } from "@/lib/ai/providers/gemini-story-generator";
import { buildCampaignBlueprint } from "@/lib/ai/campaign-planner-engine";
import { buildStoryBlueprint } from "@/lib/ai/story-generator-engine";
import { validateGeneratedStory } from "@/lib/validation/generator-validator";
import { validateStory } from "@/lib/validation/story-validator";
import { StoryBlueprintSchema } from "@/lib/ai/schemas/story.schema";
import { runFullWorkflow, resetFullWorkflowCaches } from "@/lib/ai/full-workflow";
import { dummyMaterial } from "@/data/dummy-campaign";
import type { MaterialBlueprint } from "@/lib/types/material";
import type { StoryBlueprint } from "@/lib/types/story";

const KEY = "test-key-should-never-leak";
const config: GeminiConfig = { apiKey: KEY, models: ["model-a", "model-b"], timeoutMs: 5_000, attemptsPerModel: 2, backoffMs: 0, deadlineMs: 60_000 };

function geminiOk(json: unknown, extra: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      ...extra,
    }),
    { status: 200 }
  );
}
const geminiError = (status: number, message = "error") =>
  new Response(JSON.stringify({ error: { code: status, message } }), { status });

/** A fetch that returns queued responses in order and records calls. */
function queue(...responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("no more queued responses");
    if (next instanceof Error) throw next;
    return next;
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

// These tests exercise the real (Gemini) registry, not the global test doubles.
beforeEach(() => {
  clearProvidersForTest();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetFullWorkflowCaches();
});

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

describe("generateJson", () => {
  it("sends the key in a header, never in the URL, and parses fenced JSON", async () => {
    const q = queue(
      new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: '```json\n{"a":1}\n```' }] } }] }),
        { status: 200 }
      )
    );
    const result = await generateJson({ system: "s", prompt: "p", maxOutputTokens: 10 }, config, q.fetch);
    expect(result).toMatchObject({ ok: true, json: { a: 1 }, model: "model-a" });
    expect(q.calls[0].url).not.toContain(KEY);
    expect((q.calls[0].init.headers as Record<string, string>)["x-goog-api-key"]).toBe(KEY);
  });

  it("retries an overloaded model, then succeeds", async () => {
    const q = queue(geminiError(503, "high demand"), geminiOk({ ok: true }));
    const result = await generateJson({ system: "s", prompt: "p", maxOutputTokens: 10 }, config, q.fetch);
    expect(result).toMatchObject({ ok: true, model: "model-a" });
    expect(q.calls).toHaveLength(2);
  });

  it("moves to the next model when one is retired (404)", async () => {
    const q = queue(geminiError(404, "no longer available"), geminiOk({ ok: true }));
    const result = await generateJson({ system: "s", prompt: "p", maxOutputTokens: 10 }, config, q.fetch);
    expect(result).toMatchObject({ ok: true, model: "model-b" });
    expect(q.calls[1].url).toContain("model-b");
  });

  it("ignores thought parts and retries invalid JSON", async () => {
    const q = queue(
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "not json" }] } }] }), { status: 200 }),
      new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "thinking…", thought: true }, { text: '{"b":2}' }] } }] }),
        { status: 200 }
      )
    );
    const result = await generateJson({ system: "s", prompt: "p", maxOutputTokens: 10 }, config, q.fetch);
    expect(result).toMatchObject({ ok: true, json: { b: 2 } });
  });

  it("stops immediately on billing/permission errors without leaking the key", async () => {
    const q = queue(geminiError(402, "credits depleted"));
    const result = await generateJson({ system: "s", prompt: "p", maxOutputTokens: 10 }, config, q.fetch);
    expect(result).toMatchObject({ ok: false, code: "PROVIDER_UNAVAILABLE" });
    expect(q.calls).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("reports rate limiting after every model is exhausted", async () => {
    const q = queue(geminiError(429), geminiError(429), geminiError(503), geminiError(503));
    const result = await generateJson({ system: "s", prompt: "p", maxOutputTokens: 10 }, config, q.fetch);
    expect(result).toMatchObject({ ok: false, code: "RATE_LIMITED" });
    expect(q.calls).toHaveLength(4);
  });

  it("moves to the next model on a timeout instead of waiting again", async () => {
    const hang = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      String(_url).includes("model-a")
        ? new Promise<Response>((_, reject) =>
            init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))
          )
        : Promise.resolve(geminiOk({ ok: 1 }))
    ) as unknown as typeof fetch;
    const result = await generateJson({ system: "s", prompt: "p", maxOutputTokens: 10 }, { ...config, timeoutMs: 20 }, hang);
    expect(result).toMatchObject({ ok: true, model: "model-b" });
    expect(hang).toHaveBeenCalledTimes(2); // model-a once (timed out), then model-b
  });

  it("gives up when the total deadline is reached", async () => {
    const q = queue(geminiError(503), geminiError(503), geminiError(503), geminiError(503));
    const result = await generateJson({ system: "s", prompt: "p", maxOutputTokens: 10 }, { ...config, deadlineMs: 0 }, q.fetch);
    expect(result.ok).toBe(false);
    expect(q.calls).toHaveLength(0);
  });

  it("treats network failures as retryable", async () => {
    const q = queue(new TypeError("fetch failed"), geminiOk({ c: 3 }));
    expect(await generateJson({ system: "s", prompt: "p", maxOutputTokens: 10 }, config, q.fetch)).toMatchObject({ ok: true });
  });

  it("aborts and returns TIMEOUT against a real slow HTTP server", async () => {
    const pendingTimers: ReturnType<typeof setTimeout>[] = [];
    const server = createServer((_req, res) => {
      const timer = setTimeout(() => {
        if (!res.destroyed) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }));
        }
      }, 250);
      pendingTimers.push(timer);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;

    const localFetch: typeof fetch = (_url, init) => fetch(`http://127.0.0.1:${port}/`, init);
    try {
      const result = await generateJson(
        { system: "s", prompt: "p", maxOutputTokens: 10 },
        { ...config, models: ["slow-model"], timeoutMs: 30, attemptsPerModel: 1, deadlineMs: 30 },
        localFetch
      );
      expect(result).toMatchObject({ ok: false, code: "TIMEOUT" });
    } finally {
      for (const timer of pendingTimers) clearTimeout(timer);
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("geminiConfigFromEnv", () => {
  it("reads the key and an ordered, comma-separated model list with 5-minute defaults", () => {
    expect(geminiConfigFromEnv({ GOOGLE_API_KEY: "k", AI_MODEL: " m1 , m2 " } as unknown as NodeJS.ProcessEnv)).toMatchObject({
      apiKey: "k",
      models: ["m1", "m2"],
      timeoutMs: 300_000,
      deadlineMs: 300_000,
    });
    expect(geminiConfigFromEnv({} as unknown as NodeJS.ProcessEnv)).toBeNull();
  });

  it("honors valid AI_TIMEOUT_MS/AI_DEADLINE_MS overrides and falls back cleanly on invalid input", () => {
    expect(
      geminiConfigFromEnv({
        GOOGLE_API_KEY: "k",
        AI_TIMEOUT_MS: "295000",
        AI_DEADLINE_MS: "600000",
      } as unknown as NodeJS.ProcessEnv)
    ).toMatchObject({
      timeoutMs: 295_000,
      deadlineMs: 600_000,
    });

    for (const bad of ["", "   ", "abc", "0", "-5"]) {
      expect(
        geminiConfigFromEnv({
          GOOGLE_API_KEY: "k",
          AI_TIMEOUT_MS: bad,
          AI_DEADLINE_MS: bad,
        } as unknown as NodeJS.ProcessEnv)
      ).toMatchObject({
        timeoutMs: 300_000,
        deadlineMs: 300_000,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Layer 1
// ---------------------------------------------------------------------------

const llmMaterial: MaterialBlueprint = {
  material_id: "material_01",
  title: "Photosynthesis",
  summary: "How plants turn light into chemical energy.",
  learning_objectives: ["Explain photosynthesis"],
  concepts: [
    { concept_id: "c1", name: "Chlorophyll", definition: "A pigment that absorbs light.", principles: ["Absorbs red and blue light"], methods: [], prerequisites: ["c2"], misconceptions: ["Chlorophyll absorbs green light", "Chlorophyll is food"], source_evidence: ["Chlorophyll absorbs light."] },
    { concept_id: "c2", name: "Light reactions", definition: "Reactions that convert light to ATP.", principles: ["Occur in thylakoids"], methods: [], prerequisites: ["c1", "c2", "ghost"], misconceptions: ["They happen at night", "They make glucose directly"], source_evidence: ["Light reactions make ATP."] },
    { concept_id: "c3", name: "Calvin cycle", definition: "Fixes CO2 into sugar.", principles: ["Uses ATP"], methods: [], prerequisites: ["c2"], misconceptions: ["Needs light directly", "Releases oxygen"], source_evidence: ["The Calvin cycle fixes carbon."] },
    { concept_id: "c4", name: "Stomata", definition: "Pores for gas exchange.", principles: [], methods: [], prerequisites: [], misconceptions: ["Only on top of leaves", "Absorb light"], source_evidence: ["Stomata exchange gases."] },
  ],
  scope_limitations: [],
};

describe("Gemini material provider", () => {
  it("replaces IDs, keeps only earlier prerequisites, and caps the concept count", () => {
    const normalized = normalizeMaterialBlueprint(llmMaterial, "source text", 3);
    const ids = normalized.concepts.map((c) => c.concept_id);
    expect(normalized.material_id).toMatch(/^material_/);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(normalized.concepts[0].prerequisites).toEqual([]); // c2 is later → dropped
    expect(normalized.concepts[1].prerequisites).toEqual([ids[0]]); // self + unknown dropped
    expect(normalized.concepts[2].prerequisites).toEqual([ids[1]]);
  });

  it("uses the story length to limit concepts and returns provider metadata", async () => {
    const q = queue(geminiOk(llmMaterial));
    const provider = new GeminiMaterialProvider(config, q.fetch);
    const result = await provider.analyzeMaterial({ material: "Photosynthesis notes ...", context: { story_length: "short" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.blueprint.concepts).toHaveLength(3);
    expect(result.value.meta).toMatchObject({ provider: "google", model: "model-a", tokensIn: 10, tokensOut: 5 });
    const sent = JSON.parse(q.calls[0].init.body as string);
    expect(sent.systemInstruction.parts[0].text).toContain("at most 3 concepts");
  });

  it("reports MATERIAL_ANALYSIS_FAILED when the model finds no concepts", async () => {
    const q = queue(geminiOk({ ...llmMaterial, concepts: [], learning_objectives: [] }));
    const result = await new GeminiMaterialProvider(config, q.fetch).analyzeMaterial({ material: "belajar vector" });
    expect(result).toMatchObject({ ok: false, error: { code: "MATERIAL_ANALYSIS_FAILED" } });
  });

  it("rejects output that is not a MaterialBlueprint", async () => {
    const q = queue(geminiOk({ title: "missing everything" }));
    const result = await new GeminiMaterialProvider(config, q.fetch).analyzeMaterial({ material: "some material here" });
    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
  });
});

// ---------------------------------------------------------------------------
// Layer 2
// ---------------------------------------------------------------------------

describe("Gemini campaign planner provider", () => {
  const request = { materials: [dummyMaterial], options: { genre: "fantasy" as const } };

  it("overlays creative fields without touching structure", async () => {
    const skeleton = buildCampaignBlueprint(request.materials, request.options);
    if (!skeleton.ok) throw new Error("engine failed");
    const q = queue(
      geminiOk({
        title: "The Glass Lanterns",
        premise: "Lanterns hold the night back.",
        characters: [
          { name: "Maren", role: "Lamplighter", description: "Keeps the lanterns." },
          { name: "Tobi", role: "Apprentice", description: "Asks good questions." },
        ],
        stories: [{ story_id: "story_01", title: "First Light" }],
      })
    );
    const result = await new GeminiCampaignPlannerProvider(config, q.fetch).planCampaign(request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bp = result.value.blueprint;
    expect(bp.title).toBe("The Glass Lanterns");
    expect(bp.characters.map((c) => [c.character_id, c.name])).toEqual([["char_01", "Maren"], ["char_02", "Tobi"]]);
    expect(bp.characters[0].expressions).toEqual(skeleton.blueprint.characters[0].expressions);
    expect(bp.story_sequence[0]).toMatchObject({ story_id: "story_01", title: "First Light", material_id: dummyMaterial.material_id });
    expect(bp.setting).toBe(skeleton.blueprint.setting); // not provided → template kept
  });

  it("keeps the template campaign when Gemini is unavailable", async () => {
    const q = queue(geminiError(403, "denied"));
    const result = await new GeminiCampaignPlannerProvider(config, q.fetch).planCampaign(request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.meta.model).toBe("deterministic-template");
    expect(result.value.meta.warnings.map((w) => w.code)).toContain("CREATIVE_FALLBACK");
  });
});

// ---------------------------------------------------------------------------
// Layer 3
// ---------------------------------------------------------------------------

function storyRequest() {
  const planned = buildCampaignBlueprint([dummyMaterial], { genre: "fantasy" });
  if (!planned.ok) throw new Error("engine failed");
  const campaign = planned.blueprint;
  return { campaign, story: campaign.story_sequence[0], material: dummyMaterial, options: { conceptsPerChapter: 1 } };
}

function contentFor(conceptIds: string[]) {
  return {
    intro: { narration: "You arrive at the lantern hall.", guide_line: "We need your help tonight." },
    concepts: conceptIds.map((id, i) => ({
      concept_id: id,
      companion_line: `Let's look at idea ${i + 1}.`,
      lesson_title: `Lesson ${i + 1}`,
      lesson_body: `Lesson body ${i + 1}.`,
      puzzle: {
        narrative_context: `Problem ${i + 1}.`,
        question: `Question ${i + 1}?`,
        correct_answer: `Right ${i + 1}`,
        wrong_answers: [`Wrong ${i + 1}a`, `Wrong ${i + 1}b`],
        explanation: `Because ${i + 1}.`,
        correct_feedback: "Well done.",
        incorrect_feedback: "Look at the lesson again.",
      },
      result_narration: `The lanterns brighten ${i + 1}.`,
      guide_line: "Good.",
    })),
    ending: { title: "Night Held Back", narration: "The hall glows again." },
  };
}

describe("mergeStoryContent", () => {
  const request = storyRequest();
  const skeleton = buildStoryBlueprint(request);
  if (!skeleton.ok) throw new Error("engine failed");
  const conceptIds = skeleton.blueprint.knowledge_mapping.map((m) => m.concept_id);

  it("writes every slot and keeps the story structurally valid", () => {
    const { blueprint, templated } = mergeStoryContent(skeleton.blueprint, contentFor(conceptIds));
    expect(templated).toEqual([]);
    expect(StoryBlueprintSchema.safeParse(blueprint).success).toBe(true);
    expect(validateStory(blueprint, dummyMaterial).valid).toBe(true);
    expect(validateGeneratedStory(blueprint, dummyMaterial, { entry: request.story }).valid).toBe(true);
    expect(blueprint.endings[0].title).toBe("Night Held Back");
    const lesson = blueprint.chapters.flatMap((c) => c.scenes).flatMap((s) => ("content" in s ? s.content : []))
      .find((b) => b.type === "learning_info");
    expect(lesson).toMatchObject({ title: "Lesson 1", body: "Lesson body 1." });
  });

  it("records the correct answer as data and shuffles the choices", () => {
    const { blueprint } = mergeStoryContent(skeleton.blueprint, contentFor(conceptIds));
    for (const [i, puzzle] of blueprint.puzzles.entries()) {
      const correct = puzzle.choices.find((c) => c.choice_id === puzzle.correct_choice_id);
      expect(correct?.text).toBe(`Right ${i + 1}`);
      expect(puzzle.choices).toHaveLength(3);
    }
    // Deterministic: same input → same order.
    const again = mergeStoryContent(skeleton.blueprint, contentFor(conceptIds));
    expect(again.blueprint.puzzles).toEqual(blueprint.puzzles);
  });

  const lessons = (b: StoryBlueprint) =>
    b.chapters.flatMap((c) => c.scenes).flatMap((s) => ("content" in s ? s.content : [])).filter((x) => x.type === "learning_info");

  it("attaches a valid lesson_visual to the lesson", () => {
    const content = contentFor(conceptIds);
    (content.concepts[0] as Record<string, unknown>).lesson_visual = {
      kind: "table",
      headers: ["A", "B", "A AND B"],
      rows: [["0", "0", "0"], ["1", "1", "1"]],
      caption: "Only 1 when both are 1.",
    };
    const { blueprint, droppedVisuals } = mergeStoryContent(skeleton.blueprint, content);
    expect(droppedVisuals).toEqual([]);
    expect(lessons(blueprint)[0]).toMatchObject({ visual: { kind: "table", headers: ["A", "B", "A AND B"] } });
    expect(StoryBlueprintSchema.parse(blueprint)).toEqual(blueprint); // survives save/load
    expect(validateGeneratedStory(blueprint, dummyMaterial, { entry: request.story }).valid).toBe(true);
  });

  it("drops an invalid lesson_visual but keeps the lesson text", () => {
    const content = contentFor(conceptIds);
    (content.concepts[0] as Record<string, unknown>).lesson_visual = {
      kind: "diagram",
      layout: "flow",
      nodes: [{ id: "a", label: "A" }],
      edges: [{ from: "a", to: "ghost" }],
    };
    const { blueprint, droppedVisuals, templated } = mergeStoryContent(skeleton.blueprint, content);
    expect(droppedVisuals).toEqual([conceptIds[0]]);
    expect(templated).toEqual([]);
    expect(lessons(blueprint)[0]).toMatchObject({ title: "Lesson 1", body: "Lesson body 1." });
    expect(lessons(blueprint)[0]).not.toHaveProperty("visual");
  });

  it("keeps the template puzzle when the written one has duplicate answers", () => {
    const content = contentFor(conceptIds);
    (content.concepts[0].puzzle as { wrong_answers: string[] }).wrong_answers = ["Right 1", "right 1 "];
    const { blueprint, templated } = mergeStoryContent(skeleton.blueprint, content);
    expect(templated).toContain(`puzzle:${skeleton.blueprint.puzzles[0].puzzle_id}`);
    expect(blueprint.puzzles[0].question).toBe(skeleton.blueprint.puzzles[0].question);
  });
});

describe("Gemini story generator provider", () => {
  it("reports the provider as unavailable instead of returning a generic template story", async () => {
    const q = queue(geminiError(500), geminiError(500), geminiError(500), geminiError(500));
    const result = await new GeminiStoryGeneratorProvider(config, q.fetch).generateStory(storyRequest());
    expect(result).toMatchObject({ ok: false, error: { code: "PROVIDER_UNAVAILABLE" } });
  });

  it("keeps a playable story and warns when only some slots are unusable", async () => {
    const skeleton = buildStoryBlueprint(storyRequest());
    if (!skeleton.ok) throw new Error("engine failed");
    const ids = skeleton.blueprint.knowledge_mapping.map((m) => m.concept_id);
    const content = contentFor(ids.slice(0, 1)); // second concept missing
    const q = queue(geminiOk(content));
    const result = await new GeminiStoryGeneratorProvider(config, q.fetch).generateStory(storyRequest());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.meta.warnings.map((w) => w.code)).toContain("CONTENT_PARTIAL_FALLBACK");
    expect(validateStory(result.value.blueprint, dummyMaterial).valid).toBe(true);
  });

  it("asks for lesson illustrations and reports the ones it had to drop", async () => {
    const skeleton = buildStoryBlueprint(storyRequest());
    if (!skeleton.ok) throw new Error("engine failed");
    const ids = skeleton.blueprint.knowledge_mapping.map((m) => m.concept_id);
    const content = contentFor(ids);
    (content.concepts[0] as Record<string, unknown>).lesson_visual = {
      kind: "vectors",
      vectors: [{ from: [0, 0], to: [3, 4], label: "v" }],
    };
    (content.concepts[1] as Record<string, unknown>).lesson_visual = { kind: "table", headers: ["A"], rows: [["1", "2"]] };
    const q = queue(geminiOk(content));
    const result = await new GeminiStoryGeneratorProvider(config, q.fetch).generateStory(storyRequest());

    const prompt = JSON.parse(String(q.calls[0].init.body)).contents[0].parts[0].text as string;
    expect(prompt).toContain('"lesson_steps"');
    expect(prompt).toContain('"visual": VISUAL');
    expect(prompt).toContain('"kind":"diagram"');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const visuals = result.value.blueprint.chapters
      .flatMap((c) => c.scenes)
      .flatMap((s) => ("content" in s ? s.content : []))
      .flatMap((b) => (b.type === "learning_info" && b.visual ? [b.visual.kind] : []));
    expect(visuals).toEqual(["vectors"]);
    const dropped = result.value.meta.warnings.find((w) => w.code === "VISUAL_DROPPED");
    expect(dropped?.message).toContain(ids[1]);
  });

  it("fences the story to the material's concepts, notation and scope", async () => {
    const request = storyRequest();
    const material = {
      ...request.material,
      concepts: request.material.concepts.map((c, i) => (i === 0 ? { ...c, notation: ["‖v‖ = panjang vektor v"], examples: ["(1,2)+(3,1)=(4,3)"] } : c)),
    };
    const skeleton = buildStoryBlueprint({ ...request, material });
    if (!skeleton.ok) throw new Error("engine failed");
    const q = queue(geminiOk(contentFor(skeleton.blueprint.knowledge_mapping.map((m) => m.concept_id))));
    await new GeminiStoryGeneratorProvider(config, q.fetch).generateStory({ ...request, material });

    const prompt = JSON.parse(String(q.calls[0].init.body)).contents[0].parts[0].text as string;
    expect(prompt).toContain("‖v‖ = panjang vektor v");
    expect(prompt).toContain("(1,2)+(3,1)=(4,3)");
    expect(prompt).toContain("The material does NOT cover");
    for (const limit of material.scope_limitations) expect(prompt).toContain(limit);
    expect(prompt).toContain("ONLY about the concepts listed above");
    expect(prompt).toContain("Worked example");
  });

  it("gives the story request a longer timeout than the default", async () => {
    const skeleton = buildStoryBlueprint(storyRequest());
    if (!skeleton.ok) throw new Error("engine failed");
    // A fetch that resolves after 40 ms would time out under a 20 ms default.
    const slow = vi.fn(async (_url: unknown, init?: RequestInit) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 40);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
      return geminiOk(contentFor(skeleton.blueprint.knowledge_mapping.map((m) => m.concept_id)));
    });
    const tight = { ...config, timeoutMs: 20, deadlineMs: 50, attemptsPerModel: 1 };
    const result = await new GeminiStoryGeneratorProvider(tight, slow as unknown as typeof fetch).generateStory(storyRequest());
    expect(result.ok).toBe(true);
  });
});

describe("mergeStoryContent — lesson steps", () => {
  const request = storyRequest();
  const skeleton = buildStoryBlueprint(request);
  if (!skeleton.ok) throw new Error("engine failed");
  const conceptIds = skeleton.blueprint.knowledge_mapping.map((m) => m.concept_id);
  const learningSceneOf = (b: StoryBlueprint, conceptId: string) => {
    const id = b.knowledge_mapping.find((m) => m.concept_id === conceptId)!.introduced_in_scene_id;
    const scene = b.chapters.flatMap((c) => c.scenes).find((s) => s.scene_id === id)!;
    if (!("content" in scene)) throw new Error("learning scene has no content");
    return scene;
  };

  const step = (n: number, extra: Record<string, unknown> = {}) => ({ title: `Step ${n}`, body: `Body ${n}.`, ...extra });

  it("teaches one concept in several lesson blocks with the companion between them", () => {
    const content = contentFor(conceptIds);
    (content.concepts[0] as Record<string, unknown>).lesson_steps = [
      step(1, { visual: { kind: "vectors", vectors: [{ from: [0, 0], to: [1, 2] }] } }),
      step(2, { companion_line: "So how do we add them?" }),
      step(3),
    ];
    const { blueprint, templated, droppedVisuals } = mergeStoryContent(skeleton.blueprint, content);
    expect(templated).toEqual([]);
    expect(droppedVisuals).toEqual([]);

    const scene = learningSceneOf(blueprint, conceptIds[0]);
    expect(scene.content.map((b) => (b.type === "learning_info" ? b.title : b.type))).toEqual([
      "dialogue", // the companion's opening line
      "Step 1",
      "dialogue",
      "Step 2",
      "Step 3",
    ]);
    const lessons = scene.content.filter((b) => b.type === "learning_info");
    expect(lessons.every((b) => b.type === "learning_info" && b.concept_ids.join() === conceptIds[0])).toBe(true);
    expect(lessons[0]).toMatchObject({ visual: { kind: "vectors" } });
    const between = scene.content[2];
    expect(between).toMatchObject({ type: "dialogue", text: "So how do we add them?" });
    expect(between.type === "dialogue" && scene.content[0].type === "dialogue" && between.character_id).toBe(
      scene.content[0].type === "dialogue" ? scene.content[0].character_id : null
    );

    // Still a valid, playable, generator-compliant story.
    expect(StoryBlueprintSchema.parse(blueprint)).toEqual(blueprint);
    expect(validateStory(blueprint, dummyMaterial).valid).toBe(true);
    expect(validateGeneratedStory(blueprint, dummyMaterial, { entry: request.story }).valid).toBe(true);
  });

  it("drops invalid steps, keeps the valid ones and caps the count", () => {
    const content = contentFor(conceptIds);
    (content.concepts[0] as Record<string, unknown>).lesson_steps = [
      { title: "", body: "no title" },
      step(1),
      step(2, { visual: { kind: "table", headers: ["A"], rows: [["1", "2"]] } }),
      step(3),
      step(4),
      step(5),
    ];
    const { blueprint, droppedVisuals } = mergeStoryContent(skeleton.blueprint, content);
    const titles = learningSceneOf(blueprint, conceptIds[0]).content.flatMap((b) => (b.type === "learning_info" ? [b.title] : []));
    expect(titles).toEqual(["Step 1", "Step 2", "Step 3", "Step 4"]);
    expect(droppedVisuals).toEqual([conceptIds[0]]);
  });

  it("falls back to the single lesson fields when no step is usable", () => {
    const content = contentFor(conceptIds);
    (content.concepts[0] as Record<string, unknown>).lesson_steps = [{ title: "Only a title" }];
    const { blueprint, templated } = mergeStoryContent(skeleton.blueprint, content);
    const lessons = learningSceneOf(blueprint, conceptIds[0]).content.filter((b) => b.type === "learning_info");
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toMatchObject({ title: "Lesson 1", body: "Lesson body 1." });
    expect(templated).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// End to end through the registry (AI_PROVIDER=google)
// ---------------------------------------------------------------------------

describe("full workflow with AI_PROVIDER=google", () => {
  it("builds a validated campaign from material using all three Gemini layers", async () => {
    vi.stubEnv("AI_PROVIDER", "google");
    vi.stubEnv("GOOGLE_API_KEY", KEY);
    vi.stubEnv("AI_MODEL", "model-a");
    resetFullWorkflowCaches();

    const fake = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      const system: string = body.systemInstruction.parts[0].text;
      const prompt: string = body.contents[0].parts[0].text;
      if (system.includes("learning engineer")) return geminiOk(llmMaterial);
      if (system.includes("narrative designer")) return geminiOk({ title: "The Glass Lanterns" });
      const ids = [...prompt.matchAll(/"concept_id": "([^"]+)"/g)].map((m) => m[1]);
      return geminiOk(contentFor(ids));
    });
    vi.stubGlobal("fetch", fake);

    const result = await runFullWorkflow({
      materials: [{ material: "Photosynthesis lecture notes ...", context: { story_length: "short" } }],
      campaignOptions: { genre: "fantasy" },
      storyOptions: { conceptsPerChapter: 1 },
    });

    expect(result.ok).toBe(true);
    expect(fake).toHaveBeenCalledTimes(3); // one call per layer
    expect(result.campaign?.title).toBe("The Glass Lanterns");
    const story = [...(result.stories?.values() ?? [])][0];
    expect(story.chapters).toHaveLength(3);
    expect(story.puzzles.map((p) => p.question)).toEqual(["Question 1?", "Question 2?", "Question 3?"]);
  });

  it("reports PROVIDER_UNAVAILABLE (not a material problem) when the storyteller is down", async () => {
    vi.stubEnv("AI_PROVIDER", "google");
    vi.stubEnv("GOOGLE_API_KEY", KEY);
    vi.stubEnv("AI_MODEL", "model-a");
    vi.stubEnv("AI_DEADLINE_MS", "1"); // story call gets no time
    resetFullWorkflowCaches();

    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call++;
        if (call === 1) return geminiOk(llmMaterial);
        if (call === 2) return geminiOk({ title: "X" });
        return geminiError(503);
      })
    );

    const result = await runFullWorkflow({
      materials: [{ material: "Photosynthesis lecture notes ...", context: { story_length: "short" } }],
      campaignOptions: { genre: "fantasy" },
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PROVIDER_UNAVAILABLE");
  });
});
