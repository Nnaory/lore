/**
 * /game — Campaign Game Page
 *
 * Client Component that owns campaign-level state for the current session.
 * Uses useCampaign to manage story progression, and renders either the
 * CampaignLobby (when between stories) or the StoryViewer (when playing).
 *
 * Story data is imported statically from dummy-campaign.ts.
 * In future milestones this page will receive campaign/story data from
 * a session or database source.
 */

"use client";

import { useMemo } from "react";
import type { Metadata } from "next";
import {
  dummyStory,
  dummyStory2,
  dummyCampaign,
  dummyCampaignState,
} from "@/data/dummy-campaign";
import type { StoryBlueprint } from "@/lib/types/story";
import { useCampaign } from "@/lib/campaign/use-campaign";
import { StoryViewer } from "@/components/story/StoryViewer";
import { CampaignLobby } from "@/components/campaign/CampaignLobby";

// Build the stories map once — stable reference
const STORIES: ReadonlyMap<string, StoryBlueprint> = new Map([
  [dummyStory.story_id, dummyStory],
  [dummyStory2.story_id, dummyStory2],
]);

export default function GamePage() {
  const {
    campaignState,
    activeStory,
    isCampaignComplete,
    isAtLobby,
    onStoryComplete,
    onExitStory,
    onStartStory,
  } = useCampaign(dummyCampaign, STORIES, dummyCampaignState);

  if (isAtLobby) {
    return (
      <div className="h-screen flex flex-col overflow-hidden">
        <CampaignLobby
          campaign={dummyCampaign}
          campaignState={campaignState}
          onStartStory={onStartStory}
        />
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <StoryViewer
        story={activeStory}
        characters={dummyCampaign.characters}
        onStoryComplete={onStoryComplete}
        onExit={onExitStory}
        isCampaignComplete={isCampaignComplete}
      />
    </div>
  );
}
