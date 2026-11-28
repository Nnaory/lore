/**
 * Test fixture: `linearStory` with AI animation references (task 27.3).
 *
 * Why: the Stage tests for animations need a story whose lesson step is stored as several
 * `learning_info` chunks (same title and visual, the reference on the first chunk only, design
 * K-6) and whose puzzle has a visual and an `animation`. `animatedStory` builds that from
 * `linearStory`; `withoutAnimations` returns the same story with every `animation` key removed,
 * which is what the Stage must draw when the flag is off.
 *
 * Shape (relied on by tests), on top of `linearStory`:
 *   - scene_02_learning: lyra line, three lesson chunks (`CHUNKS`), eldric line, lyra line;
 *   - puzzle_01: `visual` and `animation` (`PUZZLE_REF`, with `pause_at_frame`);
 *   - the first lesson chunk carries `LESSON_REF` (no `pause_at_frame`), the other two none.
 */

import { CONTRACT } from "@/lib/animation/contract";
import type { AnimationReference } from "@/lib/types/animation";
import type { SceneContent } from "@/lib/types/scene";
import type { StoryBlueprint } from "@/lib/types/story";
import type { LessonVisual } from "@/lib/types/visual";
import { linearStory } from "./linear-story";

export const DURATION = 210;
export const PAUSE = 150;

/** A reference the way the backend stores it; the Stage only passes it on. */
function reference(id: string, pause?: number): AnimationReference {
  return {
    animation_id: id,
    source_sha256: "a".repeat(64),
    bundle_sha256: "b".repeat(64),
    width: CONTRACT.canvas.width,
    height: CONTRACT.canvas.height,
    fps: CONTRACT.canvas.fps,
    duration_in_frames: DURATION,
    contract_version: CONTRACT.contract_version,
    ...(pause !== undefined ? { pause_at_frame: pause } : {}),
  };
}

export const LESSON_REF: AnimationReference = reference("00000000-0000-4000-8000-000000000001");
export const PUZZLE_REF: AnimationReference = reference("00000000-0000-4000-8000-000000000002", PAUSE);

export const PICTURE: LessonVisual = {
  kind: "vectors",
  vectors: [
    { from: [0, 0], to: [2, 1], label: "A" },
    { from: [0, 0], to: [5, 4], label: "?", tone: "muted" },
  ],
};

/** The three chunks of the lesson step, in order. */
export const CHUNKS = ["First chunk of the step.", "Second chunk of the step.", "Third chunk of the step."] as const;

export const LESSON_TITLE = "Crystal Vector Resonance";

export interface AnimatedStoryOptions {
  /** Reference on the first lesson chunk; `null` for none. Default `LESSON_REF`. */
  lessonRef?: AnimationReference | null;
  /** Reference on the puzzle; `null` for none. Default `PUZZLE_REF`. */
  puzzleRef?: AnimationReference | null;
  /** Whether the lesson chunks carry `PICTURE`. Default true. */
  lessonVisual?: boolean;
  /** Whether the puzzle carries `PICTURE`. Default true. */
  puzzleVisual?: boolean;
}

export function animatedStory(options: AnimatedStoryOptions = {}): StoryBlueprint {
  const { lessonRef = LESSON_REF, puzzleRef = PUZZLE_REF, lessonVisual = true, puzzleVisual = true } = options;

  const chunk = (body: string, withReference: boolean): SceneContent => ({
    type: "learning_info",
    title: LESSON_TITLE,
    body,
    concept_ids: ["concept_linear_combination"],
    ...(lessonVisual ? { visual: PICTURE } : {}),
    ...(withReference && lessonRef ? { animation: lessonRef } : {}),
  });

  return {
    ...linearStory,
    chapters: linearStory.chapters.map((chapter) => ({
      ...chapter,
      scenes: chapter.scenes.map((scene) => {
        if (scene.scene_id !== "scene_02_learning" || !("content" in scene)) return scene;
        const rest = scene.content.filter((block) => block.type !== "learning_info");
        return {
          ...scene,
          content: [rest[0], chunk(CHUNKS[0], true), chunk(CHUNKS[1], false), chunk(CHUNKS[2], false), ...rest.slice(1)],
        };
      }),
    })),
    puzzles: linearStory.puzzles.map((puzzle) => ({
      ...puzzle,
      ...(puzzleVisual ? { visual: PICTURE } : {}),
      ...(puzzleRef ? { animation: puzzleRef } : {}),
    })),
  };
}

/** The same story with every `animation` key removed from lesson blocks and puzzles. */
export function withoutAnimations(story: StoryBlueprint): StoryBlueprint {
  return {
    ...story,
    chapters: story.chapters.map((chapter) => ({
      ...chapter,
      scenes: chapter.scenes.map((scene) => {
        if (!("content" in scene)) return scene;
        return {
          ...scene,
          content: scene.content.map((block) => {
            if (block.type !== "learning_info") return block;
            const { animation: _animation, ...plain } = block;
            void _animation;
            return plain;
          }),
        };
      }),
    })),
    puzzles: story.puzzles.map((puzzle) => {
      const { animation: _animation, ...plain } = puzzle;
      void _animation;
      return plain;
    }),
  };
}
