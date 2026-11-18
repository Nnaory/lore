/**
 * Output Parser & Validator — Material Intelligence
 *
 * Parses raw provider output, validates against Zod schema,
 * and runs semantic validation. Returns structured result.
 */

import { MaterialBlueprintSchema, MaterialBlueprintFromSchema } from "@/lib/ai/schemas/material.schema";
import type { AnalyzeMaterialResult, AIErrorCode, ProviderMeta } from "@/lib/ai/types";
import type { ValidationError } from "@/lib/validation/story-validator";

/** Parsed and validated output. */
export interface ParsedMaterialResult {
  ok: true;
  blueprint: MaterialBlueprintFromSchema;
  meta: ProviderMeta;
  /** Warnings from semantic validation (non-blocking). */
  warnings: ValidationError[];
}

/** Parse error with standardized code. */
export interface ParseError {
  ok: false;
  code: AIErrorCode;
  message: string;
  detail?: unknown;
}

/** Union for handling without exceptions. */
export type ParseResult = ParsedMaterialResult | ParseError;

/**
 * Parse raw provider response, validate schema, run semantic checks.
 * Returns ParseResult (never throws).
 */
export function parseAndValidateMaterialOutput(
  rawResponse: { blueprint: unknown; meta: ProviderMeta }
): ParseResult {
  const { blueprint: rawBlueprint, meta } = rawResponse;

  // 1. Zod schema validation
  const schemaResult = MaterialBlueprintSchema.safeParse(rawBlueprint);
  if (!schemaResult.success) {
    return {
      ok: false,
      code: "VALIDATION_FAILED",
      message: "Output does not match MaterialBlueprint schema",
      detail: schemaResult.error.flatten(),
    };
  }

  const blueprint = schemaResult.data;

  // 2. Semantic validation (cross-reference checks)
  // Note: Campaign validation requires full campaign + materials.
  // For Layer 1 output, we only validate the MaterialBlueprint internally.
  // Concept cross-references within the blueprint are already covered by schema.
  // Future: when Campaign Planner (Layer 2) runs, it will validate
  // required_knowledge against these concept_ids.

  const warnings: ValidationError[] = [];

  // Check for empty arrays that schema allows but semantics discourage
  if (blueprint.learning_objectives.length === 0) {
    warnings.push({
      code: "EMPTY_LEARNING_OBJECTIVES",
      message: "No learning objectives extracted",
      path: "learning_objectives",
    });
  }
  if (blueprint.concepts.length === 0) {
    warnings.push({
      code: "EMPTY_CONCEPTS",
      message: "No concepts extracted",
      path: "concepts",
    });
  }
  for (const concept of blueprint.concepts) {
    if (concept.source_evidence.length === 0) {
      warnings.push({
        code: "MISSING_SOURCE_EVIDENCE",
        message: `Concept "${concept.concept_id}" has no source_evidence`,
        path: `concepts[${concept.concept_id}].source_evidence`,
      });
    }
    // Check prerequisite references are internal
    for (const prereq of concept.prerequisites) {
      const exists = blueprint.concepts.some((c) => c.concept_id === prereq);
      if (!exists) {
        warnings.push({
          code: "INVALID_PREREQUISITE_REF",
          message: `Concept "${concept.concept_id}" references unknown prerequisite "${prereq}"`,
          path: `concepts[${concept.concept_id}].prerequisites`,
        });
      }
    }
  }

  return {
    ok: true,
    blueprint,
    meta,
    warnings,
  };
}

/**
 * High-level parser used by Material Intelligence service.
 * Takes the full AnalyzeMaterialResult from provider.
 */
export function parseProviderResult(
  providerResult: AnalyzeMaterialResult
): ParseResult {
  if (!providerResult.ok) {
    return {
      ok: false,
      code: providerResult.error.code,
      message: providerResult.error.message,
      detail: providerResult.error.detail,
    };
  }

  return parseAndValidateMaterialOutput(providerResult.value);
}