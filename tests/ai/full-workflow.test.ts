/**
 * Tests — Full Workflow Orchestration (M10)
 *
 * Verifies the end-to-end AI pipeline:
 *   Material Intelligence → Campaign Planner → Story Generator
 *
 * Tests cover:
 * - Complete workflow success
 * - Material analysis failure handling
 * - Campaign planning failure handling
 * - Story generation failure handling
 * - Determinism under dummy provider
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runFullWorkflow, generateSingleStory, resetFullWorkflowCaches } from "@/lib/ai/full-workflow";
import { buildCampaignBlueprint } from "@/lib/ai/campaign-planner-engine";
import {
  dummyMaterial,
  dummyMaterial2,
  dummyMaterial3,
  dummyPlannerOptions,
} from "@/data/dummy-campaign";
import type { CampaignBlueprint } from "@/lib/types/campaign";
import type { MaterialBlueprint } from "@/lib/types/material";
import type { StoryBlueprint } from "@/lib/types/story";
import { validateCampaign } from "@/lib/validation/campaign-validator";
import { createInitialCampaignState, isStoryUnlocked, completeStory, isCampaignComplete, getNextStoryEntry } from "@/lib/game/campaign-manager";
import { createInitialKnowledge, recordLearningExposure, recordPuzzleSubmission } from "@/lib/game/knowledge-manager";

describe("Full Workflow Orchestration", () => {
  beforeEach(() => {
    resetFullWorkflowCaches();
  });

  afterEach(() => {
    resetFullWorkflowCaches();
  });

  // ---------------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------------

  const threeMaterials = [dummyMaterial, dummyMaterial2, dummyMaterial3];

  // Use content that the dummy provider recognizes (linear algebra keywords)
  // so all three materials produce distinct blueprints
  const linearAlgebraContent = [
    "Linear combinations are fundamental to linear algebra. A linear combination of vectors v1, v2 is c1*v1 + c2*v2. Vector span is the set of all linear combinations.",
    "Vector spaces and basis vectors. A basis is a set of linearly independent vectors that span the space. Linear independence means no vector is a linear combination of the others.",
    "Matrix transformations and eigenvalues. Matrices act on vectors as linear transformations. Eigenvalues and eigenvectors reveal the structure of a linear transformation.",
  ];

  const validInput = {
    materials: linearAlgebraContent.map((content) => ({ material: content })),
    campaignOptions: dummyPlannerOptions,
    storyOptions: {},
  };

  // ---------------------------------------------------------------------------
  // Complete Workflow
  // ---------------------------------------------------------------------------

  it("runs complete workflow: materials -> campaign -> stories", async () => {
    const result = await runFullWorkflow(validInput);

    expect(result.ok).toBe(true);
    expect(result.campaign).toBeDefined();
    expect(result.stories).toBeDefined();
    expect(result.materialResults).toHaveLength(3);
    expect(result.planningResult).toBeDefined();
    expect(result.generationResult).toBeDefined();

    // All materials analyzed successfully
    for (const mr of result.materialResults) {
      expect(mr.ok).toBe(true);
      expect(mr.blueprint).toBeDefined();
    }

    // Campaign planned successfully
    expect(result.planningResult?.ok).toBe(true);
    expect(result.planningResult?.blueprint).toBeDefined();
    expect(result.planningResult?.meta).toBeDefined();

    // All stories generated successfully
    expect(result.generationResult?.ok).toBe(true);
    expect(result.generationResult?.stories?.size).toBe(3);
    expect(result.generationResult?.errors?.size).toBe(0);

    // Campaign has 3 stories
    expect(result.campaign?.story_sequence).toHaveLength(3);

    // Each story is a valid StoryBlueprint
    for (const story of result.stories!.values()) {
      expect(story.story_id).toBeDefined();
      expect(story.chapters.length).toBeGreaterThan(0);
      expect(story.puzzles.length).toBeGreaterThan(0);
      expect(story.endings.length).toBe(1); // Single ending enforced
      expect(story.knowledge_mapping.length).toBeGreaterThan(0);
    }
  });

  it("produces campaign that passes final game-engine validation", async () => {
    const result = await runFullWorkflow(validInput);

    expect(result.ok).toBe(true);

    // Validate against game engine requirements using actual materials
    const materials = result.materialResults
      .filter((mr) => mr.ok && mr.blueprint)
      .map((mr) => mr.blueprint!);
    const validation = validateCampaign(result.campaign!, materials);
    expect(validation.valid).toBe(true);
  });

  it("generated campaign is playable by game engine", async () => {
    const result = await runFullWorkflow(validInput);
    expect(result.ok).toBe(true);

    const campaign = result.campaign!;
    const stories = result.stories!;

    // Create initial campaign state
    const campaignState = createInitialCampaignState(campaign);
    expect(campaignState.current_story_id).toBe(campaign.story_sequence[0].story_id);

    // First story should be unlocked
    expect(isStoryUnlocked(campaign.story_sequence[0].story_id, campaign, campaignState)).toBe(true);

    // Simulate completing all stories sequentially
    let currentState = campaignState;
    for (let i = 0; i < campaign.story_sequence.length; i++) {
      const storyEntry = campaign.story_sequence[i];
      const storyBlueprint = stories.get(storyEntry.story_id);

      expect(storyBlueprint).toBeDefined();

      // Verify story can be completed
      currentState = completeStory(
        currentState,
        campaign,
        storyBlueprint!,
        { outcomeDescription: storyBlueprint!.endings[0].narration, worldStateChanges: {} }
      );

      // Next story should be unlocked (except for last)
      if (i < campaign.story_sequence.length - 1) {
        const nextEntry = campaign.story_sequence[i + 1];
        expect(isStoryUnlocked(nextEntry.story_id, campaign, currentState)).toBe(true);
      }
    }

    // Campaign should be complete
    expect(isCampaignComplete(campaign, currentState)).toBe(true);
  });

  it("knowledge progression works through generated stories", async () => {
    const result = await runFullWorkflow(validInput);
    expect(result.ok).toBe(true);

    const campaign = result.campaign!;
    const stories = result.stories!;
    const materials = result.materialResults
      .filter((mr) => mr.ok && mr.blueprint)
      .map((mr) => mr.blueprint!);

    // For each story, verify all required_knowledge concepts exist in materials
    for (const entry of campaign.story_sequence) {
      const material = materials.find((m) => m.material_id === entry.material_id);
      expect(material).toBeDefined();

      for (const conceptId of entry.required_knowledge) {
        const concept = material!.concepts.find((c) => c.concept_id === conceptId);
        expect(concept).toBeDefined();

        // Verify concept has learning_info + puzzle in generated story
        const story = stories.get(entry.story_id);
        expect(story).toBeDefined();

        const km = story!.knowledge_mapping.find((k) => k.concept_id === conceptId);
        expect(km).toBeDefined();

        // Verify the puzzle tests this concept
        const puzzle = story!.puzzles.find((p) => p.puzzle_id === km!.tested_in_puzzle_id);
        expect(puzzle).toBeDefined();
        expect(puzzle!.concept_ids).toContain(conceptId);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Determinism
  // ---------------------------------------------------------------------------

  it("is deterministic under dummy provider (same input = same output)", async () => {
    const result1 = await runFullWorkflow(validInput);
    resetFullWorkflowCaches();
    const result2 = await runFullWorkflow(validInput);

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);

    // Campaign IDs should match
    expect(result1.campaign?.campaign_id).toBe(result2.campaign?.campaign_id);
    expect(result1.campaign?.title).toBe(result2.campaign?.title);

    // Story IDs should match
    for (const entry of result1.campaign!.story_sequence) {
      const story1 = result1.stories!.get(entry.story_id);
      const story2 = result2.stories!.get(entry.story_id);
      expect(story1?.story_id).toBe(story2?.story_id);
      expect(story1?.title).toBe(story2?.title);
      expect(story1?.chapters.length).toBe(story2?.chapters.length);
    }
  });

  // ---------------------------------------------------------------------------
  // Material Analysis Failure
  // ---------------------------------------------------------------------------

  it("fails gracefully when material analysis fails (too short)", async () => {
    const badInput = {
      ...validInput,
      materials: [
        ...validInput.materials,
        { material: "Short" }, // Too short (< 10 chars)
      ],
    };

    const result = await runFullWorkflow(badInput);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("MATERIAL_ANALYSIS_FAILED");
    expect(result.materialResults.length).toBe(4);
    expect(result.planningResult?.ok).toBe(false);
    expect(result.stories).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Single Story Generation
  // ---------------------------------------------------------------------------

  it("generates a single story for an existing campaign", async () => {
    // First run full workflow to get a campaign
    const workflowResult = await runFullWorkflow(validInput);
    expect(workflowResult.ok).toBe(true);

    const campaign = workflowResult.campaign!;
    const materials = workflowResult.materialResults
      .filter((m) => m.ok)
      .map((m) => m.blueprint!) as MaterialBlueprint[];

    const firstStoryId = campaign.story_sequence[0].story_id;

    // Generate single story
    const singleResult = await generateSingleStory(campaign, materials, firstStoryId, [], {});

    expect(singleResult.ok).toBe(true);
    if (singleResult.ok) {
      expect(singleResult.value.blueprint.story_id).toBe(firstStoryId);
      expect(singleResult.value.blueprint.chapters.length).toBeGreaterThan(0);
    }
  });

  it("returns error for non-existent story ID", async () => {
    const workflowResult = await runFullWorkflow(validInput);
    expect(workflowResult.ok).toBe(true);

    const campaign = workflowResult.campaign!;
    const materials = workflowResult.materialResults
      .filter((m) => m.ok)
      .map((m) => m.blueprint!) as MaterialBlueprint[];

    const singleResult = await generateSingleStory(campaign, materials, "nonexistent_story", [], {});

    expect(singleResult.ok).toBe(false);
    if (!singleResult.ok) {
      expect(singleResult.error.code).toBe("STORY_NOT_IN_CAMPAIGN");
    }
  });

  it("returns error for story with missing material", async () => {
    const workflowResult = await runFullWorkflow(validInput);
    expect(workflowResult.ok).toBe(true);

    const campaign = workflowResult.campaign!;
    // Remove one material
    const materials = workflowResult.materialResults
      .filter((m) => m.ok && m.blueprint!.material_id !== campaign.story_sequence[0].material_id)
      .map((m) => m.blueprint!) as MaterialBlueprint[];

    const firstStoryId = campaign.story_sequence[0].story_id;

    const singleResult = await generateSingleStory(campaign, materials, firstStoryId, [], {});

    expect(singleResult.ok).toBe(false);
    if (!singleResult.ok) {
      expect(singleResult.error.code).toBe("MATERIAL_MISMATCH");
    }
  });

  // ---------------------------------------------------------------------------
  // Warning Aggregation
  // ---------------------------------------------------------------------------

  it("aggregates warnings from all layers", async () => {
    const result = await runFullWorkflow(validInput);

    expect(result.ok).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
    // Warnings may be empty under dummy provider, but array should exist
  });
});