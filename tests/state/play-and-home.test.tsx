/**
 * Tests — /play/[projectId] and the saved-stories list
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { PlayProject as PlayPage } from "@/components/play/PlayProject";
import { SavedStories } from "@/components/home/SavedStories";
import { createProject, loadProject } from "@/lib/state/project-store";
import { createInitialCampaignState, completeStory } from "@/lib/game/campaign-manager";
import { saveCampaignState } from "@/lib/state/project-store";
import { dummyCampaign } from "@/data/dummy-campaign";
import { linearStory, linearStory2 } from "../fixtures/linear-story";

const params = { projectId: "" };
vi.mock("next/navigation", () => ({ useParams: () => params }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

function saveDemoProject() {
  const result = createProject({
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

beforeEach(() => window.localStorage.clear());

describe("/play/[projectId]", () => {
  it("opens a new saved campaign straight into its first story", async () => {
    params.projectId = saveDemoProject().id;
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
    const project = saveDemoProject();
    params.projectId = project.id;
    render(<PlayPage />);
    await screen.findByTestId("story-viewer");

    playToStoryComplete();
    act(() => { fireEvent.click(screen.getByTestId("continue-campaign-button")); });

    const saved = loadProject(project.id)?.campaign_state;
    expect(saved?.completed_stories).toEqual(["story_01"]);
    expect(saved?.current_story_id).toBe("story_02");
    expect(saved?.player_knowledge.concept_linear_combination?.status).toBe("demonstrated");
  });

  it("brings a returning player to the lobby with their progress", async () => {
    const project = saveDemoProject();
    saveCampaignState(project.id, completeStory(createInitialCampaignState(dummyCampaign), dummyCampaign, linearStory));
    params.projectId = project.id;
    render(<PlayPage />);

    expect(await screen.findByTestId("campaign-lobby")).toBeTruthy();
    expect(screen.getByTestId("story-badge-story_01").textContent).toBe("Completed");
    expect(screen.getByTestId("lobby-home-link").getAttribute("href")).toBe("/");
  });
});

describe("SavedStories", () => {
  it("renders nothing when no story is saved", () => {
    const { container } = render(<SavedStories />);
    expect(container.innerHTML).toBe("");
  });

  it("lists saved stories with a continue link", async () => {
    const project = saveDemoProject();
    render(<SavedStories />);
    expect((await screen.findByTestId(`saved-story-${project.id}`)).textContent).toContain(dummyCampaign.title);
    expect(screen.getByTestId(`continue-${project.id}`).getAttribute("href")).toBe(`/play/${project.id}`);
  });

  it("deletes only after confirming", async () => {
    const project = saveDemoProject();
    render(<SavedStories />);
    fireEvent.click(await screen.findByTestId(`delete-${project.id}`));
    expect(loadProject(project.id)).not.toBeNull(); // first click only asks
    fireEvent.click(screen.getByTestId(`confirm-delete-${project.id}`));
    expect(loadProject(project.id)).toBeNull();
    expect(screen.queryByTestId("saved-stories")).toBeNull();
  });
});
