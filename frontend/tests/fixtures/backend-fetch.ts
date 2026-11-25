/**
 * A fetch that plays the FastAPI backend for the three AI steps.
 *
 * It answers POST /api/v1/ai/<step> with the success envelopes in
 * backend/tests/fixtures/ai/<step>.success.json (the same files the contract
 * test proves the backend produces), so client code runs against the real
 * response shape without a server. Tests can replace any call with an error
 * envelope (see `errorResponse`) to exercise failure paths.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "..", "..", "..", "backend", "tests", "fixtures", "ai");

const STEPS = ["analyze-material", "plan-campaign", "generate-story"] as const;
export type BackendStep = (typeof STEPS)[number];

export type BackendCall = { path: string; body: unknown };

/** The raw text of a backend fixture, e.g. `analyze-material.success.json`. */
export function fixtureText(name: string): string {
  return readFileSync(join(DIR, name), "utf8");
}

/** The parsed backend fixture. */
export function fixtureJson<T = unknown>(name: string): T {
  return JSON.parse(fixtureText(name)) as T;
}

/** The URL the client posts to for a step. */
export const stepPath = (step: BackendStep): string => `/api/v1/ai/${step}`;

/** A JSON error envelope response, like the backend sends for `code`. */
export function errorResponse(code: string, status: number): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message: "x" } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A response built from an `error-*.json` backend fixture and the status the contract gives it. */
export function fixtureErrorResponse(file: string, status: number): Response {
  return new Response(fixtureText(file), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * @param override Return a Response to replace the fixture answer for a call
 *   (e.g. to simulate an outage), or undefined to serve the success fixture.
 */
export function backendFetch(override?: (call: BackendCall) => Response | undefined) {
  const calls: BackendCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const call = { path, body };
    calls.push(call);
    const replaced = override?.(call);
    if (replaced) return replaced;
    const step = STEPS.find((s) => stepPath(s) === path);
    if (!step) return new Response("not found", { status: 404 });
    return new Response(fixtureText(`${step}.success.json`), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}
