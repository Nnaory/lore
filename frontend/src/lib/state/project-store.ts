/**
 * Project store — browser IndexedDB
 *
 * A "project" is one generated campaign: its blueprint, its stories, and the
 * player's campaign progress. Everything is validated with Zod when read
 * back, because stored data can be stale or hand-edited.
 *
 * Layout (database "lore", see idb.ts):
 *   projects  → Project, keyed by id
 *   summaries → ProjectSummary, keyed by id (written in the same
 *               transaction as its project, so the two never disagree)
 *
 * IndexedDB replaces localStorage, whose ~5 MB limit filled up quickly once
 * stories carried several illustrated lesson steps per concept. Projects
 * saved by older versions in localStorage are moved over automatically the
 * first time the store is used (see migrateFromLocalStorage).
 *
 * Every function is async, SSR-safe (no IndexedDB → empty / not saved) and
 * never throws: storage errors (quota, private mode) come back as
 * `{ ok: false }`.
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
import { indexedDbAvailable, PROJECTS, resetDatabaseConnection, SUMMARIES, transact } from "./idb";

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

const UNAVAILABLE_MESSAGE = "Saving is not available in this browser.";
const QUOTA_MESSAGE =
  "Your browser's storage is full. Delete a saved story from the home page, then try again.";
const FAILED_MESSAGE = "Your story could not be saved in this browser. Try again.";
const MISSING_MESSAGE = "This story is no longer saved.";

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

function failure(err: unknown): { ok: false; message: string } {
  const name = (err as { name?: string } | null)?.name;
  return { ok: false, message: name === "QuotaExceededError" ? QUOTA_MESSAGE : FAILED_MESSAGE };
}

/** A stored value as a Project, dropping invalid progress; null if unusable. */
function readProject(raw: unknown): Project | null {
  const parsed = ProjectSchema.safeParse(raw);
  if (!parsed.success) return null;
  // Invalid progress is dropped (the player restarts) rather than losing the story.
  const state = CampaignStateSchema.safeParse(parsed.data.campaign_state);
  return { ...parsed.data, campaign_state: state.success ? state.data : undefined };
}

// ---------------------------------------------------------------------------
// One-time move from localStorage (projects saved by older versions)
// ---------------------------------------------------------------------------

const LEGACY_INDEX_KEY = "lore:projects";
const LEGACY_PROJECT_PREFIX = "lore:project:";

function legacyStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null; // access can throw when storage is disabled
  }
}

/**
 * Copy every valid localStorage project into IndexedDB, then remove the
 * copied keys. A project already in IndexedDB is only replaced by an older
 * copy's newer version, so progress made after an interrupted move is kept.
 * On any failure the localStorage data stays put and the move is retried on
 * the next page load.
 */
async function migrateFromLocalStorage(): Promise<void> {
  const ls = legacyStorage();
  if (!ls) return;
  const keys: string[] = [];
  for (let i = 0; i < ls.length; i++) {
    const key = ls.key(i);
    if (key?.startsWith(LEGACY_PROJECT_PREFIX)) keys.push(key);
  }
  if (keys.length === 0) {
    if (ls.getItem(LEGACY_INDEX_KEY) !== null) ls.removeItem(LEGACY_INDEX_KEY);
    return;
  }

  const legacy: Array<{ key: string; project: Project }> = [];
  for (const key of keys) {
    try {
      const project = readProject(JSON.parse(ls.getItem(key) ?? "null"));
      if (project) legacy.push({ key, project });
    } catch {
      // unreadable — left in place, never shown (as before)
    }
  }

  try {
    await transact<void>([PROJECTS, SUMMARIES], "readwrite", (tx) => {
      const projects = tx.objectStore(PROJECTS);
      const summaries = tx.objectStore(SUMMARIES);
      for (const { project } of legacy) {
        const existing = projects.get(project.id);
        existing.onsuccess = () => {
          const current = readProject(existing.result);
          if (current && current.updated_at >= project.updated_at) return;
          projects.put(project);
          summaries.put(summarize(project));
        };
      }
    });
  } catch (err) {
    console.warn("[project-store] Could not move saved stories to IndexedDB; will retry.", err);
    return;
  }

  for (const { key } of legacy) ls.removeItem(key);
  if (legacy.length === keys.length) ls.removeItem(LEGACY_INDEX_KEY);
}

let ready: Promise<boolean> | null = null;

/** True once IndexedDB is usable and any legacy projects have been moved. */
function storeReady(): Promise<boolean> {
  ready ??= indexedDbAvailable() ? migrateFromLocalStorage().then(() => true, () => true) : Promise.resolve(false);
  return ready;
}

/** Forget the connection and migration state (tests use a fresh database). */
export async function resetProjectStoreForTests(): Promise<void> {
  ready = null;
  await resetDatabaseConnection();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Saved projects, newest first. Summaries whose project is missing are dropped. */
export async function listProjects(): Promise<ProjectSummary[]> {
  if (!(await storeReady())) return [];
  try {
    const { summaries, ids } = await transact<{ summaries: unknown[]; ids: IDBValidKey[] }>(
      [PROJECTS, SUMMARIES],
      "readonly",
      (tx, setResult) => {
        const all = tx.objectStore(SUMMARIES).getAll();
        const keys = tx.objectStore(PROJECTS).getAllKeys();
        // Requests in a transaction complete in order: `all` is done by now.
        keys.onsuccess = () => setResult({ summaries: all.result ?? [], ids: keys.result });
      }
    );
    const present = new Set(ids);
    return summaries
      .flatMap((raw) => {
        const parsed = SummarySchema.safeParse(raw);
        return parsed.success && present.has(parsed.data.id) ? [parsed.data] : [];
      })
      .sort((a, b) => b.updated_at - a.updated_at);
  } catch {
    return [];
  }
}

/** Load a project, or null if it is missing or invalid. */
export async function loadProject(id: string): Promise<Project | null> {
  if (!(await storeReady())) return null;
  try {
    const raw = await transact<unknown>([PROJECTS], "readonly", (tx, setResult) => {
      const request = tx.objectStore(PROJECTS).get(id);
      request.onsuccess = () => setResult(request.result);
    });
    return readProject(raw);
  } catch {
    return null;
  }
}

/** Save a newly built campaign as a project. */
export async function createProject(input: {
  source: Project["source"];
  campaign: CampaignBlueprint;
  stories: ReadonlyMap<string, StoryBlueprint> | Record<string, StoryBlueprint>;
  materials?: MaterialBlueprint[];
}): Promise<StoreResult<Project>> {
  if (!(await storeReady())) return { ok: false, message: UNAVAILABLE_MESSAGE };
  const now = Date.now();
  const stories = input.stories instanceof Map ? Object.fromEntries(input.stories) : { ...input.stories };
  const project: Project = {
    id: newId(),
    created_at: now,
    updated_at: now,
    source: input.source,
    campaign: input.campaign,
    stories,
    ...(input.materials ? { materials: input.materials } : {}),
  };
  try {
    await transact<void>([PROJECTS, SUMMARIES], "readwrite", (tx) => {
      tx.objectStore(PROJECTS).put(project);
      tx.objectStore(SUMMARIES).put(summarize(project));
    });
    return { ok: true, value: project };
  } catch (err) {
    return failure(err);
  }
}

/**
 * Record the player's campaign progress. Read and write happen in one
 * transaction, so back-to-back saves apply in order and never lose each
 * other's changes.
 */
export async function saveCampaignState(id: string, campaignState: CampaignState): Promise<StoreResult> {
  if (!(await storeReady())) return { ok: false, message: UNAVAILABLE_MESSAGE };
  try {
    return await transact<StoreResult>([PROJECTS, SUMMARIES], "readwrite", (tx, setResult) => {
      const projects = tx.objectStore(PROJECTS);
      const request = projects.get(id);
      request.onsuccess = () => {
        const project = readProject(request.result);
        if (!project) {
          setResult({ ok: false, message: MISSING_MESSAGE });
          return;
        }
        const updated: Project = { ...project, campaign_state: campaignState, updated_at: Date.now() };
        projects.put(updated);
        tx.objectStore(SUMMARIES).put(summarize(updated));
        setResult({ ok: true, value: undefined });
      };
    });
  } catch (err) {
    return failure(err);
  }
}

export async function deleteProject(id: string): Promise<void> {
  if (!(await storeReady())) return;
  try {
    await transact<void>([PROJECTS, SUMMARIES], "readwrite", (tx) => {
      tx.objectStore(PROJECTS).delete(id);
      tx.objectStore(SUMMARIES).delete(id);
    });
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
