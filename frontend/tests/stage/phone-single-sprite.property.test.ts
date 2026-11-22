/**
 * phone-single-sprite.property.test.ts — Property 4: phone draws exactly one sprite.
 *
 * Feature: ui-redesign, Property 4: Phone menggambar tepat satu sprite.
 * Desktop always contains the active speaker and the other character at most once.
 *
 * **Validates: Requirements 8.7, 12.8**
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { visibleSprites } from "@/lib/stage/stage-boxes";

const id = fc.string({ minLength: 1, maxLength: 12 });
const other = fc.option(id, { nil: undefined });

describe("Property 4: phone draws exactly one sprite", () => {
  it("phone returns only the active speaker, whatever the other id is", () => {
    fc.assert(
      fc.property(id, other, (active, o) => {
        const r = visibleSprites("phone", active, o);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.sprites.map((s) => s.id)).toEqual([active]);
        expect(r.sprites[0].role).toBe("active");
      }),
      { numRuns: 100 },
    );
  });

  it("desktop always has the active speaker and the other at most once", () => {
    fc.assert(
      fc.property(id, other, (active, o) => {
        const r = visibleSprites("desktop", active, o);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.sprites[0]).toMatchObject({ id: active, role: "active" });
        const others = r.sprites.filter((s) => s.role === "other");
        expect(others.length).toBeLessThanOrEqual(1);
        expect(r.sprites.filter((s) => s.id === active)).toHaveLength(1);
        expect(r.sprites.length).toBeLessThanOrEqual(2);
      }),
      { numRuns: 100 },
    );
  });
});
