/**
 * AI endpoint URLs (pure)
 *
 * The AI pipeline runs only in the FastAPI backend, served under
 * /api/v1/ai/*. This module turns a step name into that POST URL so the path
 * lives in one place.
 */

export type AiStep = "analyze-material" | "plan-campaign" | "generate-story" | "animations" | "ask";

/** The POST URL of an AI step. */
export function aiUrl(step: AiStep): string {
  return `/api/v1/ai/${step}`;
}
