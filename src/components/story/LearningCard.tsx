/**
 * LearningCard
 *
 * Renders a learning_info content block — an in-world presentation of a
 * learning concept, styled as a document or archival entry the player
 * "discovers" within the story.
 *
 * Visually distinct from both narration and dialogue to signal that this
 * is educational content worth noting.
 */

type LearningCardProps = {
  title: string;
  body: string;
  conceptIds: string[];
};

export function LearningCard({ title, body, conceptIds }: LearningCardProps) {
  return (
    <div
      data-testid="learning-card"
      className="rounded-lg p-4 my-2"
      style={{
        backgroundColor: "var(--background-surface)",
        borderWidth: "1px",
        borderStyle: "solid",
        borderColor: "var(--accent-gold)",
        borderLeftWidth: "3px",
      }}
      role="region"
      aria-label={`Learning: ${title}`}
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        {/* Small decorative square accent */}
        <span
          className="inline-block w-2 h-2 rounded-sm flex-shrink-0"
          style={{ backgroundColor: "var(--accent-gold)" }}
          aria-hidden="true"
        />
        <h3
          className="text-xs font-semibold tracking-widest uppercase"
          style={{ color: "var(--accent-gold)" }}
        >
          {title}
        </h3>
      </div>

      {/* Body */}
      <p
        className="text-sm leading-7"
        style={{ color: "var(--foreground)" }}
      >
        {body}
      </p>

      {/* Concept tags — for context/debugging; subtle */}
      {conceptIds.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {conceptIds.map((id) => (
            <span
              key={id}
              className="text-xs px-2 py-0.5 rounded-full"
              style={{
                backgroundColor: "var(--background-panel)",
                color: "var(--foreground-faint)",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "var(--border-subtle)",
              }}
            >
              {id}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
