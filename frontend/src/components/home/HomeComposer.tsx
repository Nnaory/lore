/**
 * HomeComposer
 *
 * The home page's one control: a chat-style field where the player pastes
 * material or, with the clip on its right, attaches a document. Sending hands
 * the material to /create (see lib/setup/pending-material), which reads it and
 * asks for the rest (world, length, language).
 *
 * The pipeline takes a single piece of material, so the field holds either
 * typed text or one file, never both: attaching is off while there is text,
 * and typing is off while a file is attached.
 */

"use client";

import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, FileText, Paperclip, X } from "lucide-react";
import { ACCEPTED_FILE_TYPES } from "@/lib/ingest";
import { MAX_FILE_BYTES } from "@/lib/ingest/limits";
import { setPendingMaterial } from "@/lib/setup/pending-material";

/** Tallest the field grows before it scrolls. */
const MAX_INPUT_HEIGHT = 220;
const MAX_MB = Math.round(MAX_FILE_BYTES / (1024 * 1024));

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function HomeComposer() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hasText = text.trim() !== "";
  const canSend = file !== null || hasText;

  function growToFit(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  }

  function send() {
    if (!canSend) return;
    setPendingMaterial(file ? { kind: "file", file } : { kind: "text", text });
    router.push("/create");
    // The home page stays mounted (hidden) while /create is open, so leave it
    // empty for when the player comes back.
    setText("");
    setFile(null);
    if (inputRef.current) inputRef.current.style.height = "";
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    send();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter adds a line. Enter that confirms an IME choice does neither.
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    send();
  }

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
              onClick={() => setFile(null)}
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
            aria-label="Your material"
            rows={1}
            value={text}
            disabled={file !== null}
            onChange={(e) => {
              setText(e.target.value);
              growToFit(e.target);
            }}
            onKeyDown={handleKeyDown}
            placeholder={file ? "File attached. Press send." : "Paste text or attach a file…"}
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
              if (chosen) setFile(chosen);
              e.target.value = ""; // allow choosing the same file again
            }}
          />
          <button
            type="button"
            data-testid="home-attach"
            onClick={() => fileInputRef.current?.click()}
            disabled={hasText}
            aria-label="Attach a file"
            title={hasText ? "Clear the text to attach a file instead" : "Attach a file"}
            className="lore-pill lore-pill-icon flex-none"
          >
            <Paperclip size={18} aria-hidden="true" />
          </button>
          <button
            type="submit"
            data-testid="home-send"
            disabled={!canSend}
            aria-label="Build a story from this material"
            className="lore-pill lore-pill-icon lore-pill-primary flex-none"
          >
            <ArrowUp size={18} aria-hidden="true" />
          </button>
        </div>
      </form>

      <p className="lore-halo text-center text-xs" style={{ color: "var(--foreground-faint)" }}>
        PDF · DOCX · PPTX · TXT · MD, up to {MAX_MB} MB. Your file is read on this device.
      </p>
    </div>
  );
}
