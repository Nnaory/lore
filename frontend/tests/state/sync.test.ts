/**
 * Tests — syncCheck (r13 F4): seeded fake-indexeddb, mocked fetch
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { batchBySize, MAX_IMPORT_BATCH_BYTES, syncCheck } from "@/lib/state/sync";
import { IndexedDbRepository } from "@/lib/state/indexed-db-repository";
import type { Project } from "@/lib/state/project-model";
import { createInitialCampaignState, completeStory } from "@/lib/game/campaign-manager";
import { dummyCampaign } from "@/data/dummy-campaign";
import { linearStory } from "../fixtures/linear-story";
import { freshStore } from "../fixtures/fresh-store";

type Call = { url: string; method: string; body: unknown };
const calls: Call[] = [];
let server: Array<{ id: string; updated_at: number }> = [];
let handler: (call: Call) => Response | Promise<Response> = defaultHandler;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function summary(id: string, updated_at: number) {
  return { id, updated_at, title: "T", genre: "fantasy", source_name: "a.pdf", stories_total: 1, stories_completed: 0 };
}

function defaultHandler(call: Call): Response {
  if (call.method === "GET") return json(200, server.map((s) => summary(s.id, s.updated_at)));
  if (call.url.endsWith("/import")) {
    const count = (call.body as { projects: unknown[] }).projects.length;
    return json(200, { imported: count, skipped: 0, rejected: [] });
  }
  return json(200, { updated_at: 1 });
}

const stories = { [linearStory.story_id]: linearStory };

async function seed(id: string, options: { played?: boolean; updatedAt?: number; padding?: number } = {}) {
  const repo = new IndexedDbRepository();
  const campaign = options.padding
    ? { ...dummyCampaign, premise: "x".repeat(options.padding) }
    : dummyCampaign;
  const created = await repo.createProject({ id, source: { file_name: `${id}.pdf`, file_type: "pdf" }, campaign, stories });
  if (!created.ok) throw new Error(created.message);
  if (options.played || options.updatedAt) {
    const state = options.played
      ? completeStory(createInitialCampaignState(campaign), campaign, linearStory)
      : createInitialCampaignState(campaign);
    await repo.saveCampaignState(id, state, options.updatedAt ?? Date.now());
  }
  return (await repo.loadProject(id)) as Project;
}

const imports = () => calls.filter((c) => c.url.endsWith("/import"));
const puts = () => calls.filter((c) => c.method === "PUT");

beforeEach(async () => {
  await freshStore();
  calls.length = 0;
  server = [];
  handler = defaultHandler;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const call = { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      return handler(call);
    })
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("syncCheck", () => {
  it("imports a project missing on the server, with its campaign_state", async () => {
    const local = await seed("p1", { played: true });
    const result = await syncCheck();
    expect(imports()).toHaveLength(1);
    const sent = (imports()[0].body as { projects: Project[] }).projects;
    expect(sent).toEqual([local]);
    expect(sent[0].campaign_state?.completed_stories).toEqual([linearStory.story_id]);
    expect(result).toMatchObject({ imported: 1, rejected: 0 });
  });

  it("sends several small projects in one request", async () => {
    for (const id of ["a", "b", "c"]) await seed(id);
    await syncCheck();
    expect(imports()).toHaveLength(1);
    expect((imports()[0].body as { projects: Project[] }).projects).toHaveLength(3);
  });

  it("splits projects totalling more than 4 MB into several requests under the cap", async () => {
    for (const id of ["big1", "big2", "big3"]) await seed(id, { padding: 1_600_000 });
    await syncCheck();
    expect(imports().length).toBeGreaterThan(1);
    for (const call of imports()) {
      expect(new TextEncoder().encode(JSON.stringify(call.body)).length).toBeLessThanOrEqual(MAX_IMPORT_BATCH_BYTES);
    }
    const ids = imports().flatMap((c) => (c.body as { projects: Project[] }).projects.map((p) => p.id));
    expect(ids.sort()).toEqual(["big1", "big2", "big3"]);
  });

  it("puts the state once when the local copy is newer", async () => {
    const local = await seed("p1", { played: true, updatedAt: 5_000 });
    server = [{ id: "p1", updated_at: 4_000 }];
    const result = await syncCheck();
    expect(imports()).toHaveLength(0);
    expect(puts()).toEqual([
      {
        url: "/api/v1/projects/p1/state",
        method: "PUT",
        body: { campaign_state: local.campaign_state, updated_at: 5_000 },
      },
    ]);
    expect(result.statesSent).toBe(1);
  });

  it.each([
    ["newer", 6_000],
    ["equal", 5_000],
  ])("does nothing when the server copy is %s", async (_label, serverTime) => {
    await seed("p1", { played: true, updatedAt: 5_000 });
    server = [{ id: "p1", updated_at: serverTime }];
    await syncCheck();
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("makes no write request when IndexedDB is empty", async () => {
    await syncCheck();
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("does nothing and does not throw when offline", async () => {
    await seed("p1");
    handler = () => {
      throw new TypeError("offline");
    };
    await expect(syncCheck()).resolves.toMatchObject({ stopped: "offline" });
    expect(await new IndexedDbRepository().loadProject("p1")).not.toBeNull();
  });

  it("re-imports everything after cookies are cleared (empty server list)", async () => {
    await seed("a", { played: true });
    await seed("b");
    server = [];
    await syncCheck();
    const ids = imports().flatMap((c) => (c.body as { projects: Project[] }).projects.map((p) => p.id));
    expect(ids.sort()).toEqual(["a", "b"]);
  });

  it("shares one run between concurrent callers", async () => {
    await seed("p1");
    const [first, second] = await Promise.all([syncCheck(), syncCheck()]);
    expect(first).toBe(second);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(1);
    expect(imports()).toHaveLength(1);
  });

  it("stops the run on 429 and keeps local data", async () => {
    for (const id of ["big1", "big2", "big3"]) await seed(id, { padding: 1_600_000 });
    handler = (call) => (call.method === "GET" ? defaultHandler(call) : json(429, { detail: "rate limit exceeded" }));
    const result = await syncCheck();
    expect(result.stopped).toBe("rate_limited");
    expect(imports()).toHaveLength(1);
    expect(await new IndexedDbRepository().listProjects()).toHaveLength(3);
  });

  it("counts rejected items and does not retry them within the run", async () => {
    await seed("p1");
    handler = (call) =>
      call.method === "GET"
        ? defaultHandler(call)
        : json(200, { imported: 0, skipped: 0, rejected: [{ index: 0, id: "p1", error: "project limit reached" }] });
    const result = await syncCheck();
    expect(result).toMatchObject({ imported: 0, rejected: 1 });
    expect(imports()).toHaveLength(1);
  });
});

describe("batchBySize", () => {
  it("puts a single project larger than the cap in its own batch", async () => {
    const big = await seed("big", { padding: 200 });
    const small = await seed("small");
    const batches = batchBySize([big, small], 100);
    expect(batches.map((b) => b.map((p) => p.id))).toEqual([["big"], ["small"]]);
  });
});
