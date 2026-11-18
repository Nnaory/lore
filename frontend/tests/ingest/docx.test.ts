/**
 * Tests — Word (.docx) reader
 *
 * @vitest-environment jsdom
 *
 * Runs the real mammoth against small .docx files generated in memory.
 * mammoth's Node build takes `{ buffer }` (the browser build takes
 * `{ arrayBuffer }`), so the converter is injected here.
 */

import { describe, it, expect } from "vitest";
import mammoth from "mammoth";
import { docxHtmlToBlocks, extractDocx, type DocxToHtml } from "@/lib/ingest/docx";
import { IngestError } from "@/lib/ingest/errors";
import { ExtractedDocumentSchema } from "@/lib/ai/schemas/document.schema";
import { makeDocx, makeOleHeader, toArrayBuffer } from "../fixtures/make-files";

const nodeDocxToHtml: DocxToHtml = async (data) =>
  (await mammoth.convertToHtml({ buffer: Buffer.from(data) })).value;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return err instanceof IngestError ? err.code : `unexpected: ${String(err)}`;
  }
}

describe("docxHtmlToBlocks", () => {
  it("reads headings, paragraphs, list items and table rows in order", () => {
    const html =
      "<h1>Vectors</h1><p>A vector has a direction.</p>" +
      "<ul><li>Scale</li><li>Add</li></ul>" +
      "<table><tr><td><p>Crystal A</p></td><td><p>(2, 1)</p></td></tr></table>" +
      "<h2>Span</h2><p></p><p>All combinations.</p>";
    expect(docxHtmlToBlocks(html)).toEqual([
      { kind: "heading", level: 1, text: "Vectors" },
      { kind: "paragraph", text: "A vector has a direction." },
      { kind: "paragraph", text: "• Scale" },
      { kind: "paragraph", text: "• Add" },
      { kind: "paragraph", text: "Crystal A | (2, 1)" },
      { kind: "heading", level: 2, text: "Span" },
      { kind: "paragraph", text: "" },
      { kind: "paragraph", text: "All combinations." },
    ]);
  });
});

describe("extractDocx", () => {
  it("splits a real .docx on its Word headings", async () => {
    const data = await makeDocx([
      { paragraph: "Week 3 reading." },
      { heading: 1, text: "Linear Combinations" },
      { paragraph: "Scale vectors, then add them component-wise." },
      { table: [["Crystal A", "(2, 1)"], ["Crystal B", "(1, 2)"]] },
      { heading: 1, text: "Vector Span" },
      { paragraph: "The span is the set of all linear combinations." },
    ]);
    const doc = await extractDocx(data, "week3.docx", nodeDocxToHtml);

    expect(doc.file_type).toBe("docx");
    expect(doc.sections.map((s) => [s.title, s.source_ref])).toEqual([
      ["Week 3 reading.", "Section 1"],
      ["Linear Combinations", "Section 2"],
      ["Vector Span", "Section 3"],
    ]);
    expect(doc.sections[1].text).toContain("Crystal B | (1, 2)");
    expect(ExtractedDocumentSchema.safeParse(doc).success).toBe(true);
  });

  it("rejects a password-protected document", async () => {
    expect(await codeOf(extractDocx(makeOleHeader(), "locked.docx", nodeDocxToHtml))).toBe("ENCRYPTED");
  });

  it("rejects bytes that are not a .docx", async () => {
    const data = toArrayBuffer(new TextEncoder().encode("not a zip"));
    expect(await codeOf(extractDocx(data, "fake.docx", nodeDocxToHtml))).toBe("CORRUPT_FILE");
  });

  it("rejects a document with no text", async () => {
    const data = await makeDocx([{ paragraph: "   " }]);
    expect(await codeOf(extractDocx(data, "blank.docx", nodeDocxToHtml))).toBe("NO_TEXT");
  });
});
