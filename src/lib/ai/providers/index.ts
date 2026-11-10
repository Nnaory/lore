/**
 * AI Provider Registry
 *
 * Resolves the active provider from environment configuration.
 * Server-side only — never imported by client components.
 */

import { IMaterialIntelligenceProvider, AIProviderId } from "@/lib/ai/types";
import { DummyProvider } from "@/lib/ai/providers/dummy-provider";
import type { ICampaignPlannerProvider } from "@/lib/ai/campaign-planner-types";
import { DummyCampaignPlannerProvider } from "@/lib/ai/providers/dummy-campaign-planner-provider";

/**
 * Returns the configured provider instance.
 * Defaults to DummyProvider if AI_PROVIDER is unset or unknown.
 * Fail-closed: never crashes, always returns a working provider.
 */
export function getProvider(): IMaterialIntelligenceProvider {
  const providerId = (process.env.AI_PROVIDER ?? "dummy") as AIProviderId;

  switch (providerId) {
    case "dummy":
      return new DummyProvider();
    // Future providers — NOT implemented in M7:
    // case "openai":
    //   return new OpenAIProvider({
    //     apiKey: process.env.AI_API_KEY!,
    //     model: process.env.AI_MODEL ?? "gpt-4o-mini",
    //     maxTokens: Number(process.env.AI_MAX_TOKENS ?? 4000),
    //   });
    // case "anthropic":
    //   return new AnthropicProvider({ ... });
    // case "google":
    //   return new GoogleProvider({ ... });
    default:
      console.warn(
        `[AI] Unknown provider "${providerId}", falling back to dummy`
      );
      return new DummyProvider();
  }
}

/** Reset provider cache (for testing). */
let _cachedProvider: IMaterialIntelligenceProvider | null = null;

export function getProviderCached(): IMaterialIntelligenceProvider {
  if (!_cachedProvider) {
    _cachedProvider = getProvider();
  }
  return _cachedProvider;
}

export function resetProviderCache(): void {
  _cachedProvider = null;
}

// ---------------------------------------------------------------------------
// Campaign Planner provider registry (Layer 2)
//
// Kept separate from the Material Intelligence registry so each service owns
// its own selection responsibilities. Both read the same AI_PROVIDER variable.
// ---------------------------------------------------------------------------

/**
 * Returns the configured Campaign Planner provider.
 * Defaults to DummyCampaignPlannerProvider if AI_PROVIDER is unset or unknown.
 * Fail-closed: never crashes, always returns a working provider.
 */
export function getCampaignPlannerProvider(): ICampaignPlannerProvider {
  const providerId = (process.env.AI_PROVIDER ?? "dummy") as AIProviderId;

  switch (providerId) {
    case "dummy":
      return new DummyCampaignPlannerProvider();
    // Future providers — NOT implemented in M8:
    // case "openai":
    //   return new OpenAICampaignPlannerProvider({ ... });
    // case "anthropic":
    //   return new AnthropicCampaignPlannerProvider({ ... });
    // case "google":
    //   return new GoogleCampaignPlannerProvider({ ... });
    default:
      console.warn(
        `[AI] Unknown campaign planner provider "${providerId}", falling back to dummy`
      );
      return new DummyCampaignPlannerProvider();
  }
}

let _cachedCampaignPlannerProvider: ICampaignPlannerProvider | null = null;

export function getCampaignPlannerProviderCached(): ICampaignPlannerProvider {
  if (!_cachedCampaignPlannerProvider) {
    _cachedCampaignPlannerProvider = getCampaignPlannerProvider();
  }
  return _cachedCampaignPlannerProvider;
}

export function resetCampaignPlannerProviderCache(): void {
  _cachedCampaignPlannerProvider = null;
}