/**
 * board-scale.ts — pure geometry for the fixed-size Stage board.
 *
 * Why: the Stage is a fixed 1440x900 (desktop) / 390x844 (phone) board that is
 * scaled as a whole (DESIGN-SYSTEM §4.1, AGENTS.md). The scale, the layout
 * breakpoint and the design<->viewport coordinate mapping live here as pure
 * functions so they can be tested without a DOM. No HP or game rules.
 *
 * All functions return `{ ok: true, ... } | { ok: false, reason }`; none throw.
 */

/** Viewport width (px) at which the desktop layout starts. Equals Tailwind `md`. */
export const DESKTOP_MIN_WIDTH = 768;

export type StageLayout = "desktop" | "phone";

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Design-pixel size of the board per layout. */
export const BOARD_SIZE: Readonly<Record<StageLayout, Size>> = {
  desktop: { width: 1440, height: 900 },
  phone: { width: 390, height: 844 },
} as const;

export type BoardFailure = { ok: false; reason: "invalid_viewport" | "invalid_scale" | "invalid_rect" };

function isPositiveFinite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** Phone when width < 768, desktop when width >= 768. */
export function selectLayout(
  viewportWidth: number,
): { ok: true; layout: StageLayout } | { ok: false; reason: "invalid_viewport" } {
  if (!isFiniteNumber(viewportWidth) || viewportWidth < 0) {
    return { ok: false, reason: "invalid_viewport" };
  }
  return { ok: true, layout: viewportWidth >= DESKTOP_MIN_WIDTH ? "desktop" : "phone" };
}

/** scale = min(vw / W, vh / H) for the board of the given layout. */
export function computeBoardScale(
  viewport: Size,
  layout: StageLayout,
): { ok: true; scale: number } | { ok: false; reason: "invalid_viewport" } {
  if (!viewport || !isPositiveFinite(viewport.width) || !isPositiveFinite(viewport.height)) {
    return { ok: false, reason: "invalid_viewport" };
  }
  const board = BOARD_SIZE[layout];
  if (!board) return { ok: false, reason: "invalid_viewport" };
  const scale = Math.min(viewport.width / board.width, viewport.height / board.height);
  if (!isPositiveFinite(scale)) {
    return { ok: false, reason: "invalid_viewport" };
  }
  return {
    ok: true,
    scale,
  };
}

/** Horizontal offset of the board (top-center origin) inside the viewport. */
function boardLeft(viewport: Size, layout: StageLayout, scale: number): number {
  return (viewport.width - BOARD_SIZE[layout].width * scale) / 2;
}

function validInputs(
  viewport: Size,
  layout: StageLayout,
  scale: number,
): BoardFailure | null {
  if (!viewport || !isFiniteNumber(viewport.width) || !isFiniteNumber(viewport.height)) {
    return { ok: false, reason: "invalid_viewport" };
  }
  if (!BOARD_SIZE[layout] || !isPositiveFinite(scale)) {
    return { ok: false, reason: "invalid_scale" };
  }
  return null;
}

/** Maps a rect in design px to viewport px (board is top-center anchored). */
export function designRectToViewport(
  rect: Rect,
  viewport: Size,
  layout: StageLayout,
  scale: number,
): { ok: true; rect: Rect } | BoardFailure {
  const bad = validInputs(viewport, layout, scale);
  if (bad) return bad;
  if (
    !rect ||
    !isFiniteNumber(rect.x) ||
    !isFiniteNumber(rect.y) ||
    !isFiniteNumber(rect.width) ||
    !isFiniteNumber(rect.height)
  ) {
    return { ok: false, reason: "invalid_rect" };
  }
  const left = boardLeft(viewport, layout, scale);
  return {
    ok: true,
    rect: {
      x: left + rect.x * scale,
      y: rect.y * scale,
      width: rect.width * scale,
      height: rect.height * scale,
    },
  };
}

/** Inverse of {@link designRectToViewport}. */
export function viewportRectToDesign(
  rect: Rect,
  viewport: Size,
  layout: StageLayout,
  scale: number,
): { ok: true; rect: Rect } | BoardFailure {
  const bad = validInputs(viewport, layout, scale);
  if (bad) return bad;
  if (
    !rect ||
    !isFiniteNumber(rect.x) ||
    !isFiniteNumber(rect.y) ||
    !isFiniteNumber(rect.width) ||
    !isFiniteNumber(rect.height)
  ) {
    return { ok: false, reason: "invalid_rect" };
  }
  const left = boardLeft(viewport, layout, scale);
  return {
    ok: true,
    rect: {
      x: (rect.x - left) / scale,
      y: rect.y / scale,
      width: rect.width / scale,
      height: rect.height / scale,
    },
  };
}
