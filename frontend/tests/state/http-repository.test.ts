/**
 * Tests — HttpRepository (r13 F3): mocked fetch, fake-indexeddb, fake timers
 *
 * Only setTimeout/clearTimeout are faked, so fake-indexeddb keeps working.
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEBOUNCE_MS,
  HTTP_MESSAGES,
  HttpRepository,
  INITIAL_RETRY_MS,
  MAX_RETRY_MS,
} from "@/lib/state/http-repository";
import { IndexedDbRepository } from "@/lib/state/indexed-db-repository";
import type { Project } from "@/lib/state/project-model";
import { createInitialCampaignState } from "@/lib/game/campaign-manager";
import { dummyCampaign } from "@/data/dummy-campaign";
import type { CampaignState } from "@/lib/types/game";
import { linearStory } from "../fixtures/linear-story";
import { freshStore } from "../fixtures/fresh-store";

type Call = { url: string; method: string; body: unknown };
type Reply = Response | Error | ((call: Call) => Response | Error | Promise<Response>);

const calls: Call[] = [];
let replies: Reply[] = [];
let fallback: Reply = () => json(200, {});

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const call = { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const reply = replies.length > 0 ? replies.shift()! : fallback;
      const result = typeof reply === "function" ? await reply(call) : reply;
      if (result instanceof Error) throw result;
      return result;
    })
  );
}

const input = {
  source: { file_name: "notes.pdf", file_type: "pdf" as const },
  campaign: dummyCampaign,
  stories: { [linearStory.story_id]: linearStory },
};

const state = (marker: string): CampaignState => ({
  ...createInitialCampaignState(dummyCampaign),
  world_state: { [marker]: 1 },
});

async function seedLocal(id: string): Promise<Project> {
  const result = await new IndexedDbRepository().createProject({ ...input, id });
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

function serverCopy(project: Project, extra: Record<string, unknown> = {}) {
  return { ...project, campaign_state: null, materials: null, ...extra };
}

const puts = () => calls.filter((c) => c.method === "PUT");

beforeEach(async () => {
  await freshStore();
  calls.length = 0;
  replies = [];
  fallback = () => json(200, {});
  installFetch();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("HttpRepository reads", () => {
  it("does nothing at construction", () => {
    new HttpRepository();
    expect(calls).toEqual([]);
  });

  it("lists server projects plus local-only ones, newest first", async () => {
    await seedLocal("local_only");
    const summary = { title: "S", genre: "fantasy", source_name: "s.pdf", stories_total: 1, stories_completed: 0 };
    replies = [json(200, [{ id: "on_server", updated_at: 9e15, ...summary }, { id: "broken" }])];
    const list = await new HttpRepository().listProjects();
    expect(list.map((p) => p.id)).toEqual(["on_server", "local_only"]);
  });

  it("lists local projects when the server is unreachable", async () => {
    await seedLocal("p1");
    replies = [new TypeError("offline")];
    expect((await new HttpRepository().listProjects()).map((p) => p.id)).toEqual(["p1"]);
  });

  it.each([
    ["404", () => json(404, { detail: "project not found" })],
    ["a non-OK response", () => json(500, { detail: "boom" })],
    ["a network error", () => new TypeError("offline")],
    ["invalid data", () => json(200, { id: "p1" })],
  ])("loads the local copy on %s", async (_label, reply) => {
    const local = await seedLocal("p1");
    replies = [reply()];
    expect(await new HttpRepository().loadProject("p1")).toEqual(local);
  });

  it("loads from the server, accepting nulls and dropping an invalid campaign_state", async () => {
    const local = await seedLocal("p1");
    const remote = serverCopy(local, { campaign_state: { completed_stories: "not-an-array" }, updated_at: 42 });
    replies = [json(200, remote)];
    const project = await new HttpRepository().loadProject("p1");
    expect(project?.updated_at).toBe(42);
    expect(project?.campaign_state).toBeUndefined();
    expect(project?.materials).toBeUndefined();
    expect(project?.stories).toEqual(local.stories);
  });
});

describe("HttpRepository create and delete", () => {
  it("writes locally first, then POSTs the same record", async () => {
    replies = [(call) => json(201, call.body)];
    const result = await new HttpRepository().createProject(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls[0]).toMatchObject({ method: "POST", url: "/api/v1/projects" });
    expect(calls[0].body).toEqual(result.value);
    expect(await new IndexedDbRepository().loadProject(result.value.id)).toEqual(result.value);
  });

  it("counts a network error as saved (kept locally)", async () => {
    replies = [new TypeError("offline")];
    const result = await new HttpRepository().createProject(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(await new IndexedDbRepository().loadProject(result.value.id)).not.toBeNull();
  });

  it("deletes the local copy on 409", async () => {
    replies = [json(409, { detail: "project id already in use" })];
    const result = await new HttpRepository().createProject({ ...input, id: "taken" });
    expect(result).toEqual({ ok: false, message: HTTP_MESSAGES.idTaken });
    expect(await new IndexedDbRepository().loadProject("taken")).toBeNull();
  });

  it("reports other server refusals and keeps the local copy", async () => {
    replies = [json(422, { detail: "project limit reached" })];
    const result = await new HttpRepository().createProject({ ...input, id: "p1" });
    expect(result).toEqual({ ok: false, message: HTTP_MESSAGES.serverRejected });
    expect(await new IndexedDbRepository().loadProject("p1")).not.toBeNull();
  });

  it("deletes locally first, then on the server, even when the server is unreachable", async () => {
    await seedLocal("p1");
    replies = [new TypeError("offline")];
    await new HttpRepository().deleteProject("p1");
    expect(await new IndexedDbRepository().loadProject("p1")).toBeNull();
    expect(calls).toMatchObject([{ method: "DELETE", url: "/api/v1/projects/p1" }]);
  });
});

describe("HttpRepository state saves", () => {
  it("saves locally at once and coalesces rapid saves into one PUT after the debounce", async () => {
    await seedLocal("p1");
    const repo = new HttpRepository();
    for (const marker of ["a", "b", "c"]) {
      expect(await repo.saveCampaignState("p1", state(marker), 1000)).toEqual({ ok: true, value: undefined });
    }
    expect((await new IndexedDbRepository().loadProject("p1"))?.campaign_state).toEqual(state("c"));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);
    expect(puts()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(puts()).toHaveLength(1);
    expect(puts()[0]).toMatchObject({
      url: "/api/v1/projects/p1/state",
      body: { campaign_state: state("c"), updated_at: 1000 },
    });
  });

  it("stamps the local and the server copy with the same updated_at", async () => {
    await seedLocal("p1");
    await new HttpRepository().saveCampaignState("p1", state("a"));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    const local = await new IndexedDbRepository().loadProject("p1");
    expect((puts()[0].body as { updated_at: number }).updated_at).toBe(local?.updated_at);
  });

  it("sends saves in order, one at a time, and sends a state that arrived mid-flight", async () => {
    await seedLocal("p1");
    const repo = new HttpRepository();
    let open = 0;
    let maxOpen = 0;
    let release!: () => void;
    replies = [
      () =>
        new Promise<Response>((resolve) => {
          open++;
          maxOpen = Math.max(maxOpen, open);
          release = () => {
            open--;
            resolve(json(200, { updated_at: 1 }));
          };
        }),
    ];
    await repo.saveCampaignState("p1", state("first"), 1);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await repo.saveCampaignState("p1", state("second"), 2);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS); // fires while the first PUT is still open
    expect(puts()).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(puts().map((c) => (c.body as { updated_at: number }).updated_at)).toEqual([1, 2]);
    expect(maxOpen).toBe(1);
  });

  it("keeps states for different projects and sends both", async () => {
    await seedLocal("p1");
    await seedLocal("p2");
    const repo = new HttpRepository();
    await repo.saveCampaignState("p1", state("a"), 1);
    await repo.saveCampaignState("p2", state("b"), 2);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(puts().map((c) => c.url)).toEqual(["/api/v1/projects/p1/state", "/api/v1/projects/p2/state"]);
  });

  it.each([
    ["a server error", () => json(500, { detail: "boom" }), HTTP_MESSAGES.saveFailed],
    ["a network error", () => new TypeError("offline"), HTTP_MESSAGES.offline],
  ])("retries %s with a doubling delay capped at 60 s", async (_label, failure, message) => {
    await seedLocal("p1");
    const repo = new HttpRepository();
    const errors: Array<string | null> = [];
    repo.onSaveError((m) => errors.push(m));
    fallback = failure;
    await repo.saveCampaignState("p1", state("a"), 1);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(puts()).toHaveLength(1);

    const expected = [INITIAL_RETRY_MS, 10_000, 20_000, 40_000, MAX_RETRY_MS, MAX_RETRY_MS];
    for (const delay of expected) {
      const before = puts().length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(puts()).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(puts()).toHaveLength(before + 1);
    }
    expect(errors.every((m) => m === message)).toBe(true);

    fallback = () => json(200, { updated_at: 1 });
    await vi.advanceTimersByTimeAsync(MAX_RETRY_MS);
    expect(errors.at(-1)).toBeNull();
    const sent = puts().length;
    await vi.advanceTimersByTimeAsync(MAX_RETRY_MS * 2);
    expect(puts()).toHaveLength(sent); // nothing left to send
  });

  it("waits for Retry-After on 429", async () => {
    await seedLocal("p1");
    const repo = new HttpRepository();
    const errors: Array<string | null> = [];
    repo.onSaveError((m) => errors.push(m));
    replies = [json(429, { detail: "rate limit exceeded" }, { "Retry-After": "10" })];
    await repo.saveCampaignState("p1", state("a"), 1);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(errors).toEqual([HTTP_MESSAGES.busy]);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(puts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(puts()).toHaveLength(2);
  });

  it.each([
    [409, HTTP_MESSAGES.stale],
    [404, HTTP_MESSAGES.notOnServer],
  ])("drops the pending state on %s and reports it", async (status, message) => {
    await seedLocal("p1");
    const repo = new HttpRepository();
    const errors: Array<string | null> = [];
    repo.onSaveError((m) => errors.push(m));
    replies = [json(status, { detail: "x", stored_updated_at: 5 })];
    await repo.saveCampaignState("p1", state("a"), 1);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(MAX_RETRY_MS * 3);
    expect(puts()).toHaveLength(1);
    expect(errors).toEqual([message]);
  });

  it("returns the local failure and sends nothing when the project is not saved locally", async () => {
    const result = await new HttpRepository().saveCampaignState("missing", state("a"));
    expect(result.ok).toBe(false);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(puts()).toHaveLength(0);
  });

  it("stops reporting after unsubscribe", async () => {
    await seedLocal("p1");
    const repo = new HttpRepository();
    const errors: Array<string | null> = [];
    const unsubscribe = repo.onSaveError((m) => errors.push(m));
    unsubscribe();
    replies = [json(500, {})];
    await repo.saveCampaignState("p1", state("a"), 1);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(errors).toEqual([]);
  });
});
