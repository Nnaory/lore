/**
 * Tests — server save errors on the play page (r13 F6, http mode)
 *
 * In http mode a state save succeeds locally first and reaches the server
 * 1.5 s later; a server failure must still show the existing
 * `play-save-error` banner, and a later success must clear it.
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { createInitialCampaignState } from "@/lib/game/campaign-manager";
import { dummyCampaign } from "@/data/dummy-campaign";
import { HTTP_MESSAGES } from "@/lib/state/http-repository";
import { linearStory } from "../fixtures/linear-story";
import { freshStore } from "../fixtures/fresh-store";

const params = { projectId: "" };
vi.mock("next/navigation", () => ({ useParams: () => params }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

let putStatus = 500;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(async () => {
  await freshStore();
  putStatus = 500;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "PUT") return json(putStatus, { updated_at: 1 });
      if (method === "POST" && url === "/api/v1/projects") return json(201, JSON.parse(String(init?.body)));
      if (method === "GET" && url === "/api/v1/projects") return json(200, []);
      if (url.endsWith("/import")) return json(200, { imported: 0, skipped: 0, rejected: [] });
      return json(404, { detail: "project not found" }); // GET one → the local copy is used
    })
  );
  vi.stubEnv("NEXT_PUBLIC_PROJECT_STORE", "http");
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("PlayProject in http mode", () => {
  it("shows a server save error and clears it after a later success", async () => {
    // Import after the env stub, so the component and the test share one HttpRepository.
    const store = await import("@/lib/state/project-store");
    const { PlayProject } = await import("@/components/play/PlayProject");

    const created = await store.createProject({
      source: { file_name: "week3.pdf", file_type: "pdf" },
      campaign: dummyCampaign,
      stories: { [linearStory.story_id]: linearStory },
    });
    if (!created.ok) throw new Error(created.message);
    params.projectId = created.value.id;

    render(<PlayProject />);
    await screen.findByTestId("story-viewer");
    expect(screen.queryByTestId("play-save-error")).toBeNull();

    const state = createInitialCampaignState(dummyCampaign);
    expect(await store.saveCampaignState(created.value.id, state)).toEqual({ ok: true, value: undefined });
    const banner = await screen.findByTestId("play-save-error", {}, { timeout: 4000 });
    expect(banner.textContent).toBe(HTTP_MESSAGES.saveFailed);

    putStatus = 200;
    await store.saveCampaignState(created.value.id, { ...state, world_state: { light: 1 } });
    await waitFor(() => expect(screen.queryByTestId("play-save-error")).toBeNull(), { timeout: 4000 });
  }, 15_000);
});
