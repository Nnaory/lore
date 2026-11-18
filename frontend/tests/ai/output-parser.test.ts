/**
 * Tests — Output Parser & Validator
 *
 * Verifies parsing, schema validation, and semantic validation.
 */

import { describe, it, expect } from "vitest";
import {
  parseAndValidateMaterialOutput,
  parseProviderResult,
} from "@/lib/ai/output-parser";
import { dummyMaterial } from "@/data/dummy-campaign";
import type { ProviderMeta, AnalyzeMaterialResult } from "@/lib/ai/types";

const validMeta: ProviderMeta = {
  provider: "dummy",
  model: "dummy-v1",
  latencyMs: 10,
  tokensIn: 100,
  tokensOut: 200,
};

describe("Output Parser — parseAndValidateMaterialOutput", () => {
  it("accepts valid dummyMaterial", () => {
    const result = parseAndValidateMaterialOutput({
      blueprint: dummyMaterial,
      meta: validMeta,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blueprint.material_id).toBe(dummyMaterial.material_id);
      expect(result.meta.provider).toBe("dummy");
      expect(Array.isArray(result.warnings)).toBe(true);
    }
  });

  it("rejects missing required fields", () => {
    const badBlueprint = { ...dummyMaterial, material_id: "" };
    const result = parseAndValidateMaterialOutput({
      blueprint: badBlueprint,
      meta: validMeta,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("VALIDATION_FAILED");
    }
  });

  it("rejects empty concepts array", () => {
    const badBlueprint = { ...dummyMaterial, concepts: [] };
    const result = parseAndValidateMaterialOutput({
      blueprint: badBlueprint,
      meta: validMeta,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("VALIDATION_FAILED");
    }
  });

  it("warns about missing source_evidence", () => {
    const badBlueprint = {
      ...dummyMaterial,
      concepts: [{ ...dummyMaterial.concepts[0], source_evidence: [] }],
    };
    const result = parseAndValidateMaterialOutput({
      blueprint: badBlueprint,
      meta: validMeta,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const warning = result.warnings.find((w) => w.code === "MISSING_SOURCE_EVIDENCE");
      expect(warning).toBeDefined();
      expect(warning?.path).toContain("source_evidence");
    }
  });

  it("warns about invalid prerequisite references", () => {
    const badBlueprint = {
      ...dummyMaterial,
      concepts: [{ ...dummyMaterial.concepts[0], prerequisites: ["nonexistent_concept"] }],
    };
    const result = parseAndValidateMaterialOutput({
      blueprint: badBlueprint,
      meta: validMeta,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const warning = result.warnings.find((w) => w.code === "INVALID_PREREQUISITE_REF");
      expect(warning).toBeDefined();
    }
  });
});

describe("Output Parser — parseProviderResult", () => {
  it("passes through provider error", () => {
    const providerError: AnalyzeMaterialResult = {
      ok: false,
      error: { code: "TIMEOUT", message: "Request timed out" },
    };

    const result = parseProviderResult(providerError);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("TIMEOUT");
      expect(result.message).toBe("Request timed out");
    }
  });

  it("parses successful provider result", () => {
    const providerSuccess: AnalyzeMaterialResult = {
      ok: true,
      value: {
        blueprint: dummyMaterial,
        meta: validMeta,
      },
    };

    const result = parseProviderResult(providerSuccess);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blueprint.material_id).toBe(dummyMaterial.material_id);
    }
  });
});