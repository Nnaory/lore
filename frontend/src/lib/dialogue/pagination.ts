/**
 * pagination.ts — fit dialogue text into the dialogue box (pure, no React).
 *
 * Why: the desktop dialogue box (876x181, DESIGN-SYSTEM §4.1/§4.3) shows 3 lines of
 * about 68 characters. The AI is told to write short chunks and the backend splits the
 * rest (`MAX_CHUNK_CHARS`), but saved projects, the demo and any text that still comes
 * out too long must never run over the bottom bar. `paginateText` splits such a text
 * into pages of at most `rows` wrapped lines; the Stage shows one page at a time and
 * SPACE moves to the next page before it moves to the next story line.
 *
 * `MAX_CHUNK_CHARS` mirrors `backend/app/ai/chunking.py` (a test reads that file and
 * fails when the two numbers differ). It is below `cols * rows` on purpose: greedy word
 * wrapping wastes a few characters per line.
 *
 * Nothing here throws. A capacity that cannot be used leaves the text in one page.
 */

import type { StageLayout } from "@/lib/stage/board-scale";

/** Longest chunk of text the AI side produces (backend `MAX_CHUNK_CHARS`). */
export const MAX_CHUNK_CHARS = 180;

export interface PageCapacity {
  /** Characters per line (mono 17px in a 700px column: 68). */
  readonly cols: number;
  /** Lines that fit above the bottom bar. */
  readonly rows: number;
}

/**
 * What the dialogue box holds per layout. The phone box scrolls its text area, so it has no
 * page limit (`null`).
 */
export const DIALOGUE_CAPACITY: Readonly<Record<StageLayout, PageCapacity | null>> = {
  desktop: { cols: 68, rows: 3 },
  phone: null,
};

interface Line {
  /** Index of the paragraph (text between newlines) this line belongs to. */
  readonly paragraph: number;
  readonly text: string;
}

function isUsable(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1;
}

/** Greedy word wrap by code points. Words longer than a line are cut. */
export function wrapLines(text: string, cols: number): string[] {
  return wrapParagraphs(text, cols).map((line) => line.text);
}

function wrapParagraphs(text: string, cols: number): Line[] {
  const lines: Line[] = [];
  text.split("\n").forEach((paragraph, index) => {
    const words = paragraph.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) {
      lines.push({ paragraph: index, text: "" });
      return;
    }
    let current = "";
    let currentLength = 0;
    const flush = () => {
      if (currentLength > 0) lines.push({ paragraph: index, text: current });
      current = "";
      currentLength = 0;
    };
    for (const word of words) {
      const chars = Array.from(word);
      // A word longer than a whole line is cut into line-sized pieces.
      let rest = chars;
      while (rest.length > cols) {
        flush();
        lines.push({ paragraph: index, text: rest.slice(0, cols).join("") });
        rest = rest.slice(cols);
      }
      const pieceLength = rest.length;
      if (pieceLength === 0) continue;
      const piece = rest.join("");
      if (currentLength === 0) {
        current = piece;
        currentLength = pieceLength;
      } else if (currentLength + 1 + pieceLength <= cols) {
        current += ` ${piece}`;
        currentLength += 1 + pieceLength;
      } else {
        flush();
        current = piece;
        currentLength = pieceLength;
      }
    }
    flush();
  });
  return lines;
}

/**
 * Split `text` into pages of at most `capacity.rows` wrapped lines.
 *
 * A text that already fits (or a capacity that is missing or unusable) comes back
 * unchanged as one page, so short lines keep their exact spacing. Longer text is
 * re-flowed with single spaces; paragraph breaks (newlines) are kept.
 */
export function paginateText(text: string, capacity: PageCapacity | null): string[] {
  if (capacity === null || !isUsable(capacity.cols) || !isUsable(capacity.rows)) return [text];
  const lines = wrapParagraphs(text, capacity.cols);
  if (lines.length <= capacity.rows) return [text];

  const pages: string[] = [];
  for (let start = 0; start < lines.length; start += capacity.rows) {
    const slice = lines.slice(start, start + capacity.rows);
    let page = "";
    slice.forEach((line, i) => {
      if (i > 0) page += line.paragraph === slice[i - 1].paragraph ? " " : "\n";
      page += line.text;
    });
    pages.push(page);
  }
  return pages;
}
