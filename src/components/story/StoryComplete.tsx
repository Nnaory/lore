/**
 * StoryComplete
 *
 * Displayed when a story reaches its ending and isComplete is true.
 * A glass card with divider lines.
 */

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
};

export function StoryComplete({
  storyTitle,
  onContinue,
  onExit,
  isCampaignComplete,
  onViewResults,
}: StoryCompleteProps) {
  return (
    <div
      data-testid="story-complete-screen"
      className="w-full max-w-md mx-auto px-4 py-6"
    >
      <div
        className="lore-glass lore-glass-panel rounded-panel w-full overflow-hidden"
        style={{ borderColor: "var(--accent-gold)" }}
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
                You have completed the full campaign.
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
          {isCampaignComplete && onViewResults && (
            <button
              data-testid="view-results-button"
              onClick={onViewResults}
              className="lore-pill lore-pill-lg lore-pill-primary w-full"
            >
              See your results →
            </button>
          )}
          {!isCampaignComplete && (
            <button
              data-testid="continue-campaign-button"
              onClick={onContinue}
              className="lore-pill lore-pill-lg lore-pill-primary w-full"
            >
              Continue Campaign →
            </button>
          )}
          <button
            data-testid="exit-button"
            onClick={onExit}
            className="lore-pill lore-pill-lg w-full"
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