/**
 * Tests — AI Provider Types
 *
 * Verifies type contracts, error codes, and result union narrowing.
 */

import { describe, it, expect } from "vitest";
import type {
  AIProviderId,
  AnalyzeMaterialRequest,
  AnalyzeMaterialResponse,
  AnalyzeMaterialError,
  AnalyzeMaterialResult,
  AIErrorCode,
  ProviderMeta,
  IMaterialIntelligenceProvider,
} from "@/lib/ai/types";

describe("AI Provider Types — Contract", () => {
  it("AIProviderId includes dummy and future providers", () => {
    // Type-only test — verifies the union includes expected values
    const providers: AIProviderId[] = ["dummy", "openai", "anthropic", "google"];
    expect(providers).toHaveLength(4);
  });

  it("AnalyzeMaterialRequest has required material field", () => {
    const req: AnalyzeMaterialRequest = {
      material: "Test material content here",
      context: { grade: "undergraduate" },
      genre: "fantasy",
    };
    expect(req.material).toBeDefined();
    expect(req.context).toBeDefined();
    expect(req.genre).toBeDefined();
  });

  it("AnalyzeMaterialResponse includes blueprint and meta", () => {
    const meta: ProviderMeta = {
      provider: "dummy",
      model: "dummy-v1",
      latencyMs: 10,
      tokensIn: 100,
      tokensOut: 200,
    };
    const response: AnalyzeMaterialResponse = {
      blueprint: {
        material_id: "test",
        title: "Test",
        summary: "Summary",
        learning_objectives: ["Obj 1"],
        concepts: [
          {
            concept_id: "c1",
            name: "Concept",
            definition: "Def",
            principles: [],
            methods: [],
            prerequisites: [],
            misconceptions: [],
            source_evidence: ["evidence"],
          },
        ],
        scope_limitations: [],
      },
      meta,
    };
    expect(response.blueprint.material_id).toBe("test");
    expect(response.meta.provider).toBe("dummy");
  });

  it("AnalyzeMaterialError has standardized code", () => {
    const error: AnalyzeMaterialError = {
      code: "VALIDATION_FAILED",
      message: "Schema validation failed",
      detail: { fieldErrors: {} },
    };
    expect(error.code).toBe("VALIDATION_FAILED");
  });

  it("AIErrorCode union contains all expected codes", () => {
    const codes: AIErrorCode[] = [
      "PROVIDER_UNAVAILABLE",
      "INVALID_REQUEST",
      "OUTPUT_PARSE_FAILED",
      "VALIDATION_FAILED",
      "RATE_LIMITED",
      "TIMEOUT",
      "UNKNOWN",
    ];
    expect(codes).toHaveLength(7);
  });

  it("AnalyzeMaterialResult discriminated union narrows correctly", () => {
    function handleResult(result: AnalyzeMaterialResult) {
      if (result.ok) {
        // TypeScript narrows to { ok: true; value: AnalyzeMaterialResponse }
        return result.value.meta.provider;
      } else {
        // TypeScript narrows to { ok: false; error: AnalyzeMaterialError }
        return result.error.code;
      }
    }

    const success: AnalyzeMaterialResult = {
      ok: true,
      value: {
        blueprint: {
          material_id: "x",
          title: "X",
          summary: "S",
          learning_objectives: ["O"],
          concepts: [
            {
              concept_id: "c1",
              name: "N",
              definition: "D",
              principles: [],
              methods: [],
              prerequisites: [],
              misconceptions: [],
              source_evidence: ["E"],
            },
          ],
          scope_limitations: [],
        },
        meta: { provider: "dummy", model: "m", latencyMs: 1 },
      },
    };
    const failure: AnalyzeMaterialResult = {
      ok: false,
      error: { code: "TIMEOUT", message: "Timed out" },
    };

    expect(handleResult(success)).toBe("dummy");
    expect(handleResult(failure)).toBe("TIMEOUT");
  });

  it("IMaterialIntelligenceProvider interface shape", () => {
    // Verify interface requires id, model, analyzeMaterial, optional healthCheck
    const mockProvider: IMaterialIntelligenceProvider = {
      id: "dummy",
      model: "test-model",
      async analyzeMaterial() {
        return {
          ok: true,
          value: {
            blueprint: {
              material_id: "test",
              title: "Test",
              summary: "Summary",
              learning_objectives: ["Obj 1"],
              concepts: [
                {
                  concept_id: "c1",
                  name: "Concept",
                  definition: "Def",
                  principles: [],
                  methods: [],
                  prerequisites: [],
                  misconceptions: [],
                  source_evidence: ["E"],
                },
              ],
              scope_limitations: [],
            },
            meta: { provider: "dummy", model: "m", latencyMs: 1 },
          },
        };
      },
      async healthCheck() {
        return { healthy: true };
      },
    };
    expect(mockProvider.id).toBe("dummy");
    expect(mockProvider.model).toBe("test-model");
    expect(typeof mockProvider.analyzeMaterial).toBe("function");
    expect(typeof mockProvider.healthCheck).toBe("function");
  });
});