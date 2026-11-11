/**
 * StoryComplete
 *
 * Displayed when a story reaches its ending and isComplete is true.
 * Minimalist gold/black theme with divider lines.
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
      className="w-full max-w-md mx-auto px-4 py-6"
    >
      <div
        className="w-full"
        style={{
          backgroundColor: "var(--background-panel)",
          border: "1px solid var(--accent-gold)",
          borderRadius: "0.5rem",
          overflow: "hidden",
        }}
        role="region"
        aria-label={`${isCampaignComplete ? "Campaign complete" : "Story complete"}: ${storyTitle}`}
      >
        {/* Top divider */}
        <div className="chat-divider" aria-hidden="true" />

        {/* Status badge */}
        <div className="px-6 py-4 text-center">
          <span
            className="inline-block text-xs font-semibold tracking-widest uppercase px-3 py-1 rounded-full"
            style={{
              backgroundColor: "rgba(111, 207, 151, 0.1)",
              border: "1px solid #2d6a4a",
              color: "#6fcf97",
            }}
          >
            {isCampaignComplete ? "Campaign Complete" : "Story Complete"}
          </span>
        </div>

        {/* Divider */}
        <div className="chat-divider" aria-hidden="true" />

        {/* Title */}
        <div className="px-6 py-4 text-center">
          <h2
            className="text-lg font-semibold"
            style={{ color: "var(--foreground)" }}
            data-testid="story-complete-title"
          >
            {storyTitle}
          </h2>
        </div>

        {/* Divider */}
        <div className="chat-divider" aria-hidden="true" />

        {/* Message */}
        <div className="px-6 py-4 text-sm leading-6 text-center" style={{ color: "var(--foreground-muted)" }}>
          {isCampaignComplete ? (
            <>
              <p data-testid="campaign-complete-message">
                You have completed the full campaign. The Veiled City endures.
              </p>
            </>
          ) : (
            <p>The story has ended. Your progress has been recorded.</p>
          )}
        </div>

        {/* Divider */}
        <div className="chat-divider" aria-hidden="true" />

        {/* Actions */}
        <div className="px-6 py-4 space-y-3">
          {!isCampaignComplete && (
            <button
              data-testid="continue-campaign-button"
              onClick={onContinue}
              className="w-full px-6 py-2.5 rounded text-sm font-medium tracking-wide transition-all"
              style={{
                backgroundColor: "var(--accent-gold)",
                color: "var(--background)",
              }}
            >
              Continue Campaign →
            </button>
          )}
          <button
            data-testid="exit-button"
            onClick={onExit}
            className="w-full px-6 py-2.5 rounded text-sm font-medium tracking-wide transition-all"
            style={{
              backgroundColor: "transparent",
              color: "var(--foreground-faint)",
              border: "1px solid var(--border-dim)",
            }}
          >
            {isCampaignComplete ? "Return to Lobby" : "Exit Story"}
          </button>
        </div>

        {/* Bottom divider */}
        <div className="chat-divider" aria-hidden="true" />
      </div>
    </div>
  );
}