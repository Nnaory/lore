/**
 * StoryViewer — the Stage (docs/DESIGN-SYSTEM.md §4.1, §4.3, §4.4)
 *
 * A fixed 1440x900 (desktop) / 390x844 (phone) board scaled as a whole by
 * `ScaledBoard`. One tree serves both layouts, so layout switches do not
 * remount state:
 *
 *   StageHud, then the stage panel with
 *   StageScene (ASCII), CanvasPane (only for lesson, visual and puzzle, OQ-12),
 *   StageSprite (speaker), StageDialogue (typewriter, choices on phone, shortcuts)
 *   and an overlay for endings, completion, failure and navigation errors.
 *
 * Hoisted above the layout switch: useStoryPlayer, pacing, the story log, the
 * answer reaction, the log/exit modals and `usePuzzleInteraction` (via
 * PuzzleScope). Modals render outside the board.
 *
 * Story logic is unchanged: useStoryPlayer drives navigation/HP/bad branches,
 * right and wrong come only from usePuzzleInteraction, and knowledge evidence
 * is reported through onKnowledgeUpdate.
 *
 * AI animations (design 7.6, K-6, Requirements 30.11 to 30.13, 30.17, 31.2, 36.7). Only when the
 * build flag is on (`readAnimationsFlag`) and the puzzle has an `animation`, or the lesson has a
 * visual and `animationForStep` finds a reference for its step, the scene the Stage would draw
 * becomes the `fallback` of an `{ kind: "animation" }` scene. Nothing else about `framed` changes:
 * the key is the one the Stage already used (`puzzle:<id>`, or the step key of a drawn lesson), so
 * one iframe keeps playing across the chunks of one lesson step. With the flag off, or without a
 * reference, `withAnimation` returns the old scene object untouched, so the Stage is exactly what
 * it was before the feature and nothing asks the animation API for anything. The animation gets
 * the answer only through `CanvasPane` (`interaction.isCorrect`); no message from the iframe
 * reaches `useStoryPlayer`, `usePuzzleInteraction` or `validateMultipleChoice`.
 */

"use client";

import { useEffect, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import type { StoryBlueprint } from "@/lib/types/story";
import type { CampaignBlueprint, Character, Genre } from "@/lib/types/campaign";
import type { PlayerKnowledge } from "@/lib/types/game";
import type { MaterialBlueprint } from "@/lib/types/material";
import type { Scene, SceneContent } from "@/lib/types/scene";
import type { AnimationReference } from "@/lib/types/animation";
import { readAnimationsFlag } from "@/lib/animation/flags";
import { animationForStep } from "@/lib/animation/targets";
import { useStoryPlayer } from "@/lib/story/use-story-player";
import { lessonStepInfo } from "@/lib/story/lesson-steps";
import { getSceneContentBlocks, isBadBranchAtEnd, type CharacterIndex } from "@/lib/story/story-player";
import { buildCompletionReport, type RunAnswer } from "@/lib/story/completion-report";
import { loadStoredPacing, motionAllowed, savePacing, type Pacing } from "@/lib/story/pacing";
import { initialTextMode } from "@/lib/dialogue/typewriter";
import { CAST_ORDER, resolveCampaignCast, emotionToExpression, pickOtherCharacter } from "@/lib/cast/cast-mapping";
import { STAGE_BOXES, visibleSprites } from "@/lib/stage/stage-boxes";
import type { StageLayout } from "@/lib/stage/board-scale";
import { stableHash } from "@/lib/contracts/hash";
import {
  getOrCreateKnowledge,
  recordLearningExposure,
  recordPuzzleSubmission,
  getConceptIdsFromScene,
} from "@/lib/game/knowledge-manager";
import { MAX_HP } from "@/lib/game/hp-manager";
import { StoryFailure } from "./StoryFailure";
import { StoryComplete } from "./StoryComplete";
import { EndingDisplay } from "./EndingDisplay";
import { ScaledBoard } from "@/components/stage/ScaledBoard";
import { StageHud } from "@/components/stage/StageHud";
import { StageScene } from "@/components/stage/StageScene";
import { StageSprite } from "@/components/stage/StageSprite";
import { StageDialogue } from "@/components/stage/StageDialogue";
import { KeyHints } from "@/components/stage/KeyHints";
import { PuzzleScope } from "@/components/stage/PuzzleScope";
import {
  CanvasPane,
  PuzzleActions,
  PuzzleChoices,
  PuzzleFeedback,
  type FramedScene,
} from "@/components/stage/CanvasPane";
import type { AnimationSceneProps } from "@/components/stage/StageCanvas";
import type { ChatEntry } from "@/components/stage/chat-entry";
import { ChatLog } from "@/components/stage/ChatLog";
import { emotionFor, type Emotion } from "@/components/stage/emotion";
import { Button } from "@/components/ui/Button";
import { ErrorLine } from "@/components/ui/ErrorLine";
import { Icon } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import { useAskQuestion } from "./use-ask-question";

type StoryViewerProps = {
  story: StoryBlueprint;
  characters: Character[];
  /** Campaign metadata and cast personas used for mid-story Q&A context. */
  campaign?: CampaignBlueprint;
  /** Analyzed source materials used as full educational context for Q&A. */
  materials?: MaterialBlueprint[];
  /** Campaign genre. Unused since the ASCII cast replaced the genre accessories; kept so callers compile. */
  genre?: Genre;
  /** Called when the player completes the story and chooses "Continue Campaign". */
  onStoryComplete?: (opts?: {
    worldStateChanges?: Record<string, number>;
    relationshipChanges?: Record<string, number>;
    outcomeDescription?: string;
  }) => void;
  /** Called when the player exits the story (navbar or completion screen). */
  onExit?: () => void;
  /** True when this was the last story — alters the completion screen. */
  isCampaignComplete?: boolean;
  /** Opens the epilogue and learning evaluation once the campaign is complete. */
  onViewResults?: () => void;
  /** Restarts this story from Scene 1 with full HP (shown on completed campaign replays). */
  onReplay?: () => void;
  /** Called when knowledge state needs updating (learning exposure or puzzle answer). */
  onKnowledgeUpdate?: (updates: Record<string, PlayerKnowledge>) => void;
  /** The current player_knowledge map from CampaignState. */
  playerKnowledge?: Record<string, PlayerKnowledge>;
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function entryForBlock(block: SceneContent, characterIndex: CharacterIndex): ChatEntry {
  if (block.type === "narration") return { kind: "narration", text: block.text };
  if (block.type === "learning_info") return { kind: "lesson", title: block.title, text: block.body };
  const character = characterIndex.get(block.character_id);
  return {
    kind: "dialogue",
    characterId: block.character_id,
    name: character?.name ?? block.character_id,
    expression: character?.expressions[block.expression] ?? `(${block.expression})`,
    expressionKey: block.expression,
    text: block.text,
  };
}

/** Index of the block on screen, or -1 when the scene has no content blocks. */
function visibleBlockIndex(scene: Scene | null, contentIndex: number): number {
  const blocks = scene ? getSceneContentBlocks(scene) : null;
  if (!blocks || blocks.length === 0) return -1;
  return Math.min(contentIndex, blocks.length - 1);
}

/** Who is on stage: the last speaker so far in this scene, else the first character present. */
function speakerFor(scene: Scene | null, blockIndex: number, characters: Character[]): { character?: Character; expression?: string } {
  const blocks = scene ? getSceneContentBlocks(scene) : null;
  const byId = new Map(characters.map((c) => [c.character_id, c]));
  if (blocks) {
    for (let i = blockIndex; i >= 0; i--) {
      const block = blocks[i];
      if (block?.type === "dialogue" && byId.has(block.character_id)) {
        return { character: byId.get(block.character_id), expression: block.expression };
      }
    }
  }
  const present = scene?.characters_present.find((id) => byId.has(id));
  return { character: (present && byId.get(present)) || characters[0] };
}

function askPlaceholderFor(opts: {
  isAsking: boolean;
  sceneType: Scene["type"] | undefined;
  canAsk: boolean;
  speakerName: string;
  phone: boolean;
}): string {
  if (opts.isAsking) return `Asking ${opts.speakerName}…`;
  if (opts.sceneType === "puzzle") {
    return opts.phone ? "Solve puzzle first" : `Finish the puzzle to ask ${opts.speakerName}…`;
  }
  if (!opts.canAsk) return "Story ended";
  return opts.phone ? `Ask ${opts.speakerName}…` : `Ask ${opts.speakerName} something…`;
}

/**
 * The scene to hand to `CanvasPane`: `fallback` itself (the same object) without a reference, or
 * an `animation` scene that carries `fallback` as its Fallback_Scene. The caller passes no
 * reference when the build flag is off, so this is the only place that wraps.
 */
function withAnimation(fallback: AnimationSceneProps["fallback"], reference: AnimationReference | undefined): FramedScene {
  return reference ? { kind: "animation", props: { animation: reference, fallback } } : fallback;
}

/** Region above the dialogue box that endings, completion, failure and errors cover. */
const OVERLAY_BOX: Record<StageLayout, { left: number; top: number; width: number; height: number }> = {
  desktop: { left: 0, top: 0, width: 1440, height: 598 },
  phone: { left: 0, top: 56, width: 390, height: 522 },
};

/** The full-screen foreground Stage region in board coordinates (below the HUD on desktop). */
const PANEL_BOX: Record<StageLayout, { left: number; top: number; width: number; height: number }> = {
  desktop: {
    left: STAGE_BOXES.desktop.stage.x,
    top: STAGE_BOXES.desktop.stage.y,
    width: STAGE_BOXES.desktop.stage.width,
    height: STAGE_BOXES.desktop.stage.height,
  },
  phone: { left: 0, top: 0, width: 390, height: 844 },
};

/** The completion report column, in board coordinates: full height, half the board wide and centred (desktop), or inset (phone). */
const REPORT_BOX: Record<StageLayout, { left: number; top: number; width: number; height: number }> = {
  desktop: {
    left: STAGE_BOXES.desktop.board.width / 4,
    top: 0,
    width: STAGE_BOXES.desktop.board.width / 2,
    height: STAGE_BOXES.desktop.board.height,
  },
  phone: { left: 12, top: 14, width: 366, height: 816 },
};

function overlay(layout: StageLayout, children: ReactNode) {
  return (
    <div
      data-testid="stage-overlay"
      className="flex items-start justify-center overflow-y-auto bg-ink/90 p-3 md:p-4"
      style={{ position: "absolute", ...OVERLAY_BOX[layout], zIndex: 30 }}
    >
      <div className="flex w-full max-w-[720px] flex-col items-center gap-4">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StoryViewer({
  story,
  characters,
  campaign,
  materials,
  onStoryComplete,
  onExit,
  isCampaignComplete = false,
  onViewResults,
  onReplay,
  onKnowledgeUpdate,
  playerKnowledge = {},
}: StoryViewerProps) {
  const {
    playerState,
    currentScene,
    currentChapter,
    isComplete,
    error,
    hp,
    isFailed,
    characterIndex,
    advance,
    completePuzzle,
    onPuzzleIncorrect,
    onPuzzleBadBranch,
    returnToPuzzle,
    retryStory,
  } = useStoryPlayer(story, characters);

  // Keep a ref to the latest playerKnowledge
  const playerKnowledgeRef = useRef(playerKnowledge);
  useEffect(() => {
    playerKnowledgeRef.current = playerKnowledge;
  });

  // ── Learning exposure: when entering a scene, record learning_info concepts ─
  useEffect(() => {
    if (!currentScene) return;
    if (!onKnowledgeUpdate) return;

    const conceptIds = getConceptIdsFromScene(story, currentScene.scene_id);
    if (conceptIds.length === 0) return;

    const updates: Record<string, PlayerKnowledge> = {};
    for (const conceptId of conceptIds) {
      const current = getOrCreateKnowledge(playerKnowledge, conceptId);
      const updated = recordLearningExposure(current, currentScene.scene_id);
      if (updated !== current) {
        updates[conceptId] = updated;
      }
    }
    if (Object.keys(updates).length > 0) {
      onKnowledgeUpdate(updates);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentScene?.scene_id, story.story_id]);

  // ── Character reactions to answers (held while still on that scene) ───────
  const [reaction, setReaction] = useState<{ sceneId: string; emotion: Emotion } | null>(null);

  // ── This run's judged answers and start time, for the completion screen ───
  const [answers, setAnswers] = useState<RunAnswer[]>([]);
  const [runStartedAt, setRunStartedAt] = useState(() => Date.now());

  // ── Puzzle answer handler ─────────────────────────────────────────────────
  const handlePuzzleAnswerSubmitted = useCallback(
    (correct: boolean) => {
      if (!currentScene || currentScene.type !== "puzzle") return;

      const puzzleId = currentScene.puzzle_id;
      const puzzle = story.puzzles.find((p) => p.puzzle_id === puzzleId);
      if (!puzzle) return;

      setReaction({ sceneId: currentScene.scene_id, emotion: correct ? "happy" : "worried" });
      setAnswers((prev) => [...prev, { puzzleId, correct }]);

      if (onKnowledgeUpdate) {
        const latestKnowledge = playerKnowledgeRef.current;
        const updates: Record<string, PlayerKnowledge> = {};
        for (const conceptId of puzzle.concept_ids) {
          const current = getOrCreateKnowledge(latestKnowledge, conceptId);
          const updated = recordPuzzleSubmission(current, puzzleId, correct);
          if (updated !== current) {
            updates[conceptId] = updated;
          }
        }
        if (Object.keys(updates).length > 0) {
          onKnowledgeUpdate(updates);
        }
      }
    },
    [currentScene, story.puzzles, onKnowledgeUpdate]
  );

  // Derive ending data for the StoryComplete callback
  function handleContinueCampaign() {
    const endingScene = story.chapters.flatMap((c) => c.scenes).find((s) => s.type === "ending");
    let worldStateChanges: Record<string, number> | undefined;
    let relationshipChanges: Record<string, number> | undefined;
    let outcomeDescription: string | undefined;

    if (endingScene?.type === "ending") {
      const ending = story.endings.find((e) => e.ending_id === endingScene.ending_id);
      if (ending) {
        worldStateChanges = ending.world_state_changes;
        relationshipChanges = ending.relationship_changes;
        outcomeDescription = ending.title;
      }
    }

    onStoryComplete?.({ worldStateChanges, relationshipChanges, outcomeDescription });
  }

  // ── UI state ───────────────────────────────────────────────────────────────
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [showLog, setShowLog] = useState(false);
  // Starts "fast" so the server render and first client render show the full line (no
  // hydration mismatch); the saved choice, or "animate" unless reduced motion, is applied after.
  const [pacing, setPacing] = useState<Pacing>("fast");
  useEffect(() => {
    // The saved preference lives in localStorage (browser only).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPacing(initialTextMode(loadStoredPacing(), !motionAllowed()));
  }, []);
  function changePacing(next: Pacing) {
    setPacing(next);
    savePacing(next);
  }

  // ── What is on screen ──────────────────────────────────────────────────────
  const navigationError = error;
  const blockIndex = visibleBlockIndex(currentScene, playerState.contentIndex);
  const blocks = currentScene ? getSceneContentBlocks(currentScene) : null;
  const currentBlock = blocks && blockIndex >= 0 ? blocks[blockIndex] : null;
  const puzzle =
    currentScene?.type === "puzzle" ? story.puzzles.find((p) => p.puzzle_id === currentScene.puzzle_id) : undefined;
  const ending =
    currentScene?.type === "ending" ? story.endings.find((e) => e.ending_id === currentScene.ending_id) : undefined;

  let entry: ChatEntry | null = null;
  if (isFailed) entry = { kind: "narration", text: "You have run out of HP. The story stops here — for now." };
  else if (currentBlock) entry = entryForBlock(currentBlock, characterIndex);
  else if (puzzle) entry = { kind: "narration", text: `${puzzle.narrative_context} Choose your answer on the board.` };
  else if (ending) entry = { kind: "narration", text: `— ${ending.title} —` };
  const entryKey = `${story.story_id}:${currentScene?.scene_id ?? ""}:${blockIndex}:${isFailed ? "failed" : ""}`;

  // ── Story log (lines seen in this run) ─────────────────────────────────────
  const [log, setLog] = useState<ChatEntry[]>([]);
  const loggedKeys = useRef(new Set<string>());
  useEffect(() => {
    if (!entry || isFailed || loggedKeys.current.has(entryKey)) return;
    loggedKeys.current.add(entryKey);
    setLog((prev) => [...prev, entry]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryKey]);

  const appendLogEntry = useCallback((item: ChatEntry) => {
    setLog((prev) => [...prev, item]);
  }, []);

  // ── Character on stage & mid-story Q&A ────────────────────────────────────
  const speaker = speakerFor(currentScene, blockIndex, characters);
  const canAsk = Boolean(
    !isFailed &&
      !isComplete &&
      !navigationError &&
      currentScene !== null &&
      currentScene.type !== "puzzle" &&
      currentScene.type !== "ending"
  );
  const { activeQa, isAsking, ask, clearQa, resetQaHistory } = useAskQuestion({
    story,
    characters,
    campaign,
    materials,
    sceneId: currentScene?.scene_id,
    chapterId: currentChapter?.chapter_id,
    chapterTitle: currentChapter?.title,
    blockIndex,
    speaker: speaker.character,
    recentLog: log,
    playerKnowledge,
    canAsk,
    onAppendLog: appendLogEntry,
  });

  function handleRetry() {
    retryStory();
    resetQaHistory();
    loggedKeys.current.clear();
    setLog([]);
    setReaction(null);
    setAnswers([]);
    setRunStartedAt(Date.now());
  }

  // ── Advancing ──────────────────────────────────────────────────────────────
  const badBranchDone = currentScene !== null && isBadBranchAtEnd(playerState, currentScene);
  const canAdvanceStory =
    currentScene !== null &&
    currentScene.type !== "puzzle" &&
    !isComplete &&
    !isFailed &&
    !navigationError &&
    playerState.status !== "story_complete" &&
    !badBranchDone;

  // ── Display & emotion (overlay active Q&A reply cleanly over paused beat) ──
  let emotion: Emotion = emotionFor(speaker.expression);
  if (currentBlock?.type === "learning_info") emotion = "explaining";
  if (puzzle) emotion = "thinking";
  if (ending) emotion = ending.type === "success" ? "happy" : "worried";
  if (reaction && reaction.sceneId === currentScene?.scene_id) emotion = reaction.emotion;
  if (isFailed) emotion = "worried";

  let displayEntry: ChatEntry | null = entry;
  let displayEntryKey = entryKey;
  let displayCanAdvance = canAdvanceStory;
  let displayOnAdvance = advance;
  if (activeQa) {
    displayEntryKey = activeQa.key;
    displayCanAdvance = activeQa.status !== "loading";
    displayOnAdvance = clearQa;
    if (activeQa.status === "loading") {
      displayEntry = {
        kind: "dialogue",
        characterId: activeQa.characterId,
        name: activeQa.name,
        expression: activeQa.expression,
        expressionKey: activeQa.expressionKey,
        text: "Thinking…",
      };
      emotion = "thinking";
    } else if (activeQa.status === "answered") {
      displayEntry = activeQa.entry;
      emotion = emotionFor(activeQa.entry.expressionKey);
    } else {
      displayEntry = { kind: "narration", text: activeQa.message };
      emotion = "worried";
    }
  }

  const askSpeakerName = speaker.character?.name ?? "a character";
  const askDisabled = !canAsk || isAsking;


  const castMap = useMemo(() => resolveCampaignCast(characters), [characters]);
  const castId = speaker.character ? castMap.get(speaker.character.character_id)?.castId : undefined;
  // Same emotion logic as before; the Kit has five expressions, so it maps down.
  const expression = emotionToExpression(emotion);
  const otherCharacter = pickOtherCharacter(
    currentScene?.characters_present,
    speaker.character?.character_id,
    characters
  );
  const otherCastId = otherCharacter ? castMap.get(otherCharacter.character_id)?.castId : undefined;

  // ── Completion screen (good ending only) ───────────────────────────────────
  const atGoodEnding =
    !navigationError && !isFailed && isComplete && Boolean(ending) && !playerState.returnToPuzzleSceneId;
  const completionReport = useMemo(() => buildCompletionReport(story, answers), [story, answers]);
  const completionCast = useMemo(() => {
    const inStory = characters.filter((c) => story.character_ids.includes(c.character_id));
    return (inStory.length > 0 ? inStory : characters).slice(0, CAST_ORDER.length).flatMap((c) => {
      const castId = castMap.get(c.character_id)?.castId;
      return castId ? [{ castId, name: c.name }] : [];
    });
  }, [characters, story.character_ids, castMap]);

  // ── Canvas (OQ-12: a CanvasFrame only for lesson, visual and decision) ─────
  const seed = parseInt(stableHash(story.story_id), 36) % 1000;
  const chapterIndex = Math.max(0, story.chapters.findIndex((c) => c.chapter_id === currentChapter?.chapter_id));
  const canvasLocation = currentScene?.location ?? story.title;

  let framed: { scene: FramedScene; key: string; label: string } | null = null;
  let puzzleMissing = false;
  // Read once per render. Off (or unset) means the animation code below is never reached.
  const animationsOn = readAnimationsFlag();
  if (!navigationError && !isFailed) {
    if (currentScene?.type === "puzzle") {
      if (puzzle) {
        framed = {
          // The AI's picture of the problem when it made one; the question alone otherwise. With
          // the flag on and an animation on the puzzle, that scene is the animation's fallback.
          scene: withAnimation(
            puzzle.visual
              ? { kind: "puzzle", props: { question: puzzle.question, visual: puzzle.visual, seed } }
              : { kind: "decision", props: { label: puzzle.question, seed } },
            animationsOn ? puzzle.animation : undefined
          ),
          key: `puzzle:${puzzle.puzzle_id}`,
          label: canvasLocation,
        };
      } else {
        puzzleMissing = true;
      }
    } else if (currentScene?.type !== "ending" && currentBlock?.type === "learning_info") {
      // A concept may be taught in several steps in one scene, and a long step is stored as
      // several blocks (chunks) with the same title and visual: count steps, not chunks.
      const info = lessonStepInfo(blocks ?? [], blockIndex);
      const step = info ? { index: info.index, total: info.total } : undefined;
      framed = {
        scene: currentBlock.visual
          ? withAnimation(
              { kind: "visual", props: { title: currentBlock.title, visual: currentBlock.visual, seed, step } },
              // The reference sits on the first block of the step, so every chunk finds the same one.
              animationsOn ? animationForStep(blocks ?? [], blockIndex) : undefined
            )
          : { kind: "lesson", props: { title: currentBlock.title, body: currentBlock.body, seed, step } },
        // A drawn visual keeps playing across the chunks of one step; a text lesson shows its chunk.
        key:
          currentBlock.visual && info
            ? `${story.story_id}:${currentScene?.scene_id ?? ""}:lesson:${info.index}`
            : entryKey,
        label: canvasLocation,
      };
    }
  }

  function overlayFor(layout: StageLayout): ReactNode {
    if (navigationError) {
      return overlay(
        layout,
        <div
          data-testid="story-viewer-error"
          role="alert"
          aria-live="assertive"
          className="mx-auto flex w-full max-w-[366px] flex-col items-center gap-3 border-2 border-smoke bg-ink p-5 text-center md:max-w-[720px] md:p-6"
        >
          <p className="font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-gold">
            Navigation Error
          </p>
          <ErrorLine>{navigationError.message}</ErrorLine>
        </div>
      );
    }
    if (isFailed) return overlay(layout, <StoryFailure storyTitle={story.title} onRetry={handleRetry} />);
    if (puzzleMissing && currentScene?.type === "puzzle") {
      return overlay(
        layout,
        <ErrorLine data-testid="scene-error">
          Puzzle not found for {currentScene.puzzle_id}.
        </ErrorLine>
      );
    }
    if (currentScene?.type === "ending") {
      // The good ending is shown by the full-screen completion report (see `completionScreen`).
      if (atGoodEnding) return null;
      const badEnding = Boolean(playerState.returnToPuzzleSceneId);
      return overlay(
        layout,
        <>
          {ending ? (
            <EndingDisplay ending={ending} />
          ) : (
            <ErrorLine data-testid="scene-error">
              Ending not found for {currentScene.ending_id}.
            </ErrorLine>
          )}
          {badEnding ? (
            <div className="flex justify-center">
              <Button variant="outline" data-testid="bad-ending-return-btn" onClick={returnToPuzzle}>
                <Icon name="back" size={16} />
                Try a different choice
              </Button>
            </div>
          ) : (
            isComplete && (
              <StoryComplete
                storyTitle={story.title}
                onContinue={handleContinueCampaign}
                onExit={onExit ?? (() => {})}
                isCampaignComplete={isCampaignComplete}
                onViewResults={onViewResults}
                onReplay={onReplay}
              />
            )
          )}
        </>
      );
    }
    return null;
  }

  const modalOpen = showLog || showExitConfirm;
  const puzzleScopeKey = puzzle && !isFailed && !navigationError ? `puzzle:${puzzle.puzzle_id}` : "none";
  const puzzleCallbacks = {
    onIncorrect: onPuzzleIncorrect,
    onBadBranch: onPuzzleBadBranch,
    onAnswerSubmitted: handlePuzzleAnswerSubmitted,
    isFailed,
    badBranchChoiceIds:
      currentScene?.type === "puzzle" && currentScene.on_incorrect_scene_id
        ? new Set(Object.keys(currentScene.on_incorrect_scene_id))
        : undefined,
  };

  return (
    <div data-testid="story-viewer">
      {/* Full-viewport gameplay canvas without pumpkins; lore-grid-bg fills edge-to-edge in solid ink + 24px grid. */}
      <ScaledBoard
        rootClassName="lore-grid-bg"
        fullBleed={(layout) => (
          <>
            <StageScene fullBleed layout={layout} seed={seed + 1} />
            <div style={atGoodEnding ? { visibility: "hidden" } : undefined}>
              <StageHud
                fullWidth
                layout={layout}
                storyTitle={story.title}
                chapterIndex={chapterIndex}
                chapterCount={story.chapters.length}
                chapterTitle={currentChapter?.title}
                location={currentScene?.location}
                hp={hp}
                failed={isFailed}
                onExit={onExit ? () => setShowExitConfirm(true) : undefined}
              />
            </div>
          </>
        )}
      >
        {(layout) => (
          <PuzzleScope
            key={puzzleScopeKey}
            puzzle={puzzleScopeKey === "none" ? undefined : puzzle}
            callbacks={puzzleCallbacks}
          >
            {(interaction) => {
              const canvasBox = STAGE_BOXES[layout].canvas;
              const phone = layout === "phone";
              const sprites = visibleSprites(
                layout,
                speaker.character?.character_id,
                !framed ? otherCharacter?.character_id : null
              );
              const showOther =
                sprites.ok &&
                sprites.sprites.some((s) => s.role === "other") &&
                Boolean(otherCharacter && otherCastId);
              return (
                <>
                  <div
                    data-testid="stage-panel"
                    style={{
                      position: "absolute",
                      ...PANEL_BOX[layout],
                      overflow: "hidden",
                      visibility: atGoodEnding ? "hidden" : undefined,
                    }}
                  >
                    {framed && (
                      <div
                        style={{
                          position: "absolute",
                          left: canvasBox.x,
                          top: canvasBox.y,
                          width: canvasBox.width,
                          height: phone ? canvasBox.height : undefined,
                          zIndex: puzzle && !phone ? 15 : 5,
                        }}
                      >
                        <CanvasPane
                          scene={framed.scene}
                          sceneKey={framed.key}
                          pacing={pacing}
                          layout={layout}
                          label={framed.label}
                          puzzle={
                            puzzle && interaction
                              ? { puzzle, interaction, onComplete: completePuzzle }
                              : undefined
                          }
                        />
                      </div>
                    )}
                    {speaker.character && castId && (
                      <StageSprite
                        layout={layout}
                        characterId={speaker.character.character_id}
                        castId={castId}
                        name={speaker.character.name}
                        expression={expression}
                        emotion={emotion}
                      />
                    )}
                    {showOther && otherCharacter && otherCastId && (
                      <StageSprite
                        layout={layout}
                        role="other"
                        characterId={otherCharacter.character_id}
                        castId={otherCastId}
                        name={otherCharacter.name}
                        expression="calm"
                        emotion="idle"
                      />
                    )}
                    <StageDialogue
                      layout={layout}
                      entry={displayEntry}
                      entryKey={displayEntryKey}
                      mode={pacing}
                      onModeChange={changePacing}
                      canAdvance={displayCanAdvance}
                      onAdvance={displayOnAdvance}
                      onOpenLog={() => setShowLog(true)}
                      speakerRole={speaker.character?.role}
                      askName={speaker.character?.name}
                      onAsk={(question) => {
                        void ask(question);
                      }}
                      askDisabled={askDisabled}
                      askPlaceholder={askPlaceholderFor({
                        isAsking,
                        sceneType: currentScene?.type,
                        canAsk,
                        speakerName: askSpeakerName,
                        phone,
                      })}
                      modalOpen={modalOpen}
                      boxOverride={
                        phone && puzzle && interaction ? STAGE_BOXES.phone.dialoguePuzzle : undefined
                      }
                      feedback={
                        phone && puzzle && interaction ? (
                          <PuzzleFeedback
                            puzzle={puzzle}
                            interaction={interaction}
                            hideQuestion
                            surfaceClassName="mt-1.5 border border-smoke bg-ink px-2.5 py-1.5"
                            maxHeightClassName="max-h-28"
                          />
                        ) : undefined
                      }
                      choices={
                        phone && puzzle && interaction ? (
                          <div
                            data-testid="puzzle-interaction"
                            role="region"
                            aria-label={`Puzzle: ${puzzle.question}`}
                            className="flex w-full flex-col gap-1.5"
                          >
                            <PuzzleChoices puzzle={puzzle} interaction={interaction} gapClass="gap-1.5" />
                            <PuzzleActions
                              interaction={interaction}
                              onComplete={completePuzzle}
                              className="w-full min-h-11! h-11"
                            />
                          </div>
                        ) : undefined
                      }
                      actions={
                        badBranchDone && !activeQa ? (
                          <Button variant="outline" data-testid="bad-branch-return-btn" onClick={returnToPuzzle}>
                            <Icon name="back" size={16} />
                            Try a different choice
                          </Button>
                        ) : undefined
                      }
                    />
                    {overlayFor(layout)}
                    {!phone && <KeyHints />}
                  </div>
                  {atGoodEnding && ending && (
                    <div
                      data-testid="story-report"
                      style={{ position: "absolute", zIndex: 40, ...REPORT_BOX[layout] }}
                    >
                      <StoryComplete
                        storyTitle={story.title}
                        subtitle={`${story.chapters.length} ${story.chapters.length === 1 ? "chapter" : "chapters"}`}
                        layout={layout}
                        cast={completionCast}
                        report={completionReport}
                        hp={hp}
                        maxHp={MAX_HP}
                        startedAt={runStartedAt}
                        onContinue={handleContinueCampaign}
                        onExit={onExit ?? (() => {})}
                        isCampaignComplete={isCampaignComplete}
                        onViewResults={onViewResults}
                        onReplay={onReplay}
                        onOpenLog={() => setShowLog(true)}
                        endingSlot={<EndingDisplay ending={ending} />}
                      />
                    </div>
                  )}
                </>
              );
            }}
          </PuzzleScope>
        )}
      </ScaledBoard>

      {showLog && <ChatLog entries={log} onClose={() => setShowLog(false)} />}

      {showExitConfirm && (
        <Modal
          onClose={() => setShowExitConfirm(false)}
          labelledBy="exit-confirm-title"
          data-testid="exit-confirm-dialog"
          className="p-5 md:max-w-[480px] md:p-6"
        >
          <h3
            id="exit-confirm-title"
            className="mb-3 font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-gold"
          >
            Exit Story?
          </h3>
          <p className="mb-5 text-[15px] leading-[1.5] text-muted">
            Your progress in this story will be lost. You can retry the story later, but you&apos;ll
            start from the beginning.
          </p>
          <div className="flex gap-3">
            <Button
              variant="outline"
              data-testid="exit-confirm-cancel"
              onClick={() => setShowExitConfirm(false)}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              data-testid="exit-confirm-accept"
              onClick={() => {
                setShowExitConfirm(false);
                onExit?.();
              }}
              className="flex-1"
            >
              Exit Anyway
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
