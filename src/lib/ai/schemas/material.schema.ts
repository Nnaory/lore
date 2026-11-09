/**
 * Zod Schemas — Material Blueprint
 *
 * Used to validate AI output from Layer 1 (Material Intelligence)
 * before it is consumed by the rest of the application.
 */

import { z } from "zod";

export const ConceptSchema = z.object({
  concept_id: z.string().min(1, "concept_id must not be empty"),
  name: z.string().min(1, "concept name must not be empty"),
  definition: z.string().min(1, "definition must not be empty"),
  principles: z.array(z.string()),
  methods: z.array(z.string()),
  prerequisites: z.array(z.string()),
  misconceptions: z.array(z.string()),
  source_evidence: z.array(z.string()),
});

export const MaterialBlueprintSchema = z.object({
  material_id: z.string().min(1, "material_id must not be empty"),
  title: z.string().min(1, "material title must not be empty"),
  summary: z.string().min(1, "material summary must not be empty"),
  learning_objectives: z
    .array(z.string())
    .min(1, "at least one learning objective is required"),
  concepts: z.array(ConceptSchema).min(1, "at least one concept is required"),
  scope_limitations: z.array(z.string()),
});

// Inferred TypeScript types from schemas (use these instead of hand-written types
// when you need runtime-validated values)
export type ConceptFromSchema = z.infer<typeof ConceptSchema>;
export type MaterialBlueprintFromSchema = z.infer<typeof MaterialBlueprintSchema>;
