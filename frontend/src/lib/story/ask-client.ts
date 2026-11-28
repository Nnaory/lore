/**
 * Client for mid-story Q&A (`POST /api/v1/ai/ask`).
 *
 * Pure request builder and HTTP wrapper separated from React state (`use-ask-question.ts`).
 */

import { z } from "zod";
import {
  AskQuestionReplySchema,
  type AskKnowledgeEntry,
  type AskLogItem,
  type AskQuestionReply,
  type AskQuestionRequest,
  type AskTurn,
} from "@/lib/contracts/ai-requests";
import { askErrorMessage } from "@/lib/contracts/error-messages";
import { aiUrl } from "@/lib/generation/ai-endpoints";
import type { ChatEntry } from "@/components/stage/chat-entry";
import type { CampaignBlueprint, Character } from "@/lib/types/campaign";
import type { PlayerKnowledge } from "@/lib/types/game";
import type { MaterialBlueprint } from "@/lib/types/material";
import type { StoryBlueprint } from "@/lib/types/story";

export const ASK_TIMEOUT_MS = 45_000;
const MAX_RECENT_LOG = 12;
const MAX_QA_HISTORY = 8;

const ErrorEnvelope = z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) });
const AskSuccessEnvelope = z.object({
  ok: z.literal(true),
  data: z.object({ reply: AskQuestionReplySchema }),
});

export type AskResult =
  | { ok: true; reply: AskQuestionReply }
  | { ok: false; message: string; aborted?: boolean };

/** Synthesize minimal campaign context when StoryViewer runs standalone (without CampaignPlayer). */
export function fallbackCampaignForStory(story: StoryBlueprint, characters: Character[]): CampaignBlueprint {
  const safeCharacters: Character[] =
    characters.length > 0
      ? characters
      : [
          {
            character_id: "tutor",
            name: "Guide",
            role: "Story Guide",
            description: "An encouraging guide explaining concepts clearly.",
            expressions: { calm: "(._.)" },
          },
        ];

  return {
    campaign_id: `campaign_${story.story_id}`,
    title: story.title,
    genre: "fantasy",
    tone: "educational",
    premise: story.summary,
    main_conflict: story.summary,
    setting: "Story World",
    characters: safeCharacters,
    world_rules: [],
    story_sequence: [
      {
        story_id: story.story_id,
        material_id: story.material_id,
        title: story.title,
        purpose: story.summary,
        main_conflict: story.summary,
        required_knowledge: [],
        outcomes: [],
      },
    ],
  };
}

export function compactPlayerKnowledge(
  knowledge: Record<string, PlayerKnowledge> | undefined,
): Record<string, AskKnowledgeEntry> | undefined {
  if (!knowledge) return undefined;
  const entries = Object.entries(knowledge).map(([key, pk]) => [
    key,
    { concept_id: pk.concept_id, status: pk.status },
  ] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function compactLogEntries(entries: readonly ChatEntry[]): AskLogItem[] {
  return entries.slice(-MAX_RECENT_LOG).map((entry) => {
    if (entry.kind === "dialogue" || entry.kind === "answer") {
      return { kind: entry.kind, speaker: entry.name, text: entry.text };
    }
    if (entry.kind === "lesson") {
      return { kind: "lesson", title: entry.title, text: entry.text };
    }
    return { kind: entry.kind, text: entry.text };
  });
}

export interface BuildAskPayloadInput {
  question: string;
  story: StoryBlueprint;
  characters: Character[];
  campaign?: CampaignBlueprint;
  materials?: MaterialBlueprint[];
  sceneId: string;
  chapterId?: string;
  chapterTitle?: string;
  blockIndex?: number;
  speakerCharacterId?: string;
  recentLog?: readonly ChatEntry[];
  qaHistory?: readonly AskTurn[];
  playerKnowledge?: Record<string, PlayerKnowledge>;
}

export function buildAskQuestionPayload(input: BuildAskPayloadInput): AskQuestionRequest {
  const recentLog = input.recentLog ? compactLogEntries(input.recentLog) : [];
  const qaHistory = input.qaHistory ? input.qaHistory.slice(-MAX_QA_HISTORY) : [];
  const playerKnowledge = compactPlayerKnowledge(input.playerKnowledge);

  return {
    question: input.question.trim(),
    campaign: input.campaign ?? fallbackCampaignForStory(input.story, input.characters),
    story: input.story,
    materials: input.materials ?? [],
    context: {
      scene_id: input.sceneId,
      ...(input.chapterId ? { chapter_id: input.chapterId } : {}),
      ...(input.chapterTitle ? { chapter_title: input.chapterTitle } : {}),
      ...(input.blockIndex !== undefined && input.blockIndex >= 0
        ? { block_index: input.blockIndex }
        : {}),
      ...(input.speakerCharacterId ? { speaker_character_id: input.speakerCharacterId } : {}),
      ...(recentLog.length > 0 ? { recent_log: recentLog } : {}),
      ...(qaHistory.length > 0 ? { qa_history: qaHistory } : {}),
      ...(playerKnowledge ? { player_knowledge: playerKnowledge } : {}),
    },
  };
}

export async function postAskQuestion(
  payload: AskQuestionRequest,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<AskResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutController = new AbortController();
  const timeoutMs = options.timeoutMs ?? ASK_TIMEOUT_MS;
  const timer = setTimeout(() => timeoutController.abort("timeout"), timeoutMs);

  const forwardAbort = () => timeoutController.abort(options.signal?.reason ?? "aborted");
  if (options.signal?.aborted) {
    clearTimeout(timer);
    return { ok: false, message: "", aborted: true };
  }
  options.signal?.addEventListener("abort", forwardAbort, { once: true });

  let response: Response;
  try {
    response = await fetchImpl(aiUrl("ask"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: timeoutController.signal,
    });
  } catch {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", forwardAbort);
    if (options.signal?.aborted) return { ok: false, message: "", aborted: true };
    if (timeoutController.signal.aborted) return { ok: false, message: askErrorMessage("TIMEOUT") };
    return { ok: false, message: askErrorMessage("NETWORK") };
  }

  clearTimeout(timer);
  options.signal?.removeEventListener("abort", forwardAbort);

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { ok: false, message: askErrorMessage("UNKNOWN") };
  }

  const failure = ErrorEnvelope.safeParse(json);
  if (failure.success) return { ok: false, message: askErrorMessage(failure.data.error.code) };

  const parsed = AskSuccessEnvelope.safeParse(json);
  if (!response.ok || !parsed.success) {
    return { ok: false, message: askErrorMessage("UNKNOWN") };
  }
  return { ok: true, reply: parsed.data.data.reply };
}
