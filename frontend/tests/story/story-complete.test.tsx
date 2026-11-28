/**
 * @vitest-environment jsdom
 *
 * story-complete.test.tsx — StoryComplete component tests (task 13.3).
 *
 * Why: verifies which buttons and messages appear for an incomplete vs
 * completed campaign, along with Kit StatusBadge, accessible region label,
 * and 44px touch targets.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StoryComplete } from "@/components/story/StoryComplete";

afterEach(cleanup);

describe("StoryComplete (task 13.3)", () => {
  it("shows Continue Campaign and Exit Story when the campaign is not complete", () => {
    const onContinue = vi.fn();
    const onExit = vi.fn();
    render(
      <StoryComplete
        storyTitle="The Fading Light"
        onContinue={onContinue}
        onExit={onExit}
        isCampaignComplete={false}
      />
    );

    const panel = screen.getByTestId("story-complete-screen");
    expect(panel.getAttribute("role")).toBe("region");
    expect(panel.getAttribute("aria-label")).toBe("Story complete: The Fading Light");
    expect(panel.textContent).toContain("Story Complete");
    expect(screen.getByTestId("story-complete-title").textContent).toBe("The Fading Light");
    expect(panel.textContent).toContain("The story has ended. Your progress has been recorded.");
    expect(screen.queryByTestId("campaign-complete-message")).toBeNull();
    expect(screen.queryByTestId("view-results-button")).toBeNull();

    const continueBtn = screen.getByTestId("continue-campaign-button");
    expect(continueBtn.textContent).toBe("Continue Campaign →");
    expect(continueBtn.className).toContain("min-h-[44px]");
    fireEvent.click(continueBtn);
    expect(onContinue).toHaveBeenCalledTimes(1);

    const exitBtn = screen.getByTestId("exit-button");
    expect(exitBtn.textContent).toBe("Exit Story");
    fireEvent.click(exitBtn);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("shows See your results and Return to Lobby when the campaign is complete", () => {
    const onContinue = vi.fn();
    const onExit = vi.fn();
    const onViewResults = vi.fn();
    render(
      <StoryComplete
        storyTitle="The Outer Ward"
        onContinue={onContinue}
        onExit={onExit}
        isCampaignComplete={true}
        onViewResults={onViewResults}
      />
    );

    const panel = screen.getByTestId("story-complete-screen");
    expect(panel.getAttribute("aria-label")).toBe("Campaign complete: The Outer Ward");
    expect(panel.textContent).toContain("Campaign Complete");
    expect(screen.getByTestId("campaign-complete-message").textContent).toBe(
      "You have completed the full campaign."
    );
    expect(screen.queryByTestId("continue-campaign-button")).toBeNull();

    const resultsBtn = screen.getByTestId("view-results-button");
    expect(resultsBtn.textContent).toBe("See your results →");
    fireEvent.click(resultsBtn);
    expect(onViewResults).toHaveBeenCalledTimes(1);

    const exitBtn = screen.getByTestId("exit-button");
    expect(exitBtn.textContent).toBe("Return to Lobby");
    fireEvent.click(exitBtn);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("shows Replay Story when isCampaignComplete and onReplay are passed", () => {
    const onReplay = vi.fn();
    render(
      <StoryComplete
        storyTitle="The Outer Ward"
        onContinue={vi.fn()}
        onExit={vi.fn()}
        isCampaignComplete={true}
        onViewResults={vi.fn()}
        onReplay={onReplay}
      />
    );
    const replayBtn = screen.getByTestId("replay-story-button");
    expect(replayBtn.textContent).toBe("Replay Story");
    expect(replayBtn.className).toContain("min-h-[44px]");
    fireEvent.click(replayBtn);
    expect(onReplay).toHaveBeenCalledTimes(1);
  });
});
