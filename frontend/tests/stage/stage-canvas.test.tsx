// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

/** Props of the last <Player> rendered by StageCanvas. */
let lastPlayerProps: Record<string, unknown> = {};
vi.mock("@remotion/player", () => ({
  Player: (props: Record<string, unknown>) => {
    lastPlayerProps = props;
    return null;
  },
}));

const { StageCanvas } = await import("@/components/stage/StageCanvas");
type CanvasScene = import("@/components/stage/StageCanvas").CanvasScene;

const visual: CanvasScene = {
  kind: "visual",
  props: { title: "Vectors", seed: 1, visual: { kind: "vectors", vectors: [{ from: [0, 0], to: [2, 1] }] } },
};
const lesson: CanvasScene = { kind: "lesson", props: { title: "Vectors", body: "Arrows with length.", seed: 1 } };
const decision: CanvasScene = { kind: "decision", props: { label: "", seed: 1 } };
const ambient: CanvasScene = { kind: "ambient", props: { title: "The Hall", seed: 1 } };

describe("StageCanvas playback", () => {
  it.each([
    ["visual", visual],
    ["lesson", lesson],
    ["decision", decision],
  ] as const)("plays a %s scene once and holds its finished last frame", (_kind, scene) => {
    render(<StageCanvas scene={scene} sceneKey="k" pacing="animate" />);
    expect(lastPlayerProps).toMatchObject({ loop: false, autoPlay: true, initialFrame: 0, moveToBeginningWhenEnded: false });
  });

  it("opens explanations on their last frame in fast pacing", () => {
    render(<StageCanvas scene={visual} sceneKey="k" pacing="fast" />);
    const duration = lastPlayerProps.durationInFrames as number;
    expect(lastPlayerProps).toMatchObject({ autoPlay: false, initialFrame: duration - 1, moveToBeginningWhenEnded: false });
  });

  it("keeps looping ambient scenes", () => {
    render(<StageCanvas scene={ambient} sceneKey="k" pacing="fast" />);
    expect(lastPlayerProps).toMatchObject({ loop: true, autoPlay: true });
  });
});
