/**
 * StoryFailure
 *
 * Displayed when HP reaches 0 and the story enters the failed state.
 * Minimalist gold/black theme with divider lines.
 */

type StoryFailureProps = {
  storyTitle: string;
  /** Retry callback — provided by useStoryPlayer. Resets StoryState only. */
  onRetry: () => void;
};

export function StoryFailure({ storyTitle, onRetry }: StoryFailureProps) {
  return (
    <div
      data-testid="story-failure"
      className="flex flex-col items-center justify-center flex-1 px-4 py-12 text-center"
      role="alert"
      aria-live="assertive"
    >
      <div
        className="w-full max-w-md"
        style={{
          backgroundColor: "var(--background-panel)",
          border: "1px solid var(--danger)",
          borderRadius: "0.5rem",
          overflow: "hidden",
        }}
        role="region"
        aria-label={`Story failed: ${storyTitle}`}
      >
        {/* Top divider */}
        <div className="chat-divider" aria-hidden="true" />

        {/* Status badge */}
        <div className="px-6 py-4 text-center">
          <span
            className="inline-block text-xs font-semibold tracking-widest uppercase px-3 py-1 rounded-full"
            style={{
              backgroundColor: "var(--danger-bg)",
              border: "1px solid var(--danger)",
              color: "var(--danger)",
            }}
          >
            Story Failed
          </span>
        </div>

        {/* Middle divider */}
        <div className="chat-divider" aria-hidden="true" />

        {/* Title */}
        <div className="px-6 py-4">
          <h2
            className="text-lg font-semibold"
            style={{ color: "var(--foreground)" }}
            data-testid="story-failure-title"
          >
            {storyTitle}
          </h2>
        </div>

        {/* Divider */}
        <div className="chat-divider" aria-hidden="true" />

        {/* Message */}
        <div className="px-6 py-4 text-sm leading-6" style={{ color: "var(--foreground-muted)" }}>
          <p>You have run out of HP.</p>
          <p className="mt-2" data-testid="story-failure-hp">
            HP: 0 / 5
          </p>
        </div>

        {/* Divider */}
        <div className="chat-divider" aria-hidden="true" />

        {/* Explanation */}
        <div className="px-6 py-4 text-xs leading-5" style={{ color: "var(--foreground-faint)" }}>
          You can retry from the beginning. Your HP will be restored to 5.
          Progress from earlier stories is preserved.
        </div>

        {/* Divider */}
        <div className="chat-divider" aria-hidden="true" />

        {/* Retry button */}
        <div className="px-6 py-4">
          <button
            data-testid="retry-button"
            onClick={onRetry}
            className="w-full px-6 py-2.5 rounded text-sm font-medium tracking-wide transition-all"
            style={{
              backgroundColor: "var(--accent-gold)",
              color: "var(--background)",
            }}
          >
            Retry Story
          </button>
        </div>

        {/* Bottom divider */}
        <div className="chat-divider" aria-hidden="true" />
      </div>
    </div>
  );
}