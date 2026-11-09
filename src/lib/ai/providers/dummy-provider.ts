/**
 * Dummy AI Provider — Deterministic Material Intelligence
 *
 * Implements IMaterialIntelligenceProvider for local development and testing.
 * Returns predictable MaterialBlueprints based on input keywords.
 * NO randomness, NO external calls, NO API keys required.
 */

import {
  IMaterialIntelligenceProvider,
  AnalyzeMaterialRequest,
  AnalyzeMaterialResult,
} from "@/lib/ai/types";
import { dummyMaterial } from "@/data/dummy-campaign";
import { MaterialBlueprintSchema } from "@/lib/ai/schemas/material.schema";
import type { MaterialBlueprint } from "@/lib/types/material";

/** Minimal valid blueprint for unknown materials. */
function createGenericBlueprint(material: string): MaterialBlueprint {
  const truncated = material.slice(0, 120).replace(/\s+/g, " ").trim();
  return {
    material_id: "material_generic",
    title: "Extracted Learning Material",
    summary: `Auto-generated summary for: ${truncated}...`,
    learning_objectives: ["Understand the core concepts from the provided material."],
    concepts: [
      {
        concept_id: "concept_core",
        name: "Core Concept",
        definition: "The primary idea extracted from the learning material.",
        principles: ["Key principle derived from the material."],
        methods: ["Primary method or approach described."],
        prerequisites: [],
        misconceptions: ["Common misunderstanding about this topic."],
        source_evidence: [truncated],
      },
    ],
    scope_limitations: [
      "This is a generic fallback blueprint. Provide more specific material for detailed analysis.",
    ],
  };
}

/** Keyword-based template selection (deterministic). */
function selectBlueprint(material: string): MaterialBlueprint {
  const lower = material.toLowerCase();

  // Linear Algebra / Vector topics → dummyMaterial
  if (
    lower.includes("linear combination") ||
    lower.includes("vector span") ||
    lower.includes("vector space") ||
    lower.includes("basis vector") ||
    lower.includes("linear algebra")
  ) {
    return dummyMaterial;
  }

  // Calculus topics → could add a second fixture later
  // if (lower.includes("derivative") || lower.includes("integral")) { ... }

  // Default: generic
  return createGenericBlueprint(material);
}

export class DummyProvider implements IMaterialIntelligenceProvider {
  readonly id = "dummy" as const;
  readonly model = "dummy-v1";

  async analyzeMaterial(
    request: AnalyzeMaterialRequest
  ): Promise<AnalyzeMaterialResult> {
    const start = Date.now();

    try {
      // Input validation (defensive — API route also validates)
      if (!request.material || request.material.trim().length < 10) {
        return {
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            message: "Material must be at least 10 characters",
          },
        };
      }

      // Select deterministic blueprint based on input
      const blueprint = selectBlueprint(request.material);

      // Validate against schema (ensures dummy output always passes)
      const parsed = MaterialBlueprintSchema.safeParse(blueprint);
      if (!parsed.success) {
        return {
          ok: false,
          error: {
            code: "VALIDATION_FAILED",
            message: "Dummy provider produced invalid blueprint",
            detail: parsed.error.flatten(),
          },
        };
      }

      const latencyMs = Date.now() - start;

      return {
        ok: true,
        value: {
          blueprint: parsed.data,
          meta: {
            provider: this.id,
            model: this.model,
            latencyMs,
            tokensIn: Math.ceil(request.material.length / 4),
            tokensOut: JSON.stringify(blueprint).length,
          },
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: "UNKNOWN",
          message: "Dummy provider unexpected error",
          detail: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  async healthCheck(): Promise<{ healthy: boolean; detail?: string }> {
    return { healthy: true, detail: "Dummy provider operational" };
  }
}