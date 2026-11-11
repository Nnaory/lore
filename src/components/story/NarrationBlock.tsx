/**
 * NarrationBlock
 *
 * Minimalist narration style matching chat bubbles:
 * ┌─────────────────────────────────┐
 * │ NARRATION                       │  ← top divider
 * ├─────────────────────────────────┤
 * │ Environmental prose text        │
 * └─────────────────────────────────┘  ← bottom divider
 */

type NarrationBlockProps = {
  text: string;
};

export function NarrationBlock({ text }: NarrationBlockProps) {
  return (
    <div
      data-testid="narration-block"
      className="w-full max-w-4xl mx-auto"
      style={{ opacity: 0, animation: "fade-in-up 0.3s ease-out forwards" }}
      aria-label="Narration"
    >
      {/* Top divider */}
      <div className="chat-divider" aria-hidden="true" />

      {/* Label */}
      <div className="px-1 py-2" style={{ color: "var(--accent-gold-dim)" }}>
        <span className="text-xs font-semibold tracking-widest uppercase">
          Narration
        </span>
      </div>

      {/* Middle divider */}
      <div className="chat-divider" aria-hidden="true" />

      {/* Narration text */}
      <div className="px-1 py-2 text-base leading-7 italic" style={{ color: "var(--foreground-muted)" }}>
        <p>{text}</p>
      </div>

      {/* Bottom divider */}
      <div className="chat-divider" aria-hidden="true" />
    </div>
  );
}