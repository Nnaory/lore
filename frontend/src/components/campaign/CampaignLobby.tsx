/**
 * CampaignLobby
 *
 * Shown when the player is between stories (after exiting or completing a story).
 * Lists stories in the campaign sequence with their lock/complete/available state
 * and lets the player start an available story. Flat Kit layout (Pola K): a
 * transparent column split by 1px smoke lines, so the animated backdrop shows
 * through. The Current row is inverted (cream fill, ink text).
 */

import Link from "next/link";
import type { CampaignBlueprint } from "@/lib/types/campaign";
import type { CampaignState } from "@/lib/types/game";
import { isStoryUnlocked } from "@/lib/game/campaign-manager";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/StatusBadge";

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
      className="mx-auto flex min-h-full w-full max-w-[680px] flex-col px-5 pb-12 md:px-0"
    >
      {/* Top row (44px) */}
      <div className="flex min-h-[44px] items-center justify-between">
        {homeHref ? (
          <Link
            href={homeHref}
            data-testid="lobby-home-link"
            className="inline-flex min-h-[44px] items-center gap-2 font-mono text-[12px] font-bold text-muted"
          >
            <Icon name="back" size={14} />
            All stories
          </Link>
        ) : (
          <span />
        )}
        <span className="font-mono text-[12px] font-bold tracking-[0.2em] text-cream">LORE</span>
      </div>

      <div className="mt-8 flex flex-col gap-2">
        <p className="font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-gold md:text-[12px]">
          Campaign
        </p>
        <h1 className="font-display text-[28px] font-bold leading-[1.15] text-cream md:text-[36px]" data-testid="campaign-title">
          {campaign.title}
        </h1>
      </div>

      <div aria-hidden="true" className="my-6 h-px w-full bg-smoke" />

      {onViewResults && (
        <Button variant="primary" data-testid="lobby-view-results" onClick={onViewResults} className="mb-6 w-full">
          Campaign complete — see your results →
        </Button>
      )}

      <div className="flex flex-col" data-testid="story-list" role="list" aria-label="Campaign stories">
        {campaign.story_sequence.map((entry, idx) => {
          const isCompleted = campaignState.completed_stories.includes(entry.story_id);
          const unlocked = isStoryUnlocked(entry.story_id, campaign, campaignState);
          const isCurrent = campaignState.current_story_id === entry.story_id && !isCompleted;

          let badgeText = "Locked";
          let variant: StatusBadgeVariant = "locked";
          if (isCompleted) {
            badgeText = "Completed";
            variant = "done";
          } else if (isCurrent) {
            badgeText = "Current";
            variant = "current";
          } else if (unlocked) {
            badgeText = "Available";
            variant = "available";
          }

          const rowClass = isCurrent ? "bg-cream text-ink" : "";
          const indexClass = isCurrent ? "text-ink" : "text-gold";
          const titleClass = isCurrent ? "text-ink" : unlocked ? "text-cream" : "text-muted";

          return (
            <div
              key={entry.story_id}
              data-testid={`story-entry-${entry.story_id}`}
              data-current={isCurrent || undefined}
              className={`border-b border-smoke px-0 py-4 ${isCurrent ? "px-4" : ""} ${rowClass}`}
              role="listitem"
            >
              <div className="flex items-start gap-3">
                <span className={`font-mono text-[12px] font-bold leading-[1.5] ${indexClass}`}>
                  {String(idx + 1).padStart(2, "0")}
                </span>
                <p className={`min-w-0 flex-1 text-[15px] font-bold leading-[1.4] ${titleClass}`}>{entry.title}</p>
                <StatusBadge variant={variant} data-testid={`story-badge-${entry.story_id}`}>
                  {badgeText}
                </StatusBadge>
              </div>

              {unlocked && !isCompleted && (
                <Button
                  variant="primary"
                  data-testid={`start-story-${entry.story_id}`}
                  onClick={() => onStartStory(entry.story_id)}
                  className="mt-4 w-full md:w-auto"
                >
                  {isCurrent ? "Continue" : "Start Story"}
                </Button>
              )}

              {!unlocked && !isCompleted && (
                <p className="mt-3 font-mono text-[12px] text-muted" aria-live="polite">
                  Complete previous stories to unlock
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
