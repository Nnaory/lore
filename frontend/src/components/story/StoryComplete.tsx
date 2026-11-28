/**
 * StoryComplete — story / campaign completion panel on the Stage (Pola P, design 6.8)
 *
 * Why: displayed when a story reaches its good ending and `isComplete` is true.
 * Uses Kit StatusBadge (`done`), Button (`primary` / `outline`), and token classes
 * with no glass, rounded corners, shadows or non-token colours. Buttons are
 * full-width on phone and 320px wide on desktop.
 */

import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/StatusBadge";

type StoryCompleteProps = {
  storyTitle: string;
  /** Called when the player wants to record completion and advance the campaign. */
  onContinue: () => void;
  /** Called when the player wants to exit without recording completion. */
  onExit: () => void;
  /** True when this was the final story in the campaign. */
  isCampaignComplete: boolean;
  /** Opens the epilogue and learning evaluation (shown once the campaign is complete). */
  onViewResults?: () => void;
  /** Restarts this story from Scene 1 with full HP (shown on completed campaign replays). */
  onReplay?: () => void;
};

export function StoryComplete({
  storyTitle,
  onContinue,
  onExit,
  isCampaignComplete,
  onViewResults,
  onReplay,
}: StoryCompleteProps) {
  return (
    <div
      data-testid="story-complete-screen"
      className="mx-auto flex w-full max-w-[366px] flex-col items-center gap-4 border-2 border-smoke bg-ink p-5 text-center md:max-w-[720px] md:p-6"
      role="region"
      aria-label={`${isCampaignComplete ? "Campaign complete" : "Story complete"}: ${storyTitle}`}
    >
      <StatusBadge variant="done">
        {isCampaignComplete ? "Campaign Complete" : "Story Complete"}
      </StatusBadge>

      <h2
        className="font-display text-[17px] font-bold leading-snug text-cream"
        data-testid="story-complete-title"
      >
        {storyTitle}
      </h2>

      {isCampaignComplete ? (
        <p
          data-testid="campaign-complete-message"
          className="text-[14px] leading-[1.5] text-muted md:text-[15px]"
        >
          You have completed the full campaign.
        </p>
      ) : (
        <p className="text-[14px] leading-[1.5] text-muted md:text-[15px]">
          The story has ended. Your progress has been recorded.
        </p>
      )}

      <div aria-hidden="true" className="h-px w-full bg-smoke" />

      <div className="flex w-full flex-col items-center gap-3">
        {isCampaignComplete && onViewResults && (
          <Button
            variant="primary"
            data-testid="view-results-button"
            onClick={onViewResults}
            className="w-full md:w-[320px]"
          >
            See your results →
          </Button>
        )}
        {!isCampaignComplete && (
          <Button
            variant="primary"
            data-testid="continue-campaign-button"
            onClick={onContinue}
            className="w-full md:w-[320px]"
          >
            Continue Campaign →
          </Button>
        )}
        {isCampaignComplete && onReplay && (
          <Button
            variant="outline"
            data-testid="replay-story-button"
            onClick={onReplay}
            className="w-full md:w-[320px]"
          >
            Replay Story
          </Button>
        )}
        <Button
          variant="outline"
          data-testid="exit-button"
          onClick={onExit}
          className="w-full md:w-[320px]"
        >
          {isCampaignComplete ? "Return to Lobby" : "Exit Story"}
        </Button>
      </div>
    </div>
  );
}
