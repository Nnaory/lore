/**
 * SectionPicker
 *
 * Collapsible list of a document's sections (pages, slides, headings) with
 * checkboxes, plus a meter showing how much text is selected against the
 * limit the AI pipeline accepts.
 */

"use client";

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
        <div className="flex justify-between text-xs mb-1.5" style={{ color: over ? "var(--danger)" : "var(--foreground-faint)" }}>
          <span>
            {selected.length} of {sections.length} selected
          </span>
          <span data-testid="material-budget-count">
            {fmt(materialLength)} / {fmt(MAX_MATERIAL_CHARS)} characters
          </span>
        </div>
        <div className="h-1 rounded-full overflow-hidden" style={{ backgroundColor: "var(--border-dim)" }} aria-hidden="true">
          <div
            className="h-full transition-all"
            style={{ width: `${pct}%`, backgroundColor: over ? "var(--danger)" : "var(--accent-gold-dim)" }}
          />
        </div>
        {over && (
          <p className="text-xs mt-1.5" role="alert" style={{ color: "var(--danger)" }}>
            That&apos;s more text than one story can use. Deselect some sections.
          </p>
        )}
      </div>

      <details className="group" data-testid="section-picker">
        <summary
          className="cursor-pointer text-xs tracking-wide select-none list-none flex items-center gap-1.5"
          style={{ color: "var(--foreground-muted)" }}
        >
          <span className="inline-block transition-transform group-open:rotate-90" aria-hidden="true">▸</span>
          Preview content ({sections.length} sections)
        </summary>

        <div className="mt-3 flex gap-3 text-xs">
          <button type="button" onClick={() => onSetAll(true)} className="underline underline-offset-2" style={{ color: "var(--foreground-muted)" }}>
            Select all
          </button>
          <button type="button" onClick={() => onSetAll(false)} className="underline underline-offset-2" style={{ color: "var(--foreground-muted)" }}>
            Select none
          </button>
        </div>

        <ul className="mt-2 max-h-72 overflow-y-auto pr-1 flex flex-col" aria-label="Document sections">
          {sections.map((section) => {
            const checked = selectedSet.has(section.section_id);
            return (
              <li key={section.section_id}>
                <label
                  className="flex items-start gap-3 py-2 px-1 cursor-pointer border-b"
                  style={{ borderBottomColor: "var(--border-dim)", opacity: checked ? 1 : 0.55 }}
                >
                  <input
                    type="checkbox"
                    data-testid={`section-checkbox-${section.section_id}`}
                    checked={checked}
                    onChange={() => onToggle(section.section_id)}
                    className="mt-0.5 accent-[var(--accent-gold)]"
                  />
                  <span className="text-xs font-mono flex-shrink-0 w-16" style={{ color: "var(--foreground-faint)" }}>
                    {section.source_ref}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm truncate" style={{ color: "var(--foreground)" }}>
                      {section.title}
                    </span>
                    <span className="block text-xs truncate" style={{ color: "var(--foreground-faint)" }}>
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
