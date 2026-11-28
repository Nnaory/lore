/**
 * @vitest-environment jsdom
 *
 * chat-log.test.tsx - ChatLog entries, empty state, close button and the
 * stage shortcuts being muted while the log is open (task 7.3).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatLog } from "@/components/stage/ChatLog";
import type { ChatEntry } from "@/components/stage/chat-entry";
import { StoryViewer } from "@/components/story/StoryViewer";
import { dummyCampaign } from "@/data/dummy-campaign";
import { linearStory } from "../fixtures/linear-story";

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  window.matchMedia = ((query: string) => ({
    matches: query.includes("min-width"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const entries: ChatEntry[] = [
  { kind: "narration", text: "A cold wind blows." },
  {
    kind: "dialogue",
    characterId: "c1",
    name: "Mira",
    expression: "calm",
    expressionKey: "calm",
    text: "Stay close.",
  },
  { kind: "lesson", title: "Gravity", text: "Things fall." },
  { kind: "question", text: "Why does it fall?" },
  {
    kind: "answer",
    characterId: "c1",
    name: "Mira",
    expression: "smile",
    expressionKey: "smile",
    text: "Gravity pulls mass together.",
  },
];

describe("ChatLog", () => {
  it("renders narration, dialogue, lesson, question and answer entries", () => {
    render(<ChatLog entries={entries} onClose={() => {}} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-labelledby")).toBe("chat-log-title");
    const text = screen.getByTestId("chat-log").textContent ?? "";
    expect(text).toContain("A cold wind blows.");
    expect(text).toContain("Mira");
    expect(text).toContain("Stay close.");
    expect(text).toContain("Lesson · Gravity");
    expect(text).toContain("Things fall.");
    expect(text).toContain("YOU");
    expect(text).toContain("Why does it fall?");
    expect(text).toContain("Q&A");
    expect(text).toContain("Gravity pulls mass together.");
  });

  it("shows 'Nothing yet.' when there are no entries", () => {
    render(<ChatLog entries={[]} onClose={() => {}} />);
    expect(screen.getByText("Nothing yet.")).toBeTruthy();
  });

  it("has a focused Close button with a 44px touch target that closes", () => {
    const onClose = vi.fn();
    render(<ChatLog entries={entries} onClose={onClose} />);
    const close = screen.getByTestId("chat-log-close");
    expect(document.activeElement).toBe(close);
    expect(close.className).toContain("min-h-[44px]");
    expect(close.className).toContain("min-w-[44px]");
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores stage shortcuts while open and restores them after Escape", () => {
    render(<StoryViewer story={linearStory} characters={dummyCampaign.characters} />);
    const press = (k: string) =>
      act(() => {
        fireEvent.keyDown(window, { key: k, code: k === " " ? "Space" : `Key${k.toUpperCase()}` });
      });
    press("l");
    expect(screen.getByTestId("chat-log")).toBeTruthy();
    const before = screen.getByTestId("scene-content").textContent;
    press(" ");
    press("f");
    expect(screen.getByTestId("scene-content").textContent).toBe(before);
    expect(screen.getByTestId("pacing-animate").getAttribute("aria-pressed")).toBe("true");
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(screen.queryByTestId("chat-log")).toBeNull();
  });
});
