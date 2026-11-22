/**
 * Home file check
 *
 * Pure validation for the single file attached on the Home screen. A file is
 * accepted only when its format is PDF, DOCX, PPTX, TXT or MD and its size is
 * from 1 byte up to MAX_FILE_BYTES (25 MB, inclusive). Format detection and
 * the size limit are imported from lib/ingest so Home and the create form
 * can never disagree. Never throws: every outcome is a result union with a
 * message the UI can show as-is.
 */

import { MAX_FILE_BYTES } from "@/lib/ingest/limits";
import { detectFileKind } from "@/lib/ingest";

export type HomeFileRejection = "unsupported_format" | "empty_file" | "too_large";

export type HomeFileCheck =
  | { ok: true }
  | { ok: false; reason: HomeFileRejection; message: string };

export const HOME_FILE_MESSAGES: Record<HomeFileRejection, string> = {
  unsupported_format: "Unsupported format. Use PDF, DOCX, PPTX, TXT or MD.",
  empty_file: "This file is empty.",
  too_large: "This file is larger than 25 MB.",
};

function reject(reason: HomeFileRejection): HomeFileCheck {
  return { ok: false, reason, message: HOME_FILE_MESSAGES[reason] };
}

/** Check format first, then emptiness, then the upper size bound. */
export function validateHomeFile(file: { name: string; size: number; type: string }): HomeFileCheck {
  const kind = detectFileKind({ name: file.name, type: file.type });
  if (kind === "unsupported" || kind === "legacy-doc" || kind === "legacy-ppt") {
    return reject("unsupported_format");
  }
  if (!(file.size > 0)) return reject("empty_file");
  if (file.size > MAX_FILE_BYTES) return reject("too_large");
  return { ok: true };
}
