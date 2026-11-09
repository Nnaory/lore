/**
 * StoryComplete
 *
 * Displayed when a story reaches its ending and isComplete is true.
 * Replaces the passive "— End of Story —" text from earlier milestones.
 *
 * Provides two actions:
 *   - "Continue Campaign" → calls onContinue (triggers campaign progression).
 *   - "Exit Story"        → calls onExit (returns to lobby without completing).
 *
 * When the full campaign is complete, shows a campaign-complete message
 * instead of the continue button.
 */

type StoryCompleteProps = {
  storyTitle: string;
  /** Called when the player wants to record completion and advance the campaign. */
  onContinue: () => void;
  /** Called when the player wants to exit without recording completion. */
  onExit: () => void;
  /** True when this was the final story in the campaign. */
  isCampaignComplete: boolean;
};

export function StoryComplete({
  storyTitle,
  onContinue,
  onExit,
  isCampaignComplete,
}: StoryCompleteProps) {
  return (
    <div
      data-testid="story-complete-screen"
      className="flex flex-col items-center justify-center flex-1 px-8 py-12 text-center"
    >
      <div
        className="rounded-lg p-8 max-w-sm w-full"
        style={{
          backgroundColor: "var(--background-panel)",
          borderWidth: "1px",
          borderStyle: "solid",
          borderColor: "var(--accent-gold)",
        }}
      >
        <div className="lore-divider mb-6" />

        <span
          className="inline-block text-xs font-semibold tracking-widest uppercase px-3 py-1 rounded-full mb-5"
          style={{
            backgroundColor: "#0a1a10",
            borderWidth: "1px",
            borderStyle: "solid",
            borderColor: "#2d6a4a",
            color: "#6fcf97",
          }}
        >
          {isCampaignComplete ? "Campaign Complete" : "Story Complete"}
        </span>

        <h2
          className="text-base font-semibold mb-3"
          style={{ color: "var(--foreground)" }}
          data-testid="story-complete-title"
        >
          {storyTitle}
        </h2>

        {isCampaignComplete ? (
          <>
            <p
              className="text-sm leading-6 mb-6"
              style={{ color: "var(--foreground-muted)" }}
              data-testid="campaign-complete-message"
            >
              You have completed the full campaign. The Veiled City endures.
            </p>
            <button
              data-testid="exit-button"
              onClick={onExit}
              className="w-full px-6 py-3 rounded text-sm font-medium tracking-wide transition-opacity hover:opacity-80 active:opacity-60"
              style={{
                backgroundColor: "var(--accent)",
                color: "var(--foreground)",
              }}
            >
              Return to Lobby
            </button>
          </>
        ) : (
          <>
            <p
              className="text-sm leading-6 mb-6"
              style={{ color: "var(--foreground-muted)" }}
            >
              The story has ended. Your progress has been recorded.
            </p>
            <div className="flex flex-col gap-3">
              <button
                data-testid="continue-campaign-button"
                onClick={onContinue}
                className="w-full px-6 py-3 rounded text-sm font-medium tracking-wide transition-opacity hover:opacity-80 active:opacity-60"
                style={{
                  backgroundColor: "var(--accent)",
                  color: "var(--foreground)",
                }}
              >
                Continue Campaign →
              </button>
              <button
                data-testid="exit-button"
                onClick={onExit}
                className="w-full px-6 py-3 rounded text-sm font-medium tracking-wide transition-opacity hover:opacity-70"
                style={{
                  backgroundColor: "transparent",
                  color: "var(--foreground-faint)",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: "var(--border-subtle)",
                }}
              >
                Exit Story
              </button>
            </div>
          </>
        )}

        <div className="lore-divider mt-6" />
      </div>
    </div>
  );
}
