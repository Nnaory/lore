/**
 * World scene helpers: the pure parts of the "Building your world" screen
 *
 * Why: the screen shows Hazel at her cauldron, a clock, a log and one line of what she is
 * doing. None of that is game logic, but each piece is a decision from the generation state, so
 * it lives here as small pure functions with the React component only drawing them:
 *   - `formatClock`   mm:ss for the clock and the active step
 *   - `hazelLine`     what Hazel says for a stage (the review stage names what to do)
 *   - `hazelExpression` which of the Kit's expressions she wears
 *   - `buildLog`      the log lines, taken only from what the run really produced
 *   - `tossAt`        where a concept word is on its way into the pot at a given frame
 * Nothing here talks to the network or to the clock.
 */

import type { GenerationState } from "./generation";
import type { Expression } from "@/lib/ascii";

/** "00:08", "12:05". Negative or fractional input is clamped and floored. */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

export function hazelLine(state: Pick<GenerationState, "stage" | "status">): string {
  if (state.status === "failed") return "Something went wrong at the cauldron. We can try that step again.";
  switch (state.stage) {
    case "analyzing":
      return "Let me read through your material and fish out the key ideas.";
    case "reviewing":
      return "This is what I found in your material. Drop anything that does not belong, then let me keep stirring.";
    case "planning":
      return "Now I am designing a world and a cast around these concepts.";
    case "writing":
      return "Writing your story. Every concept becomes one chapter.";
    case "animating":
      return "Almost there. I am animating the lessons.";
    case "done":
      return "Your world is ready.";
  }
}

export function hazelExpression(state: Pick<GenerationState, "stage" | "status">): Expression {
  if (state.status === "failed") return "worried";
  if (state.stage === "reviewing" || state.stage === "done") return "smile";
  return "calm";
}

export type LogTone = "lore" | "add" | "warn";
export type LogLine = { tone: LogTone; text: string };

const MAX_LOG_LINES = 14;

/** The log of this run, oldest first, trimmed to the last lines that fit the box. */
export function buildLog(state: GenerationState): LogLine[] {
  const lines: LogLine[] = [{ tone: "lore", text: "lore › reading your material" }];
  if (state.material) {
    for (const concept of state.material.concepts) lines.push({ tone: "add", text: `+ ${concept.name}` });
  }
  if (state.stage === "reviewing" && state.status !== "failed") {
    lines.push({ tone: "lore", text: "lore › waiting for your review…" });
  }
  if (state.stage !== "analyzing" && state.stage !== "reviewing") {
    lines.push({ tone: "lore", text: `lore › kept ${state.selectedConceptIds.length} concepts` });
  }
  if (state.campaign) {
    lines.push({ tone: "add", text: `+ world: ${state.campaign.title}` });
    for (const c of state.campaign.characters) lines.push({ tone: "add", text: `+ ${c.name} · ${c.role}` });
  }
  for (const story of Object.values(state.stories)) lines.push({ tone: "add", text: `+ story: ${story.title}` });
  if (state.stage === "animating" && state.status !== "failed") {
    lines.push({ tone: "lore", text: "lore › animating the lessons…" });
  }
  if (state.status === "failed") lines.push({ tone: "warn", text: "! this step failed" });
  return lines.slice(-MAX_LOG_LINES);
}

/** Frames one concept word takes to fly from the edge into the pot. */
export const TOSS_FRAMES = 10;
/** Frames between two words leaving. */
export const TOSS_GAP = 5;

export type Toss = { word: number; x: number; y: number };

/**
 * The concept word in flight at `frame`, as fractions of the toss area: `x` runs 0 (left edge)
 * to 1 (the pot), `y` follows an arc (0 at the top, 1 at the bottom, the pot being at 1).
 * Returns null while the gap between two words runs or when there is nothing to toss.
 */
export function tossAt(frame: number, wordCount: number): Toss | null {
  if (wordCount <= 0 || frame < 0) return null;
  const slot = TOSS_FRAMES + TOSS_GAP;
  const word = Math.floor(frame / slot) % wordCount;
  const step = frame % slot;
  if (step >= TOSS_FRAMES) return null;
  const t = step / (TOSS_FRAMES - 1);
  // A thrown arc: rises first, then drops into the pot.
  const y = 0.55 - 0.5 * Math.sin(Math.PI * Math.min(1, t * 1.15)) + t * t * 0.45;
  return { word, x: t, y: Math.min(1, Math.max(0, y)) };
}
