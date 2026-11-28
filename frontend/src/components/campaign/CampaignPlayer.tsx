/**
 * CampaignPlayer — branch selector for a campaign play session (design 6.5)
 *
 * Why: owns campaign-level state for one play session (via useCampaign) and
 * renders one of three branches without adding chrome of its own:
 *   - CampaignSummary (epilogue + learning evaluation, once complete)
 *   - CampaignLobby (between stories)
 *   - StoryViewer (the Stage inside ScaledBoard, keyed by story_id so a story
 *     change remounts per-story state)
 * Lobby and summary sit in a scrolling `min-h-dvh` wrapper with `.lore-grid-lines`
 * (transparent fill so the root layout's animated PumpkinBackdrop stays visible).
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
  const [playRunKey, setPlayRunKey] = useState(0);
  const viewResults = isCampaignComplete ? () => setShowResults(true) : undefined;

  function handleStartStory(storyId: string) {
    setPlayRunKey((k) => k + 1);
    onStartStory(storyId);
  }

  function handleReplayCampaign() {
    const firstStory = campaign.story_sequence[0];
    if (!firstStory) return;
    setPlayRunKey((k) => k + 1);
    setShowResults(false);
    onStartStory(firstStory.story_id);
  }

  if (showResults && isCampaignComplete) {
    return (
      <div className="lore-grid-lines min-h-dvh overflow-y-auto">
        <CampaignSummary
          summary={buildLearningSummary({ campaign, stories, state: campaignState, materials })}
          homeHref={homeHref}
          onBackToLobby={() => {
            setShowResults(false);
            onExitStory();
          }}
          onReplayCampaign={handleReplayCampaign}
        />
      </div>
    );
  }

  if (isAtLobby) {
    return (
      <div className="lore-grid-lines min-h-dvh overflow-y-auto">
        <CampaignLobby
          campaign={campaign}
          campaignState={campaignState}
          onStartStory={handleStartStory}
          homeHref={homeHref}
          onViewResults={viewResults}
        />
      </div>
    );
  }

  return (
    <StoryViewer
      // A new story or replay must start from its own first scene with full HP.
      // StoryViewer keeps that per-story state internally, so remount it
      // whenever the active story or replay run changes.
      key={`${activeStory.story_id}:${playRunKey}`}
      story={activeStory}
      characters={campaign.characters}
      campaign={campaign}
      materials={materials}
      genre={campaign.genre}
      onStoryComplete={onStoryComplete}
      onExit={onExitStory}
      isCampaignComplete={isCampaignComplete}
      onViewResults={viewResults}
      onReplay={() => handleStartStory(activeStory.story_id)}
      onKnowledgeUpdate={onKnowledgeUpdate}
      playerKnowledge={campaignState.player_knowledge}
    />
  );
}
