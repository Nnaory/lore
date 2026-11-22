/**
 * Hazel's greeting on Home option B (docs/DESIGN-SYSTEM.md §4.7).
 *
 * Pure state: whether a file is attached decides her expression and her line.
 * No file: she smiles and asks for notes as a file (a topic alone is not
 * enough, a file is required). With a file: she is surprised and asks for
 * focus instructions. Removing the file returns her to the first state.
 * The canvas line "Tell me a topic, or toss your notes..." is changed on
 * purpose because it implied a topic was enough.
 */

export type HazelExpression = "smile" | "surprised";

export interface HazelGreeting {
  expression: HazelExpression;
  line: string;
  /** Label of the file button: "Add file" or "Replace". */
  fileLabel: "Add file" | "Replace";
}

export const HAZEL_LINE_NO_FILE =
  "Welcome, traveler. What shall we learn tonight? Toss your notes into my cauldron as a file, and I'll brew a world from them.";

export const HAZEL_LINE_WITH_FILE =
  "Ooh, lecture notes! Into the cauldron they go. Add a word or two about what to focus on, then let's brew.";

export function hazelGreeting(hasFile: boolean): HazelGreeting {
  return hasFile
    ? { expression: "surprised", line: HAZEL_LINE_WITH_FILE, fileLabel: "Replace" }
    : { expression: "smile", line: HAZEL_LINE_NO_FILE, fileLabel: "Add file" };
}
