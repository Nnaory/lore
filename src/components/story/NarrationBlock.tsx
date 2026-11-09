/**
 * NarrationBlock
 *
 * Renders a single narration content block.
 * Narration has no character name or expression — it is displayed
 * as neutral environmental prose, visually distinct from dialogue.
 */

type NarrationBlockProps = {
  text: string;
};

export function NarrationBlock({ text }: NarrationBlockProps) {
  return (
    <div
      data-testid="narration-block"
      className="px-2 py-1"
      aria-label="Narration"
    >
      <p
        className="text-sm leading-7 text-foreground-muted italic"
        style={{ color: "var(--foreground-muted)" }}
      >
        {text}
      </p>
    </div>
  );
}
