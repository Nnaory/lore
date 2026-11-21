/**
 * Ingest — PDF
 *
 * pdf.js reads the text layer of every page; each page with text becomes a
 * section. Pages without a text layer (scanned images) are skipped and
 * reported; a PDF with no text at all is rejected with guidance.
 *
 * Parsing runs inside pdf.js's own Web Worker in the browser.
 */

import type { DocumentWarning, ExtractedDocument } from "@/lib/types/document";
import { buildDocument, deriveTitle, normalizeText, type RawSection } from "./blocks";
import { IngestError } from "./errors";

/** The subset of the pdf.js API this reader uses (modern or legacy build). */
export type PdfjsLib = Pick<typeof import("pdfjs-dist"), "getDocument">;

async function loadBrowserPdfjs(): Promise<PdfjsLib> {
  const pdfjs = await import("pdfjs-dist");
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url
    ).toString();
  }
  return pdfjs;
}

/** The text of every page, in order ("" for pages without a text layer). */
export async function readPdfPageTexts(data: ArrayBuffer, pdfjs: PdfjsLib): Promise<string[]> {
  // pdf.js takes ownership of (detaches) the buffer it is given, so pass a copy.
  const task = pdfjs.getDocument({ data: new Uint8Array(data.slice(0)), verbosity: 0 });
  let pdf;
  try {
    pdf = await task.promise;
  } catch (err) {
    await task.destroy();
    const name = (err as { name?: string } | null)?.name;
    if (name === "PasswordException") {
      throw new IngestError(
        "ENCRYPTED",
        "This PDF is password-protected. Remove the password and try again."
      );
    }
    throw new IngestError("CORRUPT_FILE", "This file could not be opened as a PDF. It may be damaged.");
  }

  try {
    const pages: string[] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if ("str" in item) text += item.str + (item.hasEOL ? "\n" : "");
      }
      pages.push(normalizeText(text));
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

/** Turn per-page text into a document; throws NO_TEXT when no page has text. */
export function pdfPagesToDocument(fileName: string, pages: string[]): ExtractedDocument {
  const sections: RawSection[] = [];
  pages.forEach((text, i) => {
    if (text === "") return;
    const ref = `Page ${i + 1}`;
    sections.push({ title: deriveTitle(text, ref), text, source_ref: ref });
  });

  if (sections.length === 0) {
    throw new IngestError(
      "NO_TEXT",
      "This PDF has no selectable text — it looks like scanned images. Use a PDF with a text layer."
    );
  }

  const empty = pages.length - sections.length;
  const warnings: DocumentWarning[] =
    empty > 0
      ? [
          {
            code: "PARTIAL_TEXT_LAYER",
            message: `${empty} of ${pages.length} pages have no selectable text (they may be scanned images) and were skipped.`,
          },
        ]
      : [];

  return buildDocument({ fileName, fileType: "pdf", sections, units: pages.length, warnings });
}

export async function extractPdf(
  data: ArrayBuffer,
  fileName: string,
  pdfjs?: PdfjsLib
): Promise<ExtractedDocument> {
  const lib = pdfjs ?? (await loadBrowserPdfjs());
  return pdfPagesToDocument(fileName, await readPdfPageTexts(data, lib));
}
