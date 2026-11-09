/**
 * StoryHeader
 *
 * Sticky header displayed above the story content area.
 * Shows the current location and chapter information.
 *
 * Follows DESIGN.md §5.3 A — always visible, does not scroll with content.
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
      className="flex-shrink-0 px-6 py-4"
      style={{
        backgroundColor: "var(--background-panel)",
        borderBottomWidth: "1px",
        borderBottomStyle: "solid",
        borderBottomColor: "var(--border)",
      }}
    >
      {/* Location */}
      <h2
        className="text-base font-semibold tracking-wide"
        style={{ color: "var(--foreground)" }}
      >
        {location ?? storyTitle}
      </h2>
      {/* Chapter info */}
      {chapterTitle && (
        <p
          className="text-xs tracking-widest uppercase mt-0.5"
          style={{ color: "var(--foreground-muted)" }}
        >
          {chapterTitle}
        </p>
      )}
    </div>
  );
}
