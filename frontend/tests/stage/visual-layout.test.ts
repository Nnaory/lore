import { describe, expect, it } from "vitest";
import {
  boxEdgePoint,
  layoutDiagram,
  niceStep,
  plotProjection,
  ticks,
  labelBox,
  placePointLabels,
  placeVectorLabels,
  segmentIntersectsBox,
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

describe("segmentIntersectsBox", () => {
  const box: Area = { x: 10, y: 10, w: 20, h: 10 };

  it("detects a segment that crosses, ends inside, or lies inside the box", () => {
    expect(segmentIntersectsBox({ x: 0, y: 15 }, { x: 40, y: 15 }, box)).toBe(true);
    expect(segmentIntersectsBox({ x: 0, y: 0 }, { x: 15, y: 15 }, box)).toBe(true);
    expect(segmentIntersectsBox({ x: 12, y: 12 }, { x: 14, y: 14 }, box)).toBe(true);
  });

  it("is false for a segment that passes beside or stops short", () => {
    expect(segmentIntersectsBox({ x: 0, y: 0 }, { x: 40, y: 0 }, box)).toBe(false);
    expect(segmentIntersectsBox({ x: 0, y: 15 }, { x: 8, y: 15 }, box)).toBe(false);
    expect(segmentIntersectsBox({ x: 0, y: 60 }, { x: 60, y: 0 }, box)).toBe(false);
  });
});

describe("placeVectorLabels", () => {
  const FONT = 22;
  const BOUNDS: Area = { x: 0, y: 0, w: 1280, h: 720 };

  /** The lesson from the demo: 2×A, then 1×B tip to tail, and their sum from the origin. */
  const visual: VectorsVisual = {
    kind: "vectors",
    vectors: [
      { from: [0, 0], to: [4, 2], label: "2 × A = (2, 1)" },
      { from: [4, 2], to: [5, 4], label: "1 × B" },
      { from: [0, 0], to: [5, 4], label: "(5, 4)", tone: "result" },
    ],
  };
  const { toPx } = vectorsProjection(visual, { x: 90, y: 150, w: 1100, h: 470 });
  const specs = visual.vectors.map((v) => ({ from: toPx(v.from), to: toPx(v.to), label: v.label }));

  it("keeps every label clear of every arrow, including the sum that used to cross one", () => {
    const at = placeVectorLabels(specs, { fontSize: FONT, bounds: BOUNDS });
    specs.forEach((spec, i) => {
      const where = at[i];
      expect(where).not.toBeNull();
      const box = labelBox(spec.label!, where!, FONT);
      for (const s of specs) expect(segmentIntersectsBox(s.from, s.to, box)).toBe(false);
    });
  });

  it("keeps the labels apart from each other and inside the canvas", () => {
    const at = placeVectorLabels(specs, { fontSize: FONT, bounds: BOUNDS });
    const boxes = specs.map((s, i) => labelBox(s.label!, at[i]!, FONT));
    for (let i = 0; i < boxes.length; i++) {
      expect(boxes[i].x).toBeGreaterThanOrEqual(0);
      expect(boxes[i].x + boxes[i].w).toBeLessThanOrEqual(BOUNDS.w);
      for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i], boxes[j])).toBe(false);
    }
  });

  it("returns null for a vector without a label and is deterministic", () => {
    const unlabeled = [{ from: { x: 0, y: 0 }, to: { x: 100, y: 0 } }, ...specs];
    const first = placeVectorLabels(unlabeled, { fontSize: FONT });
    expect(first[0]).toBeNull();
    expect(placeVectorLabels(unlabeled, { fontSize: FONT })).toEqual(first);
  });

  it("puts a label beside a horizontal arrow, near its midpoint, on its left (above)", () => {
    const [at] = placeVectorLabels([{ from: { x: 0, y: 200 }, to: { x: 400, y: 200 }, label: "v" }], {
      fontSize: FONT,
    });
    expect(at!.x).toBeCloseTo(200, 5);
    expect(at!.y).toBeLessThan(200);
  });

  it("moves a long label off a vertical arrow instead of centring it on the line", () => {
    const from = { x: 300, y: 500 };
    const to = { x: 300, y: 100 };
    const [at] = placeVectorLabels([{ from, to, label: "a rather long label" }], { fontSize: FONT });
    const box = labelBox("a rather long label", at!, FONT);
    expect(segmentIntersectsBox(from, to, box)).toBe(false);
  });

  it("still answers when no spot is free (the least bad one), without throwing", () => {
    const crowded = Array.from({ length: 12 }, (_, i) => ({
      from: { x: 0, y: i * 6 },
      to: { x: 300, y: i * 6 },
      label: i === 0 ? "squeezed" : undefined,
    }));
    const [at] = placeVectorLabels(crowded, { fontSize: FONT, bounds: { x: 0, y: 0, w: 300, h: 70 } });
    expect(at).not.toBeNull();
    expect(Number.isFinite(at!.x) && Number.isFinite(at!.y)).toBe(true);
  });

  it("avoids axis tick obstacles inside the given area", () => {
    const vector = [{ from: { x: 200, y: 300 }, to: { x: 500, y: 300 }, label: "Crystal A (2, 1)" }];
    const preferredBox = labelBox(vector[0].label, { x: 350, y: 277 }, FONT);
    const tickObstacle: Area = { x: preferredBox.x + 10, y: preferredBox.y, w: 30, h: 24 };
    const [at] = placeVectorLabels(vector, { fontSize: FONT, bounds: AREA, obstacles: [tickObstacle] });
    const placedBox = labelBox(vector[0].label, at!, FONT);
    expect(overlaps(placedBox, tickObstacle)).toBe(false);
    expect(inside({ x: placedBox.x, y: placedBox.y }, AREA)).toBe(true);
  });

  it("keeps fanning vector labels on their own arrow's side rather than jumping across neighbors", () => {
    const fan: VectorsVisual = {
      kind: "vectors",
      vectors: [
        { from: [0, 0], to: [2, 1], label: "Crystal A (2, 1)" },
        { from: [0, 0], to: [1, 2], label: "Crystal B (1, 2)" },
        { from: [0, 0], to: [5, 4], label: "target (5, 4)" },
      ],
    };
    const area: Area = { x: 90, y: 90, w: 1100, h: 400 };
    const { toPx } = vectorsProjection(fan, area);
    const fanSpecs = fan.vectors.map((v) => ({ from: toPx(v.from), to: toPx(v.to), label: v.label }));
    const labels = placeVectorLabels(fanSpecs, { fontSize: FONT, bounds: area });
    // Crystal B (to=[1,2]) has smaller x than Crystal A (to=[2,1]), so its label must stay left of Crystal A.
    expect(labels[1]!.x).toBeLessThan(labels[0]!.x);
  });
});

describe("placePointLabels", () => {
  const FONT = 20;
  const AREA_PUZZLE: Area = { x: 90, y: 90, w: 1100, h: 400 };
  const visual: VectorsVisual = {
    kind: "vectors",
    vectors: [
      { from: [0, 0], to: [4, 2], label: "2 × A" },
      { from: [4, 2], to: [5, 4], label: "1 × B" },
    ],
    points: [
      { at: [2, 1], label: "A = (2, 1)" },
      { at: [4, 2], label: "(4, 2)" },
      { at: [5, 4], label: "(5, 4)" },
    ],
  };

  it("keeps point labels clear of arrows, vector labels, ticks and area bounds", () => {
    const { toPx } = vectorsProjection(visual, AREA_PUZZLE);
    const vecSpecs = visual.vectors.map((v) => ({ from: toPx(v.from), to: toPx(v.to), label: v.label }));
    const vecAt = placeVectorLabels(vecSpecs, { fontSize: 22, bounds: AREA_PUZZLE });
    const vecBoxes = vecSpecs.flatMap((s, i) => (s.label && vecAt[i] ? [labelBox(s.label, vecAt[i]!, 22)] : []));
    const ptSpecs = visual.points!.map((p) => ({ at: toPx(p.at), label: p.label }));
    const ptAt = placePointLabels(ptSpecs, {
      fontSize: FONT,
      bounds: AREA_PUZZLE,
      obstacles: vecBoxes,
      segments: vecSpecs,
    });

    const placedBoxes = ptSpecs.map((pt, i) => {
      expect(ptAt[i]).not.toBeNull();
      return labelBox(pt.label!, ptAt[i]!, FONT);
    });
    for (let i = 0; i < placedBoxes.length; i++) {
      const box = placedBoxes[i];
      expect(inside({ x: box.x, y: box.y }, AREA_PUZZLE)).toBe(true);
      expect(inside({ x: box.x + box.w, y: box.y + box.h }, AREA_PUZZLE)).toBe(true);
      for (const s of vecSpecs) expect(segmentIntersectsBox(s.from, s.to, box)).toBe(false);
      for (const vb of vecBoxes) expect(overlaps(box, vb)).toBe(false);
      for (let j = i + 1; j < placedBoxes.length; j++) expect(overlaps(box, placedBoxes[j])).toBe(false);
    }
  });
});
