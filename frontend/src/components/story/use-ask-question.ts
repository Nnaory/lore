/**
 * useAskQuestion — manages inline mid-story Q&A state for StoryViewer.
 *
 * Keeps the request/response lifecycle cleanly isolated from Stage JSX:
 *   - Sends full MaterialBlueprint[], StoryBlueprint, CampaignBlueprint, playerKnowledge,
 *     active scene/beat pointer, recent story log, and multi-turn Q&A history.
 *   - Cancels stale requests when retrying, advancing scenes, or unmounting.
 *   - Scopes active Q&A state to its originating sceneId (derived, no sync useEffect).
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatEntry } from "@/components/stage/chat-entry";
import type { AskTurn } from "@/lib/contracts/ai-requests";
import { buildAskQuestionPayload, postAskQuestion } from "@/lib/story/ask-client";
import type { CampaignBlueprint, Character } from "@/lib/types/campaign";
import type { PlayerKnowledge } from "@/lib/types/game";
import type { MaterialBlueprint } from "@/lib/types/material";
import type { StoryBlueprint } from "@/lib/types/story";

export type QaState =
  | {
      status: "loading";
      sceneId: string;
      key: string;
      characterId: string;
      name: string;
      expression: string;
      expressionKey: string;
    }
  | {
      status: "answered";
      sceneId: string;
      key: string;
      entry: Extract<ChatEntry, { kind: "answer" }>;
    }
  | {
      status: "error";
      sceneId: string;
      key: string;
      message: string;
    };

export interface UseAskQuestionOptions {
  story: StoryBlueprint;
  characters: Character[];
  campaign?: CampaignBlueprint;
  materials?: MaterialBlueprint[];
  sceneId: string | undefined;
  chapterId?: string;
  chapterTitle?: string;
  blockIndex: number;
  speaker?: Character;
  recentLog: readonly ChatEntry[];
  playerKnowledge: Record<string, PlayerKnowledge>;
  canAsk: boolean;
  onAppendLog: (entry: ChatEntry) => void;
  fetchImpl?: typeof fetch;
}

export function useAskQuestion({
  story,
  characters,
  campaign,
  materials,
  sceneId,
  chapterId,
  chapterTitle,
  blockIndex,
  speaker,
  recentLog,
  playerKnowledge,
  canAsk,
  onAppendLog,
  fetchImpl,
}: UseAskQuestionOptions) {
  const [qaState, setQaState] = useState<QaState | null>(null);
  const [qaTurns, setQaTurns] = useState<AskTurn[]>([]);
  const controllerRef = useRef<AbortController | null>(null);
  const seqRef = useRef(0);
  const currentSceneRef = useRef(sceneId);
  useEffect(() => {
    currentSceneRef.current = sceneId;
  }, [sceneId]);

  const abortInFlight = useCallback(() => {
    controllerRef.current?.abort("reset");
    controllerRef.current = null;
  }, []);

  useEffect(() => {
    abortInFlight();
  }, [sceneId, abortInFlight]);

  useEffect(() => () => abortInFlight(), [abortInFlight]);

  // Scoped to the active scene so advancing scenes drops stale replies without an effect setState.
  const activeQa = qaState && sceneId && qaState.sceneId === sceneId ? qaState : null;
  const isAsking = activeQa?.status === "loading";

  const clearQa = useCallback(() => {
    abortInFlight();
    setQaState(null);
  }, [abortInFlight]);

  const resetQaHistory = useCallback(() => {
    abortInFlight();
    seqRef.current += 1;
    setQaState(null);
    setQaTurns([]);
  }, [abortInFlight]);

  const ask = useCallback(
    async (rawQuestion: string) => {
      const trimmed = rawQuestion.trim();
      if (!trimmed || !canAsk || !sceneId || isAsking) return;

      const resolvedSpeaker = speaker ?? characters[0];
      const characterId = resolvedSpeaker?.character_id ?? "tutor";
      const name = resolvedSpeaker?.name ?? "Guide";
      const calmExpression = resolvedSpeaker?.expressions.calm ?? "(calm)";

      abortInFlight();
      const controller = new AbortController();
      controllerRef.current = controller;
      const seq = ++seqRef.current;

      onAppendLog({ kind: "question", text: trimmed });
      setQaState({
        status: "loading",
        sceneId,
        key: `qa:loading:${seq}`,
        characterId,
        name,
        expression: calmExpression,
        expressionKey: "calm",
      });

      const payload = buildAskQuestionPayload({
        question: trimmed,
        story,
        characters,
        campaign,
        materials,
        sceneId,
        chapterId,
        chapterTitle,
        blockIndex,
        speakerCharacterId: resolvedSpeaker?.character_id,
        recentLog,
        qaHistory: qaTurns,
        playerKnowledge,
      });

      const result = await postAskQuestion(payload, { signal: controller.signal, fetchImpl });
      if (seq !== seqRef.current || currentSceneRef.current !== sceneId) return;
      if (controllerRef.current === controller) controllerRef.current = null;
      if (!result.ok) {
        if (result.aborted) return;
        setQaState({
          status: "error",
          sceneId,
          key: `qa:error:${seq}`,
          message: result.message,
        });
        return;
      }

      const expressionKey = result.reply.expression;
      const answerEntry: Extract<ChatEntry, { kind: "answer" }> = {
        kind: "answer",
        characterId,
        name,
        expression: resolvedSpeaker?.expressions[expressionKey] ?? `(${expressionKey})`,
        expressionKey,
        text: result.reply.answer,
      };
      onAppendLog(answerEntry);
      setQaTurns((prev) => [...prev, { question: trimmed, answer: result.reply.answer }]);
      setQaState({
        status: "answered",
        sceneId,
        key: `qa:answer:${seq}`,
        entry: answerEntry,
      });
    },
    [
      abortInFlight,
      blockIndex,
      campaign,
      canAsk,
      chapterId,
      chapterTitle,
      characters,
      fetchImpl,
      isAsking,
      materials,
      onAppendLog,
      playerKnowledge,
      qaTurns,
      recentLog,
      sceneId,
      speaker,
      story,
    ],
  );

  return {
    activeQa,
    isAsking,
    ask,
    clearQa,
    resetQaHistory,
  };
}
