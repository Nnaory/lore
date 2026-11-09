/**
 * Tests — Story Blueprint Schema
 *
 * Verifies that:
 *   - Valid dummy story passes validation
 *   - Story with no chapters is rejected
 *   - Story with empty title is rejected
 */

import { describe, it, expect } from "vitest";
import { StoryBlueprintSchema } from "@/lib/ai/schemas/story.schema";
import { dummyStory } from "@/data/dummy-campaign";

describe("StoryBlueprintSchema", () => {
  it("should accept the valid dummy story", () => {
    const result = StoryBlueprintSchema.safeParse(dummyStory);
    expect(result.success).toBe(true);
  });

  it("should reject a story with an empty title", () => {
    const bad = { ...dummyStory, title: "" };
    const result = StoryBlueprintSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("should reject a story with no chapters", () => {
    const bad = { ...dummyStory, chapters: [] };
    const result = StoryBlueprintSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("should reject a story with an empty story_id", () => {
    const bad = { ...dummyStory, story_id: "" };
    const result = StoryBlueprintSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("should accept a story with null continuity_summary", () => {
    const result = StoryBlueprintSchema.safeParse({ ...dummyStory, continuity_summary: null });
    expect(result.success).toBe(true);
  });
});
