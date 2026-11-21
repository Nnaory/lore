/**
 * Sync check — bring the server up to date with the projects in IndexedDB
 *
 * Runs on every page load in `http` mode (r13 spec, FR-5); there is no
 * "already imported" flag, because the server is idempotent:
 *   - a local project missing on the server is imported, with its campaign
 *     state (first migration, a new device cookie, or a create that never
 *     reached the server);
 *   - a local project newer than the server copy has its state PUT (a save
 *     that failed earlier);
 *   - a server copy that is newer or equal is left alone.
 *
 * Imports are batched by serialized size (at most 4 MB per request, under
 * Caddy's 5 MB cap), never one request per project, so the API's 5 imports
 * per minute limit is not hit. A 429 stops the run until the next load.
 * Items the server lists as rejected (invalid, or over a storage cap) are
 * not retried within the run. Local data is never deleted here.
 *
 * Only one run happens at a time: concurrent callers share the in-flight
 * promise (repeated effects under cacheComponents must not overlap). It
 * never throws.
 */

import { z } from "zod";
import type { CampaignState } from "@/lib/types/game";
import { API_BASE } from "./api-paths";
import { IndexedDbRepository } from "./indexed-db-repository";
import { SummarySchema, type Project } from "./project-model";
import type { ProjectRepository } from "./repository";

export const MAX_IMPORT_BATCH_BYTES = 4 * 1024 * 1024;

export type SyncResult = {
  imported: number;
  skipped: number;
  rejected: number;
  statesSent: number;
  /** Why the run ended early, if it did. */
  stopped?: "offline" | "server_error" | "rate_limited";
};

type LocalStore = Pick<ProjectRepository, "listProjects" | "loadProject">;

const ImportResponseSchema = z.object({
  imported: z.number(),
  skipped: z.number(),
  rejected: z.array(z.unknown()).default([]),
});

const encoder = new TextEncoder();
const byteSize = (value: unknown) => encoder.encode(JSON.stringify(value)).length;

let inFlight: Promise<SyncResult> | null = null;

/** Run the sync check, or join the run already in progress. */
export function syncCheck(local: LocalStore = new IndexedDbRepository()): Promise<SyncResult> {
  inFlight ??= run(local)
    .catch((): SyncResult => ({ imported: 0, skipped: 0, rejected: 0, statesSent: 0, stopped: "server_error" }))
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

async function run(local: LocalStore): Promise<SyncResult> {
  const result: SyncResult = { imported: 0, skipped: 0, rejected: 0, statesSent: 0 };

  let serverUpdatedAt: Map<string, number>;
  try {
    const res = await fetch(API_BASE);
    if (!res.ok) return { ...result, stopped: res.status === 429 ? "rate_limited" : "server_error" };
    const body: unknown = await res.json();
    const list = Array.isArray(body) ? body : [];
    serverUpdatedAt = new Map(
      list.flatMap((raw) => {
        const parsed = SummarySchema.safeParse(raw);
        return parsed.success ? [[parsed.data.id, parsed.data.updated_at] as const] : [];
      })
    );
  } catch {
    return { ...result, stopped: "offline" };
  }

  const localSummaries = await local.listProjects();
  if (localSummaries.length === 0) return result;

  const toImport: Project[] = [];
  const toSyncState: Array<{ id: string; state: CampaignState; updatedAt: number }> = [];
  for (const summary of localSummaries) {
    const serverTime = serverUpdatedAt.get(summary.id);
    if (serverTime !== undefined && summary.updated_at <= serverTime) continue; // server is current
    const project = await local.loadProject(summary.id); // validated with Zod; invalid → null
    if (!project) continue;
    if (serverTime === undefined) toImport.push(project);
    else if (project.campaign_state) {
      toSyncState.push({ id: project.id, state: project.campaign_state, updatedAt: project.updated_at });
    }
  }

  for (const batch of batchBySize(toImport, MAX_IMPORT_BATCH_BYTES)) {
    const stop = await sendImport(batch, result);
    if (stop) return { ...result, stopped: stop };
  }

  for (const { id, state, updatedAt } of toSyncState) {
    try {
      const res = await fetch(`${API_BASE}/${encodeURIComponent(id)}/state`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaign_state: state, updated_at: updatedAt }),
      });
      if (res.status === 429) return { ...result, stopped: "rate_limited" };
      if (res.ok) result.statesSent++;
    } catch {
      return { ...result, stopped: "offline" };
    }
  }
  return result;
}

/** Group projects so each request body stays under `maxBytes` (a single larger project goes alone). */
export function batchBySize(projects: Project[], maxBytes: number): Project[][] {
  const overhead = byteSize({ projects: [] });
  const batches: Project[][] = [];
  let batch: Project[] = [];
  let size = overhead;
  for (const project of projects) {
    const itemSize = byteSize(project) + 1; // + comma
    if (batch.length > 0 && size + itemSize > maxBytes) {
      batches.push(batch);
      batch = [];
      size = overhead;
    }
    batch.push(project);
    size += itemSize;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

async function sendImport(batch: Project[], result: SyncResult): Promise<SyncResult["stopped"]> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projects: batch }),
    });
  } catch {
    return "offline";
  }
  if (res.status === 429) return "rate_limited";
  if (!res.ok) return undefined; // e.g. 413 for one oversized batch: try the next one
  const parsed = ImportResponseSchema.safeParse(await res.json().catch(() => null));
  if (parsed.success) {
    result.imported += parsed.data.imported;
    result.skipped += parsed.data.skipped;
    result.rejected += parsed.data.rejected.length;
  }
  return undefined;
}
