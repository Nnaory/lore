/**
 * ProjectRepository — the storage interface behind project-store.ts
 *
 * Two implementations exist: IndexedDbRepository (browser only, the current
 * behaviour) and HttpRepository (the FastAPI backend, with IndexedDB as a
 * local cache). project-store.ts picks one at build time and keeps its public
 * functions unchanged, so components never know which one is in use (r13
 * spec, FR-3).
 *
 * Like the rest of the store, implementations never throw: failures come back
 * as `{ ok: false, message }`, null or an empty list.
 */

import type { CampaignState } from "@/lib/types/game";
import type { CreateProjectInput, Project, ProjectSummary, StoreResult } from "./project-model";

export interface ProjectRepository {
  /** Saved projects, newest first. */
  listProjects(): Promise<ProjectSummary[]>;
  /** A project, or null if it is missing or invalid. */
  loadProject(id: string): Promise<Project | null>;
  /** Save a new project. `input.id` lets a caller fix the id up front. */
  createProject(input: CreateProjectInput): Promise<StoreResult<Project>>;
  /**
   * Record campaign progress. `updatedAt` lets a caller stamp the local and the
   * server copy with the same time; it defaults to now.
   */
  saveCampaignState(id: string, campaignState: CampaignState, updatedAt?: number): Promise<StoreResult>;
  deleteProject(id: string): Promise<void>;
}
