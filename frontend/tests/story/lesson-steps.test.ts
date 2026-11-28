/**
 * lesson-steps.test.ts — lesson chunks are one step.
 *
 * Why: a long lesson body is stored as consecutive `learning_info` blocks with the same
 * title and visual. The heading and the canvas key must count steps, not chunks.
 */
import { describe, expect, it } from "vitest";
import { lessonStepInfo } from "@/lib/story/lesson-steps";
import type { SceneContent } from "@/lib/types/scene";
import type { LessonVisual } from "@/lib/types/visual";

const visual: LessonVisual = { kind: "formula", expression: "a + b", terms: [{ symbol: "a", meaning: "first" }] };

function lesson(title: string, body: string, v?: LessonVisual): SceneContent {
  return { type: "learning_info", title, body, concept_ids: ["c1"], ...(v ? { visual: v } : {}) };
}
const talk: SceneContent = { type: "dialogue", character_id: "m", expression: "calm", text: "Look." };

describe("lessonStepInfo", () => {
  it("is null for a block that is not a lesson, or out of range", () => {
    const blocks = [talk, lesson("A", "x")];
    expect(lessonStepInfo(blocks, 0)).toBeNull();
    expect(lessonStepInfo(blocks, 5)).toBeNull();
    expect(lessonStepInfo(blocks, -1)).toBeNull();
  });

  it("counts a single lesson block as one step of one chunk", () => {
    expect(lessonStepInfo([lesson("A", "x")], 0)).toEqual({ index: 0, total: 1, chunk: 0, chunks: 1 });
  });

  it("treats consecutive blocks with the same title and visual as chunks of one step", () => {
    const blocks = [lesson("A", "one", visual), lesson("A", "two", visual), lesson("A", "three", visual)];
    expect(lessonStepInfo(blocks, 0)).toEqual({ index: 0, total: 1, chunk: 0, chunks: 3 });
    expect(lessonStepInfo(blocks, 2)).toEqual({ index: 0, total: 1, chunk: 2, chunks: 3 });
  });

  it("numbers steps, not chunks, across a companion line", () => {
    const blocks = [
      lesson("Concept", "a1", visual),
      lesson("Concept", "a2", visual),
      talk,
      lesson("How it works", "b1"),
      lesson("How it works", "b2"),
      lesson("Worked example", "c1"),
    ];
    expect(lessonStepInfo(blocks, 1)).toEqual({ index: 0, total: 3, chunk: 1, chunks: 2 });
    expect(lessonStepInfo(blocks, 4)).toEqual({ index: 1, total: 3, chunk: 1, chunks: 2 });
    expect(lessonStepInfo(blocks, 5)).toEqual({ index: 2, total: 3, chunk: 0, chunks: 1 });
  });

  it("starts a new step when only the visual differs", () => {
    const other: LessonVisual = { kind: "formula", expression: "a - b", terms: [{ symbol: "a", meaning: "first" }] };
    const blocks = [lesson("A", "one", visual), lesson("A", "two", other)];
    expect(lessonStepInfo(blocks, 1)).toEqual({ index: 1, total: 2, chunk: 0, chunks: 1 });
  });
});
