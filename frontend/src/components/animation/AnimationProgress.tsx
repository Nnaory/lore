/**
 * AnimationProgress: the animating stage on the generation screen (design 7.5 UI, Requirement 24.4,
 * 24.6, 24.7, 24.11, 24.13).
 *
 * Shows `k / n` (jobs that are ready, failed or skipped), one row per job (title, status square,
 * and a second line with the stage and attempt, "Ready", "Skipped" or the failure message), and
 * the two controls: `animation-skip` while jobs run or wait, `animation-retry` only while the flow
 * waits for the player. While it waits (a failed or skipped job is left and `onDone` is held) the
 * notice says so and names both choices, so the held state is never a silent stall.
 *
 * Draws only. What each row says and which control exists come from `buildAnimationProgressView`
 * (lib/generation/animation-progress.ts); the clicks go to `retryAnimation` and `skipAnimation` of
 * `useGeneration`. Kit parts and token classes only: a `SectionLabel`, 1px smoke row rules, the
 * shared `StepMarker` and `Button`; no card, radius, shadow or new colour. The surface stays
 * transparent so the animated backdrop shows. Controls are 44px or more and full width on phone.
 *
 * Returns nothing when the run has no animating stage, so a run with the flag off is unchanged.
 */

"use client";

import { StepMarker } from "@/components/setup/StepMarker";
import { Button } from "@/components/ui/Button";
import { SectionLabel } from "@/components/ui/SectionLabel";
import { buildAnimationProgressView } from "@/lib/generation/animation-progress";
import type { GenerationState } from "@/lib/generation/generation";

export type AnimationProgressProps = {
  state: Pick<GenerationState, "stage" | "status" | "animation">;
  /** Run the failed and skipped jobs again. Without it the retry control is not drawn. */
  onRetry?: () => void;
  /** Give up on the unfinished jobs. Without it the skip control is not drawn. */
  onSkip?: () => void;
};

export function AnimationProgress({ state, onRetry, onSkip }: AnimationProgressProps) {
  const view = buildAnimationProgressView(state);
  if (view === null) return null;

  const showRetry = view.showRetry && onRetry !== undefined;
  const showSkip = view.showSkip && onSkip !== undefined;

  return (
    <section
      data-testid="animation-progress"
      data-mode={view.mode}
      aria-label="Lesson animations"
      className="mt-8 flex flex-col gap-3"
    >
      <SectionLabel number="03" title="ANIMATIONS" />

      <div aria-live="polite" className="flex flex-col gap-2">
        <p className="m-0 font-mono text-[12px] text-muted" data-testid="animation-count">
          {view.settled} / {view.total}
        </p>
        {view.notice !== null && (
          <p className="m-0 font-mono text-[12px] leading-[1.5] text-cream md:text-[13px]" data-testid="animation-notice">
            <span className="font-bold text-gold">{view.noticeLead}.</span> {view.notice}
          </p>
        )}
      </div>

      <ul className="m-0 flex list-none flex-col p-0" aria-label="Animations">
        {view.rows.map((row) => (
          <li
            key={row.id}
            data-testid={`animation-job-${row.id}`}
            data-status={row.status}
            className="flex min-h-[44px] items-start gap-3 border-b border-smoke py-2.5 font-mono"
          >
            <span className="mt-[3px] flex">
              <StepMarker status={row.marker} />
            </span>
            <span className="min-w-0 flex-1">
              <span
                className={`line-clamp-2 block break-words text-[13px] leading-[1.4] ${
                  row.status === "pending" ? "text-muted" : "text-cream"
                }`}
              >
                {row.title}
              </span>
              <span
                data-testid={`animation-job-detail-${row.id}`}
                className={`block break-words text-[12px] leading-[1.5] ${
                  row.status === "failed" ? "text-cream" : "text-muted"
                }`}
              >
                {row.detail}
              </span>
            </span>
          </li>
        ))}
      </ul>

      {view.mode === "running" && (
        <p className="m-0 font-mono text-[11px] text-muted" data-testid="animation-hint">
          Each animation can take a few minutes. Skip to open the story now: animations that are not finished use
          the standard drawings.
        </p>
      )}

      {(showRetry || showSkip) && (
        <div className="flex flex-col gap-3 md:flex-row">
          {showRetry && (
            <Button data-testid="animation-retry" onClick={onRetry} className="w-full md:w-auto">
              Try again
            </Button>
          )}
          {showSkip && (
            <Button
              variant="outline"
              data-testid="animation-skip"
              onClick={onSkip}
              disabled={view.skipDisabled}
              className="w-full md:w-auto"
            >
              {view.skipLabel}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
