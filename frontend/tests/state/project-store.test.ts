/**
 * Tests — project store (IndexedDB, with migration from localStorage)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createProject,
  deleteProject,
  listProjects,
  loadProject,
  projectStories,
  saveCampaignState,
  type Project,
} from "@/lib/state/project-store";
import { PROJECTS, SUMMARIES, transact } from "@/lib/state/idb";
import { createInitialCampaignState, completeStory } from "@/lib/game/campaign-manager";
import { dummyCampaign } from "@/data/dummy-campaign";
import { linearStory, linearStory2 } from "../fixtures/linear-story";
import { freshStore } from "../fixtures/fresh-store";

const stories = new Map([
  [linearStory.story_id, linearStory],
  [linearStory2.story_id, linearStory2],
]);

async function create(fileName = "notes.pdf") {
  const result = await createProject({ source: { file_name: fileName, file_type: "pdf" }, campaign: dummyCampaign, stories });
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

/** Write a raw value straight into an object store (to simulate bad data). */
function putRaw(store: string, value: unknown) {
  return transact<void>([store], "readwrite", (tx) => {
    tx.objectStore(store).put(value);
  });
}

function deleteRaw(store: string, id: string) {
  return transact<void>([store], "readwrite", (tx) => {
    tx.objectStore(store).delete(id);
  });
}

/** A project as an older version saved it in localStorage. */
function legacyProject(id: string, updatedAt = 1_000): Project {
  return {
    id,
    created_at: 500,
    updated_at: updatedAt,
    source: { file_name: `${id}.pdf`, file_type: "pdf" },
    campaign: dummyCampaign,
    stories: Object.fromEntries(stories),
  };
}

function saveLegacy(projects: Project[]) {
  for (const p of projects) window.localStorage.setItem(`lore:project:${p.id}`, JSON.stringify(p));
  window.localStorage.setItem("lore:projects", JSON.stringify(projects.map((p) => ({ id: p.id }))));
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await freshStore();
});

describe("project store", () => {
  it("saves a project and loads it back intact", async () => {
    const project = await create();
    const loaded = await loadProject(project.id);
    expect(loaded?.campaign).toEqual(dummyCampaign);
    expect(loaded?.stories.story_01).toEqual(linearStory);
    expect(loaded?.campaign_state).toBeUndefined();
    expect([...projectStories(loaded!).keys()]).toEqual(["story_01", "story_02"]);
  });

  it("lists projects newest first with progress", async () => {
    const first = await create("a.pdf");
    const second = await create("b.pdf");
    const state = completeStory(createInitialCampaignState(dummyCampaign), dummyCampaign, linearStory);
    await new Promise((r) => setTimeout(r, 2)); // a later timestamp than `second`
    await saveCampaignState(first.id, state); // touching it makes it the newest

    const list = await listProjects();
    expect(list.map((p) => p.id)).toEqual([first.id, second.id]);
    expect(list[0]).toMatchObject({ title: dummyCampaign.title, source_name: "a.pdf", stories_total: 2, stories_completed: 1 });
  });

  it("saves and restores campaign progress", async () => {
    const project = await create();
    const state = completeStory(createInitialCampaignState(dummyCampaign), dummyCampaign, linearStory, {
      outcomeDescription: "The Beacon Holds",
    });
    expect((await saveCampaignState(project.id, state)).ok).toBe(true);
    expect((await loadProject(project.id))?.campaign_state).toEqual(state);
  });

  it("applies back-to-back progress saves in order", async () => {
    const project = await create();
    const one = completeStory(createInitialCampaignState(dummyCampaign), dummyCampaign, linearStory);
    const two = completeStory(one, dummyCampaign, linearStory2);
    // Not awaited one by one: both are in flight at once, like rapid state changes.
    const results = await Promise.all([saveCampaignState(project.id, one), saveCampaignState(project.id, two)]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect((await loadProject(project.id))?.campaign_state?.completed_stories).toEqual(["story_01", "story_02"]);
  });

  it("reports a missing project when saving progress", async () => {
    const result = await saveCampaignState("nope", createInitialCampaignState(dummyCampaign));
    expect(result).toEqual({ ok: false, message: expect.stringContaining("no longer saved") });
  });

  it("deletes a project and its summary", async () => {
    const keep = await create("keep.pdf");
    const gone = await create("gone.pdf");
    await deleteProject(gone.id);
    expect(await loadProject(gone.id)).toBeNull();
    expect((await listProjects()).map((p) => p.id)).toEqual([keep.id]);
  });

  it("returns null for missing or corrupted projects", async () => {
    expect(await loadProject("nope")).toBeNull();
    const project = await create();
    await putRaw(PROJECTS, { id: project.id });
    expect(await loadProject(project.id)).toBeNull();
  });

  it("keeps the story but drops invalid progress", async () => {
    const project = await create();
    await putRaw(PROJECTS, { ...project, campaign_state: { campaign_id: "x" } });
    const loaded = await loadProject(project.id);
    expect(loaded?.campaign.title).toBe(dummyCampaign.title);
    expect(loaded?.campaign_state).toBeUndefined();
  });

  it("drops summaries whose project data is gone, and invalid summaries", async () => {
    const project = await create();
    await deleteRaw(PROJECTS, project.id);
    await putRaw(SUMMARIES, { id: "broken" });
    expect(await listProjects()).toEqual([]);
  });

  it("reports a full storage instead of throwing", async () => {
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    const result = await createProject({ source: { file_name: "x.pdf", file_type: "pdf" }, campaign: dummyCampaign, stories });
    expect(result).toEqual({ ok: false, message: expect.stringContaining("storage is full") });
    vi.restoreAllMocks();
    expect(await listProjects()).toEqual([]); // nothing half-written
  });

  it("is unavailable, not broken, without IndexedDB", async () => {
    Object.defineProperty(globalThis, "indexedDB", { value: undefined, configurable: true, writable: true });
    expect(await listProjects()).toEqual([]);
    expect(await loadProject("x")).toBeNull();
    const result = await createProject({ source: { file_name: "x.pdf", file_type: "pdf" }, campaign: dummyCampaign, stories });
    expect(result).toEqual({ ok: false, message: expect.stringContaining("not available") });
  });
});

describe("moving projects saved by older versions (localStorage)", () => {
  it("moves every valid project into IndexedDB and clears localStorage", async () => {
    saveLegacy([legacyProject("old1", 2_000), legacyProject("old2", 1_000)]);
    const list = await listProjects();
    expect(list.map((p) => p.id)).toEqual(["old1", "old2"]);
    expect((await loadProject("old1"))?.stories.story_01).toEqual(linearStory);
    expect(window.localStorage.getItem("lore:project:old1")).toBeNull();
    expect(window.localStorage.getItem("lore:projects")).toBeNull();
  });

  it("keeps saved progress through the move", async () => {
    const state = completeStory(createInitialCampaignState(dummyCampaign), dummyCampaign, linearStory);
    saveLegacy([{ ...legacyProject("old"), campaign_state: state }]);
    expect((await loadProject("old"))?.campaign_state).toEqual(state);
    expect((await listProjects())[0].stories_completed).toBe(1);
  });

  it("leaves unreadable legacy data alone and does not show it", async () => {
    saveLegacy([legacyProject("good")]);
    window.localStorage.setItem("lore:project:bad", "{not json");
    expect((await listProjects()).map((p) => p.id)).toEqual(["good"]);
    expect(window.localStorage.getItem("lore:project:bad")).toBe("{not json");
    expect(window.localStorage.getItem("lore:project:good")).toBeNull();
  });

  it("never replaces newer IndexedDB progress with an older localStorage copy", async () => {
    // An interrupted earlier move: the project is already in IndexedDB and was played since.
    const newer = legacyProject("same", 5_000);
    await putRaw(PROJECTS, newer);
    saveLegacy([{ ...legacyProject("same", 1_000), source: { file_name: "stale.pdf", file_type: "pdf" } }]);
    expect((await loadProject("same"))?.source.file_name).toBe("same.pdf");
  });

  it("keeps the legacy data when the move fails, and retries later", async () => {
    saveLegacy([legacyProject("old")]);
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await listProjects()).toEqual([]);
    expect(window.localStorage.getItem("lore:project:old")).not.toBeNull();
  });
});
