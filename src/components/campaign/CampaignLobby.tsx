/**
 * CampaignLobby
 *
 * Shown when the player is between stories (after exiting or completing a story).
 * Lists stories in the campaign sequence with their lock/complete/available state
 * and lets the player start an available story.
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
      className="lore-bg flex flex-col items-center justify-center min-h-full py-12 px-8"
    >
      <div className="w-full max-w-sm flex flex-col gap-6">
        {/* Campaign title */}
        <div className="text-center">
          <p
            className="text-xs tracking-widest uppercase mb-1"
            style={{ color: "var(--foreground-faint)" }}
          >
            Campaign
          </p>
          <h1
            className="text-xl font-semibold tracking-wide"
            style={{ color: "var(--foreground)" }}
            data-testid="campaign-title"
          >
            {campaign.title}
          </h1>
        </div>

        <div className="lore-divider" />

        {/* Story list */}
        <div className="flex flex-col gap-3" data-testid="story-list">
          {campaign.story_sequence.map((entry, idx) => {
            const isCompleted = campaignState.completed_stories.includes(
              entry.story_id
            );
            const unlocked = isStoryUnlocked(
              entry.story_id,
              campaign,
              campaignState
            );
            const isCurrent =
              campaignState.current_story_id === entry.story_id && !isCompleted;

            let badgeText = "Locked";
            let badgeStyle: React.CSSProperties = {
              color: "var(--foreground-faint)",
              borderColor: "var(--border-subtle)",
            };
            if (isCompleted) {
              badgeText = "Completed";
              badgeStyle = { color: "#6fcf97", borderColor: "#2d6a4a" };
            } else if (isCurrent) {
              badgeText = "Current";
              badgeStyle = {
                color: "var(--accent-gold)",
                borderColor: "var(--accent-gold)",
              };
            } else if (unlocked) {
              badgeText = "Available";
              badgeStyle = {
                color: "var(--foreground-muted)",
                borderColor: "var(--border)",
              };
            }

            return (
              <div
                key={entry.story_id}
                data-testid={`story-entry-${entry.story_id}`}
                className="rounded-lg p-4"
                style={{
                  backgroundColor: "var(--background-panel)",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: isCurrent
                    ? "var(--accent)"
                    : "var(--border-subtle)",
                }}
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <span
                    className="text-xs font-mono"
                    style={{ color: "var(--foreground-faint)" }}
                  >
                    {String(idx + 1).padStart(2, "0")}
                  </span>
                  <span
                    className="text-xs px-2 py-0.5 rounded-full"
                    style={{
                      borderWidth: "1px",
                      borderStyle: "solid",
                      ...badgeStyle,
                    }}
                    data-testid={`story-badge-${entry.story_id}`}
                  >
                    {badgeText}
                  </span>
                </div>

                <p
                  className="text-sm font-medium mb-1"
                  style={{
                    color: unlocked
                      ? "var(--foreground)"
                      : "var(--foreground-faint)",
                  }}
                >
                  {entry.title}
                </p>

                {unlocked && !isCompleted && (
                  <button
                    data-testid={`start-story-${entry.story_id}`}
                    onClick={() => onStartStory(entry.story_id)}
                    className="mt-3 w-full px-4 py-2 rounded text-xs font-medium tracking-wide transition-opacity hover:opacity-80 active:opacity-60"
                    style={{
                      backgroundColor: "var(--accent)",
                      color: "var(--foreground)",
                    }}
                  >
                    {isCurrent ? "Continue" : "Start Story"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
