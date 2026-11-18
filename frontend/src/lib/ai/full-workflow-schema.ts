/**
 * Request contract for POST /api/ai/full-workflow.
 *
 * Shared by the route handler (validation) and the browser (request type).
 * Pure Zod — safe to import from client code.
 */

import { z } from "zod";
import { AnalyzeMaterialRequestSchema } from "@/lib/ai/types";
import { CampaignPlannerOptionsSchema } from "@/lib/ai/campaign-planner-types";
import { StoryGeneratorOptionsSchema } from "@/lib/ai/story-generator-types";

export const FullWorkflowRequestSchema = z.object({
  materials: z.array(AnalyzeMaterialRequestSchema).min(1, "at least one material is required"),
  campaignOptions: CampaignPlannerOptionsSchema,
  storyOptions: StoryGeneratorOptionsSchema.optional(),
});

export type FullWorkflowRequestBody = z.input<typeof FullWorkflowRequestSchema>;
