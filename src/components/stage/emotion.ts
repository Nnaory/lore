/**
 * Character emotions shown on the stage, and how story expression keys
 * (written by the story data / AI, e.g. "nervous", "approving") map onto them.
 */

export type Emotion = "idle" | "explaining" | "thinking" | "worried" | "happy" | "stern" | "surprised";

const KEYWORDS: Array<[Emotion, RegExp]> = [
  ["worried", /worr|nerv|anx|afraid|scare|sad|concern|fear|tense/],
  ["happy", /happ|approv|reliev|excit|smil|joy|proud|glad|cheer/],
  ["stern", /stern|serious|angr|firm|strict|cold|grim/],
  ["surprised", /surpri|shock|amaz|astonish|startl/],
  ["thinking", /think|curio|focus|ponder|wonder|puzzl|calm/],
  ["explaining", /expla|teach|point|lectur/],
];

/** Map a free-form expression key to a stage emotion ("idle" when unknown). */
export function emotionFor(expressionKey: string | undefined): Emotion {
  const key = (expressionKey ?? "").toLowerCase();
  for (const [emotion, pattern] of KEYWORDS) if (pattern.test(key)) return emotion;
  return "idle";
}
