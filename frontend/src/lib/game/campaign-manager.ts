/**
 * Campaign Manager
 *
 * Pure, deterministic logic for campaign-level state transitions.
 * No React, no side effects — all functions take state and return new state.
 *
 * Responsibilities:
 *   - Building initial campaign state.
 *   - Completing a story (adding to completed_stories, updating world/relationships,
 *     advancing current_story_id, recording a summary).
 *   - Determining which stories are unlocked.
 *   - Validating that a story may be started.
 *
 * Rules (from DOCS.md §9–10):
 *   - Completing a story → add to completed_stories, advance current_story_id.
 *   - Next story = next entry in story_sequence after the completed one.
 *   - A story is unlocked if every story before it in the sequence is completed.
 *   - Failure / exit → no campaign change.
 *   - Retry → no campaign change.
 *   - Duplicate completion is silently ignored.
 */

import type { CampaignBlueprint, StorySummaryEntry } from "@/lib/types/campaign";
import type { CampaignState, PreviousStorySummary } from "@/lib/types/game";
import type { StoryBlueprint } from "@/lib/types/story";
import { meetsKnowledgeRequirements } from "@/lib/game/knowledge-manager";

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

/**
 * Build the initial CampaignState for a campaign that has not yet started.
 * The first story in the sequence is set as current and is immediately unlocked.
 */
export function createInitialCampaignState(
  campaign: CampaignBlueprint
): CampaignState {
  const firstStory = campaign.story_sequence[0];
  if (!firstStory) {
    throw new Error(
      `Campaign "${campaign.campaign_id}" has no stories in story_sequence.`
    );
  }
  return {
    campaign_id: campaign.campaign_id,
    current_story_id: firstStory.story_id,
    completed_stories: [],
    world_state: {},
    relationships: {},
    major_decisions: [],
    player_knowledge: {},
    previous_story_summaries: [],
  };
}

// ---------------------------------------------------------------------------
// Unlock / access check
// ---------------------------------------------------------------------------

/**
 * Returns true if the given story_id may be started.
 *
 * A story is unlocked when ALL of the following are true:
 *   1. Every story that appears before it in story_sequence has been completed.
 *   2. All concept IDs in the story's `required_knowledge` array have been
 *      `demonstrated` in the player's knowledge map.
 *
 * The first story is always unlocked (no preceding stories, no prerequisites).
 *
 * Rule reference:
 *   - Sequence rule: DOCS.md §6, §9–10.
 *   - Knowledge rule: DOCS.md §11 + knowledge-manager.ts REQUIRED_KNOWLEDGE_THRESHOLD.
 *   - AND logic: all prerequisites must be satisfied simultaneously.
 */
export function isStoryUnlocked(
  storyId: string,
  campaign: CampaignBlueprint,
  campaignState: CampaignState
): boolean {
  const idx = campaign.story_sequence.findIndex((s) => s.story_id === storyId);
  if (idx === -1) return false; // story not in this campaign
  if (idx === 0) return true;   // first story always unlocked

  const entry = campaign.story_sequence[idx];

  // Rule 1: every preceding story must be completed
  const preceding = campaign.story_sequence.slice(0, idx);
  const sequenceOk = preceding.every((s) =>
    campaignState.completed_stories.includes(s.story_id)
  );
  if (!sequenceOk) return false;

  // Rule 2: all required concepts must be demonstrated
  const knowledgeOk = meetsKnowledgeRequirements(
    entry.required_knowledge,
    campaignState.player_knowledge
  );
  return knowledgeOk;
}

/**
 * Returns the next unlocked-but-not-yet-started story entry,
 * or null if the campaign is fully complete.
 */
export function getNextStoryEntry(
  campaign: CampaignBlueprint,
  campaignState: CampaignState
): StorySummaryEntry | null {
  for (const entry of campaign.story_sequence) {
    if (!campaignState.completed_stories.includes(entry.story_id)) {
      return entry;
    }
  }
  return null; // all stories completed
}

/**
 * Returns true if all stories in the sequence have been completed.
 */
export function isCampaignComplete(
  campaign: CampaignBlueprint,
  campaignState: CampaignState
): boolean {
  return campaign.story_sequence.every((s) =>
    campaignState.completed_stories.includes(s.story_id)
  );
}

// ---------------------------------------------------------------------------
// Story completion
// ---------------------------------------------------------------------------

/**
 * Records a completed story in the campaign state.
 *
 * - Adds story_id to completed_stories (deduplicated).
 * - Applies world_state_changes and relationship_changes from the ending.
 * - Stores a PreviousStorySummary.
 * - Advances current_story_id to the next story (or keeps it if campaign ends).
 *
 * Returns a new CampaignState (pure — does not mutate the input).
 */
export function completeStory(
  campaignState: CampaignState,
  campaign: CampaignBlueprint,
  story: StoryBlueprint,
  options: {
    worldStateChanges?: Record<string, number>;
    relationshipChanges?: Record<string, number>;
    outcomeDescription?: string;
  } = {}
): CampaignState {
  const { worldStateChanges = {}, relationshipChanges = {}, outcomeDescription = "" } = options;

  // Deduplicate: if already recorded, return unchanged
  if (campaignState.completed_stories.includes(story.story_id)) {
    return campaignState;
  }

  // Apply world state changes
  const newWorldState = { ...campaignState.world_state };
  for (const [key, delta] of Object.entries(worldStateChanges)) {
    newWorldState[key] = (newWorldState[key] ?? 0) + delta;
  }

  // Apply relationship changes
  const newRelationships = { ...campaignState.relationships };
  for (const [charId, delta] of Object.entries(relationshipChanges)) {
    newRelationships[charId] = (newRelationships[charId] ?? 0) + delta;
  }

  // Record summary for continuity
  const summary: PreviousStorySummary = {
    story_id: story.story_id,
    title: story.title,
    outcome_description: outcomeDescription,
    world_state_snapshot: newWorldState,
    relationship_snapshot: newRelationships,
  };

  const completedStories = [...campaignState.completed_stories, story.story_id];

  // Determine next current_story_id
  const nextEntry = campaign.story_sequence.find(
    (s) => !completedStories.includes(s.story_id)
  );
  const nextStoryId = nextEntry?.story_id ?? campaignState.current_story_id;

  return {
    ...campaignState,
    completed_stories: completedStories,
    current_story_id: nextStoryId,
    world_state: newWorldState,
    relationships: newRelationships,
    previous_story_summaries: [
      ...campaignState.previous_story_summaries,
      summary,
    ],
  };
}
