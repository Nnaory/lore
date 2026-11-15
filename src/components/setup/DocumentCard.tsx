/**
 * DocumentCard
 *
 * Step 01 after a document is chosen: shows reading progress, the result
 * (type, name, size, warnings, section picker), or a read error.
 */

"use client";

import { TriangleAlert, X } from "lucide-react";
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

const TYPE_LABEL: Record<ExtractedDocument["file_type"], string> = {
  pdf: "PDF",
  docx: "DOCX",
  pptx: "PPTX",
  text: "TXT",
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
    <div
      data-testid="document-card"
      data-status={doc.status}
      className="rounded-lg p-4 flex flex-col gap-4"
      style={{
        backgroundColor: "var(--background-panel)",
        border: `1px solid ${isError ? "var(--danger)" : "var(--border)"}`,
      }}
    >
      <div className="flex items-start gap-3">
        <span
          className="flex-shrink-0 text-[10px] font-mono font-semibold tracking-wider px-1.5 py-1 rounded"
          style={{
            border: "1px solid var(--accent-gold-dim)",
            color: "var(--accent-gold)",
          }}
          aria-hidden="true"
        >
          {doc.status === "ready" ? TYPE_LABEL[doc.document.file_type] : "DOC"}
        </span>

        <div className="flex-1 min-w-0" aria-live="polite">
          <p className="text-sm font-medium truncate" style={{ color: "var(--foreground)" }} data-testid="document-name">
            {fileName}
          </p>
          {doc.status === "reading" && (
            <p className="text-xs animate-pulse-gold" style={{ color: "var(--accent-gold-dim)" }}>
              Reading…
            </p>
          )}
          {doc.status === "ready" && (
            <p className="text-xs" style={{ color: "var(--foreground-faint)" }} data-testid="document-stats">
              {unitLabel(doc.document)} · {doc.document.stats.words.toLocaleString("en-US")} words
            </p>
          )}
          {doc.status === "error" && (
            <p className="text-xs mt-0.5" role="alert" style={{ color: "var(--danger)" }} data-testid="document-error">
              {doc.error.message}
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={onRemove}
          aria-label={isError ? "Choose another file" : "Remove document"}
          data-testid="document-remove"
          className="flex-shrink-0 p-1 rounded transition-colors hover:bg-white/5"
          style={{ color: "var(--foreground-faint)" }}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      {doc.status === "ready" && doc.document.warnings.length > 0 && (
        <ul className="flex flex-col gap-1.5" data-testid="document-warnings">
          {doc.document.warnings.map((w) => (
            <li key={w.code} className="flex gap-2 text-xs" style={{ color: "#e0b25a" }}>
              <TriangleAlert size={14} className="flex-shrink-0 mt-px" aria-hidden="true" />
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
