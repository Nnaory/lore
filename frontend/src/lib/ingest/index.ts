/**
 * Ingest — Layer 0 entry point
 *
 * Reads a user's file in the browser and returns an
 * ExtractedDocument. Never throws: expected problems come back as
 * `{ ok: false, error }` with a message that can be shown to the user.
 *
 * Format libraries (pdf.js, mammoth, JSZip) are loaded on demand, only when
 * a file of that type is chosen.
 */

import type { DocumentFileType, ExtractedDocument } from "@/lib/types/document";
import { IngestError, type IngestFailure } from "./errors";
import { MAX_FILE_BYTES } from "./limits";
import { extractText } from "./text";

export type { IngestFailure, IngestErrorCode } from "./errors";

export type ExtractResult =
  | { ok: true; document: ExtractedDocument }
  | { ok: false; error: IngestFailure };

/** File picker `accept` value for the supported formats. */
export const ACCEPTED_FILE_TYPES = [
  ".pdf",
  ".docx",
  ".pptx",
  ".txt",
  ".md",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/markdown",
].join(",");

type FileKind = DocumentFileType | "legacy-doc" | "legacy-ppt" | "unsupported";

const BY_EXTENSION: Record<string, FileKind> = {
  pdf: "pdf",
  docx: "docx",
  pptx: "pptx",
  txt: "text",
  md: "text",
  markdown: "text",
  doc: "legacy-doc",
  ppt: "legacy-ppt",
};

const BY_MIME: Record<string, FileKind> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/plain": "text",
  "text/markdown": "text",
  "application/msword": "legacy-doc",
  "application/vnd.ms-powerpoint": "legacy-ppt",
};

/** Decide how to read a file from its extension, falling back to its MIME type. */
export function detectFileKind(file: Pick<File, "name" | "type">): FileKind {
  const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
  return (ext && BY_EXTENSION[ext]) || BY_MIME[file.type] || "unsupported";
}

async function readByKind(kind: DocumentFileType, file: File): Promise<ExtractedDocument> {
  switch (kind) {
    case "text":
      return extractText(await file.text(), file.name);
    case "pdf": {
      const { extractPdf } = await import("./pdf");
      return extractPdf(await file.arrayBuffer(), file.name);
    }
    case "docx": {
      const { extractDocx } = await import("./docx");
      return extractDocx(await file.arrayBuffer(), file.name);
    }
    case "pptx": {
      const { extractPptx } = await import("./pptx");
      return extractPptx(await file.arrayBuffer(), file.name);
    }
  }
}

export async function extractDocument(
  file: File,
  options: { maxBytes?: number } = {}
): Promise<ExtractResult> {
  const maxBytes = options.maxBytes ?? MAX_FILE_BYTES;
  const kind = detectFileKind(file);

  if (kind === "legacy-doc" || kind === "legacy-ppt") {
    const target = kind === "legacy-doc" ? ".docx" : ".pptx";
    return failure(
      "LEGACY_FORMAT",
      `This is an older Office format. Open it in Office and save it as ${target}, then try again.`
    );
  }
  if (kind === "unsupported") {
    return failure("UNSUPPORTED_TYPE", "This file type is not supported. Use PDF, DOCX, PPTX, or TXT.");
  }
  if (file.size > maxBytes) {
    const limitMb = Math.round(maxBytes / (1024 * 1024));
    return failure(
      "FILE_TOO_LARGE",
      `This file is larger than ${limitMb} MB. Split it into smaller files.`
    );
  }

  try {
    return { ok: true, document: await readByKind(kind, file) };
  } catch (err) {
    if (err instanceof IngestError) return { ok: false, error: err.toFailure() };
    return failure("READ_FAILED", "This file could not be read. Try again, or use a different file.");
  }
}

/** Build a document from text the user pasted. */
export function extractPastedText(text: string): ExtractResult {
  try {
    return { ok: true, document: extractText(text, "Pasted text") };
  } catch (err) {
    if (err instanceof IngestError) return { ok: false, error: err.toFailure() };
    return failure("READ_FAILED", "This text could not be read.");
  }
}

function failure(code: IngestFailure["code"], message: string): ExtractResult {
  return { ok: false, error: { code, message } };
}
