/**
 * Tests: the animating stage inside `useGeneration` (design 7.5 orchestration, Requirement 24, 36.6)
 *
 * @vitest-environment jsdom
 *
 * The hook runs against the fake backend of `tests/fixtures/backend-fetch.ts` for the three story
 * steps, and `createAnimation` is a mock the test controls call by call: it records the request,
 * and it resolves only when the test says so (or with `ABORTED` when its signal aborts, as the
 * real client does). No network. Timers are fake (`setTimeout` and `Date`), so the 60 s window
 * and the 270000 ms limit are crossed by advancing the clock, not by waiting.
 *
 * `waitFor` of Testing Library does not work with fake timers, so `until` flushes promises with
 * `advanceTimersByTimeAsync(0)` inside `act` until the condition holds.
 *
 * The tests of the stages that existed before (`generation.test.tsx`) are not changed; the first
 * group here shows the flag-off path is the old one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { createAnimation } from "@/lib/animation/animation-client";
import { CONTRACT } from "@/lib/animation/contract";
import { selectAnimationTargets } from "@/lib/animation/targets";
import type { AnimationEvent, AnimationResult } from "@/lib/contracts/animation-events";
import type { GenerationRequest } from "@/lib/contracts/generation-request";
import { generationReducer, type AnimationJob } from "@/lib/generation/generation";
import { useGeneration, type GenerationResult } from "@/lib/generation/use-generation";
import { ANIMATION_CLIENT_TIMEOUT_MS } from "@/lib/generation/animating";
import type { AnimationReference, CreateAnimationRequest } from "@/lib/types/animation";
import { backendFetch, fixtureJson, stepPath } from "../fixtures/backend-fetch";

vi.mock("@/lib/animation/animation-client", () => ({ createAnimation: vi.fn() }));

// The reducer is wrapped, not replaced: it still decides, and the test reads the order of actions.
vi.mock("@/lib/generation/generation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/generation/generation")>();
  return { ...actual, generationReducer: vi.fn(actual.generationReducer) };
});

const FLAG = "NEXT_PUBLIC_ANIMATIONS";

// ---------------------------------------------------------------------------
// The mocked animation client
// ---------------------------------------------------------------------------

type Call = {
  request: CreateAnimationRequest;
  signal: AbortSignal;
  fetchImpl: typeof fetch | undefined;
  emit: (event: AnimationEvent) => void;
  finish: (result: AnimationResult) => void;
};

const calls: Call[] = [];

const ABORTED: AnimationResult = { ok: false, code: "ABORTED", message: "The animation request was cancelled." };
const failure = (code: string): AnimationResult => ({ ok: false, code, message: "x" });

let counter = 0;

/** A reference that attaches to `request`'s target; `omitPause` breaks the puzzle pause rule. */
function referenceFor(request: CreateAnimationRequest, omitPause = false): AnimationReference {
  counter += 1;
  const reference: AnimationReference = {
    animation_id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    source_sha256: "a".repeat(64),
    bundle_sha256: "b".repeat(64),
    width: CONTRACT.canvas.width,
    height: CONTRACT.canvas.height,
    fps: CONTRACT.canvas.fps,
    duration_in_frames: 150,
    contract_version: CONTRACT.contract_version,
  };
  if (request.kind === "puzzle" && !omitPause) reference.pause_at_frame = 120;
  return reference;
}

function success(request: CreateAnimationRequest, omitPause = false): AnimationResult {
  return { ok: true, animation: referenceFor(request, omitPause), cached: false, attempts: 1 };
}

// ---------------------------------------------------------------------------
// The fake backend and the hook
// ---------------------------------------------------------------------------

type StoryConfig = {
  /** Stories in the campaign; each has two lesson targets and two puzzle targets by default. */
  stories?: number;
  lessonVisuals?: boolean;
  puzzleVisuals?: boolean;
  /** Makes the first puzzle's question too long for the request: its target cannot be built. */
  longQuestion?: boolean;
  language?: string;
  flag?: string;
};

const FORMULA = { kind: "formula", expression: "a + b = c", terms: [{ symbol: "a", meaning: "first part" }] };

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function envelope(blueprint: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data: { blueprint, meta: {} } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function storyBlueprint(storyId: string, config: StoryConfig): Json {
  const blueprint = structuredClone(fixtureJson<Json>("generate-story.success.json").data.blueprint);
  blueprint.story_id = storyId;
  for (const chapter of blueprint.chapters) {
    for (const scene of chapter.scenes) {
      for (const block of scene.content ?? []) {
        if (config.lessonVisuals === false) delete block.visual;
      }
    }
  }
  blueprint.puzzles.forEach((puzzle: Json, index: number) => {
    if (config.puzzleVisuals !== false) puzzle.visual = structuredClone(FORMULA);
    if (config.longQuestion && index === 0) puzzle.question = "q".repeat(201);
  });
  return blueprint;
}

function campaignBlueprint(ids: string[]): Json {
  const blueprint = structuredClone(fixtureJson<Json>("plan-campaign.success.json").data.blueprint);
  const [first] = blueprint.story_sequence as Json[];
  blueprint.story_sequence = ids.map((id) => ({
    ...first,
    story_id: id,
    title: `Story ${id}`,
    outcomes: first.outcomes.map((o: Json) => ({ ...o, outcome_id: `${o.outcome_id}_${id}` })),
  }));
  return blueprint;
}

function request(config: StoryConfig): GenerationRequest {
  return {
    materials: [{ material: "Linear algebra notes: a linear combination scales vectors." }],
    campaignOptions: { genre: "fantasy" },
    storyOptions: config.language === undefined ? { conceptsPerChapter: 1 } : { conceptsPerChapter: 1, language: config.language },
  };
}

function setup(config: StoryConfig = {}) {
  vi.stubEnv(FLAG, config.flag ?? "on");
  const ids = Array.from({ length: config.stories ?? 1 }, (_, i) => `story_0${i + 1}`);
  const route = backendFetch((call) => {
    if (call.path === stepPath("plan-campaign")) return envelope(campaignBlueprint(ids));
    if (call.path === stepPath("generate-story")) {
      const body = call.body as { story: { story_id: string } };
      return envelope(storyBlueprint(body.story.story_id, config));
    }
    return undefined;
  });
  const onDone = vi.fn<(result: GenerationResult) => void>();
  const hook = renderHook(() => useGeneration({ onDone, fetchImpl: route.fetchImpl }));
  return {
    hook,
    onDone,
    route,
    input: request(config),
    api: () => hook.result.current,
    state: () => hook.result.current.state,
    jobs: (): AnimationJob[] => hook.result.current.state.animation?.jobs ?? [],
    statuses: () => (hook.result.current.state.animation?.jobs ?? []).map((job) => job.status),
  };
}

type Harness = ReturnType<typeof setup>;

// ---------------------------------------------------------------------------
// Driving the hook under fake timers
// ---------------------------------------------------------------------------

const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

async function until(predicate: () => boolean, label: string) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await tick(0);
  }
  throw new Error(`never reached: ${label}`);
}

/** Starts a run, confirms the concepts, and returns once the stories are written. */
async function generate(h: Harness) {
  act(() => h.api().start(h.input));
  await until(() => h.state().stage === "reviewing", "reviewing");
  act(() => h.api().confirmConcepts());
  await until(() => h.state().stage !== "reviewing" && h.state().stage !== "writing" && h.state().stage !== "planning", "stories written");
}

/** Resolves call `index` with `result` (default: a reference that attaches). */
async function complete(index: number, result?: AnimationResult) {
  await act(async () => {
    calls[index].finish(result ?? success(calls[index].request));
    await vi.advanceTimersByTimeAsync(0);
  });
}

const kinds = () => calls.map((call) => call.request.kind);

/** Action types in dispatch order, one per action object (React may run a reducer twice). */
function dispatchedTypes(): string[] {
  const seen = new Set<object>();
  const types: string[] = [];
  for (const [, action] of vi.mocked(generationReducer).mock.calls) {
    if (seen.has(action)) continue;
    seen.add(action);
    types.push(action.type);
  }
  return types;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  calls.length = 0;
  counter = 0;
  vi.mocked(generationReducer).mockClear();
  vi.mocked(createAnimation).mockReset();
  vi.mocked(createAnimation).mockImplementation(
    (req, opts = {}) =>
      new Promise<AnimationResult>((resolve) => {
        const signal = opts.signal ?? new AbortController().signal;
        if (signal.aborted) {
          resolve(ABORTED);
          return;
        }
        // The real client answers `ABORTED` as soon as its signal aborts.
        signal.addEventListener("abort", () => resolve(ABORTED), { once: true });
        calls.push({
          request: req,
          signal,
          fetchImpl: opts.fetchImpl,
          emit: (event) => opts.onEvent?.(event),
          finish: resolve,
        });
      })
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Flag off and no targets: the path that existed before
// ---------------------------------------------------------------------------

describe("flag off", () => {
  it.each(["off", "", "ON", "true", "1"])("with the flag at %j the run is the old one and the client is never called", async (flag) => {
    const h = setup({ flag });
    await generate(h);
    await until(() => h.onDone.mock.calls.length === 1, "onDone");

    expect(createAnimation).not.toHaveBeenCalled();
    expect(h.route.calls.map((c) => c.path)).toEqual([
      stepPath("analyze-material"),
      stepPath("plan-campaign"),
      stepPath("generate-story"),
    ]);
    expect(h.state()).toMatchObject({ stage: "done", status: "waiting", animation: null });
    expect(dispatchedTypes().filter((t) => t.startsWith("animat"))).toEqual([]);
    const stories = h.onDone.mock.calls[0][0].stories;
    expect([...stories.keys()]).toEqual(["story_01"]);
    expect(JSON.stringify([...stories.values()])).not.toContain('"animation":');
  });

  it("is not changed by the player controls: they do nothing without an animating stage", async () => {
    const h = setup({ flag: "off" });
    await generate(h);
    await until(() => h.onDone.mock.calls.length === 1, "onDone");
    act(() => h.api().skipAnimation());
    act(() => h.api().retryAnimation());
    await tick(0);
    expect(h.onDone).toHaveBeenCalledTimes(1);
    expect(h.state().animation).toBeNull();
  });
});

describe("flag on without targets", () => {
  it("goes straight to done like the old path, with onDone once", async () => {
    const h = setup({ lessonVisuals: false, puzzleVisuals: false });
    await generate(h);
    await until(() => h.onDone.mock.calls.length === 1, "onDone");

    expect(createAnimation).not.toHaveBeenCalled();
    expect(h.state()).toMatchObject({ stage: "done", status: "waiting", animation: null });
    expect(dispatchedTypes().filter((t) => t.startsWith("animat"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The happy path: one at a time, in order
// ---------------------------------------------------------------------------

describe("animating one target at a time", () => {
  it("sends one request per target in selection order and attaches every reference once", async () => {
    const h = setup();
    await generate(h);
    await until(() => calls.length === 1, "first request");

    expect(h.state()).toMatchObject({ stage: "animating", status: "running", error: null });
    expect(h.statuses()).toEqual(["running", "pending", "pending", "pending"]);
    expect(calls[0].fetchImpl).toBe(h.route.fetchImpl);
    expect(calls[0].request).toMatchObject({ kind: "lesson", language: "en" });

    // progress of the running request reaches the job
    await act(async () => calls[0].emit({ event: "stage", data: { stage: "verifying", attempt: 2 } }));
    expect(h.jobs()[0]).toMatchObject({ stage: "verifying", attempt: 2 });

    await complete(0);
    await until(() => calls.length === 2, "second request");
    expect(calls).toHaveLength(2); // never two at the same time
    expect(h.statuses()).toEqual(["ready", "running", "pending", "pending"]);
    expect(h.onDone).not.toHaveBeenCalled();

    await complete(1);
    await until(() => calls.length === 3, "third request");
    await complete(2);
    await until(() => calls.length === 4, "fourth request");
    expect(kinds()).toEqual(["lesson", "lesson", "puzzle", "puzzle"]);
    await complete(3);
    await until(() => h.onDone.mock.calls.length === 1, "onDone");

    expect(h.statuses()).toEqual(["ready", "ready", "ready", "ready"]);
    expect(h.state()).toMatchObject({ stage: "done", status: "waiting" });
    expect(h.onDone).toHaveBeenCalledTimes(1);
    const story = h.onDone.mock.calls[0][0].stories.get("story_01")!;
    expect(selectAnimationTargets(story)).toEqual([]); // every target now has its animation
    expect(vi.getTimerCount()).toBe(0);
    expect(dispatchedTypes().filter((t) => t === "animating_finished")).toHaveLength(1);
  });

  it("builds a request whose answer is kept out of the picture: the puzzle forbids its correct choice", async () => {
    const h = setup();
    await generate(h);
    await until(() => calls.length === 1, "first request");
    await complete(0);
    await until(() => calls.length === 2, "second request");
    await complete(1);
    await until(() => calls.length === 3, "third request");
    expect(calls[2].request.forbidden_tokens).toEqual(["The statement that follows from the definition."]);
    expect(calls[0].request).not.toHaveProperty("forbidden_tokens");
  });

  it.each([
    ["id", "id"],
    ["en", "en"],
    ["fr", "en"],
    [undefined, "en"],
  ])("sends language %j as %j", async (language, expected) => {
    const h = setup({ language });
    await generate(h);
    await until(() => calls.length === 1, "first request");
    expect(calls[0].request.language).toBe(expected);
  });

  it("calls onDone again for a second run in the same hook, once per run", async () => {
    const h = setup();
    await generate(h);
    for (let i = 0; i < 4; i += 1) {
      await until(() => calls.length === i + 1, `request ${i + 1}`);
      await complete(i);
    }
    await until(() => h.onDone.mock.calls.length === 1, "first onDone");

    // The four starts are still inside the 60 s window, so the second run waits for it.
    await generate(h);
    await until(() => h.statuses().length === 4, "second run animating");
    expect(calls).toHaveLength(4);
    expect(h.statuses()).toEqual(["pending", "pending", "pending", "pending"]);
    await tick(60_000);
    expect(calls).toHaveLength(5);
    for (let i = 4; i < 8; i += 1) {
      await until(() => calls.length === i + 1, `request ${i + 1}`);
      await complete(i);
    }
    await until(() => h.onDone.mock.calls.length === 2, "second onDone");
    expect(h.onDone).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// The 60 second window
// ---------------------------------------------------------------------------

describe("the 60 second window", () => {
  it("holds the fifth target pending until 60 s after the first start", async () => {
    const h = setup({ stories: 2 });
    await generate(h);
    for (let i = 0; i < 4; i += 1) {
      await until(() => calls.length === i + 1, `request ${i + 1}`);
      await complete(i);
    }
    await tick(0);
    expect(calls).toHaveLength(4);
    expect(h.statuses().slice(4)).toEqual(["pending", "pending", "pending", "pending"]);

    await tick(59_999);
    expect(calls).toHaveLength(4);
    expect(h.jobs()[4].status).toBe("pending");

    await tick(1);
    expect(calls).toHaveLength(5);
    expect(h.jobs()[4].status).toBe("running");

    // The four earlier starts left the window, so the sixth target starts at once.
    await complete(4);
    await until(() => calls.length === 6, "sixth request");
  });
});

// ---------------------------------------------------------------------------
// The 270000 ms limit
// ---------------------------------------------------------------------------

describe("the 270000 ms limit", () => {
  it("aborts a request that never ends, marks it ANIMATION_TIMEOUT, and goes on", async () => {
    expect(ANIMATION_CLIENT_TIMEOUT_MS).toBe(270_000);
    const h = setup();
    await generate(h);
    await until(() => calls.length === 1, "first request");

    await tick(269_999);
    expect(calls[0].signal.aborted).toBe(false);
    expect(h.jobs()[0].status).toBe("running");

    await tick(1);
    expect(calls[0].signal.aborted).toBe(true);
    expect(h.jobs()[0]).toMatchObject({ status: "failed", code: "ANIMATION_TIMEOUT" });
    // The ABORTED that follows its own abort changed nothing, and the next target started.
    await until(() => calls.length === 2, "second request");
    expect(h.jobs()[0]).toMatchObject({ status: "failed", code: "ANIMATION_TIMEOUT" });
    expect(h.state().status).toBe("running");
  });

  it("does not time out a request that already ended", async () => {
    const h = setup();
    await generate(h);
    await until(() => calls.length === 1, "first request");
    await complete(0);
    await until(() => calls.length === 2, "second request");
    expect(calls[0].signal.aborted).toBe(false);
    await tick(269_999);
    expect(calls[0].signal.aborted).toBe(false);
    expect(h.jobs()[0].status).toBe("ready");
  });
});

// ---------------------------------------------------------------------------
// Failures and the player's decision
// ---------------------------------------------------------------------------

describe("when a target fails", () => {
  it("marks it failed and starts the next target for an ordinary error code", async () => {
    const h = setup();
    await generate(h);
    await until(() => calls.length === 1, "first request");
    await complete(0, failure("ANIMATION_VERIFICATION_FAILED"));
    await until(() => calls.length === 2, "second request");

    expect(h.jobs()[0]).toMatchObject({ status: "failed", code: "ANIMATION_VERIFICATION_FAILED" });
    expect(h.jobs()[1].status).toBe("running");
    expect(h.state().status).not.toBe("failed");
    expect(dispatchedTypes()).not.toContain("failed");
  });

  it.each(["ANIMATION_NOT_CONFIGURED", "ANIMATION_QUOTA_EXCEEDED", "RATE_LIMITED"])(
    "%s sends one request, skips the rest, and waits for the player (Requirement 36.6)",
    async (code) => {
      const h = setup();
      await generate(h);
      await until(() => calls.length === 1, "first request");
      await complete(0, failure(code));
      await tick(0);

      expect(calls).toHaveLength(1);
      expect(h.statuses()).toEqual(["failed", "skipped", "skipped", "skipped"]);
      expect(h.jobs()[0].code).toBe(code);
      expect(h.state()).toMatchObject({ stage: "animating", status: "waiting" });
      expect(h.onDone).not.toHaveBeenCalled();

      act(() => h.api().skipAnimation());
      await tick(0);
      expect(h.onDone).toHaveBeenCalledTimes(1);
      expect(h.state().stage).toBe("done");
      const story = h.onDone.mock.calls[0][0].stories.get("story_01")!;
      expect(selectAnimationTargets(story)).toHaveLength(4); // no new reference
      expect(JSON.stringify([...h.onDone.mock.calls[0][0].stories.values()])).not.toContain('"animation":');

      // later clicks change nothing
      act(() => h.api().skipAnimation());
      act(() => h.api().retryAnimation());
      await tick(60_000);
      expect(calls).toHaveLength(1);
      expect(h.onDone).toHaveBeenCalledTimes(1);
    }
  );

  it("fails a target whose request cannot be built without sending it", async () => {
    const h = setup({ longQuestion: true });
    await generate(h);
    await until(() => calls.length === 1, "first request");
    await complete(0);
    await until(() => calls.length === 2, "second request");
    await complete(1);
    // the first puzzle (a 201-character question) is refused; the next target is the second puzzle
    await until(() => calls.length === 3, "third request");

    expect(kinds()).toEqual(["lesson", "lesson", "puzzle"]);
    expect(h.jobs()[2]).toMatchObject({ status: "failed", code: "REQUEST_INVALID" });
    expect(h.jobs()[3].status).toBe("running");
    await complete(2);
    await tick(0);
    expect(h.state()).toMatchObject({ stage: "animating", status: "waiting" });
    expect(h.onDone).not.toHaveBeenCalled();
  });

  it("keeps onDone until the player chooses, then attaches what is ready", async () => {
    const h = setup();
    await generate(h);
    await until(() => calls.length === 1, "first request");
    await complete(0);
    await until(() => calls.length === 2, "second request");
    await complete(1, failure("ANIMATION_VERIFICATION_FAILED"));
    await until(() => calls.length === 3, "third request");
    await complete(2);
    await until(() => calls.length === 4, "fourth request");
    await complete(3);
    await tick(0);

    expect(h.statuses()).toEqual(["ready", "failed", "ready", "ready"]);
    expect(h.state()).toMatchObject({ stage: "animating", status: "waiting" });
    expect(h.onDone).not.toHaveBeenCalled();

    act(() => h.api().skipAnimation());
    await tick(0);
    expect(h.onDone).toHaveBeenCalledTimes(1);
    const story = h.onDone.mock.calls[0][0].stories.get("story_01")!;
    expect(selectAnimationTargets(story)).toHaveLength(1); // only the failed target is still bare
    expect(h.statuses()).toEqual(["ready", "failed", "ready", "ready"]);
  });
});

describe("retry", () => {
  it("runs only the failed targets again and keeps the ready ones", async () => {
    const h = setup();
    await generate(h);
    const answers: Array<AnimationResult | undefined> = [
      undefined,
      failure("ANIMATION_VERIFICATION_FAILED"),
      undefined,
      failure("ANIMATION_STORAGE_FAILED"),
    ];
    for (let i = 0; i < 4; i += 1) {
      await until(() => calls.length === i + 1, `request ${i + 1}`);
      await complete(i, answers[i]);
    }
    await tick(0);
    expect(h.statuses()).toEqual(["ready", "failed", "ready", "failed"]);

    act(() => h.api().retryAnimation());
    expect(h.state().status).toBe("running");
    await tick(0);
    // Four starts are inside the last minute, so the retried targets wait for the window.
    expect(h.statuses()).toEqual(["ready", "pending", "ready", "pending"]);
    expect(h.jobs()[1].code).toBeUndefined();
    expect(calls).toHaveLength(4);
    await tick(60_000);
    expect(calls).toHaveLength(5);
    expect(calls[4].request).toEqual(calls[1].request);
    await complete(4);
    await until(() => calls.length === 6, "sixth request");
    expect(calls[5].request).toEqual(calls[3].request);
    await complete(5);
    await until(() => h.onDone.mock.calls.length === 1, "onDone");

    expect(calls).toHaveLength(6); // the ready targets were not asked again
    expect(h.statuses()).toEqual(["ready", "ready", "ready", "ready"]);
    const story = h.onDone.mock.calls[0][0].stories.get("story_01")!;
    expect(selectAnimationTargets(story)).toEqual([]);
  });

  it("runs the skipped targets again after a stop code", async () => {
    const h = setup();
    await generate(h);
    await until(() => calls.length === 1, "first request");
    await complete(0, failure("RATE_LIMITED"));
    await tick(0);
    expect(h.statuses()).toEqual(["failed", "skipped", "skipped", "skipped"]);

    act(() => h.api().retryAnimation());
    await tick(0);
    expect(calls).toHaveLength(2);
    expect(h.state().animation?.skipRequested).toBe(false);
    for (let i = 1; i < 5; i += 1) {
      // the failed request and the first three retried ones are four starts in one minute
      if (i === 4) await tick(60_000);
      await until(() => calls.length === i + 1, `request ${i + 1}`);
      await complete(i);
    }
    await until(() => h.onDone.mock.calls.length === 1, "onDone");
    expect(h.statuses()).toEqual(["ready", "ready", "ready", "ready"]);
  });

  it("does nothing while a request is running", async () => {
    const h = setup();
    await generate(h);
    await until(() => calls.length === 1, "first request");
    act(() => h.api().retryAnimation());
    await tick(0);
    expect(calls).toHaveLength(1);
    expect(h.statuses()).toEqual(["running", "pending", "pending", "pending"]);
  });
});

// ---------------------------------------------------------------------------
// Skip
// ---------------------------------------------------------------------------

describe("skip", () => {
  it("aborts the running request, skips every unfinished target, and finishes with onDone once", async () => {
    const h = setup();
    await generate(h);
    await until(() => calls.length === 1, "first request");
    act(() => h.api().skipAnimation());
    await tick(0);

    expect(calls[0].signal.aborted).toBe(true);
    expect(calls).toHaveLength(1);
    expect(h.statuses()).toEqual(["skipped", "skipped", "skipped", "skipped"]);
    expect(h.state().animation?.skipRequested).toBe(true);
    expect(h.state()).toMatchObject({ stage: "done", status: "waiting" });
    expect(h.onDone).toHaveBeenCalledTimes(1);

    // order: the reducer learns of the skip, then the jobs are marked skipped; nothing failed
    const types = dispatchedTypes();
    expect(types.indexOf("animation_skip_requested")).toBeGreaterThan(-1);
    expect(types.indexOf("animation_skip_requested")).toBeLessThan(types.indexOf("animation_jobs_skipped"));
    expect(types).not.toContain("animation_job_failed");
    expect(types.filter((t) => t === "animating_finished")).toHaveLength(1);

    act(() => h.api().skipAnimation());
    await tick(0);
    expect(h.onDone).toHaveBeenCalledTimes(1);
  });

  it("keeps the animations that were ready when the player skips", async () => {
    const h = setup();
    await generate(h);
    await until(() => calls.length === 1, "first request");
    await complete(0);
    await until(() => calls.length === 2, "second request");
    act(() => h.api().skipAnimation());
    await tick(0);

    expect(h.statuses()).toEqual(["ready", "skipped", "skipped", "skipped"]);
    expect(h.onDone).toHaveBeenCalledTimes(1);
    const story = h.onDone.mock.calls[0][0].stories.get("story_01")!;
    expect(selectAnimationTargets(story)).toHaveLength(3);
  });

  it("stops the wait for the 60 s window", async () => {
    const h = setup({ stories: 2 });
    await generate(h);
    for (let i = 0; i < 4; i += 1) {
      await until(() => calls.length === i + 1, `request ${i + 1}`);
      await complete(i);
    }
    await tick(0);
    expect(h.jobs()[4].status).toBe("pending");

    act(() => h.api().skipAnimation());
    await tick(0);
    expect(h.statuses()).toEqual(["ready", "ready", "ready", "ready", "skipped", "skipped", "skipped", "skipped"]);
    expect(h.onDone).toHaveBeenCalledTimes(1);
    await tick(120_000);
    expect(calls).toHaveLength(4);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// attachAnimation refuses a reference
// ---------------------------------------------------------------------------

describe("when attachAnimation refuses a reference", () => {
  it("marks that target failed, keeps its story bare, and still calls onDone once", async () => {
    const h = setup();
    await generate(h);
    for (let i = 0; i < 4; i += 1) {
      await until(() => calls.length === i + 1, `request ${i + 1}`);
      // a puzzle reference without `pause_at_frame` breaks the contract's pause rule
      await complete(i, i === 2 ? success(calls[i].request, true) : undefined);
    }
    await until(() => h.onDone.mock.calls.length === 1, "onDone");

    expect(h.statuses()).toEqual(["ready", "ready", "failed", "ready"]);
    expect(h.jobs()[2].code).toBe("ANIMATION_ATTACH_FAILED");
    expect(h.state()).toMatchObject({ stage: "done", status: "waiting" });
    expect(h.onDone).toHaveBeenCalledTimes(1);
    const story = h.onDone.mock.calls[0][0].stories.get("story_01")!;
    expect(selectAnimationTargets(story)).toEqual([h.jobs()[2].target]);

    // the stage is over: the player's controls do nothing
    act(() => h.api().retryAnimation());
    act(() => h.api().skipAnimation());
    await tick(0);
    expect(h.onDone).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Unmount and cancel
// ---------------------------------------------------------------------------

describe("unmount and cancel", () => {
  it("aborts the running request on unmount and ignores its late result", async () => {
    const h = setup();
    await generate(h);
    await until(() => calls.length === 1, "first request");
    h.hook.unmount();

    expect(calls[0].signal.aborted).toBe(true);
    await act(async () => {
      calls[0].finish(success(calls[0].request));
      await vi.advanceTimersByTimeAsync(300_000);
    });
    expect(calls).toHaveLength(1);
    expect(h.onDone).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops the wait for the window on unmount", async () => {
    const h = setup({ stories: 2 });
    await generate(h);
    for (let i = 0; i < 4; i += 1) {
      await until(() => calls.length === i + 1, `request ${i + 1}`);
      await complete(i);
    }
    await tick(0);
    h.hook.unmount();
    await tick(120_000);
    expect(calls).toHaveLength(4);
    expect(h.onDone).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancel() aborts the request and leaves a late result without effect", async () => {
    const h = setup();
    await generate(h);
    await until(() => calls.length === 1, "first request");
    act(() => h.api().cancel());
    expect(calls[0].signal.aborted).toBe(true);
    await complete(0);
    await tick(300_000);

    expect(calls).toHaveLength(1);
    expect(h.onDone).not.toHaveBeenCalled();
    expect(h.state().stage).toBe("animating");
    expect(h.jobs()[0].status).toBe("running");

    // after a cancel the player's controls are inert
    act(() => h.api().skipAnimation());
    act(() => h.api().retryAnimation());
    await tick(0);
    expect(h.onDone).not.toHaveBeenCalled();
  });
});
