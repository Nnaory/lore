/**
 * StageCanvas — the 16:9 @remotion/player canvas with an HTML overlay.
 *
 * The player renders one of the compositions client-side from props. In
 * "fast" pacing it opens on the final frame instead of playing; ambient
 * scenes loop, explanations play once and hold their last frame.
 * `children` are laid over the canvas in the same 16:9 box, so overlay
 * positions in percent match the composition's geometry.
 */

"use client";

import { Player, type PlayerRef } from "@remotion/player";
import { useSyncExternalStore, type ReactNode } from "react";
import type { Pacing } from "@/lib/story/pacing";
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
import { LessonVisualBoard, type LessonVisualBoardProps } from "./visual-compositions";
import { visualDuration } from "./visual-layout";

export type CanvasScene =
  | { kind: "ambient"; props: AmbientSceneProps }
  | { kind: "lesson"; props: LessonBoardProps }
  | { kind: "visual"; props: LessonVisualBoardProps }
  | { kind: "decision"; props: DecisionGraphProps };

function sceneSpec(scene: CanvasScene) {
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
    case "decision":
      return { component: DecisionGraph as React.ComponentType<Record<string, unknown>>, duration: DECISION_DURATION, loop: false };
  }
}

export function sceneDurationFrames(scene: CanvasScene): number {
  return sceneSpec(scene).duration;
}

type StageCanvasProps = {
  scene: CanvasScene;
  /** Changes whenever the canvas should restart its animation. */
  sceneKey: string;
  pacing: Pacing;
  children?: ReactNode;
  /** Callback ref for the Remotion player (feeds `useCanvasPlayback`). */
  playerRef?: (player: PlayerRef | null) => void;
  /** Inside a CanvasFrame: no own border, radius or shadow (the frame draws them). */
  bare?: boolean;
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

export function StageCanvas({ scene, sceneKey, pacing, children, playerRef, bare = false }: StageCanvasProps) {
  const { component, duration, loop } = sceneSpec(scene);
  const fast = pacing === "fast";
  const isClient = useIsClient();
  return (
    <div
      data-testid="stage-canvas"
      data-canvas-kind={scene.kind}
      className={bare ? "relative mx-auto overflow-hidden" : "relative mx-auto overflow-hidden border border-smoke"}
      style={{
        aspectRatio: `${CANVAS_WIDTH} / ${CANVAS_HEIGHT}`,
        // Fill the width, but never overflow the height of a size container.
        width: `min(100%, calc(100cqh * ${CANVAS_WIDTH} / ${CANVAS_HEIGHT}))`,
      }}
    >
      {isClient ? (
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
      )}
      {children && <div className="absolute inset-0">{children}</div>}
    </div>
  );
}
