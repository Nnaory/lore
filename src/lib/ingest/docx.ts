/**
 * Ingest — Word documents (.docx)
 *
 * mammoth converts the document to semantic HTML (headings, paragraphs,
 * lists, tables); the HTML is walked into TextBlocks so Word headings
 * become section boundaries. Images are dropped — only text is kept.
 *
 * Requires DOMParser (browser, or jsdom in tests).
 */

import type { ExtractedDocument } from "@/lib/types/document";
import { buildDocument, sectionsFromBlocks, type TextBlock } from "./blocks";
import { IngestError, isOleCompoundFile } from "./errors";

/** Converts .docx bytes to HTML. Injectable so tests can use mammoth's Node input. */
export type DocxToHtml = (data: ArrayBuffer) => Promise<string>;

const browserDocxToHtml: DocxToHtml = async (data) => {
  const mammoth = (await import("mammoth")).default;
  const result = await mammoth.convertToHtml(
    { arrayBuffer: data },
    // Skip image data entirely; base64-embedding pictures wastes memory.
    { convertImage: mammoth.images.imgElement(async () => ({ src: "" })) }
  );
  return result.value;
};

function cellText(el: Element): string {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** Walk mammoth's HTML output into headings and paragraphs. */
export function docxHtmlToBlocks(html: string): TextBlock[] {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const blocks: TextBlock[] = [];

  const visit = (el: Element) => {
    const tag = el.tagName.toLowerCase();
    const heading = /^h([1-6])$/.exec(tag);
    if (heading) {
      blocks.push({ kind: "heading", level: Number(heading[1]), text: el.textContent ?? "" });
    } else if (tag === "ul" || tag === "ol") {
      for (const li of Array.from(el.children)) {
        if (li.tagName.toLowerCase() === "li") {
          blocks.push({ kind: "paragraph", text: `• ${cellText(li)}` });
        }
      }
    } else if (tag === "table") {
      for (const row of Array.from(el.querySelectorAll("tr"))) {
        const cells = Array.from(row.children).map(cellText).filter(Boolean);
        if (cells.length > 0) blocks.push({ kind: "paragraph", text: cells.join(" | ") });
      }
    } else if (tag === "p") {
      blocks.push({ kind: "paragraph", text: el.textContent ?? "" });
    } else {
      for (const child of Array.from(el.children)) visit(child);
    }
  };

  for (const child of Array.from(doc.body.children)) visit(child);
  return blocks;
}

export async function extractDocx(
  data: ArrayBuffer,
  fileName: string,
  toHtml: DocxToHtml = browserDocxToHtml
): Promise<ExtractedDocument> {
  if (isOleCompoundFile(data)) {
    throw new IngestError(
      "ENCRYPTED",
      "This Word document is password-protected. Remove the password and try again."
    );
  }

  let html: string;
  try {
    html = await toHtml(data);
  } catch {
    throw new IngestError(
      "CORRUPT_FILE",
      "This file could not be opened as a Word document. It may be damaged."
    );
  }

  const doc = buildDocument({
    fileName,
    fileType: "docx",
    sections: sectionsFromBlocks(docxHtmlToBlocks(html), "Section"),
  });
  if (doc.sections.length === 0) {
    throw new IngestError("NO_TEXT", "This Word document has no text to work with.");
  }
  return doc;
}
