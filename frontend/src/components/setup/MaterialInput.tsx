/**
 * MaterialInput
 *
 * Step 01 before a document is chosen (DESIGN-SYSTEM §4.5, Prep.dc.html): a 128px
 * drop zone with a 2px dashed smoke border (solid gold while a file is dragged over
 * it). A <label> wraps the native file input so the whole zone opens the picker.
 * A file is required; text cannot be pasted as material (typed text only guides the
 * story, in the options below). Accepted types and the size limit come from lib/ingest.
 */

"use client";

import { useState, type DragEvent } from "react";
import { Icon } from "@/components/ui/Icon";
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
    <div className="flex flex-col md:mt-3.5">
      <label
        data-testid="material-dropzone"
        onDragEnter={(e) => handleDrag(e, true)}
        onDragOver={(e) => handleDrag(e, true)}
        onDragLeave={(e) => handleDrag(e, false)}
        onDrop={handleDrop}
        className={`box-border flex cursor-pointer flex-col items-stretch gap-3 border-2 p-4 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-cream md:h-32 md:flex-row md:items-center md:justify-between md:gap-6 md:px-7 md:py-0 ${
          dragActive ? "border-solid border-gold" : "border-dashed border-smoke"
        }`}
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
        <div className="flex items-center gap-3 md:gap-[18px]">
          <Icon name="file-up" size={28} className="h-6 w-6 shrink-0 text-ember md:h-7 md:w-7" />
          <div className="flex flex-col gap-1 md:gap-1.5">
            <span className="text-[15px] font-bold leading-[1.3] text-cream md:text-[17px]">Drop your document here</span>
            <span className="font-mono text-[11px] leading-[1.32] text-muted md:text-[12px]">
              PDF · DOCX · PPTX · TXT · MD — up to {MAX_MB} MB
            </span>
          </div>
        </div>
        {/* Visual button only: a real <button> inside a <label> would not open the picker. */}
        <span
          aria-hidden="true"
          className="flex h-11 w-full shrink-0 items-center justify-center bg-cream font-mono md:inline-flex md:w-auto md:px-5 text-[13px] font-bold text-ink"
        >
          Choose a file
        </span>
      </label>
      <p className="mb-0 mt-2 font-mono text-[11px] leading-[1.45] text-muted md:mt-2.5 md:leading-[1.27]">
        Your file is read on this device; only the text you select is sent.
      </p>
    </div>
  );
}
