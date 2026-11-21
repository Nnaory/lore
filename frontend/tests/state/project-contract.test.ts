/**
 * Tests — shared project fixture contract (r13 F8)
 *
 * backend/tests/fixtures/project.json is the one payload both sides agree on.
 * The backend's test_models.py checks it against the Pydantic envelope; this
 * file checks it against the client's Zod schemas. A change on either side
 * that breaks the shared shape fails one of the two.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CampaignStateSchema } from "@/lib/contracts/schemas/game.schema";
import { ProjectSchema, readProject } from "@/lib/state/project-model";
import { projectFromServer } from "@/lib/state/http-repository";

const FIXTURE = join(__dirname, "..", "..", "..", "backend", "tests", "fixtures", "project.json");
const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;

describe("shared project fixture", () => {
  it("is accepted by ProjectSchema", () => {
    const parsed = ProjectSchema.safeParse(fixture);
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
  });

  it("carries a campaign_state accepted by CampaignStateSchema", () => {
    const parsed = CampaignStateSchema.safeParse(fixture.campaign_state);
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
  });

  it("reads back with its progress intact", () => {
    expect(readProject(fixture)?.campaign_state).toEqual(fixture.campaign_state);
  });

  it("reads back from a server response that has null optionals", () => {
    const fromServer = projectFromServer({ ...fixture, campaign_state: null, materials: null });
    expect(fromServer?.id).toBe(fixture.id);
    expect(fromServer?.campaign_state).toBeUndefined();
    expect(fromServer?.materials).toBeUndefined();
  });
});
