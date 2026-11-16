/**
 * CampaignSummary — epilogue and learning evaluation
 *
 * Shown when every story in the campaign is complete. Recaps how each story
 * ended, then evaluates each concept from the evidence the game recorded,
 * with a short recap for the concepts that still need practice.
 */

"use client";

import Link from "next/link";
import type { ConceptOutcome, LearningSummary } from "@/lib/game/learning-summary";

type CampaignSummaryProps = {
  summary: LearningSummary;
  onBackToLobby: () => void;
  homeHref?: string;
};

const OUTCOME: Record<ConceptOutcome, { label: string; detail: string; mark: string; color: string }> = {
  mastered: { label: "Mastered", detail: "Right on the first try", mark: "●", color: "#6fcf97" },
  developing: { label: "Developing", detail: "Right after a mistake", mark: "◐", color: "var(--accent-gold)" },
  practice: { label: "Needs practice", detail: "Not answered correctly yet", mark: "○", color: "var(--danger)" },
  unseen: { label: "Not tested", detail: "Taught, but never tested", mark: "·", color: "var(--foreground-faint)" },
};

export function CampaignSummary({ summary, onBackToLobby, homeHref }: CampaignSummaryProps) {
  const total = summary.concepts.length;
  const { mastered } = summary.counts;

  return (
    <div className="lore-bg min-h-screen overflow-y-auto" data-testid="campaign-summary">
      <main className="w-full max-w-2xl mx-auto px-5 py-14 flex flex-col gap-10">
        <header className="text-center flex flex-col gap-2">
          <p className="text-xs tracking-[0.3em] uppercase" style={{ color: "var(--accent-gold-dim)" }}>
            Epilogue
          </p>
          <h1 className="text-2xl font-semibold tracking-wide" style={{ color: "var(--foreground)" }}>
            {summary.campaign_title}
          </h1>
        </header>

        <section aria-label="How your story ended" className="flex flex-col gap-5">
          {summary.stories.map((story) => (
            <article key={story.story_id} data-testid={`epilogue-${story.story_id}`} className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold tracking-wide" style={{ color: "var(--accent-gold)" }}>
                {story.ending_title}
              </h2>
              {story.ending_narration.split("\n").filter(Boolean).map((paragraph, i) => (
                <p key={i} className="text-sm leading-7 italic" style={{ color: "var(--foreground-muted)" }}>
                  {paragraph}
                </p>
              ))}
            </article>
          ))}
        </section>

        <div className="lore-divider" />

        <section aria-labelledby="evaluation-heading" className="flex flex-col gap-4" data-testid="learning-evaluation">
          <div>
            <h2 id="evaluation-heading" className="text-xs tracking-[0.25em] uppercase" style={{ color: "var(--foreground)" }}>
              What you learned
            </h2>
            <p className="text-sm mt-2" style={{ color: "var(--foreground-muted)" }} data-testid="evaluation-headline">
              {total === 0
                ? "No concepts were tested in this campaign."
                : `You mastered ${mastered} of ${total} concept${total === 1 ? "" : "s"} on the first try.`}
            </p>
          </div>

          <ul className="flex flex-col gap-2">
            {summary.concepts.map((concept) => {
              const o = OUTCOME[concept.outcome];
              const needsRecap = concept.outcome === "developing" || concept.outcome === "practice";
              return (
                <li
                  key={concept.concept_id}
                  data-testid={`concept-result-${concept.concept_id}`}
                  data-outcome={concept.outcome}
                  className="rounded-lg p-3 flex flex-col gap-1.5"
                  style={{ backgroundColor: "var(--background-panel)", border: "1px solid var(--border-dim)" }}
                >
                  <div className="flex items-center gap-3">
                    <span aria-hidden="true" style={{ color: o.color }}>{o.mark}</span>
                    <span className="flex-1 text-sm" style={{ color: "var(--foreground)" }}>{concept.name}</span>
                    <span className="text-xs text-right" style={{ color: o.color }}>
                      {o.label}
                      <span className="block" style={{ color: "var(--foreground-faint)" }}>{o.detail}</span>
                    </span>
                  </div>
                  {needsRecap && concept.definition && (
                    <p className="text-xs leading-5 pl-6" style={{ color: "var(--foreground-muted)" }}>
                      <span style={{ color: "var(--foreground-faint)" }}>Recap: </span>
                      {concept.definition}
                    </p>
                  )}
                  {needsRecap && concept.watch_out && (
                    <p className="text-xs leading-5 pl-6" style={{ color: "var(--foreground-faint)" }}>
                      Watch out for: {concept.watch_out}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          {homeHref && (
            <Link
              href={homeHref}
              className="px-6 py-2.5 rounded text-sm font-medium text-center"
              style={{ backgroundColor: "var(--accent-gold)", color: "var(--background)" }}
            >
              Back to your stories
            </Link>
          )}
          <Link
            href="/create"
            className="px-6 py-2.5 rounded text-sm text-center"
            style={{ color: "var(--foreground-muted)", border: "1px solid var(--border)" }}
          >
            Create a new story
          </Link>
          <button
            type="button"
            onClick={onBackToLobby}
            className="px-6 py-2.5 rounded text-sm"
            style={{ color: "var(--foreground-faint)", border: "1px solid var(--border-dim)" }}
          >
            Campaign lobby
          </button>
        </div>
      </main>
    </div>
  );
}
