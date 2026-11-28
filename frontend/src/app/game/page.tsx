/**
 * /game — Campaign Game Page
 *
 * Plays the demo campaign ("The Last Beacon") from static data in
 * dummy-campaign.ts. Campaign state and the lobby/story switch live in
 * CampaignPlayer; later this page will load campaign data from a saved
 * project instead.
 */

"use client";

import {
  dummyStory,
  dummyStory2,
  dummyCampaign,
  dummyCampaignState,
  dummyMaterial,
} from "@/data/dummy-campaign";
import type { StoryBlueprint } from "@/lib/types/story";
import { CampaignPlayer } from "@/components/campaign/CampaignPlayer";

// Build the stories map once — stable reference
const STORIES: ReadonlyMap<string, StoryBlueprint> = new Map([
  [dummyStory.story_id, dummyStory],
  [dummyStory2.story_id, dummyStory2],
]);

const DEMO_MATERIALS = [dummyMaterial];

export default function GamePage() {
  return (
    <CampaignPlayer
      campaign={dummyCampaign}
      stories={STORIES}
      initialState={dummyCampaignState}
      materials={DEMO_MATERIALS}
      homeHref="/"
      homeLabel="Back to home"
    />
  );
}
