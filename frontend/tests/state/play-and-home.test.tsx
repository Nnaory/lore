/**
 * Tests — /play/[projectId] and the saved-stories list
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { PlayProject as PlayPage, PlayLoading } from "@/components/play/PlayProject";
import { SavedStories } from "@/components/home/SavedStories";
import * as projectStore from "@/lib/state/project-store";
import { createProject, loadProject } from "@/lib/state/project-store";
import { createInitialCampaignState, completeStory } from "@/lib/game/campaign-manager";
import { saveCampaignState } from "@/lib/state/project-store";
import { dummyCampaign } from "@/data/dummy-campaign";
import { linearStory, linearStory2 } from "../fixtures/linear-story";
import { freshStore } from "../fixtures/fresh-store";

const params = { projectId: "" };
vi.mock("next/navigation", () => ({ useParams: () => params }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

async function saveDemoProject() {
  const result = await createProject({
    source: { file_name: "week3.pdf", file_type: "pdf" },
    campaign: dummyCampaign,
    stories: new Map([
      [linearStory.story_id, linearStory],
      [linearStory2.story_id, linearStory2],
    ]),
  });
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

/** Play the current story to its completion panel, answering correctly. */
function playToStoryComplete() {
  for (let i = 0; i < 100; i++) {
    if (screen.queryByTestId("story-complete-screen")) return;
    if (screen.queryByTestId("puzzle-interaction")) {
      act(() => { fireEvent.click(screen.getByTestId("choice-choice_B")); });
      act(() => { fireEvent.click(screen.getByTestId("puzzle-submit")); });
      act(() => { fireEvent.click(screen.getByTestId("puzzle-continue")); });
      continue;
    }
    act(() => { fireEvent.click(screen.getByTestId("story-main")); });
  }
  throw new Error("story never completed");
}

beforeEach(freshStore);

describe("/play/[projectId]", () => {
  it("opens a new saved campaign straight into its first story", async () => {
    params.projectId = (await saveDemoProject()).id;
    render(<PlayPage />);
    expect(await screen.findByTestId("story-viewer")).toBeTruthy();
    expect(screen.getByTestId("sidebar-story-title").textContent).toContain(linearStory.title);
  });

  it("explains when the story is not saved in this browser", async () => {
    params.projectId = "missing";
    render(<PlayPage />);
    expect(await screen.findByTestId("play-missing")).toBeTruthy();
  });

  it("saves progress when a story is completed", async () => {
    const project = await saveDemoProject();
    params.projectId = project.id;
    render(<PlayPage />);
    await screen.findByTestId("story-viewer");

    playToStoryComplete();
    act(() => { fireEvent.click(screen.getByTestId("continue-campaign-button")); });

    // Saving is asynchronous (IndexedDB): wait for it to land.
    await waitFor(async () => {
      expect((await loadProject(project.id))?.campaign_state?.completed_stories).toEqual(["story_01"]);
    });
    const saved = (await loadProject(project.id))?.campaign_state;
    expect(saved?.completed_stories).toEqual(["story_01"]);
    expect(saved?.current_story_id).toBe("story_02");
    expect(saved?.player_knowledge.concept_linear_combination?.status).toBe("demonstrated");
  });

  it("brings a returning player to the lobby with their progress", async () => {
    const project = await saveDemoProject();
    await saveCampaignState(project.id, completeStory(createInitialCampaignState(dummyCampaign), dummyCampaign, linearStory));
    params.projectId = project.id;
    render(<PlayPage />);

    expect(await screen.findByTestId("campaign-lobby")).toBeTruthy();
    expect(screen.getByTestId("story-badge-story_01").textContent).toBe("Completed");
    expect(screen.getByTestId("lobby-home-link").getAttribute("href")).toBe("/");
  });

  it("renders PlayLoading without animation and play-missing with a link home (task 16.3)", async () => {
    const loadingView = render(<PlayLoading />);
    const loading = loadingView.getByTestId("play-loading");
    expect(loading.textContent).toContain("Opening your story…");
    expect(loading.innerHTML).not.toContain("animate-");
    loadingView.unmount();

    params.projectId = "nonexistent-id";
    render(<PlayPage />);
    const missing = await screen.findByTestId("play-missing");
    expect(missing.textContent).toContain("Not found");
    expect(missing.textContent).toContain("This story isn't saved in this browser.");
    const backLink = missing.querySelector('a[href="/"]');
    expect(backLink).toBeTruthy();
    expect(backLink?.textContent).toBe("Back to your stories");
  });

  it("shows play-save-error banner when saving campaign progress fails (task 16.3)", async () => {
    const project = await saveDemoProject();
    params.projectId = project.id;
    const spy = vi
      .spyOn(projectStore, "saveCampaignState")
      .mockResolvedValueOnce({ ok: false, message: "Browser storage is full." });

    render(<PlayPage />);
    await screen.findByTestId("story-viewer");
    playToStoryComplete();
    act(() => {
      fireEvent.click(screen.getByTestId("continue-campaign-button"));
    });

    const banner = await screen.findByTestId("play-save-error");
    expect(banner.getAttribute("role")).toBe("alert");
    expect(banner.textContent).toBe("Browser storage is full.");
    expect(banner.className).toContain("bg-ember");
    expect(banner.className).toContain("text-ink");
    spy.mockRestore();
  });
});

describe("SavedStories", () => {
  it("renders nothing when no story is saved", () => {
    const { container } = render(<SavedStories />);
    expect(container.innerHTML).toBe("");
  });

  it("lists saved stories with a continue link", async () => {
    const project = await saveDemoProject();
    render(<SavedStories />);
    expect((await screen.findByTestId(`saved-story-${project.id}`)).textContent).toContain(dummyCampaign.title);
    expect(screen.getByTestId(`continue-${project.id}`).getAttribute("href")).toBe(`/play/${project.id}`);
  });

  it("deletes only after confirming", async () => {
    const project = await saveDemoProject();
    render(<SavedStories />);
    fireEvent.click(await screen.findByTestId(`delete-${project.id}`));
    expect(await loadProject(project.id)).not.toBeNull(); // first click only asks
    fireEvent.click(screen.getByTestId(`confirm-delete-${project.id}`));
    await waitFor(() => expect(screen.queryByTestId("saved-stories")).toBeNull());
    expect(await loadProject(project.id)).toBeNull();
  });
});
