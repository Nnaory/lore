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
  // Generate a deterministic but unique material_id from content hash
  let hash = 0;
  for (let i = 0; i < material.length; i++) {
    hash = ((hash << 5) - hash + material.charCodeAt(i)) | 0;
  }
  const materialId = `material_gen_${Math.abs(hash).toString(36)}`;

  return {
    material_id: materialId,
    title: "Extracted Learning Material",
    summary: `Auto-generated summary for: ${truncated}...`,
    learning_objectives: ["Understand the core concepts from the provided material."],
    concepts: [
      {
        concept_id: `concept_core_${Math.abs(hash).toString(36)}`,
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

  // Linear Algebra / Vector topics → dummyMaterial (with unique material_id per input)
  if (
    lower.includes("linear combination") ||
    lower.includes("vector span") ||
    lower.includes("vector space") ||
    lower.includes("basis vector") ||
    lower.includes("linear algebra")
  ) {
    return createLinearAlgebraBlueprint(material);
  }

  // Calculus topics → could add a second fixture later
  // if (lower.includes("derivative") || lower.includes("integral")) { ... }

  // Default: generic
  return createGenericBlueprint(material);
}

/** Create a linear algebra blueprint with unique IDs derived from input hash. */
function createLinearAlgebraBlueprint(material: string): MaterialBlueprint {
  // Generate deterministic hash from input
  let hash = 0;
  for (let i = 0; i < material.length; i++) {
    hash = ((hash << 5) - hash + material.charCodeAt(i)) | 0;
  }
  const hashStr = Math.abs(hash).toString(36);
  const materialId = `material_la_${hashStr}`;

  // Map old concept_ids to new ones
  const conceptIdMap = new Map<string, string>();
  for (const c of dummyMaterial.concepts) {
    conceptIdMap.set(c.concept_id, `${c.concept_id}_${hashStr}`);
  }

  // Deep clone dummyMaterial with unique IDs and updated prerequisites
  return {
    ...dummyMaterial,
    material_id: materialId,
    concepts: dummyMaterial.concepts.map((c) => ({
      ...c,
      concept_id: conceptIdMap.get(c.concept_id)!,
      prerequisites: c.prerequisites.map((p) => conceptIdMap.get(p) ?? p),
    })),
  };
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