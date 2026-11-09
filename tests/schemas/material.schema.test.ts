/**
 * Tests — Material Blueprint Schema
 *
 * Verifies that:
 *   - Valid dummy material passes validation
 *   - Missing required fields are caught
 *   - Empty strings are rejected
 *   - At least one concept is required
 */

import { describe, it, expect } from "vitest";
import { MaterialBlueprintSchema } from "@/lib/ai/schemas/material.schema";
import { dummyMaterial } from "@/data/dummy-campaign";

describe("MaterialBlueprintSchema", () => {
  it("should accept the valid dummy material", () => {
    const result = MaterialBlueprintSchema.safeParse(dummyMaterial);
    expect(result.success).toBe(true);
  });

  it("should reject a material with an empty material_id", () => {
    const bad = { ...dummyMaterial, material_id: "" };
    const result = MaterialBlueprintSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("should reject a material with an empty title", () => {
    const bad = { ...dummyMaterial, title: "" };
    const result = MaterialBlueprintSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("should reject a material with no learning objectives", () => {
    const bad = { ...dummyMaterial, learning_objectives: [] };
    const result = MaterialBlueprintSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("should reject a material with no concepts", () => {
    const bad = { ...dummyMaterial, concepts: [] };
    const result = MaterialBlueprintSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("should reject a concept with an empty definition", () => {
    const bad = {
      ...dummyMaterial,
      concepts: [{ ...dummyMaterial.concepts[0], definition: "" }],
    };
    const result = MaterialBlueprintSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});
