/**
 * Tests: /create passes the animation controls to the generation screen (design 7.5 UI)
 *
 * @vitest-environment jsdom
 *
 * `useGeneration` is replaced by a stub that holds a state in the animating stage and records the
 * calls, so the test checks only the wiring of the page: the screen's `animation-retry` and
 * `animation-skip` reach `generation.retryAnimation` and `generation.skipAnimation`, and nothing
 * else of the stub is called by them. The full flow (requests, windows, timers) is in
 * `tests/generation/animating-flow.test.ts`; `create-page.test.tsx` covers the page with the flag off.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import CreatePage from "@/app/create/page";
import { generationReducer, initialGenerationState, type AnimationJob, type GenerationAction } from "@/lib/generation/generation";
import { takePendingMaterial } from "@/lib/setup/pending-material";
import { freshStore } from "../fixtures/fresh-store";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const stub = vi.hoisted(() => ({
  state: null as unknown,
  start: vi.fn(),
  retry: vi.fn(),
  cancel: vi.fn(),
  reset: vi.fn(),
  retryAnimation: vi.fn(),
  skipAnimation: vi.fn(),
  confirmConcepts: vi.fn(),
  toggleConcept: vi.fn(),
}));

vi.mock("@/lib/generation/use-generation", () => ({
  useGeneration: () => ({
    state: stub.state,
    start: stub.start,
    retry: stub.retry,
    cancel: stub.cancel,
    reset: stub.reset,
    retryAnimation: stub.retryAnimation,
    skipAnimation: stub.skipAnimation,
    confirmConcepts: stub.confirmConcepts,
    toggleConcept: stub.toggleConcept,
  }),
}));

beforeEach(() => {
  takePendingMaterial();
  return freshStore();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

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

/** A held animating stage: one job failed, so the screen offers retry and skip. */
function heldState() {
  const actions: GenerationAction[] = [
    { type: "animating_started", jobs: [job("a")] },
    { type: "animation_job_started", jobId: "a" },
    { type: "animation_job_failed", jobId: "a", code: "NETWORK" },
  ];
  return actions.reduce(generationReducer, { ...initialGenerationState, stage: "writing" as const });
}

async function openGenerationScreen() {
  const file = new File(["## Vectors\nA vector has direction and size."], "notes.txt", { type: "text/plain" });
  fireEvent.change(screen.getByTestId("material-file-input"), { target: { files: [file] } });
  await screen.findByTestId("document-stats", {}, { timeout: 10_000 });
  fireEvent.click(screen.getByTestId("genre-fantasy").querySelector("input")!);
  await act(async () => {
    fireEvent.click(screen.getByTestId("build-button"));
  });
}

describe("/create: animation controls", () => {
  it("wires animation-retry and animation-skip to the generation hook", async () => {
    stub.state = heldState();
    render(<CreatePage />);
    await openGenerationScreen();

    expect(stub.start).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("animation-progress").dataset.mode).toBe("waiting");

    fireEvent.click(screen.getByTestId("animation-retry"));
    expect(stub.retryAnimation).toHaveBeenCalledTimes(1);
    expect(stub.skipAnimation).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("animation-skip"));
    expect(stub.skipAnimation).toHaveBeenCalledTimes(1);
    expect(stub.retryAnimation).toHaveBeenCalledTimes(1);

    // Neither control is the stage retry or the way back.
    expect(stub.retry).not.toHaveBeenCalled();
    expect(stub.cancel).not.toHaveBeenCalled();
  });
});
