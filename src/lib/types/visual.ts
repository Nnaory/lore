/**
 * Lesson Visual Types
 *
 * A JSON description of the illustration drawn on the stage canvas while a
 * lesson is taught. The AI picks one primitive and fills in the data; the
 * canvas lays it out and animates it, so labels and numbers are always
 * exactly what was written (never hallucinated pixels).
 *
 *   vectors — arrows on a coordinate plane (vectors, displacement, forces)
 *   plot    — line chart through given points (functions, data, trends)
 *   diagram — boxes and arrows: flow (process), tree (hierarchy), cycle
 *   table   — a small grid (truth tables, comparisons, worked values)
 *   formula — an equation with each symbol explained, plus an example
 */

export type Vec2 = [number, number];

/** Colour role of an arrow or series. */
export type VisualTone = "primary" | "secondary" | "result" | "muted";

export type VectorsVisual = {
  kind: "vectors";
  /** Optional view range; the canvas always widens it to fit every arrow. */
  x_range?: Vec2;
  y_range?: Vec2;
  vectors: Array<{ from: Vec2; to: Vec2; label?: string; tone?: VisualTone }>;
  points?: Array<{ at: Vec2; label?: string }>;
  caption?: string;
};

export type PlotVisual = {
  kind: "plot";
  x_label?: string;
  y_label?: string;
  series: Array<{ label?: string; points: Vec2[]; tone?: VisualTone }>;
  caption?: string;
};

export type DiagramLayout = "flow" | "tree" | "cycle";

export type DiagramVisual = {
  kind: "diagram";
  layout: DiagramLayout;
  nodes: Array<{ id: string; label: string; detail?: string }>;
  edges: Array<{ from: string; to: string; label?: string }>;
  caption?: string;
};

export type TableVisual = {
  kind: "table";
  headers: string[];
  rows: string[][];
  /** Zero-based indexes of rows to emphasise. */
  highlight_rows?: number[];
  caption?: string;
};

export type FormulaVisual = {
  kind: "formula";
  expression: string;
  terms: Array<{ symbol: string; meaning: string }>;
  /** A worked example, e.g. "2·(2,1) + 1·(1,2) = (5,4)". */
  example?: string;
  caption?: string;
};

export type LessonVisual = VectorsVisual | PlotVisual | DiagramVisual | TableVisual | FormulaVisual;

export type LessonVisualKind = LessonVisual["kind"];
