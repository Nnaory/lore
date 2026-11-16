/**
 * /create — Preparation page
 *
 * 01 Material: upload a PDF/DOCX/PPTX/TXT (read in the browser) or paste
 *    text, then choose which sections to use.
 * 02 World: pick a genre and optional preferences.
 * "Build the world" opens the staged generation screen (concepts → the
 * player's review → world → story). The finished campaign is saved to
 * the browser (IndexedDB) and opened at /play/[id]. If saving fails (e.g. storage is
 * full) it is played in memory with a warning.
 */

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useReducer, useRef, useState } from "react";
import { createProject } from "@/lib/state/project-store";
import { ArrowLeft } from "lucide-react";
import { extractDocument, extractPastedText, type ExtractResult } from "@/lib/ingest";
import {
  buildWorkflowRequest,
  createFormReducer,
  initialCreateFormState,
  selectMaterialText,
  selectSubmitBlocker,
  type SubmitBlocker,
} from "@/lib/setup/create-form";
import { useGeneration, type GenerationResult } from "@/lib/generation/use-generation";
import type { ExtractedDocument } from "@/lib/types/document";
import { GenerationScreen } from "@/components/setup/GenerationScreen";
import { MaterialInput } from "@/components/setup/MaterialInput";
import { DocumentCard } from "@/components/setup/DocumentCard";
import { GenrePicker } from "@/components/setup/GenrePicker";
import { AdvancedOptions } from "@/components/setup/AdvancedOptions";
import { CampaignPlayer } from "@/components/campaign/CampaignPlayer";

const BLOCKER_HINT: Record<SubmitBlocker, string> = {
  no_document: "Add your material to begin.",
  reading: "Reading your document…",
  no_sections: "Select at least one section.",
  too_short: "The selected text is too short to build a story from.",
  too_long: "The selected text is over the limit — deselect some sections.",
  no_genre: "Choose a world for your story.",
  submitting: "Building your story…",
};

function StepHeading({ id, index, title }: { id: string; index: string; title: string }) {
  return (
    <h2 id={id} className="flex items-baseline gap-3 mb-4">
      <span className="font-mono text-xs" style={{ color: "var(--accent-gold-dim)" }}>
        {index}
      </span>
      <span className="text-xs font-semibold tracking-[0.25em] uppercase" style={{ color: "var(--foreground)" }}>
        {title}
      </span>
    </h2>
  );
}

type BuiltCampaign = Pick<GenerationResult, "campaign" | "stories"> & { saveError: string };

function sourceLabel(doc: ExtractedDocument | null): string {
  if (!doc) return "your text";
  const n = doc.stats.units;
  const noun = doc.file_type === "pdf" ? "page" : doc.file_type === "pptx" ? "slide" : "section";
  return `${doc.file_name} · ${n} ${noun}${n === 1 ? "" : "s"}`;
}

export default function CreatePage() {
  const router = useRouter();
  const [state, dispatch] = useReducer(createFormReducer, initialCreateFormState);
  /** Only set when the campaign could not be saved and is played in memory. */
  const [built, setBuilt] = useState<BuiltCampaign | null>(null);
  const [generating, setGenerating] = useState(false);
  const lastRequestId = useRef(0);
  const readyDocument = state.doc.status === "ready" ? state.doc.document : null;
  /** Set once a story was saved and we navigated to it. */
  const savedAndLeft = useRef(false);

  const generation = useGeneration({
    onDone: async ({ material, campaign, stories }) => {
      const saved = await createProject({
        source: {
          file_name: readyDocument?.file_name ?? "Material",
          file_type: readyDocument?.file_type ?? "text",
        },
        campaign,
        stories,
        materials: [material],
      });
      if (saved.ok) {
        savedAndLeft.current = true;
        router.push(`/play/${saved.value.id}`);
      } else {
        setBuilt({ campaign, stories, saveError: saved.message });
      }
    },
  });

  // With cacheComponents, Next.js keeps a page we navigate away from mounted
  // but hidden (React <Activity>) and shows it again — state included — when
  // the player comes back. Effects re-run on that re-show, so start a fresh
  // form if the last visit ended with a saved story.
  const { reset: resetGeneration } = generation;
  useEffect(() => {
    if (!savedAndLeft.current) return;
    savedAndLeft.current = false;
    resetGeneration();
    setGenerating(false);
    setBuilt(null);
    dispatch({ type: "reset" });
  }, [resetGeneration]);

  const materialText = selectMaterialText(state);
  const blocker = selectSubmitBlocker(state, materialText);

  function applyResult(requestId: number, fileName: string, result: ExtractResult) {
    if (result.ok) dispatch({ type: "read_succeeded", requestId, document: result.document });
    else dispatch({ type: "read_failed", requestId, fileName, error: result.error });
  }

  async function handleFile(file: File) {
    const requestId = ++lastRequestId.current;
    dispatch({ type: "read_started", requestId, fileName: file.name });
    applyResult(requestId, file.name, await extractDocument(file));
  }

  function handlePaste(text: string) {
    const requestId = ++lastRequestId.current;
    dispatch({ type: "read_started", requestId, fileName: "Pasted text" });
    applyResult(requestId, "Pasted text", extractPastedText(text));
  }

  function handleSubmit() {
    const body = buildWorkflowRequest(state);
    if (!body) return;
    setGenerating(true);
    generation.start(body);
  }

  function backToForm() {
    generation.cancel();
    setGenerating(false);
  }

  if (built) {
    return (
      <>
        <div
          role="alert"
          data-testid="create-save-error"
          className="fixed top-0 inset-x-0 z-[60] px-4 py-2 text-xs text-center"
          style={{ backgroundColor: "var(--danger-bg)", color: "var(--danger)" }}
        >
          {built.saveError} This story will be lost when you leave the page.
        </div>
        <CampaignPlayer campaign={built.campaign} stories={built.stories} />
      </>
    );
  }

  if (generating) {
    return (
      <GenerationScreen
        state={generation.state}
        sourceLabel={sourceLabel(readyDocument)}
        onToggleConcept={generation.toggleConcept}
        onConfirmConcepts={generation.confirmConcepts}
        onRetry={generation.retry}
        onBack={backToForm}
      />
    );
  }

  const submitting = state.submit.status === "submitting";

  return (
    <div className="lore-bg min-h-screen flex flex-col" data-testid="create-page">
      <header className="w-full max-w-2xl mx-auto px-5 pt-6 flex items-center justify-between">
        <Link
          href="/"
          className="flex items-center gap-1.5 text-xs tracking-wide"
          style={{ color: "var(--foreground-muted)" }}
        >
          <ArrowLeft size={14} aria-hidden="true" />
          Back
        </Link>
        <span className="text-xs font-semibold tracking-[0.3em]" style={{ color: "var(--accent-gold-dim)" }}>
          LORE
        </span>
      </header>

      <main className="flex-1 w-full max-w-2xl mx-auto px-5 pt-10 pb-6 flex flex-col gap-12">
        <div>
          <p className="text-xs tracking-widest uppercase mb-2" style={{ color: "var(--foreground-faint)" }}>
            New story
          </p>
          <h1 className="text-2xl font-semibold tracking-wide" style={{ color: "var(--foreground)" }}>
            Turn your material into a story
          </h1>
          <p className="text-sm mt-2 leading-6" style={{ color: "var(--foreground-muted)" }}>
            Bring lecture notes, a chapter, or a slide deck. LORE builds a world around it where every
            challenge is solved with what you learn.
          </p>
        </div>

        <section aria-labelledby="step-material">
          <StepHeading id="step-material" index="01" title="Material" />
          {state.doc.status === "empty" ? (
            <MaterialInput onFile={handleFile} onPaste={handlePaste} />
          ) : (
            <DocumentCard
              doc={state.doc}
              materialLength={materialText.length}
              onRemove={() => dispatch({ type: "document_cleared" })}
              onToggle={(sectionId) => dispatch({ type: "section_toggled", sectionId })}
              onSetAll={(selected) => dispatch({ type: "all_sections_set", selected })}
            />
          )}
        </section>

        <section aria-labelledby="step-world" className="flex flex-col gap-5">
          <div>
            <StepHeading id="step-world" index="02" title="World" />
            <GenrePicker value={state.genre} onChange={(genre) => dispatch({ type: "genre_set", genre })} />
          </div>
          <AdvancedOptions
            length={state.length}
            language={state.language}
            customInstructions={state.customInstructions}
            onLengthChange={(length) => dispatch({ type: "length_set", length })}
            onLanguageChange={(language) => dispatch({ type: "language_set", language })}
            onInstructionsChange={(text) => dispatch({ type: "instructions_set", text })}
          />
        </section>
      </main>

      <footer
        className="sticky bottom-0 w-full"
        style={{ background: "linear-gradient(to top, var(--background) 70%, transparent)" }}
      >
        <div className="max-w-2xl mx-auto px-5 py-5 flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
          <p
            className="text-xs"
            aria-live="polite"
            data-testid="submit-hint"
            style={{ color: state.submit.status === "failed" ? "var(--danger)" : "var(--foreground-faint)" }}
          >
            {state.submit.status === "failed" ? state.submit.message : blocker ? BLOCKER_HINT[blocker] : "Ready when you are."}
          </p>
          <button
            type="button"
            data-testid="build-button"
            onClick={handleSubmit}
            disabled={blocker !== null}
            aria-disabled={blocker !== null}
            className="px-6 py-3 rounded text-sm font-medium tracking-wide transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ backgroundColor: "var(--accent-gold)", color: "var(--background)" }}
          >
            {submitting ? "Building your story…" : "Build the world →"}
          </button>
        </div>
      </footer>
    </div>
  );
}
