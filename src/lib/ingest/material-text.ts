/**
 * Material text
 *
 * Turns the sections a user selected into the single text the AI pipeline
 * receives. Each section keeps its source reference in a header line so a
 * model can cite where a concept came from ("[Slide 5] Vector Span").
 */

import type { ExtractedDocument } from "@/lib/types/document";

export function buildMaterialText(
  document: ExtractedDocument,
  selectedIds: ReadonlySet<string> | readonly string[]
): string {
  const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  return document.sections
    .filter((s) => selected.has(s.section_id))
    .map((s) => (s.title === s.source_ref ? `[${s.source_ref}]` : `[${s.source_ref}] ${s.title}`) + `\n${s.text}`)
    .join("\n\n");
}
