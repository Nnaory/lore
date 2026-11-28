/**
 * /create — Preparation page
 *
 * 01 Material: upload a PDF/DOCX/PPTX/TXT/MD (read in the browser), then
 *    choose which sections to use. A file is required; typed text is only
 *    extra instructions (under Advanced options), never material.
 * 02 World: pick a genre. 03 Chapters: story length plus advanced options.
 * A file attached on the home page (with any instructions typed there) arrives here already chosen
 * (lib/setup/pending-material) and is read as if it were added in step 01.
 * "Build the world" (80px action bar) opens the staged generation screen (concepts → the
 * player's review → world → story). The finished campaign is saved to
 * the browser (IndexedDB) and opened at /play/[id]. If saving fails (e.g. storage is
 * full) it is played in memory with a warning.
 */

"use client";

import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { createProject } from "@/lib/state/project-store";
import { extractDocument, type ExtractResult } from "@/lib/ingest";
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
import { takePendingMaterial } from "@/lib/setup/pending-material";
import { GenerationScreen } from "@/components/setup/GenerationScreen";
import { MaterialInput } from "@/components/setup/MaterialInput";
import { DocumentCard } from "@/components/setup/DocumentCard";
import { GenrePicker, GENRE_CHOICES } from "@/components/setup/GenrePicker";
import { PrepColumn } from "@/components/setup/PrepColumn";
import { ChaptersSection } from "@/components/setup/ChaptersSection";
import { AdvancedOptions } from "@/components/setup/AdvancedOptions";
import { SectionLabel } from "@/components/ui/SectionLabel";
import { CampaignPlayer } from "@/components/campaign/CampaignPlayer";

const BLOCKER_HINT: Record<SubmitBlocker, string> = {
  no_document: "Upload a material file to begin.",
  reading: "Reading your document…",
  no_sections: "Select at least one section.",
  too_short: "The selected text is too short to build a story from.",
  too_long: "The selected text is over the limit — deselect some sections.",
  no_genre: "Choose a world for your story.",
};

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

  function applyResult(requestId: number, fileName: string, result: ExtractResult) {
    if (result.ok) dispatch({ type: "read_succeeded", requestId, document: result.document });
    else dispatch({ type: "read_failed", requestId, fileName, error: result.error });
  }

  // Material sent from the home page. Effects also re-run when this page is
  // shown again (see above), so a second send from home is picked up too.
  // The handoff can be taken once, which keeps the dev-mode double effect from
  // reading it twice. A layout effect, so the form never paints empty first.
  useLayoutEffect(() => {
    const pending = takePendingMaterial();
    if (!pending) return;
    // New material means a new story: drop a run left going in the background.
    resetGeneration();
    // The handoff lives outside React, so an effect is the only place to learn of it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setGenerating(false);
    const requestId = ++lastRequestId.current;
    const { file, instructions } = pending;
    dispatch({ type: "instructions_set", text: instructions });
    dispatch({ type: "read_started", requestId, fileName: file.name });
    void extractDocument(file).then((result) => applyResult(requestId, file.name, result));
  }, [resetGeneration]);

  const materialText = selectMaterialText(state);
  const blocker = selectSubmitBlocker(state, materialText);

  async function handleFile(file: File) {
    const requestId = ++lastRequestId.current;
    dispatch({ type: "read_started", requestId, fileName: file.name });
    applyResult(requestId, file.name, await extractDocument(file));
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
          className="fixed inset-x-0 top-0 z-[60] flex min-h-[44px] items-center justify-center bg-ember px-4 py-2 text-center font-mono text-[12px] font-bold text-ink"
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
        onRetryAnimation={generation.retryAnimation}
        onSkipAnimation={generation.skipAnimation}
      />
    );
  }

  const worldLabel = GENRE_CHOICES.find((c) => c.genre === state.genre)?.label ?? "";
  const chapters = state.length === "medium" ? 5 : 3;
  const status = blocker ? BLOCKER_HINT[blocker] : `Ready · ${chapters} chapters · ${worldLabel}`;

  return (
    <div data-testid="create-page">
      <PrepColumn>
        <section className="mt-[22px] md:mt-[34px]" data-testid="material-section">
          <SectionLabel number="01" title="MATERIAL" />
          <div className="mt-3 md:mt-3.5">
            {state.doc.status === "empty" ? (
              <MaterialInput onFile={handleFile} />
            ) : (
              <DocumentCard
                doc={state.doc}
                materialLength={materialText.length}
                onRemove={() => dispatch({ type: "document_cleared" })}
                onToggle={(sectionId) => dispatch({ type: "section_toggled", sectionId })}
                onSetAll={(selected) => dispatch({ type: "all_sections_set", selected })}
              />
            )}
          </div>
        </section>

        <section className="mt-[22px] md:mt-[30px]" data-testid="world-section">
          <SectionLabel number="02" title="WORLD" />
          <div className="mt-3 md:mt-3.5">
            <GenrePicker value={state.genre} onChange={(genre) => dispatch({ type: "genre_set", genre })} />
          </div>
        </section>

        <ChaptersSection
          length={state.length}
          onLengthChange={(length) => dispatch({ type: "length_set", length })}
          advanced={
            <AdvancedOptions
              language={state.language}
              customInstructions={state.customInstructions}
              onLanguageChange={(language) => dispatch({ type: "language_set", language })}
              onInstructionsChange={(text) => dispatch({ type: "instructions_set", text })}
            />
          }
        />

        <div aria-hidden="true" className="h-8 shrink-0" />
        <div
          data-testid="prep-action-bar"
          className="sticky bottom-0 -mx-5 mt-auto flex flex-col items-stretch gap-2 border-t border-smoke bg-ink px-4 pb-5 pt-3 md:-mx-12 md:h-20 md:flex-row md:items-center md:justify-between md:gap-4 md:px-12 md:pb-0 md:pt-0"
        >
          <span
            className={`font-mono text-[11px] md:text-xs ${blocker ? "text-muted" : "text-cream"}`}
            aria-live="polite"
            data-testid="submit-hint"
          >
            {status}
          </span>
          <button
            type="button"
            data-testid="build-button"
            onClick={handleSubmit}
            disabled={blocker !== null}
            aria-disabled={blocker !== null}
            className={`h-[52px] w-full shrink-0 border-none px-6 font-mono text-sm font-bold md:h-12 md:w-auto ${
              blocker ? "cursor-not-allowed bg-smoke text-muted" : "cursor-pointer bg-ember text-ink"
            }`}
          >
            Build the world →
          </button>
        </div>      </PrepColumn>
    </div>
  );
}
