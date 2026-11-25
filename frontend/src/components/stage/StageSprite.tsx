/**
 * StageSprite — the speaking character as ASCII art (replaces StageCharacter).
 *
 * Why: DESIGN-SYSTEM §4.1/§4.2 draw characters with `renderCharacter` only.
 * Desktop: 12 px cells at (20,99) in the stage panel, in FRONT of the dialogue
 * box (z 20 over 10). Phone: 8 px cells at (6,318) on the board, BEHIND the
 * box (z 5 under 10). The same element stays in the same tree position; only
 * z-index differs per layout. The canvas is `role="img"` named
 * `{name}, {expression}` (Requirement 6.8). The old test hooks are kept
 * (`stage-character`, `data-character-id`, `data-emotion`) and `data-cast-id`
 * and `data-expression` are added. The "other" character (desktop only) is
 * drawn at 40% and gets its own testid so it never matches the active one.
 */

"use client";

import { useMemo, type CSSProperties } from "react";
import { AsciiArt } from "@/components/ascii/AsciiArt";
import { renderCharacter, type CastId, type Expression } from "@/lib/ascii";
import { STAGE_BOXES } from "@/lib/stage/stage-boxes";
import type { StageLayout } from "@/lib/stage/board-scale";
import { useBoardPixelRatio } from "./ScaledBoard";
import type { Emotion } from "./emotion";

export interface StageSpriteProps {
  layout: StageLayout;
  /** Campaign character id (kept in `data-character-id`). */
  characterId: string;
  /** Kit cast member to draw. */
  castId: CastId;
  /** Campaign `Character.name`, used in the accessible name. */
  name: string;
  expression: Expression;
  /** Legacy emotion value, kept in `data-emotion` for existing tests. */
  emotion: Emotion;
  /** `other` = second character on desktop, drawn at 40%. Default `active`. */
  role?: "active" | "other";
  /** Position/z overrides (e.g. the "other" sprite sits in the canvas slot). */
  style?: CSSProperties;
}

/** Desktop slot for the secondary character (centred in the 736x414 CanvasFrame slot, 8px cells = 211x384). */
const OTHER_SPRITE_DESKTOP = {
  x: 694,
  y: 47,
  width: 211,
  height: 384,
  fontPx: 8,
} as const;

export function StageSprite({
  layout,
  characterId,
  castId,
  name,
  expression,
  emotion,
  role = "active",
  style,
}: StageSpriteProps) {
  const other = role === "other";
  const box = other && layout === "desktop" ? OTHER_SPRITE_DESKTOP : STAGE_BOXES[layout].sprite;
  const layers = useMemo(() => renderCharacter(castId, expression), [castId, expression]);
  const pixelRatio = useBoardPixelRatio();
  return (
    <figure
      data-testid={other ? "stage-character-other" : "stage-character"}
      data-character-id={characterId}
      data-cast-id={castId}
      data-expression={expression}
      data-emotion={emotion}
      className="m-0"
      style={{
        position: "absolute",
        left: box.x,
        top: box.y,
        width: box.width,
        height: box.height,
        zIndex: other ? 5 : layout === "desktop" ? 20 : 5,
        opacity: other ? 0.4 : 1,
        pointerEvents: "none",
        ...style,
      }}
    >
      <AsciiArt
        layers={layers}
        fontPx={box.fontPx}
        pixelRatio={pixelRatio}
        label={`${name}, ${expression}`}
      />
    </figure>
  );
}
