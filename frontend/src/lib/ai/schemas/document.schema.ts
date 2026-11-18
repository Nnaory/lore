/**
 * Zod Schemas — Extracted Document
 *
 * Validates the output of Layer 0 (Ingest) whenever it crosses a trust
 * boundary (e.g. when it is loaded back from browser storage).
 */

import { z } from "zod";

export const DocumentFileTypeSchema = z.enum(["pdf", "docx", "pptx", "text"]);

export const DocumentSectionSchema = z.object({
  section_id: z.string().min(1, "section_id must not be empty"),
  title: z.string().min(1, "section title must not be empty"),
  text: z.string().min(1, "section text must not be empty"),
  source_ref: z.string().min(1, "source_ref must not be empty"),
});

export const DocumentWarningSchema = z.object({
  code: z.enum(["PARTIAL_TEXT_LAYER", "EMPTY_SLIDES_SKIPPED"]),
  message: z.string().min(1),
});

export const ExtractedDocumentSchema = z
  .object({
    file_name: z.string().min(1, "file_name must not be empty"),
    file_type: DocumentFileTypeSchema,
    sections: z
      .array(DocumentSectionSchema)
      .min(1, "a document must contain at least one section"),
    stats: z.object({
      units: z.number().int().nonnegative(),
      words: z.number().int().nonnegative(),
      chars: z.number().int().nonnegative(),
    }),
    warnings: z.array(DocumentWarningSchema),
  })
  .refine(
    (doc) => new Set(doc.sections.map((s) => s.section_id)).size === doc.sections.length,
    { message: "section_id values must be unique", path: ["sections"] }
  );
