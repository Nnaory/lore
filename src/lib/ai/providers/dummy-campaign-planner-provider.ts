/**
 * Dummy Campaign Planner Provider — Deterministic Planning (Layer 2, M8)
 *
 * Implements ICampaignPlannerProvider using the deterministic planning engine.
 * NO randomness, NO external calls, NO API keys required.
 *
 * Error model mirrors the M7 Material Intelligence dummy provider:
 * expected failures are returned as PlanCampaignResult, never thrown.
 */

import type {
  ICampaignPlannerProvider,
  PlanCampaignRequest,
  PlanCampaignResult,
} from "@/lib/ai/campaign-planner-types";
import { buildCampaignBlueprint } from "@/lib/ai/campaign-planner-engine";
import { CampaignBlueprintSchema } from "@/lib/ai/schemas/campaign.schema";

export class DummyCampaignPlannerProvider implements ICampaignPlannerProvider {
  readonly id = "dummy" as const;
  readonly model = "dummy-planner-v1";

  async planCampaign(
    request: PlanCampaignRequest
  ): Promise<PlanCampaignResult> {
    const start = Date.now();

    try {
      // Defensive request guard — the service and API also validate.
      if (!request.materials || request.materials.length === 0) {
        return {
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            message: "At least one material is required.",
          },
        };
      }

      const engineResult = buildCampaignBlueprint(
        request.materials,
        request.options
      );

      if (!engineResult.ok) {
        return {
          ok: false,
          error: {
            code: engineResult.code,
            message: engineResult.message,
            detail: engineResult.detail,
          },
        };
      }

      // Validate the engine's own output against the schema. The dummy
      // provider must always emit schema-valid blueprints.
      const parsed = CampaignBlueprintSchema.safeParse(engineResult.blueprint);
      if (!parsed.success) {
        return {
          ok: false,
          error: {
            code: "VALIDATION_FAILED",
            message: "Dummy planner produced a schema-invalid CampaignBlueprint.",
            detail: parsed.error.flatten(),
          },
        };
      }

      const latencyMs = Date.now() - start;

      return {
        ok: true,
        value: {
          blueprint: parsed.data,
          meta: {
            provider: this.id,
            model: this.model,
            latencyMs,
            warnings: engineResult.warnings,
          },
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: "UNKNOWN",
          message: "Dummy campaign planner unexpected error.",
          detail: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  async healthCheck(): Promise<{ healthy: boolean; detail?: string }> {
    return { healthy: true, detail: "Dummy campaign planner operational" };
  }
}
