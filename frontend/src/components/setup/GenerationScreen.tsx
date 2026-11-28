/**
 * GenerationScreen ("Building your world")
 *
 * The screen while a story is built: Hazel stirs her cauldron (`WorldScene`) and tells the player
 * what she is doing, a side column lists the real pipeline stages and a log of what the run
 * produced, and the concept review (the player removes concepts that are wrong or irrelevant
 * before any story is written) happens in Hazel's dialogue box as a row of chips. A preview of the
 * designed world, the failure controls and a retry that resumes from the failed stage live in the
 * same box. Phone shows the scene and the dialogue only (the stage list and the log are for
 * desktop); the animation list stays on both.
 *
 * When the animation build flag is on (or a run already has an animating stage) a fifth step,
 * "Animating the lessons", follows the story step, and `AnimationProgress` lists the animation
 * jobs with skip and retry controls (design 7.5 UI). With the flag off nothing of that is drawn.
 *
 * Built only from Kit parts and token classes (frame of 1px smoke lines, the cream `lore-dialog`
 * box, ink chips): no radius, shadow, card or spinner. The surface is the opaque Kit grid
 * (`lore-grid-bg`), so the animated global pumpkin backdrop does not run behind the scene and the
 * text. The clock counts only while the run is working. All
 * behaviour and the data-testid values of the earlier screen are unchanged.
 */

"use client";

import type { ReactNode } from "react";
import { AnimationProgress } from "@/components/animation/AnimationProgress";
import { StepMarker, type StepMarkerStatus } from "@/components/setup/StepMarker";
import { WorldScene } from "@/components/setup/WorldScene";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { readAnimationsFlag } from "@/lib/animation/flags";
import type { GenerationStage, GenerationState } from "@/lib/generation/generation";
import { useGenerationClock } from "@/lib/generation/use-generation-clock";
import { buildLog, formatClock, hazelExpression, hazelLine, type LogTone } from "@/lib/generation/world-scene";

type GenerationScreenProps = {
  state: GenerationState;
  /** e.g. "notes.pdf · 3 pages": what was read from the document. */
  sourceLabel: string;
  /** Rest of the header line, e.g. "Fantasy · 3 chapters". */
  details?: string;
  onToggleConcept: (conceptId: string) => void;
  onConfirmConcepts: () => void;
  onRetry: () => void;
  onBack: () => void;
  /** Run the failed and skipped animations again. The page passes it; unused with the flag off. */
  onRetryAnimation?: () => void;
  /** Give up on the unfinished animations and continue. The page passes it; unused with the flag off. */
  onSkipAnimation?: () => void;
};

const STEPS: Array<{ stage: Exclude<GenerationStage, "done">; label: string }> = [
  { stage: "analyzing", label: "Finding the key concepts" },
  { stage: "reviewing", label: "Your review of the concepts" },
  { stage: "planning", label: "Designing the world and characters" },
  { stage: "writing", label: "Writing the story" },
  { stage: "animating", label: "Animating the lessons" },
];

const ORDER: Record<GenerationStage, number> = {
  analyzing: 0,
  reviewing: 1,
  planning: 2,
  writing: 3,
  animating: 4,
  done: 5,
};

type StepStatus = Extract<StepMarkerStatus, "done" | "active" | "failed" | "pending">;

function stepStatus(step: Exclude<GenerationStage, "done">, state: GenerationState): StepStatus {
  const current = ORDER[state.stage];
  const index = ORDER[step];
  if (index < current) return "done";
  if (index > current) return "pending";
  return state.status === "failed" ? "failed" : "active";
}

const LOG_TONE_CLASS: Record<LogTone, string> = {
  lore: "text-muted",
  add: "text-gold",
  warn: "text-ember",
};

/** The error pattern of the Kit (ember chip + text) drawn for the cream dialogue box. */
function BoxError({ children, "data-testid": testId }: { children: ReactNode; "data-testid"?: string }) {
  return (
    <p role="alert" data-testid={testId} className="m-0 flex items-start gap-2 font-mono text-[12px] leading-[1.5] text-ink md:text-[13px]">
      <span className="shrink-0 bg-ember px-1.5 py-[3px] text-[11px] font-bold leading-none text-ink">ERROR</span>
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
}

const INK_BUTTON =
  "inline-flex min-h-[44px] cursor-pointer items-center justify-center border-2 border-ink bg-transparent px-5 font-mono text-[14px] font-bold text-ink";

export function GenerationScreen({
  state,
  sourceLabel,
  details,
  onToggleConcept,
  onConfirmConcepts,
  onRetry,
  onBack,
  onRetryAnimation,
  onSkipAnimation,
}: GenerationScreenProps) {
  const reviewing = state.stage === "reviewing";
  const failed = state.status === "failed";
  const selectedCount = state.selectedConceptIds.length;
  const animating = state.stage === "animating";
  const running = state.status === "running";
  // The animating step exists only for a build with the flag on, or once a run has reached it.
  const steps = STEPS.filter((step) => step.stage !== "animating" || readAnimationsFlag() || state.animation !== null);
  const clock = useGenerationClock(state.stage, running);
  const log = buildLog(state);
  const words = state.material?.concepts.map((c) => c.name) ?? [];

  return (
    <div
      className="lore-grid-bg relative min-h-dvh font-display text-cream md:p-6"
      data-testid="generation-screen"
    >
      <main className="relative mx-auto flex min-h-dvh w-full max-w-[1296px] flex-col bg-transparent md:min-h-[calc(100dvh-48px)] md:border md:border-smoke">
        {/* Header: LORE, what is being built, the clock */}
        <header className="grid min-h-[58px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-smoke px-4 md:grid-cols-[1fr_auto_1fr] md:px-10">
          <div className="flex items-center gap-1">
            {reviewing || failed ? (
              <button
                type="button"
                onClick={onBack}
                aria-label="Back to edit"
                data-testid="generation-back"
                className="-ml-2 flex h-11 w-11 items-center justify-center text-cream"
              >
                <Icon name="back" size={20} />
              </button>
            ) : null}
            <span className="font-mono text-[13px] font-bold leading-[1.32] tracking-[0.4em] text-gold">LORE</span>
          </div>
          <div className="flex min-w-0 flex-col items-center gap-0.5 text-center">
            <span className="font-mono text-[11px] font-bold uppercase leading-[1.32] tracking-[0.24em] text-ember md:text-[12px]">
              Building your world
            </span>
            <p className="m-0 max-w-full truncate font-mono text-[11px] text-muted md:max-w-[520px] md:text-[12px]">
              {sourceLabel}
              {details ? ` · ${details}` : ""}
            </p>
          </div>
          <span
            data-testid="generation-clock"
            role="timer"
            aria-label="Time spent building"
            className="justify-self-end font-mono text-[13px] font-bold tabular-nums text-cream md:text-[14px]"
          >
            {formatClock(clock.total)}
          </span>
        </header>

        <div className="flex min-h-0 flex-1 flex-col md:grid md:grid-cols-[minmax(0,1fr)_380px]">
          {/* The scene */}
          <div className="relative min-h-[300px] flex-1 px-4 md:min-h-[440px] md:px-10">
            <WorldScene expression={hazelExpression(state)} words={words} />
          </div>

          {/* Stages, log and animations */}
          <aside className="flex flex-col gap-8 px-5 pb-2 md:border-l md:border-smoke md:px-8 md:py-8">
            <section className="hidden md:block" aria-label="Stages">
              <h2 className="m-0 font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-muted">Stages</h2>
              <ol className="m-0 mt-3 flex list-none flex-col p-0" aria-label="Progress" data-testid="generation-steps">
                {steps.map((step) => {
                  const status = stepStatus(step.stage, state);
                  let detail = "";
                  let detailClass = "text-muted";
                  if (step.stage === "analyzing" && state.material) detail = `${state.material.concepts.length} found`;
                  if (step.stage === "reviewing" && status === "done") detail = `${selectedCount} kept`;
                  if (step.stage === "planning" && state.campaign) detail = state.campaign.title;
                  if (status === "active" && state.status === "waiting") {
                    detail = "waiting for you";
                    detailClass = "text-gold";
                  } else if (status === "active" && running && detail === "") {
                    detail = formatClock(clock.stageSeconds);
                  }
                  return (
                    <li
                      key={step.stage}
                      data-testid={`step-${step.stage}`}
                      data-status={status}
                      className={`flex min-h-[46px] items-center gap-3 border-b border-smoke text-[15px] ${
                        status === "pending" ? "text-muted" : "text-cream"
                      } ${status === "active" ? "font-bold" : ""}`}
                    >
                      <StepMarker status={status} />
                      <span className="flex-1">{step.label}</span>
                      {detail && <span className={`max-w-[45%] truncate font-mono text-[12px] font-normal ${detailClass}`}>{detail}</span>}
                    </li>
                  );
                })}
              </ol>
            </section>

            <section className="hidden min-h-0 flex-col gap-3 md:flex" aria-label="Log">
              <h2 className="m-0 font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-muted">Log</h2>
              <ul
                data-testid="generation-log"
                className="m-0 flex max-h-[260px] list-none flex-col gap-0.5 overflow-hidden border border-smoke p-3 font-mono text-[12px] leading-[1.6]"
              >
                {log.map((line, i) => (
                  <li key={`${i}:${line.text}`} className={`truncate ${LOG_TONE_CLASS[line.tone]}`}>
                    {line.text}
                  </li>
                ))}
                <li aria-hidden="true" className="h-2 w-2 bg-ember" />
              </ul>
            </section>

            <AnimationProgress state={state} onRetry={onRetryAnimation} onSkip={onSkipAnimation} />
          </aside>
        </div>

        {/* Hazel's dialogue: what she is doing, the concept review, the world preview, failure */}
        <div className="px-4 pb-6 pt-7 md:px-16 md:pb-8">
          <section
            aria-label="Hazel"
            data-testid="hazel-dialogue"
            className="lore-dialog relative mx-auto w-full max-w-[1060px]"
          >
            <div className="lore-nametag absolute -top-4 left-3.5 flex h-[26px] items-center gap-2.5 px-2.5 md:-top-[18px] md:left-8 md:h-[30px] md:px-3">
              <span className="text-xs md:text-[13px]" style={{ color: "var(--color-cloth-hazel)" }}>
                HAZEL
              </span>
              <span className="hidden text-[11px] font-normal tracking-normal text-muted md:inline-block">
                Witch of the Ember Marsh
              </span>
            </div>

            <div className="flex max-h-[46dvh] flex-col gap-4 overflow-y-auto px-4 pb-5 pt-6 md:px-8 md:pt-7">
              <p data-testid="hazel-line" className="m-0 font-mono text-[13px] leading-[1.55] md:text-[17px] md:leading-[1.6]">
                {hazelLine(state)}
              </p>

              {/* Concept review */}
              {reviewing && state.material && (
                <section
                  data-testid="concept-review"
                  aria-labelledby="concept-review-heading"
                  className="flex flex-col gap-4"
                >
                  <h2 id="concept-review-heading" className="sr-only">
                    These are the concepts your story will teach
                  </h2>
                  <p className="m-0 font-mono text-[11px] leading-[1.5] text-ink-soft">
                    Untick anything that is wrong or not worth learning. Each concept becomes one chapter.
                  </p>
                  <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
                    {state.material.concepts.map((concept) => {
                      const checked = state.selectedConceptIds.includes(concept.concept_id);
                      return (
                        <li key={concept.concept_id}>
                          <label className="flex min-h-[44px] cursor-pointer" title={concept.definition}>
                            <input
                              type="checkbox"
                              data-testid={`concept-checkbox-${concept.concept_id}`}
                              checked={checked}
                              onChange={() => onToggleConcept(concept.concept_id)}
                              className="peer sr-only"
                            />
                            <span
                              className={`flex items-center gap-1.5 border-2 px-3 font-mono text-[12px] font-bold tracking-[0.04em] peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ember md:text-[13px] ${
                                checked ? "border-ink bg-ink text-cream" : "border-ink bg-transparent text-ink-soft"
                              }`}
                            >
                              {checked && <Icon name="check" size={12} />}
                              {concept.name}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                  <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <button type="button" onClick={onBack} className={`${INK_BUTTON} order-2 w-full md:order-1 md:w-auto`}>
                      Back to edit
                    </button>
                    <Button
                      data-testid="confirm-concepts"
                      onClick={onConfirmConcepts}
                      disabled={selectedCount === 0}
                      className="order-1 w-full md:order-2 md:w-auto"
                    >
                      {`Keep stirring · ${selectedCount} ${selectedCount === 1 ? "concept" : "concepts"} →`}
                    </Button>
                  </div>
                  {selectedCount === 0 && <BoxError>Keep at least one concept.</BoxError>}
                </section>
              )}

              {/* World preview */}
              {state.campaign && (
                <section data-testid="world-preview" aria-label="Your world" className="flex flex-col gap-1.5 border-t-2 border-ink pt-3">
                  <p className="m-0 font-display text-[17px] font-bold leading-snug text-ink">{state.campaign.title}</p>
                  <p className="m-0 font-mono text-[12px] leading-[1.5] text-ink-soft">{state.campaign.premise}</p>
                  <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0">
                    {state.campaign.characters.map((c) => (
                      <li key={c.character_id} className="font-mono text-[12px] text-ink-soft">
                        <span className="font-bold text-ink">{c.name}</span> · {c.role}{" "}
                        <span>{Object.values(c.expressions)[0]}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* Failure */}
              {failed && (
                <div className="flex flex-col gap-3">
                  <BoxError data-testid="generation-error">{state.error}</BoxError>
                  <div className="flex flex-col gap-3 md:flex-row">
                    <Button data-testid="generation-retry" onClick={onRetry} className="w-full md:w-auto">
                      Try again
                    </Button>
                    <button type="button" onClick={onBack} className={`${INK_BUTTON} w-full md:w-auto`}>
                      Back to edit
                    </button>
                  </div>
                </div>
              )}

              {running && !animating && (
                <p className="m-0 font-mono text-[11px] text-ink-soft" aria-live="polite">
                  This usually takes a few seconds per step.
                </p>
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
