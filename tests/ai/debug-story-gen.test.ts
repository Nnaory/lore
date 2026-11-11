/**
 * Debug test for story generation
 */
import { describe, it } from "vitest";
import { generateCampaignStories } from "@/lib/ai/story-generator-service";
import { buildCampaignBlueprint } from "@/lib/ai/campaign-planner-engine";
import { dummyMaterial, dummyMaterial2, dummyMaterial3, dummyPlannerOptions } from "@/data/dummy-campaign";
import { resetProviderCache, resetStoryGeneratorProviderCache } from "@/lib/ai/providers";
import { resetCampaignPlannerCache } from "@/lib/ai/campaign-planner";

describe("Debug Story Generation", () => {
  it("debug generateCampaignStories", async () => {
    resetProviderCache();
    resetCampaignPlannerCache();
    resetStoryGeneratorProviderCache();

    // Build campaign using the same materials as the full workflow
    const linearAlgebraContent = [
      "Linear combinations are fundamental to linear algebra. A linear combination of vectors v1, v2 is c1*v1 + c2*v2. Vector span is the set of all linear combinations.",
      "Vector spaces and basis vectors. A basis is a set of linearly independent vectors that span the space. Linear independence means no vector is a linear combination of the others.",
      "Matrix transformations and eigenvalues. Matrices act on vectors as linear transformations. Eigenvalues and eigenvectors reveal the structure of a linear transformation.",
    ];

    // First analyze materials
    const { analyzeMaterial, resetMaterialIntelligenceCache } = await import("@/lib/ai/material-intelligence");
    resetMaterialIntelligenceCache();

    const materialBlueprints = [];
    for (const content of linearAlgebraContent) {
      const result = await analyzeMaterial({ material: content });
      if (result.ok) {
        materialBlueprints.push(result.blueprint);
        console.log("Material analyzed:", result.blueprint.material_id);
      } else {
        console.log("Material analysis failed:", result.message);
      }
    }

    console.log("Total materials:", materialBlueprints.length);

    // Plan campaign
    const planned = await buildCampaignBlueprint(materialBlueprints, dummyPlannerOptions);
    if (!planned.ok) {
      console.log("Campaign planning failed:", planned.message);
      return;
    }
    const campaign = planned.blueprint;
    console.log("Campaign stories:", campaign.story_sequence.map(s => ({ story_id: s.story_id, material_id: s.material_id })));

    // Generate stories
    const result = await generateCampaignStories(campaign, materialBlueprints, [], {}, false);
    console.log("Generation result:", {
      ok: result.ok,
      storiesCount: result.stories.size,
      errorsCount: result.errors.size,
      errors: Array.from(result.errors.entries()),
      storyIds: Array.from(result.stories.keys()),
    });
  });
});