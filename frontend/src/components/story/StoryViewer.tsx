/**
 * StoryViewer — the Stage (docs/DESIGN-SYSTEM.md §4.1, §4.3, §4.4)
 *
 * A fixed 1440x900 (desktop) / 390x844 (phone) board scaled as a whole by
 * `ScaledBoard`. One tree serves both layouts, so layout switches do not
 * remount state:
 *
 *   StageBackdrop, StageHud, then the stage panel with
 *   StageScene (ASCII), CanvasPane (only for lesson, visual and decision, OQ-12),
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
 */

"use client";

import { useEffect, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import type { StoryBlueprint } from "@/lib/types/story";
import type { Character, Genre } from "@/lib/types/campaign";
import type { PlayerKnowledge } from "@/lib/types/game";
import type { Scene, SceneContent } from "@/lib/types/scene";
import { useStoryPlayer } from "@/lib/story/use-story-player";
import { getSceneContentBlocks, isBadBranchAtEnd, type CharacterIndex } from "@/lib/story/story-player";
import { loadStoredPacing, motionAllowed, savePacing, type Pacing } from "@/lib/story/pacing";
import { initialTextMode } from "@/lib/dialogue/typewriter";
import { resolveCampaignCast, emotionToExpression } from "@/lib/cast/cast-mapping";
import { STAGE_BOXES } from "@/lib/stage/stage-boxes";
import type { StageLayout } from "@/lib/stage/board-scale";
import { stableHash } from "@/lib/contracts/hash";
import {
  getOrCreateKnowledge,
  recordLearningExposure,
  recordPuzzleSubmission,
  getConceptIdsFromScene,
} from "@/lib/game/knowledge-manager";
import { StoryFailure } from "./StoryFailure";
import { StoryComplete } from "./StoryComplete";
import { EndingDisplay } from "./EndingDisplay";
import { ScaledBoard } from "@/components/stage/ScaledBoard";
import { StageBackdrop } from "@/components/stage/StageBackdrop";
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
import type { ChatEntry } from "@/components/stage/chat-entry";
import { ChatLog } from "@/components/stage/ChatLog";
import { emotionFor, type Emotion } from "@/components/stage/emotion";
import { Button } from "@/components/ui/Button";

type StoryViewerProps = {
  story: StoryBlueprint;
  characters: Character[];
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

/** Region above the dialogue box that endings, completion, failure and errors cover. */
const OVERLAY_BOX: Record<StageLayout, { left: number; top: number; width: number; height: number }> = {
  desktop: { left: 0, top: 0, width: 1200, height: 466 },
  phone: { left: 0, top: 56, width: 390, height: 522 },
};

/** The stage panel in board coordinates: the framed panel on desktop, the whole board on phone. */
const PANEL_BOX: Record<StageLayout, { left: number; top: number; width: number; height: number }> = {
  desktop: { left: 120, top: 92, width: 1200, height: 675 },
  phone: { left: 0, top: 0, width: 390, height: 844 },
};

function overlay(layout: StageLayout, children: ReactNode) {
  return (
    <div
      data-testid="stage-overlay"
      className="overflow-y-auto flex items-start sm:items-center justify-center p-4"
      style={{ position: "absolute", ...OVERLAY_BOX[layout], zIndex: 30, backgroundColor: "rgba(34, 34, 34, 0.55)" }}
    >
      <div className="w-full max-w-2xl flex flex-col gap-4">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StoryViewer({
  story,
  characters,
  onStoryComplete,
  onExit,
  isCampaignComplete = false,
  onViewResults,
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

  // ── Puzzle answer handler ─────────────────────────────────────────────────
  const handlePuzzleAnswerSubmitted = useCallback(
    (correct: boolean) => {
      if (!currentScene || currentScene.type !== "puzzle") return;

      const puzzleId = currentScene.puzzle_id;
      const puzzle = story.puzzles.find((p) => p.puzzle_id === puzzleId);
      if (!puzzle) return;

      setReaction({ sceneId: currentScene.scene_id, emotion: correct ? "happy" : "worried" });

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

  function handleRetry() {
    retryStory();
    loggedKeys.current.clear();
    setLog([]);
    setReaction(null);
  }

  // ── Advancing ──────────────────────────────────────────────────────────────
  const badBranchDone = currentScene !== null && isBadBranchAtEnd(playerState, currentScene);
  const canAdvance =
    currentScene !== null &&
    currentScene.type !== "puzzle" &&
    !isComplete &&
    !isFailed &&
    !navigationError &&
    playerState.status !== "story_complete" &&
    !badBranchDone;

  // ── Character on stage ─────────────────────────────────────────────────────
  const speaker = speakerFor(currentScene, blockIndex, characters);
  let emotion: Emotion = emotionFor(speaker.expression);
  if (currentBlock?.type === "learning_info") emotion = "explaining";
  if (puzzle) emotion = "thinking";
  if (ending) emotion = ending.type === "success" ? "happy" : "worried";
  if (reaction && reaction.sceneId === currentScene?.scene_id) emotion = reaction.emotion;
  if (isFailed) emotion = "worried";


  const castMap = useMemo(() => resolveCampaignCast(characters), [characters]);
  const castId = speaker.character ? castMap.get(speaker.character.character_id)?.castId : undefined;
  // Same emotion logic as before; the Kit has five expressions, so it maps down.
  const expression = emotionToExpression(emotion);

  // ── Canvas (OQ-12: a CanvasFrame only for lesson, visual and decision) ─────
  const seed = parseInt(stableHash(story.story_id), 36) % 1000;
  const chapterIndex = Math.max(0, story.chapters.findIndex((c) => c.chapter_id === currentChapter?.chapter_id));
  const canvasLocation = currentScene?.location ?? story.title;

  let framed: { scene: FramedScene; key: string; label: string } | null = null;
  let puzzleMissing = false;
  if (!navigationError && !isFailed) {
    if (currentScene?.type === "puzzle") {
      if (puzzle) {
        framed = {
          scene: { kind: "decision", props: { label: "", count: Math.min(puzzle.choices.length, 4), seed } },
          key: `puzzle:${puzzle.puzzle_id}`,
          label: canvasLocation,
        };
      } else {
        puzzleMissing = true;
      }
    } else if (currentScene?.type !== "ending" && currentBlock?.type === "learning_info") {
      // A concept may be taught in several steps (lesson blocks) in one scene.
      const lessons = (blocks ?? []).filter((b) => b.type === "learning_info");
      const step = { index: lessons.indexOf(currentBlock), total: lessons.length };
      framed = {
        scene: currentBlock.visual
          ? { kind: "visual", props: { title: currentBlock.title, visual: currentBlock.visual, seed, step } }
          : { kind: "lesson", props: { title: currentBlock.title, body: currentBlock.body, seed, step } },
        key: entryKey,
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
          className="lore-glass lore-glass-panel rounded-panel p-6 text-center"
          style={{ borderColor: "var(--danger)" }}
        >
          <p className="text-xs font-semibold tracking-widest uppercase mb-2" style={{ color: "var(--danger)" }}>
            Navigation Error
          </p>
          <p className="text-sm" style={{ color: "var(--foreground-muted)" }}>
            {navigationError.message}
          </p>
        </div>
      );
    }
    if (isFailed) return overlay(layout, <StoryFailure storyTitle={story.title} onRetry={handleRetry} />);
    if (puzzleMissing && currentScene?.type === "puzzle") {
      return overlay(
        layout,
        <p data-testid="scene-error" role="alert" style={{ color: "var(--danger)" }}>
          Puzzle not found for {currentScene.puzzle_id}.
        </p>
      );
    }
    if (currentScene?.type === "ending") {
      const badEnding = Boolean(playerState.returnToPuzzleSceneId);
      return overlay(
        layout,
        <>
          {ending ? (
            <EndingDisplay ending={ending} />
          ) : (
            <p data-testid="scene-error" role="alert" style={{ color: "var(--danger)" }}>
              Ending not found for {currentScene.ending_id}.
            </p>
          )}
          {badEnding ? (
            <div className="flex justify-center">
              <button
                type="button"
                data-testid="bad-ending-return-btn"
                onClick={returnToPuzzle}
                className="lore-pill lore-pill-lg lore-pill-accent"
                style={{ backgroundColor: "var(--background-panel)" }}
              >
                ↩ Try a different choice
              </button>
            </div>
          ) : (
            isComplete && (
              <StoryComplete
                storyTitle={story.title}
                onContinue={handleContinueCampaign}
                onExit={onExit ?? (() => {})}
                isCampaignComplete={isCampaignComplete}
                onViewResults={onViewResults}
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
      <ScaledBoard>
        {(layout) => (
          <PuzzleScope
            key={puzzleScopeKey}
            puzzle={puzzleScopeKey === "none" ? undefined : puzzle}
            callbacks={puzzleCallbacks}
          >
            {(interaction) => {
              const canvasBox = STAGE_BOXES[layout].canvas;
              const phone = layout === "phone";
              return (
                <>
                  <StageBackdrop layout={layout} />
                  <StageHud
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
                  <div
                    data-testid="stage-panel"
                    className={phone ? "" : "bg-ink outline outline-2 outline-smoke"}
                    style={{ position: "absolute", ...PANEL_BOX[layout], overflow: "hidden" }}
                  >
                    <StageScene layout={layout} seed={seed + 1} />
                    {framed && (
                      <div
                        style={{
                          position: "absolute",
                          left: canvasBox.x,
                          top: canvasBox.y,
                          width: canvasBox.width,
                          height: canvasBox.height,
                          zIndex: 5,
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
                    <StageDialogue
                      layout={layout}
                      entry={entry}
                      mode={pacing}
                      onModeChange={changePacing}
                      canAdvance={canAdvance}
                      onAdvance={advance}
                      onOpenLog={() => setShowLog(true)}
                      speakerRole={speaker.character?.role}
                      askName={speaker.character?.name}
                      modalOpen={modalOpen}
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
                        (phone && puzzle && interaction) || badBranchDone ? (
                          <>
                            {phone && puzzle && interaction && (
                              <PuzzleFeedback puzzle={puzzle} interaction={interaction} />
                            )}
                            {badBranchDone && (
                              <Button variant="outline" data-testid="bad-branch-return-btn" onClick={returnToPuzzle}>
                                ↩ Try a different choice
                              </Button>
                            )}
                          </>
                        ) : undefined
                      }
                    />
                    {overlayFor(layout)}
                  </div>
                  {!phone && <KeyHints />}
                </>
              );
            }}
          </PuzzleScope>
        )}
      </ScaledBoard>

      {showLog && <ChatLog entries={log} onClose={() => setShowLog(false)} />}

      {showExitConfirm && (
        <div
          data-testid="exit-confirm-dialog"
          className="fixed inset-0 flex items-center justify-center z-50"
          style={{ backgroundColor: "rgba(34, 34, 34, 0.7)" }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="exit-confirm-title"
        >
          <div className="lore-glass lore-glass-panel rounded-card p-6 max-w-sm w-full mx-4">
            <h3 id="exit-confirm-title" className="text-sm font-semibold mb-3" style={{ color: "var(--foreground)" }}>
              Exit Story?
            </h3>
            <p className="text-sm mb-4" style={{ color: "var(--foreground-muted)" }}>
              Your progress in this story will be lost. You can retry the story later, but you&apos;ll start from the beginning.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setShowExitConfirm(false)} className="lore-pill flex-1">
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowExitConfirm(false);
                  onExit?.();
                }}
                className="lore-pill lore-pill-danger flex-1"
              >
                Exit Anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
