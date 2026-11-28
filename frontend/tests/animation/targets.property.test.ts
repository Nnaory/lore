/**
 * Property tests: stable target selection and attachment that preserves the story (task 21.2,
 * design Property 13). Validates Requirements 23.3 and 23.8.
 *
 * Property 13: for every story, `selectAnimationTargets` answers the same on two calls, never
 * returns a duplicate, and never returns a target outside the first four candidates, also after
 * `attachAnimation` put references on other targets; and for every story and valid target,
 * `attachAnimation` leaves every part of the story except the new `animation` equal to the input.
 *
 * `targets.test.ts` holds the hand-made cases. Here fast-check builds the stories, 200 runs per
 * property (the task asks for at least 100). A story is either generated from scratch on top of
 * the header of `linearStory`, or `linearStory` itself with random edits (lessons inserted, a
 * visual added, extra puzzles). Concept ids come from a pool of six so that lessons often share a
 * concept and the "already taught" rule bites. Scene and puzzle ids are unique, as the backend
 * validator demands (`DUPLICATE_SCENE_ID`, `DUPLICATE_PUZZLE_ID`).
 *
 * The oracle (`candidatesOf`) restates Requirement 23.2 in another shape than the module: it
 * flattens the story first and then folds, where `targets.ts` walks the nesting once. Inputs are
 * deep-frozen, so a function that mutates its input throws and fails the property.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CONTRACT } from "@/lib/animation/contract";
import { MAX_ANIMATION_TARGETS, attachAnimation, selectAnimationTargets } from "@/lib/animation/targets";
import type { AnimationReference, AnimationTarget } from "@/lib/types/animation";
import type { Puzzle } from "@/lib/types/puzzle";
import type { LearningContent, Scene, SceneContent } from "@/lib/types/scene";
import type { StoryBlueprint } from "@/lib/types/story";
import type { LessonVisual } from "@/lib/types/visual";
import { linearStory } from "../fixtures/linear-story";

const RUNS = 200;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

const clone = <T>(value: T): T => structuredClone(value);

const keyOf = (target: AnimationTarget): string =>
  target.kind === "lesson" ? `lesson:${target.scene_id}:${target.block_index}` : `puzzle:${target.puzzle_id}`;

type ContentScene = Extract<Scene, { content: SceneContent[] }>;
const hasContent = (scene: Scene): scene is ContentScene => "content" in scene;

// ---------------------------------------------------------------------------
// Oracle: the candidates of Requirement 23.2, and what can be attached
// ---------------------------------------------------------------------------

interface Slot {
  target: AnimationTarget;
  animated: boolean;
}

/** Every lesson block with a visual, in story order, with where it sits. */
function lessonBlocks(story: StoryBlueprint): Array<{ target: AnimationTarget; block: LearningContent }> {
  return story.chapters
    .flatMap((chapter) => chapter.scenes)
    .filter(hasContent)
    .flatMap((scene) =>
      scene.content.map((block, blockIndex) => ({
        target: { kind: "lesson", scene_id: scene.scene_id, block_index: blockIndex } as AnimationTarget,
        block,
      })),
    )
    .filter((entry): entry is { target: AnimationTarget; block: LearningContent } =>
      entry.block.type === "learning_info" && Boolean(entry.block.visual),
    );
}

/** The first four candidates, animated or not (an animated one keeps its slot). */
function candidatesOf(story: StoryBlueprint): Slot[] {
  const taught = new Set<string>();
  const lessons: Slot[] = [];
  for (const { target, block } of lessonBlocks(story)) {
    if (block.concept_ids.some((id) => taught.has(id))) continue;
    block.concept_ids.forEach((id) => taught.add(id));
    lessons.push({ target, animated: Boolean(block.animation) });
  }
  const puzzles: Slot[] = story.puzzles
    .filter((puzzle) => Boolean(puzzle.visual))
    .map((puzzle) => ({ target: { kind: "puzzle", puzzle_id: puzzle.puzzle_id }, animated: Boolean(puzzle.animation) }));
  return [...lessons, ...puzzles].slice(0, 4);
}

/** Every target that `attachAnimation` should accept: a lesson or puzzle with a visual and no animation yet. */
function attachableOf(story: StoryBlueprint): AnimationTarget[] {
  return [
    ...lessonBlocks(story).filter(({ block }) => !block.animation).map(({ target }) => target),
    ...story.puzzles
      .filter((puzzle) => puzzle.visual && !puzzle.animation)
      .map((puzzle): AnimationTarget => ({ kind: "puzzle", puzzle_id: puzzle.puzzle_id })),
  ];
}

/** `story` with `reference` written at `target`, done by hand on a copy. */
function withReference(story: StoryBlueprint, target: AnimationTarget, reference: AnimationReference): StoryBlueprint {
  const copy = clone(story);
  if (target.kind === "puzzle") {
    const puzzle = copy.puzzles.find((p) => p.puzzle_id === target.puzzle_id);
    if (puzzle) puzzle.animation = reference;
    return copy;
  }
  const scene = copy.chapters.flatMap((chapter) => chapter.scenes).find((s) => s.scene_id === target.scene_id);
  if (scene && hasContent(scene)) (scene.content[target.block_index] as LearningContent).animation = reference;
  return copy;
}

/** `story` with the animation of `target` removed, by hand on a copy. */
function withoutReference(story: StoryBlueprint, target: AnimationTarget): StoryBlueprint {
  const copy = clone(story);
  if (target.kind === "puzzle") {
    const puzzle = copy.puzzles.find((p) => p.puzzle_id === target.puzzle_id);
    if (puzzle) delete puzzle.animation;
    return copy;
  }
  const scene = copy.chapters.flatMap((chapter) => chapter.scenes).find((s) => s.scene_id === target.scene_id);
  if (scene && hasContent(scene)) delete (scene.content[target.block_index] as LearningContent).animation;
  return copy;
}

// ---------------------------------------------------------------------------
// Story generator
// ---------------------------------------------------------------------------

const CONCEPT_POOL = ["c0", "c1", "c2", "c3", "c4", "c5"];

const VISUALS: LessonVisual[] = [
  { kind: "formula", expression: "a + b", terms: [{ symbol: "a", meaning: "first" }] },
  { kind: "vectors", vectors: [{ from: [0, 0], to: [2, 1], label: "A" }] },
];

/** A reference in the shape the backend stores; the module only checks and copies it. */
function referenceWith(id: number, pause?: number): AnimationReference {
  const hex = id.toString(16).padStart(12, "0");
  return {
    animation_id: `00000000-0000-4000-8000-${hex}`,
    source_sha256: "a".repeat(64),
    bundle_sha256: "b".repeat(64),
    width: CONTRACT.canvas.width,
    height: CONTRACT.canvas.height,
    fps: CONTRACT.canvas.fps,
    duration_in_frames: CONTRACT.duration.max,
    contract_version: CONTRACT.contract_version,
    ...(pause === undefined ? {} : { pause_at_frame: pause }),
  };
}

/** Reference already present in a generated story: counts as "animated". */
const PRESET_LESSON = referenceWith(1);
const PRESET_PUZZLE = referenceWith(2, 90);

const mostlyTrue = fc.constantFrom(true, true, true, false);
const sometimesTrue = fc.constantFrom(false, false, false, true);
const conceptsArb = fc.uniqueArray(fc.constantFrom(...CONCEPT_POOL), { maxLength: 3 });

interface LessonSpec {
  kind: "lesson";
  title: string;
  concepts: string[];
  visual: number | null;
  animated: boolean;
}

const lessonSpecArb: fc.Arbitrary<LessonSpec> = fc.record({
  kind: fc.constant("lesson" as const),
  title: fc.constantFrom("Alpha", "Beta", "Gamma"),
  concepts: conceptsArb,
  visual: mostlyTrue.chain((has) => (has ? fc.integer({ min: 0, max: VISUALS.length - 1 }) : fc.constant(null))),
  animated: sometimesTrue,
});

type BlockSpec = { kind: "narration" } | { kind: "dialogue" } | LessonSpec;

const blockSpecArb: fc.Arbitrary<BlockSpec> = fc.oneof(
  { weight: 1, arbitrary: fc.constant<BlockSpec>({ kind: "narration" }) },
  { weight: 1, arbitrary: fc.constant<BlockSpec>({ kind: "dialogue" }) },
  { weight: 3, arbitrary: lessonSpecArb },
);

type SceneSpec =
  | { kind: "content"; type: "narrative" | "learning" | "interaction" | "consequence"; blocks: BlockSpec[] }
  | { kind: "puzzle" }
  | { kind: "ending" };

const sceneSpecArb: fc.Arbitrary<SceneSpec> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant("content" as const),
      type: fc.constantFrom(...(["narrative", "learning", "interaction", "consequence"] as const)),
      blocks: fc.array(blockSpecArb, { maxLength: 5 }),
    }),
  },
  { weight: 1, arbitrary: fc.constant<SceneSpec>({ kind: "puzzle" }) },
  { weight: 1, arbitrary: fc.constant<SceneSpec>({ kind: "ending" }) },
);

interface PuzzleSpec {
  visual: number | null;
  animated: boolean;
  concepts: string[];
}

const puzzleSpecArb: fc.Arbitrary<PuzzleSpec> = fc.record({
  visual: mostlyTrue.chain((has) => (has ? fc.integer({ min: 0, max: VISUALS.length - 1 }) : fc.constant(null))),
  animated: sometimesTrue,
  concepts: conceptsArb,
});

function buildLesson(spec: LessonSpec, n: number): LearningContent {
  const block: LearningContent = {
    type: "learning_info",
    title: spec.title,
    body: `Lesson body ${n}.`,
    concept_ids: [...spec.concepts],
  };
  if (spec.visual !== null) block.visual = clone(VISUALS[spec.visual]);
  if (spec.animated) block.animation = clone(PRESET_LESSON);
  return block;
}

function buildPuzzle(spec: PuzzleSpec, id: string): Puzzle {
  const puzzle: Puzzle = { ...clone(linearStory.puzzles[0]), puzzle_id: id, concept_ids: [...spec.concepts] };
  if (spec.visual !== null) puzzle.visual = clone(VISUALS[spec.visual]);
  if (spec.animated) puzzle.animation = clone(PRESET_PUZZLE);
  return puzzle;
}

/** A story built from scratch around the header of `linearStory`. */
const generatedStoryArb: fc.Arbitrary<StoryBlueprint> = fc
  .record({
    chapters: fc.array(fc.array(sceneSpecArb, { minLength: 1, maxLength: 4 }), { minLength: 1, maxLength: 3 }),
    puzzles: fc.array(puzzleSpecArb, { maxLength: 5 }),
  })
  .map(({ chapters, puzzles }) => {
    let lessonNumber = 0;
    const built = chapters.map((scenes, ci) => ({
      chapter_id: `chapter_${ci}`,
      title: `Chapter ${ci}`,
      scenes: scenes.map((spec, si): Scene => {
        const scene_id = `s${ci}_${si}`;
        if (spec.kind === "puzzle") return { scene_id, type: "puzzle", characters_present: [], puzzle_id: "pz0", next_scene_id: null };
        if (spec.kind === "ending") return { scene_id, type: "ending", characters_present: [], ending_id: "e0" };
        const content = spec.blocks.map((block): SceneContent => {
          if (block.kind === "narration") return { type: "narration", text: "Narration." };
          if (block.kind === "dialogue") return { type: "dialogue", character_id: "eldric", expression: "calm", text: "Dialogue." };
          lessonNumber += 1;
          return buildLesson(block, lessonNumber);
        });
        return { scene_id, type: spec.type, characters_present: [], content, next_scene_id: null };
      }),
    }));
    return { ...clone(linearStory), chapters: built, puzzles: puzzles.map((p, i) => buildPuzzle(p, `pz${i}`)) };
  });

/** `linearStory` with lessons inserted, a visual added, and extra puzzles. */
const mutatedLinearArb: fc.Arbitrary<StoryBlueprint> = fc
  .record({
    insertions: fc.array(
      fc.record({ scene: fc.nat(), at: fc.nat(), lesson: lessonSpecArb }),
      { maxLength: 6 },
    ),
    visualOnExisting: fc.boolean(),
    puzzleVisual: fc.boolean(),
    puzzleAnimated: fc.boolean(),
    extraPuzzles: fc.array(puzzleSpecArb, { maxLength: 4 }),
  })
  .map((edit) => {
    const story = clone(linearStory);
    const contentScenes = story.chapters[0].scenes.filter(hasContent);
    let lessonNumber = 0;
    for (const insertion of edit.insertions) {
      const scene = contentScenes[insertion.scene % contentScenes.length];
      lessonNumber += 1;
      scene.content.splice(insertion.at % (scene.content.length + 1), 0, buildLesson(insertion.lesson, lessonNumber));
    }
    if (edit.visualOnExisting) {
      for (const scene of contentScenes) {
        for (const block of scene.content) if (block.type === "learning_info" && !block.visual) block.visual = clone(VISUALS[0]);
      }
    }
    if (edit.puzzleVisual) story.puzzles[0].visual = clone(VISUALS[1]);
    if (edit.puzzleAnimated) story.puzzles[0].animation = clone(PRESET_PUZZLE);
    story.puzzles.push(...edit.extraPuzzles.map((spec, i) => buildPuzzle(spec, `pz_extra_${i}`)));
    return story;
  });

const storyArb: fc.Arbitrary<StoryBlueprint> = fc.oneof(generatedStoryArb, mutatedLinearArb);

/** A reference a story can take: valid for both kinds, the pause is dropped for a lesson. */
const referenceArb: fc.Arbitrary<AnimationReference> = fc
  .integer({ min: CONTRACT.duration.min, max: CONTRACT.duration.max })
  .chain((duration) =>
    fc.record({
      id: fc.integer({ min: 3, max: 0xffff_ffff }),
      pause: fc.integer({ min: 1, max: duration - 1 }),
      duration: fc.constant(duration),
    }),
  )
  .map(({ id, pause, duration }) => ({ ...referenceWith(id, pause), duration_in_frames: duration }));

/** The reference that fits `target`: puzzles keep `pause_at_frame`, lessons must not have it. */
function referenceFor(target: AnimationTarget, reference: AnimationReference): AnimationReference {
  return target.kind === "puzzle" ? reference : withoutPause(reference);
}

function withoutPause(reference: AnimationReference): AnimationReference {
  const { pause_at_frame: _pause, ...rest } = reference;
  void _pause;
  return rest;
}

// ---------------------------------------------------------------------------
// The generator itself
// ---------------------------------------------------------------------------

describe("story generator for Property 13", () => {
  it("covers the cases the properties need (not vacuous)", () => {
    const stories = fc.sample(storyArb, 400);
    const slots = stories.map(candidatesOf);
    const has = (predicate: (story: StoryBlueprint, slots: Slot[]) => boolean) =>
      stories.some((story, i) => predicate(story, slots[i]));

    expect(has((_s, c) => c.length === 0)).toBe(true);
    expect(has((_s, c) => c.length === MAX_ANIMATION_TARGETS)).toBe(true);
    expect(has((_s, c) => c.some((slot) => slot.animated))).toBe(true);
    expect(has((_s, c) => c.some((slot) => slot.target.kind === "puzzle"))).toBe(true);
    expect(has((s, c) => c.length === MAX_ANIMATION_TARGETS && lessonBlocks(s).length > c.length)).toBe(true);
    expect(has((s) => attachableOf(s).some((t) => t.kind === "puzzle"))).toBe(true);
    // A lesson with a visual that is not a candidate (its concept was taught earlier).
    expect(has((s, c) => lessonBlocks(s).length > c.filter((slot) => slot.target.kind === "lesson").length)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Property 13, part 1: stable selection
// ---------------------------------------------------------------------------

describe("Property 13: selectAnimationTargets is stable", () => {
  it("answers the same twice, without duplicates, within the first four candidates", () => {
    fc.assert(
      fc.property(storyArb, (story) => {
        const frozen = deepFreeze(clone(story));
        const first = selectAnimationTargets(frozen);
        const second = selectAnimationTargets(frozen);

        expect(second).toEqual(first);
        expect(first.length).toBeLessThanOrEqual(MAX_ANIMATION_TARGETS);
        const keys = first.map(keyOf);
        expect(new Set(keys).size).toBe(keys.length);

        const firstFour = candidatesOf(story);
        expect(first).toEqual(firstFour.filter((slot) => !slot.animated).map((slot) => slot.target));
        const allowed = new Set(firstFour.map((slot) => keyOf(slot.target)));
        expect(keys.every((key) => allowed.has(key))).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });

  it("keeps the same first four candidates after references are attached to other targets", () => {
    fc.assert(
      fc.property(
        storyArb,
        fc.array(fc.nat(), { maxLength: 10 }),
        referenceArb,
        (story, picks, reference) => {
          const firstFour = candidatesOf(story).map((slot) => keyOf(slot.target));
          const candidates = new Map(candidatesOf(story).map((slot) => [keyOf(slot.target), slot.target] as const));
          const attachable = attachableOf(story);
          const animated = new Set(
            [
              ...lessonBlocks(story).filter(({ block }) => block.animation).map(({ target }) => target),
              ...story.puzzles.filter((p) => p.animation).map((p): AnimationTarget => ({ kind: "puzzle", puzzle_id: p.puzzle_id })),
            ].map(keyOf),
          );

          let current = deepFreeze(clone(story));
          if (attachable.length > 0) {
            for (const pick of picks) {
              const target = attachable[pick % attachable.length];
              const result = attachAnimation(current, target, referenceFor(target, reference));
              if (animated.has(keyOf(target))) {
                expect(result).toEqual({ ok: false });
              } else {
                expect(result.ok).toBe(true);
                if (!result.ok) return;
                current = deepFreeze(result.story);
                animated.add(keyOf(target));
              }

              // Selection: the first four candidates of the original story, minus the animated ones.
              const selected = selectAnimationTargets(current);
              const expected = firstFour.filter((key) => !animated.has(key)).map((key) => candidates.get(key));
              expect(selected).toEqual(expected);
              expect(selected.length).toBeLessThanOrEqual(MAX_ANIMATION_TARGETS);
              // The candidates themselves did not move.
              expect(candidatesOf(current).map((slot) => keyOf(slot.target))).toEqual(firstFour);
            }
          }
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("returns nothing once every selected target has an animation, and never a fifth candidate", () => {
    fc.assert(
      fc.property(storyArb, fc.array(fc.nat(), { maxLength: 6 }), referenceArb, (story, shuffle, reference) => {
        let current = deepFreeze(clone(story));
        const pending = [...selectAnimationTargets(current)];
        // Take the pending targets in an order the generated numbers decide.
        while (pending.length > 0) {
          const target = pending.splice((shuffle.shift() ?? 0) % pending.length, 1)[0];
          const result = attachAnimation(current, target, referenceFor(target, reference));
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          current = deepFreeze(result.story);
          expect(selectAnimationTargets(current)).toEqual(pending); // same order, nothing new
        }
        expect(selectAnimationTargets(current)).toEqual([]);
      }),
      { numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 13, part 2: attaching preserves everything else
// ---------------------------------------------------------------------------

describe("Property 13: attachAnimation preserves the story", () => {
  it("changes only the animation of the target, on a copy", () => {
    fc.assert(
      fc.property(storyArb, fc.nat(), referenceArb, (story, pick, reference) => {
        const attachable = attachableOf(story);
        fc.pre(attachable.length > 0);
        const target = attachable[pick % attachable.length];
        const ref = referenceFor(target, reference);

        const input = deepFreeze(clone(story));
        const result = attachAnimation(input, target, ref);
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        // The new story is the old one plus exactly this reference...
        expect(result.story).toStrictEqual(withReference(story, target, ref));
        // ...and taking the reference away again gives back the input.
        expect(withoutReference(result.story, target)).toStrictEqual(story);
        // The input is a different object and was not touched (it is frozen, so a write would have thrown).
        expect(result.story).not.toBe(input);
        expect(input).toStrictEqual(story);
        // The stored reference is a copy.
        expect(ref).toStrictEqual(referenceFor(target, reference));
      }),
      { numRuns: RUNS },
    );
  });

  it("refuses without touching the story when the target already has an animation", () => {
    fc.assert(
      fc.property(storyArb, fc.nat(), referenceArb, (story, pick, reference) => {
        const animated: AnimationTarget[] = [
          ...lessonBlocks(story).filter(({ block }) => block.animation).map(({ target }) => target),
          ...story.puzzles.filter((p) => p.visual && p.animation).map((p): AnimationTarget => ({ kind: "puzzle", puzzle_id: p.puzzle_id })),
        ];
        fc.pre(animated.length > 0);
        const target = animated[pick % animated.length];
        const input = deepFreeze(clone(story));
        expect(attachAnimation(input, target, referenceFor(target, reference))).toEqual({ ok: false });
        expect(input).toStrictEqual(story);
      }),
      { numRuns: RUNS },
    );
  });

  it("refuses a reference that breaks the pause rule of the target's kind", () => {
    fc.assert(
      fc.property(storyArb, fc.nat(), referenceArb, (story, pick, reference) => {
        const attachable = attachableOf(story);
        fc.pre(attachable.length > 0);
        const target = attachable[pick % attachable.length];
        // Wrong kind of reference: a lesson gets a pause, a puzzle loses it.
        const wrong = target.kind === "lesson" ? reference : withoutPause(reference);
        const input = deepFreeze(clone(story));
        expect(attachAnimation(input, target, wrong)).toEqual({ ok: false });
        expect(input).toStrictEqual(story);
      }),
      { numRuns: RUNS },
    );
  });
});
