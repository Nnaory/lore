/**
 * Tests: GenerationScreen with the animating stage (design 7.5 UI, Requirement 24.11)
 *
 * @vitest-environment jsdom
 *
 * `generation-screen.test.tsx` (unchanged) holds the screen with the flag off. Here the flag is
 * set per test with `vi.stubEnv`. Checked: with the flag off (unset, `off` or a wrong value) the
 * screen has the four old steps, no animation section and the old hint line; with the flag on a
 * fifth step "Animating the lessons" follows the story step and goes pending, active and done; a
 * run that already has an animating phase shows the step even when the flag reads off; the
 * progress section and its controls appear in the animating stage and call the handlers.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GenerationScreen } from "@/components/setup/GenerationScreen";
import {
  generationReducer,
  initialGenerationState,
  type AnimationJob,
  type GenerationAction,
  type GenerationState,
} from "@/lib/generation/generation";
import { dummyCampaign, dummyMaterial } from "@/data/dummy-campaign";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

const ids = dummyMaterial.concepts.map((c) => c.concept_id);

function job(id: string): AnimationJob {
  return {
    id,
    storyId: "story_01",
    target: { kind: "puzzle", puzzle_id: id },
    title: `Question ${id}`,
    status: "pending",
    stage: null,
    attempt: 0,
  };
}

/** A run that has written its stories and entered the animating stage. */
function animating(jobIds: string[], ...actions: GenerationAction[]): GenerationState {
  const written: GenerationState = {
    ...initialGenerationState,
    stage: "writing",
    status: "running",
    material: dummyMaterial,
    selectedConceptIds: ids,
    campaign: dummyCampaign,
  };
  return [{ type: "animating_started", jobs: jobIds.map(job) } as GenerationAction, ...actions].reduce(
    generationReducer,
    written
  );
}

function setup(state: GenerationState) {
  const handlers = {
    onToggleConcept: vi.fn(),
    onConfirmConcepts: vi.fn(),
    onRetry: vi.fn(),
    onBack: vi.fn(),
    onRetryAnimation: vi.fn(),
    onSkipAnimation: vi.fn(),
  };
  render(<GenerationScreen state={state} sourceLabel="3 pages" {...handlers} />);
  return handlers;
}

const stepIds = () =>
  Array.from(screen.getByTestId("generation-steps").children).map((li) => (li as HTMLElement).dataset.testid);

const writing = (patch: Partial<GenerationState> = {}): GenerationState => ({
  ...initialGenerationState,
  stage: "writing",
  material: dummyMaterial,
  selectedConceptIds: ids,
  campaign: dummyCampaign,
  ...patch,
});

describe("GenerationScreen: flag off", () => {
  it.each([
    ["unset", undefined],
    ["off", "off"],
    ["a wrong value", "ON"],
  ])("shows the four old steps and nothing about animations (%s)", (_name, value) => {
    if (value !== undefined) vi.stubEnv("NEXT_PUBLIC_ANIMATIONS", value);
    setup(writing());
    expect(stepIds()).toEqual(["step-analyzing", "step-reviewing", "step-planning", "step-writing"]);
    expect(screen.queryByTestId("step-animating")).toBeNull();
    expect(screen.queryByTestId("animation-progress")).toBeNull();
    expect(screen.getByTestId("step-writing").dataset.status).toBe("active");
    expect(screen.getByText("This usually takes a few seconds per step.")).toBeTruthy();
  });

  it("marks writing done and shows no animation section when the run is done", () => {
    setup(writing({ stage: "done", status: "waiting" }));
    expect(screen.getByTestId("step-writing").dataset.status).toBe("done");
    expect(screen.queryByTestId("animation-progress")).toBeNull();
  });
});

describe("GenerationScreen: flag on", () => {
  it("adds the animating step after the story step, pending while the story is written", () => {
    vi.stubEnv("NEXT_PUBLIC_ANIMATIONS", "on");
    setup(writing());
    expect(stepIds()).toEqual([
      "step-analyzing",
      "step-reviewing",
      "step-planning",
      "step-writing",
      "step-animating",
    ]);
    expect(screen.getByTestId("step-animating").textContent).toContain("Animating the lessons");
    expect(screen.getByTestId("step-writing").dataset.status).toBe("active");
    expect(screen.getByTestId("step-animating").dataset.status).toBe("pending");
    expect(screen.queryByTestId("animation-progress")).toBeNull();
  });

  it("keeps the earlier steps as they were on the first stages", () => {
    vi.stubEnv("NEXT_PUBLIC_ANIMATIONS", "on");
    setup(initialGenerationState);
    expect(["analyzing", "reviewing", "planning", "writing", "animating"].map(
      (s) => screen.getByTestId(`step-${s}`).dataset.status
    )).toEqual(["active", "pending", "pending", "pending", "pending"]);
  });

  it("marks writing done and animating active in the animating stage, with the section and its own hint", () => {
    vi.stubEnv("NEXT_PUBLIC_ANIMATIONS", "on");
    setup(animating(["a", "b"], { type: "animation_job_started", jobId: "a" }));
    expect(screen.getByTestId("step-writing").dataset.status).toBe("done");
    expect(screen.getByTestId("step-animating").dataset.status).toBe("active");
    expect(screen.getByTestId("animation-progress")).toBeTruthy();
    expect(screen.getByTestId("animation-count").textContent).toBe("0 / 2");
    // The "few seconds per step" line is wrong for animations; the section has its own hint.
    expect(screen.queryByText("This usually takes a few seconds per step.")).toBeNull();
    expect(screen.getByTestId("animation-hint")).toBeTruthy();
    // The world preview stays above the animations.
    expect(screen.getByTestId("world-preview")).toBeTruthy();
  });

  it("marks the animating step done when the stage is over", () => {
    vi.stubEnv("NEXT_PUBLIC_ANIMATIONS", "on");
    const finished = animating(
      ["a"],
      { type: "animation_job_started", jobId: "a" },
      { type: "animation_job_failed", jobId: "a", code: "NETWORK" },
      { type: "animation_skip_requested" },
      { type: "animating_finished" }
    );
    expect(finished.stage).toBe("done");
    setup(finished);
    expect(screen.getByTestId("step-animating").dataset.status).toBe("done");
    expect(screen.getByTestId("animation-progress").dataset.mode).toBe("closed");
  });
});

describe("GenerationScreen: a run that reached the animating stage", () => {
  it("shows the animating step even when the flag reads off", () => {
    setup(animating(["a"]));
    expect(screen.getByTestId("step-animating").dataset.status).toBe("active");
    expect(screen.getByTestId("animation-progress")).toBeTruthy();
  });

  it("calls the animation handlers, not the stage handlers, from the two controls", () => {
    const h = setup(
      animating(["a", "b"], { type: "animation_job_started", jobId: "a" }, {
        type: "animation_job_failed",
        jobId: "a",
        code: "NETWORK",
      }, { type: "animation_job_started", jobId: "b" }, { type: "animation_job_failed", jobId: "b", code: "NETWORK" })
    );
    expect(screen.getByTestId("animation-progress").dataset.mode).toBe("waiting");
    fireEvent.click(screen.getByTestId("animation-retry"));
    expect(h.onRetryAnimation).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("animation-skip"));
    expect(h.onSkipAnimation).toHaveBeenCalledTimes(1);
    expect(h.onRetry).not.toHaveBeenCalled();
    expect(h.onBack).not.toHaveBeenCalled();
  });

  it("never shows the stage failure controls or the back button while animating", () => {
    setup(animating(["a"], { type: "animation_job_started", jobId: "a" }, {
      type: "animation_job_failed",
      jobId: "a",
      code: "ANIMATION_VERIFICATION_FAILED",
    }));
    expect(screen.queryByTestId("generation-retry")).toBeNull();
    expect(screen.queryByTestId("generation-error")).toBeNull();
    expect(screen.queryByTestId("generation-back")).toBeNull();
  });
});
