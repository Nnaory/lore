/**
 * ScaledBoard — fixed-size Stage board scaled as a whole (DESIGN-SYSTEM §4.1).
 *
 * Why: the Stage is a 1440x900 (desktop) / 390x844 (phone) board. Children use
 * absolute design px and are never reflowed; only this wrapper applies
 * `transform: scale(s)` with a top-center origin. Layout and scale come from
 * `useBoardMetrics` (an invalid viewport keeps the last valid scale). The scale
 * is exposed through `BoardScaleContext` so ASCII canvases can raise their
 * pixel ratio. Modals must render outside this board (position: fixed).
 * inFlow (task 5.5, Home hero): the root flows in the page at the scaled board height instead of covering the viewport.
 * The root never paints a fill: the shared animated `PumpkinBackdrop` (root layout, z-index -1) must
 * show through on every screen, so the Stage follows the main page's background edge to edge. Callers
 * pass `rootClassName="lore-grid-lines"` for the faint grid. Only the board (design px) is letterboxed.
 */

"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { BOARD_SIZE, computeBoardScale, type StageLayout } from "@/lib/stage/board-scale";
import { useBoardMetrics } from "@/lib/stage/use-board-metrics";

/** Current board scale (1 outside a ScaledBoard). */
export const BoardScaleContext = createContext<number>(1);

export function useBoardScale(): number {
  return useContext(BoardScaleContext);
}

/** Canvas pixel ratio inside the board: min(devicePixelRatio * scale, 4). */
export function useBoardPixelRatio(): number {
  const scale = useBoardScale();
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  return Math.min(dpr * scale, 4);
}

export interface ScaledBoardProps {
  /** Foreground Stage nodes scaled as a whole inside the fixed-aspect board. */
  children: ReactNode | ((layout: StageLayout) => ReactNode);
  /** Full-viewport backdrop/chrome nodes (StageScene, StageHud) rendered edge-to-edge without letterboxing. */
  fullBleed?: ReactNode | ((layout: StageLayout) => ReactNode);
  /** Flow in the page instead of covering the viewport (Home hero): the root is as wide as its parent and as tall as the scaled board, so content can follow it. */
  inFlow?: boolean;
  /** Extra classes for the root (e.g. `lore-grid-lines` or `lore-grid-bg`). */
  rootClassName?: string;
}

export function ScaledBoard({
  children,
  fullBleed,
  inFlow = false,
  rootClassName,
}: ScaledBoardProps) {
  const { layout, scale: viewportScale, viewport } = useBoardMetrics();
  const rootRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    const el = rootRef.current;
    if (!inFlow || !el) return;
    const measure = () => {
      if (el.clientWidth > 0) setContainerWidth(el.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [inFlow]);

  let scale = viewportScale;
  if (inFlow && containerWidth > 0) {
    const fit = computeBoardScale({ width: containerWidth, height: viewport.height }, layout);
    if (fit.ok) scale = fit.scale;
  }

  const { width, height } = BOARD_SIZE[layout];
  return (
    <div
      ref={rootRef}
      data-testid="scaled-board-root"
      className={rootClassName}
      style={
        inFlow
          ? { position: "relative", width: "100%", height: height * scale, overflow: "hidden" }
          : { position: "fixed", inset: 0, overflow: "hidden" }
      }
    >
      <BoardScaleContext.Provider value={scale}>
        {typeof fullBleed === "function" ? fullBleed(layout) : fullBleed}
        <div
          data-testid="scaled-board"
          data-layout={layout}
          data-scale={scale}
          style={{
            position: "absolute",
            top: 0,
            left: `calc(50% - ${width / 2}px)`,
            width,
            height,
            transform: `scale(${scale})`,
            transformOrigin: "top center",
            zIndex: 10,
          }}
        >
          {typeof children === "function" ? children(layout) : children}
        </div>
      </BoardScaleContext.Provider>
    </div>
  );
}
