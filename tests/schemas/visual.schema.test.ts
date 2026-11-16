import { describe, expect, it } from "vitest";
import { LessonVisualSchema } from "@/lib/ai/schemas/visual.schema";
import { LearningContentSchema } from "@/lib/ai/schemas/scene.schema";

const ok = (v: unknown) => LessonVisualSchema.safeParse(v).success;

const vectors = {
  kind: "vectors",
  vectors: [
    { from: [0, 0], to: [2, 1], label: "a" },
    { from: [2, 1], to: [3, 3], label: "b", tone: "secondary" },
  ],
  caption: "Tip to tail.",
};
const diagram = {
  kind: "diagram",
  layout: "flow",
  nodes: [
    { id: "in", label: "Input" },
    { id: "gate", label: "AND gate", detail: "1 only if both are 1" },
    { id: "out", label: "Output" },
  ],
  edges: [
    { from: "in", to: "gate" },
    { from: "gate", to: "out", label: "Q" },
  ],
};
const table = {
  kind: "table",
  headers: ["A", "B", "A·B"],
  rows: [
    ["0", "0", "0"],
    ["0", "1", "0"],
    ["1", "0", "0"],
    ["1", "1", "1"],
  ],
  highlight_rows: [3],
};

describe("LessonVisualSchema", () => {
  it("accepts each primitive", () => {
    expect(ok(vectors)).toBe(true);
    expect(ok({ kind: "plot", x_label: "t", series: [{ label: "v", points: [[0, 0], [1, 2], [2, 4]] }] })).toBe(true);
    expect(ok(diagram)).toBe(true);
    expect(ok(table)).toBe(true);
    expect(ok({ kind: "formula", expression: "F = m · a", terms: [{ symbol: "F", meaning: "force (N)" }], example: "2 kg · 3 m/s² = 6 N" })).toBe(true);
  });

  it("rejects unknown kinds and empty data", () => {
    expect(ok({ kind: "image", url: "x" })).toBe(false);
    expect(ok({ ...vectors, vectors: [] })).toBe(false);
    expect(ok({ kind: "plot", series: [{ points: [[0, 0]] }] })).toBe(false);
  });

  it("rejects zero-length vectors, non-finite and out-of-range numbers", () => {
    expect(ok({ ...vectors, vectors: [{ from: [1, 1], to: [1, 1] }] })).toBe(false);
    expect(ok({ ...vectors, vectors: [{ from: [0, 0], to: [Infinity, 1] }] })).toBe(false);
    expect(ok({ ...vectors, vectors: [{ from: [0, 0], to: [1e9, 1] }] })).toBe(false);
    expect(ok({ ...vectors, x_range: [5, 1] })).toBe(false);
  });

  it("rejects diagrams with dangling, self or duplicate references", () => {
    expect(ok({ ...diagram, edges: [{ from: "in", to: "missing" }] })).toBe(false);
    expect(ok({ ...diagram, edges: [{ from: "in", to: "in" }] })).toBe(false);
    expect(ok({ ...diagram, nodes: [...diagram.nodes, { id: "in", label: "Again" }] })).toBe(false);
    expect(ok({ ...diagram, nodes: Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, label: `N${i}` })), edges: [] })).toBe(false);
  });

  it("rejects tables whose rows do not match the header or highlight missing rows", () => {
    expect(ok({ ...table, rows: [["0", "1"]] })).toBe(false);
    expect(ok({ ...table, highlight_rows: [4] })).toBe(false);
  });

  it("rejects overly long labels", () => {
    expect(ok({ ...diagram, nodes: [{ id: "a", label: "x".repeat(33) }, { id: "b", label: "B" }], edges: [] })).toBe(false);
  });
});

describe("LearningContentSchema.visual", () => {
  const lesson = { type: "learning_info", title: "Vectors", body: "Arrows.", concept_ids: ["c1"] };

  it("keeps a valid visual", () => {
    const parsed = LearningContentSchema.parse({ ...lesson, visual: vectors });
    expect(parsed.visual).toMatchObject({ kind: "vectors" });
  });

  it("drops an invalid visual without failing the lesson", () => {
    const parsed = LearningContentSchema.safeParse({ ...lesson, visual: { kind: "vectors", vectors: [] } });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.visual).toBeUndefined();
  });

  it("is optional", () => {
    const parsed = LearningContentSchema.parse(lesson);
    expect(parsed.visual).toBeUndefined();
  });
});
