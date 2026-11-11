/**
 * LearningCard
 *
 * Renders a learning_info content block — an in-world presentation of a
 * learning concept, styled as a discovered document.
 * Minimalist gold/black theme with divider lines.
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
      className="w-full max-w-4xl mx-auto"
      style={{
        backgroundColor: "var(--background-panel)",
        border: "1px solid var(--border)",
        borderLeft: "3px solid var(--accent-gold)",
        borderRadius: "0.5rem",
        overflow: "hidden",
      }}
      role="region"
      aria-label={`Learning: ${title}`}
    >
      {/* Top divider */}
      <div className="chat-divider" aria-hidden="true" />

      {/* Header */}
      <div className="px-4 py-3 flex items-center gap-2">
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

      {/* Divider */}
      <div className="chat-divider" aria-hidden="true" />

      {/* Body */}
      <div className="px-4 py-3">
        <p className="text-sm leading-7" style={{ color: "var(--foreground)" }}>
          {body}
        </p>
      </div>

      {/* Concept tags */}
      {conceptIds.length > 0 && (
        <>
          <div className="chat-divider" aria-hidden="true" />
          <div className="px-4 py-3 flex flex-wrap gap-1">
            {conceptIds.map((id) => (
              <span
                key={id}
                className="text-xs px-2 py-0.5 rounded-full"
                style={{
                  backgroundColor: "var(--background)",
                  color: "var(--foreground-faint)",
                  border: "1px solid var(--border-dim)",
                }}
              >
                {id}
              </span>
            ))}
          </div>
        </>
      )}

      {/* Bottom divider */}
      <div className="chat-divider" aria-hidden="true" />
    </div>
  );
}