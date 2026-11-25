/**
 * GenerationScreen (Pola K, design 6.1; no canvas frame)
 *
 * Shows the real pipeline stages while a story is built, the concept review
 * checkpoint (the player removes concepts that are wrong or irrelevant
 * before any story is written), a preview of the designed world, and a
 * retry that resumes from the stage that failed.
 *
 * Built only from Kit parts (Button, ErrorLine, Icon, SectionLabel) and token classes: no
 * radius, shadow, card or spinner. The surface is transparent so the animated global pumpkin
 * backdrop stays visible (user decision). Desktop column is 680px; phone uses 20px padding
 * and full-width 52px buttons. All behaviour and data-testid values are unchanged.
 */

"use client";

import { Button } from "@/components/ui/Button";
import { ErrorLine } from "@/components/ui/ErrorLine";
import { Icon } from "@/components/ui/Icon";
import { SectionLabel } from "@/components/ui/SectionLabel";
import type { GenerationStage, GenerationState } from "@/lib/generation/generation";

type GenerationScreenProps = {
  state: GenerationState;
  /** e.g. "3 pages" — what was read from the document. */
  sourceLabel: string;
  onToggleConcept: (conceptId: string) => void;
  onConfirmConcepts: () => void;
  onRetry: () => void;
  onBack: () => void;
};

const STEPS: Array<{ stage: Exclude<GenerationStage, "done">; label: string }> = [
  { stage: "analyzing", label: "Finding the key concepts" },
  { stage: "reviewing", label: "Your review of the concepts" },
  { stage: "planning", label: "Designing the world and characters" },
  { stage: "writing", label: "Writing the story" },
];

const ORDER: Record<GenerationStage, number> = { analyzing: 0, reviewing: 1, planning: 2, writing: 3, done: 4 };

type StepStatus = "done" | "active" | "failed" | "pending";

function stepStatus(step: Exclude<GenerationStage, "done">, state: GenerationState): StepStatus {
  const current = ORDER[state.stage];
  const index = ORDER[step];
  if (index < current) return "done";
  if (index > current) return "pending";
  return state.status === "failed" ? "failed" : "active";
}

/** 12px square marker: done gold, active ember, failed ember outline with "!", pending smoke. */
function StepMarker({ status }: { status: StepStatus }) {
  if (status === "failed") {
    return (
      <span
        aria-hidden="true"
        className="flex h-3 w-3 shrink-0 items-center justify-center border border-ember font-mono text-[9px] font-bold leading-none text-ember"
      >
        !
      </span>
    );
  }
  const fill = status === "done" ? "bg-gold" : status === "active" ? "bg-ember" : "bg-smoke";
  return <span aria-hidden="true" className={`h-3 w-3 shrink-0 ${fill}`} />;
}

export function GenerationScreen({
  state,
  sourceLabel,
  onToggleConcept,
  onConfirmConcepts,
  onRetry,
  onBack,
}: GenerationScreenProps) {
  const reviewing = state.stage === "reviewing";
  const failed = state.status === "failed";
  const selectedCount = state.selectedConceptIds.length;

  return (
    <div
      className="lore-grid-lines relative min-h-screen overflow-clip font-display text-cream"
      data-testid="generation-screen"
    >
      <main className="relative mx-auto flex min-h-screen w-full max-w-full flex-col bg-transparent px-5 pb-10 md:w-[680px] md:px-0">
        <div className="flex h-14 items-center justify-between md:mt-6 md:h-11">
          {reviewing || failed ? (
            <button
              type="button"
              onClick={onBack}
              aria-label="Back to edit"
              data-testid="generation-back"
              className="flex h-11 w-11 items-center justify-center text-cream"
            >
              <Icon name="back" size={20} />
            </button>
          ) : (
            <span aria-hidden="true" />
          )}
          <span className="font-mono text-[13px] font-bold leading-[1.32] tracking-[0.4em] text-gold">LORE</span>
        </div>

        <div className="mt-8 flex flex-col gap-1.5">
          <span className="font-mono text-[11px] font-bold uppercase leading-[1.32] tracking-[0.24em] text-ember md:text-[12px]">
            Building your world
          </span>
          <p className="m-0 font-mono text-[12px] text-muted">Read from your material: {sourceLabel}</p>
        </div>

        <ol className="m-0 mt-6 flex list-none flex-col p-0" aria-label="Progress" data-testid="generation-steps">
          {STEPS.map((step) => {
            const status = stepStatus(step.stage, state);
            let detail = "";
            if (step.stage === "analyzing" && state.material) detail = `${state.material.concepts.length} found`;
            if (step.stage === "reviewing" && status === "done") detail = `${selectedCount} kept`;
            if (step.stage === "planning" && state.campaign) detail = state.campaign.title;
            return (
              <li
                key={step.stage}
                data-testid={`step-${step.stage}`}
                data-status={status}
                className={`flex min-h-[44px] items-center gap-3 font-mono text-[14px] ${
                  status === "pending" ? "text-muted" : "text-cream"
                }`}
              >
                <StepMarker status={status} />
                <span className="flex-1">{step.label}</span>
                {detail && <span className="max-w-[45%] truncate text-[12px] text-muted">{detail}</span>}
              </li>
            );
          })}
        </ol>

        {/* Concept review */}
        {reviewing && state.material && (
          <section
            data-testid="concept-review"
            aria-labelledby="concept-review-heading"
            className="mt-8 flex flex-col gap-4"
          >
            <SectionLabel number="01" title="REVIEW" />
            <div>
              <h2 id="concept-review-heading" className="m-0 text-[17px] font-bold leading-snug text-cream">
                These are the concepts your story will teach
              </h2>
              <p className="m-0 mt-2 text-[15px] leading-normal text-muted">
                Untick anything that is wrong or not worth learning. Each concept becomes one chapter.
              </p>
            </div>
            <ul className="m-0 flex list-none flex-col p-0">
              {state.material.concepts.map((concept) => {
                const checked = state.selectedConceptIds.includes(concept.concept_id);
                return (
                  <li key={concept.concept_id}>
                    <label className="flex min-h-[56px] cursor-pointer items-start gap-3 border-b border-smoke py-3">
                      <input
                        type="checkbox"
                        data-testid={`concept-checkbox-${concept.concept_id}`}
                        checked={checked}
                        onChange={() => onToggleConcept(concept.concept_id)}
                        className="peer sr-only"
                      />
                      <span
                        aria-hidden="true"
                        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center border-2 border-cream peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-gold ${
                          checked ? "bg-ember text-ink" : "bg-transparent"
                        }`}
                      >
                        {checked && <Icon name="check" size={14} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={`block text-[15px] font-bold ${checked ? "text-cream" : "text-muted"}`}>
                          {concept.name}
                        </span>
                        <span className="line-clamp-2 block font-mono text-[12px] leading-[1.5] text-muted">
                          {concept.definition}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <Button variant="outline" onClick={onBack} className="w-full md:w-auto">
                Back to edit
              </Button>
              <Button
                data-testid="confirm-concepts"
                onClick={onConfirmConcepts}
                disabled={selectedCount === 0}
                className="w-full md:w-auto"
              >
                Write the story →
              </Button>
            </div>
            {selectedCount === 0 && <ErrorLine>Keep at least one concept.</ErrorLine>}
          </section>
        )}

        {/* World preview */}
        {state.campaign && (
          <section data-testid="world-preview" aria-label="Your world" className="mt-8 flex flex-col gap-3">
            <SectionLabel number="02" title="YOUR WORLD" />
            <p className="m-0 text-[17px] font-bold leading-snug text-gold">{state.campaign.title}</p>
            <p className="m-0 text-[15px] leading-normal text-muted">{state.campaign.premise}</p>
            <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0">
              {state.campaign.characters.map((c) => (
                <li key={c.character_id} className="font-mono text-[12px] text-muted">
                  <span className="text-cream">{c.name}</span> · {c.role}{" "}
                  <span>{Object.values(c.expressions)[0]}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Failure */}
        {failed && (
          <div className="mt-8 flex flex-col gap-4">
            <ErrorLine data-testid="generation-error">{state.error}</ErrorLine>
            <div className="flex flex-col gap-3 md:flex-row">
              <Button data-testid="generation-retry" onClick={onRetry} className="w-full md:w-auto">
                Try again
              </Button>
              <Button variant="outline" onClick={onBack} className="w-full md:w-auto">
                Back to edit
              </Button>
            </div>
          </div>
        )}

        {state.status === "running" && (
          <p className="m-0 mt-8 font-mono text-[11px] text-muted" aria-live="polite">
            This usually takes a few seconds per step.
          </p>
        )}
      </main>
    </div>
  );
}
