/**
 * use-board-metrics.ts — thin hook that feeds the Stage board its layout and scale.
 *
 * Why: the board is a fixed 1440x900 / 390x844 canvas scaled as a whole. The
 * layout comes from `matchMedia('(min-width: 768px)')` (same threshold as
 * Tailwind `md`, so no grey zone at fractional widths) and changes on the
 * media query `change` event. The scale follows `window.innerWidth/Height`,
 * updated in a `requestAnimationFrame` after `resize`. Server snapshot is
 * 1440x900 desktop. The maths lives in `board-scale.ts`; an invalid viewport
 * keeps the last valid scale. No game rules here.
 */

"use client";

import { useState, useSyncExternalStore } from "react";
import {
  BOARD_SIZE,
  DESKTOP_MIN_WIDTH,
  computeBoardScale,
  type Size,
  type StageLayout,
} from "./board-scale";

const DESKTOP_QUERY = `(min-width: ${DESKTOP_MIN_WIDTH}px)`;

const SERVER_VIEWPORT: Size = {
  width: BOARD_SIZE.desktop.width,
  height: BOARD_SIZE.desktop.height,
};

// ---- layout (matchMedia) ---------------------------------------------------

function subscribeLayout(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mql = window.matchMedia(DESKTOP_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getLayoutSnapshot(): StageLayout {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "desktop";
  return window.matchMedia(DESKTOP_QUERY).matches ? "desktop" : "phone";
}

function getLayoutServerSnapshot(): StageLayout {
  return "desktop";
}

// ---- viewport size (resize, applied in rAF) --------------------------------

let cachedViewport: Size = SERVER_VIEWPORT;

function subscribeViewport(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  let frame = 0;
  const onResize = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      onChange();
    });
  };
  window.addEventListener("resize", onResize);
  return () => {
    window.removeEventListener("resize", onResize);
    if (frame) cancelAnimationFrame(frame);
  };
}

/** Same object while the size is unchanged, as `useSyncExternalStore` requires. */
function getViewportSnapshot(): Size {
  if (typeof window === "undefined") return SERVER_VIEWPORT;
  const { innerWidth: width, innerHeight: height } = window;
  if (width !== cachedViewport.width || height !== cachedViewport.height) {
    cachedViewport = { width, height };
  }
  return cachedViewport;
}

function getViewportServerSnapshot(): Size {
  return SERVER_VIEWPORT;
}

export interface BoardMetrics {
  readonly layout: StageLayout;
  readonly scale: number;
  readonly viewport: Size;
}

export function useBoardMetrics(): BoardMetrics {
  const layout = useSyncExternalStore(subscribeLayout, getLayoutSnapshot, getLayoutServerSnapshot);
  const viewport = useSyncExternalStore(
    subscribeViewport,
    getViewportSnapshot,
    getViewportServerSnapshot,
  );

  const computed = computeBoardScale(viewport, layout);
  const [lastValid, setLastValid] = useState(1);
  let scale = lastValid;
  if (computed.ok) {
    scale = computed.scale;
    // Remember the last valid scale (derived state, adjusted during render).
    if (computed.scale !== lastValid) setLastValid(computed.scale);
  }

  return { layout, scale, viewport };
}
