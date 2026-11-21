/**
 * Ingest — plain text (.txt, .md)
 *
 * Markdown-style headings ("# Title", "## Part") split the text into
 * sections; otherwise paragraphs (separated by blank lines) are grouped.
 */

import type { ExtractedDocument } from "@/lib/types/document";
import { buildDocument, normalizeText, sectionsFromBlocks, type TextBlock } from "./blocks";
import { IngestError } from "./errors";

const HEADING = /^(#{1,6})\s+(.+?)\s*#*$/;

export function textToBlocks(text: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
  };

  for (const line of normalizeText(text).split("\n")) {
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
    } else if (line === "") {
      flush();
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}

export function extractText(text: string, fileName: string): ExtractedDocument {
  const doc = buildDocument({
    fileName,
    fileType: "text",
    sections: sectionsFromBlocks(textToBlocks(text), "Part"),
  });
  if (doc.sections.length === 0) {
    throw new IngestError("NO_TEXT", "There is no text to work with.");
  }
  return doc;
}
