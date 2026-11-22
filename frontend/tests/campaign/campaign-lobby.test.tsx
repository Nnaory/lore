/**
 * @vitest-environment jsdom
 *
 * campaign-lobby.test.tsx - CampaignLobby structure (task 9.3).
 *
 * Why: covers the Kit layout (inverted Current row, locked hint, 44px start
 * button, results button, home link). Basic list/lock/start behaviour is
 * already tested in campaign-progression.test.tsx.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CampaignLobby } from "@/components/campaign/CampaignLobby";
import { dummyCampaign, dummyCampaignState } from "@/data/dummy-campaign";

afterEach(cleanup);

function renderLobby(props: Partial<React.ComponentProps<typeof CampaignLobby>> = {}) {
  return render(
    <CampaignLobby
      campaign={dummyCampaign}
      campaignState={dummyCampaignState}
      onStartStory={vi.fn()}
      {...props}
    />,
  );
}

describe("CampaignLobby structure", () => {
  it("inverts the Current row and labels its button Continue", () => {
    renderLobby();
    const row = screen.getByTestId("story-entry-story_01");
    expect(row.getAttribute("data-current")).toBe("true");
    expect(row.className).toContain("bg-cream");
    expect(row.className).toContain("text-ink");
    expect(screen.getByTestId("story-badge-story_01").getAttribute("data-variant")).toBe("current");
    expect(screen.getByTestId("start-story-story_01").textContent).toBe("Continue");
  });

  it("does not invert a locked row and shows the unlock hint", () => {
    renderLobby();
    const row = screen.getByTestId("story-entry-story_02");
    expect(row.getAttribute("data-current")).toBeNull();
    expect(row.className).not.toContain("bg-cream");
    expect(row.textContent).toContain("Complete previous stories to unlock");
    expect(screen.getByTestId("story-badge-story_02").getAttribute("data-variant")).toBe("locked");
  });

  it("gives the start button a 44px minimum touch target", () => {
    renderLobby();
    expect(screen.getByTestId("start-story-story_01").className).toContain("min-h-[44px]");
  });

  it("shows the results button only when onViewResults is set, and calls it", () => {
    const { rerender } = renderLobby();
    expect(screen.queryByTestId("lobby-view-results")).toBeNull();
    const onViewResults = vi.fn();
    rerender(
      <CampaignLobby
        campaign={dummyCampaign}
        campaignState={dummyCampaignState}
        onStartStory={vi.fn()}
        onViewResults={onViewResults}
      />,
    );
    fireEvent.click(screen.getByTestId("lobby-view-results"));
    expect(onViewResults).toHaveBeenCalledTimes(1);
  });

  it("renders the home link only when homeHref is set", () => {
    const { rerender } = renderLobby();
    expect(screen.queryByTestId("lobby-home-link")).toBeNull();
    rerender(
      <CampaignLobby
        campaign={dummyCampaign}
        campaignState={dummyCampaignState}
        onStartStory={vi.fn()}
        homeHref="/stories"
      />,
    );
    expect(screen.getByTestId("lobby-home-link").getAttribute("href")).toBe("/stories");
  });
});
