/**
 * useCampaign — React hook
 *
 * Manages campaign-level state across multiple stories.
 * Owns CampaignState and the active StoryBlueprint.
 * Delegates individual story navigation (HP, scenes) to useStoryPlayer.
 *
 * Milestone 6 additions:
 *   - onKnowledgeUpdate: merges per-concept knowledge updates into CampaignState.
 *     Called by StoryViewer when a learning scene is encountered or a puzzle
 *     answer is submitted.
 */

"use client";

import { useState, useCallback } from "react";
import type { CampaignBlueprint } from "@/lib/types/campaign";
import type { CampaignState, PlayerKnowledge } from "@/lib/types/game";
import type { StoryBlueprint } from "@/lib/types/story";
import {
  completeStory,
  isStoryUnlocked,
  isCampaignComplete as checkCampaignComplete,
  createInitialCampaignState,
} from "@/lib/game/campaign-manager";
import { mergeKnowledgeUpdates } from "@/lib/game/knowledge-manager";

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
   * No-op if the story is locked (sequence or knowledge prerequisites unmet).
   */
  onStartStory: (storyId: string) => void;
  /**
   * Merge one or more knowledge updates into the campaign state.
   * Called by StoryViewer when:
   *   - A learning_info content block is revealed (introduces a concept).
   *   - A puzzle answer is submitted (correct or incorrect).
   *
   * The caller is responsible for constructing the updated PlayerKnowledge objects
   * using functions from knowledge-manager.ts.
   *
   * Knowledge from CampaignState is NEVER reset by this hook — only updated upward.
   */
  onKnowledgeUpdate: (updates: Record<string, PlayerKnowledge>) => void;
};

/**
 * @param campaign      The CampaignBlueprint describing the story sequence.
 * @param stories       A lookup map from story_id → StoryBlueprint.
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

  const [isAtLobby, setIsAtLobby] = useState<boolean>(false);

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
    setIsAtLobby(true);
  }, []);

  const onStartStory = useCallback(
    (storyId: string) => {
      // Read the latest campaignState inside the callback via functional updater
      // to avoid stale closure issues.
      setCampaignState((prev) => {
        if (!isStoryUnlocked(storyId, campaign, prev)) return prev;
        const targetStory = stories.get(storyId);
        if (!targetStory) return prev;
        return { ...prev, current_story_id: storyId };
      });
      setIsAtLobby(false);
    },
    [campaign, stories]
  );

  const onKnowledgeUpdate = useCallback(
    (updates: Record<string, PlayerKnowledge>) => {
      setCampaignState((prev) => ({
        ...prev,
        player_knowledge: mergeKnowledgeUpdates(prev.player_knowledge, updates),
      }));
    },
    []
  );

  return {
    campaignState,
    activeStory,
    isCampaignComplete,
    isAtLobby,
    onStoryComplete,
    onExitStory,
    onStartStory,
    onKnowledgeUpdate,
  };
}
