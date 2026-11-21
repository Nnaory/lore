/**
 * Project store — the public persistence API of the app
 *
 * A "project" is one generated campaign: its blueprint, its stories, and the
 * player's campaign progress. Components (create page, saved stories, play
 * page) only ever import from here.
 *
 * The functions delegate to a ProjectRepository (see repository.ts), chosen
 * once at module load by the build-time flag NEXT_PUBLIC_PROJECT_STORE:
 *   - `idb` (default, and any other value): IndexedDbRepository, the
 *     browser's IndexedDB, with validation on read and a one-time move of
 *     projects saved by older versions in localStorage;
 *   - `http`: HttpRepository, the LORE API with IndexedDB as a local cache;
 *     it runs the sync check once per page load (r13 spec, FR-3 and FR-5).
 * The variable is read as the literal `process.env.NEXT_PUBLIC_PROJECT_STORE`
 * so Next.js inlines it into the client bundle. These signatures must not
 * change: components never know which repository is in use.
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
import { HttpRepository } from "./http-repository";
import { IndexedDbRepository, resetIndexedDbStoreForTests } from "./indexed-db-repository";
import type { Project, ProjectSummary, StoreResult } from "./project-model";
import type { ProjectRepository } from "./repository";
import { syncCheck } from "./sync";

export type { Project, ProjectSummary, StoreResult } from "./project-model";

function selectRepository(): ProjectRepository {
  // Literal access: Next.js replaces it at build time. Nothing runs at construction.
  return process.env.NEXT_PUBLIC_PROJECT_STORE === "http"
    ? new HttpRepository({ sync: syncCheck })
    : new IndexedDbRepository();
}

const repo = selectRepository();

/**
 * Show server save problems (a message) and recoveries (null) — http mode
 * only; in idb mode saving errors come back from saveCampaignState itself.
 * Returns a function that stops the reporting.
 */
export function setupSaveErrorHandler(fn: (message: string | null) => void): () => void {
  return repo instanceof HttpRepository ? repo.onSaveError(fn) : () => {};
}

/** Forget the connection and migration state (tests use a fresh database). */
export async function resetProjectStoreForTests(): Promise<void> {
  await resetIndexedDbStoreForTests();
}

/** Saved projects, newest first. Summaries whose project is missing are dropped. */
export async function listProjects(): Promise<ProjectSummary[]> {
  return repo.listProjects();
}

/** Load a project, or null if it is missing or invalid. */
export async function loadProject(id: string): Promise<Project | null> {
  return repo.loadProject(id);
}

/** Save a newly built campaign as a project. */
export async function createProject(input: {
  source: Project["source"];
  campaign: CampaignBlueprint;
  stories: ReadonlyMap<string, StoryBlueprint> | Record<string, StoryBlueprint>;
  materials?: MaterialBlueprint[];
}): Promise<StoreResult<Project>> {
  // The id stays internal: the public API never lets a caller choose it.
  return repo.createProject({
    source: input.source,
    campaign: input.campaign,
    stories: input.stories,
    ...(input.materials ? { materials: input.materials } : {}),
  });
}

/**
 * Record the player's campaign progress. Saves apply in order and never lose
 * each other's changes.
 */
export async function saveCampaignState(id: string, campaignState: CampaignState): Promise<StoreResult> {
  return repo.saveCampaignState(id, campaignState);
}

export async function deleteProject(id: string): Promise<void> {
  return repo.deleteProject(id);
}

/** The stories of a project as the Map CampaignPlayer expects, in story order. */
export function projectStories(project: Project): ReadonlyMap<string, StoryBlueprint> {
  return new Map(
    project.campaign.story_sequence
      .filter((entry) => project.stories[entry.story_id])
      .map((entry) => [entry.story_id, project.stories[entry.story_id]])
  );
}
