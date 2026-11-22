/**
 * Tests — CanvasPane (the filled CanvasFrame, ui-redesign task 1.26)
 *
 * Covers the frame size, the PlayerBar footer, the puzzle mode (ChoiceButton row,
 * submit/continue, ErrorLine feedback, aria-pressed) and the phone layout, where
 * the choices are not drawn inside the frame.
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";

vi.mock("@remotion/player", () => ({ Player: () => null }));

const { CanvasPane } = await import("@/components/stage/CanvasPane");
const { usePuzzleInteraction } = await import("@/components/story/use-puzzle-interaction");
const { dummyStory } = await import("@/data/dummy-campaign");
import type { FramedScene } from "@/components/stage/CanvasPane";

const puzzle = dummyStory.puzzles[0]; // correct: choice_B, wrong: choice_A / choice_C

const lesson: FramedScene = { kind: "lesson", props: { title: "Vectors", body: "Arrows with length.", seed: 1 } };

function Harness({ layout = "desktop", onComplete = () => {} }: { layout?: "desktop" | "phone"; onComplete?: () => void }) {
  const interaction = usePuzzleInteraction(puzzle, {});
  const scene: FramedScene = { kind: "decision", props: { label: "", count: puzzle.choices.length, seed: 1 } };
  return (
    <CanvasPane
      scene={scene}
      sceneKey="p"
      pacing="fast"
      layout={layout}
      label="Fire Triangle"
      puzzle={{ puzzle, interaction, onComplete }}
    />
  );
}

describe("CanvasPane frame", () => {
  it("is 736x414 on desktop with a label, a player and a PlayerBar", () => {
    const view = render(<CanvasPane scene={lesson} sceneKey="l" pacing="fast" layout="desktop" label="Vectors Intro" />);
    const frame = view.getByRole("region", { name: "Interactive canvas" });
    expect(frame.className).toContain("w-[736px]");
    expect(frame.className).toContain("h-[414px]");
    expect(frame.textContent).toContain("/ vectors_intro");
    expect(view.getByTestId("stage-canvas").getAttribute("data-canvas-kind")).toBe("lesson");
    expect(view.getByRole("button", { name: "Play animation" })).toBeTruthy();
    expect(view.queryByTestId("puzzle-interaction")).toBeNull();
  });

  it("is 366x246 on phone", () => {
    const view = render(<CanvasPane scene={lesson} sceneKey="l" pacing="fast" layout="phone" label="x" />);
    const frame = view.getByRole("region", { name: "Interactive canvas" });
    expect(frame.className).toContain("w-[366px]");
    expect(frame.className).toContain("h-[246px]");
  });
});

describe("CanvasPane puzzle mode", () => {
  it("shows the PAUSED chip, choices with aria-pressed and a disabled submit", () => {
    const view = render(<Harness />);
    expect(view.getByText("PAUSED · YOUR MOVE")).toBeTruthy();
    expect(view.getByTestId("puzzle-question").textContent).toContain("Crystal A");
    for (const c of puzzle.choices) expect(view.getByTestId(`choice-${c.choice_id}`)).toHaveAttribute("aria-pressed", "false");
    expect(view.getByTestId("puzzle-submit")).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(view.getByTestId("choice-choice_A"));
    expect(view.getByTestId("choice-choice_A")).toHaveAttribute("aria-pressed", "true");
    expect(view.getByTestId("choice-choice_B")).toHaveAttribute("aria-pressed", "false");
  });

  it("reports a wrong answer through an ERROR line and lets the player retry", () => {
    const view = render(<Harness />);
    fireEvent.click(view.getByTestId("choice-choice_A"));
    fireEvent.click(view.getByTestId("puzzle-submit"));
    const feedback = view.getByTestId("puzzle-feedback");
    expect(feedback.getAttribute("role")).toBe("alert");
    expect(feedback.textContent).toContain(puzzle.incorrect_feedback);
    fireEvent.click(view.getByTestId("choice-choice_B"));
    expect(view.queryByTestId("puzzle-feedback")).toBeNull();
  });

  it("locks the answer after a correct submit and continues once", () => {
    const onComplete = vi.fn();
    const view = render(<Harness onComplete={onComplete} />);
    fireEvent.click(view.getByTestId("choice-choice_B"));
    fireEvent.click(view.getByTestId("puzzle-submit"));
    expect(view.getByText("RESUMED")).toBeTruthy();
    expect(view.getByTestId("puzzle-explanation")).toBeTruthy();
    expect(view.getByTestId("choice-choice_B")).toBeDisabled();
    expect(view.queryByTestId("puzzle-submit")).toBeNull();
    fireEvent.click(view.getByTestId("puzzle-continue"));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("does not draw the puzzle controls inside the phone frame", () => {
    const view = render(<Harness layout="phone" />);
    expect(view.queryByTestId("puzzle-choices")).toBeNull();
    expect(view.queryByTestId("puzzle-submit")).toBeNull();
  });
});
