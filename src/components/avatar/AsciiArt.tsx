/**
 * AsciiArt — ASCII art in a monospace block at line-height 1, so the
 * character grid keeps the proportions the converter assumed
 * (MONO_CELL_ASPECT).
 */

type AsciiArtProps = {
  art: string;
  /** Font size in px; each row is this tall. */
  size: number;
  label: string;
  color?: string;
  className?: string;
};

export function AsciiArt({ art, size, label, color = "var(--accent-gold)", className }: AsciiArtProps) {
  return (
    <pre
      role="img"
      aria-label={label}
      className={className}
      style={{
        margin: 0,
        fontFamily: "var(--font-mono), monospace",
        fontSize: size,
        lineHeight: 1,
        whiteSpace: "pre",
        color,
        userSelect: "none",
      }}
    >
      {art}
    </pre>
  );
}
