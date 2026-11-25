/**
 * Example tests for cast mapping failures: one ok:true and one ok:false case per
 * failure reason, no throws on bad input, and the NARRATION fallback tag.
 * Why: the UI relies on these results to fall back instead of stopping the story.
 */
import { describe, expect, it } from "vitest";
import {
  mapCharacter,
  mapExpression,
  NARRATION_TAG,
  speakerTagName,
} from "@/lib/cast/cast-mapping";
import type { Character } from "@/lib/types/campaign";

describe("mapCharacter failures", () => {
  it("maps a known id (ok: true)", () => {
    expect(mapCharacter({ character_id: "Mira", name: "x" })).toEqual({
      ok: true,
      castId: "mira",
      matchedBy: "id",
    });
  });

  it("returns unknown_character for an unmapped id and name", () => {
    expect(mapCharacter({ character_id: "zed", name: "Zed" })).toEqual({
      ok: false,
      reason: "unknown_character",
      value: "zed",
    });
  });

  it("maps by name when the id is unknown (ok: true)", () => {
    expect(mapCharacter({ character_id: "c1", name: " Nyx " })).toEqual({
      ok: true,
      castId: "nyx",
      matchedBy: "name",
    });
  });

  it("returns empty_character when id and name are blank", () => {
    expect(mapCharacter({ character_id: "  ", name: "" })).toEqual({
      ok: false,
      reason: "empty_character",
      value: "  ",
    });
  });

  it("does not throw on malformed input", () => {
    expect(() => mapCharacter(undefined as never)).not.toThrow();
    expect(mapCharacter({ character_id: 5, name: null } as never)).toMatchObject({
      ok: false,
      reason: "empty_character",
    });
  });
});

describe("mapExpression failures", () => {
  it("maps a known keyword (ok: true)", () => {
    expect(mapExpression("worried")).toEqual({ ok: true, expression: "worried" });
    expect(mapExpression("Neutral")).toEqual({ ok: true, expression: "calm" });
  });

  it("returns unknown_expression for an unrecognised word", () => {
    expect(mapExpression("xyzzy")).toEqual({
      ok: false,
      reason: "unknown_expression",
      value: "xyzzy",
    });
  });

  it("returns empty_expression for undefined and blank keys", () => {
    expect(mapExpression(undefined)).toEqual({
      ok: false,
      reason: "empty_expression",
      value: "",
    });
    expect(mapExpression("   ")).toMatchObject({ ok: false, reason: "empty_expression" });
  });

  it("does not throw on a non-string key", () => {
    expect(() => mapExpression(42 as never)).not.toThrow();
  });
});

describe("speakerTagName NARRATION fallback", () => {
  const chars = [
    { character_id: "mira", name: "Mira Voss" },
    { character_id: "blank", name: "  " },
  ] as unknown as Character[];

  it("returns the character name for a known speaker", () => {
    expect(speakerTagName("mira", chars)).toBe("Mira Voss");
  });

  it("returns NARRATION for narrator, undefined, empty, unknown or nameless speakers", () => {
    for (const id of ["narrator", "NARRATOR", undefined, "", "ghost", "blank"]) {
      expect(speakerTagName(id, chars)).toBe(NARRATION_TAG);
    }
    expect(NARRATION_TAG).toBe("NARRATION");
  });
});
