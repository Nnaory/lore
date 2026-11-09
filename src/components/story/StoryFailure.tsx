/**
 * StoryFailure
 *
 * Displayed when HP reaches 0 and the story enters the failed state.
 * Overlays the story content area and presents a Retry Story action.
 *
 * Design follows DESIGN.md: dark editorial aesthetic, no decorative
 * Halloween imagery, minimal and functional.
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
      className="flex flex-col items-center justify-center flex-1 px-8 py-12 text-center"
      role="alert"
      aria-live="assertive"
    >
      <div
        className="rounded-lg p-8 max-w-sm w-full"
        style={{
          backgroundColor: "var(--background-panel)",
          borderWidth: "1px",
          borderStyle: "solid",
          borderColor: "#6a2d2d",
        }}
      >
        {/* Gold divider */}
        <div className="lore-divider mb-6" />

        {/* Status badge */}
        <span
          className="inline-block text-xs font-semibold tracking-widest uppercase px-3 py-1 rounded-full mb-5"
          style={{
            backgroundColor: "#3a1a1a",
            borderWidth: "1px",
            borderStyle: "solid",
            borderColor: "#6a2d2d",
            color: "#eb5757",
          }}
        >
          Story Failed
        </span>

        {/* Title */}
        <h2
          className="text-base font-semibold mb-3"
          style={{ color: "var(--foreground)" }}
          data-testid="story-failure-title"
        >
          {storyTitle}
        </h2>

        {/* HP reached zero message */}
        <p
          className="text-sm leading-6 mb-2"
          style={{ color: "var(--foreground-muted)" }}
        >
          You have run out of HP.
        </p>
        <p
          className="text-sm leading-6 mb-6"
          data-testid="story-failure-hp"
          style={{ color: "var(--foreground-muted)" }}
        >
          HP: 0 / 5
        </p>

        {/* Explanation */}
        <p
          className="text-xs leading-5 mb-6"
          style={{ color: "var(--foreground-faint)" }}
        >
          You can retry from the beginning. Your HP will be restored to 5.
          Progress from earlier stories is preserved.
        </p>

        {/* Retry button */}
        <button
          data-testid="retry-button"
          onClick={onRetry}
          className="w-full px-6 py-3 rounded text-sm font-medium tracking-wide transition-opacity hover:opacity-80 active:opacity-60"
          style={{
            backgroundColor: "var(--accent)",
            color: "var(--foreground)",
          }}
        >
          Retry Story
        </button>

        {/* Gold divider */}
        <div className="lore-divider mt-6" />
      </div>
    </div>
  );
}
