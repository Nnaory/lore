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
    // The lesson title is not a text line: the three lines of the box are for the body.
    expect(dialogueParts({ kind: "lesson", title: "T", text: "b" })).toEqual({ tag: "LESSON", text: "b" });
  });

  it("shows the lesson title beside the LESSON tag on desktop, not in the text", () => {
    setup({ kind: "lesson", title: "Crystal Vector Resonance", text: "Body" }, "fast");
    expect(screen.getByTestId("character-name").textContent).toContain("Crystal Vector Resonance");
    expect(screen.getByTestId("scene-content").textContent).toBe("Body");
  });

  describe("text longer than the box", () => {
    const long =
      "Each crystal emits energy as a vector: a quantity with both direction and magnitude. " +
      "Crystal A points toward the east gate with a strength of two. " +
      "Crystal B points toward the north tower with a strength of one. " +
      "To produce a target resonance, you scale each crystal by how many times it is used.";
    const narration: ChatEntry = { kind: "narration", text: long };

    it("shows one page at a time and pages before it advances the story", () => {
      const onAdvance = setup(narration, "fast");
      const first = screen.getByTestId("scene-content").textContent ?? "";
      expect(first.length).toBeGreaterThan(0);
      expect(first.length).toBeLessThan(long.length);
      const target = screen.getByTestId("story-main");

      fireEvent.click(target);
      const second = screen.getByTestId("scene-content").textContent ?? "";
      expect(second).not.toBe(first);
      expect(onAdvance).not.toHaveBeenCalled();

      // Keep paging; the story advances only after the last page.
      for (let i = 0; i < 10 && onAdvance.mock.calls.length === 0; i++) fireEvent.click(target);
      expect(onAdvance).toHaveBeenCalledTimes(1);
    });

    it("never shows more than three lines of the desktop box", () => {
      setup(narration, "fast");
      const text = screen.getByTestId("scene-content").textContent ?? "";
      expect(text.length).toBeLessThanOrEqual(68 * 3);
    });

    it("does not page on the phone, where the text area scrolls", () => {
      render(
        <StageDialogue
          layout="phone"
          entry={narration}
          mode="fast"
          onModeChange={() => {}}
          canAdvance
          onAdvance={() => {}}
          onOpenLog={() => {}}
        />,
      );
      expect(screen.getByTestId("scene-content").textContent).toBe(long);
    });
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

  it("tags lessons and renders the active ask placeholder by default", () => {
    setup({ kind: "lesson", title: "Vectors", text: "Body" }, "fast");
    expect(screen.getByTestId("character-name").textContent).toContain("LESSON");
    expect(screen.getByTestId("learning-card").getAttribute("aria-label")).toBe("Learning: Vectors");
    const ask = screen.getByTestId("ask-input") as HTMLInputElement;
    expect(ask.disabled).toBe(false);
    expect(ask.placeholder).toContain("Ask a character something");
  });

  it("resets pagination to page 0 when entryKey changes even with identical text", () => {
    const long = Array.from({ length: 10 }, (_, i) => `Sentence ${i} keeps repeating steadily.`).join(" ");
    const beat: ChatEntry = { kind: "narration", text: long };
    const onAdvance = vi.fn();
    const { rerender } = render(
      <StageDialogue
        layout="desktop"
        entry={beat}
        entryKey="beat-1"
        mode="fast"
        onModeChange={() => {}}
        canAdvance
        onAdvance={onAdvance}
        onOpenLog={() => {}}
      />,
    );
    const page0 = screen.getByTestId("scene-content").textContent;
    fireEvent.click(screen.getByTestId("story-main"));
    expect(screen.getByTestId("scene-content").textContent).not.toBe(page0);

    rerender(
      <StageDialogue
        layout="desktop"
        entry={beat}
        entryKey="beat-2"
        mode="fast"
        onModeChange={() => {}}
        canAdvance
        onAdvance={onAdvance}
        onOpenLog={() => {}}
      />,
    );
    expect(screen.getByTestId("scene-content").textContent).toBe(page0);
  });
});
