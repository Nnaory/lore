/**
 * animation-reference.test.ts — the optional `animation` of a lesson block and of a puzzle.
 *
 * Why: a story may point at an AI-written animation. The pointer must be read the same way by
 * Pydantic and Zod (both read the fixtures in `backend/tests/fixtures/animation/reference-*.json`,
 * Requirement 22.6), a bad pointer must be dropped without losing the story or the saved project
 * (22.3, 22.9), a story that never had the key must not gain it (22.15), and a valid pointer must
 * survive saving and loading in both repositories (22.14).
 *
 * The contract numbers (canvas, duration range) are read from `CONTRACT`, never restated here.
 *
 * @vitest-environment jsdom
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTRACT } from "@/lib/animation/contract";
import {
  AnimationReferenceSchema,
  LessonAnimationSchema,
  PuzzleAnimationSchema,
} from "@/lib/contracts/schemas/animation.schema";
import { LearningContentSchema } from "@/lib/contracts/schemas/scene.schema";
import { PuzzleSchema } from "@/lib/contracts/schemas/puzzle.schema";
import { StoryBlueprintSchema } from "@/lib/contracts/schemas/story.schema";
import { dummyCampaign } from "@/data/dummy-campaign";
import { HttpRepository } from "@/lib/state/http-repository";
import { IndexedDbRepository } from "@/lib/state/indexed-db-repository";
import { readProject } from "@/lib/state/project-model";
import type { AnimationReference } from "@/lib/types/animation";
import type { StoryBlueprint } from "@/lib/types/story";
import { freshStore } from "../fixtures/fresh-store";
import { linearStory } from "../fixtures/linear-story";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const DIR = join(__dirname, "..", "..", "..", "backend", "tests", "fixtures", "animation");

const stems = (prefix: string): string[] =>
  readdirSync(DIR)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();

const load = (stem: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(DIR, `${stem}.json`), "utf8")) as Record<string, unknown>;

/** The nine keys of an Animation_Reference; anything else in a fixture is dropped on read. */
const KNOWN_KEYS = [
  "animation_id",
  "source_sha256",
  "bundle_sha256",
  "width",
  "height",
  "fps",
  "duration_in_frames",
  "pause_at_frame",
  "contract_version",
] as const;

const known = (raw: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(raw).filter(([key]) => (KNOWN_KEYS as readonly string[]).includes(key)));

/** The field each invalid fixture must fail on, so none passes for the wrong reason. */
const INVALID_FIELD: Record<string, string> = {
  "reference-invalid-id-uppercase": "animation_id",
  "reference-invalid-id-braces": "animation_id",
  "reference-invalid-id-urn-prefix": "animation_id",
  "reference-invalid-id-no-hyphens": "animation_id",
  "reference-invalid-source-sha-63": "source_sha256",
  "reference-invalid-source-sha-65": "source_sha256",
  "reference-invalid-source-sha-uppercase": "source_sha256",
  "reference-invalid-bundle-sha-63": "bundle_sha256",
  "reference-invalid-bundle-sha-65": "bundle_sha256",
  "reference-invalid-bundle-sha-uppercase": "bundle_sha256",
  "reference-invalid-duration-29": "duration_in_frames",
  "reference-invalid-duration-901": "duration_in_frames",
  "reference-invalid-duration-fractional": "duration_in_frames",
  "reference-invalid-duration-string": "duration_in_frames",
  "reference-invalid-duration-boolean": "duration_in_frames",
  "reference-invalid-pause-0": "pause_at_frame",
  "reference-invalid-pause-equals-duration": "pause_at_frame",
  "reference-invalid-pause-exceeds-duration": "pause_at_frame",
  "reference-invalid-pause-null": "pause_at_frame",
  "reference-invalid-width-1279": "width",
  "reference-invalid-height-721": "height",
  "reference-invalid-fps-24": "fps",
  "reference-invalid-contract-version-0": "contract_version",
  "reference-invalid-contract-version-string": "contract_version",
  "reference-invalid-missing-bundle-sha": "bundle_sha256",
  "reference-invalid-camelcase-keys": "animation_id",
};

const VALID = stems("reference-valid-");
const INVALID = stems("reference-invalid-");

const lessonReference = known(load("reference-valid-lesson")) as AnimationReference;
const puzzleReference = known(load("reference-valid-puzzle")) as AnimationReference;

// ---------------------------------------------------------------------------
// Story builders
// ---------------------------------------------------------------------------

type Patch = { lesson?: unknown; puzzle?: unknown };

/**
 * A raw (unvalidated) copy of the linear story with `animation` set on every learning block
 * and/or every puzzle. A key left out of `patch` is left out of the story.
 */
function withAnimation(patch: Patch, story: StoryBlueprint = linearStory): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(story)) as {
    chapters: { scenes: { content?: Record<string, unknown>[] }[] }[];
    puzzles: Record<string, unknown>[];
  };
  if ("lesson" in patch) {
    for (const chapter of copy.chapters) {
      for (const scene of chapter.scenes) {
        for (const block of scene.content ?? []) {
          if (block.type === "learning_info") block.animation = patch.lesson;
        }
      }
    }
  }
  if ("puzzle" in patch) {
    for (const puzzle of copy.puzzles) puzzle.animation = patch.puzzle;
  }
  return copy as unknown as Record<string, unknown>;
}

function learningBlocks(story: unknown): Record<string, unknown>[] {
  const chapters = (story as { chapters: { scenes: { content?: Record<string, unknown>[] }[] }[] }).chapters;
  return chapters
    .flatMap((chapter) => chapter.scenes)
    .flatMap((scene) => scene.content ?? [])
    .filter((block) => block.type === "learning_info");
}

const puzzlesOf = (story: unknown): Record<string, unknown>[] =>
  (story as { puzzles: Record<string, unknown>[] }).puzzles;

function parseStory(raw: unknown): StoryBlueprint {
  const parsed = StoryBlueprintSchema.safeParse(raw);
  if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
  return parsed.data as StoryBlueprint;
}

const learningBase = learningBlocks(linearStory)[0];
const puzzleBase = linearStory.puzzles[0];

// ---------------------------------------------------------------------------
// Fixtures: same decision as Pytest (Requirement 22.6)
// ---------------------------------------------------------------------------

describe("shared Animation_Reference fixtures", () => {
  it("finds the fixture files", () => {
    expect(VALID.length).toBeGreaterThan(0);
    expect(INVALID.length).toBeGreaterThan(0);
  });

  it("knows the failing field of every invalid fixture", () => {
    expect(Object.keys(INVALID_FIELD).sort()).toEqual(INVALID);
  });

  it("builds the boundary fixtures from the contract, not from literals", () => {
    const { canvas, duration } = CONTRACT;
    const lesson = load("reference-valid-lesson");
    expect([lesson.width, lesson.height, lesson.fps]).toEqual([canvas.width, canvas.height, canvas.fps]);
    expect(load("reference-valid-duration-min").duration_in_frames).toBe(duration.min);
    expect(load("reference-valid-duration-max").duration_in_frames).toBe(duration.max);
    expect(load("reference-invalid-duration-29").duration_in_frames).toBe(duration.min - 1);
    expect(load("reference-invalid-duration-901").duration_in_frames).toBe(duration.max + 1);
    expect(load("reference-invalid-width-1279").width).toBe(canvas.width - 1);
    expect(load("reference-invalid-height-721").height).toBe(canvas.height + 1);
    expect(load("reference-invalid-fps-24").fps).not.toBe(canvas.fps);
  });

  it.each(VALID)("accepts %s and keeps only the known keys", (stem) => {
    const raw = load(stem);
    const parsed = AnimationReferenceSchema.safeParse(raw);
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
    if (parsed.success) expect(parsed.data).toEqual(known(raw));
  });

  it.each(INVALID)("rejects %s on the intended field", (stem) => {
    const parsed = AnimationReferenceSchema.safeParse(load(stem));
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(String(parsed.error.issues[0].path[0])).toBe(INVALID_FIELD[stem]);
  });

  it.each(VALID)("reads %s at exactly the location its pause rule allows", (stem) => {
    const raw = load(stem);
    const atPuzzle = "pause_at_frame" in raw;
    expect(PuzzleAnimationSchema.parse(raw)).toEqual(atPuzzle ? known(raw) : undefined);
    expect(LessonAnimationSchema.parse(raw)).toEqual(atPuzzle ? undefined : known(raw));
  });

  it.each(INVALID)("drops %s at both locations", (stem) => {
    const raw = load(stem);
    expect(LessonAnimationSchema.parse(raw)).toBeUndefined();
    expect(PuzzleAnimationSchema.parse(raw)).toBeUndefined();
  });

  it("refuses an id with a trailing newline, like Pydantic", () => {
    const base = load("reference-valid-lesson");
    expect(AnimationReferenceSchema.safeParse({ ...base, animation_id: `${String(base.animation_id)}\n` }).success).toBe(
      false
    );
  });

  it("takes the canvas from the contract, not from the fixture", () => {
    const base = load("reference-valid-lesson");
    for (const key of ["width", "height", "fps"] as const) {
      expect(AnimationReferenceSchema.safeParse({ ...base, [key]: Number(base[key]) + 1 }).success).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Lenient story fields
// ---------------------------------------------------------------------------

describe("lenient animation field", () => {
  const junk: [string, unknown][] = [
    ["null", null],
    ["a string", "an animation"],
    ["a number", 7],
    ["a boolean", true],
    ["an array", [lessonReference]],
    ["an empty object", {}],
    ["an object with a camelCase reference", load("reference-invalid-camelcase-keys")],
    ["a reference with a bad id", load("reference-invalid-id-uppercase")],
  ];

  it("returns undefined for a missing key", () => {
    expect(LessonAnimationSchema.parse(undefined)).toBeUndefined();
    expect(PuzzleAnimationSchema.parse(undefined)).toBeUndefined();
  });

  it.each(junk)("drops %s on a lesson and on a puzzle without failing", (_label, value) => {
    expect(LessonAnimationSchema.safeParse(value)).toEqual({ success: true, data: undefined });
    expect(PuzzleAnimationSchema.safeParse(value)).toEqual({ success: true, data: undefined });
  });

  it("drops a lesson reference that carries pause_at_frame, whatever its value", () => {
    for (const pause of [1, 100, 0, null, "x"]) {
      expect(LessonAnimationSchema.parse({ ...lessonReference, pause_at_frame: pause })).toBeUndefined();
    }
  });

  it("drops a puzzle reference without pause_at_frame or with pause_at_frame null", () => {
    expect(PuzzleAnimationSchema.parse(lessonReference)).toBeUndefined();
    expect(PuzzleAnimationSchema.parse({ ...puzzleReference, pause_at_frame: null })).toBeUndefined();
  });

  it("drops a puzzle pause that is not before the last frame", () => {
    const duration = puzzleReference.duration_in_frames;
    expect(PuzzleAnimationSchema.parse({ ...puzzleReference, pause_at_frame: duration - 1 })).toBeDefined();
    expect(PuzzleAnimationSchema.parse({ ...puzzleReference, pause_at_frame: duration })).toBeUndefined();
  });

});

// ---------------------------------------------------------------------------
// In a story
// ---------------------------------------------------------------------------

describe("animation inside a story", () => {
  it("keeps a valid reference on a lesson block and on a puzzle", () => {
    const story = parseStory(withAnimation({ lesson: lessonReference, puzzle: puzzleReference }));
    expect(learningBlocks(story)[0].animation).toEqual(lessonReference);
    expect(story.puzzles[0].animation).toEqual(puzzleReference);
  });

  it("drops unknown keys of a reference", () => {
    const raw = load("reference-valid-unknown-key-dropped");
    const story = parseStory(withAnimation({ lesson: raw }));
    expect(learningBlocks(story)[0].animation).toEqual(known(raw));
    expect(JSON.stringify(story)).not.toContain("future_field");
  });

  it("does not add the key to a story that never had it", () => {
    const story = parseStory(linearStory);
    for (const block of learningBlocks(story)) expect("animation" in block).toBe(false);
    for (const puzzle of story.puzzles) expect("animation" in puzzle).toBe(false);
    expect(story).toEqual(linearStory);
    expect(JSON.stringify(story)).not.toContain("animation");
  });

  it("leaves LearningContent and Puzzle with exactly their own keys when the key is absent", () => {
    const block = LearningContentSchema.parse(learningBase);
    const puzzle = PuzzleSchema.parse(puzzleBase);
    expect(Object.keys(block).sort()).toEqual(Object.keys(learningBase).sort());
    expect(Object.keys(puzzle).sort()).toEqual(Object.keys(puzzleBase).sort());
  });

  it.each(INVALID)("drops the invalid reference %s and keeps the story", (stem) => {
    const raw = load(stem);
    const story = parseStory(withAnimation({ lesson: raw, puzzle: raw }));
    expect(learningBlocks(story)[0].animation).toBeUndefined();
    expect(story.puzzles[0].animation).toBeUndefined();
    expect(JSON.stringify(story)).not.toContain("animation");
    expect(story).toEqual(linearStory);
  });

  it("drops a null animation and keeps the block and the puzzle", () => {
    const story = parseStory(withAnimation({ lesson: null, puzzle: null }));
    expect(learningBlocks(story)[0]).toEqual(learningBase);
    expect(story.puzzles[0]).toEqual(puzzleBase);
  });

  it("drops the reference when the lesson carries a pause or the puzzle lacks one", () => {
    const story = parseStory(withAnimation({ lesson: puzzleReference, puzzle: lessonReference }));
    expect(learningBlocks(story)[0].animation).toBeUndefined();
    expect(story.puzzles[0].animation).toBeUndefined();
  });

  it("still validates the rest of the puzzle", () => {
    const bad = PuzzleSchema.safeParse({ ...puzzleBase, correct_choice_id: "nope", animation: puzzleReference });
    expect(bad.success).toBe(false);
  });

  it("keeps the visual next to a reference", () => {
    const visual = { kind: "formula", expression: "a + b", terms: [{ symbol: "a", meaning: "first" }] };
    const block = LearningContentSchema.parse({ ...learningBase, visual, animation: lessonReference });
    expect(block.visual).toEqual(visual);
    expect(block.animation).toEqual(lessonReference);
  });
});

// ---------------------------------------------------------------------------
// Saved projects
// ---------------------------------------------------------------------------

const source = { file_name: "notes.pdf", file_type: "pdf" as const };

const rawProject = (story: unknown) => ({
  id: "p_animation",
  created_at: 1,
  updated_at: 2,
  source,
  campaign: dummyCampaign,
  stories: { [linearStory.story_id]: story },
});

/** The linear story as `readProject` returns it; fails the test if the project is refused. */
function storyOf(raw: unknown): StoryBlueprint {
  const read = readProject(raw);
  if (!read) throw new Error("readProject refused the project");
  return read.stories[linearStory.story_id];
}

describe("readProject with an animation", () => {
  it.each([
    ["null", null],
    ["a string", "broken"],
    ["a number", 12],
    ["an empty object", {}],
    ["a fractional duration", load("reference-invalid-duration-fractional")],
  ])("loads a project whose animation is %s and drops only that field", (_label, value) => {
    const story = storyOf(rawProject(withAnimation({ lesson: value, puzzle: value })));
    expect(story).toEqual(linearStory);
    expect(JSON.stringify(story)).not.toContain("animation");
  });

  it("keeps a valid reference", () => {
    const story = storyOf(rawProject(withAnimation({ lesson: lessonReference, puzzle: puzzleReference })));
    expect(learningBlocks(story)[0].animation).toEqual(lessonReference);
    expect(puzzlesOf(story)[0].animation).toEqual(puzzleReference);
  });

  it("loads a project saved before the field existed, unchanged", () => {
    expect(storyOf(rawProject(linearStory))).toEqual(linearStory);
  });
});

// ---------------------------------------------------------------------------
// Round trip through both repositories (Requirement 22.14)
// ---------------------------------------------------------------------------

describe("saving and loading a project with a valid reference", () => {
  const animated = withAnimation({ lesson: lessonReference, puzzle: puzzleReference }) as unknown as StoryBlueprint;
  const input = {
    source,
    campaign: dummyCampaign,
    stories: { [linearStory.story_id]: animated },
  };

  beforeEach(freshStore);

  it("gives the same story back from the idb repository", async () => {
    const repo = new IndexedDbRepository();
    const created = await repo.createProject({ ...input, id: "p_idb" });
    expect(created.ok).toBe(true);
    const loaded = await repo.loadProject("p_idb");
    const story = loaded?.stories[linearStory.story_id];
    expect(story).toEqual(animated);
    expect(learningBlocks(story)[0].animation).toEqual(lessonReference);
    expect(puzzlesOf(story)[0].animation).toEqual(puzzleReference);
    expect("pause_at_frame" in (learningBlocks(story)[0].animation as object)).toBe(false);
  });

  describe("with the http repository", () => {
    const calls: { url: string; method: string; body: unknown }[] = [];

    beforeEach(() => {
      calls.length = 0;
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("sends the reference unchanged and reads it back from the server copy", async () => {
      let stored: Record<string, unknown> | null = null;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          const method = init?.method ?? "GET";
          const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
          calls.push({ url, method, body });
          if (method === "POST") {
            stored = body as Record<string, unknown>;
            return new Response(JSON.stringify(body), { status: 201, headers: { "Content-Type": "application/json" } });
          }
          // What the API returns: the stored JSON, later copy, null for absent optionals.
          const reply = { ...stored, updated_at: Number(stored?.updated_at) + 5, campaign_state: null, materials: null };
          return new Response(JSON.stringify(reply), { status: 200, headers: { "Content-Type": "application/json" } });
        })
      );

      const repo = new HttpRepository();
      const created = await repo.createProject({ ...input, id: "p_http" });
      expect(created.ok).toBe(true);

      const posted = calls.find((call) => call.method === "POST")?.body as { stories: Record<string, unknown> };
      expect(learningBlocks(posted.stories[linearStory.story_id])[0].animation).toEqual(lessonReference);
      expect(puzzlesOf(posted.stories[linearStory.story_id])[0].animation).toEqual(puzzleReference);

      const loaded = await repo.loadProject("p_http");
      const local = created.ok ? created.value : null;
      expect(loaded?.updated_at).toBe((local?.updated_at ?? 0) + 5); // read from the server copy
      expect(loaded?.stories[linearStory.story_id]).toEqual(animated);
    });
  });
});
