/**
 * Tests — Material Intelligence Service
 *
 * Verifies the service orchestrates provider → parser → validator correctly.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { analyzeMaterial, resetMaterialIntelligenceCache } from "@/lib/ai/material-intelligence";
import { resetProviderCache } from "@/lib/ai/providers";
import { parseProviderResult } from "@/lib/ai/output-parser";
import type { AnalyzeMaterialRequest } from "@/lib/ai/types";
import type { AnalyzeMaterialResult, ProviderMeta } from "@/lib/ai/types";

describe("Material Intelligence Service — Pipeline", () => {
  beforeEach(() => {
    resetMaterialIntelligenceCache();
    resetProviderCache();
    vi.clearAllMocks();
  });

  it("returns validated blueprint for valid input", async () => {
    const request: AnalyzeMaterialRequest = {
      material: "Linear combinations are fundamental to linear algebra. A linear combination of vectors v1, v2 is c1*v1 + c2*v2.",
    };
    const result = await analyzeMaterial(request);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blueprint.material_id).toBeDefined();
      expect(result.blueprint.title).toBeDefined();
      expect(result.blueprint.concepts.length).toBeGreaterThan(0);
      expect(result.meta.provider).toBe("dummy");
      expect(result.meta.model).toBe("dummy-v1");
      expect(typeof result.meta.latencyMs).toBe("number");
      expect(Array.isArray(result.meta.warnings)).toBe(true);
    }
  });

  it("includes warnings array in response", async () => {
    const request: AnalyzeMaterialRequest = {
      material: "Generic topic about something completely different from linear algebra.",
    };
    const result = await analyzeMaterial(request);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Verify warnings array exists (may be empty)
      expect(result.meta.warnings).toBeDefined();
      expect(Array.isArray(result.meta.warnings)).toBe(true);
    }
  });

  it("uses cached provider on subsequent calls", async () => {
    const request: AnalyzeMaterialRequest = {
      material: "Linear algebra and vector spaces.",
    };

    await analyzeMaterial(request);
    await analyzeMaterial(request);

    // If caching works, subsequent calls succeed
    const result = await analyzeMaterial(request);
    expect(result.ok).toBe(true);
  });

  it("returns linear algebra blueprint for relevant content", async () => {
    const request: AnalyzeMaterialRequest = {
      material: "Vector span is the set of all linear combinations of a set of vectors. This is a core concept in linear algebra.",
    };
    const result = await analyzeMaterial(request);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blueprint.material_id).toBe("material_01");
      expect(result.blueprint.concepts.length).toBe(2);
    }
  });
});

// Separate test suite for error propagation using direct parser calls
// (avoids provider factory module caching complications)
describe("Material Intelligence Service — Error Handling (Parser Level)", () => {
  const validMeta: ProviderMeta = {
    provider: "dummy",
    model: "dummy-v1",
    latencyMs: 10,
  };

  it("propagates provider errors through parser", () => {
    const providerError: AnalyzeMaterialResult = {
      ok: false,
      error: { code: "PROVIDER_UNAVAILABLE", message: "Service down" },
    };

    const result = parseProviderResult(providerError);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PROVIDER_UNAVAILABLE");
    }
  });

  it("handles validation failure from provider output", () => {
    // Provide an object that fails schema validation
    const providerSuccess: AnalyzeMaterialResult = {
      ok: true,
      value: {
        blueprint: {
          material_id: "",
          title: "",
          summary: "",
          learning_objectives: [],
          concepts: [],
          scope_limitations: [],
        },
        meta: validMeta,
      },
    };

    const result = parseProviderResult(providerSuccess);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("VALIDATION_FAILED");
    }
  });

  it("parses successful provider result", () => {
    const validBlueprint = {
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
    };

    const providerSuccess: AnalyzeMaterialResult = {
      ok: true,
      value: {
        blueprint: validBlueprint,
        meta: validMeta,
      },
    };

    const result = parseProviderResult(providerSuccess);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blueprint.material_id).toBe("test");
    }
  });
});