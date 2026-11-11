/**
 * CharacterBubble
 *
 * Minimalist chat bubble style:
 * ┌─────────────────────────────────┐
 * │ Name (emoji)                    │  ← top divider line
 * ├─────────────────────────────────┤
 * │ Dialog text                     │
 * └─────────────────────────────────┘  ← bottom divider line
 *
 * No background box, no rounded corners, just lines.
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
  isMC: _isMC = false,
}: CharacterBubbleProps) {
  const character: Character | undefined = characterIndex.get(characterId);
  const name = character?.name ?? characterId;
  const expression =
    character?.expressions[expressionKey] ?? `(${expressionKey})`;

  return (
    <div
      data-testid="character-bubble"
      data-character-id={characterId}
      className="w-full max-w-4xl mx-auto"
      style={{ opacity: 0, animation: "fade-in-up 0.3s ease-out forwards" }}
    >
      {/* Top divider */}
      <div className="chat-divider" aria-hidden="true" />

      {/* Name + expression line */}
      <div
        className="flex items-center gap-2 px-1 py-2"
        style={{ color: "var(--accent-gold)" }}
      >
        <span
          data-testid="character-name"
          className="text-sm font-semibold tracking-wide uppercase"
        >
          {name}
        </span>
        <span
          data-testid="character-expression"
          className="text-sm font-mono"
          style={{ color: "var(--foreground-muted)" }}
          aria-label={`Expression: ${expressionKey}`}
        >
          {expression}
        </span>
      </div>

      {/* Middle divider */}
      <div className="chat-divider" aria-hidden="true" />

      {/* Dialog text */}
      <div className="px-1 py-2 text-base leading-7" style={{ color: "var(--foreground)" }}>
        <p>{text}</p>
      </div>

      {/* Bottom divider */}
      <div className="chat-divider" aria-hidden="true" />
    </div>
  );
}