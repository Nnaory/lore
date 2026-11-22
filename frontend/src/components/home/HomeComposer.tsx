/**
 * HomeComposer
 *
 * The home page's one control: a chat-style field. The material is always a
 * file, attached with the clip on the right. Text typed in the field is never
 * material: it is extra instructions for the storyteller (tone, setting,
 * focus), sent along with the file. Sending is off until a file is attached,
 * and typing without one shows a warning. The file and the instructions go to
 * /create (see lib/setup/pending-material), which reads the file and asks for
 * the rest (world, length, language). State and handlers live in
 * use-home-composer (over lib/home), so option B's dialogue bar can reuse them;
 * `onFileChange` reports the file so Hazel's greeting can follow it.
 */

"use client";

import { useEffect, useRef } from "react";
import { ArrowUp, FileText, Paperclip, X } from "lucide-react";
import { ACCEPTED_FILE_TYPES } from "@/lib/ingest";
import { MAX_FILE_BYTES } from "@/lib/ingest/limits";
import { MAX_INSTRUCTIONS_CHARS } from "@/lib/setup/create-form";
import { ErrorLine } from "@/components/ui/ErrorLine";
import { HOME_FILE_MESSAGES } from "@/lib/home/file-check";
import { useHomeComposer } from "./use-home-composer";

/** Tallest the field grows before it scrolls. */
const MAX_INPUT_HEIGHT = 220;
const MAX_MB = Math.round(MAX_FILE_BYTES / (1024 * 1024));

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function HomeComposer({ onFileChange }: { onFileChange?: (file: File | null) => void } = {}) {
  const { text, setText, file, fileError, hasText, missingFile, pickFile, removeFile, handleSubmit, handleKeyDown } =
    useHomeComposer(onFileChange);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function growToFit(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  }

  // The field is emptied after sending: drop the grown height with it.
  useEffect(() => {
    if (text === "" && inputRef.current) inputRef.current.style.height = "";
  }, [text]);

  return (
    <div className="flex flex-col gap-3">
      <form
        data-testid="home-composer"
        onSubmit={handleSubmit}
        className="lore-glass lore-glass-composer rounded-card flex flex-col gap-2 p-2.5"
      >
        {file && (
          <div
            data-testid="home-file-chip"
            className="lore-tile rounded-tip self-start max-w-full flex items-center gap-2 py-1.5 pl-3 pr-1.5"
          >
            <FileText size={14} aria-hidden="true" className="flex-none" style={{ color: "var(--accent-gold-dim)" }} />
            <span className="min-w-0 truncate text-sm" style={{ color: "var(--foreground)" }}>
              {file.name}
            </span>
            <span className="flex-none text-xs" style={{ color: "var(--foreground-faint)" }}>
              {formatSize(file.size)}
            </span>
            <button
              type="button"
              data-testid="home-file-remove"
              onClick={removeFile}
              aria-label={`Remove ${file.name}`}
              className="flex-none p-1 rounded-pill transition-colors hover:bg-white/5"
              style={{ color: "var(--foreground-faint)" }}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        )}

        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            data-testid="home-input"
            aria-label="Instructions for the storyteller"
            rows={1}
            value={text}
            maxLength={MAX_INSTRUCTIONS_CHARS}
            onChange={(e) => {
              setText(e.target.value);
              growToFit(e.target);
            }}
            onKeyDown={handleKeyDown}
            placeholder={
              file ? "Add instructions (optional), then press send." : "Add instructions (optional), then attach a file…"
            }
            className="lore-composer-input flex-1 min-w-0 resize-none bg-transparent px-3 py-2 text-[15px] leading-6"
            style={{ color: "var(--foreground)" }}
          />

          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_FILE_TYPES}
            className="sr-only"
            tabIndex={-1}
            data-testid="home-file-input"
            onChange={(e) => {
              const chosen = e.target.files?.[0];
              if (chosen) pickFile(chosen);
              e.target.value = ""; // allow choosing the same file again
            }}
          />
          <button
            type="button"
            data-testid="home-attach"
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach a material file"
            title="Attach a material file"
            className={`lore-pill lore-pill-icon flex-none ${missingFile ? "lore-pill-accent" : ""}`}
          >
            <Paperclip size={18} aria-hidden="true" />
          </button>
          <button
            type="submit"
            data-testid="home-send"
            disabled={file === null}
            aria-label="Build a story from the attached file"
            className="lore-pill lore-pill-icon lore-pill-primary flex-none"
          >
            <ArrowUp size={18} aria-hidden="true" />
          </button>
        </div>
      </form>

      {fileError && <ErrorLine data-testid="home-file-error">{HOME_FILE_MESSAGES[fileError]}</ErrorLine>}
      {missingFile && (
        <ErrorLine data-testid="home-file-required">
          Attach a material file first. What you type here is used as extra instructions, not as material.
        </ErrorLine>
      )}
      {hasText && (
        <p
          className="text-right text-xs px-2"
          style={{ color: "var(--foreground-faint)" }}
          data-testid="home-instructions-count"
        >
          {text.length} / {MAX_INSTRUCTIONS_CHARS}
        </p>
      )}

      <p className="lore-halo text-center text-xs" style={{ color: "var(--foreground-faint)" }}>
        PDF · DOCX · PPTX · TXT · MD, up to {MAX_MB} MB. A file is required. Your file is read on this device.
      </p>
    </div>
  );
}
