/**
 * StageCanvas — the 16:9 @remotion/player canvas with an HTML overlay.
 *
 * The player renders one of the compositions client-side from props. In
 * "fast" pacing it opens on the final frame instead of playing; ambient
 * scenes loop, explanations play once and hold their last frame.
 * `children` are laid over the canvas in the same 16:9 box, so overlay
 * positions in percent match the composition's geometry.
 *
 * An `animation` scene (design 7.6, Requirements 30.4, 30.7, 31.3, 31.14) is an AI-written
 * animation that runs in a sandboxed iframe (`AnimationScene`). It lives in the same wrapper and
 * the same 16:9 box as every other scene, and carries its Fallback_Scene (a lesson, visual, puzzle
 * or decision scene) which is drawn by the very same `RemotionView` the other scenes use, so the
 * Fallback_Scene is exactly what the Stage would draw without a reference (Requirement 31.2).
 * The wrapper reports two things about it:
 * - `data-animation-status`: `off` for every other scene, otherwise `loading`, `playing`, `paused`
 *   or `failed:<phase>`;
 * - `data-canvas-kind`: `animation` while the iframe is shown, the Fallback_Scene's kind while the
 *   Fallback_Scene is drawn, and the scene's own kind for all other scenes.
 * The status is kept as `{key, value}` so a report from the previous scene can never be mistaken for
 * the current one. `answerCorrect` is the only game input the animation gets; nothing flows back.
 *
 * A page that `<Activity>` hid and shows again (cacheComponents) leaves the sandbox iframe running
 * but disposes the controller that talked to it. When that happens to an animation scene that has
 * not failed, the scene is mounted afresh (a new `AnimationScene` key) instead of waiting 8 s for a
 * `ready` that never comes. See `useOnReveal` and `shouldRemountOnReveal`.
 *
 * This is the only file that imports a value from `@remotion/player` (Requirement 39.14).
 */

"use client";

import { Player, type PlayerRef } from "@remotion/player";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { AnimationScene } from "@/components/animation/AnimationScene";
import type { AnimationStatus } from "@/lib/animation/scene-status";
import {
  iframeShown,
  shouldRemountOnReveal,
  statusForScene,
  type CanvasAnimationStatus,
} from "@/lib/stage/canvas-timeline";
import type { PlayerLike } from "@/lib/stage/player-like";
import { useOnReveal } from "@/lib/stage/use-on-reveal";
import type { Pacing } from "@/lib/story/pacing";
import type { AnimationReference } from "@/lib/types/animation";
import { CANVAS_FPS, CANVAS_HEIGHT, CANVAS_WIDTH } from "./canvas-layout";
import {
  AmbientScene,
  DecisionGraph,
  DECISION_DURATION,
  LessonBoard,
  lessonDuration,
  type AmbientSceneProps,
  type DecisionGraphProps,
  type LessonBoardProps,
} from "./compositions";
import { LessonVisualBoard, PuzzleBoard, type LessonVisualBoardProps, type PuzzleBoardProps } from "./visual-compositions";
import { visualDuration } from "./visual-layout";

/** What an `animation` scene carries: the reference to play, and the scene to draw instead of it. */
export type AnimationSceneProps = {
  animation: AnimationReference;
  /** The scene the Stage would draw without a reference. Never `ambient` and never `animation`. */
  fallback: Exclude<CanvasScene, { kind: "ambient" | "animation" }>;
};

export type CanvasScene =
  | { kind: "ambient"; props: AmbientSceneProps }
  | { kind: "lesson"; props: LessonBoardProps }
  | { kind: "visual"; props: LessonVisualBoardProps }
  /** A puzzle with a picture of its own: the AI-designed visual plus the question. */
  | { kind: "puzzle"; props: PuzzleBoardProps }
  /** A puzzle without a picture (older projects, or an invalid visual): the question alone. */
  | { kind: "decision"; props: DecisionGraphProps }
  /** An AI-written animation in a sandboxed iframe, with its Fallback_Scene. */
  | { kind: "animation"; props: AnimationSceneProps };

/** The scenes the Remotion `Player` draws itself (all but `animation`). */
type RemotionScene = Exclude<CanvasScene, { kind: "animation" }>;

function sceneSpec(scene: RemotionScene) {
  switch (scene.kind) {
    case "ambient":
      return { component: AmbientScene as React.ComponentType<Record<string, unknown>>, duration: 300, loop: true };
    case "lesson":
      return {
        component: LessonBoard as React.ComponentType<Record<string, unknown>>,
        duration: lessonDuration(scene.props.body),
        loop: false,
      };
    case "visual":
      return {
        component: LessonVisualBoard as React.ComponentType<Record<string, unknown>>,
        duration: visualDuration(scene.props.visual),
        loop: false,
      };
    case "puzzle":
      return {
        component: PuzzleBoard as React.ComponentType<Record<string, unknown>>,
        duration: visualDuration(scene.props.visual),
        loop: false,
      };
    case "decision":
      return { component: DecisionGraph as React.ComponentType<Record<string, unknown>>, duration: DECISION_DURATION, loop: false };
  }
}

/** Length of a scene in frames; for an `animation` scene, the length of the animation itself. */
export function sceneDurationFrames(scene: CanvasScene): number {
  if (scene.kind === "animation") return scene.props.animation.duration_in_frames;
  return sceneSpec(scene).duration;
}

type StageCanvasProps = {
  scene: CanvasScene;
  /** Changes whenever the canvas should restart its animation. */
  sceneKey: string;
  pacing: Pacing;
  children?: ReactNode;
  /**
   * Callback ref for the player the PlayerBar drives (feeds `useCanvasPlayback`): the Remotion
   * player, or the sandbox player while an animation is shown.
   */
  playerRef?: (player: PlayerLike | null) => void;
  /** Inside a CanvasFrame: no own border, radius or shadow (the frame draws them). */
  bare?: boolean;
  /** `interaction.isCorrect` of the puzzle an `animation` scene belongs to; `undefined` for a lesson. */
  answerCorrect?: boolean;
  /** Called with the status of an `animation` scene at mount and whenever it changes. */
  onAnimationStatus?: (status: AnimationStatus) => void;
};

const noSubscribe = () => () => {};

/**
 * True only in the browser after hydration. The Remotion player reads the
 * clock while rendering, which Next.js forbids during prerendering, so the
 * server renders an empty frame and the player mounts on the client.
 */
function useIsClient(): boolean {
  return useSyncExternalStore(noSubscribe, () => true, () => false);
}

/** The Remotion `Player` for one scene (or an empty frame until the browser has hydrated). */
function RemotionView({
  scene,
  sceneKey,
  pacing,
  playerRef,
}: {
  scene: RemotionScene;
  sceneKey: string;
  pacing: Pacing;
  playerRef?: (player: PlayerRef | null) => void;
}) {
  const { component, duration, loop } = sceneSpec(scene);
  const fast = pacing === "fast";
  const isClient = useIsClient();
  return isClient ? (
    <Player
      ref={playerRef}
      key={`${sceneKey}:${pacing}`}
      component={component}
      inputProps={scene.props as unknown as Record<string, unknown>}
      durationInFrames={duration}
      fps={CANVAS_FPS}
      compositionWidth={CANVAS_WIDTH}
      compositionHeight={CANVAS_HEIGHT}
      style={{ width: "100%", height: "100%" }}
      controls={false}
      clickToPlay={false}
      doubleClickToFullscreen={false}
      spaceKeyToPlayOrPause={false}
      autoPlay={!fast || loop}
      loop={loop}
      // Hold the finished drawing. The Player's default jumps back to frame
      // 0 at the end, where every element is still invisible.
      moveToBeginningWhenEnded={false}
      initialFrame={fast && !loop ? duration - 1 : 0}
      acknowledgeRemotionLicense
    />
  ) : (
    <div className="absolute inset-0 bg-ink" aria-hidden="true" />
  );
}

export function StageCanvas({
  scene,
  sceneKey,
  pacing,
  children,
  playerRef,
  bare = false,
  answerCorrect,
  onAnimationStatus,
}: StageCanvasProps) {
  /** Last status an `AnimationScene` reported, with the key of the mount that reported it. */
  const [reported, setReported] = useState<{ key: string; value: AnimationStatus } | null>(null);
  /** How many times the page was hidden and shown again; part of the `AnimationScene` key. */
  const [reveals, setReveals] = useState(0);
  const animationKey = `${sceneKey}:${reveals}`;

  const animation = scene.kind === "animation" ? scene.props : null;
  const animationStatus: CanvasAnimationStatus =
    animation === null ? "off" : statusForScene(reported, animationKey);
  const canvasKind = animation === null ? scene.kind : iframeShown(animationStatus) ? "animation" : animation.fallback.kind;

  // A page shown again after `<Activity>` hid it: mount the scene afresh unless it already failed.
  useOnReveal(() => {
    if (animation === null || !shouldRemountOnReveal(animationStatus)) return;
    setReveals((count) => count + 1);
    // The new mount starts at `loading`; tell the owner now rather than one commit later.
    onAnimationStatus?.("loading");
  });

  const handleStatus = (status: AnimationStatus) => {
    setReported({ key: animationKey, value: status });
    onAnimationStatus?.(status);
  };

  return (
    <div
      data-testid="stage-canvas"
      data-canvas-kind={canvasKind}
      data-animation-status={animationStatus}
      className={bare ? "relative mx-auto overflow-hidden" : "relative mx-auto overflow-hidden border border-smoke"}
      style={{
        aspectRatio: `${CANVAS_WIDTH} / ${CANVAS_HEIGHT}`,
        // Fill the width, but never overflow the height of a size container.
        width: `min(100%, calc(100cqh * ${CANVAS_WIDTH} / ${CANVAS_HEIGHT}))`,
      }}
    >
      {scene.kind === "animation" ? (
        <AnimationScene
          key={animationKey}
          reference={scene.props.animation}
          pacing={pacing}
          answerCorrect={answerCorrect}
          playerRef={playerRef}
          onStatus={handleStatus}
          renderFallback={(ref) => (
            <RemotionView scene={scene.props.fallback} sceneKey={sceneKey} pacing={pacing} playerRef={ref} />
          )}
        />
      ) : (
        <RemotionView scene={scene} sceneKey={sceneKey} pacing={pacing} playerRef={playerRef} />
      )}
      {children && <div className="absolute inset-0">{children}</div>}
    </div>
  );
}
