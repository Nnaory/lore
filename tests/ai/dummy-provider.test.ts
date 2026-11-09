/**
 * Tests — Dummy Provider
 *
 * Verifies deterministic behavior, schema validation of output,
 * and metadata presence.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DummyProvider } from "@/lib/ai/providers/dummy-provider";
import { MaterialBlueprintSchema } from "@/lib/ai/schemas/material.schema";
import { dummyMaterial } from "@/data/dummy-campaign";
import type { AnalyzeMaterialRequest } from "@/lib/ai/types";

describe("DummyProvider — Deterministic Behavior", () => {
  let provider: DummyProvider;

  beforeEach(() => {
    provider = new DummyProvider();
  });

  it("returns ok: true for valid input", async () => {
    const request: AnalyzeMaterialRequest = {
      material: "Linear combinations are expressions of the form c1*v1 + c2*v2 where c1, c2 are scalars.",
    };
    const result = await provider.analyzeMaterial(request);
    expect(result.ok).toBe(true);
  });

  it("returns dummyMaterial for linear algebra content", async () => {
    const request: AnalyzeMaterialRequest = {
      material: "This material covers linear combinations and vector span in linear algebra.",
    };
    const result = await provider.analyzeMaterial(request);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.blueprint.material_id).toBe(dummyMaterial.material_id);
      expect(result.value.blueprint.title).toBe(dummyMaterial.title);
      expect(result.value.blueprint.concepts).toHaveLength(dummyMaterial.concepts.length);
    }
  });

  it("returns generic blueprint for unknown content", async () => {
    const request: AnalyzeMaterialRequest = {
      material: "The history of ancient Rome spans many centuries and includes many emperors.",
    };
    const result = await provider.analyzeMaterial(request);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.blueprint.material_id).toBe("material_generic");
      expect(result.value.blueprint.concepts).toHaveLength(1);
      expect(result.value.blueprint.concepts[0].concept_id).toBe("concept_core");
    }
  });

  it("is deterministic — same input produces same output", async () => {
    const request: AnalyzeMaterialRequest = {
      material: "Vector span is the set of all linear combinations of a set of vectors.",
    };
    const r1 = await provider.analyzeMaterial(request);
    const r2 = await provider.analyzeMaterial(request);

    // Compare blueprint only (latencyMs varies between calls)
    expect(r1.ok).toBe(r2.ok);
    if (r1.ok && r2.ok) {
      expect(r1.value.blueprint).toEqual(r2.value.blueprint);
      expect(r1.value.meta.provider).toBe(r2.value.meta.provider);
      expect(r1.value.meta.model).toBe(r2.value.meta.model);
      expect(r1.value.meta.tokensIn).toBe(r2.value.meta.tokensIn);
      expect(r1.value.meta.tokensOut).toBe(r2.value.meta.tokensOut);
    }
  });

  it("output passes MaterialBlueprintSchema validation", async () => {
    const request: AnalyzeMaterialRequest = {
      material: "Linear algebra studies vector spaces and linear transformations between them.",
    };
    const result = await provider.analyzeMaterial(request);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const validated = MaterialBlueprintSchema.safeParse(result.value.blueprint);
      expect(validated.success).toBe(true);
    }
  });

  it("includes provider metadata", async () => {
    const request: AnalyzeMaterialRequest = {
      material: "A linear combination combines vectors using scalar coefficients.",
    };
    const result = await provider.analyzeMaterial(request);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const meta = result.value.meta;
      expect(meta.provider).toBe("dummy");
      expect(meta.model).toBe("dummy-v1");
      expect(typeof meta.latencyMs).toBe("number");
      expect(meta.latencyMs).toBeGreaterThanOrEqual(0);
      expect(typeof meta.tokensIn).toBe("number");
      expect(typeof meta.tokensOut).toBe("number");
    }
  });

  it("rejects too-short material", async () => {
    const request: AnalyzeMaterialRequest = {
      material: "Short",
    };
    const result = await provider.analyzeMaterial(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_REQUEST");
    }
  });

  it("healthCheck returns healthy", async () => {
    const health = await provider.healthCheck();
    expect(health.healthy).toBe(true);
  });

  it("provider id and model are correct", () => {
    expect(provider.id).toBe("dummy");
    expect(provider.model).toBe("dummy-v1");
  });
});