/**
 * pagination.test.ts — dialogue text pagination and the shared chunk limit.
 *
 * Why: long text must never run over the bottom bar of the dialogue box. These tests pin
 * the word wrap, the page size, the unchanged short text, the unusable-capacity fallback,
 * and that `MAX_CHUNK_CHARS` equals the backend's number and fits the desktop box.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DIALOGUE_CAPACITY,
  MAX_CHUNK_CHARS,
  paginateText,
  wrapLines,
} from "@/lib/dialogue/pagination";

const DESKTOP = { cols: 68, rows: 3 };

/** Sentences of ordinary length, enough to fill many pages. */
const PROSE =
  "Each crystal emits energy as a vector: a quantity with both direction and magnitude. " +
  "Crystal A points toward the east gate with a strength of two. " +
  "Crystal B points toward the north tower with a strength of one. " +
  "To produce a target resonance, you scale each crystal by how many times it is used. " +
  "The beacon only stabilises when the sum of the scaled arrows lands on the target.";

describe("wrapLines", () => {
  it("wraps greedily at the column limit without breaking words", () => {
    const lines = wrapLines("aaa bbb ccc", 7);
    expect(lines).toEqual(["aaa bbb", "ccc"]);
  });

  it("cuts a word that is longer than a whole line", () => {
    expect(wrapLines("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("keeps an empty paragraph as an empty line", () => {
    expect(wrapLines("a\n\nb", 10)).toEqual(["a", "", "b"]);
  });

  it("counts code points, not UTF-16 units", () => {
    expect(wrapLines("😀😀😀😀 😀", 4)).toEqual(["😀😀😀😀", "😀"]);
  });
});

describe("paginateText", () => {
  it("returns a text that fits as one unchanged page", () => {
    const text = "Short line.\nSecond   line with  spacing.";
    expect(paginateText(text, DESKTOP)).toEqual([text]);
  });

  it("splits long text into pages of at most `rows` lines", () => {
    const pages = paginateText(PROSE, DESKTOP);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(wrapLines(page, DESKTOP.cols).length).toBeLessThanOrEqual(DESKTOP.rows);
    }
  });

  it("keeps every word, in order", () => {
    const pages = paginateText(PROSE, DESKTOP);
    const words = (s: string) => s.split(/\s+/).filter(Boolean);
    expect(pages.flatMap(words)).toEqual(words(PROSE));
  });

  it("keeps paragraph breaks between pages' lines", () => {
    const text = `${"word ".repeat(20).trim()}\n${"other ".repeat(20).trim()}`;
    const pages = paginateText(text, { cols: 30, rows: 2 });
    expect(pages.every((p) => wrapLines(p, 30).length <= 2)).toBe(true);
    expect(pages.join("\n").includes("\n")).toBe(true);
  });

  it("leaves the text alone when there is no capacity (phone scrolls instead)", () => {
    expect(paginateText(PROSE, DIALOGUE_CAPACITY.phone)).toEqual([PROSE]);
  });

  it("does not throw on an unusable capacity and returns one page", () => {
    expect(paginateText(PROSE, { cols: 0, rows: 3 })).toEqual([PROSE]);
    expect(paginateText(PROSE, { cols: 68, rows: -1 })).toEqual([PROSE]);
    expect(paginateText(PROSE, { cols: 6.5, rows: 3 })).toEqual([PROSE]);
  });

  it("handles empty text", () => {
    expect(paginateText("", DESKTOP)).toEqual([""]);
  });
});

describe("MAX_CHUNK_CHARS", () => {
  it("equals the backend constant", () => {
    const source = readFileSync(
      path.resolve(__dirname, "../../../backend/app/ai/chunking.py"),
      "utf8",
    );
    const match = /^MAX_CHUNK_CHARS\s*=\s*(\d+)/m.exec(source);
    expect(match).not.toBeNull();
    expect(MAX_CHUNK_CHARS).toBe(Number(match?.[1]));
  });

  it("is below what the desktop box holds, so word wrap waste still fits", () => {
    const capacity = DIALOGUE_CAPACITY.desktop;
    expect(capacity).not.toBeNull();
    expect(MAX_CHUNK_CHARS).toBeLessThan((capacity?.cols ?? 0) * (capacity?.rows ?? 0));
  });

  it("a full chunk of ordinary prose fits in one page", () => {
    const chunk = PROSE.slice(0, MAX_CHUNK_CHARS).replace(/\s+\S*$/, "");
    expect(paginateText(chunk, DESKTOP)).toEqual([chunk]);
  });
});
