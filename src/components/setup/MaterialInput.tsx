/**
 * MaterialInput
 *
 * Step 01 before a document is chosen: a drop zone / file picker for
 * PDF, DOCX, PPTX or TXT, with a switch to paste text instead.
 */

"use client";

import { useState, type DragEvent } from "react";
import { FileUp } from "lucide-react";
import { ACCEPTED_FILE_TYPES } from "@/lib/ingest";
import { MAX_FILE_BYTES } from "@/lib/ingest/limits";

type MaterialInputProps = {
  onFile: (file: File) => void;
  onPaste: (text: string) => void;
};

const MAX_MB = Math.round(MAX_FILE_BYTES / (1024 * 1024));

export function MaterialInput({ onFile, onPaste }: MaterialInputProps) {
  const [mode, setMode] = useState<"file" | "paste">("file");
  const [dragActive, setDragActive] = useState(false);
  const [pasted, setPasted] = useState("");

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

  if (mode === "paste") {
    return (
      <div className="flex flex-col gap-3" data-testid="paste-panel">
        <label htmlFor="paste-material" className="text-xs tracking-widest uppercase" style={{ color: "var(--foreground-faint)" }}>
          Paste your material
        </label>
        <textarea
          id="paste-material"
          data-testid="paste-textarea"
          rows={10}
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          placeholder="Lecture notes, a textbook chapter, an article…"
          className="w-full rounded-lg p-4 text-sm leading-6 resize-y"
          style={{
            backgroundColor: "var(--background-panel)",
            border: "1px solid var(--border)",
            color: "var(--foreground)",
          }}
        />
        <div className="flex gap-3">
          <button
            type="button"
            data-testid="paste-submit"
            disabled={pasted.trim() === ""}
            onClick={() => onPaste(pasted)}
            className="px-4 py-2 rounded text-sm font-medium transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ backgroundColor: "var(--accent-gold)", color: "var(--background)" }}
          >
            Use this text
          </button>
          <button
            type="button"
            onClick={() => setMode("file")}
            className="px-4 py-2 rounded text-sm"
            style={{ color: "var(--foreground-muted)", border: "1px solid var(--border-dim)" }}
          >
            Upload a file instead
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <label
        data-testid="material-dropzone"
        onDragEnter={(e) => handleDrag(e, true)}
        onDragOver={(e) => handleDrag(e, true)}
        onDragLeave={(e) => handleDrag(e, false)}
        onDrop={handleDrop}
        className="flex flex-col items-center gap-3 rounded-lg px-6 py-10 text-center cursor-pointer transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-offset-2"
        style={{
          border: `1px dashed ${dragActive ? "var(--accent-gold)" : "var(--border)"}`,
          backgroundColor: dragActive ? "rgba(232, 197, 71, 0.06)" : "rgba(26, 20, 16, 0.4)",
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
          PDF · DOCX · PPTX · TXT — up to {MAX_MB} MB
        </span>
        <span
          className="mt-1 px-4 py-1.5 rounded text-xs font-medium tracking-wide"
          style={{ border: "1px solid var(--accent-gold-dim)", color: "var(--accent-gold)" }}
        >
          Choose a file
        </span>
      </label>
      <p className="text-xs text-center" style={{ color: "var(--foreground-faint)" }}>
        Your file is read on this device; only the text you select is sent.{" "}
        <button
          type="button"
          data-testid="paste-mode-button"
          onClick={() => setMode("paste")}
          className="underline underline-offset-2"
          style={{ color: "var(--foreground-muted)" }}
        >
          Paste text instead
        </button>
      </p>
    </div>
  );
}
