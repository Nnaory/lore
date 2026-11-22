"use client";

/**
 * HomeHero: Home option B, "Greeted by Hazel" (docs/DESIGN-SYSTEM.md §4.7,
 * HomeB.dc.html and HomeBMobile.dc.html).
 *
 * A 1440x900 (desktop) / 390x844 (phone) board scaled as a whole by
 * ScaledBoard (in flow, so the saved stories can follow it on the page).
 * Hazel is drawn with renderCharacter (desktop, 10px cells, in front of the
 * box) or renderBust (phone, 9px cells, behind it); the title is wordmark().
 * The composer is the DialogueBox's bottom bar: input, Add file/Replace and
 * Brew it. State and rules come from useHomeComposer and hazelGreeting, so
 * adding a file turns Hazel surprised and changes her line, and removing it
 * restores both. A file is required: her lines and the formats row say so.
 * Every label comes from lib/i18n/ui.ts (`t`); the language is `useUiLang()`
 * (saved setting → browser → English), DESIGN-SYSTEM §9. Phone uses the short lines.
 * The animated pumpkins behind come from the root layout's backdrop; only
 * the grid lines are drawn here.
 */

import Link from "next/link";
import { useMemo, useRef } from "react";
import { AsciiArt } from "@/components/ascii/AsciiArt";
import { DialogueBox } from "@/components/story/DialogueBox";
import { ScaledBoard, useBoardPixelRatio } from "@/components/stage/ScaledBoard";
import { ErrorLine } from "@/components/ui/ErrorLine";
import { renderBust, renderCharacter, wordmark } from "@/lib/ascii";
import { hazelGreeting } from "@/lib/home/hazel-greeting";
import { t, type UiLang } from "@/lib/i18n/ui";
import { useUiLang } from "@/lib/i18n/use-ui-lang";
import { ACCEPTED_FILE_TYPES } from "@/lib/ingest";
import { MAX_FILE_BYTES } from "@/lib/ingest/limits";
import { MAX_INSTRUCTIONS_CHARS } from "@/lib/setup/create-form";
import type { StageLayout } from "@/lib/stage/board-scale";
import { useHomeComposer } from "./use-home-composer";

const MAX_MB = Math.round(MAX_FILE_BYTES / (1024 * 1024));
const WORDMARK = wordmark();
const HAZEL_NAME = "var(--color-cloth-hazel)";

type Composer = ReturnType<typeof useHomeComposer>;

/** Paperclip icon of the Add file button (canvas SVG). */
function ClipIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" aria-hidden="true" focusable="false">
      <path d="M21 11l-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7" />
    </svg>
  );
}

function FileChip({ file, removeFile, padding, lang }: { file: File; removeFile: () => void; padding: string; lang: UiLang }) {
  return (
    <div className={padding}>
      <span
        data-testid="home-file-chip"
        className="inline-flex h-7 max-w-full items-center gap-2 bg-ink pl-2.5 pr-1 font-mono text-xs text-cream"
      >
        <span className="min-w-0 truncate">{file.name}</span>
        <button
          type="button"
          data-testid="home-file-remove"
          onClick={removeFile}
          aria-label={t(lang, "home.removeFileNamed", { file: file.name })}
          className="h-6 w-6 shrink-0 cursor-pointer border-0 bg-transparent p-0 text-muted"
        >
          ✕
        </button>
      </span>
    </div>
  );
}

/** The composer: textarea + hidden file input + the two buttons, laid out per layout. */
function ComposerBar({ layout, c, lang }: { layout: StageLayout; c: Composer; lang: UiLang }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const phone = layout === "phone";
  const hasFile = c.file !== null;
  const fileLabel = t(lang, hasFile ? "home.replace" : "home.addFile");

  const field = (
    <div className={`flex items-center gap-2 ${phone ? "h-[52px] px-3.5" : "grow gap-2.5 pl-10"}`}>
      <span aria-hidden className="font-mono font-bold">&gt;</span>
      <label htmlFor="home-ask" className="sr-only">{t(lang, "home.inputLabel")}</label>
      <textarea
        id="home-ask"
        data-testid="home-input"
        rows={1}
        value={c.text}
        maxLength={MAX_INSTRUCTIONS_CHARS}
        onChange={(e) => c.setText(e.target.value)}
        onKeyDown={c.handleKeyDown}
        placeholder={t(lang, phone ? "home.placeholderShort" : "home.placeholder")}
        className={`h-11 min-w-0 grow resize-none overflow-y-auto border-0 bg-transparent py-[11px] font-mono text-ink outline-none placeholder:text-ink-soft ${phone ? "text-sm" : "text-[15px]"}`}
      />
    </div>
  );

  const addFile = (
    <button
      type="button"
      data-testid="home-attach"
      onClick={() => fileInputRef.current?.click()}
      className={`flex cursor-pointer items-center gap-2 border-0 font-mono text-[13px] font-bold ${
        phone ? "justify-center" : "border-l-2 border-ink px-[18px]"
      } ${hasFile ? "bg-ink text-cream" : "bg-transparent text-ink"}`}
    >
      <ClipIcon />
      {fileLabel}
    </button>
  );
  const brew = (
    <button
      type="submit"
      data-testid="home-send"
      disabled={!hasFile}
      className={`cursor-pointer border-0 bg-ember font-mono text-[13px] font-bold text-ink disabled:cursor-not-allowed disabled:bg-smoke disabled:text-muted ${
        phone ? "border-l-2 border-ink" : "flex items-center gap-2 border-l-2 border-ink px-5"
      }`}
    >
      {t(lang, "home.brew")}
    </button>
  );

  return (
    <>
      {c.file && (
        <FileChip file={c.file} removeFile={c.removeFile} padding={phone ? "px-4 pb-2.5" : "px-10 pb-2.5"} lang={lang} />
      )}
      <form
        data-testid="home-composer"
        onSubmit={c.handleSubmit}
        className={`m-0 flex border-t-2 border-ink ${phone ? "flex-col" : "h-14 items-stretch"}`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_FILE_TYPES}
          className="sr-only"
          tabIndex={-1}
          aria-label={t(lang, "home.fileInputLabel")}
          data-testid="home-file-input"
          onChange={(e) => {
            const chosen = e.target.files?.[0];
            if (chosen) c.pickFile(chosen);
            e.target.value = ""; // allow choosing the same file again
          }}
        />
        {field}
        {phone ? (
          <div className="grid h-[50px] grid-cols-2 border-t-2 border-ink">
            {addFile}
            {brew}
          </div>
        ) : (
          <>
            {addFile}
            {brew}
          </>
        )}
      </form>
    </>
  );
}

function Messages({ c, lang }: { c: Composer; lang: UiLang }) {
  return (
    <>
      {c.fileError && <ErrorLine data-testid="home-file-error">{t(lang, `home.file.${c.fileError}`)}</ErrorLine>}
      {c.missingFile && (
        <ErrorLine data-testid="home-file-required">{t(lang, "home.fileRequired")}</ErrorLine>
      )}
      {c.hasText && (
        <p
          data-testid="home-instructions-count"
          className="m-0 text-right font-mono text-xs text-muted"
        >
          {c.text.length} / {MAX_INSTRUCTIONS_CHARS}
        </p>
      )}
    </>
  );
}

function DemoLink({ phone, lang }: { phone: boolean; lang: UiLang }) {
  return (
    <Link
      href="/game"
      data-testid="home-demo-link"
      className={`flex items-center gap-2.5 border-2 border-smoke font-mono text-[13px] text-cream no-underline hover:text-ember ${
        phone ? "absolute inset-x-4 bottom-7 h-[52px] justify-center" : "h-11 px-4"
      }`}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="var(--color-ember)" aria-hidden="true" focusable="false">
        <path d="M6 4l14 8-14 8z" />
      </svg>
      {t(lang, "common.playDemoLong")}
    </Link>
  );
}

function HeroBoard({ layout }: { layout: StageLayout }) {
  const c = useHomeComposer();
  const lang = useUiLang();
  const phone = layout === "phone";
  const greeting = hazelGreeting(c.file !== null);
  const line = c.file
    ? t(lang, phone ? "home.gotFileShort" : "home.gotFile", { file: c.file.name })
    : t(lang, phone ? "home.greetingShort" : "home.greeting");
  const pixelRatio = useBoardPixelRatio();
  const hazel = useMemo(
    () => (phone ? renderBust("hazel", greeting.expression) : renderCharacter("hazel", greeting.expression)),
    [phone, greeting.expression],
  );

  const formats = t(lang, phone ? "home.formatsShort" : "home.formats", { mb: MAX_MB });

  return (
    <>
      <div
        className="absolute inset-x-0 flex flex-col items-center"
        style={{ top: phone ? 56 : 64, gap: phone ? 6 : 10 }}
      >
        <h1 className="m-0" aria-label={t(lang, "common.lore")}>
          <AsciiArt layers={WORDMARK} fontPx={phone ? 5 : 8} pixelRatio={pixelRatio} />
        </h1>
        <p className="m-0 font-display text-muted" style={{ fontSize: phone ? 14 : 16 }}>
          {t(lang, "common.tagline")}
        </p>
      </div>

      <div
        role="img"
        aria-label={t(lang, `home.hazelAlt.${greeting.expression}`)}
        data-testid="home-hazel"
        data-expression={greeting.expression}
        className="absolute pointer-events-none"
        style={
          phone
            ? { left: 10, top: 150, width: 238, height: 279, overflow: "hidden", zIndex: 5 }
            : { left: 230, top: 300, width: 264, height: 480, zIndex: 20 }
        }
      >
        <AsciiArt layers={hazel} fontPx={phone ? 9 : 10} pixelRatio={pixelRatio} />
      </div>

      <div
        className="absolute flex flex-col gap-2"
        style={phone ? { left: 12, top: 420, width: 366, zIndex: 10 } : { left: 450, top: 548, width: 780, zIndex: 10 }}
      >
        <DialogueBox
          speakerName="Hazel"
          speakerRole={t(lang, "home.hazelRole")}
          nameColor={HAZEL_NAME}
          text={line}
          mode="fast"
          onModeChange={() => {}}
          onOpenLog={() => {}}
          padLeft={40}
          testIds={{ root: "home-dialogue", text: "home-hazel-line" }}
          className={phone ? "" : "h-[212px]"}
          bottomBar={<ComposerBar layout={layout} c={c} lang={lang} />}
        />
        <Messages c={c} lang={lang} />
      </div>

      {phone ? (
        <p className="absolute inset-x-0 m-0 text-center font-mono text-[11px] text-muted" style={{ top: 726 }}>
          {formats}
        </p>
      ) : (
        <div className="absolute flex items-center justify-between" style={{ left: 450, width: 780, top: 790 }}>
          <span className="font-mono text-xs text-muted">{formats}</span>
          <DemoLink phone={false} lang={lang} />
        </div>
      )}
      {phone && <DemoLink phone lang={lang} />}
    </>
  );
}

export function HomeHero() {
  return (
    <ScaledBoard inFlow rootClassName="lore-grid-lines">
      {(layout) => <HeroBoard layout={layout} />}
    </ScaledBoard>
  );
}
