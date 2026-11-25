/**
 * SectionPicker
 *
 * Collapsible list of a document's sections (pages, slides, headings) with
 * checkboxes, plus a meter showing how much text is selected against the
 * limit the AI pipeline accepts. Styled with Kit tokens only (smoke hairlines,
 * gold fill, ember for the over-limit error line).
 */

"use client";

import { ErrorLine } from "@/components/ui/ErrorLine";
import type { DocumentSection } from "@/lib/types/document";
import { MAX_MATERIAL_CHARS } from "@/lib/ingest/limits";

type SectionPickerProps = {
  sections: DocumentSection[];
  selected: readonly string[];
  /** Length of the text that will be sent for the current selection. */
  materialLength: number;
  onToggle: (sectionId: string) => void;
  onSetAll: (selected: boolean) => void;
};

const fmt = (n: number) => n.toLocaleString("en-US");

export function SectionPicker({ sections, selected, materialLength, onToggle, onSetAll }: SectionPickerProps) {
  const selectedSet = new Set(selected);
  const over = materialLength > MAX_MATERIAL_CHARS;
  const pct = Math.min(100, (materialLength / MAX_MATERIAL_CHARS) * 100);

  return (
    <div className="flex flex-col gap-3">
      {/* Budget meter */}
      <div data-testid="material-budget">
        <div className={`mb-1.5 flex justify-between font-mono text-[12px] ${over ? "text-ember" : "text-muted"}`}>
          <span>
            {selected.length} of {sections.length} selected
          </span>
          <span data-testid="material-budget-count">
            {fmt(materialLength)} / {fmt(MAX_MATERIAL_CHARS)} characters
          </span>
        </div>
        <div className="h-1 overflow-hidden bg-smoke" aria-hidden="true">
          <div className={`h-full ${over ? "bg-ember" : "bg-gold"}`} style={{ width: `${pct}%` }} />
        </div>
        {over && (
          <ErrorLine className="mt-1.5">
            That&apos;s more text than one story can use. Deselect some sections.
          </ErrorLine>
        )}
      </div>

      <details className="group" data-testid="section-picker">
        <summary className="flex min-h-11 cursor-pointer list-none select-none items-center gap-1.5 font-mono text-[12px] text-muted">
          <span className="inline-block group-open:rotate-90" aria-hidden="true">▸</span>
          Preview content ({sections.length} sections)
        </summary>

        <div className="flex gap-4 font-mono text-[12px]">
          <button type="button" onClick={() => onSetAll(true)} className="min-h-11 text-cream underline underline-offset-2">
            Select all
          </button>
          <button type="button" onClick={() => onSetAll(false)} className="min-h-11 text-cream underline underline-offset-2">
            Select none
          </button>
        </div>

        <ul className="m-0 flex max-h-72 list-none flex-col overflow-y-auto p-0" aria-label="Document sections">
          {sections.map((section) => {
            const checked = selectedSet.has(section.section_id);
            return (
              <li key={section.section_id}>
                <label
                  className={`flex min-h-11 cursor-pointer items-start gap-3 border-b border-smoke px-1 py-2 ${
                    checked ? "" : "opacity-60"
                  }`}
                >
                  <input
                    type="checkbox"
                    data-testid={`section-checkbox-${section.section_id}`}
                    checked={checked}
                    onChange={() => onToggle(section.section_id)}
                    className="mt-0.5 size-4 accent-ember"
                  />
                  <span className="w-16 shrink-0 font-mono text-[12px] text-muted">{section.source_ref}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] text-cream">{section.title}</span>
                    <span className="block truncate font-mono text-[12px] text-muted">
                      {section.text.slice(0, 140)}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </details>
    </div>
  );
}
