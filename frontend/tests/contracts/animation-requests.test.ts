/**
 * animation-requests.test.ts — the body of `POST /api/v1/ai/animations`.
 *
 * Why: the backend model (`CreateAnimationRequest`) and `CreateAnimationRequestSchema` must accept
 * and reject the same bodies (Requirements 15.2, 15.12, 15.13, 38.4). Both read the shared
 * fixtures `backend/tests/fixtures/animation/request-{valid,invalid}-*.json`, so a limit counted
 * differently (UTF-16 units against code points), a trim that differs, or a lone surrogate that
 * slips through fails here as well as in Pytest. Boundary cases that the fixtures do not cover
 * (200 against 201, 2000 against 2001, 5 against 6, 8 against 9, input that is not an object) are
 * built in this file from named constants.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANIMATION_CONCEPT_MAX,
  ANIMATION_CONCEPTS_MAX,
  ANIMATION_FORBIDDEN_TOKEN_MAX,
  ANIMATION_FORBIDDEN_TOKENS_MAX,
  ANIMATION_TEXT_MAX,
  ANIMATION_TITLE_MAX,
  containsLoneSurrogate,
  CreateAnimationRequestSchema,
} from "@/lib/contracts/animation-requests";

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

const VALID = stems("request-valid-");
const INVALID = stems("request-invalid-");

/**
 * The first field each invalid fixture must fail on, so none is rejected for the wrong reason.
 * `""` is the whole body: a lone surrogate is caught before any field is read.
 */
const INVALID_AT: Record<string, string> = {
  "request-invalid-concept-emoji-over-80-units": "concepts",
  "request-invalid-concept-empty": "concepts",
  "request-invalid-concepts-six": "concepts",
  "request-invalid-forbidden-emoji-over-80-units": "forbidden_tokens",
  "request-invalid-forbidden-tokens-nine": "forbidden_tokens",
  "request-invalid-kind": "kind",
  "request-invalid-language": "language",
  "request-invalid-lesson-with-forbidden-tokens": "forbidden_tokens",
  "request-invalid-lone-surrogate-in-key": "",
  "request-invalid-lone-surrogate-in-title": "",
  "request-invalid-lone-surrogate-in-visual": "",
  "request-invalid-missing-visual": "visual",
  "request-invalid-text-empty": "text",
  "request-invalid-title-emoji-over-200-units": "title",
  "request-invalid-title-nbsp-only": "title",
  "request-invalid-title-not-string": "title",
  "request-invalid-visual-unknown-kind": "visual",
};

/** Keys a request keeps; anything else in a fixture is dropped on read. */
const KNOWN_KEYS = ["kind", "title", "text", "concepts", "visual", "language", "forbidden_tokens"];

describe("shared CreateAnimationRequest fixtures", () => {
  it("finds the fixture files", () => {
    expect(VALID.length).toBeGreaterThan(0);
    expect(INVALID.length).toBeGreaterThan(0);
  });

  it("knows the failing field of every invalid fixture", () => {
    expect(Object.keys(INVALID_AT).sort()).toEqual(INVALID);
  });

  it.each(VALID)("accepts %s", (stem) => {
    const parsed = CreateAnimationRequestSchema.safeParse(load(stem));
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
  });

  it.each(INVALID)("rejects %s on the intended field", (stem) => {
    const parsed = CreateAnimationRequestSchema.safeParse(load(stem));
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(String(parsed.error.issues[0].path[0] ?? "")).toBe(INVALID_AT[stem]);
  });

  it.each(VALID)("reads %s as the body with defaults, a trimmed title and no unknown keys", (stem) => {
    const raw = load(stem);
    const parsed = CreateAnimationRequestSchema.parse(raw);
    const kept = Object.fromEntries(Object.entries(raw).filter(([key]) => KNOWN_KEYS.includes(key)));
    expect(parsed).toEqual({
      ...kept,
      title: String(raw.title).trim(),
      concepts: raw.concepts ?? [],
      forbidden_tokens: raw.forbidden_tokens ?? [],
    });
    expect(Object.keys(parsed).every((key) => KNOWN_KEYS.includes(key))).toBe(true);
  });

  it("trims the title with the JavaScript whitespace set, not a smaller one", () => {
    const parsed = CreateAnimationRequestSchema.parse(load("request-valid-title-js-whitespace"));
    expect(parsed.title).toBe("Vectors");
  });

  it("trims only the title: text, concepts and forbidden tokens keep their spaces and duplicates", () => {
    const parsed = CreateAnimationRequestSchema.parse(load("request-valid-untrimmed-text-and-tokens"));
    expect(parsed.text).toBe("  keep the spaces around this text  ");
    expect(parsed.concepts).toEqual(["  "]);
    expect(parsed.forbidden_tokens).toEqual(["  ", "Ya", "ya"]);
  });

  it("counts UTF-16 units: the emoji fixtures sit exactly on and over each limit", () => {
    const units = (value: unknown): number => String(value).length;
    expect(units(load("request-valid-title-emoji-200-units").title)).toBe(ANIMATION_TITLE_MAX);
    expect(units(load("request-invalid-title-emoji-over-200-units").title)).toBeGreaterThan(ANIMATION_TITLE_MAX);
    const validConcepts = load("request-valid-concept-emoji-80-units").concepts as string[];
    const invalidConcepts = load("request-invalid-concept-emoji-over-80-units").concepts as string[];
    expect(units(validConcepts[1])).toBe(ANIMATION_CONCEPT_MAX);
    expect(units(invalidConcepts[1])).toBeGreaterThan(ANIMATION_CONCEPT_MAX);
    const validTokens = load("request-valid-forbidden-emoji-80-units").forbidden_tokens as string[];
    const invalidTokens = load("request-invalid-forbidden-emoji-over-80-units").forbidden_tokens as string[];
    expect(units(validTokens[1])).toBe(ANIMATION_FORBIDDEN_TOKEN_MAX);
    expect(units(invalidTokens[1])).toBeGreaterThan(ANIMATION_FORBIDDEN_TOKEN_MAX);
  });
});

// ---------------------------------------------------------------------------
// Boundaries built here
// ---------------------------------------------------------------------------

const BASE = load("request-valid-lesson-minimal");
const PUZZLE_BASE = load("request-valid-puzzle-full");

const ok = (body: unknown): boolean => CreateAnimationRequestSchema.safeParse(body).success;
const withField = (field: string, value: unknown, base: Record<string, unknown> = BASE) => ({
  ...base,
  [field]: value,
});

describe("limits", () => {
  it("title: 200 units pass, 201 fail, and the trim happens before the count", () => {
    expect(ok(withField("title", "a".repeat(ANIMATION_TITLE_MAX)))).toBe(true);
    expect(ok(withField("title", "a".repeat(ANIMATION_TITLE_MAX + 1)))).toBe(false);
    expect(ok(withField("title", ` \t${"a".repeat(ANIMATION_TITLE_MAX)}\n `))).toBe(true);
  });

  it("title: an astral character counts as two units at the limit", () => {
    expect(ok(withField("title", `${"a".repeat(ANIMATION_TITLE_MAX - 2)}😀`))).toBe(true);
    expect(ok(withField("title", `${"a".repeat(ANIMATION_TITLE_MAX - 1)}😀`))).toBe(false);
  });

  it("title: empty, whitespace only and non-strings fail", () => {
    for (const title of ["", " ", "\t\n", "\u00a0\u3000", 0, null, undefined, ["a"], { a: 1 }]) {
      expect(ok(withField("title", title))).toBe(false);
    }
  });

  it("text: 1 to 2000 units, not trimmed", () => {
    expect(ok(withField("text", "a"))).toBe(true);
    expect(ok(withField("text", "a".repeat(ANIMATION_TEXT_MAX)))).toBe(true);
    expect(ok(withField("text", "a".repeat(ANIMATION_TEXT_MAX + 1)))).toBe(false);
    expect(ok(withField("text", ""))).toBe(false);
    expect(ok(withField("text", "   "))).toBe(true);
  });

  it("concepts: at most 5, each 1 to 80 units, optional, never null", () => {
    const concept = "c".repeat(ANIMATION_CONCEPT_MAX);
    expect(ok(withField("concepts", Array(ANIMATION_CONCEPTS_MAX).fill(concept)))).toBe(true);
    expect(ok(withField("concepts", Array(ANIMATION_CONCEPTS_MAX + 1).fill("c")))).toBe(false);
    expect(ok(withField("concepts", [`${concept}x`]))).toBe(false);
    expect(ok(withField("concepts", [""]))).toBe(false);
    expect(ok(withField("concepts", [1]))).toBe(false);
    expect(ok(withField("concepts", null))).toBe(false);
    expect(ok(withField("concepts", "vectors"))).toBe(false);
  });

  it("forbidden_tokens: at most 8, each 1 to 80 units, optional, never null", () => {
    const token = "t".repeat(ANIMATION_FORBIDDEN_TOKEN_MAX);
    expect(ok(withField("forbidden_tokens", Array(ANIMATION_FORBIDDEN_TOKENS_MAX).fill(token), PUZZLE_BASE))).toBe(true);
    expect(ok(withField("forbidden_tokens", Array(ANIMATION_FORBIDDEN_TOKENS_MAX + 1).fill("t"), PUZZLE_BASE))).toBe(
      false
    );
    expect(ok(withField("forbidden_tokens", [`${token}x`], PUZZLE_BASE))).toBe(false);
    expect(ok(withField("forbidden_tokens", [""], PUZZLE_BASE))).toBe(false);
    expect(ok(withField("forbidden_tokens", null, PUZZLE_BASE))).toBe(false);
  });

  it("forbidden_tokens: a lesson takes none, a puzzle takes a list or none", () => {
    expect(ok(withField("forbidden_tokens", ["x"]))).toBe(false);
    expect(ok(withField("forbidden_tokens", []))).toBe(true);
    const puzzleWithout = Object.fromEntries(
      Object.entries(PUZZLE_BASE).filter(([key]) => key !== "forbidden_tokens")
    );
    expect(ok(puzzleWithout)).toBe(true);
    expect(CreateAnimationRequestSchema.parse(puzzleWithout).forbidden_tokens).toEqual([]);
  });

  it("kind and language accept only their listed values", () => {
    for (const kind of ["Lesson", "quiz", "", null, 1]) expect(ok(withField("kind", kind))).toBe(false);
    for (const language of ["EN", "fr", "", null, 1]) expect(ok(withField("language", language))).toBe(false);
    for (const language of ["en", "id"]) expect(ok(withField("language", language))).toBe(true);
  });

  it("visual: required and checked by the lesson visual schema", () => {
    expect(ok(withField("visual", undefined))).toBe(false);
    expect(ok(withField("visual", null))).toBe(false);
    expect(ok(withField("visual", { kind: "vectors", vectors: [] }))).toBe(false);
    expect(ok(withField("visual", { kind: "formula", expression: "a + b", terms: [{ symbol: "a", meaning: "first" }] }))).toBe(
      true
    );
  });

  it("is total: input that is not a body fails without throwing", () => {
    for (const input of [undefined, null, 0, "text", true, [], [BASE], () => BASE, Symbol("x")]) {
      expect(() => CreateAnimationRequestSchema.safeParse(input)).not.toThrow();
      expect(ok(input)).toBe(false);
    }
  });

  it("does not change its input", () => {
    const frozen = JSON.parse(JSON.stringify(PUZZLE_BASE)) as Record<string, unknown>;
    const deepFreeze = (value: unknown): void => {
      if (typeof value !== "object" || value === null) return;
      Object.values(value).forEach(deepFreeze);
      Object.freeze(value);
    };
    deepFreeze(frozen);
    const before = JSON.stringify(frozen);
    expect(ok(frozen)).toBe(true);
    expect(JSON.stringify(frozen)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Lone surrogates
// ---------------------------------------------------------------------------

describe("lone surrogates", () => {
  const HIGH = "\ud800";
  const LOW = "\udc00";

  it("rejects one in any string field, at any position", () => {
    for (const bad of [`a${HIGH}`, `${HIGH}a`, `${LOW}a`, `a${LOW}`, `${LOW}${HIGH}`, `${HIGH}${HIGH}${LOW}${LOW}`]) {
      expect(ok(withField("title", bad))).toBe(false);
      expect(ok(withField("text", bad))).toBe(false);
      expect(ok(withField("concepts", [bad]))).toBe(false);
      expect(ok(withField("forbidden_tokens", [bad], PUZZLE_BASE))).toBe(false);
    }
  });

  it("accepts a well-formed pair, at the ends and in the middle", () => {
    for (const good of ["😀", "a😀", "😀a", "a😀b", "😀😀"]) {
      expect(ok(withField("title", good))).toBe(true);
      expect(ok(withField("text", good))).toBe(true);
    }
  });

  it("rejects one inside the visual and in an unknown key, where Zod would otherwise drop it", () => {
    expect(
      ok(withField("visual", { kind: "vectors", vectors: [{ from: [0, 0], to: [4, 2], label: `A${LOW}` }] }))
    ).toBe(false);
    expect(ok({ ...BASE, [HIGH]: "value" })).toBe(false);
    expect(ok({ ...BASE, extra: { nested: [{ [LOW]: 1 }] } })).toBe(false);
    expect(ok({ ...BASE, extra: [`x${HIGH}`] })).toBe(false);
  });

  it("is checked before the trim could remove anything around it", () => {
    expect(ok(withField("title", ` ${HIGH} `))).toBe(false);
  });

  describe("containsLoneSurrogate", () => {
    it("finds a lone surrogate in strings, keys and nested values only", () => {
      expect(containsLoneSurrogate(`x${HIGH}`)).toBe(true);
      expect(containsLoneSurrogate([[{ a: [LOW] }]])).toBe(true);
      expect(containsLoneSurrogate({ [HIGH]: 1 })).toBe(true);
      expect(containsLoneSurrogate("😀")).toBe(false);
      expect(containsLoneSurrogate({ a: ["ok", 1, null, true, undefined] })).toBe(false);
      expect(containsLoneSurrogate(null)).toBe(false);
      expect(containsLoneSurrogate(12)).toBe(false);
    });

    it("terminates on a self-referencing value and on very deep nesting without a stack overflow", () => {
      const loop: Record<string, unknown> = { name: "loop" };
      loop.self = loop;
      expect(containsLoneSurrogate(loop)).toBe(false);

      let deep: unknown[] = [HIGH];
      for (let i = 0; i < 100_000; i += 1) deep = [deep];
      expect(containsLoneSurrogate(deep)).toBe(true);

      // A very long array: spreading it into `push` would overflow the argument stack.
      expect(containsLoneSurrogate(Array(500_000).fill("a"))).toBe(false);
    });
  });
});
