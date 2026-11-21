/**
 * Request shape the create form and the staged generation flow build.
 *
 * It bundles the materials plus campaign and story options. generation.ts
 * splits it into the per-layer requests sent to analyze-material,
 * plan-campaign and generate-story. Pure Zod, safe to import from client code.
 */

import { z } from "zod";
import {
  AnalyzeMaterialRequestSchema,
  CampaignPlannerOptionsSchema,
  StoryGeneratorOptionsSchema,
} from "./ai-requests";

export const GenerationRequestSchema = z.object({
  materials: z.array(AnalyzeMaterialRequestSchema).min(1, "at least one material is required"),
  campaignOptions: CampaignPlannerOptionsSchema,
  storyOptions: StoryGeneratorOptionsSchema.optional(),
});

export type GenerationRequest = z.input<typeof GenerationRequestSchema>;
