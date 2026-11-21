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
 *
 * Types, schemas and pure helpers live in project-model.ts and are re-exported
 * here, so existing imports keep working.
 */

import type { CampaignBlueprint } from "@/lib/types/campaign";
import type { CampaignState } from "@/lib/types/game";
import type { MaterialBlueprint } from "@/lib/types/material";
import type { StoryBlueprint } from "@/lib/types/story";
import { indexedDbAvailable, PROJECTS, resetDatabaseConnection, SUMMARIES, transact } from "./idb";
import {
  buildProject,
  readProject,
  summarize,
  SummarySchema,
  type Project,
  type ProjectSummary,
  type StoreResult,
} from "./project-model";

export type { Project, ProjectSummary, StoreResult } from "./project-model";

const UNAVAILABLE_MESSAGE = "Saving is not available in this browser.";
const QUOTA_MESSAGE =
  "Your browser's storage is full. Delete a saved story from the home page, then try again.";
const FAILED_MESSAGE = "Your story could not be saved in this browser. Try again.";
const MISSING_MESSAGE = "This story is no longer saved.";

function failure(err: unknown): { ok: false; message: string } {
  const name = (err as { name?: string } | null)?.name;
  return { ok: false, message: name === "QuotaExceededError" ? QUOTA_MESSAGE : FAILED_MESSAGE };
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
  const project = buildProject(input, Date.now());
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
