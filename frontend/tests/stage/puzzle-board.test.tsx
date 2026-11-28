// @vitest-environment jsdom
/**
 * puzzle-board.test.tsx — the canvas of a puzzle (PuzzleBoard and the DecisionGraph fallback).
 *
 * Why: a puzzle used to show three empty boxes and a tiny question line. Now the AI may draw its
 * own picture of the problem (same primitives as a lesson), the question is written large on the
 * canvas, and a puzzle without a picture shows the question alone, without empty boxes.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Thumbnail } from "@remotion/player";
import { DecisionGraph, DECISION_DURATION } from "@/components/stage/compositions";
import { PuzzleBoard } from "@/components/stage/visual-compositions";
import { visualDuration } from "@/components/stage/visual-layout";
import { CANVAS_FPS, CANVAS_HEIGHT, CANVAS_WIDTH } from "@/components/stage/canvas-layout";
import type { LessonVisual } from "@/lib/types/visual";

function lastFrame(component: unknown, inputProps: Record<string, unknown>, duration: number) {
  return render(
    <Thumbnail
      component={component as React.ComponentType<Record<string, unknown>>}
      inputProps={inputProps}
      compositionWidth={CANVAS_WIDTH}
      compositionHeight={CANVAS_HEIGHT}
      durationInFrames={duration}
      fps={CANVAS_FPS}
      frameToDisplay={duration - 1}
    />,
  );
}

const QUESTION = "Which combination of Crystal A and Crystal B produces the required resonance?";

const vectors: LessonVisual = {
  kind: "vectors",
  vectors: [
    { from: [0, 0], to: [2, 1], label: "A" },
    { from: [0, 0], to: [1, 2], label: "B" },
    { from: [0, 0], to: [5, 4], label: "?", tone: "muted" },
  ],
  caption: "Which sum reaches the dashed arrow?",
};

const table: LessonVisual = {
  kind: "table",
  headers: ["x", "y"],
  rows: [["1", "2"], ["2", "?"]],
};

describe("PuzzleBoard", () => {
  it("draws the heading, the picture, its caption and the question on the last frame", () => {
    const { container } = lastFrame(PuzzleBoard, { question: QUESTION, visual: vectors, seed: 1 }, visualDuration(vectors));
    const text = container.textContent ?? "";
    expect(text).toContain("Puzzle");
    expect(text).toContain(QUESTION);
    expect(text).toContain("Which sum reaches the dashed arrow?");
    for (const label of ["A", "B", "?"]) expect(text).toContain(label);
  });

  it("works for every primitive the AI can pick, with the unknown marked by a question mark", () => {
    const { container } = lastFrame(PuzzleBoard, { question: "What is y when x is 2?", visual: table, seed: 2 }, visualDuration(table));
    const text = container.textContent ?? "";
    expect(text).toContain("What is y when x is 2?");
    expect(text).toContain("?");
  });

  it("clips a very long question instead of letting it run off the canvas", () => {
    const long = "word ".repeat(200).trim();
    const { container } = lastFrame(PuzzleBoard, { question: long, visual: table, seed: 3 }, visualDuration(table));
    // The wrapper has the same text; the question itself is the element with no <div> inside.
    const clamped = Array.from(container.querySelectorAll("div")).find(
      (el) => el.textContent === long && el.querySelector("div") === null,
    );
    expect(clamped).toBeTruthy();
    // `-webkit-line-clamp: 3` is set too; jsdom does not model it, so only the clip is checked here.
    expect((clamped as HTMLElement).style.overflow).toBe("hidden");
  });
});

describe("DecisionGraph (a puzzle without a picture)", () => {
  it("writes the question large and draws no answer boxes", () => {
    const { container } = lastFrame(DecisionGraph, { label: QUESTION, seed: 1 }, DECISION_DURATION);
    expect(container.textContent).toContain(QUESTION);
    // The old composition drew an empty <rect> per answer; the answers are chips now.
    expect(container.querySelectorAll("svg rect").length).toBe(0);
  });

  it("draws the node alone when there is no question", () => {
    const { container } = lastFrame(DecisionGraph, { label: "", seed: 1 }, DECISION_DURATION);
    expect(container.querySelectorAll("svg circle").length).toBeGreaterThanOrEqual(2);
  });
});
