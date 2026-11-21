/**
 * Tests — project-store in http mode (r13 F5)
 *
 * The repository is chosen at module load from NEXT_PUBLIC_PROJECT_STORE, so
 * each case stubs the env, resets the module registry and imports the store
 * fresh. The existing project-store.test.ts (idb mode) is untouched.
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialCampaignState } from "@/lib/game/campaign-manager";
import { dummyCampaign } from "@/data/dummy-campaign";
import { linearStory } from "../fixtures/linear-story";
import { freshStore } from "../fixtures/fresh-store";

type Call = { url: string; method: string };
const calls: Call[] = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function importStore(mode: string | undefined) {
  if (mode === undefined) vi.stubEnv("NEXT_PUBLIC_PROJECT_STORE", undefined as unknown as string);
  else vi.stubEnv("NEXT_PUBLIC_PROJECT_STORE", mode);
  vi.resetModules();
  return import("@/lib/state/project-store");
}

const input = {
  source: { file_name: "notes.pdf", file_type: "pdf" as const },
  campaign: dummyCampaign,
  stories: { [linearStory.story_id]: linearStory },
};

beforeEach(async () => {
  await freshStore();
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET" });
      if ((init?.method ?? "GET") === "GET" && url === "/api/v1/projects") return json(200, []);
      if (init?.method === "POST" && url === "/api/v1/projects") return json(201, JSON.parse(String(init.body)));
      if (url.endsWith("/import")) return json(200, { imported: 1, skipped: 0, rejected: [] });
      return json(404, { detail: "project not found" });
    })
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("project-store in http mode", () => {
  it("sends all five functions to the API", async () => {
    const store = await importStore("http");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const created = await store.createProject(input);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.value.id;
    expect(calls).toContainEqual({ url: "/api/v1/projects", method: "POST" });

    await store.listProjects();
    expect(calls).toContainEqual({ url: "/api/v1/projects", method: "GET" });

    await store.loadProject(id);
    expect(calls).toContainEqual({ url: `/api/v1/projects/${id}`, method: "GET" });

    await store.saveCampaignState(id, createInitialCampaignState(dummyCampaign));
    await vi.advanceTimersByTimeAsync(1500);
    expect(calls).toContainEqual({ url: `/api/v1/projects/${id}/state`, method: "PUT" });

    await store.deleteProject(id);
    expect(calls).toContainEqual({ url: `/api/v1/projects/${id}`, method: "DELETE" });
  });

  it("starts the sync check once per page load, from the first read", async () => {
    const store = await importStore("http");
    await store.listProjects();
    await vi.waitFor(() => expect(calls.filter((c) => c.method === "GET")).toHaveLength(2)); // list + sync
    await store.listProjects();
    await store.loadProject("x");
    const listGets = calls.filter((c) => c.method === "GET" && c.url === "/api/v1/projects");
    expect(listGets).toHaveLength(3); // 2 lists + 1 sync, not 2 syncs
  });

  it("wires the save error handler and lets it unsubscribe", async () => {
    const store = await importStore("http");
    const unsubscribe = store.setupSaveErrorHandler(() => {});
    expect(typeof unsubscribe).toBe("function");
    expect(() => unsubscribe()).not.toThrow();
  });
});

describe("project-store in idb mode", () => {
  it.each([
    ["unset", undefined],
    ["idb", "idb"],
    ["any other value", "HTTP"],
  ])("uses IndexedDB only when the flag is %s", async (_label, mode) => {
    const store = await importStore(mode);
    const created = await store.createProject(input);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await store.listProjects();
    await store.loadProject(created.value.id);
    await store.saveCampaignState(created.value.id, createInitialCampaignState(dummyCampaign));
    await store.deleteProject(created.value.id);
    expect(calls).toEqual([]);
    expect(store.setupSaveErrorHandler(() => {})).toBeTypeOf("function");
  });
});
