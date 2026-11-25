/**
 * Tests — SceneBlueprint boundary guard (ui-redesign Requirement 13.7).
 *
 * Why: the Kit's SceneBlueprintSchema (lib/schemas/visual.ts) must not leak into the AI flow.
 * AI output stays StoryBlueprint/LessonVisual; the model never supplies images or coordinates.
 * Static scan of source files, no runtime imports.
 *
 * Follow-up work (out of scope of this spec): adopting SceneBlueprint in the AI flow, i.e. a
 * Story Generator output of that shape or a StoryBlueprint <-> SceneBlueprint adapter.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(__dirname, "../../src");
const REPO = resolve(__dirname, "../../..");

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx|py)$/.test(name)) out.push(p);
  }
  return out;
}

const FORBIDDEN = [
  // lib/schemas/visual (alias or relative form); not contracts/schemas/visual.schema (LessonVisual)
  /(?<!contracts\/)schemas\/visual(?!\.schema)/,
  /\bSceneBlueprint(Schema)?\b/,
];

function offenders(files: string[]): string[] {
  return files.filter((f) => {
    const text = readFileSync(f, "utf8");
    return FORBIDDEN.some((re) => re.test(text));
  });
}

describe("SceneBlueprint boundary", () => {
  it("scans a non-empty set of generation files", () => {
    expect(walk(join(SRC, "lib/generation")).length).toBeGreaterThan(0);
  });

  it("no file in src/lib/generation imports lib/schemas/visual or SceneBlueprint", () => {
    expect(offenders(walk(join(SRC, "lib/generation")))).toEqual([]);
  });

  it("other AI-flow code (contracts, story, campaign, ingest) does not use SceneBlueprint", () => {
    const files = ["lib/contracts", "lib/story", "lib/campaign", "lib/ingest"].flatMap((d) =>
      walk(join(SRC, d)),
    );
    expect(offenders(files)).toEqual([]);
  });

  it("backend AI code does not reference SceneBlueprint, and the Python copy is not added", () => {
    expect(offenders(walk(join(REPO, "backend/app/ai")))).toEqual([]);
    expect(existsSync(join(REPO, "backend/app/schemas/visual.py"))).toBe(false);
  });
});
