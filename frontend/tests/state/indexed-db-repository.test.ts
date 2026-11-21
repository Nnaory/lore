/**
 * Tests — IndexedDbRepository options added for the HTTP repository (r13 F2)
 *
 * The existing behaviour is covered through the public API in
 * project-store.test.ts. These cases cover only what is new: an explicit id
 * and an explicit updated_at, which let the local and the server copy match.
 *
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it } from "vitest";
import { IndexedDbRepository } from "@/lib/state/indexed-db-repository";
import { createInitialCampaignState } from "@/lib/game/campaign-manager";
import { dummyCampaign } from "@/data/dummy-campaign";
import { linearStory } from "../fixtures/linear-story";
import { freshStore } from "../fixtures/fresh-store";

const input = {
  source: { file_name: "notes.pdf", file_type: "pdf" as const },
  campaign: dummyCampaign,
  stories: { [linearStory.story_id]: linearStory },
};

describe("IndexedDbRepository", () => {
  beforeEach(freshStore);

  it("keeps an explicit id", async () => {
    const repo = new IndexedDbRepository();
    const result = await repo.createProject({ ...input, id: "p_fixed_id" });
    expect(result.ok && result.value.id).toBe("p_fixed_id");
    expect((await repo.loadProject("p_fixed_id"))?.id).toBe("p_fixed_id");
  });

  it("generates an id when none is given", async () => {
    const repo = new IndexedDbRepository();
    const result = await repo.createProject(input);
    expect(result.ok && result.value.id).toMatch(/.+/);
  });

  it("stores an explicit updatedAt with the state and in the summary", async () => {
    const repo = new IndexedDbRepository();
    const created = await repo.createProject({ ...input, id: "p1" });
    expect(created.ok).toBe(true);
    const state = createInitialCampaignState(dummyCampaign);
    expect(await repo.saveCampaignState("p1", state, 1_234_567)).toEqual({ ok: true, value: undefined });
    expect((await repo.loadProject("p1"))?.updated_at).toBe(1_234_567);
    expect((await repo.listProjects())[0]?.updated_at).toBe(1_234_567);
  });

  it("does nothing at construction (safe during server rendering)", () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      get() {
        throw new Error("touched IndexedDB");
      },
    });
    try {
      expect(() => new IndexedDbRepository()).not.toThrow();
    } finally {
      if (saved) Object.defineProperty(globalThis, "indexedDB", saved);
    }
  });
});
