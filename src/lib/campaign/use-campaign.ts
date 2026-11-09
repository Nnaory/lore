/**
 * useCampaign — React hook
 *
 * Manages campaign-level state across multiple stories.
 * Owns CampaignState and the active StoryBlueprint.
 * Delegates individual story navigation (HP, scenes) to useStoryPlayer.
 *
 * Responsibilities:
 *   - Holding the current CampaignState.
 *   - Providing the active StoryBlueprint.
 *   - Handling story completion: updating CampaignState, unlocking next story.
 *   - Handling story exit: preserving CampaignState without marking completion.
 *   - Exposing campaign-level flags (isCampaignComplete).
 *
 * Out of scope (deferred to later milestones):
 *   - Persistence / serialization.
 *   - AI generation.
 *   - Knowledge mastery tracking.
 */

"use client";

import { useState, useCallback } from "react";
import type { CampaignBlueprint } from "@/lib/types/campaign";
import type { CampaignState } from "@/lib/types/game";
import type { StoryBlueprint } from "@/lib/types/story";
import {
  completeStory,
  isStoryUnlocked,
  isCampaignComplete as checkCampaignComplete,
  createInitialCampaignState,
} from "@/lib/game/campaign-manager";

export type UseCampaignReturn = {
  /** Current campaign state. */
  campaignState: CampaignState;
  /** The StoryBlueprint currently being played. */
  activeStory: StoryBlueprint;
  /** True when all stories in the sequence are completed. */
  isCampaignComplete: boolean;
  /** True when the player has exited to the campaign lobby. */
  isAtLobby: boolean;
  /**
   * Called when the story ending is reached (isComplete = true in useStoryPlayer).
   * Records the story as completed, applies world/relationship changes from the
   * ending, and advances to the next story.
   *
   * @param worldStateChanges  Changes from the story's ending (optional).
   * @param relationshipChanges Changes from the story's ending (optional).
   */
  onStoryComplete: (opts?: {
    worldStateChanges?: Record<string, number>;
    relationshipChanges?: Record<string, number>;
    outcomeDescription?: string;
  }) => void;
  /**
   * Called when the player exits mid-story.
   * Does NOT mark the story complete.
   * Returns the player to the campaign lobby.
   */
  onExitStory: () => void;
  /**
   * Called from the campaign lobby to start a specific story.
   * No-op if the story is locked.
   */
  onStartStory: (storyId: string) => void;
};

/**
 * @param campaign  The CampaignBlueprint describing the story sequence.
 * @param stories   A lookup map from story_id → StoryBlueprint.
 * @param initialState  Optional: an existing CampaignState to resume from.
 *   If omitted, a fresh state is created from the campaign blueprint.
 */
export function useCampaign(
  campaign: CampaignBlueprint,
  stories: ReadonlyMap<string, StoryBlueprint>,
  initialState?: CampaignState
): UseCampaignReturn {
  const [campaignState, setCampaignState] = useState<CampaignState>(
    () => initialState ?? createInitialCampaignState(campaign)
  );

  // When isAtLobby is true, the player is not actively playing any story.
  const [isAtLobby, setIsAtLobby] = useState<boolean>(false);

  // Resolve the active story from the map, falling back gracefully.
  const activeStory =
    stories.get(campaignState.current_story_id) ??
    stories.get(campaign.story_sequence[0]?.story_id ?? "") ??
    [...stories.values()][0];

  if (!activeStory) {
    throw new Error(
      `useCampaign: no story found for campaign "${campaign.campaign_id}".`
    );
  }

  const isCampaignComplete = checkCampaignComplete(campaign, campaignState);

  const onStoryComplete = useCallback(
    (
      opts: {
        worldStateChanges?: Record<string, number>;
        relationshipChanges?: Record<string, number>;
        outcomeDescription?: string;
      } = {}
    ) => {
      setCampaignState((prev) =>
        completeStory(prev, campaign, activeStory, opts)
      );
    },
    [campaign, activeStory]
  );

  const onExitStory = useCallback(() => {
    // Campaign state is NOT modified — exit does not count as completion.
    setIsAtLobby(true);
  }, []);

  const onStartStory = useCallback(
    (storyId: string) => {
      if (!isStoryUnlocked(storyId, campaign, campaignState)) return;
      const targetStory = stories.get(storyId);
      if (!targetStory) return;

      setCampaignState((prev) => ({ ...prev, current_story_id: storyId }));
      setIsAtLobby(false);
    },
    [campaign, campaignState, stories]
  );

  return {
    campaignState,
    activeStory,
    isCampaignComplete,
    isAtLobby,
    onStoryComplete,
    onExitStory,
    onStartStory,
  };
}
