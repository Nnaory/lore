/**
 * Home composer state transitions (pure).
 *
 * `chooseFile` applies the file check: a rejected file never replaces a valid
 * attached file and never touches the typed text. `decideSend` says what
 * pressing send does: nothing, show "file required", or hand off to /create.
 * Keeping these out of the component lets any Home layout reuse them.
 */

import { validateHomeFile, type HomeFileRejection } from "./file-check";

export interface ComposerFile {
  name: string;
  size: number;
  type: string;
}

export type ChooseFileResult<F extends ComposerFile> =
  | { ok: true; file: F }
  | { ok: false; reason: HomeFileRejection; message: string; file: F | null };

/** Accept `candidate` or keep `current` and report why not. */
export function chooseFile<F extends ComposerFile>(current: F | null, candidate: F): ChooseFileResult<F> {
  const check = validateHomeFile(candidate);
  if (check.ok) return { ok: true, file: candidate };
  return { ok: false, reason: check.reason, message: check.message, file: current };
}

export type SendDecision<F> =
  | { kind: "idle" }
  | { kind: "file_required" }
  | { kind: "submit"; file: F; instructions: string };

/** Without a file nothing is sent; typed text then asks for a file. */
export function decideSend<F>(file: F | null, text: string): SendDecision<F> {
  if (file === null) return text.trim() === "" ? { kind: "idle" } : { kind: "file_required" };
  return { kind: "submit", file, instructions: text.trim() };
}
