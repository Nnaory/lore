/**
 * Ingest — PowerPoint presentations (.pptx)
 *
 * A .pptx is a zip of XML parts. For each slide, in presentation order
 * (ppt/presentation.xml — not file-name order), this reads:
 *   - the title placeholder → section title
 *   - all other text boxes and table cells → section text
 *   - the speaker notes (notesSlide body placeholder) → appended to the text
 *
 * Slides with no body text are skipped and reported as a warning.
 * Requires DOMParser (browser, or jsdom in tests).
 */

import type { DocumentWarning, ExtractedDocument } from "@/lib/types/document";
import { buildDocument, normalizeText, type RawSection } from "./blocks";
import { IngestError, isOleCompoundFile } from "./errors";

const NS = {
  p: "http://schemas.openxmlformats.org/presentationml/2006/main",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  rel: "http://schemas.openxmlformats.org/package/2006/relationships",
};

type Zip = import("jszip");

function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, "application/xml");
}

async function readXml(zip: Zip, path: string): Promise<Document | null> {
  const file = zip.file(path);
  return file ? parseXml(await file.async("string")) : null;
}

/** Resolve a relationship target against the folder of the part that owns it. */
export function resolvePartPath(baseFolder: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = baseFolder.split("/").filter(Boolean);
  for (const piece of target.split("/")) {
    if (piece === "..") parts.pop();
    else if (piece !== "." && piece !== "") parts.push(piece);
  }
  return parts.join("/");
}

/** Relationship Id → { target, type } for a .rels part. */
async function readRels(
  zip: Zip,
  relsPath: string
): Promise<Map<string, { target: string; type: string }>> {
  const doc = await readXml(zip, relsPath);
  const rels = new Map<string, { target: string; type: string }>();
  if (!doc) return rels;
  for (const rel of Array.from(doc.getElementsByTagNameNS(NS.rel, "Relationship"))) {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (id && target) rels.set(id, { target, type: rel.getAttribute("Type") ?? "" });
  }
  return rels;
}

/** Slide part paths in presentation order. */
async function slidePaths(zip: Zip): Promise<string[]> {
  const presentation = await readXml(zip, "ppt/presentation.xml");
  if (presentation) {
    const rels = await readRels(zip, "ppt/_rels/presentation.xml.rels");
    const ordered = Array.from(presentation.getElementsByTagNameNS(NS.p, "sldId"))
      .map((el) => el.getAttributeNS(NS.r, "id") ?? el.getAttribute("r:id"))
      .map((rid) => (rid ? rels.get(rid)?.target : undefined))
      .filter((t): t is string => Boolean(t))
      .map((t) => resolvePartPath("ppt", t))
      .filter((path) => zip.file(path) !== null);
    if (ordered.length > 0) return ordered;
  }
  // Fallback: slideN.xml sorted by N.
  return Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
}

/** Every element below `root`, in document order. */
function* descendants(root: Element): Generator<Element> {
  for (const child of Array.from(root.children)) {
    yield child;
    yield* descendants(child);
  }
}

function placeholderType(shape: Element): string | null {
  const ph = shape.getElementsByTagNameNS(NS.p, "ph")[0];
  if (!ph) return null;
  return ph.getAttribute("type") ?? "body";
}

function paragraphLines(container: Element): string[] {
  return Array.from(container.getElementsByTagNameNS(NS.a, "p"))
    .map((p) =>
      Array.from(p.getElementsByTagNameNS(NS.a, "t"))
        .map((t) => t.textContent ?? "")
        .join("")
        .trim()
    )
    .filter(Boolean);
}

function tableLines(frame: Element): string[] {
  return Array.from(frame.getElementsByTagNameNS(NS.a, "tr"))
    .map((row) =>
      Array.from(row.getElementsByTagNameNS(NS.a, "tc"))
        .map((cell) => paragraphLines(cell).join(" "))
        .filter(Boolean)
        .join(" | ")
    )
    .filter(Boolean);
}

/** Title and body lines of one slide (or notes) document. */
function readShapes(doc: Document): { title: string[]; body: string[]; placeholders: Map<string, string[]> } {
  const title: string[] = [];
  const body: string[] = [];
  const placeholders = new Map<string, string[]>();
  if (!doc.documentElement) return { title, body, placeholders };

  for (const el of descendants(doc.documentElement)) {
    if (el.namespaceURI !== NS.p) continue;
    if (el.localName === "sp") {
      const lines = paragraphLines(el);
      const type = placeholderType(el);
      if (type) placeholders.set(type, [...(placeholders.get(type) ?? []), ...lines]);
      if (type === "title" || type === "ctrTitle") title.push(...lines);
      else body.push(...lines);
    } else if (el.localName === "graphicFrame") {
      body.push(...tableLines(el));
    }
  }
  return { title, body, placeholders };
}

async function notesFor(zip: Zip, slidePath: string): Promise<string[]> {
  const folder = slidePath.slice(0, slidePath.lastIndexOf("/"));
  const fileName = slidePath.slice(slidePath.lastIndexOf("/") + 1);
  const rels = await readRels(zip, `${folder}/_rels/${fileName}.rels`);
  for (const { target, type } of rels.values()) {
    if (!type.endsWith("/notesSlide")) continue;
    const notes = await readXml(zip, resolvePartPath(folder, target));
    return notes ? readShapes(notes).placeholders.get("body") ?? [] : [];
  }
  return [];
}

export async function extractPptx(data: ArrayBuffer, fileName: string): Promise<ExtractedDocument> {
  if (isOleCompoundFile(data)) {
    throw new IngestError(
      "ENCRYPTED",
      "This presentation is password-protected. Remove the password and try again."
    );
  }

  const JSZip = (await import("jszip")).default;
  let zip: Zip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    throw new IngestError(
      "CORRUPT_FILE",
      "This file could not be opened as a PowerPoint presentation. It may be damaged."
    );
  }

  const paths = await slidePaths(zip);
  if (paths.length === 0) {
    throw new IngestError("CORRUPT_FILE", "No slides were found in this presentation.");
  }

  const sections: RawSection[] = [];
  let skipped = 0;
  for (const [index, path] of paths.entries()) {
    const slide = await readXml(zip, path);
    const { title, body } = slide ? readShapes(slide) : { title: [], body: [] };
    const notes = await notesFor(zip, path);
    const text = [body.join("\n"), notes.length > 0 ? `Speaker notes:\n${notes.join("\n")}` : ""]
      .filter(Boolean)
      .join("\n\n");

    if (normalizeText(text) === "") {
      skipped += 1;
      continue;
    }
    const ref = `Slide ${index + 1}`;
    sections.push({ title: title.join(" ") || ref, text, source_ref: ref });
  }

  const warnings: DocumentWarning[] =
    skipped > 0 && sections.length > 0
      ? [
          {
            code: "EMPTY_SLIDES_SKIPPED",
            message: `${skipped} of ${paths.length} slides have no body text and were skipped.`,
          },
        ]
      : [];

  const doc = buildDocument({ fileName, fileType: "pptx", sections, units: paths.length, warnings });
  if (doc.sections.length === 0) {
    throw new IngestError(
      "NO_TEXT",
      "These slides have no text beyond titles. Pictures and diagrams cannot be read yet. Use slides that contain text."
    );
  }
  return doc;
}
