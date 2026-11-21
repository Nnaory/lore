/**
 * AI endpoint selection (pure)
 *
 * The AI pipeline can run in the Next.js route handlers (`next`, default) or
 * in the FastAPI backend (`api`). The build flag NEXT_PUBLIC_AI_BACKEND picks
 * one; this module turns a step name into the URL for that backend. Any value
 * other than `api` means `next`, so the default behavior never changes.
 *
 * The flag is read as the literal `process.env.NEXT_PUBLIC_AI_BACKEND` so
 * Next.js inlines it into the client bundle (same pattern as
 * NEXT_PUBLIC_PROJECT_STORE in lib/state/project-store.ts).
 */

export type AiBackend = "next" | "api";
export type AiStep = "analyze-material" | "plan-campaign" | "generate-story";

/** `api` selects the FastAPI backend; anything else selects Next.js routes. */
export function resolveAiBackend(raw: string | undefined): AiBackend {
  return raw === "api" ? "api" : "next";
}

/** The POST URL of an AI step on the given backend. */
export function aiUrl(step: AiStep, backend: AiBackend): string {
  return backend === "api" ? `/api/v1/ai/${step}` : `/api/ai/${step}`;
}

// Literal access: Next.js replaces it at build time.
export const AI_BACKEND: AiBackend = resolveAiBackend(process.env.NEXT_PUBLIC_AI_BACKEND);
