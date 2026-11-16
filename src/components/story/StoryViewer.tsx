/**
 * StoryViewer — the 3-pane story stage (docs/DESIGN.md §4, wireframe)
 *
 *   ┌──────────────────────── navbar ────────────────────────┐
 *   │ character (SVG, emotions) │ canvas (@remotion/player)   │
 *   ├────────────────────── chat box ────────────────────────┤
 *
 * - Navbar: story/chapter/location, HP, exit.
 * - Character: the current speaker, whose emotion follows the dialogue
 *   and reacts to answers.
 * - Canvas: ambient scene, the lesson (its illustration when the lesson has
 *   a visual, else its text), or the decision graph puzzle;
 *   endings, completion and failure appear as overlays on it. The player's
 *   ASCII avatar (chosen on the home page) stands in the ambient and
 *   puzzle scenes.
 * - Chat box: the current line (typewriter in "animate" pacing), the
 *   fast|animate toggle, the story log, and the (coming soon) question box.
 *
 * Story logic is unchanged: useStoryPlayer drives navigation/HP/bad
 * branches, and knowledge evidence is reported through onKnowledgeUpdate.
 */

"use client";

import { useEffect, useCallback, useRef, useState, type ReactNode } from "react";
import type { StoryBlueprint } from "@/lib/types/story";
import type { Character, Genre } from "@/lib/types/campaign";
import type { PlayerKnowledge } from "@/lib/types/game";
import type { Scene, SceneContent } from "@/lib/types/scene";
import { useStoryPlayer } from "@/lib/story/use-story-player";
import { getSceneContentBlocks, isBadBranchAtEnd, type CharacterIndex } from "@/lib/story/story-player";
import { loadPacing, savePacing, type Pacing } from "@/lib/story/pacing";
import { avatarArt } from "@/lib/avatar/avatar";
import { usePlayerAvatar } from "@/lib/avatar/use-player-avatar";
import { stableHash } from "@/lib/ai/hash";
import {
  getOrCreateKnowledge,
  recordLearningExposure,
  recordPuzzleSubmission,
  getConceptIdsFromScene,
} from "@/lib/game/knowledge-manager";
import { StoryFailure } from "./StoryFailure";
import { StoryComplete } from "./StoryComplete";
import { EndingDisplay } from "./EndingDisplay";
import { StageNavbar } from "@/components/stage/StageNavbar";
import { StageCharacter } from "@/components/stage/StageCharacter";
import { StageCanvas, type CanvasScene } from "@/components/stage/StageCanvas";
import { StagePuzzle } from "@/components/stage/StagePuzzle";
import { ChatBox, type ChatEntry } from "@/components/stage/ChatBox";
import { ChatLog } from "@/components/stage/ChatLog";
import { emotionFor, type Emotion } from "@/components/stage/emotion";

type StoryViewerProps = {
  story: StoryBlueprint;
  characters: Character[];
  /** Campaign genre; picks the character's accessory. */
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

function overlay(children: ReactNode) {
  return (
    <div className="absolute inset-0 overflow-y-auto flex items-start sm:items-center justify-center p-4" style={{ backgroundColor: "rgba(10, 10, 12, 0.55)" }}>
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
  genre,
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
  const [talking, setTalking] = useState(false);
  const [pacing, setPacing] = useState<Pacing>("animate");
  useEffect(() => {
    // The saved preference lives in localStorage (browser only).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPacing(loadPacing());
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
  const speakerTalking = talking && entry?.kind === "dialogue" && entry.characterId === speaker.character?.character_id;

  // ── Canvas ─────────────────────────────────────────────────────────────────
  const seed = parseInt(stableHash(story.story_id), 36) % 1000;
  const avatar = avatarArt(usePlayerAvatar());
  const chapterIndex = Math.max(0, story.chapters.findIndex((c) => c.chapter_id === currentChapter?.chapter_id));
  const ambient = (title: string, subtitle?: string): CanvasScene => ({ kind: "ambient", props: { title, subtitle, seed, avatar } });

  let canvas: ReactNode;
  if (navigationError) {
    canvas = (
      <StageCanvas scene={ambient(story.title)} sceneKey="error" pacing={pacing}>
        {overlay(
          <div
            data-testid="story-viewer-error"
            role="alert"
            aria-live="assertive"
            className="rounded-lg p-6 text-center"
            style={{ backgroundColor: "var(--background-panel)", border: "1px solid var(--danger)" }}
          >
            <p className="text-xs font-semibold tracking-widest uppercase mb-2" style={{ color: "var(--danger)" }}>
              Navigation Error
            </p>
            <p className="text-sm" style={{ color: "var(--foreground-muted)" }}>
              {navigationError.message}
            </p>
          </div>
        )}
      </StageCanvas>
    );
  } else if (isFailed) {
    canvas = (
      <StageCanvas scene={ambient(story.title, "Story failed")} sceneKey="failed" pacing={pacing}>
        {overlay(<StoryFailure storyTitle={story.title} onRetry={handleRetry} />)}
      </StageCanvas>
    );
  } else if (currentScene?.type === "puzzle") {
    canvas = puzzle ? (
      <StagePuzzle
        key={currentScene.scene_id}
        puzzle={puzzle}
        pacing={pacing}
        seed={seed}
        avatar={avatar}
        onComplete={completePuzzle}
        onIncorrect={onPuzzleIncorrect}
        onBadBranch={onPuzzleBadBranch}
        onAnswerSubmitted={handlePuzzleAnswerSubmitted}
        isFailed={isFailed}
        badBranchChoiceIds={currentScene.on_incorrect_scene_id ? new Set(Object.keys(currentScene.on_incorrect_scene_id)) : undefined}
      />
    ) : (
      <p data-testid="scene-error" role="alert" style={{ color: "var(--danger)" }}>
        Puzzle not found for {currentScene.puzzle_id}.
      </p>
    );
  } else if (currentScene?.type === "ending") {
    const badEnding = Boolean(playerState.returnToPuzzleSceneId);
    canvas = (
      <StageCanvas scene={ambient(ending?.title ?? story.title, badEnding ? "A wrong turn" : "Story complete")} sceneKey={`ending:${currentScene.scene_id}`} pacing={pacing}>
        {overlay(
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
                  className="px-6 py-3 rounded text-sm font-medium"
                  style={{ color: "var(--accent-gold)", border: "1px solid var(--accent-gold)", backgroundColor: "var(--background-panel)" }}
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
        )}
      </StageCanvas>
    );
  } else if (currentBlock?.type === "learning_info") {
    // Illustrated when the lesson has a visual; otherwise its text is written out.
    canvas = (
      <StageCanvas
        scene={
          currentBlock.visual
            ? { kind: "visual", props: { title: currentBlock.title, visual: currentBlock.visual, seed } }
            : { kind: "lesson", props: { title: currentBlock.title, body: currentBlock.body, seed } }
        }
        sceneKey={entryKey}
        pacing={pacing}
      />
    );
  } else {
    canvas = (
      <StageCanvas
        scene={ambient(currentScene?.location ?? story.title, currentChapter?.title)}
        sceneKey={`scene:${currentScene?.scene_id ?? ""}`}
        pacing={pacing}
      />
    );
  }

  return (
    <div data-testid="story-viewer" className="lore-bg h-screen flex flex-col overflow-hidden">
      <StageNavbar
        storyTitle={story.title}
        chapterTitle={currentChapter?.title}
        chapterIndex={chapterIndex}
        chapterCount={story.chapters.length}
        location={currentScene?.location}
        hp={hp}
        failed={isFailed}
        onExit={onExit ? () => setShowExitConfirm(true) : undefined}
      />

      <div className="flex-1 min-h-0 flex gap-3 p-3">
        <aside
          aria-label="Character"
          className="hidden md:flex w-[30%] lg:w-[28%] rounded-lg p-4 lore-panel-bg"
          style={{ border: "1px solid var(--border)" }}
        >
          {speaker.character && (
            <StageCharacter
              characterId={speaker.character.character_id}
              name={speaker.character.name}
              role={speaker.character.role}
              emotion={emotion}
              talking={speakerTalking}
              genre={genre}
            />
          )}
        </aside>
        <div className="flex-1 min-w-0 min-h-0 flex items-center justify-center" style={{ containerType: "size" }}>
          {canvas}
        </div>
      </div>

      <div className="px-3 pb-3">
        <ChatBox
          entry={entry}
          entryKey={entryKey}
          pacing={pacing}
          onPacingChange={changePacing}
          canAdvance={canAdvance}
          onAdvance={advance}
          onTypingChange={setTalking}
          onOpenLog={() => setShowLog(true)}
          askName={speaker.character?.name}
          actions={
            badBranchDone ? (
              <button
                type="button"
                data-testid="bad-branch-return-btn"
                onClick={returnToPuzzle}
                className="px-4 py-1.5 rounded text-xs font-medium"
                style={{ color: "var(--accent-gold)", border: "1px solid var(--accent-gold)" }}
              >
                ↩ Try a different choice
              </button>
            ) : undefined
          }
        />
      </div>

      {showLog && <ChatLog entries={log} onClose={() => setShowLog(false)} />}

      {showExitConfirm && (
        <div
          data-testid="exit-confirm-dialog"
          className="fixed inset-0 flex items-center justify-center z-50"
          style={{ backgroundColor: "rgba(10, 10, 12, 0.8)" }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="exit-confirm-title"
        >
          <div
            className="rounded-lg p-6 max-w-sm w-full mx-4"
            style={{ backgroundColor: "var(--background-panel)", border: "1px solid var(--border)" }}
          >
            <h3 id="exit-confirm-title" className="text-sm font-semibold mb-3" style={{ color: "var(--foreground)" }}>
              Exit Story?
            </h3>
            <p className="text-sm mb-4" style={{ color: "var(--foreground-muted)" }}>
              Your progress in this story will be lost. You can retry the story later, but you&apos;ll start from the beginning.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowExitConfirm(false)}
                className="flex-1 px-4 py-2 rounded text-sm font-medium"
                style={{ color: "var(--foreground-muted)", border: "1px solid var(--border)" }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowExitConfirm(false);
                  onExit?.();
                }}
                className="flex-1 px-4 py-2 rounded text-sm font-medium"
                style={{ backgroundColor: "var(--danger-bg)", color: "var(--danger)", border: "1px solid var(--danger)" }}
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
