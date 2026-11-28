/**
 * Tests — Mid-story Q&A client & StoryViewer integration
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StoryViewer } from "@/components/story/StoryViewer";
import { ASK_MESSAGES } from "@/lib/contracts/error-messages";
import { buildAskQuestionPayload, postAskQuestion } from "@/lib/story/ask-client";
import { dummyCampaign, dummyMaterial } from "@/data/dummy-campaign";
import { linearStory } from "../fixtures/linear-story";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  window.localStorage.setItem("lore:pacing", "fast");
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ask-client helpers", () => {
  it("builds a complete payload with materials, campaign, story and compact logs", () => {
    const payload = buildAskQuestionPayload({
      question: "  What is a linear combination?  ",
      story: linearStory,
      characters: dummyCampaign.characters,
      campaign: dummyCampaign,
      materials: [dummyMaterial],
      sceneId: linearStory.chapters[0].scenes[0].scene_id,
      chapterId: linearStory.chapters[0].chapter_id,
      chapterTitle: linearStory.chapters[0].title,
      blockIndex: 1,
      speakerCharacterId: dummyCampaign.characters[0].character_id,
      recentLog: [
        { kind: "narration", text: "Intro line" },
        { kind: "question", text: "Prior Q" },
        {
          kind: "answer",
          characterId: "char_eldric",
          name: "Eldric",
          expression: "(^_^)",
          expressionKey: "smile",
          text: "Prior A",
        },
      ],
      qaHistory: [{ question: "Prior Q", answer: "Prior A" }],
      playerKnowledge: {
        concept_linear_combination: {
          concept_id: "concept_linear_combination",
          status: "introduced",
          evidence: [{ source: "seen", reference_id: "s1", timestamp: 1 }],
        },
      },
    });

    expect(payload.question).toBe("What is a linear combination?");
    expect(payload.materials).toEqual([dummyMaterial]);
    expect(payload.campaign.campaign_id).toBe(dummyCampaign.campaign_id);
    expect(payload.story.story_id).toBe(linearStory.story_id);
    expect(payload.context.recent_log).toHaveLength(3);
    expect(payload.context.qa_history).toHaveLength(1);
    expect(payload.context.player_knowledge?.concept_linear_combination).toEqual({
      concept_id: "concept_linear_combination",
      status: "introduced",
    });
  });

  it("maps abort and error envelopes cleanly", async () => {
    const controller = new AbortController();
    controller.abort();
    const aborted = await postAskQuestion(
      buildAskQuestionPayload({
        question: "Hi?",
        story: linearStory,
        characters: dummyCampaign.characters,
        sceneId: linearStory.chapters[0].scenes[0].scene_id,
      }),
      { signal: controller.signal },
    );
    expect(aborted).toEqual({ ok: false, message: "", aborted: true });

    const errorFetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, error: { code: "ASK_NOT_ALLOWED_IN_SCENE", message: "no" } }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const failed = await postAskQuestion(
      buildAskQuestionPayload({
        question: "Hi?",
        story: linearStory,
        characters: dummyCampaign.characters,
        sceneId: linearStory.chapters[0].scenes[0].scene_id,
      }),
      { fetchImpl: errorFetch },
    );
    expect(failed).toEqual({ ok: false, message: ASK_MESSAGES.notAllowed });
  });
});

describe("StoryViewer mid-story Q&A flow", () => {
  it("submits question, shows reply in DialogueBox, logs Q&A, supports follow-up, and resumes paused beat", async () => {
    const pending1 = deferred<Response>();
    const pending2 = deferred<Response>();
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      return calls.length === 1 ? pending1.promise : pending2.promise;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <StoryViewer
        story={linearStory}
        characters={dummyCampaign.characters}
        campaign={dummyCampaign}
        materials={[dummyMaterial]}
      />,
    );

    const originalLine = screen.getByTestId("scene-content").textContent;
    const askInput = screen.getByTestId("ask-input") as HTMLInputElement;
    expect(askInput.disabled).toBe(false);

    // 1. Ask first question
    await act(async () => {
      fireEvent.change(askInput, { target: { value: "Kenapa harus dikali skalar?" } });
      fireEvent.submit(askInput.closest("form")!);
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/v1/ai/ask");
    expect(calls[0].body.materials).toEqual([dummyMaterial]);
    expect(screen.getByTestId("scene-content").textContent).toBe("Thinking…");
    expect((screen.getByTestId("ask-input") as HTMLInputElement).disabled).toBe(true);

    // 2. Resolve response
    await act(async () => {
      pending1.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            data: {
              reply: {
                answer: "Skalar memperpanjang atau membalik arah vektor sebelum dijumlahkan.",
                expression: "smile",
                referenced_concept_ids: [dummyMaterial.concepts[0].concept_id],
                out_of_scope: false,
              },
              meta: { provider: "google", model: "gemini", latencyMs: 12, warnings: [] },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    });

    expect(screen.getByTestId("scene-content").textContent).toBe(
      "Skalar memperpanjang atau membalik arah vektor sebelum dijumlahkan.",
    );
    expect(screen.getByTestId("character-bubble").getAttribute("data-qa-reply")).toBe("true");
    expect((screen.getByTestId("ask-input") as HTMLInputElement).disabled).toBe(false);

    // 3. Ask follow-up question while reading answer: qa_history is carried forward
    await act(async () => {
      fireEvent.change(screen.getByTestId("ask-input"), { target: { value: "Beri contoh cepat!" } });
      fireEvent.submit(screen.getByTestId("ask-input").closest("form")!);
    });
    expect(calls).toHaveLength(2);
    const secondContext = calls[1].body.context as { qa_history: Array<{ question: string; answer: string }> };
    expect(secondContext.qa_history).toEqual([
      {
        question: "Kenapa harus dikali skalar?",
        answer: "Skalar memperpanjang atau membalik arah vektor sebelum dijumlahkan.",
      },
    ]);

    await act(async () => {
      pending2.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            data: {
              reply: {
                answer: "Misalnya 2×(1, 0) + 3×(0, 1) menghasilkan (2, 3).",
                expression: "calm",
                referenced_concept_ids: [],
                out_of_scope: false,
              },
              meta: { provider: "google", model: "gemini", latencyMs: 8, warnings: [] },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    });

    expect(screen.getByTestId("scene-content").textContent).toBe(
      "Misalnya 2×(1, 0) + 3×(0, 1) menghasilkan (2, 3).",
    );

    // 4. Advance from Q&A returns cleanly to paused story beat (without skipping it)
    act(() => {
      fireEvent.click(screen.getByTestId("story-main"));
    });
    expect(screen.getByTestId("scene-content").textContent).toBe(originalLine);

    // 5. Open ChatLog and confirm both questions + answers were logged and paused beat is not duplicated
    act(() => {
      fireEvent.click(screen.getByTestId("log-chat-button"));
    });
    const logText = screen.getByTestId("chat-log").textContent ?? "";
    expect(logText).toContain("Kenapa harus dikali skalar?");
    expect(logText).toContain("Beri contoh cepat!");
    expect(logText).toContain("Q&A");
    expect(logText.match(new RegExp(originalLine!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(1);
  });

  it("shows friendly error inline and lets the player click back to the beat", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    render(<StoryViewer story={linearStory} characters={dummyCampaign.characters} />);
    const originalLine = screen.getByTestId("scene-content").textContent;

    await act(async () => {
      fireEvent.change(screen.getByTestId("ask-input"), { target: { value: "Halo?" } });
      fireEvent.submit(screen.getByTestId("ask-input").closest("form")!);
    });

    expect(screen.getByTestId("scene-content").textContent).toBe(ASK_MESSAGES.network);

    act(() => {
      fireEvent.click(screen.getByTestId("story-main"));
    });
    expect(screen.getByTestId("scene-content").textContent).toBe(originalLine);
  });

  it("uses compact placeholder on phone viewport matching the mobile canvas spec", () => {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;

    render(<StoryViewer story={linearStory} characters={dummyCampaign.characters} />);
    const ask = screen.getByTestId("ask-input") as HTMLInputElement;
    expect(ask.disabled).toBe(false);
    expect(ask.placeholder).toBe(`Ask ${dummyCampaign.characters[0].name}…`);
  });
});
