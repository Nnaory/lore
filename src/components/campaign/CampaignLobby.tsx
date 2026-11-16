/**
 * CampaignLobby
 *
 * Shown when the player is between stories (after exiting or completing a story).
 * Lists stories in the campaign sequence with their lock/complete/available state
 * and lets the player start an available story.
 * A glass card over the pumpkin night.
 */

import Link from "next/link";
import type { CampaignBlueprint } from "@/lib/types/campaign";
import type { CampaignState } from "@/lib/types/game";
import { isStoryUnlocked } from "@/lib/game/campaign-manager";

type CampaignLobbyProps = {
  campaign: CampaignBlueprint;
  campaignState: CampaignState;
  onStartStory: (storyId: string) => void;
  /** When set, shows a link back to this page (e.g. the saved-stories list). */
  homeHref?: string;
  /** When set (campaign complete), shows a button to the epilogue and results. */
  onViewResults?: () => void;
};

export function CampaignLobby({
  campaign,
  campaignState,
  onStartStory,
  homeHref,
  onViewResults,
}: CampaignLobbyProps) {
  return (
    <div
      data-testid="campaign-lobby"
      className="flex flex-col items-center justify-center min-h-full py-12 px-4"
    >
      <div className="lore-glass lore-glass-panel rounded-card w-full max-w-md p-6 sm:p-8">
        {homeHref && (
          <Link
            href={homeHref}
            data-testid="lobby-home-link"
            className="inline-block mb-6 text-xs tracking-wide"
            style={{ color: "var(--foreground-muted)" }}
          >
            ← All stories
          </Link>
        )}
        {/* Campaign title */}
        <div className="text-center mb-8">
          <p className="text-xs tracking-widest uppercase mb-2" style={{ color: "var(--foreground-faint)" }}>
            Campaign
          </p>
          <h1 className="text-2xl font-semibold tracking-wide" style={{ color: "var(--foreground)" }} data-testid="campaign-title">
            {campaign.title}
          </h1>
        </div>

        <div className="lore-divider mb-8" />

        {onViewResults && (
          <button
            type="button"
            data-testid="lobby-view-results"
            onClick={onViewResults}
            className="lore-pill lore-pill-primary w-full mb-6"
          >
            Campaign complete — see your results →
          </button>
        )}

        {/* Story list */}
        <div className="flex flex-col gap-4" data-testid="story-list" role="list" aria-label="Campaign stories">
          {campaign.story_sequence.map((entry, idx) => {
            const isCompleted = campaignState.completed_stories.includes(entry.story_id);
            const unlocked = isStoryUnlocked(entry.story_id, campaign, campaignState);
            const isCurrent = campaignState.current_story_id === entry.story_id && !isCompleted;

            let badgeText = "Locked";
            let badgeStyle: React.CSSProperties = {
              backgroundColor: "transparent",
              color: "var(--foreground-faint)",
              borderColor: "var(--border-dim)",
            };
            if (isCompleted) {
              badgeText = "Completed";
              badgeStyle = { backgroundColor: "rgba(111, 207, 151, 0.1)", color: "#6fcf97", borderColor: "#2d6a4a" };
            } else if (isCurrent) {
              badgeText = "Current";
              badgeStyle = { backgroundColor: "rgba(246, 200, 78, 0.1)", color: "var(--accent-gold)", borderColor: "var(--accent-gold)" };
            } else if (unlocked) {
              badgeText = "Available";
              badgeStyle = { backgroundColor: "transparent", color: "var(--foreground-muted)", borderColor: "var(--border)" };
            }

            return (
              <div
                key={entry.story_id}
                data-testid={`story-entry-${entry.story_id}`}
                className="lore-tile rounded-panel relative overflow-hidden"
                style={isCurrent ? { borderLeftWidth: "3px", borderLeftColor: "var(--accent-gold)" } : undefined}
                role="listitem"
              >
                <div className="p-4">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <span className="text-xs font-mono" style={{ color: "var(--foreground-faint)" }}>
                      {String(idx + 1).padStart(2, "0")}
                    </span>
                    <span
                      className="text-xs px-2 py-0.5 rounded-full"
                      style={{ borderWidth: "1px", borderStyle: "solid", ...badgeStyle }}
                      data-testid={`story-badge-${entry.story_id}`}
                    >
                      {badgeText}
                    </span>
                  </div>

                  <p className="text-sm font-medium mb-1" style={{ color: unlocked ? "var(--foreground)" : "var(--foreground-faint)" }}>
                    {entry.title}
                  </p>

                  {unlocked && !isCompleted && (
                    <button
                      data-testid={`start-story-${entry.story_id}`}
                      onClick={() => onStartStory(entry.story_id)}
                      className="lore-pill lore-pill-sm lore-pill-primary mt-3 w-full"
                    >
                      {isCurrent ? "Continue" : "Start Story"}
                    </button>
                  )}

                  {!unlocked && !isCompleted && (
                    <p className="mt-3 text-xs" style={{ color: "var(--foreground-faint)" }} aria-live="polite">
                      Complete previous stories to unlock
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}