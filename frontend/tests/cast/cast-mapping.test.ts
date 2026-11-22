/**
 * Property tests for cast-mapping: Kit cast ids and names always map to
 * themselves, whatever the letter case or edge whitespace.
 *
 * Feature: ui-redesign, Property 6 (Id dan nama cast selalu dipetakan ke dirinya).
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  CAST_ORDER,
  emotionToExpression,
  mapCharacter,
  mapExpression,
  resolveCampaignCast,
} from "@/lib/cast/cast-mapping";
import type { Character } from "@/lib/types/campaign";
import { emotionFor } from "@/components/stage/emotion";

const EXPRESSIONS = ["calm", "smile", "worried", "surprised", "angry"];

const castIdArb = fc.constantFrom(...CAST_ORDER);
const spaceArb = fc.stringMatching(/^[ \t\n]{0,4}$/);

/** Random upper/lower casing of each letter plus edge whitespace. */
const variantOf = (id: string) =>
  fc
    .tuple(fc.array(fc.boolean(), { minLength: id.length, maxLength: id.length }), spaceArb, spaceArb)
    .map(([flags, pre, post]) => {
      const body = [...id].map((ch, i) => (flags[i] ? ch.toUpperCase() : ch)).join("");
      return `${pre}${body}${post}`;
    });

const castVariantArb = castIdArb.chain((id) => variantOf(id).map((v) => ({ id, v })));

const unknownIdArb = fc
  .string({ maxLength: 20 })
  .filter((s) => !(CAST_ORDER as readonly string[]).includes(s.trim().toLowerCase()))
  .filter((s) => s.trim() !== "");

describe("Property 6: cast id and name map to themselves", () => {
  it("maps any case/whitespace variant of a cast id by id", () => {
    fc.assert(
      fc.property(castVariantArb, fc.string({ maxLength: 20 }), ({ id, v }, name) => {
        const r = mapCharacter({ character_id: v, name });
        expect(r).toEqual({ ok: true, castId: id, matchedBy: "id" });
      }),
      { numRuns: 100 },
    );
  });

  it("maps an unknown id with a cast-name variant by name", () => {
    fc.assert(
      fc.property(unknownIdArb, castVariantArb, (unknownId, { id, v }) => {
        const r = mapCharacter({ character_id: unknownId, name: v });
        expect(r).toEqual({ ok: true, castId: id, matchedBy: "name" });
      }),
      { numRuns: 100 },
    );
  });

  it("every ok result carries a castId from the cast list", () => {
    fc.assert(
      fc.property(fc.oneof(castVariantArb.map((x) => x.v), fc.string({ maxLength: 20 })), fc.string({ maxLength: 20 }), (a, b) => {
        for (const r of [mapCharacter({ character_id: a, name: b }), mapCharacter({ character_id: b, name: a })]) {
          if (r.ok) expect(CAST_ORDER).toContain(r.castId);
        }
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: ui-redesign, Property 7
 * (Pemetaan karakter dan ekspresi deterministik, total, dan tanpa throw).
 * Validates: Requirements 6.6, 6.7, 13.3
 */
const CHARACTER_REASONS = ["unknown_character", "empty_character"];
const EXPRESSION_REASONS = ["unknown_expression", "empty_expression"];

/** Arbitrary text: empty, whitespace, Unicode, and long strings. */
const anyTextArb = fc.oneof(
  fc.constant(""),
  spaceArb,
  fc.string({ maxLength: 30 }),
  fc.string({ unit: "binary", maxLength: 30 }),
  fc.string({ minLength: 500, maxLength: 2000 }),
);

describe("Property 7: mapping is deterministic, total, and never throws", () => {
  it("mapCharacter is total, deterministic, and echoes the id on failure", () => {
    fc.assert(
      fc.property(anyTextArb, anyTextArb, (id, name) => {
        const input = { character_id: id, name };
        const a = mapCharacter(input);
        const b = mapCharacter({ ...input });
        expect(typeof a.ok).toBe("boolean");
        expect(b).toEqual(a);
        if (!a.ok) {
          expect(CHARACTER_REASONS).toContain(a.reason);
          expect(a.value).toBe(id);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("mapExpression is total, deterministic, and echoes the key on failure", () => {
    fc.assert(
      fc.property(anyTextArb, (key) => {
        const a = mapExpression(key);
        const b = mapExpression(key);
        expect(typeof a.ok).toBe("boolean");
        expect(b).toEqual(a);
        if (a.ok) expect(EXPRESSIONS).toContain(a.expression);
        else {
          expect(EXPRESSION_REASONS).toContain(a.reason);
          expect(a.value).toBe(key);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("does not throw on undefined or non-string inputs", () => {
    expect(() => mapExpression(undefined)).not.toThrow();
    expect(mapExpression(undefined)).toMatchObject({ ok: false, reason: "empty_expression" });
    for (const bad of [undefined, null, 42, {}] as unknown[]) {
      expect(() => mapCharacter({ character_id: bad, name: bad } as never)).not.toThrow();
    }
  });
});

/**
 * Feature: ui-redesign, Property 8
 * (Pemetaan ekspresi setia pada lima ekspresi Kit dan konsisten dengan emotionFor).
 * Validates: Requirements 6.4, 6.5
 */
const KEYWORD_FRAGMENTS = [
  "worr", "nerv", "happ", "approv", "stern", "angr", "surpri", "shock",
  "think", "curio", "expla", "teach", "calm", "smil",
];

/** Keys that mix a known keyword fragment with random text, in any letter case. */
const keywordKeyArb = fc
  .tuple(fc.string({ maxLength: 8 }), fc.constantFrom(...KEYWORD_FRAGMENTS), fc.string({ maxLength: 8 }), fc.boolean())
  .map(([pre, kw, post, upper]) => (upper ? `${pre}${kw}${post}`.toUpperCase() : `${pre}${kw}${post}`));

const mixedKeyArb = fc.oneof(keywordKeyArb, fc.string({ maxLength: 30 }), fc.string({ unit: "binary", maxLength: 30 }));

describe("Property 8: expression mapping is faithful to the Kit and consistent with emotionFor", () => {
  it("maps each canonical Kit expression to itself, ignoring case and edge whitespace", () => {
    const exprArb = fc.constantFrom(...EXPRESSIONS);
    fc.assert(
      fc.property(exprArb.chain((e) => variantOf(e).map((v) => ({ e, v }))), ({ e, v }) => {
        expect(mapExpression(v)).toEqual({ ok: true, expression: e });
      }),
      { numRuns: 100 },
    );
  });

  it("returns emotionToExpression(emotionFor(key)) whenever emotionFor recognises the key", () => {
    fc.assert(
      fc.property(mixedKeyArb, (key) => {
        const emotion = emotionFor(key);
        fc.pre(emotion !== "idle");
        expect(mapExpression(key)).toEqual({ ok: true, expression: emotionToExpression(emotion) });
      }),
      { numRuns: 200 },
    );
  });

  it("every ok result is one of the five Kit expressions", () => {
    fc.assert(
      fc.property(mixedKeyArb, (key) => {
        const r = mapExpression(key);
        if (r.ok) expect(EXPRESSIONS).toContain(r.expression);
      }),
      { numRuns: 200 },
    );
  });
});

/**
 * Feature: ui-redesign, Property 9
 * (Alokasi cast kampanye deterministik dan tidak bertabrakan sampai lima karakter).
 * Validates: Requirements 6.7, 12.6
 */
const characterArb = fc
  .tuple(
    fc.oneof(castVariantArb.map((x) => x.v), fc.string({ maxLength: 12 })),
    fc.oneof(castVariantArb.map((x) => x.v), fc.string({ maxLength: 12 })),
  )
  .map(([character_id, name]): Character => ({ character_id, name, role: "", description: "", expressions: {} }));

const campaignArb = (maxLength: number, minLength = 0) =>
  fc.uniqueArray(characterArb, { selector: (c) => c.character_id, minLength, maxLength });

describe("Property 9: campaign cast allocation is total, deterministic, and collision-free up to five", () => {
  it("returns an entry with a valid cast for every character, identically on repeated calls", () => {
    fc.assert(
      fc.property(campaignArb(12), (chars) => {
        const a = resolveCampaignCast(chars);
        const b = resolveCampaignCast(chars.map((c) => ({ ...c })));
        expect(a.size).toBe(chars.length);
        for (const c of chars) {
          const entry = a.get(c.character_id);
          expect(entry).toBeDefined();
          expect(CAST_ORDER).toContain(entry!.castId);
        }
        expect([...b.entries()]).toEqual([...a.entries()]);
      }),
      { numRuns: 100 },
    );
  });

  it("gives a mapped character its mapped cast unless an earlier mapped character already took it", () => {
    fc.assert(
      fc.property(campaignArb(12), (chars) => {
        const result = resolveCampaignCast(chars);
        const taken = new Set<string>();
        for (const c of chars) {
          const m = mapCharacter(c);
          if (m.ok && !taken.has(m.castId)) {
            taken.add(m.castId);
            expect(result.get(c.character_id)).toEqual({ castId: m.castId, mapped: true });
          } else {
            expect(result.get(c.character_id)?.mapped).toBe(false);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it("assigns pairwise different casts for up to five characters", () => {
    fc.assert(
      fc.property(campaignArb(5), (chars) => {
        const result = resolveCampaignCast(chars);
        const casts = chars.map((c) => result.get(c.character_id)!.castId);
        expect(new Set(casts).size).toBe(chars.length);
      }),
      { numRuns: 200 },
    );
  });

  it("stays total with all five casts used once the list passes five characters", () => {
    fc.assert(
      fc.property(campaignArb(15, 6), (chars) => {
        const result = resolveCampaignCast(chars);
        expect(result.size).toBe(chars.length);
        expect(new Set([...result.values()].map((v) => v.castId)).size).toBe(CAST_ORDER.length);
      }),
      { numRuns: 100 },
    );
  });
});
