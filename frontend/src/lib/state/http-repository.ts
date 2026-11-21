/**
 * HttpRepository — projects on the LORE API, with IndexedDB as a local cache
 *
 * Used when the app is built with NEXT_PUBLIC_PROJECT_STORE=http (r13 spec,
 * FR-3 to FR-6). Writes go to IndexedDB first, so a failing or unreachable
 * server never loses a story or progress; the server copy follows:
 *   - createProject: local, then POST. A network error still counts as saved
 *     (the sync check uploads it later). A 409 means the id belongs to someone
 *     else, so the orphan local copy is removed.
 *   - saveCampaignState: local at once, then a debounced PUT (1.5 s). Saves
 *     are sent one at a time, newest state per project, never in parallel.
 *     Server and network errors keep the state and retry with a doubling
 *     delay (5 s → 60 s); a 429 waits for Retry-After. Problems are reported
 *     through the onSaveError callback, because the caller already got
 *     `{ ok: true }` for the local write.
 *   - loadProject: server first, local copy on 404, error or bad data.
 *   - listProjects: server list plus local-only (not yet uploaded) projects.
 *
 * The server sends `null` for absent optional fields; they are dropped before
 * the Zod validation in readProject. Nothing happens at construction (no
 * fetch, no IndexedDB), because this module also runs during server rendering.
 */

import type { CampaignState } from "@/lib/types/game";
import { API_BASE, projectUrl } from "./api-paths";
import { IndexedDbRepository } from "./indexed-db-repository";
import {
  newId,
  readProject,
  SummarySchema,
  type CreateProjectInput,
  type Project,
  type ProjectSummary,
  type StoreResult,
} from "./project-model";
import type { ProjectRepository } from "./repository";

export { API_BASE } from "./api-paths";
export const DEBOUNCE_MS = 1500;
export const INITIAL_RETRY_MS = 5_000;
export const MAX_RETRY_MS = 60_000;

export const HTTP_MESSAGES = {
  idTaken: "This story ID already exists. Try again.",
  serverRejected: "Could not save to the server. Your story is kept on this device.",
  stale: "Your progress was saved from another session. Reload to see the latest.",
  notOnServer: "This story is not on the server yet. It will sync on your next visit.",
  busy: "Server is busy. Your progress is kept on this device and will retry.",
  saveFailed: "Could not save your progress. It is kept on this device and will retry.",
  offline: "Could not reach the server. Your progress is kept on this device.",
} as const;

type PendingState = { id: string; state: CampaignState; updatedAt: number };
type LocalStore = Pick<
  ProjectRepository,
  "listProjects" | "loadProject" | "createProject" | "saveCampaignState" | "deleteProject"
>;

/** Server JSON → Project: drop null optionals, then the usual validation. */
export function projectFromServer(raw: unknown): Project | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const copy: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const key of ["campaign_state", "materials"]) {
    if (copy[key] === null) delete copy[key];
  }
  return readProject(copy);
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Retry-After in ms (seconds form), capped; the server's fixed 60 s when missing or invalid. */
function retryAfterMs(res: Response): number {
  const seconds = Number.parseInt(res.headers.get("Retry-After") ?? "", 10);
  const ms = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : MAX_RETRY_MS;
  return Math.min(ms, MAX_RETRY_MS);
}

export class HttpRepository implements ProjectRepository {
  private readonly local: LocalStore;
  /** Newest unsent state per project, in arrival order. */
  private readonly pending = new Map<string, PendingState>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private nextRetryDelay = INITIAL_RETRY_MS;
  private onError: ((message: string | null) => void) | null = null;
  private readonly sync: ((local: LocalStore) => Promise<unknown>) | null;
  private syncStarted = false;

  /**
   * `sync` runs once, in the background, on the first listProjects or
   * loadProject call, i.e. once per page load for the app's single instance
   * (project-store.ts passes syncCheck). Without it nothing is synced.
   */
  constructor(options: { local?: LocalStore; sync?: (local: LocalStore) => Promise<unknown> } = {}) {
    this.local = options.local ?? new IndexedDbRepository();
    this.sync = options.sync ?? null;
  }

  private startSync(): void {
    if (this.syncStarted || !this.sync) return;
    this.syncStarted = true;
    void this.sync(this.local).catch(() => undefined);
  }

  /** Report server save problems (a message) and recoveries (null). Returns an unsubscribe. */
  onSaveError(fn: (message: string | null) => void): () => void {
    this.onError = fn;
    return () => {
      if (this.onError === fn) this.onError = null;
    };
  }

  // ---- reads --------------------------------------------------------------

  async listProjects(): Promise<ProjectSummary[]> {
    this.startSync();
    const [server, local] = await Promise.all([this.fetchServerList(), this.local.listProjects()]);
    const serverIds = new Set(server.map((s) => s.id));
    const localOnly = local.filter((s) => !serverIds.has(s.id));
    return [...server, ...localOnly].sort((a, b) => b.updated_at - a.updated_at);
  }

  private async fetchServerList(): Promise<ProjectSummary[]> {
    try {
      const res = await fetch(API_BASE);
      if (!res.ok) return [];
      const body = await readJson(res);
      if (!Array.isArray(body)) return [];
      return body.flatMap((raw) => {
        const parsed = SummarySchema.safeParse(raw);
        return parsed.success ? [parsed.data] : [];
      });
    } catch {
      return [];
    }
  }

  async loadProject(id: string): Promise<Project | null> {
    this.startSync();
    try {
      const res = await fetch(projectUrl(id));
      if (res.ok) {
        const project = projectFromServer(await readJson(res));
        if (project) return project;
      }
    } catch {
      // network error: fall through to the local copy
    }
    return this.local.loadProject(id);
  }

  // ---- create -------------------------------------------------------------

  async createProject(input: CreateProjectInput): Promise<StoreResult<Project>> {
    const id = input.id ?? newId();
    const local = await this.local.createProject({ ...input, id });
    if (!local.ok) return local;
    const project = local.value; // same id and timestamps on both copies

    let res: Response;
    try {
      res = await fetch(API_BASE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(project),
      });
    } catch {
      return { ok: true, value: project }; // kept locally; the sync check uploads it
    }
    if (res.ok) return { ok: true, value: project };
    if (res.status === 409) {
      await this.local.deleteProject(id); // the id belongs to another owner
      return { ok: false, message: HTTP_MESSAGES.idTaken };
    }
    return { ok: false, message: HTTP_MESSAGES.serverRejected };
  }

  // ---- save state ---------------------------------------------------------

  async saveCampaignState(id: string, campaignState: CampaignState, updatedAt = Date.now()): Promise<StoreResult> {
    const local = await this.local.saveCampaignState(id, campaignState, updatedAt);
    if (!local.ok) return local;

    this.pending.delete(id); // re-insert so arrival order stays newest-last
    this.pending.set(id, { id, state: campaignState, updatedAt });
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.flush();
    }, DEBOUNCE_MS);
    return { ok: true, value: undefined };
  }

  /** Send pending states one at a time. Safe to call at any moment. */
  private async flush(): Promise<void> {
    if (this.inFlight) return;
    const next = this.pending.values().next();
    if (next.done) return;
    const sending = next.value;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.inFlight = true;
    try {
      const res = await fetch(`${projectUrl(sending.id)}/state`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaign_state: sending.state, updated_at: sending.updatedAt }),
      });
      if (res.ok) {
        this.settle(sending);
        this.nextRetryDelay = INITIAL_RETRY_MS;
        this.onError?.(null);
      } else if (res.status === 409 || res.status === 404) {
        this.settle(sending); // stale, or not on the server yet: retrying cannot help
        this.onError?.(res.status === 409 ? HTTP_MESSAGES.stale : HTTP_MESSAGES.notOnServer);
      } else if (res.status === 429) {
        this.onError?.(HTTP_MESSAGES.busy);
        this.scheduleRetry(retryAfterMs(res));
      } else {
        this.onError?.(HTTP_MESSAGES.saveFailed);
        this.scheduleRetry(this.backoff());
      }
    } catch {
      this.onError?.(HTTP_MESSAGES.offline);
      this.scheduleRetry(this.backoff());
    } finally {
      this.inFlight = false;
    }
    // More waiting (another project, or a newer state that arrived mid-flight)?
    // Send it now unless a retry or the debounce window is already scheduled.
    if (this.pending.size > 0 && !this.retryTimer && !this.debounceTimer) void this.flush();
  }

  /** Forget a sent state, unless a newer one for the same project replaced it meanwhile. */
  private settle(sent: PendingState): void {
    if (this.pending.get(sent.id) === sent) this.pending.delete(sent.id);
  }

  private backoff(): number {
    const delay = this.nextRetryDelay;
    this.nextRetryDelay = Math.min(delay * 2, MAX_RETRY_MS);
    return delay;
  }

  private scheduleRetry(delay: number): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flush();
    }, delay);
  }

  // ---- delete -------------------------------------------------------------

  async deleteProject(id: string): Promise<void> {
    this.pending.delete(id);
    await this.local.deleteProject(id);
    try {
      await fetch(projectUrl(id), { method: "DELETE" });
    } catch {
      // best effort; the local copy is already gone
    }
  }
}
