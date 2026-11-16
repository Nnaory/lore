/**
 * GenerationScreen
 *
 * Shows the real pipeline stages while a story is built, the concept review
 * checkpoint (the player removes concepts that are wrong or irrelevant
 * before any story is written), a preview of the designed world, and a
 * retry that resumes from the stage that failed.
 */

"use client";

import { Check, Circle, LoaderCircle, TriangleAlert } from "lucide-react";
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

function StepIcon({ status }: { status: StepStatus }) {
  if (status === "done") return <Check size={16} aria-hidden="true" style={{ color: "var(--accent-gold)" }} />;
  if (status === "failed") return <TriangleAlert size={16} aria-hidden="true" style={{ color: "var(--danger)" }} />;
  if (status === "active")
    return <LoaderCircle size={16} aria-hidden="true" className="animate-spin" style={{ color: "var(--accent-gold-dim)" }} />;
  return <Circle size={8} aria-hidden="true" style={{ color: "var(--foreground-faint)", margin: "0 4px" }} />;
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
  const selectedCount = state.selectedConceptIds.length;

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10" data-testid="generation-screen">
      <main className="lore-glass lore-glass-panel rounded-card w-full max-w-xl p-6 sm:p-8 flex flex-col gap-8">
        <div className="text-center">
          <p className="text-xs tracking-[0.3em] uppercase mb-2" style={{ color: "var(--accent-gold-dim)" }}>
            Building your world
          </p>
          <p className="text-xs" style={{ color: "var(--foreground-faint)" }}>
            Read from your material: {sourceLabel}
          </p>
        </div>

        <ol className="flex flex-col gap-3" aria-label="Progress" data-testid="generation-steps">
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
                className="flex items-center gap-3 text-sm"
                style={{
                  color:
                    status === "pending" ? "var(--foreground-faint)" : status === "failed" ? "var(--danger)" : "var(--foreground)",
                }}
              >
                <span className="w-5 flex justify-center">
                  <StepIcon status={status} />
                </span>
                <span className="flex-1">{step.label}</span>
                {detail && (
                  <span className="text-xs truncate max-w-[45%]" style={{ color: "var(--foreground-faint)" }}>
                    {detail}
                  </span>
                )}
              </li>
            );
          })}
        </ol>

        {/* Concept review */}
        {reviewing && state.material && (
          <section
            data-testid="concept-review"
            aria-labelledby="concept-review-heading"
            className="lore-tile rounded-panel p-4 flex flex-col gap-3"
          >
            <div>
              <h2 id="concept-review-heading" className="text-sm font-medium" style={{ color: "var(--foreground)" }}>
                These are the concepts your story will teach
              </h2>
              <p className="text-xs mt-1" style={{ color: "var(--foreground-muted)" }}>
                Untick anything that is wrong or not worth learning. Each concept becomes one chapter.
              </p>
            </div>
            <ul className="flex flex-col">
              {state.material.concepts.map((concept) => {
                const checked = state.selectedConceptIds.includes(concept.concept_id);
                return (
                  <li key={concept.concept_id}>
                    <label
                      className="flex items-start gap-3 py-2.5 border-b cursor-pointer"
                      style={{ borderBottomColor: "var(--border-dim)", opacity: checked ? 1 : 0.5 }}
                    >
                      <input
                        type="checkbox"
                        data-testid={`concept-checkbox-${concept.concept_id}`}
                        checked={checked}
                        onChange={() => onToggleConcept(concept.concept_id)}
                        className="mt-1 accent-[var(--accent-gold)]"
                      />
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm" style={{ color: "var(--foreground)" }}>
                          {concept.name}
                        </span>
                        <span className="block text-xs leading-5" style={{ color: "var(--foreground-faint)" }}>
                          {concept.definition}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
            <div className="flex items-center justify-between gap-3 pt-1">
              <button type="button" onClick={onBack} className="text-xs underline underline-offset-2" style={{ color: "var(--foreground-muted)" }}>
                Back to edit
              </button>
              <button
                type="button"
                data-testid="confirm-concepts"
                onClick={onConfirmConcepts}
                disabled={selectedCount === 0}
                className="lore-pill lore-pill-lg lore-pill-primary"
              >
                Write the story →
              </button>
            </div>
            {selectedCount === 0 && (
              <p className="text-xs" style={{ color: "var(--danger)" }}>
                Keep at least one concept.
              </p>
            )}
          </section>
        )}

        {/* World preview */}
        {state.campaign && (
          <section
            data-testid="world-preview"
            aria-label="Your world"
            className="lore-tile rounded-panel p-4 flex flex-col gap-2 animate-fade-in-up"
          >
            <p className="text-base font-semibold tracking-wide" style={{ color: "var(--accent-gold)" }}>
              {state.campaign.title}
            </p>
            <p className="text-sm leading-6" style={{ color: "var(--foreground-muted)" }}>
              {state.campaign.premise}
            </p>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 pt-1">
              {state.campaign.characters.map((c) => (
                <li key={c.character_id} className="text-xs" style={{ color: "var(--foreground-faint)" }}>
                  <span style={{ color: "var(--foreground)" }}>{c.name}</span> · {c.role}{" "}
                  <span className="font-mono">{Object.values(c.expressions)[0]}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Failure */}
        {state.status === "failed" && (
          <div role="alert" data-testid="generation-error" className="flex flex-col items-center gap-3 text-center">
            <p className="text-sm" style={{ color: "var(--danger)" }}>
              {state.error}
            </p>
            <div className="flex gap-3">
              <button
                type="button"
                data-testid="generation-retry"
                onClick={onRetry}
                className="lore-pill lore-pill-primary"
              >
                Try again
              </button>
              <button type="button" onClick={onBack} className="lore-pill">
                Back to edit
              </button>
            </div>
          </div>
        )}

        {state.status === "running" && (
          <p className="text-xs text-center" style={{ color: "var(--foreground-faint)" }} aria-live="polite">
            This usually takes a few seconds per step.
          </p>
        )}
      </main>
    </div>
  );
}
