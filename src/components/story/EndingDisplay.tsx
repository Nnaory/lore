/**
 * EndingDisplay
 *
 * Renders the story ending — shown when an ending scene is reached.
 * Minimalist gold/black theme with divider lines.
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
  success: { backgroundColor: "rgba(111, 207, 151, 0.1)", borderColor: "#2d6a4a", color: "#6fcf97" },
  failure: { backgroundColor: "rgba(216, 74, 58, 0.1)", borderColor: "#6a2d2d", color: "#eb5757" },
  partial_success: { backgroundColor: "rgba(242, 201, 76, 0.1)", borderColor: "#6a5a2d", color: "#f2c94c" },
};

export function EndingDisplay({ ending }: EndingDisplayProps) {
  return (
    <div
      data-testid="ending-display"
      className="w-full max-w-2xl mx-auto"
      style={{
        backgroundColor: "var(--background-panel)",
        border: "1px solid var(--accent-gold)",
        borderRadius: "0.5rem",
        overflow: "hidden",
      }}
      role="region"
      aria-label={`Story ending: ${ending.title}`}
    >
      {/* Top divider */}
      <div className="chat-divider" aria-hidden="true" />

      {/* Type badge */}
      <div className="px-6 py-4 text-center">
        <span
          data-testid="ending-type-badge"
          className="inline-block text-xs font-semibold tracking-widest uppercase px-3 py-1 rounded-full"
          style={endingTypeStyle[ending.type]}
        >
          {endingTypeLabel[ending.type]}
        </span>
      </div>

      {/* Divider */}
      <div className="chat-divider" aria-hidden="true" />

      {/* Title */}
      <div className="px-6 py-4 text-center">
        <h2
          className="text-xl font-semibold tracking-wide"
          style={{ color: "var(--accent-gold)" }}
        >
          {ending.title}
        </h2>
      </div>

      {/* Divider */}
      <div className="chat-divider" aria-hidden="true" />

      {/* Narration */}
      <div className="px-6 py-4">
        <p
          className="text-base leading-7 italic text-center"
          style={{ color: "var(--foreground-muted)" }}
        >
          {ending.narration}
        </p>
      </div>

      {/* Bottom divider */}
      <div className="chat-divider" aria-hidden="true" />
    </div>
  );
}