/**
 * stage-boxes.ts — design-pixel coordinates of every Stage element.
 *
 * Why: DESIGN-SYSTEM §4.1 (desktop) and §4.2 (phone) fix each box to the pixel.
 * Keeping them in one `as const` table lets tests catch accidental drift and
 * keeps components free of magic numbers. Also decides which sprites are drawn.
 * No HP or game rules.
 */

import type { StageLayout } from "./board-scale";

export const STAGE_BOXES = {
  desktop: {
    board: { width: 1440, height: 900 },
    hud: { x: 0, y: 0, width: 1440, height: 64 },
    /** Stage panel, outline 2px smoke. */
    stage: { x: 120, y: 92, width: 1200, height: 675 },
    /** Scene ASCII, in stage-panel coordinates: 167x57 cells at 12 px. */
    scene: { x: 0, y: 0, cols: 167, rows: 57, fontPx: 12 },
    /** CanvasFrame, in stage-panel coordinates. */
    canvas: { x: 432, y: 32, width: 736, height: 414 },
    /** DialogueBox, in stage-panel coordinates. */
    dialogue: { x: 300, y: 470, width: 876, height: 181, nameTagLeft: 96, nameTagTop: -18 },
    /** Active sprite, in stage-panel coordinates: 44x48 cells at 12 px. */
    sprite: { x: 20, y: 99, width: 317, height: 576, cols: 44, rows: 48, fontPx: 12 },
    keyHints: { y: 800, width: 1440 },
  },
  phone: {
    board: { width: 390, height: 844 },
    hud: { x: 0, y: 0, width: 390, height: 56 },
    /** Scene ASCII: 82x99 cells at 8 px, starts below the HUD and is clipped. */
    scene: { x: 0, y: 56, cols: 82, rows: 99, fontPx: 8 },
    canvas: { x: 12, y: 68, width: 366, height: 246 },
    /** Active sprite: 44x48 cells at 8 px, behind the dialogue box. */
    sprite: { x: 6, y: 318, width: 211, height: 384, cols: 44, rows: 48, fontPx: 8 },
    dialogue: { x: 12, y: 582, width: 366, height: 250 },
  },
} as const;

export interface SpritePlacement {
  readonly id: string;
  readonly role: "active" | "other";
  /** 1 for the active speaker, 0.4 for the other character. */
  readonly opacity: number;
}

export type VisibleSprites =
  | { ok: true; sprites: readonly SpritePlacement[] }
  | { ok: false; reason: "no_active_character" };

/**
 * Sprites to draw. Phone: only the active speaker. Desktop: the active
 * speaker plus, when given and different, the other character at 40%.
 */
export function visibleSprites(
  layout: StageLayout,
  activeId: string | null | undefined,
  otherId?: string | null,
): VisibleSprites {
  if (typeof activeId !== "string" || activeId.length === 0) {
    return { ok: false, reason: "no_active_character" };
  }
  const sprites: SpritePlacement[] = [{ id: activeId, role: "active", opacity: 1 }];
  if (
    layout === "desktop" &&
    typeof otherId === "string" &&
    otherId.length > 0 &&
    otherId !== activeId
  ) {
    sprites.push({ id: otherId, role: "other", opacity: 0.4 });
  }
  return { ok: true, sprites };
}
