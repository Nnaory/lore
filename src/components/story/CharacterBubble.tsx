/**
 * CharacterBubble
 *
 * Renders a single dialogue content block as a chat bubble.
 * NPC characters appear on the left, the MC on the right.
 *
 * Design follows DESIGN.md §5.4:
 *   - Name + expression shown above the bubble.
 *   - NPC on left, MC on right.
 *   - Simple rounded border, no heavy decoration.
 */

import type { Character } from "@/lib/types/campaign";
import type { CharacterIndex } from "@/lib/story/story-player";

type CharacterBubbleProps = {
  characterId: string;
  expressionKey: string;
  text: string;
  characterIndex: CharacterIndex;
  /** True when this dialogue belongs to the MC (player character). */
  isMC?: boolean;
};

export function CharacterBubble({
  characterId,
  expressionKey,
  text,
  characterIndex,
  isMC = false,
}: CharacterBubbleProps) {
  const character: Character | undefined = characterIndex.get(characterId);
  const name = character?.name ?? characterId;
  const expression =
    character?.expressions[expressionKey] ?? `(${expressionKey})`;

  const isRight = isMC;

  return (
    <div
      data-testid="character-bubble"
      data-character-id={characterId}
      className={`flex flex-col gap-1 max-w-[82%] ${isRight ? "items-end self-end" : "items-start self-start"}`}
    >
      {/* Name + expression label */}
      <div
        className={`flex items-center gap-2 px-1 ${isRight ? "flex-row-reverse" : "flex-row"}`}
      >
        <span
          data-testid="character-name"
          className="text-xs font-semibold tracking-wide uppercase"
          style={{ color: "var(--accent-gold)" }}
        >
          {name}
        </span>
        <span
          data-testid="character-expression"
          className="text-xs font-mono"
          style={{ color: "var(--foreground-muted)" }}
          aria-label={`Expression: ${expressionKey}`}
        >
          {expression}
        </span>
      </div>

      {/* Bubble */}
      <div
        className={`rounded-lg px-4 py-3 text-sm leading-6 ${
          isRight
            ? "rounded-tr-sm text-right"
            : "rounded-tl-sm"
        }`}
        style={{
          backgroundColor: isRight
            ? "var(--color-muted-burgundy)"
            : "var(--background-panel)",
          borderWidth: "1px",
          borderStyle: "solid",
          borderColor: isRight ? "var(--accent)" : "var(--border)",
          color: "var(--foreground)",
        }}
      >
        <p>{text}</p>
      </div>
    </div>
  );
}
