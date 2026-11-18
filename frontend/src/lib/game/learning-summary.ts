/**
 * Learning summary — the end-of-campaign evaluation
 *
 * Built only from evidence the game actually recorded (player_knowledge),
 * never from guesses:
 *   - mastered:   puzzle answered correctly on the very first attempt
 *   - developing: answered correctly, but only after a mistake
 *   - practice:   attempted, never answered correctly
 *   - unseen:     taught but never tested / never reached
 *
 * Pure function — no React.
 */

import type { CampaignBlueprint } from "@/lib/types/campaign";
import type { CampaignState } from "@/lib/types/game";
import type { MaterialBlueprint } from "@/lib/types/material";
import type { StoryBlueprint } from "@/lib/types/story";

export type ConceptOutcome = "mastered" | "developing" | "practice" | "unseen";

export type ConceptSummary = {
  concept_id: string;
  name: string;
  /** The concept's definition, when the source material is available. */
  definition: string | null;
  outcome: ConceptOutcome;
  /** A common misconception to watch for, shown when the player stumbled. */
  watch_out: string | null;
};

export type StoryOutcomeSummary = {
  story_id: string;
  title: string;
  ending_title: string;
  ending_narration: string;
};

export type LearningSummary = {
  campaign_title: string;
  stories: StoryOutcomeSummary[];
  concepts: ConceptSummary[];
  counts: Record<ConceptOutcome, number>;
};

function outcomeFor(state: CampaignState, conceptId: string): ConceptOutcome {
  const knowledge = state.player_knowledge[conceptId];
  if (!knowledge) return "unseen";
  if (knowledge.status === "demonstrated") return "mastered";
  const sources = new Set(knowledge.evidence.map((e) => e.source));
  if (sources.has("puzzle_correct_after_feedback")) return "developing";
  if (sources.has("puzzle_incorrect")) return "practice";
  return "unseen";
}

/** The first learning_info title that introduces a concept (fallback name). */
function lessonTitle(stories: StoryBlueprint[], conceptId: string): string | null {
  for (const story of stories) {
    for (const scene of story.chapters.flatMap((c) => c.scenes)) {
      if (!("content" in scene)) continue;
      const block = scene.content.find((b) => b.type === "learning_info" && b.concept_ids.includes(conceptId));
      if (block && block.type === "learning_info") return block.title;
    }
  }
  return null;
}

export function buildLearningSummary(input: {
  campaign: CampaignBlueprint;
  stories: ReadonlyMap<string, StoryBlueprint>;
  state: CampaignState;
  materials?: MaterialBlueprint[];
}): LearningSummary {
  const { campaign, state } = input;
  const ordered = campaign.story_sequence
    .map((entry) => input.stories.get(entry.story_id))
    .filter((s): s is StoryBlueprint => s !== undefined);
  const concepts = new Map((input.materials ?? []).flatMap((m) => m.concepts).map((c) => [c.concept_id, c]));

  // Concepts in the order the player met them; each counted once.
  const conceptIds = [...new Set(ordered.flatMap((s) => s.knowledge_mapping.map((m) => m.concept_id)))];
  const conceptSummaries: ConceptSummary[] = conceptIds.map((id) => {
    const concept = concepts.get(id);
    const outcome = outcomeFor(state, id);
    return {
      concept_id: id,
      name: concept?.name ?? lessonTitle(ordered, id) ?? id,
      definition: concept?.definition ?? null,
      outcome,
      watch_out: outcome === "developing" || outcome === "practice" ? concept?.misconceptions[0] ?? null : null,
    };
  });

  const stories: StoryOutcomeSummary[] = ordered
    .filter((s) => state.completed_stories.includes(s.story_id))
    .map((s) => {
      // The good ending is the first ending scene in the story (bad-branch
      // endings come later) — the same rule the story viewer uses.
      const endingScene = s.chapters.flatMap((c) => c.scenes).find((sc) => sc.type === "ending");
      const ending =
        (endingScene?.type === "ending" ? s.endings.find((e) => e.ending_id === endingScene.ending_id) : undefined) ??
        s.endings[0];
      return {
        story_id: s.story_id,
        title: s.title,
        ending_title: ending?.title ?? s.title,
        ending_narration: ending?.narration ?? "",
      };
    });

  const counts: Record<ConceptOutcome, number> = { mastered: 0, developing: 0, practice: 0, unseen: 0 };
  for (const c of conceptSummaries) counts[c.outcome]++;

  return { campaign_title: campaign.title, stories, concepts: conceptSummaries, counts };
}
