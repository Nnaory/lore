/**
 * CampaignLobby
 *
 * Shown when the player is between stories (after exiting or completing a story).
 * Lists stories in the campaign sequence with their lock/complete/available state
 * and lets the player start an available story.
 * Minimalist gold/black theme.
 */

import type { CampaignBlueprint } from "@/lib/types/campaign";
import type { CampaignState } from "@/lib/types/game";
import { isStoryUnlocked } from "@/lib/game/campaign-manager";

type CampaignLobbyProps = {
  campaign: CampaignBlueprint;
  campaignState: CampaignState;
  onStartStory: (storyId: string) => void;
};

export function CampaignLobby({
  campaign,
  campaignState,
  onStartStory,
}: CampaignLobbyProps) {
  return (
    <div
      data-testid="campaign-lobby"
      className="lore-bg flex flex-col items-center justify-center min-h-full py-12 px-4"
    >
      <div className="w-full max-w-md">
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
              badgeStyle = { backgroundColor: "rgba(232, 197, 71, 0.1)", color: "var(--accent-gold)", borderColor: "var(--accent-gold)" };
            } else if (unlocked) {
              badgeText = "Available";
              badgeStyle = { backgroundColor: "transparent", color: "var(--foreground-muted)", borderColor: "var(--border)" };
            }

            return (
              <div
                key={entry.story_id}
                data-testid={`story-entry-${entry.story_id}`}
                className="relative overflow-hidden"
                style={{
                  backgroundColor: "var(--background-panel)",
                  border: "1px solid var(--border-dim)",
                  borderRadius: "0.5rem",
                  borderLeftWidth: isCurrent ? "3px" : "1px",
                  borderLeftColor: isCurrent ? "var(--accent-gold)" : "var(--border-dim)",
                }}
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
                      className="mt-3 w-full px-4 py-2 rounded text-xs font-medium tracking-wide transition-all"
                      style={{ backgroundColor: "var(--accent-gold)", color: "var(--background)" }}
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