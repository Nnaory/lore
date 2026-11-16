import { describe, expect, it } from "vitest";
import {
  boxEdgePoint,
  layoutDiagram,
  niceStep,
  plotProjection,
  ticks,
  toneAt,
  vectorLabelPosition,
  vectorsProjection,
  visualDuration,
  type Area,
} from "@/components/stage/visual-layout";
import type { DiagramVisual, LessonVisual, VectorsVisual } from "@/lib/types/visual";

const AREA: Area = { x: 100, y: 100, w: 1000, h: 500 };

const inside = (p: { x: number; y: number }, a: Area) =>
  p.x >= a.x - 1e-6 && p.x <= a.x + a.w + 1e-6 && p.y >= a.y - 1e-6 && p.y <= a.y + a.h + 1e-6;

const overlaps = (a: Area, b: Area) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("axes", () => {
  it("picks 1-2-5 steps", () => {
    expect(niceStep(10)).toBe(2);
    expect(niceStep(8)).toBe(1);
    expect(niceStep(100)).toBe(20);
    expect(niceStep(0.5)).toBe(0.1);
    expect(niceStep(0)).toBe(1);
  });

  it("lists multiples of the step inside the range without float noise", () => {
    expect(ticks(-1.2, 3.1, 1)).toEqual([-1, 0, 1, 2, 3]);
    expect(ticks(0, 0.3, 0.1)).toEqual([0, 0.1, 0.2, 0.3]);
  });
});

describe("vectorsProjection", () => {
  const visual: VectorsVisual = {
    kind: "vectors",
    vectors: [
      { from: [0, 0], to: [4, 2] },
      { from: [4, 2], to: [5, 4] },
    ],
    points: [{ at: [-1, 1] }],
  };

  it("fits every arrow, point and the origin inside the area", () => {
    const { toPx } = vectorsProjection(visual, AREA);
    for (const p of [[0, 0], [4, 2], [5, 4], [-1, 1]] as const) expect(inside(toPx([p[0], p[1]]), AREA)).toBe(true);
  });

  it("uses the same scale on both axes and puts +y upwards", () => {
    const { toPx } = vectorsProjection(visual, AREA);
    const o = toPx([0, 0]);
    const x1 = toPx([1, 0]);
    const y1 = toPx([0, 1]);
    expect(x1.x - o.x).toBeCloseTo(o.y - y1.y);
    expect(y1.y).toBeLessThan(o.y);
  });

  it("widens the view to a requested range", () => {
    const { bounds } = vectorsProjection({ ...visual, x_range: [-10, 10] }, AREA);
    expect(bounds.xMin).toBeLessThanOrEqual(-10);
    expect(bounds.xMax).toBeGreaterThanOrEqual(10);
  });

  it("puts labels beside the arrow, not on it", () => {
    const at = vectorLabelPosition({ x: 0, y: 0 }, { x: 100, y: 0 }, 20);
    expect(at).toEqual({ x: 50, y: -20 });
  });
});

describe("plotProjection", () => {
  it("keeps all points inside and handles a flat series", () => {
    const pts: [number, number][] = [[0, 3], [5, 3], [10, 3]];
    const { toPx } = plotProjection(pts, AREA);
    for (const p of pts) expect(inside(toPx(p), AREA)).toBe(true);
  });
});

describe("layoutDiagram", () => {
  const nodes = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `n${i}`, label: `Node ${i}` }));
  const chain = (n: number) => Array.from({ length: n - 1 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` }));

  for (const layout of ["flow", "tree", "cycle"] as const) {
    for (const count of [2, 4, 5, 8]) {
      it(`${layout} with ${count} nodes: inside the area, no overlaps`, () => {
        const visual: DiagramVisual = { kind: "diagram", layout, nodes: nodes(count), edges: chain(count) };
        const placed = layoutDiagram(visual, AREA);
        expect(placed).toHaveLength(count);
        for (const p of placed) {
          expect(inside({ x: p.box.x, y: p.box.y }, AREA)).toBe(true);
          expect(inside({ x: p.box.x + p.box.w, y: p.box.y + p.box.h }, AREA)).toBe(true);
        }
        for (let i = 0; i < placed.length; i++) {
          for (let j = i + 1; j < placed.length; j++) expect(overlaps(placed[i].box, placed[j].box)).toBe(false);
        }
      });
    }
  }

  it("orders a flow by its arrows, not by node order", () => {
    const visual: DiagramVisual = {
      kind: "diagram",
      layout: "flow",
      nodes: [{ id: "end", label: "End" }, { id: "start", label: "Start" }, { id: "mid", label: "Mid" }],
      edges: [{ from: "start", to: "mid" }, { from: "mid", to: "end" }],
    };
    const placed = layoutDiagram(visual, AREA);
    const x = (id: string) => placed.find((p) => p.id === id)!.box.x;
    expect(x("start")).toBeLessThan(x("mid"));
    expect(x("mid")).toBeLessThan(x("end"));
  });

  it("puts tree children on lower rows than their parent", () => {
    const visual: DiagramVisual = {
      kind: "diagram",
      layout: "tree",
      nodes: [{ id: "root", label: "Root" }, { id: "a", label: "A" }, { id: "b", label: "B" }],
      edges: [{ from: "root", to: "a" }, { from: "root", to: "b" }],
    };
    const placed = layoutDiagram(visual, AREA);
    const y = (id: string) => placed.find((p) => p.id === id)!.box.y;
    expect(y("a")).toBeGreaterThan(y("root"));
    expect(y("a")).toBe(y("b"));
  });
});

describe("boxEdgePoint", () => {
  it("leaves the box on the side facing the target", () => {
    const box = { x: 0, y: 0, w: 100, h: 50 };
    expect(boxEdgePoint(box, { x: 500, y: 25 }, 0)).toEqual({ x: 100, y: 25 });
    expect(boxEdgePoint(box, { x: 50, y: -300 }, 0)).toEqual({ x: 50, y: 0 });
  });
});

describe("timing and tones", () => {
  it("gives every primitive a finite duration that grows with its content", () => {
    const visuals: LessonVisual[] = [
      { kind: "vectors", vectors: [{ from: [0, 0], to: [1, 1] }] },
      { kind: "plot", series: [{ points: [[0, 0], [1, 1]] }] },
      { kind: "diagram", layout: "flow", nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [] },
      { kind: "table", headers: ["A"], rows: [["1"]] },
      { kind: "formula", expression: "a = b", terms: [{ symbol: "a", meaning: "x" }] },
    ];
    for (const v of visuals) expect(visualDuration(v)).toBeGreaterThan(30);
    expect(visualDuration({ kind: "table", headers: ["A"], rows: Array(8).fill(["1"]) })).toBeGreaterThan(
      visualDuration({ kind: "table", headers: ["A"], rows: [["1"]] })
    );
  });

  it("cycles default tones and respects explicit ones", () => {
    expect([0, 1, 2, 3, 4].map((i) => toneAt(i))).toEqual(["primary", "secondary", "result", "muted", "primary"]);
    expect(toneAt(0, "muted")).toBe("muted");
  });
});
