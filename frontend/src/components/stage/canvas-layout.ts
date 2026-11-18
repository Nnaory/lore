/**
 * Shared geometry for the stage canvas.
 *
 * The Remotion composition (lines, node, box outlines) and the HTML overlay
 * (clickable answer boxes) both use these percentages inside the same 16:9
 * box, so they always line up regardless of the canvas size.
 */

export const CANVAS_WIDTH = 1280;
export const CANVAS_HEIGHT = 720;
export const CANVAS_FPS = 30;

/** Position of the question node at the top of the decision graph (percent). */
export const DECISION_NODE = { x: 50, y: 15 };

export type Box = { x: number; y: number; w: number; h: number };

/** Answer boxes in a row (wireframe layout), in percent of the canvas. */
export function choiceBoxes(count: number): Box[] {
  const n = Math.max(1, Math.min(count, 4));
  const gap = 3;
  const side = 4;
  const w = (100 - side * 2 - gap * (n - 1)) / n;
  return Array.from({ length: n }, (_, i) => ({ x: side + i * (w + gap), y: 42, w, h: 50 }));
}
