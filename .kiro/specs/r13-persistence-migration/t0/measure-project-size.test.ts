/**
 * T0 (r13 spec) — one-off measurement of real project sizes. NOT part of the suite.
 *
 * Runs the same staged pipeline as /create (analyze → plan → story by story with
 * previousSummaries) through the real route handlers and the real Gemini provider, builds the
 * record exactly as project-store.createProject + saveCampaignState would, plays story 1 with
 * the StoryViewer recipe (all puzzles correct, good ending), and measures
 * new Blob([JSON.stringify(x)]).size. Skips unless T0_MEASURE=1. Stored in the spec folder;
 * copy it to frontend/tests/_t0/ to run it (see README.md next to it).
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { describe, it } from "vitest";
import { POST as analyzePOST } from "@/app/api/ai/analyze-material/route";
import { POST as planPOST } from "@/app/api/ai/plan-campaign/route";
import { POST as storyPOST } from "@/app/api/ai/generate-story/route";
import { api, type GenerationInput } from "@/lib/generation/generation";
import { completeStory, createInitialCampaignState } from "@/lib/game/campaign-manager";
import {
  getConceptIdsFromScene,
  getOrCreateKnowledge,
  mergeKnowledgeUpdates,
  recordLearningExposure,
  recordPuzzleSubmission,
} from "@/lib/game/knowledge-manager";
import type { CampaignBlueprint } from "@/lib/types/campaign";
import type { PlayerKnowledge, PreviousStorySummary } from "@/lib/types/game";
import type { MaterialBlueprint } from "@/lib/types/material";
import type { StoryBlueprint } from "@/lib/types/story";

const ROOT = join(__dirname, "..", "..", "..");
const enabled = process.env.T0_MEASURE === "1";

const handlers: Record<string, (r: NextRequest) => Promise<Response>> = {
  "/api/ai/analyze-material": analyzePOST,
  "/api/ai/plan-campaign": planPOST,
  "/api/ai/generate-story": storyPOST,
};

const fetchImpl = (async (url: string, init?: RequestInit) => {
  const handler = handlers[url];
  if (!handler) throw new Error(`no handler for ${url}`);
  const response = await handler(new NextRequest(`http://localhost${url}`, init as never));
  if (!response.ok) {
    const text = await response.clone().text();
    console.log(`  ${url} -> HTTP ${response.status}: ${text.slice(0, 600)}`);
  }
  return response;
}) as unknown as typeof fetch;

const size = (value: unknown) => new Blob([JSON.stringify(value)]).size;

async function retry<T>(label: string, step: () => Promise<{ ok: true; value: T } | { ok: false; message: string }>) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await step();
    if (result.ok) return result.value;
    console.log(`  ${label} attempt ${attempt} failed: ${result.message}`);
  }
  throw new Error(`${label} failed 3 times`);
}

function input(material: string, fileName: string, length: "short" | "medium"): GenerationInput {
  return {
    materials: [
      {
        material,
        genre: "fantasy",
        context: { source_file_name: fileName, source_file_type: "md", story_length: length, language: "en" },
      },
    ],
    campaignOptions: { genre: "fantasy", language: "en" },
    storyOptions: { conceptsPerChapter: 1, language: "en" },
  } as GenerationInput;
}

/** Play one story the way StoryViewer does: learning exposure on every scene, puzzles correct. */
function playStory(state: ReturnType<typeof createInitialCampaignState>, campaign: CampaignBlueprint, story: StoryBlueprint) {
  let pk: Record<string, PlayerKnowledge> = { ...state.player_knowledge };
  for (const chapter of story.chapters) {
    for (const scene of chapter.scenes) {
      const updates: Record<string, PlayerKnowledge> = {};
      for (const id of getConceptIdsFromScene(story, scene.scene_id)) {
        updates[id] = recordLearningExposure(getOrCreateKnowledge(pk, id), scene.scene_id);
      }
      pk = mergeKnowledgeUpdates(pk, updates);
      if (scene.type === "puzzle") {
        const puzzle = story.puzzles.find((p) => p.puzzle_id === scene.puzzle_id);
        const solved: Record<string, PlayerKnowledge> = {};
        for (const id of puzzle?.concept_ids ?? []) {
          solved[id] = recordPuzzleSubmission(getOrCreateKnowledge(pk, id), puzzle!.puzzle_id, true);
        }
        pk = mergeKnowledgeUpdates(pk, solved);
      }
    }
  }
  const endingScene = story.chapters.flatMap((c) => c.scenes).find((s) => s.type === "ending");
  const ending = story.endings.find((e) => endingScene && "ending_id" in endingScene && e.ending_id === endingScene.ending_id);
  return completeStory({ ...state, player_knowledge: pk }, campaign, story, {
    worldStateChanges: ending?.world_state_changes,
    relationshipChanges: ending?.relationship_changes,
    outcomeDescription: ending?.title,
  });
}

async function measure(name: string, gen: GenerationInput, fileName: string) {
  const started = Date.now();
  console.log(`[${name}] analyzing ${gen.materials[0].material.length} chars`);
  const material: MaterialBlueprint = await retry("analyze", () => api.analyze(gen, { fetchImpl }));
  console.log(`[${name}] planning (${material.concepts.length} concepts)`);
  const campaign = await retry("plan", () => api.plan(gen, material, { fetchImpl }));
  const stories: Record<string, StoryBlueprint> = {};
  const summaries: PreviousStorySummary[] = [];
  for (const entry of campaign.story_sequence) {
    console.log(`[${name}] writing ${entry.story_id}`);
    const story = await retry(entry.story_id, () =>
      api.story(gen, campaign, entry.story_id, material, summaries, { fetchImpl })
    );
    stories[entry.story_id] = story;
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
  const first = stories[campaign.story_sequence[0].story_id];
  const campaignState = playStory(createInitialCampaignState(campaign), campaign, first);
  const now = Date.now();
  const record = {
    id: crypto.randomUUID(),
    created_at: now,
    updated_at: now,
    source: { file_name: fileName, file_type: "md" },
    campaign,
    stories,
    materials: [material],
    campaign_state: campaignState,
  };
  return {
    name,
    input_chars: gen.materials[0].material.length,
    concepts: material.concepts.length,
    stories_count: Object.keys(stories).length,
    chapters_per_story: Object.values(stories).map((s) => s.chapters.length),
    record: size(record),
    campaign: size(campaign),
    stories_total: size(stories),
    story_each: Object.values(stories).map(size),
    materials: size(record.materials),
    campaign_state: size(campaignState),
    put_state_body: size({ campaign_state: campaignState, updated_at: now }),
    minutes: Math.round((Date.now() - started) / 600) / 100,
  };
}

describe.skipIf(!enabled)("T0 project size measurement", () => {
  it("measures short, medium and largest-input projects", async () => {
    const docs = readFileSync(join(ROOT, "docs", "DOCS.md"), "utf8");
    const design = readFileSync(join(ROOT, "docs", "DESIGN.md"), "utf8");
    const infraDir = join(ROOT, "docs", "infra");
    const infra = readdirSync(infraDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => readFileSync(join(infraDir, f), "utf8"))
      .join("\n\n")
      .slice(0, 80_000);

    const results = [];
    results.push(await measure("short / DOCS.md", input(docs, "DOCS.md", "short"), "DOCS.md"));
    results.push(await measure("medium / DESIGN.md", input(design, "DESIGN.md", "medium"), "DESIGN.md"));
    results.push(await measure("medium / docs-infra 80k", input(infra, "docs-infra.md", "medium"), "docs-infra.md"));

    const out = process.env.T0_OUT ?? join(process.cwd(), "t0-results.json");
    writeFileSync(out, JSON.stringify({ model: process.env.AI_MODEL, results }, null, 2));
    console.log(JSON.stringify(results, null, 2));
  });
});
