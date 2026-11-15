/**
 * Project store — browser localStorage
 *
 * A "project" is one generated campaign: its blueprint, its stories, and the
 * player's campaign progress. Everything is validated with Zod when read
 * back, because localStorage can hold stale or hand-edited data.
 *
 * Layout:
 *   lore:projects           → JSON array of ProjectSummary (newest first)
 *   lore:project:<id>       → JSON Project
 *
 * All functions are SSR-safe (no-ops without `window`) and never throw:
 * storage errors (quota, private mode) come back as `{ ok: false }`.
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

const INDEX_KEY = "lore:projects";
const projectKey = (id: string) => `lore:project:${id}`;

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

const ProjectSchema = z.object({
  id: z.string().min(1),
  created_at: z.number(),
  updated_at: z.number(),
  source: z.object({ file_name: z.string(), file_type: DocumentFileTypeSchema }),
  campaign: CampaignBlueprintSchema,
  stories: z.record(z.string(), StoryBlueprintSchema),
  campaign_state: z.unknown().optional(),
  materials: z.array(MaterialBlueprintSchema).optional(),
});

const SummarySchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  genre: z.string(),
  source_name: z.string(),
  updated_at: z.number(),
  stories_total: z.number(),
  stories_completed: z.number(),
});

export type StoreResult<T = void> = { ok: true; value: T } | { ok: false; message: string };

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null; // access can throw when storage is disabled
  }
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function summarize(p: Project): ProjectSummary {
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

const QUOTA_MESSAGE =
  "Your browser's storage is full. Delete a saved story from the home page, then try again.";

function writeIndex(store: Storage, summaries: ProjectSummary[]) {
  store.setItem(INDEX_KEY, JSON.stringify(summaries));
}

/** Saved projects, newest first. Entries whose project is missing are dropped. */
export function listProjects(): ProjectSummary[] {
  const store = storage();
  if (!store) return [];
  try {
    const parsed = z.array(SummarySchema).safeParse(JSON.parse(store.getItem(INDEX_KEY) ?? "[]"));
    if (!parsed.success) return [];
    return parsed.data
      .filter((s) => store.getItem(projectKey(s.id)) !== null)
      .sort((a, b) => b.updated_at - a.updated_at);
  } catch {
    return [];
  }
}

/** Load a project, or null if it is missing or invalid. */
export function loadProject(id: string): Project | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(projectKey(id));
    if (!raw) return null;
    const parsed = ProjectSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    // Invalid progress is dropped (the player restarts) rather than losing the story.
    const state = CampaignStateSchema.safeParse(parsed.data.campaign_state);
    return { ...parsed.data, campaign_state: state.success ? state.data : undefined };
  } catch {
    return null;
  }
}

function persist(project: Project): StoreResult<Project> {
  const store = storage();
  if (!store) return { ok: false, message: "Saving is not available in this browser." };
  try {
    store.setItem(projectKey(project.id), JSON.stringify(project));
    const others = listProjects().filter((s) => s.id !== project.id);
    writeIndex(store, [summarize(project), ...others]);
    return { ok: true, value: project };
  } catch {
    return { ok: false, message: QUOTA_MESSAGE };
  }
}

/** Save a newly built campaign as a project. */
export function createProject(input: {
  source: Project["source"];
  campaign: CampaignBlueprint;
  stories: ReadonlyMap<string, StoryBlueprint> | Record<string, StoryBlueprint>;
  materials?: MaterialBlueprint[];
}): StoreResult<Project> {
  const now = Date.now();
  const stories = input.stories instanceof Map ? Object.fromEntries(input.stories) : { ...input.stories };
  return persist({ id: newId(), created_at: now, updated_at: now, source: input.source, campaign: input.campaign, stories, materials: input.materials });
}

/** Record the player's campaign progress. */
export function saveCampaignState(id: string, campaignState: CampaignState): StoreResult {
  const project = loadProject(id);
  if (!project) return { ok: false, message: "This story is no longer saved." };
  const result = persist({ ...project, campaign_state: campaignState, updated_at: Date.now() });
  return result.ok ? { ok: true, value: undefined } : result;
}

export function deleteProject(id: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(projectKey(id));
    writeIndex(store, listProjects().filter((s) => s.id !== id));
  } catch {
    // nothing else to do
  }
}

/** The stories of a project as the Map CampaignPlayer expects, in story order. */
export function projectStories(project: Project): ReadonlyMap<string, StoryBlueprint> {
  return new Map(
    project.campaign.story_sequence
      .filter((entry) => project.stories[entry.story_id])
      .map((entry) => [entry.story_id, project.stories[entry.story_id]])
  );
}
