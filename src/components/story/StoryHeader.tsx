/**
 * StoryHeader
 *
 * Sticky header displayed above the story content area.
 * Shows the current location and chapter information.
 * Desktop only — mobile uses navbar.
 */

type StoryHeaderProps = {
  storyTitle: string;
  chapterTitle: string | undefined;
  location: string | undefined;
};

export function StoryHeader({
  storyTitle,
  chapterTitle,
  location,
}: StoryHeaderProps) {
  return (
    <div
      data-testid="story-header"
      className="hidden md:flex-shrink-0 border-b px-6 py-3"
      style={{ borderBottomColor: "var(--border-dim)" }}
    >
      <div className="max-w-4xl mx-auto">
        <h2
          className="text-base font-semibold tracking-wide"
          style={{ color: "var(--foreground)" }}
        >
          {location ?? storyTitle}
        </h2>
        {chapterTitle && (
          <p
            className="text-xs tracking-widest uppercase mt-0.5"
            style={{ color: "var(--foreground-faint)" }}
          >
            {chapterTitle}
          </p>
        )}
      </div>
    </div>
  );
}