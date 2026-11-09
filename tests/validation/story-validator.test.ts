/**
 * Tests — Story Semantic Validator
 *
 * Verifies that:
 *   - Valid dummy story passes semantic validation
 *   - Duplicate scene IDs are caught
 *   - Invalid next_scene_id references are caught
 *   - Invalid character references in characters_present are caught
 *   - Invalid character references in dialogue are caught
 *   - Invalid puzzle_id references are caught
 *   - Invalid concept_id references are caught (with material)
 */

import { describe, it, expect } from "vitest";
import { validateStory } from "@/lib/validation/story-validator";
import { dummyStory, dummyMaterial } from "@/data/dummy-campaign";
import type { StoryBlueprint } from "@/lib/types/story";
import type { Scene } from "@/lib/types/scene";

/** Deep-clone the story so mutations in one test don't bleed into others. */
function cloneStory(): StoryBlueprint {
  return JSON.parse(JSON.stringify(dummyStory)) as StoryBlueprint;
}

describe("validateStory — valid data", () => {
  it("should pass for the valid dummy story (without material)", () => {
    const result = validateStory(dummyStory);
    expect(result.valid).toBe(true);
  });

  it("should pass for the valid dummy story (with material)", () => {
    const result = validateStory(dummyStory, dummyMaterial);
    expect(result.valid).toBe(true);
  });
});

describe("validateStory — duplicate scene IDs", () => {
  it("should detect duplicate scene_id within the story", () => {
    const story = cloneStory();
    // Duplicate the first scene at the end of the chapter
    const duplicate: Scene = {
      ...story.chapters[0].scenes[0],
    };
    story.chapters[0].scenes.push(duplicate);

    const result = validateStory(story);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const codes = result.errors.map((e) => e.code);
      expect(codes).toContain("DUPLICATE_SCENE_ID");
    }
  });
});

describe("validateStory — invalid next_scene_id references", () => {
  it("should detect a next_scene_id that points to a non-existent scene", () => {
    const story = cloneStory();
    // Make the intro scene point to a scene that doesn't exist
    const introScene = story.chapters[0].scenes[0] as Extract<
      Scene,
      { type: "narrative" }
    >;
    introScene.next_scene_id = "scene_DOES_NOT_EXIST";

    const result = validateStory(story);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const codes = result.errors.map((e) => e.code);
      expect(codes).toContain("INVALID_NEXT_SCENE_REF");
    }
  });
});

describe("validateStory — invalid character references", () => {
  it("should detect an unknown character_id in characters_present", () => {
    const story = cloneStory();
    story.chapters[0].scenes[0].characters_present = ["ghost_character"];

    const result = validateStory(story);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const codes = result.errors.map((e) => e.code);
      expect(codes).toContain("INVALID_CHARACTER_REF");
    }
  });

  it("should detect an unknown character_id in a dialogue block", () => {
    const story = cloneStory();
    // Replace eldric's dialogue with a ghost character
    const scene = story.chapters[0].scenes[0] as Extract<Scene, { type: "narrative" }>;
    scene.content = [
      {
        type: "dialogue",
        character_id: "ghost_character",
        expression: "neutral",
        text: "Hello.",
      },
    ];

    const result = validateStory(story);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const codes = result.errors.map((e) => e.code);
      expect(codes).toContain("INVALID_DIALOGUE_CHARACTER_REF");
    }
  });
});

describe("validateStory — invalid puzzle references", () => {
  it("should detect a puzzle_id that does not exist in story.puzzles", () => {
    const story = cloneStory();
    const puzzleScene = story.chapters[0].scenes.find(
      (s) => s.type === "puzzle"
    ) as Extract<Scene, { type: "puzzle" }>;
    puzzleScene.puzzle_id = "puzzle_NONEXISTENT";

    const result = validateStory(story);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const codes = result.errors.map((e) => e.code);
      expect(codes).toContain("INVALID_PUZZLE_REF");
    }
  });
});

describe("validateStory — invalid concept references", () => {
  it("should detect a concept_id in a puzzle that does not exist in the material", () => {
    const story = cloneStory();
    story.puzzles[0].concept_ids = ["concept_NONEXISTENT"];

    const result = validateStory(story, dummyMaterial);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const codes = result.errors.map((e) => e.code);
      expect(codes).toContain("INVALID_CONCEPT_REF");
    }
  });
});
