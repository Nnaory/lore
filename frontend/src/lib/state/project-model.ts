/**
 * Project model — types, schemas and pure helpers shared by every repository
 *
 * A "project" is one generated campaign: its blueprint, its stories, and the
 * player's campaign progress. These definitions used to live inside
 * project-store.ts; they are here so the IndexedDB and HTTP repositories can
 * share them without importing each other (r13 spec, task F1).
 *
 * Everything read from storage or from the server goes through `readProject`
 * or `SummarySchema`, because stored data can be stale or hand-edited.
 */

import { z } from "zod";
import { CampaignBlueprintSchema } from "@/lib/ai/schemas/campaign.schema";
import { StoryBlueprintSchema } from "@/lib/ai/schemas/story.schema";
import { CampaignStateSchema } from "@/lib/ai/schemas/game.schema";
import { DocumentFileTypeSchema } from "@/lib/ai/schemas/document.schema";
import { MaterialBlueprintSchema } from "@/lib/ai/schemas/material.schema";
import type { MaterialBlueprint } from "@/lib/types/material";
import type { CampaignBlueprint } from "@/lib/types/campaign";
import type { CampaignState } from "@/lib/types/game";
import type { StoryBlueprint } from "@/lib/types/story";
import type { DocumentFileType } from "@/lib/types/document";

export type Project = {
  id: string;
  created_at: number;
  updated_at: number;
  source: { file_name: string; file_type: DocumentFileType };
  campaign: CampaignBlueprint;
  /** story_id → StoryBlueprint, for every story in campaign.story_sequence. */
  stories: Record<string, StoryBlueprint>;
  /** Player progress; absent until the player starts. */
  campaign_state?: CampaignState;
  /** Analysed source material (concept names/definitions for the evaluation). */
  materials?: MaterialBlueprint[];
};

export type ProjectSummary = {
  id: string;
  title: string;
  genre: string;
  source_name: string;
  updated_at: number;
  stories_total: number;
  stories_completed: number;
};

export type StoreResult<T = void> = { ok: true; value: T } | { ok: false; message: string };

/** What a repository needs to create a project. `id` is internal (not on the public API). */
export type CreateProjectInput = {
  id?: string;
  source: Project["source"];
  campaign: CampaignBlueprint;
  stories: ReadonlyMap<string, StoryBlueprint> | Record<string, StoryBlueprint>;
  materials?: MaterialBlueprint[];
};

export const ProjectSchema = z.object({
  id: z.string().min(1),
  created_at: z.number(),
  updated_at: z.number(),
  source: z.object({ file_name: z.string(), file_type: DocumentFileTypeSchema }),
  campaign: CampaignBlueprintSchema,
  stories: z.record(z.string(), StoryBlueprintSchema),
  campaign_state: z.unknown().optional(),
  materials: z.array(MaterialBlueprintSchema).optional(),
});

export const SummarySchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  genre: z.string(),
  source_name: z.string(),
  updated_at: z.number(),
  stories_total: z.number(),
  stories_completed: z.number(),
});

export function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function summarize(p: Project): ProjectSummary {
  return {
    id: p.id,
    title: p.campaign.title,
    genre: p.campaign.genre,
    source_name: p.source.file_name,
    updated_at: p.updated_at,
    stories_total: p.campaign.story_sequence.length,
    stories_completed: p.campaign_state?.completed_stories.length ?? 0,
  };
}

/** A stored value as a Project, dropping invalid progress; null if unusable. */
export function readProject(raw: unknown): Project | null {
  const parsed = ProjectSchema.safeParse(raw);
  if (!parsed.success) return null;
  // Invalid progress is dropped (the player restarts) rather than losing the story.
  const state = CampaignStateSchema.safeParse(parsed.data.campaign_state);
  return { ...parsed.data, campaign_state: state.success ? state.data : undefined };
}

/** Build the record for a new project (shared so every repository stores the same shape). */
export function buildProject(input: CreateProjectInput, now: number): Project {
  const stories = input.stories instanceof Map ? Object.fromEntries(input.stories) : { ...input.stories };
  return {
    id: input.id ?? newId(),
    created_at: now,
    updated_at: now,
    source: input.source,
    campaign: input.campaign,
    stories,
    ...(input.materials ? { materials: input.materials } : {}),
  };
}
