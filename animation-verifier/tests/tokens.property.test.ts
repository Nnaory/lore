// Property 11: Paritas normalisasi token Python dan TypeScript (separuh TypeScript, tugas 7.4).
// Validates: Requirements 10.13

import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { normalizeToken } from "../src/tokens.js";

const FIXTURE_URL = new URL(
  "../../backend/tests/fixtures/animation/token-normalization.json",
  import.meta.url,
);

const VECTORS = JSON.parse(readFileSync(FIXTURE_URL, "utf8")) as Array<{
  name: string;
  input: string;
  expected: string;
}>;

// Beberapa karakter NFKC (mis. tanda gabung yang terpisah oleh spasi seperti `e \u0301` atau
// U+00A8/U+309B/U+FF9E) bisa menyatu pada putaran kedua setelah spasi dihapus.
const HAS_COMBINING_OR_COMPAT_MARK = /\p{M}|[\u00a8\u02d8-\u02dd\u309b\u309c\uff9e\uff9f]/u;

describe("Property 11: Paritas normalisasi token (sisi TypeScript)", () => {
  it("setiap vektor pada fixture bersama cocok dengan normalizeToken", () => {
    expect(VECTORS.length).toBeGreaterThanOrEqual(20);
    for (const vector of VECTORS) {
      expect(normalizeToken(vector.input), vector.name).toBe(vector.expected);
    }
  });

  it("setara dengan NFKC + lowercase + hapus \\s untuk string acak", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 64 }), (s) => {
        const expected = s.normalize("NFKC").toLowerCase().replace(/\s/g, "");
        expect(normalizeToken(s)).toBe(expected);
      }),
      { numRuns: 300 },
    );
  });

  it("idempoten untuk string acak tanpa tanda gabung/kompatibilitas yang menyatu pasca-spasi", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 64 }).filter((s) => !HAS_COMBINING_OR_COMPAT_MARK.test(s.normalize("NFKC"))),
        (s) => {
          const once = normalizeToken(s);
          expect(normalizeToken(once)).toBe(once);
        },
      ),
      { numRuns: 300 },
    );
  });
});
