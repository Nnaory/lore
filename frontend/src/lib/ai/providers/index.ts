/**
 * AI Provider Registry
 *
 * Resolves the active provider for each layer from environment configuration.
 * Server-side only — never imported by client components.
 *
 * There is no offline/demo provider. When no LLM can be reached (AI_PROVIDER
 * is not "google", or no GOOGLE_API_KEY / GEMINI_API_KEY is set) every layer
 * gets an "unavailable" provider that returns PROVIDER_NOT_CONFIGURED, so the
 * player sees a clear warning instead of made-up concepts or a made-up story.
 * Tests inject deterministic doubles with setProvidersForTest.
 */

import type { IMaterialIntelligenceProvider, AnalyzeMaterialResult } from "@/lib/ai/types";
import type { ICampaignPlannerProvider, PlanCampaignResult } from "@/lib/ai/campaign-planner-types";
import type { IStoryGeneratorProvider, GenerateStoryResult } from "@/lib/ai/story-generator-types";
import { geminiConfigFromEnv, type GeminiConfig } from "@/lib/ai/providers/gemini-client";
import { GeminiMaterialProvider } from "@/lib/ai/providers/gemini-material-provider";
import { GeminiCampaignPlannerProvider } from "@/lib/ai/providers/gemini-campaign-planner-provider";
import { GeminiStoryGeneratorProvider } from "@/lib/ai/providers/gemini-story-generator";

// ---------------------------------------------------------------------------
// "Unavailable" providers (no LLM configured)
// ---------------------------------------------------------------------------

const NOT_CONFIGURED_MESSAGE =
  "No AI model is configured on this server (set AI_PROVIDER=google and GOOGLE_API_KEY).";

const notConfigured = { code: "PROVIDER_NOT_CONFIGURED" as const, message: NOT_CONFIGURED_MESSAGE };

class UnavailableMaterialProvider implements IMaterialIntelligenceProvider {
  readonly id = "none" as const;
  readonly model = "none";
  async analyzeMaterial(): Promise<AnalyzeMaterialResult> {
    return { ok: false, error: { ...notConfigured } };
  }
}

class UnavailableCampaignPlannerProvider implements ICampaignPlannerProvider {
  readonly id = "none" as const;
  readonly model = "none";
  async planCampaign(): Promise<PlanCampaignResult> {
    return { ok: false, error: { ...notConfigured } };
  }
}

class UnavailableStoryGeneratorProvider implements IStoryGeneratorProvider {
  readonly id = "none" as const;
  readonly model = "none";
  async generateStory(): Promise<GenerateStoryResult> {
    return { ok: false, error: { ...notConfigured } };
  }
}

/**
 * Gemini config when AI_PROVIDER=google and a key is set, otherwise null
 * (with a server-side warning saying why).
 */
function googleConfig(layer: string): GeminiConfig | null {
  const providerId = process.env.AI_PROVIDER;
  if (providerId !== "google") {
    console.warn(`[AI] AI_PROVIDER is "${providerId ?? ""}" (expected "google"); ${layer} is unavailable`);
    return null;
  }
  const config = geminiConfigFromEnv();
  if (!config) {
    console.warn(`[AI] AI_PROVIDER=google but no GOOGLE_API_KEY is set; ${layer} is unavailable`);
  }
  return config;
}

// ---------------------------------------------------------------------------
// Test doubles (NODE_ENV === "test" only)
// ---------------------------------------------------------------------------

type TestProviders = {
  material?: IMaterialIntelligenceProvider;
  planner?: ICampaignPlannerProvider;
  story?: IStoryGeneratorProvider;
};

let testProviders: TestProviders = {};

/** Replace providers with test doubles. Ignored outside NODE_ENV=test. */
export function setProvidersForTest(providers: TestProviders): void {
  if (process.env.NODE_ENV !== "test") return;
  testProviders = { ...testProviders, ...providers };
}

/** Remove every test double so the real (env-driven) registry is used. */
export function clearProvidersForTest(): void {
  testProviders = {};
}

function testDouble<K extends keyof TestProviders>(key: K): TestProviders[K] | undefined {
  return process.env.NODE_ENV === "test" ? testProviders[key] : undefined;
}

// ---------------------------------------------------------------------------
// Material Intelligence provider registry (Layer 1)
// ---------------------------------------------------------------------------

/** The configured provider, or an unavailable one. Never throws. */
export function getProvider(): IMaterialIntelligenceProvider {
  const double = testDouble("material");
  if (double) return double;
  const config = googleConfig("material intelligence");
  return config ? new GeminiMaterialProvider(config) : new UnavailableMaterialProvider();
}

/**
 * Whether the *Cached getters may reuse a provider. Under `next dev`
 * (NODE_ENV=development) they build a fresh one per call, so edits to
 * .env.local or provider code apply without restarting the dev server.
 * Read at call time, not at module load.
 */
function cacheProviders(): boolean {
  return process.env.NODE_ENV !== "development";
}

let _cachedProvider: IMaterialIntelligenceProvider | null = null;

export function getProviderCached(): IMaterialIntelligenceProvider {
  if (!cacheProviders() || testDouble("material")) return getProvider();
  if (!_cachedProvider) {
    _cachedProvider = getProvider();
  }
  return _cachedProvider;
}

/** Reset provider cache (for testing). */
export function resetProviderCache(): void {
  _cachedProvider = null;
}

// ---------------------------------------------------------------------------
// Campaign Planner provider registry (Layer 2)
// ---------------------------------------------------------------------------

export function getCampaignPlannerProvider(): ICampaignPlannerProvider {
  const double = testDouble("planner");
  if (double) return double;
  const config = googleConfig("campaign planner");
  return config ? new GeminiCampaignPlannerProvider(config) : new UnavailableCampaignPlannerProvider();
}

let _cachedCampaignPlannerProvider: ICampaignPlannerProvider | null = null;

export function getCampaignPlannerProviderCached(): ICampaignPlannerProvider {
  if (!cacheProviders() || testDouble("planner")) return getCampaignPlannerProvider();
  if (!_cachedCampaignPlannerProvider) {
    _cachedCampaignPlannerProvider = getCampaignPlannerProvider();
  }
  return _cachedCampaignPlannerProvider;
}

export function resetCampaignPlannerProviderCache(): void {
  _cachedCampaignPlannerProvider = null;
}

// ---------------------------------------------------------------------------
// Story Generator provider registry (Layer 3)
// ---------------------------------------------------------------------------

export function getStoryGeneratorProvider(): IStoryGeneratorProvider {
  const double = testDouble("story");
  if (double) return double;
  const config = googleConfig("story generator");
  return config ? new GeminiStoryGeneratorProvider(config) : new UnavailableStoryGeneratorProvider();
}

let _cachedStoryGeneratorProvider: IStoryGeneratorProvider | null = null;

export function getStoryGeneratorProviderCached(): IStoryGeneratorProvider {
  if (!cacheProviders() || testDouble("story")) return getStoryGeneratorProvider();
  if (!_cachedStoryGeneratorProvider) {
    _cachedStoryGeneratorProvider = getStoryGeneratorProvider();
  }
  return _cachedStoryGeneratorProvider;
}

export function resetStoryGeneratorProviderCache(): void {
  _cachedStoryGeneratorProvider = null;
}
