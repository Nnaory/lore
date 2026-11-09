/**
 * EndingDisplay
 *
 * Renders the story ending — shown when an ending scene is reached.
 * Displays the ending title, type badge, and narration.
 */

import type { Ending } from "@/lib/types/scene";

type EndingDisplayProps = {
  ending: Ending;
};

const endingTypeLabel: Record<Ending["type"], string> = {
  success: "Success",
  failure: "Failed",
  partial_success: "Partial Success",
};

const endingTypeStyle: Record<Ending["type"], React.CSSProperties> = {
  success: { backgroundColor: "#1a3a2a", borderColor: "#2d6a4a", color: "#6fcf97" },
  failure: { backgroundColor: "#3a1a1a", borderColor: "#6a2d2d", color: "#eb5757" },
  partial_success: { backgroundColor: "#2a2a1a", borderColor: "#6a5a2d", color: "#f2c94c" },
};

export function EndingDisplay({ ending }: EndingDisplayProps) {
  return (
    <div
      data-testid="ending-display"
      className="rounded-lg p-6 my-4 text-center"
      style={{
        backgroundColor: "var(--background-panel)",
        borderWidth: "1px",
        borderStyle: "solid",
        borderColor: "var(--accent-gold)",
      }}
      role="region"
      aria-label={`Story ending: ${ending.title}`}
    >
      {/* Decorative gold line */}
      <div className="lore-divider mb-5" />

      {/* Type badge */}
      <span
        data-testid="ending-type-badge"
        className="inline-block text-xs font-semibold tracking-widest uppercase px-3 py-1 rounded-full mb-4"
        style={endingTypeStyle[ending.type]}
      >
        {endingTypeLabel[ending.type]}
      </span>

      {/* Title */}
      <h2
        className="text-xl font-semibold tracking-wide mb-4"
        style={{ color: "var(--accent-gold)" }}
      >
        {ending.title}
      </h2>

      {/* Narration */}
      <p
        className="text-sm leading-7 italic max-w-lg mx-auto"
        style={{ color: "var(--foreground-muted)" }}
      >
        {ending.narration}
      </p>

      {/* Decorative gold line */}
      <div className="lore-divider mt-5" />
    </div>
  );
}
