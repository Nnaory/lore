/**
 * Gemini client — server-side only
 *
 * Minimal fetch-based client for the Gemini API `generateContent` endpoint
 * that always asks for a JSON response. Handles:
 *   - an ordered list of models (fallback when one is overloaded or retired)
 *   - retries with backoff on 429 / 5xx / timeouts
 *   - stripping code fences and parsing the JSON body
 *
 * Never throws for expected failures and never includes the API key in
 * results, errors, or logs.
 */

export type GeminiConfig = {
  apiKey: string;
  /** Tried in order; the next model is used when one is unavailable. */
  models: string[];
  /** Per-request timeout. */
  timeoutMs: number;
  /** Attempts per model for retryable failures (429, 5xx, timeout, bad JSON). */
  attemptsPerModel: number;
  /** Base backoff between attempts on the same model. */
  backoffMs: number;
  /** Total time budget for one generateJson call, across all models. */
  deadlineMs: number;
};

const DEFAULT_MODELS = ["gemini-3.5-flash-lite"];
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_DEADLINE_MS = 300_000;
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

function parsePositiveMs(raw: string | undefined, fallback: number): number {
  if (!raw || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Read config from env. Returns null when no key is configured. */
export function geminiConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GeminiConfig | null {
  const apiKey = env.GOOGLE_API_KEY ?? env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const models = (env.AI_MODEL ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  return {
    apiKey,
    models: models.length > 0 ? models : DEFAULT_MODELS,
    timeoutMs: parsePositiveMs(env.AI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    attemptsPerModel: 2,
    backoffMs: 1_000,
    deadlineMs: parsePositiveMs(env.AI_DEADLINE_MS, DEFAULT_DEADLINE_MS),
  };
}

export type GeminiUsage = {
  promptTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type GeminiJsonResult =
  | { ok: true; json: unknown; model: string; usage: GeminiUsage; latencyMs: number }
  | {
      ok: false;
      code: "PROVIDER_UNAVAILABLE" | "OUTPUT_PARSE_FAILED" | "RATE_LIMITED" | "TIMEOUT";
      message: string;
      detail?: unknown;
    };

export type GeminiRequest = {
  system: string;
  prompt: string;
  maxOutputTokens: number;
  temperature?: number;
};

type Attempt =
  | { kind: "ok"; json: unknown; usage: GeminiUsage }
  | { kind: "retry"; reason: string; status?: number }
  | { kind: "next-model"; reason: string; status?: number }
  | { kind: "fatal"; reason: string; status?: number };

/** Strip ```json fences and parse. */
export function parseJsonText(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  return JSON.parse(cleaned);
}

type GeminiResponseBody = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  error?: { code?: number; message?: string; status?: string };
};

async function attemptOnce(
  model: string,
  request: GeminiRequest,
  config: GeminiConfig,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<Attempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": config.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: "user", parts: [{ text: request.prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens: request.maxOutputTokens,
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        },
      }),
    });
  } catch (err) {
    const aborted = (err as { name?: string } | null)?.name === "AbortError";
    // A model that is too slow now is likely to stay slow: try the next one.
    return aborted ? { kind: "next-model", reason: "timeout" } : { kind: "retry", reason: "network error" };
  } finally {
    clearTimeout(timer);
  }

  let body: GeminiResponseBody;
  try {
    body = (await response.json()) as GeminiResponseBody;
  } catch {
    return { kind: "retry", reason: "unreadable response", status: response.status };
  }

  if (!response.ok) {
    const status = response.status;
    const reason = body.error?.message?.slice(0, 200) ?? `HTTP ${status}`;
    if (status === 429 || status >= 500) return { kind: "retry", reason, status };
    if (status === 404) return { kind: "next-model", reason, status };
    if (status === 400) return { kind: "next-model", reason, status };
    return { kind: "fatal", reason, status }; // 401/402/403: key, billing or permission
  }

  const candidate = body.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .filter((p) => !p.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
  if (!text) {
    return { kind: "retry", reason: `empty response (finishReason: ${candidate?.finishReason ?? "none"})` };
  }

  try {
    return {
      kind: "ok",
      json: parseJsonText(text),
      usage: {
        promptTokens: body.usageMetadata?.promptTokenCount,
        outputTokens: body.usageMetadata?.candidatesTokenCount,
        totalTokens: body.usageMetadata?.totalTokenCount,
      },
    };
  } catch {
    return { kind: "retry", reason: `response was not valid JSON (finishReason: ${candidate?.finishReason ?? "none"})` };
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Generate a JSON response, trying each configured model in order.
 * Returns the parsed JSON (unvalidated — callers validate with Zod).
 */
export async function generateJson(
  request: GeminiRequest,
  config: GeminiConfig,
  fetchImpl: typeof fetch = fetch
): Promise<GeminiJsonResult> {
  const start = Date.now();
  const failures: Array<{ model: string; reason: string; status?: number }> = [];
  let sawRateLimit = false;
  let sawTimeoutOnly = true;
  let sawBadJson = false;

  outer: for (const model of config.models) {
    for (let attempt = 1; attempt <= config.attemptsPerModel; attempt++) {
      const remaining = config.deadlineMs - (Date.now() - start);
      if (remaining <= 0) {
        failures.push({ model, reason: "deadline reached" });
        break outer;
      }
      const result = await attemptOnce(model, request, config, fetchImpl, Math.min(config.timeoutMs, remaining));
      if (result.kind === "ok") {
        return { ok: true, json: result.json, model, usage: result.usage, latencyMs: Date.now() - start };
      }
      failures.push({ model, reason: result.reason, status: result.status });
      if (result.status === 429) sawRateLimit = true;
      if (result.reason !== "timeout") sawTimeoutOnly = false;
      if (result.reason.includes("not valid JSON")) sawBadJson = true;

      if (result.kind === "fatal") {
        return {
          ok: false,
          code: "PROVIDER_UNAVAILABLE",
          message: "The AI provider rejected the request (check the API key, billing, or permissions).",
          detail: failures,
        };
      }
      if (result.kind === "next-model") break;
      if (attempt < config.attemptsPerModel) await sleep(config.backoffMs * attempt);
    }
  }

  if (sawBadJson && !sawRateLimit) {
    return { ok: false, code: "OUTPUT_PARSE_FAILED", message: "The AI provider did not return valid JSON.", detail: failures };
  }
  return {
    ok: false,
    code: sawRateLimit ? "RATE_LIMITED" : sawTimeoutOnly ? "TIMEOUT" : "PROVIDER_UNAVAILABLE",
    message: "No configured AI model is available right now. Try again in a moment.",
    detail: failures,
  };
}
