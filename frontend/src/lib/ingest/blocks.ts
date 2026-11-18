/**
 * Ingest building blocks
 *
 * Format-independent helpers shared by every reader:
 *   - text normalisation and word counting
 *   - turning a flat list of headings/paragraphs into sections
 *   - assembling the final ExtractedDocument
 *
 * Pure functions only — no DOM, no file APIs, no libraries.
 */

import type {
  DocumentFileType,
  DocumentSection,
  DocumentWarning,
  ExtractedDocument,
} from "@/lib/types/document";

/** A heading or paragraph read from a document, in reading order. */
export type TextBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string };

/** A section before it receives its section_id. */
export type RawSection = {
  title: string;
  text: string;
  source_ref: string;
};

/** Paragraph grouping target for documents without headings. */
const GROUP_TARGET_CHARS = 1200;

/** Longest title derived from body text. */
const MAX_DERIVED_TITLE = 80;

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/**
 * Collapse runs of spaces/tabs, trim every line, and keep at most one blank
 * line between paragraphs. Non-breaking spaces become plain spaces.
 */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v ]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

/**
 * A short title taken from the first line of `text`, cut at a word boundary.
 * Falls back to `fallback` when the text is empty.
 */
export function deriveTitle(text: string, fallback: string): string {
  const firstLine = text.trim().split("\n")[0]?.trim() ?? "";
  if (firstLine === "") return fallback;
  if (firstLine.length <= MAX_DERIVED_TITLE) return firstLine;
  const cut = firstLine.slice(0, MAX_DERIVED_TITLE);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Blocks → sections
// ---------------------------------------------------------------------------

/**
 * Split blocks into sections.
 *
 * - With headings: split on the two highest heading levels present (e.g. h1
 *   and h2); deeper headings stay inside the body as their own line. Text
 *   before the first split heading becomes its own section. Sections with
 *   no body text (e.g. a chapter heading directly followed by a subheading)
 *   are dropped.
 * - Without headings: group consecutive paragraphs into ~1200-character
 *   sections titled by their first line.
 *
 * @param refLabel Used for source_ref, e.g. "Section" → "Section 3".
 */
export function sectionsFromBlocks(blocks: TextBlock[], refLabel: string): RawSection[] {
  const clean = blocks
    .map((b) => ({ ...b, text: normalizeText(b.text) }))
    .filter((b) => b.text !== "");

  const levels = [
    ...new Set(
      clean.flatMap((b) => (b.kind === "heading" ? [b.level] : []))
    ),
  ].sort((a, b) => a - b);

  const drafts =
    levels.length === 0
      ? groupParagraphs(clean.map((b) => b.text))
      : splitOnHeadings(clean, levels[1] ?? levels[0]);

  return drafts.map((d, i) => ({ ...d, source_ref: `${refLabel} ${i + 1}` }));
}

function splitOnHeadings(
  blocks: TextBlock[],
  deepestSplitLevel: number
): Array<{ title: string; text: string }> {
  const out: Array<{ title: string; text: string }> = [];
  let title: string | null = null;
  let body: string[] = [];

  const flush = () => {
    const text = body.join("\n\n").trim();
    if (text !== "") out.push({ title: title ?? deriveTitle(text, "Introduction"), text });
    body = [];
  };

  for (const block of blocks) {
    if (block.kind === "heading" && block.level <= deepestSplitLevel) {
      flush();
      title = block.text;
    } else {
      body.push(block.text);
    }
  }
  flush();
  return out;
}

function groupParagraphs(paragraphs: string[]): Array<{ title: string; text: string }> {
  const out: Array<{ title: string; text: string }> = [];
  let chunk: string[] = [];
  let size = 0;

  const flush = () => {
    if (chunk.length === 0) return;
    const text = chunk.join("\n\n");
    out.push({ title: deriveTitle(text, `Part ${out.length + 1}`), text });
    chunk = [];
    size = 0;
  };

  for (const paragraph of paragraphs) {
    if (size > 0 && size + paragraph.length > GROUP_TARGET_CHARS) flush();
    chunk.push(paragraph);
    size += paragraph.length;
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Document assembly
// ---------------------------------------------------------------------------

/**
 * Assign section ids, drop empty sections, and compute stats.
 *
 * @param units Pages/slides in the source; defaults to the section count.
 */
export function buildDocument(input: {
  fileName: string;
  fileType: DocumentFileType;
  sections: RawSection[];
  units?: number;
  warnings?: DocumentWarning[];
}): ExtractedDocument {
  const sections: DocumentSection[] = input.sections
    .map((s) => ({ ...s, text: normalizeText(s.text), title: normalizeText(s.title) }))
    .filter((s) => s.text !== "")
    .map((s, i) => ({
      section_id: `sec_${String(i + 1).padStart(3, "0")}`,
      title: s.title === "" ? s.source_ref : s.title,
      text: s.text,
      source_ref: s.source_ref,
    }));

  return {
    file_name: input.fileName,
    file_type: input.fileType,
    sections,
    stats: {
      units: input.units ?? sections.length,
      words: sections.reduce((n, s) => n + countWords(s.text), 0),
      chars: sections.reduce((n, s) => n + s.text.length, 0),
    },
    warnings: input.warnings ?? [],
  };
}
