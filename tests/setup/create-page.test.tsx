/**
 * Tests — /create page
 *
 * @vitest-environment jsdom
 *
 * Drives the page the way a user would: paste or upload material, pick a
 * world, build, review the concepts, and land on the saved story. Server
 * calls go to the real AI route handlers in-process (dummy provider).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import CreatePage from "@/app/create/page";
import { MAX_MATERIAL_CHARS } from "@/lib/ingest/limits";
import { BUILD_MESSAGES } from "@/lib/setup/request-campaign";
import { loadProject } from "@/lib/state/project-store";
import { routeFetch } from "../fixtures/route-fetch";
import { Activity } from "react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  push.mockReset();
  window.localStorage.clear();
});

// Mentions "linear combination", so the dummy provider returns two concepts.
const NOTES = "## Vectors\nA vector has direction and size.\n\n## Span\nThe span is every linear combination.";

function pasteMaterial(text: string) {
  fireEvent.click(screen.getByTestId("paste-mode-button"));
  fireEvent.change(screen.getByTestId("paste-textarea"), { target: { value: text } });
  fireEvent.click(screen.getByTestId("paste-submit"));
}

function chooseGenre(genre: string) {
  fireEvent.click(screen.getByTestId(`genre-${genre}`).querySelector("input")!);
}

describe("/create — material step", () => {
  it("starts with an upload area and a disabled build button", () => {
    render(<CreatePage />);
    expect(screen.getByTestId("material-dropzone")).toBeTruthy();
    expect(screen.getByTestId("build-button")).toBeDisabled();
    expect(screen.getByTestId("submit-hint").textContent).toBe("Add your material to begin.");
  });

  it("turns pasted text into selectable sections", () => {
    render(<CreatePage />);
    pasteMaterial(NOTES);

    expect(screen.getByTestId("document-card").dataset.status).toBe("ready");
    expect(screen.getByTestId("document-name").textContent).toBe("Pasted text");
    expect(screen.getByTestId("section-checkbox-sec_001")).toBeChecked();
    expect(screen.getByTestId("section-checkbox-sec_002")).toBeChecked();
  });

  it("reads an uploaded text file", async () => {
    render(<CreatePage />);
    const file = new File([NOTES], "week3.txt", { type: "text/plain" });
    fireEvent.change(screen.getByTestId("material-file-input"), { target: { files: [file] } });

    // The card shows the file name while reading; stats appear only once it is ready.
    expect(screen.getByTestId("document-card").dataset.status).toBe("reading");
    expect((await screen.findByTestId("document-stats")).textContent).toContain("2 sections");
    expect(screen.getByTestId("document-card").dataset.status).toBe("ready");
    expect(screen.getByTestId("document-name").textContent).toBe("week3.txt");
  });

  it("shows a helpful error for an old PowerPoint file and lets the user start over", async () => {
    render(<CreatePage />);
    const file = new File(["x"], "lecture.ppt", { type: "application/vnd.ms-powerpoint" });
    fireEvent.change(screen.getByTestId("material-file-input"), { target: { files: [file] } });

    expect((await screen.findByTestId("document-error")).textContent).toContain(".pptx");
    fireEvent.click(screen.getByTestId("document-remove"));
    expect(screen.getByTestId("material-dropzone")).toBeTruthy();
  });

  it("updates the character count when sections are deselected", () => {
    render(<CreatePage />);
    pasteMaterial(NOTES);
    const before = screen.getByTestId("material-budget-count").textContent;
    fireEvent.click(screen.getByTestId("section-checkbox-sec_002"));
    expect(screen.getByTestId("material-budget-count").textContent).not.toBe(before);
  });

  it("blocks building when the selected text is over the limit", () => {
    render(<CreatePage />);
    pasteMaterial("x".repeat(MAX_MATERIAL_CHARS + 100));
    chooseGenre("fantasy");
    expect(screen.getByTestId("build-button")).toBeDisabled();
    expect(screen.getByTestId("submit-hint").textContent).toContain("over the limit");
  });
});

describe("/create — build", () => {
  async function startBuild(override?: Parameters<typeof routeFetch>[0]) {
    const route = routeFetch(override);
    vi.stubGlobal("fetch", route.fetchImpl);
    render(<CreatePage />);
    pasteMaterial(NOTES);
    chooseGenre("fantasy");
    await act(async () => {
      fireEvent.click(screen.getByTestId("build-button"));
    });
    return route;
  }

  it("enables building once material and a world are chosen", () => {
    render(<CreatePage />);
    pasteMaterial(NOTES);
    expect(screen.getByTestId("submit-hint").textContent).toBe("Choose a world for your story.");
    chooseGenre("science_fiction");
    expect(screen.getByTestId("build-button")).toBeEnabled();
  });

  it("asks the player to review the concepts before writing anything", async () => {
    const route = await startBuild();
    expect(await screen.findByTestId("concept-review")).toBeTruthy();
    expect(screen.getByTestId("step-analyzing").dataset.status).toBe("done");
    expect(screen.getByTestId("step-reviewing").dataset.status).toBe("active");
    expect(route.calls.map((c) => c.path)).toEqual(["/api/ai/analyze-material"]);
    expect((route.calls[0].body as { material: string }).material).toBe(
      "[Part 1] Vectors\nA vector has direction and size.\n\n[Part 2] Span\nThe span is every linear combination."
    );
  });

  it("writes the story with the kept concepts, saves it, and opens it", async () => {
    const route = await startBuild();
    await screen.findByTestId("concept-review");
    const boxes = screen.getAllByRole("checkbox");
    fireEvent.click(boxes[0]); // drop the first concept
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-concepts"));
    });

    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(route.calls.map((c) => c.path)).toEqual([
      "/api/ai/analyze-material",
      "/api/ai/plan-campaign",
      "/api/ai/generate-story",
    ]);
    const id = (push.mock.calls[0][0] as string).replace("/play/", "");
    const saved = loadProject(id);
    expect(saved?.source).toEqual({ file_name: "Pasted text", file_type: "text" });
    const story = Object.values(saved!.stories)[0];
    expect(story.knowledge_mapping).toHaveLength(1);
  });

  it("does not let the player continue with no concepts", async () => {
    await startBuild();
    await screen.findByTestId("concept-review");
    for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
    expect(screen.getByTestId("confirm-concepts")).toBeDisabled();
  });

  it("shows a busy message and retries just the failed stage", async () => {
    let failOnce = true;
    const route = await startBuild((call) => {
      if (call.path === "/api/ai/generate-story" && failOnce) {
        failOnce = false;
        return new Response(JSON.stringify({ ok: false, error: { code: "PROVIDER_UNAVAILABLE", message: "x" } }), { status: 503 });
      }
      return undefined;
    });
    await screen.findByTestId("concept-review");
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-concepts"));
    });

    expect((await screen.findByTestId("generation-error")).textContent).toContain(BUILD_MESSAGES.busy);
    expect(screen.getByTestId("world-preview")).toBeTruthy(); // the planned world is kept
    expect(screen.getByTestId("step-writing").dataset.status).toBe("failed");

    await act(async () => {
      fireEvent.click(screen.getByTestId("generation-retry"));
    });
    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(route.calls.filter((c) => c.path === "/api/ai/plan-campaign")).toHaveLength(1);
  });

  it("goes back to the filled-in form", async () => {
    await startBuild();
    await screen.findByTestId("concept-review");
    fireEvent.click(screen.getByText("Back to edit"));
    expect(screen.getByTestId("create-page")).toBeTruthy();
    expect(screen.getByTestId("document-name").textContent).toBe("Pasted text");
  });

  it("still plays the story, with a warning, when it cannot be saved", async () => {
    await startBuild();
    await screen.findByTestId("concept-review");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-concepts"));
    });

    expect((await screen.findByTestId("create-save-error")).textContent).toContain("storage is full");
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByTestId("story-viewer")).toBeTruthy();
  });
});

describe("/create — returning after a story was built", () => {
  // Next.js (cacheComponents) keeps a page we leave mounted inside a hidden
  // React <Activity> and shows it again on return, state included.
  it("shows a fresh form, not the finished build screen", async () => {
    vi.stubGlobal("fetch", routeFetch().fetchImpl);
    const page = (mode: "visible" | "hidden") => (
      <Activity mode={mode}>
        <CreatePage />
      </Activity>
    );
    const view = render(page("visible"));
    pasteMaterial(NOTES);
    chooseGenre("fantasy");
    await act(async () => {
      fireEvent.click(screen.getByTestId("build-button"));
    });
    await screen.findByTestId("concept-review");
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-concepts"));
    });
    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));

    // Navigate away, then come back.
    view.rerender(page("hidden"));
    view.rerender(page("visible"));

    expect(screen.queryByTestId("generation-screen")).toBeNull();
    expect(screen.getByTestId("material-dropzone")).toBeTruthy();
    expect(screen.getByTestId("build-button")).toBeDisabled();
    expect(screen.getByTestId("genre-fantasy").querySelector("input")).not.toBeChecked();
  });

  it("keeps an unfinished form when the player leaves before building", () => {
    const page = (mode: "visible" | "hidden") => (
      <Activity mode={mode}>
        <CreatePage />
      </Activity>
    );
    const view = render(page("visible"));
    pasteMaterial(NOTES);
    view.rerender(page("hidden"));
    view.rerender(page("visible"));
    expect(screen.getByTestId("document-name").textContent).toBe("Pasted text");
  });
});
