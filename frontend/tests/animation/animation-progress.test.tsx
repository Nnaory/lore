/**
 * Tests: AnimationProgress (the animating stage on the generation screen, design 7.5 UI)
 *
 * @vitest-environment jsdom
 *
 * States come from the real reducer, so the screen is tested in the states the flow can reach.
 * Checked: the `k / n` count, one row per job with its `data-testid` and status text, which
 * control exists in which mode (skip while running, both while the flow waits for the player,
 * none once the stage is over), that the clicks reach the handlers, the held state after a stop
 * code (Requirement 36.6 against 24.13: the screen says what is happening and offers both
 * choices), and the Kit rules of AGENTS.md (token classes only, 44px targets).
 *
 * Requirements 24.4, 24.6, 24.7, 24.11, 24.13.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { AnimationProgress } from "@/components/animation/AnimationProgress";
import { BUILD_MESSAGES } from "@/lib/contracts/error-messages";
import {
  generationReducer,
  initialGenerationState,
  type AnimationJob,
  type GenerationAction,
  type GenerationState,
} from "@/lib/generation/generation";
import type { AnimationReference } from "@/lib/types/animation";

afterEach(cleanup);

const reference: AnimationReference = {
  animation_id: "0b0a4c1e-0000-4000-8000-000000000001",
  source_sha256: "a".repeat(64),
  bundle_sha256: "b".repeat(64),
  width: 1280,
  height: 720,
  fps: 30,
  duration_in_frames: 150,
  contract_version: 1,
};

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

function animating(ids: string[], ...actions: GenerationAction[]): GenerationState {
  const start: GenerationState = { ...initialGenerationState, stage: "writing", status: "running" };
  return [{ type: "animating_started", jobs: ids.map(job) } as GenerationAction, ...actions].reduce(
    generationReducer,
    start
  );
}

const started = (jobId: string): GenerationAction => ({ type: "animation_job_started", jobId });
const ready = (jobId: string): GenerationAction => ({ type: "animation_job_ready", jobId, reference });
const failed = (jobId: string, code: string): GenerationAction => ({ type: "animation_job_failed", jobId, code });
const progress = (jobId: string, stage: "generating" | "verifying", attempt: number): GenerationAction => ({
  type: "animation_job_progress",
  jobId,
  stage,
  attempt,
});

function setup(state: GenerationState) {
  const handlers = { onRetry: vi.fn(), onSkip: vi.fn() };
  const view = render(<AnimationProgress state={state} {...handlers} />);
  return { ...handlers, ...view };
}

describe("AnimationProgress: nothing to show", () => {
  it("renders nothing when the run has no animating stage", () => {
    const { container } = setup(initialGenerationState);
    expect(container.innerHTML).toBe("");
    expect(screen.queryByTestId("animation-progress")).toBeNull();
  });
});

describe("AnimationProgress: count and rows", () => {
  it("shows k / n and one row per job with its status", () => {
    setup(
      animating(
        ["a", "b", "c", "d"],
        started("a"),
        ready("a"),
        started("b"),
        failed("b", "ANIMATION_TIMEOUT"),
        started("c"),
        progress("c", "verifying", 2)
      )
    );
    expect(screen.getByTestId("animation-count").textContent).toBe("2 / 4");

    const rows = ["a", "b", "c", "d"].map((id) => screen.getByTestId(`animation-job-${id}`));
    expect(rows.map((row) => row.dataset.status)).toEqual(["ready", "failed", "running", "pending"]);
    expect(rows.map((row) => within(row).getByText(/^Question/).textContent)).toEqual([
      "Question a",
      "Question b",
      "Question c",
      "Question d",
    ]);
    expect(screen.getByTestId("animation-job-detail-a").textContent).toBe("Ready");
    expect(screen.getByTestId("animation-job-detail-b").textContent).toBe(BUILD_MESSAGES.animationTimeout);
    expect(screen.getByTestId("animation-job-detail-c").textContent).toBe("Checking · attempt 2");
    expect(screen.getByTestId("animation-job-detail-d").textContent).toBe("Waiting");
  });

  it("starts at 0 / n and updates the running row as stage events arrive", () => {
    const first = animating(["a"], started("a"));
    const { rerender } = setup(first);
    expect(screen.getByTestId("animation-count").textContent).toBe("0 / 1");
    expect(screen.getByTestId("animation-job-detail-a").textContent).toBe("Starting");

    rerender(<AnimationProgress state={generationReducer(first, progress("a", "generating", 1))} />);
    expect(screen.getByTestId("animation-job-detail-a").textContent).toBe("Writing · attempt 1");
  });

  it("keeps job ids with colons usable as test ids", () => {
    const state = animating(["story_01:lesson:scene_2:0"]);
    setup(state);
    expect(screen.getByTestId("animation-job-story_01:lesson:scene_2:0")).toBeTruthy();
  });

  it("marks a row for a reference that could not be attached with its own message", () => {
    const state = animating(["a"], started("a"), ready("a"), failed("a", "ANIMATION_ATTACH_FAILED"));
    setup(state);
    expect(screen.getByTestId("animation-job-a").dataset.status).toBe("failed");
    expect(screen.getByTestId("animation-job-detail-a").textContent).toBe(BUILD_MESSAGES.animationAttachFailed);
  });
});

describe("AnimationProgress: while jobs run", () => {
  it("offers skip only, tells the player what skipping does, and reports the click", () => {
    const h = setup(animating(["a", "b"], started("a")));
    expect(screen.getByTestId("animation-progress").dataset.mode).toBe("running");
    const skip = screen.getByTestId("animation-skip");
    expect(skip).not.toBeDisabled();
    expect(skip.textContent).toBe("Skip animations");
    expect(screen.queryByTestId("animation-retry")).toBeNull();
    expect(screen.queryByTestId("animation-notice")).toBeNull();
    expect(screen.getByTestId("animation-hint").textContent).toMatch(/few minutes/);

    fireEvent.click(skip);
    expect(h.onSkip).toHaveBeenCalledTimes(1);
    expect(h.onRetry).not.toHaveBeenCalled();
  });

  it("still runs (skip only) when one job failed but another is pending", () => {
    setup(animating(["a", "b"], started("a"), failed("a", "NETWORK")));
    expect(screen.getByTestId("animation-progress").dataset.mode).toBe("running");
    expect(screen.queryByTestId("animation-retry")).toBeNull();
    expect(screen.getByTestId("animation-skip")).toBeTruthy();
  });
});

describe("AnimationProgress: the flow waits for the player", () => {
  const held = () =>
    animating(["a", "b", "c"], started("a"), ready("a"), started("b"), failed("b", "NETWORK"), {
      type: "animation_jobs_skipped",
      jobIds: ["c"],
    });

  it("explains that it waits, offers retry and skip, and reports each click", () => {
    const h = setup(held());
    expect(screen.getByTestId("animation-progress").dataset.mode).toBe("waiting");
    const notice = screen.getByTestId("animation-notice").textContent ?? "";
    expect(notice).toContain("Waiting for your choice.");
    expect(notice).toContain("2 of 3 animations are not ready.");
    expect(screen.queryByTestId("animation-hint")).toBeNull();

    const retry = screen.getByTestId("animation-retry");
    const skip = screen.getByTestId("animation-skip");
    expect(retry).not.toBeDisabled();
    expect(skip).not.toBeDisabled();
    expect(skip.textContent).toBe("Skip and continue");

    fireEvent.click(retry);
    expect(h.onRetry).toHaveBeenCalledTimes(1);
    expect(h.onSkip).not.toHaveBeenCalled();
    fireEvent.click(skip);
    expect(h.onSkip).toHaveBeenCalledTimes(1);
  });

  it("after a stop code shows the failure, the skipped rest, and both choices (nothing happens alone)", () => {
    const state = animating(["a", "b", "c"], started("a"), failed("a", "ANIMATION_NOT_CONFIGURED"), {
      type: "animation_jobs_skipped",
      jobIds: ["b", "c"],
    });
    setup(state);
    expect(state.stage).toBe("animating");
    expect(screen.getByTestId("animation-count").textContent).toBe("3 / 3");
    expect(screen.getByTestId("animation-job-detail-a").textContent).toBe(BUILD_MESSAGES.animationNotConfigured);
    expect(screen.getByTestId("animation-job-b").dataset.status).toBe("skipped");
    expect(screen.getByTestId("animation-job-detail-b").textContent).toBe("Skipped");
    expect(screen.getByTestId("animation-notice").textContent).toContain("3 of 3 animations are not ready.");
    expect(screen.getByTestId("animation-retry")).not.toBeDisabled();
    expect(screen.getByTestId("animation-skip")).not.toBeDisabled();
  });

  it("uses the singular for one job", () => {
    setup(animating(["a"], started("a"), failed("a", "NETWORK")));
    expect(screen.getByTestId("animation-notice").textContent).toContain(
      "1 of 1 animations is not ready. Try again, or skip and open the story with the standard drawing for it."
    );
  });
});

describe("AnimationProgress: skipping and closed", () => {
  it("disables the skip control while the skip is under way and drops retry", () => {
    const h = setup(animating(["a", "b"], started("a"), { type: "animation_skip_requested" }));
    expect(screen.getByTestId("animation-progress").dataset.mode).toBe("skipping");
    const skip = screen.getByTestId("animation-skip");
    expect(skip).toBeDisabled();
    expect(skip.textContent).toBe("Skipping…");
    expect(screen.queryByTestId("animation-retry")).toBeNull();
    fireEvent.click(skip);
    expect(h.onSkip).not.toHaveBeenCalled();
  });

  it("keeps the rows but no controls once the stage is over", () => {
    setup(animating(["a"], started("a"), ready("a"), { type: "animating_finished" }));
    expect(screen.getByTestId("animation-progress").dataset.mode).toBe("closed");
    expect(screen.getByTestId("animation-job-a").dataset.status).toBe("ready");
    expect(screen.getByTestId("animation-count").textContent).toBe("1 / 1");
    expect(screen.queryByTestId("animation-skip")).toBeNull();
    expect(screen.queryByTestId("animation-retry")).toBeNull();
    expect(screen.queryByTestId("animation-notice")).toBeNull();
  });

  it("draws a control only when its handler is given", () => {
    const state = animating(["a"], started("a"), failed("a", "NETWORK"));
    render(<AnimationProgress state={state} />);
    expect(screen.queryByTestId("animation-retry")).toBeNull();
    expect(screen.queryByTestId("animation-skip")).toBeNull();
    expect(screen.getByTestId("animation-notice")).toBeTruthy();
  });
});

describe("AnimationProgress: Kit rules (AGENTS.md)", () => {
  const states = {
    running: () => animating(["a", "b"], started("a"), progress("a", "generating", 1)),
    waiting: () => animating(["a", "b"], started("a"), ready("a"), started("b"), failed("b", "NETWORK")),
    skipping: () => animating(["a"], started("a"), { type: "animation_skip_requested" } as GenerationAction),
  } as const;

  it.each(Object.keys(states) as Array<keyof typeof states>)(
    "%s: no radius, shadow, blur, gradient, hex colour or card, only token classes",
    (name) => {
      const { container } = setup(states[name]());
      const html = container.innerHTML;
      expect(html).not.toMatch(/rounded/);
      expect(html).not.toMatch(/shadow/);
      expect(html).not.toMatch(/blur|backdrop-/);
      expect(html).not.toMatch(/gradient/);
      expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(html).not.toMatch(/\[#|bg-\[|text-\[#|border-\[#/);
      expect(container.querySelector("[style]")).toBeNull();
    }
  );

  it("gives the controls a touch target of 44px or more and full width on phone", () => {
    setup(states.waiting());
    for (const id of ["animation-retry", "animation-skip"]) {
      const classes = screen.getByTestId(id).className;
      const heights = [...classes.matchAll(/min-h-\[(\d+)px\]/g)].map((m) => Number(m[1]));
      expect(Math.max(...heights)).toBeGreaterThanOrEqual(44);
      expect(classes).toContain("w-full");
      expect(classes).toContain("md:w-auto");
    }
  });

  it("labels the section, the list and the marker squares for assistive technology", () => {
    setup(states.waiting());
    expect(screen.getByRole("region", { name: "Lesson animations" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "Animations" })).toBeTruthy();
    const markers = screen.getByTestId("animation-job-a").querySelectorAll('[aria-hidden="true"]');
    expect(markers.length).toBeGreaterThan(0);
  });

  it("puts a data-testid on every button", () => {
    setup(states.waiting());
    for (const button of screen.getAllByRole("button")) {
      expect(button.getAttribute("data-testid")).toMatch(/^animation-(retry|skip)$/);
    }
  });
});
