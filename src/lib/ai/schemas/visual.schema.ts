/**
 * Zod Schema — Lesson Visual
 *
 * Validates the illustration spec written by the AI for a lesson. Limits
 * keep every primitive legible on the 1280×720 canvas; cross-field checks
 * (edges reference real nodes, table rows match the header) reject specs
 * the canvas could not draw correctly. An invalid visual is dropped — the
 * lesson itself still plays, as text.
 */

import { z } from "zod";
import type { LessonVisual } from "@/lib/types/visual";

/** Coordinates are bounded so a stray 1e9 cannot squash the plane. */
const coord = z.number().finite().min(-1000).max(1000);
const vec2 = z.tuple([coord, coord]);
const label = (max: number) => z.string().trim().min(1).max(max);
const caption = label(160).optional();
const tone = z.enum(["primary", "secondary", "result", "muted"]).optional();

const range = vec2.refine(([lo, hi]) => lo < hi, "range must be [min, max] with min < max").optional();

export const VectorsVisualSchema = z.object({
  kind: z.literal("vectors"),
  x_range: range,
  y_range: range,
  vectors: z
    .array(z.object({ from: vec2, to: vec2, label: label(24).optional(), tone }))
    .min(1)
    .max(6)
    .refine((vs) => vs.every((v) => v.from[0] !== v.to[0] || v.from[1] !== v.to[1]), "a vector must have length"),
  points: z.array(z.object({ at: vec2, label: label(24).optional() })).max(6).optional(),
  caption,
});

export const PlotVisualSchema = z.object({
  kind: z.literal("plot"),
  x_label: label(24).optional(),
  y_label: label(24).optional(),
  series: z
    .array(z.object({ label: label(24).optional(), points: z.array(vec2).min(2).max(60), tone }))
    .min(1)
    .max(3),
  caption,
});

export const DiagramVisualSchema = z
  .object({
    kind: z.literal("diagram"),
    layout: z.enum(["flow", "tree", "cycle"]),
    nodes: z
      .array(z.object({ id: label(40), label: label(32), detail: label(70).optional() }))
      .min(2)
      .max(8),
    edges: z.array(z.object({ from: label(40), to: label(40), label: label(24).optional() })).max(12),
    caption,
  })
  .superRefine((d, ctx) => {
    const ids = new Set<string>();
    d.nodes.forEach((n, i) => {
      if (ids.has(n.id)) ctx.addIssue({ code: "custom", message: `duplicate node id "${n.id}"`, path: ["nodes", i, "id"] });
      ids.add(n.id);
    });
    d.edges.forEach((e, i) => {
      if (!ids.has(e.from) || !ids.has(e.to)) {
        ctx.addIssue({ code: "custom", message: "edge must connect existing nodes", path: ["edges", i] });
      }
      if (e.from === e.to) ctx.addIssue({ code: "custom", message: "edge must connect two different nodes", path: ["edges", i] });
    });
  });

export const TableVisualSchema = z
  .object({
    kind: z.literal("table"),
    headers: z.array(label(24)).min(1).max(6),
    rows: z.array(z.array(z.string().trim().max(24))).min(1).max(10),
    highlight_rows: z.array(z.number().int().min(0)).max(10).optional(),
    caption,
  })
  .superRefine((t, ctx) => {
    t.rows.forEach((row, i) => {
      if (row.length !== t.headers.length) {
        ctx.addIssue({ code: "custom", message: "every row needs one cell per header", path: ["rows", i] });
      }
    });
    t.highlight_rows?.forEach((r, i) => {
      if (r >= t.rows.length) ctx.addIssue({ code: "custom", message: "highlighted row does not exist", path: ["highlight_rows", i] });
    });
  });

export const FormulaVisualSchema = z.object({
  kind: z.literal("formula"),
  expression: label(80),
  terms: z.array(z.object({ symbol: label(16), meaning: label(80) })).min(1).max(5),
  example: label(120).optional(),
  caption,
});

export const LessonVisualSchema: z.ZodType<LessonVisual, z.ZodTypeDef, unknown> = z.union([
  VectorsVisualSchema,
  PlotVisualSchema,
  DiagramVisualSchema,
  TableVisualSchema,
  FormulaVisualSchema,
]);
