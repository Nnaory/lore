/**
 * Tests — Home components (task 5.9)
 *
 * @vitest-environment jsdom
 *
 * Gaps left by home-composer / home-page tests: hero structure per layout,
 * DialogueBox bottomBar/padLeft, ScaledBoard inFlow, SavedStories behaviour,
 * the label on the input, rejected files and the handoff to /create.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Home from "@/app/page";
import { HomeHero } from "@/components/home/HomeHero";
import { SavedStories } from "@/components/home/SavedStories";
import { DialogueBox } from "@/components/story/DialogueBox";
import { ScaledBoard } from "@/components/stage/ScaledBoard";
import { createProject, listProjects } from "@/lib/state/project-store";
import { MAX_FILE_BYTES } from "@/lib/ingest/limits";
import { takePendingMaterial } from "@/lib/setup/pending-material";
import { dummyCampaign } from "@/data/dummy-campaign";
import { linearStory } from "../fixtures/linear-story";
import { freshStore } from "../fixtures/fresh-store";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

/** matchMedia stub: the desktop query follows the width. */
function stubViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
  window.matchMedia = ((query: string) => ({
    matches: query.includes("min-width") ? width >= 768 : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(async () => {
  await freshStore();
  push.mockReset();
  takePendingMaterial();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  stubViewport(1440, 900);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const txt = (name = "notes.txt") => new File(["## Vectors"], name, { type: "text/plain" });

describe("HomeHero layouts", () => {
  it("desktop: 1440x900 board, tall dialogue, inline demo link, composer in a row", () => {
    render(<HomeHero />);
    expect(screen.getByTestId("scaled-board").dataset.layout).toBe("desktop");
    expect(screen.getByTestId("home-dialogue").className).toContain("h-[212px]");
    expect(screen.getByTestId("home-hazel").style.width).toBe("264px");
    expect(screen.getByTestId("home-demo-link").className).not.toContain("absolute");
    expect(screen.getByTestId("home-composer").className).not.toContain("flex-col");
  });

  it("phone: 390x844 board, bust behind the box, pinned demo link, stacked composer", () => {
    stubViewport(390, 844);
    render(<HomeHero />);
    expect(screen.getByTestId("scaled-board").dataset.layout).toBe("phone");
    expect(screen.getByTestId("home-dialogue").className).not.toContain("h-[212px]");
    expect(screen.getByTestId("home-hazel").style.width).toBe("238px");
    expect(screen.getByTestId("home-demo-link").className).toContain("absolute");
    expect(screen.getByTestId("home-composer").className).toContain("flex-col");
  });

  it("flows in the page so content can follow the hero", () => {
    render(<HomeHero />);
    expect(screen.getByTestId("scaled-board-root").style.position).toBe("relative");
  });
});

describe("ScaledBoard inFlow", () => {
  it("flows at the scaled height, unlike the default root; neither root paints an ink fill", () => {
    stubViewport(720, 450);
    const { unmount } = render(<ScaledBoard inFlow rootClassName="extra">{null}</ScaledBoard>);
    let root = screen.getByTestId("scaled-board-root");
    expect(root.style.position).toBe("relative");
    expect(root.style.width).toBe("100%");
    expect(root.className).toContain("extra");
    expect(root.className).not.toContain("bg-ink");
    unmount();

    render(<ScaledBoard>{null}</ScaledBoard>);
    root = screen.getByTestId("scaled-board-root");
    expect(root.style.position).toBe("fixed");
    // The shared animated backdrop must show through the Stage root as well.
    expect(root.className).not.toContain("bg-ink");
  });
});

describe("DialogueBox bottomBar and padLeft", () => {
  const base = {
    speakerName: "Hazel",
    speakerRole: "Witch",
    text: "Hello",
    mode: "fast" as const,
    onModeChange: () => {},
    onOpenLog: () => {},
  };

  it("replaces the whole bottom bar with the given node", () => {
    render(
      <DialogueBox {...base} testIds={{ root: "dlg", ask: "dlg-ask" }} bottomBar={<div data-testid="custom-bar" />} />,
    );
    expect(within(screen.getByTestId("dlg")).getByTestId("custom-bar")).toBeTruthy();
    expect(screen.queryByTestId("dlg-ask")).toBeNull();
  });

  it("keeps the default bar when no bottomBar is given", () => {
    render(<DialogueBox {...base} testIds={{ root: "dlg", ask: "dlg-ask" }} />);
    expect(screen.getByTestId("dlg-ask")).toBeTruthy();
  });

  it("sets the left inset variable only when padLeft is given", () => {
    const { rerender } = render(<DialogueBox {...base} testIds={{ root: "dlg" }} padLeft={40} />);
    expect(screen.getByTestId("dlg").style.getPropertyValue("--dlg-pl")).toBe("40px");
    rerender(<DialogueBox {...base} testIds={{ root: "dlg" }} />);
    expect(screen.getByTestId("dlg").style.getPropertyValue("--dlg-pl")).toBe("");
  });
});

describe("Home composer file handling", () => {
  it("the input has an accessible label", () => {
    render(<Home />);
    expect(screen.getByLabelText("Instructions for the storyteller")).toBe(screen.getByTestId("home-input"));
  });

  it.each([
    ["empty", new File([], "empty.txt", { type: "text/plain" }), /empty/i],
    ["too large", Object.defineProperty(txt("big.txt"), "size", { value: MAX_FILE_BYTES + 1 }), /larger than/i],
  ])("rejects an %s file, keeping the valid file and the text", async (_label, bad, message) => {
    const user = userEvent.setup({ applyAccept: false });
    render(<Home />);
    await user.upload(screen.getByTestId("home-file-input"), txt("good.txt"));
    await user.type(screen.getByTestId("home-input"), "keep me");
    await user.upload(screen.getByTestId("home-file-input"), bad as File);

    expect(screen.getByTestId("home-file-error").textContent).toMatch(message);
    expect(screen.getByTestId("home-file-chip").textContent).toContain("good.txt");
    expect((screen.getByTestId("home-input") as HTMLTextAreaElement).value).toBe("keep me");
  });

  it("sending text without a file stays on Home with the file-required error", async () => {
    const user = userEvent.setup();
    render(<Home />);
    await user.type(screen.getByTestId("home-input"), "belajar vector{Enter}");
    expect(push).not.toHaveBeenCalled();
    expect(takePendingMaterial()).toBeNull();
    expect(screen.getByTestId("home-file-required").getAttribute("role")).toBe("alert");
    expect((screen.getByTestId("home-input") as HTMLTextAreaElement).value).toBe("belajar vector");
  });

  it("hands the same { file, instructions } payload to /create, once", async () => {
    const user = userEvent.setup();
    render(<Home />);
    const file = txt("week3.txt");
    await user.upload(screen.getByTestId("home-file-input"), file);
    await user.type(screen.getByTestId("home-input"), "focus on dot product");
    await user.click(screen.getByTestId("home-send"));

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/create");
    const taken = takePendingMaterial();
    expect(Object.keys(taken ?? {}).sort()).toEqual(["file", "instructions"]);
    expect(taken?.file).toBe(file);
    expect(taken?.instructions).toBe("focus on dot product");
    expect(takePendingMaterial()).toBeNull();
  });
});

describe("SavedStories", () => {
  async function save(fileName: string) {
    const result = await createProject({
      source: { file_name: fileName, file_type: "pdf" },
      campaign: dummyCampaign,
      stories: new Map([[linearStory.story_id, linearStory]]),
    });
    if (!result.ok) throw new Error(result.message);
    return result.value;
  }

  it("renders nothing when there are no saved stories", async () => {
    const { container } = render(<SavedStories />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(container.innerHTML).toBe("");
    expect(screen.queryByTestId("saved-stories")).toBeNull();
  });

  it("lists newest first with a Continue link to /play/<id>", async () => {
    const first = await save("first.pdf");
    await new Promise((r) => setTimeout(r, 5));
    const second = await save("second.pdf");
    render(<SavedStories />);

    const list = await screen.findByTestId("saved-stories");
    const rows = within(list).getAllByTestId(/^saved-story-/);
    expect(rows.map((r) => r.dataset.testid)).toEqual([`saved-story-${second.id}`, `saved-story-${first.id}`]);
    expect(rows[0].textContent).toContain("second.pdf");
    expect(screen.getByTestId(`continue-${first.id}`).getAttribute("href")).toBe(`/play/${first.id}`);
    expect(screen.getByTestId(`continue-${second.id}`).getAttribute("href")).toBe(`/play/${second.id}`);
  });

  it("deletes in two steps, and Keep cancels", async () => {
    const user = userEvent.setup();
    const p = await save("week3.pdf");
    render(<SavedStories />);

    await user.click(await screen.findByTestId(`delete-${p.id}`));
    expect(screen.getByTestId(`confirm-delete-${p.id}`)).toBeTruthy();
    expect(screen.queryByTestId(`continue-${p.id}`)).toBeNull();
    expect(await listProjects()).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.getByTestId(`delete-${p.id}`)).toBeTruthy();
    expect(await listProjects()).toHaveLength(1);

    await user.click(screen.getByTestId(`delete-${p.id}`));
    await user.click(screen.getByTestId(`confirm-delete-${p.id}`));
    await waitFor(() => expect(screen.queryByTestId("saved-stories")).toBeNull());
    expect(await listProjects()).toEqual([]);
  });
});
