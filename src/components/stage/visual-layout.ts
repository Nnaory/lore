/**
 * Layout maths for lesson visuals (pure — no React, no Remotion).
 *
 * Everything works in canvas pixels inside a drawing `Area`; the
 * composition only draws what these functions place.
 */

import type { DiagramVisual, LessonVisual, Vec2, VectorsVisual, VisualTone } from "@/lib/types/visual";

export type Area = { x: number; y: number; w: number; h: number };
export type Point = { x: number; y: number };

export const TONE_COLORS: Record<VisualTone, string> = {
  primary: "#e8c547",
  secondary: "#4fb3bf",
  result: "#f08a5d",
  muted: "#8a8070",
};

/** Default tone of the i-th arrow or series when the spec gives none. */
export function toneAt(i: number, tone?: VisualTone): VisualTone {
  return tone ?? (["primary", "secondary", "result", "muted"] as const)[i % 4];
}

// ---------------------------------------------------------------------------
// Axes
// ---------------------------------------------------------------------------

/** A "nice" grid step (1, 2 or 5 × 10ⁿ) giving about `target` divisions. */
export function niceStep(span: number, target = 8): number {
  if (!(span > 0) || !Number.isFinite(span)) return 1;
  const raw = span / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / pow;
  const nice = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10;
  return nice * pow;
}

/** Multiples of `step` within [lo, hi]. */
export function ticks(lo: number, hi: number, step: number): number[] {
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) {
    out.push(Math.abs(v) < step * 1e-9 ? 0 : Number(v.toPrecision(12)));
  }
  return out;
}

export type Bounds = { xMin: number; xMax: number; yMin: number; yMax: number };

function boundsOf(points: Vec2[]): Bounds {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { xMin: Math.min(...xs), xMax: Math.max(...xs), yMin: Math.min(...ys), yMax: Math.max(...ys) };
}

/** Grow bounds by `fraction` of their span (at least `min`) on every side. */
function pad(b: Bounds, fraction: number, min: number): Bounds {
  const px = Math.max((b.xMax - b.xMin) * fraction, min);
  const py = Math.max((b.yMax - b.yMin) * fraction, min);
  return { xMin: b.xMin - px, xMax: b.xMax + px, yMin: b.yMin - py, yMax: b.yMax + py };
}

/** A data → pixel mapping (y grows upwards in data, downwards on screen). */
export type Projection = {
  bounds: Bounds;
  toPx: (p: Vec2) => Point;
  /** The drawn plot rectangle in canvas pixels. */
  frame: Area;
};

function projection(bounds: Bounds, area: Area, equalAspect: boolean): Projection {
  let sx = area.w / (bounds.xMax - bounds.xMin);
  let sy = area.h / (bounds.yMax - bounds.yMin);
  if (equalAspect) sx = sy = Math.min(sx, sy);
  const w = (bounds.xMax - bounds.xMin) * sx;
  const h = (bounds.yMax - bounds.yMin) * sy;
  const frame = { x: area.x + (area.w - w) / 2, y: area.y + (area.h - h) / 2, w, h };
  return {
    bounds,
    frame,
    toPx: ([x, y]) => ({ x: frame.x + (x - bounds.xMin) * sx, y: frame.y + (bounds.yMax - y) * sy }),
  };
}

/**
 * The coordinate plane for a vectors visual: fits every arrow, point and the
 * origin (plus any requested range) with equal x/y scale, so angles and
 * lengths look true.
 */
export function vectorsProjection(visual: VectorsVisual, area: Area): Projection {
  const pts: Vec2[] = [[0, 0]];
  for (const v of visual.vectors) pts.push(v.from, v.to);
  for (const p of visual.points ?? []) pts.push(p.at);
  if (visual.x_range) pts.push([visual.x_range[0], 0], [visual.x_range[1], 0]);
  if (visual.y_range) pts.push([0, visual.y_range[0]], [0, visual.y_range[1]]);
  return projection(pad(boundsOf(pts), 0.1, 0.5), area, true);
}

/** The chart area for a plot visual (independent x/y scales). */
export function plotProjection(points: Vec2[], area: Area): Projection {
  const b = boundsOf(points);
  // A flat series still needs some height.
  if (b.yMax === b.yMin) {
    b.yMin -= 1;
    b.yMax += 1;
  }
  return projection(pad(b, 0.05, 0), area, false);
}

/** Where a vector's label goes: beside its midpoint, on its left-hand side. */
export function vectorLabelPosition(from: Point, to: Point, offset = 18): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: (from.x + to.x) / 2 + (dy / len) * offset, y: (from.y + to.y) / 2 - (dx / len) * offset };
}

// ---------------------------------------------------------------------------
// Diagrams
// ---------------------------------------------------------------------------

export type PlacedNode = DiagramVisual["nodes"][number] & { box: Area; order: number };

/** Nodes in breadth-first order from the roots (nodes nothing points to). */
function levels(visual: DiagramVisual): string[][] {
  const incoming = new Map(visual.nodes.map((n) => [n.id, 0]));
  for (const e of visual.edges) incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
  const roots = visual.nodes.filter((n) => incoming.get(n.id) === 0).map((n) => n.id);
  const level = new Map<string, number>();
  const queue = (roots.length > 0 ? roots : [visual.nodes[0].id]).map((id) => ({ id, depth: 0 }));
  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (level.has(id)) continue;
    level.set(id, depth);
    for (const e of visual.edges) if (e.from === id && !level.has(e.to)) queue.push({ id: e.to, depth: depth + 1 });
  }
  // Unreached nodes (e.g. inside a cycle with no root) go on a final row.
  const deepest = Math.max(0, ...level.values());
  for (const n of visual.nodes) if (!level.has(n.id)) level.set(n.id, deepest + 1);

  const rows: string[][] = [];
  for (const n of visual.nodes) (rows[level.get(n.id)!] ??= []).push(n.id);
  return rows.filter(Boolean);
}

/** Place every node of a diagram inside `area`. */
export function layoutDiagram(visual: DiagramVisual, area: Area): PlacedNode[] {
  const byId = new Map(visual.nodes.map((n) => [n.id, n]));
  const n = visual.nodes.length;
  const place = (id: string, box: Area, order: number): PlacedNode => ({ ...byId.get(id)!, box, order });

  if (visual.layout === "cycle") {
    const w = Math.min(230, area.w / 3.2);
    const h = 92;
    const cx = area.x + area.w / 2;
    const cy = area.y + area.h / 2;
    const rx = (area.w - w) / 2;
    const ry = (area.h - h) / 2;
    return visual.nodes.map((node, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      return place(node.id, { x: cx + rx * Math.cos(angle) - w / 2, y: cy + ry * Math.sin(angle) - h / 2, w, h }, i);
    });
  }

  if (visual.layout === "tree") {
    const rows = levels(visual);
    const h = Math.min(96, (area.h - (rows.length - 1) * 40) / rows.length);
    const rowGap = rows.length > 1 ? (area.h - h * rows.length) / (rows.length - 1) : 0;
    let order = 0;
    return rows.flatMap((row, r) => {
      const gap = 24;
      const w = Math.min(240, (area.w - gap * (row.length - 1)) / row.length);
      const total = w * row.length + gap * (row.length - 1);
      const y = rows.length === 1 ? area.y + (area.h - h) / 2 : area.y + r * (h + rowGap);
      return row.map((id, i) => place(id, { x: area.x + (area.w - total) / 2 + i * (w + gap), y, w, h }, order++));
    });
  }

  // flow: breadth-first order, left to right, wrapping onto a second row.
  const ordered = levels(visual).flat();
  const perRow = n <= 4 ? n : Math.ceil(n / 2);
  const rowCount = Math.ceil(n / perRow);
  const gapX = 70;
  const w = Math.min(240, (area.w - gapX * (perRow - 1)) / perRow);
  const h = 100;
  const gapY = rowCount > 1 ? Math.min(110, area.h - h * rowCount) : 0;
  const top = area.y + (area.h - (h * rowCount + gapY * (rowCount - 1))) / 2;
  return ordered.map((id, i) => {
    const row = Math.floor(i / perRow);
    const inRow = Math.min(perRow, n - row * perRow);
    const total = w * inRow + gapX * (inRow - 1);
    const col = i % perRow;
    return place(id, { x: area.x + (area.w - total) / 2 + col * (w + gapX), y: top + row * (h + gapY), w, h }, i);
  });
}

export function center(box: Area): Point {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

/** Where the line from `box`'s centre towards `toward` leaves the box (plus `margin`). */
export function boxEdgePoint(box: Area, toward: Point, margin = 6): Point {
  const c = center(box);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const t = Math.min(
    dx === 0 ? Infinity : (box.w / 2 + margin) / Math.abs(dx),
    dy === 0 ? Infinity : (box.h / 2 + margin) / Math.abs(dy)
  );
  return { x: c.x + dx * t, y: c.y + dy * t };
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/** Frames to fully draw a visual (the canvas then holds the last frame). */
export function visualDuration(visual: LessonVisual): number {
  const settle = 45;
  switch (visual.kind) {
    case "vectors":
      return 15 + visual.vectors.length * 18 + (visual.points?.length ?? 0) * 6 + settle;
    case "plot":
      return 20 + visual.series.length * 30 + settle;
    case "diagram":
      return 10 + visual.nodes.length * 8 + visual.edges.length * 5 + settle;
    case "table":
      return 15 + visual.rows.length * 6 + settle;
    case "formula":
      return 25 + visual.terms.length * 14 + (visual.example ? 30 : 0) + settle;
  }
}
