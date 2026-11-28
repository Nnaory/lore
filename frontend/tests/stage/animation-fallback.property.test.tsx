/**
 * @vitest-environment jsdom
 *
 * Property 10: Totalitas fallback dan non-interferensi dengan game (task 27.4).
 * Validates: Requirements 31.8, 31.9, 31.13, 30.17
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import fc from "fast-check";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoryViewer } from "@/components/story/StoryViewer";
import { dummyCampaign } from "@/data/dummy-campaign";
import { CONTRACT } from "@/lib/animation/contract";
import type { LoadResult } from "@/lib/animation/loader";
import { PUZZLE_REF, animatedStory } from "../fixtures/animated-story";
import { createSandboxHarness, type SandboxHarness } from "../fixtures/sandbox-harness";

const FLAG = "NEXT_PUBLIC_ANIMATIONS";
const BUNDLE = '"use strict";module.exports.default=function(){return null};';

const loader = vi.hoisted(() => ({ loadAnimation: vi.fn() }));
vi.mock("@/lib/animation/loader", () => ({ loadAnimation: loader.loadAnimation }));

vi.mock("@remotion/player", () => {
  const player = {
    addEventListener: () => {},
    removeEventListener: () => {},
    play: () => {},
    pause: () => {},
    seekTo: () => {},
  };
  return {
    Player: (props: Record<string, unknown>) => {
      const ref = props.ref as ((value: unknown) => void) | undefined;
      return createElement("div", {
        "data-testid": "remotion-player",
        ref: (element: HTMLElement | null) => ref?.(element ? player : null),
      });
    },
  };
});

let harness: SandboxHarness;

function okResult(): LoadResult {
  return {
    ok: true,
    bundle: BUNDLE,
    meta: {
      width: PUZZLE_REF.width,
      height: PUZZLE_REF.height,
      fps: PUZZLE_REF.fps,
      durationInFrames: PUZZLE_REF.duration_in_frames,
      ...(PUZZLE_REF.pause_at_frame !== undefined ? { pauseAtFrame: PUZZLE_REF.pause_at_frame } : {}),
    },
    runtimeMismatch: false,
  };
}

function stubDesktop() {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
  window.matchMedia = ((query: string) => ({
    matches: query.includes("min-width"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function advanceToPuzzle(): void {
  act(() => {
    fireEvent.keyDown(window, { key: "f", code: "KeyF" });
  });
  for (let i = 0; i < 80; i++) {
    if (screen.queryByTestId("puzzle-interaction") !== null) return;
    act(() => {
      fireEvent.keyDown(window, { key: " ", code: "Space" });
    });
  }
  throw new Error("puzzle did not appear");
}

type EventAction =
  | { kind: "ready" }
  | { kind: "loaded" }
  | { kind: "heartbeat" }
  | { kind: "frame"; frame: number; playing: boolean }
  | { kind: "paused"; reason: "interaction" | "end"; frame: number }
  | { kind: "ended" }
  | { kind: "error"; phase: "load" | "runtime"; code: string }
  | { kind: "garbage"; payload: unknown }
  | { kind: "wrongOrigin" }
  | { kind: "tick"; ms: number }
  | { kind: "failLoader"; phase: "urls" | "fetch" | "integrity" };

const actionArb: fc.Arbitrary<EventAction> = fc.oneof(
  fc.constant({ kind: "ready" } as const),
  fc.constant({ kind: "loaded" } as const),
  fc.constant({ kind: "heartbeat" } as const),
  fc.record({
    kind: fc.constant("frame" as const),
    frame: fc.integer({ min: 0, max: PUZZLE_REF.duration_in_frames - 1 }),
    playing: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant("paused" as const),
    reason: fc.constantFrom("interaction" as const, "end" as const),
    frame: fc.integer({ min: 0, max: PUZZLE_REF.duration_in_frames - 1 }),
  }),
  fc.constant({ kind: "ended" } as const),
  fc.record({
    kind: fc.constant("error" as const),
    phase: fc.constantFrom("load" as const, "runtime" as const),
    code: fc.constantFrom("EVAL_THROW", "RENDER_THROW", "CONTRACT_UNSUPPORTED"),
  }),
  fc.record({
    kind: fc.constant("garbage" as const),
    payload: fc.oneof(fc.constant(null), fc.string(), fc.integer(), fc.dictionary(fc.string(), fc.jsonValue())),
  }),
  fc.constant({ kind: "wrongOrigin" } as const),
  fc.record({
    kind: fc.constant("tick" as const),
    ms: fc.integer({ min: 100, max: 15_000 }),
  }),
  fc.record({
    kind: fc.constant("failLoader" as const),
    phase: fc.constantFrom("urls" as const, "fetch" as const, "integrity" as const),
  }),
);

describe("Property 10: Totalitas fallback dan non-interferensi dengan game", () => {
  beforeEach(() => {
    window.localStorage.clear();
    stubDesktop();
    vi.stubEnv(FLAG, "on");
    vi.useFakeTimers();
    harness = createSandboxHarness();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    harness.restore();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("urutan acak pesan protokol, timer, dan kegagalan fase menjaga Stage di playing/paused/Fallback serta HP & isCorrect utuh", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(actionArb, { minLength: 1, maxLength: 12 }),
        fc.boolean(),
        async (actions, answerWrongFirst) => {
          cleanup();
          harness.restore();
          harness = createSandboxHarness();
          let rejectOrResolve: ((res: LoadResult) => void) | null = null;
          loader.loadAnimation.mockReset();
          loader.loadAnimation.mockImplementation(
            () =>
              new Promise<LoadResult>((resolve) => {
                rejectOrResolve = resolve;
              }),
          );

          render(
            <StoryViewer
              story={animatedStory({ lessonRef: null })}
              characters={dummyCampaign.characters}
            />,
          );
          advanceToPuzzle();

          if (answerWrongFirst) {
            act(() => {
              fireEvent.click(screen.getByTestId("choice-choice_A"));
            });
            act(() => {
              fireEvent.click(screen.getByTestId("puzzle-submit"));
            });
          }

          const hpBefore = screen.getByTestId("hp-value").textContent;
          const continueBefore = screen.queryByTestId("puzzle-continue") !== null;

          // Flush microtasks so loader is subscribed
          await act(async () => {
            await Promise.resolve();
          });

          const hasSession = () => harness.postedOfType("load").length > 0;

          for (const action of actions) {
            await act(async () => {
              switch (action.kind) {
                case "ready":
                  harness.ready();
                  break;
                case "loaded":
                  if (hasSession()) {
                    harness.loaded(PUZZLE_REF.duration_in_frames);
                  }
                  break;
                case "heartbeat":
                  if (hasSession()) harness.heartbeat();
                  break;
                case "frame":
                  if (hasSession()) harness.frame(action.frame, action.playing);
                  break;
                case "paused":
                  if (hasSession()) harness.paused(action.reason, action.frame);
                  break;
                case "ended":
                  if (hasSession()) harness.ended();
                  break;
                case "error":
                  if (hasSession()) harness.error(action.phase, action.code);
                  break;
                case "garbage":
                  harness.deliver(action.payload);
                  break;
                case "wrongOrigin":
                  harness.deliver(
                    {
                      source: "lore-sandbox",
                      version: 1,
                      type: "heartbeat",
                      session: hasSession() ? harness.session() : "",
                    },
                    { origin: "https://evil.example" },
                  );
                  break;
                case "tick":
                  vi.advanceTimersByTime(action.ms);
                  break;
                case "failLoader":
                  rejectOrResolve?.({
                    ok: false,
                    phase: action.phase,
                    reason: "network",
                  });
                  rejectOrResolve = null;
                  break;
              }
              await Promise.resolve();
            });

            // Resolve loader if still pending and we haven't failed it yet, so loaded path can be reached
            if (rejectOrResolve && action.kind === "ready") {
              await act(async () => {
                rejectOrResolve?.(okResult());
                rejectOrResolve = null;
                await Promise.resolve();
              });
            }

            const canvas = screen.getByTestId("stage-canvas");
            const status = canvas.getAttribute("data-animation-status");
            const kind = canvas.getAttribute("data-canvas-kind");

            const isPlayingOrPaused = status === "playing" || status === "paused";
            const isFallbackShown = kind !== "animation" && screen.queryByTestId("remotion-player") !== null;
            expect(isPlayingOrPaused || isFallbackShown).toBe(true);

            expect(screen.getByTestId("hp-value").textContent).toBe(hpBefore);
            expect(screen.queryByTestId("puzzle-continue") !== null).toBe(continueBefore);
            expect(CONTRACT.contract_version).toBeGreaterThanOrEqual(1);
          }

          cleanup();
          harness.restore();
          harness = createSandboxHarness();
        },
      ),
      { numRuns: 20 },
    );
  });
});
