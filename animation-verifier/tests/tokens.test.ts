// Tes normalisasi token verifier (Requirement 10.1, 10.9, 10.13; design 5.10, 14.4).
// Fixture bersama `backend/tests/fixtures/animation/token-normalization.json` dibaca juga oleh
// Pytest (`normalize_token`), jadi nilai `expected` di sana adalah kebenaran lintas bahasa.
// Karena `expected` dihitung dari `normalizeToken` itu sendiri, tes ini juga memuat tegasan literal
// yang tidak bergantung pada fixture agar kesesuaian tidak melingkar.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { containsToken, normalizeToken } from "../src/tokens.js";

const FIXTURE_URL = new URL(
  "../../backend/tests/fixtures/animation/token-normalization.json",
  import.meta.url,
);
const MIN_VECTORS = 20;

// Spasi ECMAScript (`\s`) menurut ECMA-262: WhiteSpace dan LineTerminator, termasuk U+FEFF.
const ECMA_WHITESPACE = [
  "\t", "\n", "\v", "\f", "\r", " ", "\u00a0", "\u1680",
  "\u2000", "\u2001", "\u2002", "\u2003", "\u2004", "\u2005", "\u2006", "\u2007", "\u2008",
  "\u2009", "\u200a", "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff",
];

const vectorSchema = z.object({ name: z.string().min(1), input: z.string(), expected: z.string() }).strict();
const fixtureSchema = z.array(vectorSchema).min(MIN_VECTORS);

const parsed = fixtureSchema.safeParse(JSON.parse(readFileSync(FIXTURE_URL, "utf8")));
const vectors = parsed.success ? parsed.data : [];

// Satu-satunya vektor yang sengaja tidak idempoten: menghapus spasi setelah NFKC mempertemukan
// huruf dasar dengan tanda gabung, yang baru tersusun menjadi satu karakter pada NFKC berikutnya.
const NOT_IDEMPOTENT = new Set(["whitespace-between-base-and-combining-mark"]);

describe("fixture normalisasi token", () => {
  it("sah menurut skema dan memuat sedikitnya 20 vektor dengan nama unik", () => {
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
    expect(vectors.length).toBeGreaterThanOrEqual(MIN_VECTORS);
    expect(new Set(vectors.map((v) => v.name)).size).toBe(vectors.length);
  });

  it("memuat kasus wajib: U+FEFF, U+200B, İ, ß, huruf lebar penuh, U+00A0, dan U+3000", () => {
    const inputs = vectors.map((v) => v.input);
    const covers = (needle: RegExp) => inputs.some((input) => needle.test(input));
    expect(covers(/\ufeff/)).toBe(true);
    expect(covers(/\u200b/)).toBe(true);
    expect(covers(/\u0130/)).toBe(true);
    expect(covers(/\u00df/)).toBe(true);
    expect(covers(/[\uff21-\uff3a\uff41-\uff5a\uff10-\uff19]/)).toBe(true);
    expect(covers(/\u00a0/)).toBe(true);
    expect(covers(/\u3000/)).toBe(true);
  });

  it("setiap `expected` tidak memuat spasi ECMAScript", () => {
    for (const v of vectors) expect(/\s/.test(v.expected), v.name).toBe(false);
  });
});

describe("normalizeToken: vektor fixture bersama", () => {
  it.each(vectors.map((v) => [v.name, v.input, v.expected] as const))("%s", (_name, input, expected) => {
    expect(normalizeToken(input)).toBe(expected);
  });
});

describe("normalizeToken: tegasan literal (tidak bergantung pada fixture)", () => {
  it("menghapus U+FEFF dan semua spasi ECMAScript", () => {
    expect(normalizeToken("\ufeffA\ufeffB")).toBe("ab");
    for (const ws of ECMA_WHITESPACE) expect(normalizeToken(`a${ws}b`), JSON.stringify(ws)).toBe("ab");
  });

  it("mempertahankan karakter lebar nol yang bukan spasi ECMAScript", () => {
    expect(normalizeToken("a\u200bb")).toBe("a\u200bb");
    expect(normalizeToken("a\u200cb\u200dc\u2060d")).toBe("a\u200cb\u200dc\u2060d");
    expect(normalizeToken("a\u0085b\u180ec")).toBe("a\u0085b\u180ec");
  });

  it("memetakan huruf lebar penuh dan spasi U+3000 lewat NFKC", () => {
    expect(normalizeToken("ＡＢＣ　１２３")).toBe("abc123");
  });

  it("menurunkan huruf besar tanpa locale dan tanpa pelipatan kasus", () => {
    expect(normalizeToken("İ")).toBe("i\u0307");
    expect(normalizeToken("I")).toBe("i");
    expect(normalizeToken("ß")).toBe("ß");
    expect(normalizeToken("ẞ")).toBe("ß");
    expect(normalizeToken("Straße")).not.toBe("strasse");
  });

  it("menjalankan urutan NFKC, lowercase, lalu hapus spasi", () => {
    // Spasi dihapus setelah NFKC: tanda gabung tidak disusun ulang dengan huruf dasarnya.
    expect(normalizeToken("e \u0301")).toBe("e\u0301");
    expect(normalizeToken("e\u0301")).toBe("\u00e9");
    // U+3000 dan U+00A0 menjadi spasi biasa pada NFKC, lalu terhapus.
    expect(normalizeToken("\u3000\u00a0")).toBe("");
  });
});

describe("normalizeToken: kasus kosong dan idempotensi", () => {
  it("string kosong dan string yang hanya berisi spasi menjadi kosong (Requirement 10.9)", () => {
    expect(normalizeToken("")).toBe("");
    expect(normalizeToken(ECMA_WHITESPACE.join(""))).toBe("");
    expect(normalizeToken("\u3000\ufeff \t\n")).toBe("");
  });

  it("idempoten pada setiap input dan `expected` fixture", () => {
    for (const v of vectors) {
      if (NOT_IDEMPOTENT.has(v.name)) continue;
      expect(normalizeToken(v.expected), v.name).toBe(v.expected);
      expect(normalizeToken(normalizeToken(v.input)), v.name).toBe(v.expected);
    }
  });

  it("mencatat satu-satunya pengecualian idempotensi agar perubahan perilakunya terlihat", () => {
    const exception = vectors.find((v) => NOT_IDEMPOTENT.has(v.name));
    expect(exception).toBeDefined();
    if (!exception) return;
    expect(normalizeToken(exception.expected)).not.toBe(exception.expected);
  });
});

describe("containsToken", () => {
  it("benar bila token adalah substring teks frame", () => {
    expect(containsToken("vektorposisi(x,y)", "posisi")).toBe(true);
    expect(containsToken("abc", "abc")).toBe(true);
    expect(containsToken("abc", "a")).toBe(true);
    expect(containsToken("abc", "c")).toBe(true);
  });

  it("salah bila token tidak ada atau lebih panjang dari teks frame", () => {
    expect(containsToken("abc", "abd")).toBe(false);
    expect(containsToken("abc", "abcd")).toBe(false);
    expect(containsToken("", "a")).toBe(false);
  });

  it("token kosong selalu terkandung, jadi pemanggil membuangnya lebih dulu (Requirement 10.9)", () => {
    expect(containsToken("", "")).toBe(true);
    expect(containsToken("abc", "")).toBe(true);
  });

  it("mencocokkan setelah kedua sisi dinormalkan (Requirement 10.1)", () => {
    const frame = normalizeToken("Ｖektor\u00a0Posisi\u3000(x, y)");
    expect(containsToken(frame, normalizeToken("vektor posisi"))).toBe(true);
    expect(containsToken(frame, normalizeToken("  (X,Y) "))).toBe(true);
    expect(containsToken(frame, normalizeToken("posisi vektor"))).toBe(false);
  });

  it("U+FEFF di teks frame tidak memisahkan token, tetapi U+200B memisahkannya", () => {
    expect(containsToken(normalizeToken("A\ufeffB"), normalizeToken("ab"))).toBe(true);
    expect(containsToken(normalizeToken("A\u200bB"), normalizeToken("ab"))).toBe(false);
  });
});
