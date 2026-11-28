/**
 * CampaignSummary — epilogue and learning evaluation (Pola K, design 6.6)
 *
 * Why: shown when every story in the campaign is complete. Recaps how each
 * story ended, then evaluates each concept from the evidence the game recorded,
 * with a short recap for the concepts that still need practice. Built from Kit
 * components (Button, SectionLabel) and token classes only — transparent column
 * so the root layout's animated PumpkinBackdrop remains visible.
 */

"use client";

import { Button } from "@/components/ui/Button";
import { SectionLabel } from "@/components/ui/SectionLabel";
import type { ConceptOutcome, LearningSummary } from "@/lib/game/learning-summary";

type CampaignSummaryProps = {
  summary: LearningSummary;
  onBackToLobby: () => void;
  homeHref?: string;
  onReplayCampaign?: () => void;
};

const OUTCOME: Record<
  ConceptOutcome,
  { label: string; detail: string; mark: string; colorClass: string }
> = {
  mastered: {
    label: "Mastered",
    detail: "Right on the first try",
    mark: "●",
    colorClass: "text-gold",
  },
  developing: {
    label: "Developing",
    detail: "Right after a mistake",
    mark: "◐",
    colorClass: "text-cream",
  },
  practice: {
    label: "Needs practice",
    detail: "Not answered correctly yet",
    mark: "○",
    colorClass: "text-ember",
  },
  unseen: {
    label: "Not tested",
    detail: "Taught, but never tested",
    mark: "·",
    colorClass: "text-muted",
  },
};

export function CampaignSummary({ summary, onBackToLobby, homeHref, onReplayCampaign }: CampaignSummaryProps) {
  const total = summary.concepts.length;
  const { mastered } = summary.counts;

  return (
    <div
      data-testid="campaign-summary"
      className="mx-auto flex min-h-full w-full max-w-[680px] flex-col px-5 pb-12 md:px-0"
    >
      {/* Top row (44px desktop, 56px phone) */}
      <div className="flex min-h-[56px] items-center justify-between md:min-h-[44px]">
        <span aria-hidden="true" />
        <span className="font-mono text-[13px] font-bold tracking-[0.4em] text-gold">LORE</span>
      </div>

      <header className="mt-8 flex flex-col gap-2">
        <p className="font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-ember md:text-[12px]">
          Epilogue
        </p>
        <h1 className="font-display text-[28px] font-bold leading-[1.15] text-cream md:text-[36px]">
          {summary.campaign_title}
        </h1>
      </header>

      <section aria-label="How your story ended" className="mt-6 flex flex-col gap-5">
        {summary.stories.map((story) => (
          <article
            key={story.story_id}
            data-testid={`epilogue-${story.story_id}`}
            className="flex flex-col gap-2"
          >
            <h2 className="font-display text-[17px] font-bold leading-snug text-gold">
              {story.ending_title}
            </h2>
            {story.ending_narration
              .split("\n")
              .filter(Boolean)
              .map((paragraph, i) => (
                <p key={i} className="text-[14px] leading-[1.5] text-muted md:text-[15px]">
                  {paragraph}
                </p>
              ))}
          </article>
        ))}
      </section>

      <div aria-hidden="true" className="my-6 h-px w-full bg-smoke" />

      <section
        aria-label="What you learned"
        className="flex flex-col gap-4"
        data-testid="learning-evaluation"
      >
        <div className="flex flex-col gap-2">
          <SectionLabel number="01" title="WHAT YOU LEARNED" />
          <p
            className="text-[14px] leading-[1.5] text-muted md:text-[15px]"
            data-testid="evaluation-headline"
          >
            {total === 0
              ? "No concepts were tested in this campaign."
              : `You mastered ${mastered} of ${total} concept${total === 1 ? "" : "s"} on the first try.`}
          </p>
        </div>

        <ul className="m-0 flex list-none flex-col p-0">
          {summary.concepts.map((concept) => {
            const o = OUTCOME[concept.outcome];
            const needsRecap = concept.outcome === "developing" || concept.outcome === "practice";
            return (
              <li
                key={concept.concept_id}
                data-testid={`concept-result-${concept.concept_id}`}
                data-outcome={concept.outcome}
                className="flex flex-col gap-1.5 border-b border-smoke py-3.5"
              >
                <div className="flex items-start gap-3">
                  <span
                    aria-hidden="true"
                    className={`font-mono text-[14px] leading-[1.4] ${o.colorClass}`}
                  >
                    {o.mark}
                  </span>
                  <span className="min-w-0 flex-1 text-[15px] font-bold leading-[1.4] text-cream">
                    {concept.name}
                  </span>
                  <span className={`text-right font-mono text-[12px] font-bold ${o.colorClass}`}>
                    {o.label}
                    <span className="block font-mono text-[11px] font-normal text-muted">
                      {o.detail}
                    </span>
                  </span>
                </div>
                {needsRecap && concept.definition && (
                  <p className="pl-6 font-mono text-[12px] leading-[1.5] text-muted">
                    <span>Recap: </span>
                    {concept.definition}
                  </p>
                )}
                {needsRecap && concept.watch_out && (
                  <p className="pl-6 font-mono text-[12px] leading-[1.5] text-muted">
                    Watch out for: {concept.watch_out}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <div className="mt-8 flex flex-col gap-3 md:flex-row">
        {homeHref && (
          <Button variant="primary" href={homeHref} className="w-full md:w-auto">
            Back to your stories
          </Button>
        )}
        {onReplayCampaign && (
          <Button
            variant="outline"
            data-testid="summary-replay-button"
            onClick={onReplayCampaign}
            className="w-full md:w-auto"
          >
            Replay Campaign
          </Button>
        )}
        <Button variant="outline" href="/create" className="w-full md:w-auto">
          Create a new story
        </Button>
        <Button variant="outline" onClick={onBackToLobby} className="w-full md:w-auto">
          Campaign lobby
        </Button>
      </div>
    </div>
  );
}
