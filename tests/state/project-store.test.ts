/**
 * Tests — project store (localStorage)
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
} from "@/lib/state/project-store";
import { createInitialCampaignState, completeStory } from "@/lib/game/campaign-manager";
import { dummyCampaign } from "@/data/dummy-campaign";
import { linearStory, linearStory2 } from "../fixtures/linear-story";

const stories = new Map([
  [linearStory.story_id, linearStory],
  [linearStory2.story_id, linearStory2],
]);

function create(fileName = "notes.pdf") {
  const result = createProject({ source: { file_name: fileName, file_type: "pdf" }, campaign: dummyCampaign, stories });
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

beforeEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("project store", () => {
  it("saves a project and loads it back intact", () => {
    const project = create();
    const loaded = loadProject(project.id);
    expect(loaded?.campaign).toEqual(dummyCampaign);
    expect(loaded?.stories.story_01).toEqual(linearStory);
    expect(loaded?.campaign_state).toBeUndefined();
    expect([...projectStories(loaded!).keys()]).toEqual(["story_01", "story_02"]);
  });

  it("lists projects newest first with progress", () => {
    const first = create("a.pdf");
    const second = create("b.pdf");
    const state = completeStory(createInitialCampaignState(dummyCampaign), dummyCampaign, linearStory);
    saveCampaignState(first.id, state); // touching it makes it the newest

    const list = listProjects();
    expect(list.map((p) => p.id)).toEqual([first.id, second.id]);
    expect(list[0]).toMatchObject({ title: dummyCampaign.title, source_name: "a.pdf", stories_total: 2, stories_completed: 1 });
  });

  it("saves and restores campaign progress", () => {
    const project = create();
    const state = completeStory(createInitialCampaignState(dummyCampaign), dummyCampaign, linearStory, {
      outcomeDescription: "The Beacon Holds",
    });
    expect(saveCampaignState(project.id, state).ok).toBe(true);
    expect(loadProject(project.id)?.campaign_state).toEqual(state);
  });

  it("deletes a project and its index entry", () => {
    const keep = create("keep.pdf");
    const gone = create("gone.pdf");
    deleteProject(gone.id);
    expect(loadProject(gone.id)).toBeNull();
    expect(listProjects().map((p) => p.id)).toEqual([keep.id]);
  });

  it("returns null for missing or corrupted projects", () => {
    expect(loadProject("nope")).toBeNull();
    const project = create();
    window.localStorage.setItem(`lore:project:${project.id}`, "{not json");
    expect(loadProject(project.id)).toBeNull();
    window.localStorage.setItem(`lore:project:${project.id}`, JSON.stringify({ id: project.id }));
    expect(loadProject(project.id)).toBeNull();
  });

  it("keeps the story but drops invalid progress", () => {
    const project = create();
    const raw = JSON.parse(window.localStorage.getItem(`lore:project:${project.id}`)!);
    raw.campaign_state = { campaign_id: "x" };
    window.localStorage.setItem(`lore:project:${project.id}`, JSON.stringify(raw));
    const loaded = loadProject(project.id);
    expect(loaded?.campaign.title).toBe(dummyCampaign.title);
    expect(loaded?.campaign_state).toBeUndefined();
  });

  it("drops index entries whose project data is gone", () => {
    const project = create();
    window.localStorage.removeItem(`lore:project:${project.id}`);
    expect(listProjects()).toEqual([]);
  });

  it("reports a full storage instead of throwing", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    const result = createProject({ source: { file_name: "x.pdf", file_type: "pdf" }, campaign: dummyCampaign, stories });
    expect(result).toEqual({ ok: false, message: expect.stringContaining("storage is full") });
  });
});
