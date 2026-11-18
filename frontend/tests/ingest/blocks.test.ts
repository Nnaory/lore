/**
 * Tests — Ingest building blocks, plain-text reader, and material text
 */

import { describe, it, expect } from "vitest";
import {
  buildDocument,
  countWords,
  deriveTitle,
  normalizeText,
  sectionsFromBlocks,
  type TextBlock,
} from "@/lib/ingest/blocks";
import { extractText, textToBlocks } from "@/lib/ingest/text";
import { buildMaterialText } from "@/lib/ingest/material-text";
import { IngestError } from "@/lib/ingest/errors";
import { ExtractedDocumentSchema } from "@/lib/ai/schemas/document.schema";

describe("normalizeText", () => {
  it("collapses spaces, trims lines, and keeps at most one blank line", () => {
    expect(normalizeText("  a \t  b  \r\n\r\n\r\n\r\n  c d  ")).toBe("a b\n\nc d");
  });
});

describe("countWords", () => {
  it("counts whitespace-separated words", () => {
    expect(countWords("one two\nthree")).toBe(3);
    expect(countWords("   ")).toBe(0);
  });
});

describe("deriveTitle", () => {
  it("uses the first line", () => {
    expect(deriveTitle("Vector Span\nbody", "Fallback")).toBe("Vector Span");
  });

  it("falls back when the text is empty", () => {
    expect(deriveTitle("  ", "Page 3")).toBe("Page 3");
  });

  it("cuts long first lines at a word boundary", () => {
    const title = deriveTitle("word ".repeat(40), "x");
    expect(title.length).toBeLessThanOrEqual(81);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toMatch(/ …$/);
  });
});

describe("sectionsFromBlocks — with headings", () => {
  const blocks: TextBlock[] = [
    { kind: "paragraph", text: "Course notes for week 3." },
    { kind: "heading", level: 1, text: "Linear Algebra" },
    { kind: "heading", level: 2, text: "Linear Combinations" },
    { kind: "paragraph", text: "A linear combination scales and adds vectors." },
    { kind: "heading", level: 3, text: "Worked example" },
    { kind: "paragraph", text: "2(2,1) + 1(1,2) = (5,4)" },
    { kind: "heading", level: 2, text: "Span" },
    { kind: "paragraph", text: "The span is every combination." },
  ];
  const sections = sectionsFromBlocks(blocks, "Section");

  it("keeps text before the first heading as its own section", () => {
    expect(sections[0]).toMatchObject({ title: "Course notes for week 3.", source_ref: "Section 1" });
  });

  it("drops a heading that has no body of its own", () => {
    expect(sections.map((s) => s.title)).not.toContain("Linear Algebra");
  });

  it("splits on the two highest heading levels and keeps deeper headings in the body", () => {
    expect(sections.map((s) => s.title)).toEqual([
      "Course notes for week 3.",
      "Linear Combinations",
      "Span",
    ]);
    expect(sections[1].text).toContain("Worked example");
    expect(sections[1].text).toContain("(5,4)");
  });

  it("numbers source refs after dropping empty sections", () => {
    expect(sections.map((s) => s.source_ref)).toEqual(["Section 1", "Section 2", "Section 3"]);
  });
});

describe("sectionsFromBlocks — without headings", () => {
  it("groups paragraphs into ~1200 character sections", () => {
    const paragraph = "x".repeat(500);
    const blocks: TextBlock[] = Array.from({ length: 5 }, () => ({ kind: "paragraph", text: paragraph }));
    const sections = sectionsFromBlocks(blocks, "Part");
    expect(sections).toHaveLength(3); // 2 + 2 + 1 paragraphs
    expect(sections.map((s) => s.source_ref)).toEqual(["Part 1", "Part 2", "Part 3"]);
  });

  it("ignores blocks that are only whitespace", () => {
    expect(sectionsFromBlocks([{ kind: "paragraph", text: "  \n " }], "Part")).toEqual([]);
  });
});

describe("buildDocument", () => {
  it("assigns sequential section ids and computes stats", () => {
    const doc = buildDocument({
      fileName: "notes.txt",
      fileType: "text",
      sections: [
        { title: "A", text: "one two", source_ref: "Part 1" },
        { title: "B", text: "   ", source_ref: "Part 2" },
        { title: "", text: "three", source_ref: "Part 3" },
      ],
    });
    expect(doc.sections.map((s) => s.section_id)).toEqual(["sec_001", "sec_002"]);
    expect(doc.sections[1].title).toBe("Part 3"); // empty title falls back to the source ref
    expect(doc.stats).toEqual({ units: 2, words: 3, chars: 12 });
    expect(ExtractedDocumentSchema.safeParse(doc).success).toBe(true);
  });
});

describe("text reader", () => {
  it("treats markdown headings as headings", () => {
    expect(textToBlocks("# Title\n\nBody line one\nline two\n\n## Next")).toEqual([
      { kind: "heading", level: 1, text: "Title" },
      { kind: "paragraph", text: "Body line one\nline two" },
      { kind: "heading", level: 2, text: "Next" },
    ]);
  });

  it("builds a schema-valid document from pasted text", () => {
    const doc = extractText("## Vectors\nA vector has direction.\n\n## Span\nAll combinations.", "Pasted text");
    expect(doc.file_type).toBe("text");
    expect(doc.sections.map((s) => [s.title, s.source_ref])).toEqual([
      ["Vectors", "Part 1"],
      ["Span", "Part 2"],
    ]);
    expect(ExtractedDocumentSchema.safeParse(doc).success).toBe(true);
  });

  it("rejects text with nothing in it", () => {
    expect(() => extractText(" \n\n ", "empty.txt")).toThrow(IngestError);
  });
});

describe("buildMaterialText", () => {
  const doc = extractText("## Vectors\nDirection and size.\n\n## Span\nAll combinations.\n\n## Basis\nMinimal spanning set.", "notes.md");

  it("joins only the selected sections, in document order, with source headers", () => {
    const text = buildMaterialText(doc, ["sec_003", "sec_001"]);
    expect(text).toBe("[Part 1] Vectors\nDirection and size.\n\n[Part 3] Basis\nMinimal spanning set.");
  });

  it("returns an empty string when nothing is selected", () => {
    expect(buildMaterialText(doc, new Set())).toBe("");
  });
});
