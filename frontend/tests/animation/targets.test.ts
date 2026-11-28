/**
 * targets.test.ts — which lessons and puzzles get an animation, the request for one, and how the
 * finished animation is attached to the story (Requirement 23, design 7.2).
 *
 * Why: the four animated targets of a story must be the same on every call, because a target that
 * moves would pay for a second animation of the same lesson and attach it to the wrong place
 * (Requirements 23.3, 23.13). The request must also be rejected, not trimmed, when it does not fit
 * the contract (23.10), because `title` is looked up verbatim on screen by the verifier. Every
 * function here is pure, so each test hands it a deep-frozen story: a mutation would throw.
 *
 * Written before `src/lib/animation/targets.ts` (tests-first, task 21.1).
 */

import { describe, expect, it } from "vitest";
import {
  ANIMATION_CONCEPTS_MAX,
  ANIMATION_FORBIDDEN_TOKEN_MAX,
  ANIMATION_TEXT_MAX,
  ANIMATION_TITLE_MAX,
  CreateAnimationRequestSchema,
} from "@/lib/contracts/animation-requests";
import { CONTRACT } from "@/lib/animation/contract";
import {
  MAX_ANIMATION_TARGETS,
  animationForStep,
  attachAnimation,
  buildAnimationRequest,
  selectAnimationTargets,
} from "@/lib/animation/targets";
import { lessonStepInfo } from "@/lib/story/lesson-steps";
import type { AnimationReference, AnimationTarget } from "@/lib/types/animation";
import type { MaterialBlueprint } from "@/lib/types/material";
import type { Puzzle } from "@/lib/types/puzzle";
import type { LearningContent, NarrationContent, PuzzleScene, Scene, SceneContent } from "@/lib/types/scene";
import type { StoryBlueprint } from "@/lib/types/story";
import type { LessonVisual } from "@/lib/types/visual";
import { linearStory } from "../fixtures/linear-story";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function visualOf(expression: string): LessonVisual {
  return { kind: "formula", expression, terms: [{ symbol: "x", meaning: "the unknown" }] };
}

const narration = (text = "Some narration."): NarrationContent => ({ type: "narration", text });

interface LessonOptions {
  noVisual?: boolean;
  visual?: LessonVisual;
  animation?: AnimationReference;
  body?: string;
}

function lesson(title: string, conceptIds: string[], options: LessonOptions = {}): LearningContent {
  const block: LearningContent = {
    type: "learning_info",
    title,
    body: options.body ?? `Body of ${title}.`,
    concept_ids: conceptIds,
  };
  if (!options.noVisual) block.visual = options.visual ?? visualOf(title);
  if (options.animation) block.animation = options.animation;
  return block;
}

function sceneOf(sceneId: string, content: SceneContent[]): Scene {
  return { scene_id: sceneId, type: "learning", characters_present: [], content, next_scene_id: null };
}

function puzzleSceneOf(sceneId: string, puzzleId: string): PuzzleScene {
  return { scene_id: sceneId, type: "puzzle", characters_present: [], puzzle_id: puzzleId, next_scene_id: null };
}

interface PuzzleOptions {
  noVisual?: boolean;
  animation?: AnimationReference;
  conceptIds?: string[];
}

function puzzleOf(id: string, options: PuzzleOptions = {}): Puzzle {
  const puzzle: Puzzle = {
    puzzle_id: id,
    concept_ids: options.conceptIds ?? ["c1"],
    narrative_context: `Context of ${id}.`,
    question: `Question of ${id}?`,
    choices: [
      { choice_id: "A", text: "wrong one" },
      { choice_id: "B", text: "the right answer" },
      { choice_id: "C", text: "wrong two" },
    ],
    correct_choice_id: "B",
    explanation: "Because.",
    incorrect_feedback: "No.",
    correct_feedback: "Yes.",
    retry_allowed: true,
  };
  if (!options.noVisual) puzzle.visual = visualOf(`visual of ${id}`);
  if (options.animation) puzzle.animation = options.animation;
  return puzzle;
}

/** A story with one chapter per entry of `chapters`. */
function storyOf(chapters: Scene[][], puzzles: Puzzle[] = []): StoryBlueprint {
  return {
    story_id: "story_test",
    material_id: "material_test",
    title: "Test story",
    summary: "A story for tests.",
    character_ids: [],
    chapters: chapters.map((scenes, i) => ({ chapter_id: `chapter_${i + 1}`, title: `Chapter ${i + 1}`, scenes })),
    puzzles,
    endings: [],
    continuity_summary: null,
    knowledge_mapping: [],
  };
}

/** Scene `s<n>` with a narration at block 0 and a lesson on concept `c<n>` at block 1. */
function lessonScene(n: number, options: LessonOptions = {}): Scene {
  return sceneOf(`s${n}`, [narration(), lesson(`Lesson ${n}`, [`c${n}`], options)]);
}

function materialOf(...concepts: Array<[id: string, name: string]>): MaterialBlueprint {
  return {
    material_id: "material_test",
    title: "Material",
    summary: "A material for tests.",
    learning_objectives: [],
    concepts: concepts.map(([concept_id, name]) => ({
      concept_id,
      name,
      definition: `Definition of ${name}.`,
      principles: [],
      methods: [],
      prerequisites: [],
      misconceptions: [],
      source_evidence: ["evidence"],
    })),
    scope_limitations: [],
  };
}

const LESSON_REF: AnimationReference = {
  animation_id: "3f8e2b1c-6d4a-4e5f-9a7b-0c1d2e3f4a5b",
  source_sha256: "a27321c1c0f1407c835394676fb809e185474ec0c0ce213e0c7cffedfa857750",
  bundle_sha256: "9aecee4acec55281859c57184dec790783d3c59b71aaf923de28e1d8b0dc9b73",
  width: CONTRACT.canvas.width,
  height: CONTRACT.canvas.height,
  fps: CONTRACT.canvas.fps,
  duration_in_frames: 150,
  contract_version: CONTRACT.contract_version,
};

const PUZZLE_REF: AnimationReference = {
  ...LESSON_REF,
  animation_id: "7a1b9c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d",
  duration_in_frames: 210,
  pause_at_frame: 180,
};

const lessonTarget = (sceneId: string, blockIndex = 1): AnimationTarget => ({
  kind: "lesson",
  scene_id: sceneId,
  block_index: blockIndex,
});
const puzzleTarget = (puzzleId: string): AnimationTarget => ({ kind: "puzzle", puzzle_id: puzzleId });

const MATERIAL = materialOf(["c1", "Vectors"], ["c2", "Scalars"], ["c3", "Matrices"], ["c4", "Rank"]);

// ---------------------------------------------------------------------------
// selectAnimationTargets
// ---------------------------------------------------------------------------

describe("selectAnimationTargets", () => {
  it("returns nothing for a story without visuals", () => {
    expect(selectAnimationTargets(deepFreeze(storyOf([[]])))).toEqual([]);
    expect(selectAnimationTargets(deepFreeze(linearStory))).toEqual([]);
  });

  it("returns lessons in story order with their scene id and zero-based block index", () => {
    const story = deepFreeze(
      storyOf([
        [lessonScene(1), puzzleSceneOf("p-scene", "pz1")],
        [lessonScene(2), sceneOf("s3", [narration(), narration(), lesson("Lesson 3", ["c3"])])],
      ]),
    );
    expect(selectAnimationTargets(story)).toEqual([
      lessonTarget("s1", 1),
      lessonTarget("s2", 1),
      lessonTarget("s3", 2),
    ]);
  });

  it("skips narration, dialogue and a lesson without a visual", () => {
    const story = deepFreeze(
      storyOf([
        [
          sceneOf("s1", [
            narration(),
            { type: "dialogue", character_id: "x", expression: "calm", text: "Hi." },
            lesson("No picture", ["c1"], { noVisual: true }),
            lesson("With picture", ["c2"]),
          ]),
        ],
      ]),
    );
    expect(selectAnimationTargets(story)).toEqual([lessonTarget("s1", 3)]);
  });

  it("skips a block that shares any concept id with an earlier candidate", () => {
    const story = deepFreeze(
      storyOf([
        [
          sceneOf("s1", [
            lesson("First", ["c1", "c2"]),
            lesson("Same concepts again", ["c1", "c2"]), // a second chunk of the same step
            lesson("Overlaps one", ["c3", "c2"]),
            lesson("Fresh", ["c4"]),
          ]),
        ],
      ]),
    );
    expect(selectAnimationTargets(story)).toEqual([lessonTarget("s1", 0), lessonTarget("s1", 3)]);
  });

  it("does not let a block without a visual claim its concept ids", () => {
    const story = deepFreeze(
      storyOf([
        [sceneOf("s1", [lesson("Plain", ["c1"], { noVisual: true }), lesson("Pictured", ["c1"])])],
      ]),
    );
    expect(selectAnimationTargets(story)).toEqual([lessonTarget("s1", 1)]);
  });

  it("keeps only the first four lesson candidates and no puzzle", () => {
    const lessons = [1, 2, 3, 4, 5, 6].map((n) => lessonScene(n));
    const story = deepFreeze(storyOf([lessons], [puzzleOf("pz1")]));
    expect(MAX_ANIMATION_TARGETS).toBe(4);
    expect(selectAnimationTargets(story)).toEqual([
      lessonTarget("s1"),
      lessonTarget("s2"),
      lessonTarget("s3"),
      lessonTarget("s4"),
    ]);
  });

  it("adds puzzles only while fewer than four lesson candidates exist (A-14)", () => {
    const twoLessons = deepFreeze(
      storyOf([[lessonScene(1), lessonScene(2)]], [puzzleOf("pz1"), puzzleOf("pz2"), puzzleOf("pz3")]),
    );
    expect(selectAnimationTargets(twoLessons)).toEqual([
      lessonTarget("s1"),
      lessonTarget("s2"),
      puzzleTarget("pz1"),
      puzzleTarget("pz2"),
    ]);

    const noLessons = deepFreeze(storyOf([[]], ["a", "b", "c", "d", "e"].map((id) => puzzleOf(id))));
    expect(selectAnimationTargets(noLessons)).toEqual(["a", "b", "c", "d"].map(puzzleTarget));

    const fourLessons = deepFreeze(storyOf([[1, 2, 3, 4].map((n) => lessonScene(n))], [puzzleOf("pz1")]));
    expect(selectAnimationTargets(fourLessons).every((t) => t.kind === "lesson")).toBe(true);
  });

  it("skips a puzzle without a visual and lets the next one take its place", () => {
    const story = deepFreeze(storyOf([[]], [puzzleOf("plain", { noVisual: true }), puzzleOf("pictured")]));
    expect(selectAnimationTargets(story)).toEqual([puzzleTarget("pictured")]);
  });

  it("walks chapters, scenes and puzzles in array order, not by id", () => {
    const story = deepFreeze(
      storyOf([[lessonScene(9)], [lessonScene(2)]], [puzzleOf("zz"), puzzleOf("aa")]),
    );
    expect(selectAnimationTargets(story)).toEqual([
      lessonTarget("s9"),
      lessonTarget("s2"),
      puzzleTarget("zz"),
      puzzleTarget("aa"),
    ]);
  });

  it("lets a candidate that already has an animation keep its slot but drops it from the result", () => {
    const lessons = [
      lessonScene(1, { animation: LESSON_REF }),
      lessonScene(2),
      lessonScene(3),
      lessonScene(4),
      lessonScene(5),
    ];
    const story = deepFreeze(storyOf([lessons]));
    // Slots: s1 (animated), s2, s3, s4. s5 is outside the first four and stays out.
    expect(selectAnimationTargets(story)).toEqual([lessonTarget("s2"), lessonTarget("s3"), lessonTarget("s4")]);
  });

  it("does not pull a fifth candidate in after an animation is attached", () => {
    const story = storyOf([[1, 2, 3, 4, 5, 6].map((n) => lessonScene(n))]);
    const before = selectAnimationTargets(story);
    const attached = attachAnimation(deepFreeze(story), before[1], LESSON_REF);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    const after = selectAnimationTargets(attached.story);
    expect(after).toEqual([before[0], before[2], before[3]]);
  });

  it("holds the slot of an animated puzzle too", () => {
    const story = deepFreeze(
      storyOf(
        [[lessonScene(1), lessonScene(2)]],
        [puzzleOf("pz1", { animation: PUZZLE_REF }), puzzleOf("pz2"), puzzleOf("pz3")],
      ),
    );
    // Candidates: s1, s2, pz1 (animated), pz2. pz3 is the fifth.
    expect(selectAnimationTargets(story)).toEqual([lessonTarget("s1"), lessonTarget("s2"), puzzleTarget("pz2")]);
  });

  it("answers the same on two calls, without duplicates, and does not touch a frozen story", () => {
    const story = deepFreeze(
      storyOf(
        [[lessonScene(1), lessonScene(2), puzzleSceneOf("p", "pz1")]],
        [puzzleOf("pz1"), puzzleOf("pz2")],
      ),
    );
    const first = selectAnimationTargets(story);
    const second = selectAnimationTargets(story);
    expect(second).toEqual(first);
    const keys = first.map((t) => JSON.stringify(t));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("ignores scenes that have no content (puzzle and ending scenes)", () => {
    const story = deepFreeze(
      storyOf([
        [
          puzzleSceneOf("p", "pz1"),
          { scene_id: "e", type: "ending", characters_present: [], ending_id: "end" },
          lessonScene(1),
        ],
      ]),
    );
    expect(selectAnimationTargets(story)).toEqual([lessonTarget("s1")]);
  });
});

// ---------------------------------------------------------------------------
// buildAnimationRequest
// ---------------------------------------------------------------------------

describe("buildAnimationRequest: lesson", () => {
  const story = deepFreeze(
    storyOf([
      [
        sceneOf("s1", [
          narration(),
          lesson("Adding vectors", ["c2", "c1"], { body: "Place the tail of one arrow on the tip of the other." }),
        ]),
      ],
    ]),
  );

  it("copies title, body and visual and names the concepts in concept_ids order", () => {
    const result = buildAnimationRequest(lessonTarget("s1"), story, deepFreeze(MATERIAL), "en");
    expect(result).toEqual({
      ok: true,
      request: {
        kind: "lesson",
        title: "Adding vectors",
        text: "Place the tail of one arrow on the tip of the other.",
        concepts: ["Scalars", "Vectors"],
        visual: visualOf("Adding vectors"),
        language: "en",
      },
    });
  });

  it("does not carry a forbidden_tokens key at all", () => {
    const result = buildAnimationRequest(lessonTarget("s1"), story, MATERIAL, "id");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect("forbidden_tokens" in result.request).toBe(false);
      expect(result.request.language).toBe("id");
    }
  });

  it("returns a request that the request schema accepts unchanged", () => {
    const result = buildAnimationRequest(lessonTarget("s1"), story, MATERIAL, "en");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = CreateAnimationRequestSchema.safeParse(result.request);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const { forbidden_tokens: defaulted, ...rest } = parsed.data;
      expect(defaulted).toEqual([]);
      expect(rest).toEqual(result.request);
    }
  });

  it("drops repeated ids, unknown ids and keeps at most five concept names", () => {
    const many = materialOf(["a", "A"], ["b", "B"], ["c", "C"], ["d", "D"], ["e", "E"], ["f", "F"], ["g", "G"]);
    const repeated = deepFreeze(
      storyOf([
        [sceneOf("s1", [lesson("T", ["a", "a", "ghost", "b", "c", "b", "d", "e", "f", "g"])])],
      ]),
    );
    const result = buildAnimationRequest(lessonTarget("s1", 0), repeated, many, "en");
    expect(ANIMATION_CONCEPTS_MAX).toBe(5);
    expect(result.ok && result.request.concepts).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("does not repeat a name when two concept ids carry the same name", () => {
    const twins = materialOf(["a", "Same"], ["b", "Same"], ["c", "Other"]);
    const twinStory = deepFreeze(storyOf([[sceneOf("s1", [lesson("T", ["a", "b", "c"])])]]));
    const result = buildAnimationRequest(lessonTarget("s1", 0), twinStory, twins, "en");
    expect(result.ok && result.request.concepts).toEqual(["Same", "Other"]);
  });

  it("gives an empty concept list when none of the ids is in the material", () => {
    const orphan = deepFreeze(storyOf([[sceneOf("s1", [lesson("T", ["ghost"])])]]));
    const result = buildAnimationRequest(lessonTarget("s1", 0), orphan, MATERIAL, "en");
    expect(result.ok && result.request.concepts).toEqual([]);
  });

  it("answers the same on two calls and leaves frozen inputs alone", () => {
    const frozenMaterial = deepFreeze(clone(MATERIAL));
    const first = buildAnimationRequest(lessonTarget("s1"), story, frozenMaterial, "en");
    const second = buildAnimationRequest(lessonTarget("s1"), story, frozenMaterial, "en");
    expect(second).toEqual(first);
  });

  it("returns a request that does not share objects with the story", () => {
    const result = buildAnimationRequest(lessonTarget("s1"), story, MATERIAL, "en");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const block = story.chapters[0].scenes[0] as Extract<Scene, { content: SceneContent[] }>;
    expect(result.request.visual).not.toBe((block.content[1] as LearningContent).visual);
  });
});

describe("buildAnimationRequest: puzzle", () => {
  const story = deepFreeze(
    storyOf([[]], [puzzleOf("pz1", { conceptIds: ["c3", "c1", "c3"] })]),
  );

  it("maps question, narrative context, visual and the correct choice text", () => {
    const result = buildAnimationRequest(puzzleTarget("pz1"), story, MATERIAL, "en");
    expect(result).toEqual({
      ok: true,
      request: {
        kind: "puzzle",
        title: "Question of pz1?",
        text: "Context of pz1.",
        concepts: ["Matrices", "Vectors"],
        visual: visualOf("visual of pz1"),
        language: "en",
        forbidden_tokens: ["the right answer"],
      },
    });
  });

  it("never lists a wrong choice as a forbidden token", () => {
    const result = buildAnimationRequest(puzzleTarget("pz1"), story, MATERIAL, "en");
    expect(result.ok && result.request.forbidden_tokens).toEqual(["the right answer"]);
  });

  it("answers the same on two calls", () => {
    const first = buildAnimationRequest(puzzleTarget("pz1"), story, MATERIAL, "id");
    const second = buildAnimationRequest(puzzleTarget("pz1"), story, MATERIAL, "id");
    expect(second).toEqual(first);
  });

  it("accepts a correct choice of exactly 80 characters and sends it trimmed", () => {
    const text = "x".repeat(ANIMATION_FORBIDDEN_TOKEN_MAX);
    const puzzle = puzzleOf("pz1");
    puzzle.choices[1] = { choice_id: "B", text: `  ${text}  ` };
    const result = buildAnimationRequest(puzzleTarget("pz1"), deepFreeze(storyOf([[]], [puzzle])), MATERIAL, "en");
    expect(result.ok && result.request.forbidden_tokens).toEqual([text]);
  });
});

describe("buildAnimationRequest: TARGET_NOT_FOUND", () => {
  const story = deepFreeze(
    storyOf(
      [
        [
          sceneOf("s1", [narration(), lesson("Picture", ["c1"]), lesson("Plain", ["c2"], { noVisual: true })]),
          puzzleSceneOf("p", "pz1"),
        ],
      ],
      [puzzleOf("pz1"), puzzleOf("plain", { noVisual: true })],
    ),
  );
  const reason = (target: AnimationTarget) => {
    const result = buildAnimationRequest(target, story, MATERIAL, "en");
    return result.ok ? "ok" : result.reason;
  };

  it("rejects an unknown scene or puzzle id", () => {
    expect(reason(lessonTarget("nope", 1))).toBe("TARGET_NOT_FOUND");
    expect(reason(puzzleTarget("nope"))).toBe("TARGET_NOT_FOUND");
  });

  it("rejects a block index outside the scene or not a whole number", () => {
    for (const index of [-1, 3, 99, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(reason(lessonTarget("s1", index))).toBe("TARGET_NOT_FOUND");
    }
  });

  it("rejects a block that is not learning_info", () => {
    expect(reason(lessonTarget("s1", 0))).toBe("TARGET_NOT_FOUND");
  });

  it("rejects a lesson or a puzzle without a visual", () => {
    expect(reason(lessonTarget("s1", 2))).toBe("TARGET_NOT_FOUND");
    expect(reason(puzzleTarget("plain"))).toBe("TARGET_NOT_FOUND");
  });

  it("rejects a scene that has no content, and a scene id used as a puzzle id", () => {
    expect(reason(lessonTarget("p", 0))).toBe("TARGET_NOT_FOUND");
    expect(reason(puzzleTarget("s1"))).toBe("TARGET_NOT_FOUND");
  });

  it("rejects a target of an unknown kind without throwing", () => {
    expect(reason({ kind: "video", id: "x" } as unknown as AnimationTarget)).toBe("TARGET_NOT_FOUND");
  });
});

describe("buildAnimationRequest: REQUEST_INVALID", () => {
  const lessonRequest = (options: { title?: string; body?: string; visual?: LessonVisual }) =>
    buildAnimationRequest(
      lessonTarget("s1", 0),
      deepFreeze(
        storyOf([
          [
            sceneOf("s1", [
              // A fixed visual: the default one quotes the title, which can be far over a label's limit.
              lesson(options.title ?? "Title", ["c1"], {
                body: options.body,
                visual: options.visual ?? visualOf("fixed"),
              }),
            ]),
          ],
        ]),
      ),
      MATERIAL,
      "en",
    );

  it("accepts a title of exactly 200 characters and rejects 201, without cutting it", () => {
    expect(lessonRequest({ title: "t".repeat(ANIMATION_TITLE_MAX) }).ok).toBe(true);
    expect(lessonRequest({ title: "t".repeat(ANIMATION_TITLE_MAX + 1) })).toEqual({
      ok: false,
      reason: "REQUEST_INVALID",
    });
  });

  it("measures the title after trimming and sends the trimmed title", () => {
    const padded = lessonRequest({ title: `  ${"t".repeat(ANIMATION_TITLE_MAX)}\n` });
    expect(padded.ok && padded.request.title).toBe("t".repeat(ANIMATION_TITLE_MAX));
    expect(lessonRequest({ title: `  ${"t".repeat(ANIMATION_TITLE_MAX + 1)} ` }).ok).toBe(false);
  });

  it("rejects a title that is empty after trimming", () => {
    expect(lessonRequest({ title: " \u00a0\n " })).toEqual({ ok: false, reason: "REQUEST_INVALID" });
  });

  it("counts characters like String.length, so 101 emoji are too long and 100 fit", () => {
    expect(lessonRequest({ title: "😀".repeat(100) }).ok).toBe(true);
    expect(lessonRequest({ title: "😀".repeat(101) })).toEqual({ ok: false, reason: "REQUEST_INVALID" });
  });

  it("accepts a text of exactly 2000 characters and rejects 2001, without cutting it", () => {
    const fits = lessonRequest({ body: "b".repeat(ANIMATION_TEXT_MAX) });
    expect(fits.ok && fits.request.text.length).toBe(ANIMATION_TEXT_MAX);
    expect(lessonRequest({ body: "b".repeat(ANIMATION_TEXT_MAX + 1) })).toEqual({
      ok: false,
      reason: "REQUEST_INVALID",
    });
  });

  it("rejects a lone surrogate in the title", () => {
    expect(lessonRequest({ title: "bad \ud800 title" })).toEqual({ ok: false, reason: "REQUEST_INVALID" });
  });

  it("rejects a visual that fails the schema", () => {
    const broken = { kind: "formula", expression: "", terms: [] } as unknown as LessonVisual;
    expect(lessonRequest({ visual: broken })).toEqual({ ok: false, reason: "REQUEST_INVALID" });
  });

  it("rejects a language outside en and id", () => {
    const result = buildAnimationRequest(
      lessonTarget("s1", 0),
      storyOf([[sceneOf("s1", [lesson("T", ["c1"])])]]),
      MATERIAL,
      "fr" as unknown as "en",
    );
    expect(result).toEqual({ ok: false, reason: "REQUEST_INVALID" });
  });

  it("rejects a puzzle whose question is 201 characters", () => {
    const puzzle = puzzleOf("pz1");
    puzzle.question = "q".repeat(ANIMATION_TITLE_MAX + 1);
    const result = buildAnimationRequest(puzzleTarget("pz1"), storyOf([[]], [puzzle]), MATERIAL, "en");
    expect(result).toEqual({ ok: false, reason: "REQUEST_INVALID" });
  });
});

describe("buildAnimationRequest: ANSWER_TOKEN_INVALID", () => {
  const build = (puzzle: Puzzle) =>
    buildAnimationRequest(puzzleTarget(puzzle.puzzle_id), deepFreeze(storyOf([[]], [puzzle])), MATERIAL, "en");

  it("rejects a correct_choice_id that matches no choice", () => {
    const puzzle = puzzleOf("pz1");
    puzzle.correct_choice_id = "Z";
    expect(build(puzzle)).toEqual({ ok: false, reason: "ANSWER_TOKEN_INVALID" });
  });

  it("rejects a correct_choice_id that matches two choices", () => {
    const puzzle = puzzleOf("pz1");
    puzzle.choices.push({ choice_id: "B", text: "another right answer" });
    expect(build(puzzle)).toEqual({ ok: false, reason: "ANSWER_TOKEN_INVALID" });
  });

  it("rejects a correct choice of 81 characters and accepts 80", () => {
    const longer = puzzleOf("pz1");
    longer.choices[1] = { choice_id: "B", text: "x".repeat(ANIMATION_FORBIDDEN_TOKEN_MAX + 1) };
    expect(build(longer)).toEqual({ ok: false, reason: "ANSWER_TOKEN_INVALID" });

    const fits = puzzleOf("pz1");
    fits.choices[1] = { choice_id: "B", text: "x".repeat(ANIMATION_FORBIDDEN_TOKEN_MAX) };
    expect(build(fits).ok).toBe(true);
  });

  it("measures the choice after trimming, so spaces around 80 characters still fit", () => {
    const puzzle = puzzleOf("pz1");
    puzzle.choices[1] = { choice_id: "B", text: ` ${"x".repeat(ANIMATION_FORBIDDEN_TOKEN_MAX)} ` };
    expect(build(puzzle).ok).toBe(true);
  });

  it("rejects a correct choice that is empty after trimming, because it gives nothing to look for", () => {
    const puzzle = puzzleOf("pz1");
    puzzle.choices[1] = { choice_id: "B", text: "  \n " };
    expect(build(puzzle)).toEqual({ ok: false, reason: "ANSWER_TOKEN_INVALID" });
  });

  it("does not apply to a lesson target", () => {
    const result = buildAnimationRequest(lessonTarget("s1", 0), storyOf([[sceneOf("s1", [lesson("T", ["c1"])])]]), MATERIAL, "en");
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// attachAnimation
// ---------------------------------------------------------------------------

describe("attachAnimation", () => {
  const base = () =>
    storyOf(
      [[lessonScene(1), lessonScene(2), puzzleSceneOf("p", "pz1")], [lessonScene(3)]],
      [puzzleOf("pz1"), puzzleOf("pz2")],
    );

  it("puts a lesson reference on the target block and leaves everything else equal", () => {
    const input = deepFreeze(base());
    const result = attachAnimation(input, lessonTarget("s2"), LESSON_REF);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const expected = base();
    ((expected.chapters[0].scenes[1] as { content: SceneContent[] }).content[1] as LearningContent).animation =
      LESSON_REF;
    expect(result.story).toEqual(expected);
    expect(result.story).not.toBe(input);
    expect(input).toEqual(base()); // untouched (it is frozen as well)
  });

  it("puts a puzzle reference with pause_at_frame on the puzzle and leaves everything else equal", () => {
    const input = deepFreeze(base());
    const result = attachAnimation(input, puzzleTarget("pz2"), PUZZLE_REF);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const expected = base();
    expected.puzzles[1].animation = PUZZLE_REF;
    expect(result.story).toEqual(expected);
    expect(input).toEqual(base());
  });

  it("keeps animations that other targets already have", () => {
    const first = attachAnimation(deepFreeze(base()), lessonTarget("s1"), LESSON_REF);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = attachAnimation(deepFreeze(first.story), puzzleTarget("pz1"), PUZZLE_REF);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const lessonBlock = (second.story.chapters[0].scenes[0] as { content: SceneContent[] }).content[1];
    expect((lessonBlock as LearningContent).animation).toEqual(LESSON_REF);
    expect(second.story.puzzles[0].animation).toEqual(PUZZLE_REF);
  });

  it("stores a copy of the reference, with unknown keys dropped", () => {
    const reference = { ...LESSON_REF, extra: "from a newer backend" } as AnimationReference;
    const result = attachAnimation(base(), lessonTarget("s1"), reference);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stored = ((result.story.chapters[0].scenes[0] as { content: SceneContent[] }).content[1] as LearningContent)
      .animation;
    expect(stored).toEqual(LESSON_REF);
    expect(stored).not.toBe(reference);
    reference.duration_in_frames = 31;
    expect(stored?.duration_in_frames).toBe(LESSON_REF.duration_in_frames);
  });

  it("refuses a pause_at_frame on a lesson and leaves the story as it was", () => {
    const input = deepFreeze(base());
    expect(attachAnimation(input, lessonTarget("s1"), PUZZLE_REF)).toEqual({ ok: false });
    expect(input).toEqual(base());
  });

  it("refuses a puzzle reference that has no pause_at_frame", () => {
    expect(attachAnimation(deepFreeze(base()), puzzleTarget("pz1"), LESSON_REF)).toEqual({ ok: false });
  });

  it("refuses a target that is not in the story", () => {
    const input = deepFreeze(base());
    expect(attachAnimation(input, lessonTarget("nope"), LESSON_REF).ok).toBe(false);
    expect(attachAnimation(input, lessonTarget("s1", 0), LESSON_REF).ok).toBe(false); // a narration block
    expect(attachAnimation(input, lessonTarget("s1", 7), LESSON_REF).ok).toBe(false);
    expect(attachAnimation(input, lessonTarget("p", 0), LESSON_REF).ok).toBe(false); // a puzzle scene
    expect(attachAnimation(input, puzzleTarget("nope"), PUZZLE_REF).ok).toBe(false);
    expect(attachAnimation(input, { kind: "video" } as unknown as AnimationTarget, LESSON_REF).ok).toBe(false);
  });

  it("refuses a lesson or puzzle without a visual, as buildAnimationRequest does", () => {
    const input = deepFreeze(
      storyOf([[sceneOf("s1", [lesson("Plain", ["c1"], { noVisual: true })])]], [puzzleOf("plain", { noVisual: true })]),
    );
    expect(attachAnimation(input, lessonTarget("s1", 0), LESSON_REF).ok).toBe(false);
    expect(attachAnimation(input, puzzleTarget("plain"), PUZZLE_REF).ok).toBe(false);
  });

  it("refuses a target that already has an animation and does not replace it", () => {
    const input = deepFreeze(
      storyOf(
        [[lessonScene(1, { animation: LESSON_REF })]],
        [puzzleOf("pz1", { animation: PUZZLE_REF })],
      ),
    );
    const other = { ...LESSON_REF, animation_id: "11111111-2222-4333-8444-555555555555" };
    expect(attachAnimation(input, lessonTarget("s1"), other)).toEqual({ ok: false });
    expect(attachAnimation(input, puzzleTarget("pz1"), { ...PUZZLE_REF, animation_id: other.animation_id })).toEqual({
      ok: false,
    });
  });

  it.each<[string, (reference: AnimationReference) => unknown]>([
    ["an upper-case id", (r) => ({ ...r, animation_id: r.animation_id.toUpperCase() })],
    ["an id with braces", (r) => ({ ...r, animation_id: `{${r.animation_id}}` })],
    ["a short source hash", (r) => ({ ...r, source_sha256: r.source_sha256.slice(1) })],
    ["an upper-case bundle hash", (r) => ({ ...r, bundle_sha256: r.bundle_sha256.toUpperCase() })],
    ["a wrong width", (r) => ({ ...r, width: r.width - 1 })],
    ["a wrong frame rate", (r) => ({ ...r, fps: r.fps + 1 })],
    ["a duration below the minimum", (r) => ({ ...r, duration_in_frames: CONTRACT.duration.min - 1 })],
    ["a duration above the maximum", (r) => ({ ...r, duration_in_frames: CONTRACT.duration.max + 1 })],
    ["a fractional duration", (r) => ({ ...r, duration_in_frames: 150.5 })],
    ["a contract version of 0", (r) => ({ ...r, contract_version: 0 })],
    ["a missing hash", (r) => ({ ...r, bundle_sha256: undefined })],
    ["null", () => null],
    ["a string", () => "reference"],
    ["an array", () => [LESSON_REF]],
  ])("refuses a lesson reference with %s", (_name, mutate) => {
    const input = deepFreeze(base());
    expect(attachAnimation(input, lessonTarget("s1"), mutate(LESSON_REF) as AnimationReference)).toEqual({
      ok: false,
    });
    expect(input).toEqual(base());
  });

  it.each<[string, Partial<AnimationReference> | { pause_at_frame: unknown }]>([
    ["a pause at frame 0", { pause_at_frame: 0 }],
    ["a pause at the duration itself", { pause_at_frame: PUZZLE_REF.duration_in_frames }],
    ["a fractional pause", { pause_at_frame: 10.5 }],
    ["a null pause", { pause_at_frame: null }],
  ])("refuses a puzzle reference with %s", (_name, patch) => {
    const reference = { ...PUZZLE_REF, ...patch } as AnimationReference;
    expect(attachAnimation(deepFreeze(base()), puzzleTarget("pz1"), reference)).toEqual({ ok: false });
  });

  it("accepts the first and the last legal pause frame", () => {
    const first = attachAnimation(base(), puzzleTarget("pz1"), { ...PUZZLE_REF, pause_at_frame: 1 });
    const last = attachAnimation(base(), puzzleTarget("pz1"), {
      ...PUZZLE_REF,
      pause_at_frame: PUZZLE_REF.duration_in_frames - 1,
    });
    expect(first.ok).toBe(true);
    expect(last.ok).toBe(true);
  });

  it("treats an absent pause key written as undefined like an absent key", () => {
    const withUndefined = { ...LESSON_REF, pause_at_frame: undefined };
    const result = attachAnimation(base(), lessonTarget("s1"), withUndefined);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stored = ((result.story.chapters[0].scenes[0] as { content: SceneContent[] }).content[1] as LearningContent)
      .animation;
    expect(stored && "pause_at_frame" in stored).toBe(false);
  });

  it("does not throw on a reference whose property getter throws", () => {
    const hostile = {} as AnimationReference;
    Object.defineProperty(hostile, "animation_id", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    expect(attachAnimation(base(), lessonTarget("s1"), hostile)).toEqual({ ok: false });
  });

  it("makes a lesson target drop out of the next selection", () => {
    const input = base();
    const [target] = selectAnimationTargets(input);
    const result = attachAnimation(input, target, LESSON_REF);
    expect(result.ok).toBe(true);
    if (result.ok) expect(selectAnimationTargets(result.story)).not.toContainEqual(target);
  });
});

// ---------------------------------------------------------------------------
// animationForStep
// ---------------------------------------------------------------------------

describe("animationForStep", () => {
  const refFor = (i: number): AnimationReference => ({ ...LESSON_REF, duration_in_frames: CONTRACT.duration.min + i });

  it("returns the animation of a single lesson block", () => {
    const blocks = deepFreeze<SceneContent[]>([narration(), lesson("A", ["c1"], { animation: LESSON_REF })]);
    expect(animationForStep(blocks, 1)).toEqual(LESSON_REF);
  });

  it("returns undefined for a block without an animation", () => {
    expect(animationForStep([lesson("A", ["c1"])], 0)).toBeUndefined();
  });

  it("gives every chunk of a step the animation of the first chunk", () => {
    const blocks = deepFreeze<SceneContent[]>([
      narration(),
      lesson("A", ["c1"], { animation: LESSON_REF, body: "chunk 1" }),
      lesson("A", ["c1"], { body: "chunk 2" }),
      lesson("A", ["c1"], { body: "chunk 3" }),
    ]);
    expect([1, 2, 3].map((i) => animationForStep(blocks, i))).toEqual([LESSON_REF, LESSON_REF, LESSON_REF]);
  });

  it("does not use an animation that sits on a later chunk of a step", () => {
    const blocks = deepFreeze<SceneContent[]>([
      lesson("A", ["c1"]),
      lesson("A", ["c1"], { animation: LESSON_REF }),
    ]);
    expect(animationForStep(blocks, 0)).toBeUndefined();
    expect(animationForStep(blocks, 1)).toBeUndefined();
  });

  it("does not carry an animation into the next step (a different title or a different visual)", () => {
    const blocks = deepFreeze<SceneContent[]>([
      lesson("A", ["c1"], { animation: LESSON_REF }),
      lesson("B", ["c1"]),
      lesson("B", ["c1"], { visual: visualOf("other") }),
    ]);
    expect(animationForStep(blocks, 1)).toBeUndefined();
    expect(animationForStep(blocks, 2)).toBeUndefined();
    expect(animationForStep(blocks, 0)).toEqual(LESSON_REF);
  });

  it("returns undefined for a block that is not a lesson block, and for an index out of range", () => {
    const blocks = deepFreeze<SceneContent[]>([narration(), lesson("A", ["c1"], { animation: LESSON_REF })]);
    expect(animationForStep(blocks, 0)).toBeUndefined();
    expect(animationForStep(blocks, 2)).toBeUndefined();
    expect(animationForStep(blocks, -1)).toBeUndefined();
    expect(animationForStep(blocks, 0.5)).toBeUndefined();
    expect(animationForStep([], 0)).toBeUndefined();
  });

  it("finds the same step as lessonStepInfo for every short block sequence", () => {
    // Block kinds: N narration, A1 and A2 lessons of one step, B a lesson of another step.
    const kinds = ["N", "A", "A2", "B"] as const;
    const make = (kind: (typeof kinds)[number], i: number): SceneContent => {
      const animation = refFor(i);
      if (kind === "N") return narration(`n${i}`);
      if (kind === "A") return lesson("Step A", ["c1"], { animation });
      if (kind === "A2") return lesson("Step A", ["c1"], { animation, visual: visualOf("Step A, another picture") });
      return lesson("Step B", ["c2"], { animation });
    };

    let sequences = 0;
    const walk = (prefix: Array<(typeof kinds)[number]>): void => {
      if (prefix.length > 0) {
        sequences += 1;
        const blocks = deepFreeze(prefix.map(make));
        blocks.forEach((block, i) => {
          const info = lessonStepInfo(blocks, i);
          if (block.type !== "learning_info" || info === null) {
            expect(animationForStep(blocks, i)).toBeUndefined();
            return;
          }
          const first = blocks.findIndex((_, j) => lessonStepInfo(blocks, j)?.index === info.index);
          expect(animationForStep(blocks, i)).toEqual(refFor(first));
        });
      }
      if (prefix.length < 6) for (const kind of kinds) walk([...prefix, kind]);
    };
    walk([]);
    expect(sequences).toBeGreaterThan(5000);
  });
});
