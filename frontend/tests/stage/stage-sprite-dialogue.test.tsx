/**
 * @vitest-environment jsdom
 *
 * StageSprite and StageDialogue (task 1.25): accessible sprite name, kept and
 * new data attributes, per-layout z-index, typewriter skip-then-advance, name
 * tags and the disabled ask input.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StageSprite } from "@/components/stage/StageSprite";
import { StageDialogue, dialogueParts } from "@/components/stage/StageDialogue";
import type { ChatEntry } from "@/components/stage/chat-entry";

beforeEach(() => {
  // jsdom has no canvas; AsciiArt only needs a null context to skip drawing.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(cleanup);

describe("StageSprite", () => {
  it("exposes an image name and data attributes, in front on desktop", () => {
    render(
      <StageSprite layout="desktop" characterId="c1" castId="mira" name="Mira Vale" expression="smile" emotion="happy" />,
    );
    const fig = screen.getByTestId("stage-character");
    expect(fig.dataset.characterId).toBe("c1");
    expect(fig.dataset.castId).toBe("mira");
    expect(fig.dataset.expression).toBe("smile");
    expect(fig.dataset.emotion).toBe("happy");
    expect(fig.style.zIndex).toBe("20");
    expect(screen.getByRole("img", { name: "Mira Vale, smile" })).toBeTruthy();
  });

  it("sits behind the dialogue box on phone", () => {
    render(<StageSprite layout="phone" characterId="c1" castId="nyx" name="Nyx" expression="calm" emotion="idle" />);
    expect(screen.getByTestId("stage-character").style.zIndex).toBe("5");
  });
});

describe("StageDialogue", () => {
  const dialogue: ChatEntry = {
    kind: "dialogue",
    characterId: "c1",
    name: "Mira",
    expression: "(^_^)",
    expressionKey: "smile",
    text: "Hello there",
  };

  function setup(entry: ChatEntry | null, mode: "fast" | "animate", onAdvance = vi.fn()) {
    render(
      <StageDialogue
        layout="desktop"
        entry={entry}
        mode={mode}
        onModeChange={() => {}}
        canAdvance
        onAdvance={onAdvance}
        onOpenLog={() => {}}
      />,
    );
    return onAdvance;
  }

  it("maps entries to name tags and text", () => {
    expect(dialogueParts({ kind: "narration", text: "x" }).tag).toBe("NARRATION");
    expect(dialogueParts({ kind: "lesson", title: "T", text: "b" })).toEqual({ tag: "LESSON", text: "T\nb" });
  });

  it("shows the line at once in fast mode, advances on click, keeps hooks", () => {
    const onAdvance = setup(dialogue, "fast");
    expect(screen.getByTestId("scene-content").textContent).toBe("Hello there");
    expect(screen.getByTestId("character-name").textContent).toContain("MIRA");
    expect(screen.getByTestId("story-main")).toBeTruthy();
    expect(screen.getByTestId("pacing-toggle")).toBeTruthy();
    expect(screen.getByTestId("log-chat-button")).toBeTruthy();
    expect(screen.getByTestId("character-bubble").dataset.characterId).toBe("c1");
    fireEvent.click(screen.getByRole("button", { name: /Hello/ }));
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });

  it("first click completes a line still typing, second click advances", () => {
    const onAdvance = setup(dialogue, "animate");
    expect(screen.getByTestId("scene-content").textContent).toBe("");
    const target = screen.getByTestId("scene-content").parentElement!.parentElement!;
    fireEvent.click(target);
    expect(screen.getByTestId("scene-content").textContent).toBe("Hello there");
    expect(onAdvance).not.toHaveBeenCalled();
    fireEvent.click(target);
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });

  it("tags lessons and keeps the ask input disabled", () => {
    setup({ kind: "lesson", title: "Vectors", text: "Body" }, "fast");
    expect(screen.getByTestId("character-name").textContent).toContain("LESSON");
    expect(screen.getByTestId("learning-card").getAttribute("aria-label")).toBe("Learning: Vectors");
    const ask = screen.getByTestId("ask-input") as HTMLInputElement;
    expect(ask.disabled).toBe(true);
    expect(ask.placeholder).toContain("coming soon");
  });
});
