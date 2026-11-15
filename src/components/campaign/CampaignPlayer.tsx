/**
 * CampaignPlayer
 *
 * Owns campaign-level state for one play session (via useCampaign) and
 * renders the CampaignLobby (between stories), the StoryViewer (while
 * playing), or the CampaignSummary (epilogue + evaluation, once complete).
 * Pages only supply the campaign data.
 */

"use client";

import { useEffect, useRef, useState } from "react";
import type { CampaignBlueprint } from "@/lib/types/campaign";
import type { MaterialBlueprint } from "@/lib/types/material";
import { buildLearningSummary } from "@/lib/game/learning-summary";
import { CampaignSummary } from "@/components/campaign/CampaignSummary";
import type { CampaignState } from "@/lib/types/game";
import type { StoryBlueprint } from "@/lib/types/story";
import { useCampaign } from "@/lib/campaign/use-campaign";
import { StoryViewer } from "@/components/story/StoryViewer";
import { CampaignLobby } from "@/components/campaign/CampaignLobby";

type CampaignPlayerProps = {
  campaign: CampaignBlueprint;
  /** Lookup map from story_id → StoryBlueprint. Must be a stable reference. */
  stories: ReadonlyMap<string, StoryBlueprint>;
  /** Optional state to resume from; a fresh state is created when omitted. */
  initialState?: CampaignState;
  /** Called whenever campaign progress changes (e.g. to save it). */
  onStateChange?: (state: CampaignState) => void;
  /** Starts at the campaign lobby instead of inside the current story. */
  startAtLobby?: boolean;
  /** Link shown in the lobby to leave the campaign (e.g. "/"). */
  homeHref?: string;
  /** Source materials; give the evaluation concept names and definitions. */
  materials?: MaterialBlueprint[];
};

export function CampaignPlayer({
  campaign,
  stories,
  initialState,
  onStateChange,
  startAtLobby = false,
  homeHref,
  materials,
}: CampaignPlayerProps) {
  const {
    campaignState,
    activeStory,
    isCampaignComplete,
    isAtLobby,
    onStoryComplete,
    onExitStory,
    onStartStory,
    onKnowledgeUpdate,
  } = useCampaign(campaign, stories, initialState, { startAtLobby });

  // Report progress changes; the latest callback is read from a ref so a new
  // function identity from the parent does not re-fire the effect.
  const onStateChangeRef = useRef(onStateChange);
  useEffect(() => {
    onStateChangeRef.current = onStateChange;
  });
  const isFirstState = useRef(true);
  useEffect(() => {
    if (isFirstState.current) {
      isFirstState.current = false;
      return; // the initial state is already what was loaded
    }
    onStateChangeRef.current?.(campaignState);
  }, [campaignState]);

  const [showResults, setShowResults] = useState(false);
  const viewResults = isCampaignComplete ? () => setShowResults(true) : undefined;

  if (showResults && isCampaignComplete) {
    return (
      <CampaignSummary
        summary={buildLearningSummary({ campaign, stories, state: campaignState, materials })}
        homeHref={homeHref}
        onBackToLobby={() => {
          setShowResults(false);
          onExitStory();
        }}
      />
    );
  }

  if (isAtLobby) {
    return (
      <div className="h-screen flex flex-col overflow-hidden">
        <CampaignLobby
          campaign={campaign}
          campaignState={campaignState}
          onStartStory={onStartStory}
          homeHref={homeHref}
          onViewResults={viewResults}
        />
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <StoryViewer
        // A new story must start from its own first scene with full HP.
        // StoryViewer keeps that per-story state internally, so remount it
        // whenever the active story changes.
        key={activeStory.story_id}
        story={activeStory}
        characters={campaign.characters}
        onStoryComplete={onStoryComplete}
        onExit={onExitStory}
        isCampaignComplete={isCampaignComplete}
        onViewResults={viewResults}
        onKnowledgeUpdate={onKnowledgeUpdate}
        playerKnowledge={campaignState.player_knowledge}
      />
    </div>
  );
}
