/**
 * Debug test to see the actual error
 */
import { describe, it } from "vitest";
import { runFullWorkflow, resetFullWorkflowCaches } from "@/lib/ai/full-workflow";
import {
  dummyMaterial,
  dummyMaterial2,
  dummyMaterial3,
  dummyPlannerOptions,
} from "@/data/dummy-campaign";

describe("Debug", () => {
  it("debug", async () => {
    resetFullWorkflowCaches();

    const validInput = {
      materials: [
        { material: dummyMaterial.summary },
        { material: dummyMaterial2.summary },
        { material: dummyMaterial3.summary },
      ],
      campaignOptions: dummyPlannerOptions,
      storyOptions: {},
    };

    const result = await runFullWorkflow(validInput);
    console.log("Result:", JSON.stringify(result, null, 2));
  });
});