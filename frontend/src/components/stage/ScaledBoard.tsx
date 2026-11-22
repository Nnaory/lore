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
 */

"use client";

import { createContext, useContext, type ReactNode } from "react";
import { BOARD_SIZE, type StageLayout } from "@/lib/stage/board-scale";
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
  /** Nodes, or a function receiving the active layout. */
  children: ReactNode | ((layout: StageLayout) => ReactNode);
  /** Flow in the page instead of covering the viewport (Home hero): the root is as wide as its parent and as tall as the scaled board, so content can follow it. No ink fill. */
  inFlow?: boolean;
  /** Extra classes for the root (e.g. the grid lines of the Home hero). */
  rootClassName?: string;
}

export function ScaledBoard({ children, inFlow = false, rootClassName }: ScaledBoardProps) {
  const { layout, scale } = useBoardMetrics();
  const { width, height } = BOARD_SIZE[layout];
  return (
    <div
      data-testid="scaled-board-root"
      className={`${inFlow ? "" : "bg-ink"} ${rootClassName ?? ""}`.trim()}
      style={
        inFlow
          ? { position: "relative", width: "100%", height: height * scale, overflow: "hidden" }
          : { position: "fixed", inset: 0, overflow: "hidden" }
      }
    >
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
        }}
      >
        <BoardScaleContext.Provider value={scale}>
          {typeof children === "function" ? children(layout) : children}
        </BoardScaleContext.Provider>
      </div>
    </div>
  );
}
