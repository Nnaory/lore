"use client";

/**
 * useHomeComposer
 *
 * Thin React hook over lib/home: holds the instructions text, the attached
 * file and the two messages (file rejected, file required), and exposes
 * handlers any Home layout can wire to its own markup (the glass field today,
 * option B's dialogue bar in the hero). Sending stores the file and the
 * instructions with setPendingMaterial and goes to /create; the fields are
 * then emptied because the home page stays mounted while /create is open.
 * `onFileChange` lets the layout follow the file (Hazel's expression).
 */

import { useState, type FormEvent, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { chooseFile, decideSend } from "@/lib/home/composer-state";
import type { HomeFileRejection } from "@/lib/home/file-check";
import { setPendingMaterial } from "@/lib/setup/pending-material";

export function useHomeComposer(onFileChange?: (file: File | null) => void) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [file, setFileState] = useState<File | null>(null);
  /** Why the last chosen file was rejected; the layout translates it (`home.file.<reason>`). */
  const [fileError, setFileError] = useState<HomeFileRejection | null>(null);
  /** Text was typed (or send pressed) without a file. */
  const [needsFile, setNeedsFile] = useState(false);

  const hasText = text.trim() !== "";
  const missingFile = file === null && (hasText || needsFile);

  function setFile(next: File | null) {
    setFileState(next);
    onFileChange?.(next);
  }

  function pickFile(candidate: File) {
    const result = chooseFile(file, candidate);
    if (!result.ok) {
      setFileError(result.reason);
      return;
    }
    setFileError(null);
    setNeedsFile(false);
    setFile(result.file);
  }

  function removeFile() {
    setFileError(null);
    setFile(null);
  }

  function send(): boolean {
    const decision = decideSend(file, text);
    if (decision.kind === "idle") return false;
    if (decision.kind === "file_required") {
      setNeedsFile(true);
      return false;
    }
    setPendingMaterial({ file: decision.file, instructions: decision.instructions });
    router.push("/create");
    setText("");
    setFile(null);
    setFileError(null);
    setNeedsFile(false);
    return true;
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

  return {
    text, setText, file, fileError, hasText, missingFile,
    pickFile, removeFile, send, handleSubmit, handleKeyDown,
  };
}
