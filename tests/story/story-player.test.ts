/**
 * Tests — Story Player (pure logic)
 *
 * Tests the navigation engine without React or a DOM.
 * Covers:
 *   1. Initial state from dummy story
 *   2. Scene index build
 *   3. advanceContent within a scene
 *   4. advanceScene transitions
 *   5. Ending scene detection (story_complete)
 *   6. Puzzle scene detection
 *   7. Invalid scene reference handling
 *   8. getChapterForScene helper
 */

import { describe, it, expect } from "vitest";
import {
  buildSceneIndex,
  createInitialPlayerState,
  advanceContent,
  advanceScene,
  getChapterForScene,
  deriveStatusForScene,
} from "@/lib/story/story-player";
import { dummyStory } from "@/data/dummy-campaign";
import type { StoryBlueprint } from "@/lib/types/story";
import type { Scene } from "@/lib/types/scene";

// ── 1. Initial state ─────────────────────────────────────────────────────────

describe("createInitialPlayerState", () => {
  it("should start at the first scene of the first chapter", () => {
    const state = createInitialPlayerState(dummyStory);
    expect(state.currentSceneId).toBe("scene_01_intro");
  });

  it("should start at contentIndex 0", () => {
    const state = createInitialPlayerState(dummyStory);
    expect(state.contentIndex).toBe(0);
  });

  it("should have status 'reading' for a narrative scene with content", () => {
    const state = createInitialPlayerState(dummyStory);
    expect(state.status).toBe("reading");
  });

  it("should throw if the story has no chapters", () => {
    const empty: StoryBlueprint = { ...dummyStory, chapters: [] };
    expect(() => createInitialPlayerState(empty)).toThrow();
  });
});

// ── 2. Scene index ───────────────────────────────────────────────────────────

describe("buildSceneIndex", () => {
  it("should index all scenes from all chapters", () => {
    const index = buildSceneIndex(dummyStory);
    expect(index.size).toBe(5); // 5 scenes in dummy story
  });

  it("should resolve known scene IDs", () => {
    const index = buildSceneIndex(dummyStory);
    expect(index.has("scene_01_intro")).toBe(true);
    expect(index.has("scene_02_learning")).toBe(true);
    expect(index.has("scene_05_ending")).toBe(true);
  });

  it("should return undefined for unknown scene IDs", () => {
    const index = buildSceneIndex(dummyStory);
    expect(index.get("scene_NONEXISTENT")).toBeUndefined();
  });
});

// ── 3. advanceContent ────────────────────────────────────────────────────────

describe("advanceContent", () => {
  it("should increment contentIndex when more blocks remain", () => {
    const index = buildSceneIndex(dummyStory);
    const scene = index.get("scene_01_intro")!;
    const state = createInitialPlayerState(dummyStory);
    const next = advanceContent(state, scene);
    expect(next.contentIndex).toBe(1);
    expect(next.status).toBe("reading");
  });

  it("should set status to scene_end when last block is consumed", () => {
    const index = buildSceneIndex(dummyStory);
    const scene = index.get("scene_01_intro") as Extract<Scene, { type: "narrative" }>;
    // scene_01_intro has 4 content blocks (index 0–3); advance from index 3
    const state = { currentSceneId: "scene_01_intro", contentIndex: 3, status: "reading" as const };
    const next = advanceContent(state, scene);
    expect(next.status).toBe("scene_end");
  });

  it("should be a no-op when status is not 'reading'", () => {
    const index = buildSceneIndex(dummyStory);
    const scene = index.get("scene_01_intro")!;
    const state = { currentSceneId: "scene_01_intro", contentIndex: 0, status: "scene_end" as const };
    const next = advanceContent(state, scene);
    expect(next).toStrictEqual(state);
  });
});

// ── 4. advanceScene transitions ──────────────────────────────────────────────

describe("advanceScene", () => {
  it("should transition from scene_01_intro to scene_02_learning", () => {
    const sceneIdx = buildSceneIndex(dummyStory);
    const scene = sceneIdx.get("scene_01_intro")!;
    const state = { currentSceneId: "scene_01_intro", contentIndex: 4, status: "scene_end" as const };
    const next = advanceScene(state, scene, sceneIdx);
    expect("error" in next).toBe(false);
    if (!("error" in next)) {
      expect(next.currentSceneId).toBe("scene_02_learning");
    }
  });

  it("should detect puzzle scene and set status to 'puzzle'", () => {
    const sceneIdx = buildSceneIndex(dummyStory);
    const learningScene = sceneIdx.get("scene_02_learning")!;
    const state = { currentSceneId: "scene_02_learning", contentIndex: 4, status: "scene_end" as const };
    const next = advanceScene(state, learningScene, sceneIdx);
    expect("error" in next).toBe(false);
    if (!("error" in next)) {
      expect(next.currentSceneId).toBe("scene_03_puzzle");
      expect(next.status).toBe("puzzle");
    }
  });

  it("should detect ending scene and set status to 'story_complete'", () => {
    const sceneIdx = buildSceneIndex(dummyStory);
    const consequenceScene = sceneIdx.get("scene_04_consequence")!;
    const state = { currentSceneId: "scene_04_consequence", contentIndex: 3, status: "scene_end" as const };
    const next = advanceScene(state, consequenceScene, sceneIdx);
    expect("error" in next).toBe(false);
    if (!("error" in next)) {
      expect(next.currentSceneId).toBe("scene_05_ending");
      expect(next.status).toBe("story_complete");
    }
  });

  it("should return an error object for an invalid next_scene_id", () => {
    const sceneIdx = buildSceneIndex(dummyStory);
    // Create a modified scene with a bad reference
    const badScene: Scene = {
      ...(sceneIdx.get("scene_01_intro") as Extract<Scene, { type: "narrative" }>),
      next_scene_id: "scene_NONEXISTENT",
    };
    const state = { currentSceneId: "scene_01_intro", contentIndex: 4, status: "scene_end" as const };
    const result = advanceScene(state, badScene, sceneIdx);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("scene_NONEXISTENT");
    }
  });

  it("should be a no-op when status is already story_complete", () => {
    const sceneIdx = buildSceneIndex(dummyStory);
    const scene = sceneIdx.get("scene_05_ending")!;
    const state = { currentSceneId: "scene_05_ending", contentIndex: 0, status: "story_complete" as const };
    const result = advanceScene(state, scene, sceneIdx);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.status).toBe("story_complete");
    }
  });
});

// ── 5. Ending scene detection ────────────────────────────────────────────────

describe("deriveStatusForScene — ending scene", () => {
  it("should immediately set story_complete for an ending scene", () => {
    const sceneIdx = buildSceneIndex(dummyStory);
    const endingScene = sceneIdx.get("scene_05_ending")!;
    const state = deriveStatusForScene(endingScene, 0);
    expect(state.status).toBe("story_complete");
  });
});

// ── 6. Puzzle scene detection ────────────────────────────────────────────────

describe("deriveStatusForScene — puzzle scene", () => {
  it("should set status to 'puzzle' for a puzzle scene", () => {
    const sceneIdx = buildSceneIndex(dummyStory);
    const puzzleScene = sceneIdx.get("scene_03_puzzle")!;
    const state = deriveStatusForScene(puzzleScene, 0);
    expect(state.status).toBe("puzzle");
  });
});

// ── 7. getChapterForScene ────────────────────────────────────────────────────

describe("getChapterForScene", () => {
  it("should return the correct chapter for a known scene", () => {
    const chapter = getChapterForScene(dummyStory, "scene_01_intro");
    expect(chapter).toBeDefined();
    expect(chapter?.chapter_id).toBe("chapter_01");
  });

  it("should return undefined for an unknown scene_id", () => {
    const chapter = getChapterForScene(dummyStory, "scene_GHOST");
    expect(chapter).toBeUndefined();
  });
});
