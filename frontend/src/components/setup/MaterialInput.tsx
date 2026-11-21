/**
 * MaterialInput
 *
 * Step 01 before a document is chosen: a drop zone / file picker for
 * PDF, DOCX, PPTX, TXT or MD. A file is required; text cannot be pasted as
 * material (typed text only guides the story, in the options below).
 */

"use client";

import { useState, type DragEvent } from "react";
import { FileUp } from "lucide-react";
import { ACCEPTED_FILE_TYPES } from "@/lib/ingest";
import { MAX_FILE_BYTES } from "@/lib/ingest/limits";

type MaterialInputProps = {
  onFile: (file: File) => void;
};

const MAX_MB = Math.round(MAX_FILE_BYTES / (1024 * 1024));

export function MaterialInput({ onFile }: MaterialInputProps) {
  const [dragActive, setDragActive] = useState(false);

  function handleDrag(e: DragEvent, active: boolean) {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(active);
  }

  function handleDrop(e: DragEvent) {
    handleDrag(e, false);
    const file = e.dataTransfer.files?.[0];
    if (file) onFile(file);
  }

  return (
    <div className="flex flex-col gap-3">
      <label
        data-testid="material-dropzone"
        onDragEnter={(e) => handleDrag(e, true)}
        onDragOver={(e) => handleDrag(e, true)}
        onDragLeave={(e) => handleDrag(e, false)}
        onDrop={handleDrop}
        className="lore-well flex flex-col items-center gap-3 rounded-panel px-6 py-10 text-center cursor-pointer transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-offset-2"
        style={{
          borderStyle: "dashed",
          borderColor: dragActive ? "var(--accent-gold)" : "var(--border)",
          backgroundColor: dragActive ? "rgba(246, 200, 78, 0.08)" : undefined,
          outlineColor: "var(--accent-gold)",
        }}
      >
        <input
          type="file"
          accept={ACCEPTED_FILE_TYPES}
          className="sr-only"
          data-testid="material-file-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onFile(file);
            e.target.value = ""; // allow choosing the same file again
          }}
        />
        <FileUp size={28} strokeWidth={1.25} aria-hidden="true" style={{ color: "var(--accent-gold-dim)" }} />
        <span className="text-sm font-medium" style={{ color: "var(--foreground)" }}>
          Drop your document here
        </span>
        <span className="text-xs" style={{ color: "var(--foreground-faint)" }}>
          PDF · DOCX · PPTX · TXT · MD — up to {MAX_MB} MB
        </span>
        <span className="lore-pill lore-pill-sm lore-pill-accent mt-1">Choose a file</span>
      </label>
      <p className="text-xs text-center" style={{ color: "var(--foreground-faint)" }}>
        Your file is read on this device; only the text you select is sent.
      </p>
    </div>
  );
}
