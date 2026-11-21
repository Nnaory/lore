/**
 * A fetch that serves /api/ai/* by calling the real route handlers
 * in-process (with whatever provider the test environment selects — dummy
 * by default). Lets client code be tested against the real server contract.
 */

import { NextRequest } from "next/server";
import { POST as analyzeMaterial } from "@/app/api/ai/analyze-material/route";
import { POST as planCampaign } from "@/app/api/ai/plan-campaign/route";
import { POST as generateStory } from "@/app/api/ai/generate-story/route";

const ROUTES: Record<string, (req: NextRequest) => Promise<Response>> = {
  "/api/ai/analyze-material": analyzeMaterial,
  "/api/ai/plan-campaign": planCampaign,
  "/api/ai/generate-story": generateStory,
};

export type RouteCall = { path: string; body: unknown };

/**
 * @param override Return a Response to replace the real handler for a call
 *   (e.g. to simulate a provider outage), or undefined to use the handler.
 */
export function routeFetch(override?: (call: RouteCall) => Response | undefined) {
  const calls: RouteCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const call = { path, body };
    calls.push(call);
    const replaced = override?.(call);
    if (replaced) return replaced;
    const handler = ROUTES[path];
    if (!handler) return new Response("not found", { status: 404 });
    return handler(new NextRequest(`http://localhost${path}`, { method: "POST", body: init?.body as string }));
  }) as typeof fetch;
  return { fetchImpl, calls };
}
