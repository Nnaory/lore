/**
 * Tests — Story Blueprint Schema
 *
 * Verifies that:
 *   - Valid dummy story passes validation
 *   - Story with no chapters is rejected
 *   - Story with empty title is rejected
 */

import { describe, it, expect } from "vitest";
import { StoryBlueprintSchema } from "@/lib/contracts/schemas/story.schema";
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

  it("should keep on_incorrect_scene_id on puzzle scenes after parsing", () => {
    const result = StoryBlueprintSchema.safeParse(dummyStory);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const puzzleScene = result.data.chapters
      .flatMap((c) => c.scenes)
      .find((s) => s.scene_id === "scene_05_puzzle");
    expect(puzzleScene).toMatchObject({
      type: "puzzle",
      on_incorrect_scene_id: {
        choice_A: "scene_bad_A_start",
        choice_C: "scene_bad_C_start",
      },
    });
  });

  it("should reject an on_incorrect_scene_id entry with an empty scene_id", () => {
    const bad = JSON.parse(JSON.stringify(dummyStory));
    const puzzleScene = bad.chapters[0].scenes.find(
      (s: { scene_id: string }) => s.scene_id === "scene_05_puzzle"
    );
    puzzleScene.on_incorrect_scene_id = { choice_A: "" };
    const result = StoryBlueprintSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});
