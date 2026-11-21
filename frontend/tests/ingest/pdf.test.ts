/**
 * Tests — PDF reader
 *
 * Runs the real pdf.js (legacy build, no worker) in Node against small PDFs
 * generated in memory.
 */

import { describe, it, expect } from "vitest";
import { extractPdf, pdfPagesToDocument, type PdfjsLib } from "@/lib/ingest/pdf";
import { IngestError } from "@/lib/ingest/errors";
import { ExtractedDocumentSchema } from "@/lib/contracts/schemas/document.schema";
import { makePdf, toArrayBuffer } from "../fixtures/make-files";

const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfjsLib;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return err instanceof IngestError ? err.code : `unexpected: ${String(err)}`;
  }
}

describe("extractPdf", () => {
  it("makes one section per page, titled by the page's first line", async () => {
    const data = makePdf([
      ["Linear Combinations", "Scale vectors, then add them."],
      ["Vector Span", "The span is the set of all combinations."],
    ]);
    const doc = await extractPdf(data, "week3.pdf", pdfjs);

    expect(doc.file_type).toBe("pdf");
    expect(doc.sections.map((s) => [s.title, s.source_ref])).toEqual([
      ["Linear Combinations", "Page 1"],
      ["Vector Span", "Page 2"],
    ]);
    expect(doc.sections[1].text).toContain("set of all combinations");
    expect(doc.stats.units).toBe(2);
    expect(doc.warnings).toEqual([]);
    expect(ExtractedDocumentSchema.safeParse(doc).success).toBe(true);
  });

  it("skips pages without text and warns about them", async () => {
    const doc = await extractPdf(makePdf([["Only page with text"], [], []]), "mixed.pdf", pdfjs);
    expect(doc.sections).toHaveLength(1);
    expect(doc.stats.units).toBe(3);
    expect(doc.warnings).toEqual([
      expect.objectContaining({ code: "PARTIAL_TEXT_LAYER", message: expect.stringContaining("2 of 3 pages") }),
    ]);
  });

  it("rejects a PDF with no text layer at all", async () => {
    expect(await codeOf(extractPdf(makePdf([[], []]), "scan.pdf", pdfjs))).toBe("NO_TEXT");
  });

  it("rejects bytes that are not a PDF", async () => {
    const data = toArrayBuffer(new TextEncoder().encode("definitely not a pdf"));
    expect(await codeOf(extractPdf(data, "fake.pdf", pdfjs))).toBe("CORRUPT_FILE");
  });

  it("leaves the caller's buffer usable", async () => {
    const data = makePdf([["Hello"]]);
    const size = data.byteLength;
    await extractPdf(data, "hello.pdf", pdfjs);
    expect(data.byteLength).toBe(size);
  });
});

describe("pdfPagesToDocument", () => {
  it("numbers source refs by original page, not by kept section", () => {
    const doc = pdfPagesToDocument("x.pdf", ["", "Second page text", "", "Fourth"]);
    expect(doc.sections.map((s) => s.source_ref)).toEqual(["Page 2", "Page 4"]);
  });
});
