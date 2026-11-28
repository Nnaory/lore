/**
 * targets.ts — which parts of a story get an AI-written animation, the request that asks for one,
 * and how the finished animation is attached back to the story (pure, no React, no I/O).
 *
 * Why: animating costs Gemini calls and minutes of waiting, so only a few visuals are animated, and
 * the choice must be the same on every call (design 7.2, Requirement 23). A target that moved after
 * another animation was attached would animate a second lesson the player never asked for. Four
 * functions cover the whole flow:
 *
 * - `selectAnimationTargets(story)` picks at most `MAX_ANIMATION_TARGETS` targets. Candidates are
 *   lesson blocks with a visual whose concepts no earlier candidate has taught, then puzzles with a
 *   visual. The first four candidates keep their slots even when they already have an animation,
 *   and only those without one are returned, so the answer does not drift as animations arrive.
 * - `buildAnimationRequest(target, story, material, language)` builds the body for
 *   `POST /api/v1/ai/animations`. It never shortens a text: the title is looked up verbatim on the
 *   rendered frame, so a title that does not fit the contract is refused, not cut.
 * - `attachAnimation(story, target, reference)` returns a copy of the story with the reference on
 *   the target. It reads the reference strictly (a bad one is refused here, unlike the lenient
 *   story reader) and applies the contract's pause rule for the kind of target.
 * - `animationForStep(blocks, blockIndex)` is for the Stage. A lesson step can be stored as several
 *   consecutive `learning_info` blocks; the reference lives on the first block of the step, so the
 *   Stage reads it from there and one iframe stays alive for the whole step (design K-6).
 *
 * Results are `{ ok: true, ... } | { ok: false, ... }` and nothing here throws or mutates its input.
 * Limits come from `animation-requests.ts` and `animation-contract.json`; this file adds only the
 * count of targets, which belongs to neither.
 */

import { CONTRACT } from "@/lib/animation/contract";
import {
  ANIMATION_CONCEPTS_MAX,
  ANIMATION_FORBIDDEN_TOKEN_MAX,
  CreateAnimationRequestSchema,
} from "@/lib/contracts/animation-requests";
import { AnimationReferenceSchema } from "@/lib/contracts/schemas/animation.schema";
import { sameStep } from "@/lib/story/lesson-steps";
import type { AnimationReference, AnimationTarget, CreateAnimationRequest } from "@/lib/types/animation";
import type { MaterialBlueprint } from "@/lib/types/material";
import type { LearningContent, Scene, SceneContent } from "@/lib/types/scene";
import type { StoryBlueprint } from "@/lib/types/story";
import type { LessonVisual } from "@/lib/types/visual";

/** Most targets one story can have animated (Requirement 23.1). */
export const MAX_ANIMATION_TARGETS = 4;

/** Why `buildAnimationRequest` refused (Requirements 23.9, 23.10, 23.11). */
export type BuildRequestFailure = "TARGET_NOT_FOUND" | "REQUEST_INVALID" | "ANSWER_TOKEN_INVALID";

export type BuildAnimationRequestResult =
  | { ok: true; request: CreateAnimationRequest }
  | { ok: false; reason: BuildRequestFailure };

export type AttachAnimationResult = { ok: true; story: StoryBlueprint } | { ok: false };

// ---------------------------------------------------------------------------
// Finding a target in the story
// ---------------------------------------------------------------------------

/** The scene types that carry `content` (every type except `puzzle` and `ending`). */
type ContentScene = Extract<Scene, { content: SceneContent[] }>;

function hasContent(scene: Scene): scene is ContentScene {
  return Array.isArray((scene as { content?: unknown }).content);
}

/** A lesson block that can be animated: a `learning_info` block with a visual. */
interface LessonLocation {
  chapterIndex: number;
  sceneIndex: number;
  blockIndex: number;
  block: LearningContent;
  visual: LessonVisual;
}

/**
 * The first scene with `target.scene_id` decides (ids are unique in a valid story). Anything
 * other than a lesson block with a visual is "not found", the same rule for the request and for
 * the attachment.
 */
function locateLesson(story: StoryBlueprint, scene_id: string, block_index: number): LessonLocation | null {
  if (!Number.isInteger(block_index) || block_index < 0) return null;
  for (let chapterIndex = 0; chapterIndex < story.chapters.length; chapterIndex += 1) {
    const scenes = story.chapters[chapterIndex].scenes;
    for (let sceneIndex = 0; sceneIndex < scenes.length; sceneIndex += 1) {
      const scene = scenes[sceneIndex];
      if (scene.scene_id !== scene_id) continue;
      if (!hasContent(scene)) return null;
      const block = scene.content[block_index];
      if (block === undefined || block.type !== "learning_info" || !block.visual) return null;
      return { chapterIndex, sceneIndex, blockIndex: block_index, block, visual: block.visual };
    }
  }
  return null;
}

/** A puzzle that can be animated: one with a visual. */
function locatePuzzle(story: StoryBlueprint, puzzle_id: string) {
  const puzzleIndex = story.puzzles.findIndex((puzzle) => puzzle.puzzle_id === puzzle_id);
  if (puzzleIndex < 0) return null;
  const puzzle = story.puzzles[puzzleIndex];
  return puzzle.visual ? { puzzleIndex, puzzle, visual: puzzle.visual } : null;
}

// ---------------------------------------------------------------------------
// selectAnimationTargets
// ---------------------------------------------------------------------------

interface Candidate {
  target: AnimationTarget;
  animated: boolean;
}

/** The first `MAX_ANIMATION_TARGETS` candidates in story order, animated or not. */
function collectCandidates(story: StoryBlueprint): Candidate[] {
  const candidates: Candidate[] = [];
  const taught = new Set<string>();

  for (const chapter of story.chapters) {
    for (const scene of chapter.scenes) {
      if (!hasContent(scene)) continue;
      for (let blockIndex = 0; blockIndex < scene.content.length; blockIndex += 1) {
        const block = scene.content[blockIndex];
        if (block.type !== "learning_info" || !block.visual) continue;
        if (block.concept_ids.some((id) => taught.has(id))) continue;
        for (const id of block.concept_ids) taught.add(id);
        candidates.push({
          target: { kind: "lesson", scene_id: scene.scene_id, block_index: blockIndex },
          animated: Boolean(block.animation),
        });
        if (candidates.length >= MAX_ANIMATION_TARGETS) return candidates;
      }
    }
  }

  for (const puzzle of story.puzzles) {
    if (!puzzle.visual) continue;
    candidates.push({ target: { kind: "puzzle", puzzle_id: puzzle.puzzle_id }, animated: Boolean(puzzle.animation) });
    if (candidates.length >= MAX_ANIMATION_TARGETS) return candidates;
  }
  return candidates;
}

/**
 * Up to four targets still without an animation, in story order. Deterministic: the same story
 * gives the same list, and attaching an animation to one target never brings a fifth candidate in.
 */
export function selectAnimationTargets(story: StoryBlueprint): AnimationTarget[] {
  return collectCandidates(story)
    .filter((candidate) => !candidate.animated)
    .map((candidate) => candidate.target);
}

// ---------------------------------------------------------------------------
// buildAnimationRequest
// ---------------------------------------------------------------------------

/**
 * Names of the concepts in `ids` order: each id once, ids missing from the material skipped, a
 * name that an earlier id already gave skipped, at most `ANIMATION_CONCEPTS_MAX`.
 */
function conceptNames(ids: readonly string[], material: Pick<MaterialBlueprint, "concepts">): string[] {
  const nameById = new Map<string, string>();
  for (const concept of material.concepts) {
    if (!nameById.has(concept.concept_id)) nameById.set(concept.concept_id, concept.name);
  }
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const names: string[] = [];
  for (const id of ids) {
    if (names.length >= ANIMATION_CONCEPTS_MAX) break;
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    const name = nameById.get(id);
    if (name === undefined || seenNames.has(name)) continue;
    seenNames.add(name);
    names.push(name);
  }
  return names;
}

/** Runs the request schema; the parsed copy (trimmed title, no shared objects) is what is returned. */
function validated(draft: CreateAnimationRequest): BuildAnimationRequestResult {
  const parsed = CreateAnimationRequestSchema.safeParse(draft);
  if (!parsed.success) return { ok: false, reason: "REQUEST_INVALID" };
  const request: CreateAnimationRequest = { ...parsed.data };
  // The schema fills a missing list with []. A lesson sends no such key at all (Requirement 23.12).
  if (request.kind === "lesson") delete request.forbidden_tokens;
  return { ok: true, request };
}

/**
 * The request for `target`, or the reason it cannot be built. `material` supplies the concept
 * names; only its `concepts` are read.
 */
export function buildAnimationRequest(
  target: AnimationTarget,
  story: StoryBlueprint,
  material: Pick<MaterialBlueprint, "concepts">,
  language: "en" | "id",
): BuildAnimationRequestResult {
  switch (target.kind) {
    case "lesson": {
      const found = locateLesson(story, target.scene_id, target.block_index);
      if (found === null) return { ok: false, reason: "TARGET_NOT_FOUND" };
      return validated({
        kind: "lesson",
        title: found.block.title,
        text: found.block.body,
        concepts: conceptNames(found.block.concept_ids, material),
        visual: found.visual,
        language,
      });
    }
    case "puzzle": {
      const found = locatePuzzle(story, target.puzzle_id);
      if (found === null) return { ok: false, reason: "TARGET_NOT_FOUND" };
      const { puzzle } = found;

      // The correct answer is the one text that must not show up on the frame.
      const correct = puzzle.choices.filter((choice) => choice.choice_id === puzzle.correct_choice_id);
      if (correct.length !== 1) return { ok: false, reason: "ANSWER_TOKEN_INVALID" };
      const answer = correct[0].text.trim();
      if (answer.length === 0 || answer.length > ANIMATION_FORBIDDEN_TOKEN_MAX) {
        return { ok: false, reason: "ANSWER_TOKEN_INVALID" };
      }

      return validated({
        kind: "puzzle",
        title: puzzle.question,
        text: puzzle.narrative_context,
        concepts: conceptNames(puzzle.concept_ids, material),
        visual: found.visual,
        language,
        forbidden_tokens: [answer],
      });
    }
    default:
      return { ok: false, reason: "TARGET_NOT_FOUND" };
  }
}

// ---------------------------------------------------------------------------
// attachAnimation
// ---------------------------------------------------------------------------

/**
 * `reference` as a fresh `AnimationReference`, or `null` when it fails the strict schema or breaks
 * the contract's pause rule for `kind` (a lesson reference has no `pause_at_frame`, a puzzle
 * reference has one). Unknown keys are dropped. A `pause_at_frame` key holding `undefined` counts
 * as absent, which is what the optional type allows.
 */
function readReference(reference: unknown, kind: "lesson" | "puzzle"): AnimationReference | null {
  let parsed: ReturnType<typeof AnimationReferenceSchema.safeParse>;
  try {
    parsed = AnimationReferenceSchema.safeParse(reference);
  } catch {
    return null; // a hostile object (a getter that throws) is just a bad reference
  }
  if (!parsed.success) return null;

  const copy: AnimationReference = { ...parsed.data };
  const hasPause = copy.pause_at_frame !== undefined;
  if (!hasPause) delete copy.pause_at_frame;
  if (CONTRACT.pause_rules[kind] === "forbidden" && hasPause) return null;
  if (CONTRACT.pause_rules[kind] === "required" && !hasPause) return null;
  return copy;
}

function withLessonAnimation(story: StoryBlueprint, found: LessonLocation, reference: AnimationReference): StoryBlueprint {
  return {
    ...story,
    chapters: story.chapters.map((chapter, chapterIndex) =>
      chapterIndex !== found.chapterIndex
        ? chapter
        : {
            ...chapter,
            scenes: chapter.scenes.map((scene, sceneIndex) =>
              sceneIndex !== found.sceneIndex || !hasContent(scene)
                ? scene
                : {
                    ...scene,
                    content: scene.content.map((block, blockIndex) =>
                      blockIndex !== found.blockIndex || block.type !== "learning_info"
                        ? block
                        : { ...block, animation: reference },
                    ),
                  },
            ),
          },
    ),
  };
}

/**
 * A copy of `story` with `reference` on `target`. Refused (`{ ok: false }`, story untouched) when
 * the target is not in the story or is not a lesson or puzzle with a visual, when it already has an
 * animation, or when the reference fails the strict schema or the pause rule of the target's kind.
 * Everything except the new `animation` key equals the input.
 */
export function attachAnimation(
  story: StoryBlueprint,
  target: AnimationTarget,
  reference: AnimationReference,
): AttachAnimationResult {
  switch (target.kind) {
    case "lesson": {
      const found = locateLesson(story, target.scene_id, target.block_index);
      if (found === null || found.block.animation) return { ok: false };
      const checked = readReference(reference, "lesson");
      if (checked === null) return { ok: false };
      return { ok: true, story: withLessonAnimation(story, found, checked) };
    }
    case "puzzle": {
      const found = locatePuzzle(story, target.puzzle_id);
      if (found === null || found.puzzle.animation) return { ok: false };
      const checked = readReference(reference, "puzzle");
      if (checked === null) return { ok: false };
      return {
        ok: true,
        story: {
          ...story,
          puzzles: story.puzzles.map((puzzle, index) =>
            index === found.puzzleIndex ? { ...puzzle, animation: checked } : puzzle,
          ),
        },
      };
    }
    default:
      return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// animationForStep
// ---------------------------------------------------------------------------

/**
 * The animation of the lesson step that holds `blocks[blockIndex]`: the one on the first block of
 * the step, or `undefined` when that block has none, `blockIndex` is not a lesson block, or it is
 * out of range. Blocks are grouped like `lessonStepInfo` does it, by `sameStep` against the
 * previous lesson block.
 */
export function animationForStep(blocks: readonly SceneContent[], blockIndex: number): AnimationReference | undefined {
  if (!Number.isInteger(blockIndex) || blockIndex < 0 || blockIndex >= blocks.length) return undefined;

  let first: LearningContent | undefined;
  let previous: LearningContent | undefined;
  for (let index = 0; index <= blockIndex; index += 1) {
    const block = blocks[index];
    if (block.type !== "learning_info") continue;
    if (previous === undefined || !sameStep(previous, block)) first = block;
    previous = block;
    if (index === blockIndex) return first?.animation;
  }
  return undefined;
}
