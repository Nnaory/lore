/**
 * DocumentCard
 *
 * Step 01 after a document is chosen (DESIGN-SYSTEM §4.5, Prep.dc.html): the same
 * 128px box as the drop zone, now with a solid 2px gold border, the file name on one
 * line (ellipsis), a status line, and a `Replace` button. A read error (type, size
 * over 25 MB, read failed) shows an ErrorLine with the IngestFailure message and a
 * button that clears the file so the drop zone returns. Ready documents also show
 * warnings and the section picker. The card itself is not in the canvas; it only
 * reuses Kit tokens.
 */

"use client";

import { Button } from "@/components/ui/Button";
import { ErrorLine } from "@/components/ui/ErrorLine";
import { Icon } from "@/components/ui/Icon";
import type { DocumentState } from "@/lib/setup/create-form";
import type { ExtractedDocument } from "@/lib/types/document";
import { SectionPicker } from "./SectionPicker";

type DocumentCardProps = {
  doc: Exclude<DocumentState, { status: "empty" }>;
  materialLength: number;
  onRemove: () => void;
  onToggle: (sectionId: string) => void;
  onSetAll: (selected: boolean) => void;
};

function unitLabel(doc: ExtractedDocument): string {
  const n = doc.stats.units;
  const noun = doc.file_type === "pdf" ? "page" : doc.file_type === "pptx" ? "slide" : "section";
  return `${n.toLocaleString("en-US")} ${noun}${n === 1 ? "" : "s"}`;
}

export function DocumentCard({ doc, materialLength, onRemove, onToggle, onSetAll }: DocumentCardProps) {
  const isError = doc.status === "error";
  const fileName = doc.status === "ready" ? doc.document.file_name : doc.fileName;

  return (
    <div data-testid="document-card" data-status={doc.status} className="flex flex-col gap-4 md:mt-3.5">
      <div
        className={`box-border flex min-h-[108px] items-center justify-between gap-3 border-2 p-4 md:h-32 md:gap-6 md:px-7 md:py-0 ${
          isError ? "border-dashed border-smoke" : "border-solid border-gold"
        }`}
      >
        <div className="flex min-w-0 items-center gap-3 md:gap-[18px]" aria-live="polite">
          <Icon name={isError ? "alert" : "file"} size={28} className={`shrink-0 ${isError ? "text-ember" : "text-gold"}`} />
          <div className="flex min-w-0 flex-col gap-1 md:gap-1.5">
            <span
              className="truncate font-mono text-sm font-bold md:text-[15px] text-cream"
              data-testid="document-name"
              title={fileName}
            >
              {fileName}
            </span>
            {doc.status === "reading" && <span className="font-mono text-[12px] text-muted">Reading…</span>}
            {doc.status === "ready" && (
              <span className="font-mono text-[12px] text-muted" data-testid="document-stats">
                {unitLabel(doc.document)} · {doc.document.stats.words.toLocaleString("en-US")} words
              </span>
            )}
            {isError && <span className="font-mono text-[12px] text-muted">Could not read this file</span>}
          </div>
        </div>

        <Button
          variant="outline"
          onClick={onRemove}
          aria-label={isError ? "Choose another file" : "Remove document"}
          data-testid="document-remove"
          className="shrink-0 !px-[18px] !text-[13px]"
        >
          {isError ? "Choose another" : "Replace"}
        </Button>
      </div>

      {isError && <ErrorLine data-testid="document-error">{doc.error.message}</ErrorLine>}

      {doc.status === "ready" && doc.document.warnings.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0" data-testid="document-warnings">
          {doc.document.warnings.map((w) => (
            <li key={w.code} className="flex gap-2 font-mono text-[12px] text-gold">
              <Icon name="alert" size={14} className="mt-px shrink-0" />
              <span>{w.message}</span>
            </li>
          ))}
        </ul>
      )}

      {doc.status === "ready" && (
        <SectionPicker
          sections={doc.document.sections}
          selected={doc.selected}
          materialLength={materialLength}
          onToggle={onToggle}
          onSetAll={onSetAll}
        />
      )}
    </div>
  );
}
