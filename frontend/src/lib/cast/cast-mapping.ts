/**
 * Cast mapping: turns campaign characters and free-form expression keys into
 * the Kit's five built-in cast members and five expressions.
 *
 * Why: the AI writes arbitrary character ids and expression words, but the
 * Kit can only draw `eldric | mira | hazel | varr | nyx` with
 * `calm | smile | worried | surprised | angry`. Everything here is pure and
 * total (no throws); failures come back as `{ ok: false, reason, value }` so
 * the UI can fall back (unknown expression -> `calm`, unmapped character ->
 * deterministic cast allocation) without stopping the story.
 *
 * Expression keywords deliberately reuse `emotionFor` so the already-tested
 * emotion logic stays the single source of truth.
 */
import type { CastId, Expression } from "@/lib/ascii/figure";
import { emotionFor, type Emotion } from "@/components/stage/emotion";
import { stableHash } from "@/lib/contracts/hash";
import type { Character } from "@/lib/types/campaign";

/** Cast order used for fallback allocation. */
export const CAST_ORDER: readonly CastId[] = ["eldric", "mira", "hazel", "varr", "nyx"];

/** Display name of the tag shown for narration or an unknown speaker. */
export const NARRATION_TAG = "NARRATION";

export type CastMapping =
  | { ok: true; castId: CastId; matchedBy: "id" | "name" }
  | { ok: false; reason: "unknown_character" | "empty_character"; value: string };

export type ExpressionMapping =
  | { ok: true; expression: Expression }
  | { ok: false; reason: "unknown_expression" | "empty_expression"; value: string };

export type CastAllocation = { castId: CastId; mapped: boolean };

function normalize(text: unknown): string {
  return typeof text === "string" ? text.trim().toLowerCase() : "";
}

function asCastId(text: string): CastId | null {
  return (CAST_ORDER as readonly string[]).includes(text) ? (text as CastId) : null;
}

/** Map a campaign character to a Kit cast member by id first, then by name. */
export function mapCharacter(c: { character_id: string; name: string }): CastMapping {
  const rawId = typeof c?.character_id === "string" ? c.character_id : "";
  const id = normalize(rawId);
  const name = normalize(c?.name);
  if (id === "" && name === "") return { ok: false, reason: "empty_character", value: rawId };
  const byId = asCastId(id);
  if (byId) return { ok: true, castId: byId, matchedBy: "id" };
  const byName = asCastId(name);
  if (byName) return { ok: true, castId: byName, matchedBy: "name" };
  return { ok: false, reason: "unknown_character", value: rawId };
}

const EMOTION_TO_EXPRESSION: Record<Emotion, Expression> = {
  idle: "calm",
  explaining: "calm",
  thinking: "calm",
  worried: "worried",
  happy: "smile",
  stern: "angry",
  surprised: "surprised",
};

/** Total table used for state overrides (puzzle, ending, answer reaction, failed). */
export function emotionToExpression(e: Emotion): Expression {
  return EMOTION_TO_EXPRESSION[e] ?? "calm";
}

const NEUTRAL_KEYWORDS = /neutral|idle|default|normal/;

/** Map a free-form expression key to one of the Kit's five expressions. */
export function mapExpression(key: string | undefined): ExpressionMapping {
  const raw = typeof key === "string" ? key : "";
  const normalized = normalize(raw);
  if (normalized === "") return { ok: false, reason: "empty_expression", value: raw };
  const emotion = emotionFor(normalized);
  if (emotion !== "idle") return { ok: true, expression: emotionToExpression(emotion) };
  if (NEUTRAL_KEYWORDS.test(normalized)) return { ok: true, expression: "calm" };
  return { ok: false, reason: "unknown_expression", value: raw };
}

function startIndex(characterId: string): number {
  const n = parseInt(stableHash(characterId), 36);
  return (Number.isFinite(n) ? n : 0) % CAST_ORDER.length;
}

/**
 * Allocate a cast member to every campaign character, once per campaign.
 * Mapped characters keep their cast (first wins on collision); the rest take
 * the first free cast starting at `stableHash(character_id) mod 5`, searching
 * forward in cast order. From the 6th character on, casts are shared.
 */
export function resolveCampaignCast(chars: readonly Character[]): ReadonlyMap<string, CastAllocation> {
  const result = new Map<string, CastAllocation>();
  const taken = new Set<CastId>();
  const pending: string[] = [];
  const seen = new Set<string>();

  for (const c of chars ?? []) {
    if (seen.has(c.character_id)) continue;
    seen.add(c.character_id);
    const mapping = mapCharacter(c);
    if (mapping.ok && !taken.has(mapping.castId)) {
      taken.add(mapping.castId);
      result.set(c.character_id, { castId: mapping.castId, mapped: true });
    } else {
      pending.push(c.character_id);
    }
  }

  for (const id of pending) {
    const start = startIndex(id);
    let chosen: CastId = CAST_ORDER[start];
    for (let i = 0; i < CAST_ORDER.length; i++) {
      const candidate = CAST_ORDER[(start + i) % CAST_ORDER.length];
      if (!taken.has(candidate)) {
        chosen = candidate;
        break;
      }
    }
    taken.add(chosen);
    result.set(id, { castId: chosen, mapped: false });
  }
  return result;
}

/**
 * Name tag for a speaker: the character's real name, or `NARRATION` for the
 * narrator or an id that is not in the campaign.
 */
export function speakerTagName(speakerId: string | undefined, chars: readonly Character[]): string {
  const id = normalize(speakerId);
  if (id === "" || id === "narrator") return NARRATION_TAG;
  const found = (chars ?? []).find((c) => c.character_id === speakerId);
  return found && found.name.trim() !== "" ? found.name : NARRATION_TAG;
}
