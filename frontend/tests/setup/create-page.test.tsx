/**
 * Tests — /create page
 *
 * @vitest-environment jsdom
 *
 * Drives the page the way a user would: upload a material file, pick a
 * world, build, review the concepts, and land on the saved story. Backend
 * calls go to a fake fetch that serves the backend's fixtures
 * (tests/fixtures/backend-fetch.ts).
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import CreatePage from "@/app/create/page";
import { MAX_MATERIAL_CHARS } from "@/lib/ingest/limits";
import { BUILD_MESSAGES } from "@/lib/contracts/error-messages";
import { loadProject } from "@/lib/state/project-store";
import { setPendingMaterial, takePendingMaterial } from "@/lib/setup/pending-material";
import { backendFetch, errorResponse, fixtureErrorResponse, stepPath } from "../fixtures/backend-fetch";
import { freshStore } from "../fixtures/fresh-store";
import { Activity } from "react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

beforeEach(() => {
  takePendingMaterial();
  return freshStore();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  push.mockReset();
});

// The fake backend ignores the text and always answers with its fixtures.
const NOTES = "## Vectors\nA vector has direction and size.\n\n## Span\nThe span is every linear combination.";

/** Upload a text file as material and wait until it has been read. */
async function uploadMaterial(text: string, name = "notes.txt") {
  const file = new File([text], name, { type: "text/plain" });
  fireEvent.change(screen.getByTestId("material-file-input"), { target: { files: [file] } });
  await screen.findByTestId("document-stats", {}, { timeout: 10_000 });
}

function chooseGenre(genre: string) {
  fireEvent.click(screen.getByTestId(`genre-${genre}`).querySelector("input")!);
}

describe("/create — material sent from the home page", () => {
  it("reads a sent file", async () => {
    setPendingMaterial({ file: new File([NOTES], "week3.txt", { type: "text/plain" }), instructions: "" });
    render(<CreatePage />);

    // Reading is async; give a loaded machine more than the 1 s default.
    expect((await screen.findByTestId("document-stats", {}, { timeout: 10_000 })).textContent).toContain("2 sections");
    expect(screen.getByTestId("document-name").textContent).toBe("week3.txt");
    expect(screen.queryByTestId("material-dropzone")).toBeNull();
  });

  it("fills the storyteller instructions with the text typed on the home page", async () => {
    setPendingMaterial({
      file: new File([NOTES], "week3.txt", { type: "text/plain" }),
      instructions: "belajar vector, fokus ke dot product",
    });
    render(<CreatePage />);
    await screen.findByTestId("document-stats", {}, { timeout: 10_000 });
    // The instructions live behind the "Advanced options" link of the CHAPTERS section.
    fireEvent.click(screen.getByTestId("advanced-toggle"));

    expect((screen.getByLabelText("Instructions for the storyteller") as HTMLTextAreaElement).value).toBe(
      "belajar vector, fokus ke dot product"
    );
  });

  it("shows why a sent file cannot be read", async () => {
    setPendingMaterial({ file: new File(["x"], "old.doc", { type: "application/msword" }), instructions: "" });
    render(<CreatePage />);

    expect((await screen.findByTestId("document-error", {}, { timeout: 10_000 })).textContent).toMatch(/\S/);
    expect(screen.getByTestId("document-card").dataset.status).toBe("error");
  });

  it("uses the material once, then starts empty", async () => {
    setPendingMaterial({ file: new File([NOTES], "week3.txt", { type: "text/plain" }), instructions: "" });
    const first = render(<CreatePage />);
    await screen.findByTestId("document-stats", {}, { timeout: 10_000 });
    first.unmount();

    render(<CreatePage />);
    expect(screen.getByTestId("material-dropzone")).toBeTruthy();
  });

  it("still lets the player choose a world and build", async () => {
    setPendingMaterial({ file: new File([NOTES], "week3.txt", { type: "text/plain" }), instructions: "" });
    render(<CreatePage />);
    await screen.findByTestId("document-stats", {}, { timeout: 10_000 });
    chooseGenre("fantasy");

    expect(screen.getByTestId("build-button")).toBeEnabled();
  });
});

describe("/create — material step", () => {
  it("starts with an upload area and a disabled build button", () => {
    render(<CreatePage />);
    expect(screen.getByTestId("material-dropzone")).toBeTruthy();
    expect(screen.queryByTestId("paste-mode-button")).toBeNull(); // text is never material
    expect(screen.queryByTestId("paste-textarea")).toBeNull();
    expect(screen.getByTestId("build-button")).toBeDisabled();
    expect(screen.getByTestId("submit-hint").textContent).toBe("Upload a material file to begin.");
  });

  it("turns an uploaded file into selectable sections", async () => {
    render(<CreatePage />);
    await uploadMaterial(NOTES);

    expect(screen.getByTestId("document-card").dataset.status).toBe("ready");
    expect(screen.getByTestId("document-name").textContent).toBe("notes.txt");
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

  it("updates the character count when sections are deselected", async () => {
    render(<CreatePage />);
    await uploadMaterial(NOTES);
    const before = screen.getByTestId("material-budget-count").textContent;
    fireEvent.click(screen.getByTestId("section-checkbox-sec_002"));
    expect(screen.getByTestId("material-budget-count").textContent).not.toBe(before);
  });

  it("blocks building when the selected text is over the limit", async () => {
    render(<CreatePage />);
    await uploadMaterial("x".repeat(MAX_MATERIAL_CHARS + 100));
    chooseGenre("fantasy");
    expect(screen.getByTestId("build-button")).toBeDisabled();
    expect(screen.getByTestId("submit-hint").textContent).toContain("over the limit");
  });
});

describe("/create — build", () => {
  async function startBuild(override?: Parameters<typeof backendFetch>[0]) {
    const route = backendFetch(override);
    vi.stubGlobal("fetch", route.fetchImpl);
    render(<CreatePage />);
    await uploadMaterial(NOTES);
    chooseGenre("fantasy");
    await act(async () => {
      fireEvent.click(screen.getByTestId("build-button"));
    });
    return route;
  }

  it("enables building once material and a world are chosen", async () => {
    render(<CreatePage />);
    await uploadMaterial(NOTES);
    expect(screen.getByTestId("submit-hint").textContent).toBe("Choose a world for your story.");
    chooseGenre("science_fiction");
    expect(screen.getByTestId("build-button")).toBeEnabled();
  });

  it("asks the player to review the concepts before writing anything", async () => {
    const route = await startBuild();
    expect(await screen.findByTestId("concept-review")).toBeTruthy();
    expect(screen.getByTestId("step-analyzing").dataset.status).toBe("done");
    expect(screen.getByTestId("step-reviewing").dataset.status).toBe("active");
    expect(route.calls.map((c) => c.path)).toEqual([stepPath("analyze-material")]);
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
      stepPath("analyze-material"),
      stepPath("plan-campaign"),
      stepPath("generate-story"),
    ]);
    const id = (push.mock.calls[0][0] as string).replace("/play/", "");
    const saved = await loadProject(id);
    expect(saved?.source).toEqual({ file_name: "notes.txt", file_type: "text" });
    const story = Object.values(saved!.stories)[0];
    expect(story.story_id).toBe("story_01");
    // the backend was only shown the concept the player kept
    const keptConcepts = (route.calls[2].body as { material: { concepts: unknown[] } }).material.concepts;
    expect(keptConcepts).toHaveLength(1);
  });

  it("does not let the player continue with no concepts", async () => {
    await startBuild();
    await screen.findByTestId("concept-review");
    for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
    expect(screen.getByTestId("confirm-concepts")).toBeDisabled();
  });

  it("tells the player when no AI is set up, instead of building a story", async () => {
    await startBuild((call) =>
      call.path === stepPath("analyze-material")
        ? errorResponse("PROVIDER_NOT_CONFIGURED", 503)
        : undefined
    );

    const alert = await screen.findByTestId("generation-error");
    expect(alert.textContent).toContain(BUILD_MESSAGES.notConfigured);
    expect(screen.getByTestId("step-analyzing").dataset.status).toBe("failed");
    expect(screen.getByTestId("generation-retry")).toBeTruthy();
    expect(screen.queryByTestId("concept-review")).toBeNull();
  });

  it("tells the player when no concepts were found in the material", async () => {
    await startBuild((call) =>
      call.path === stepPath("analyze-material")
        ? fixtureErrorResponse("error-material-analysis-failed.json", 422)
        : undefined
    );

    expect((await screen.findByTestId("generation-error")).textContent).toContain(BUILD_MESSAGES.noConcepts);
    expect(screen.queryByTestId("concept-review")).toBeNull();
  });

  it("shows a busy message and retries just the failed stage", async () => {
    let failOnce = true;
    const route = await startBuild((call) => {
      if (call.path === stepPath("generate-story") && failOnce) {
        failOnce = false;
        return errorResponse("PROVIDER_UNAVAILABLE", 503);
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
    expect(route.calls.filter((c) => c.path === stepPath("plan-campaign"))).toHaveLength(1);
  });

  it("goes back to the filled-in form", async () => {
    await startBuild();
    await screen.findByTestId("concept-review");
    fireEvent.click(screen.getByText("Back to edit"));
    expect(screen.getByTestId("create-page")).toBeTruthy();
    expect(screen.getByTestId("document-name").textContent).toBe("notes.txt");
  });

  it("still plays the story, with a warning, when it cannot be saved", async () => {
    await startBuild();
    await screen.findByTestId("concept-review");
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
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
    vi.stubGlobal("fetch", backendFetch().fetchImpl);
    const page = (mode: "visible" | "hidden") => (
      <Activity mode={mode}>
        <CreatePage />
      </Activity>
    );
    const view = render(page("visible"));
    await uploadMaterial(NOTES);
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

  it("keeps an unfinished form when the player leaves before building", async () => {
    const page = (mode: "visible" | "hidden") => (
      <Activity mode={mode}>
        <CreatePage />
      </Activity>
    );
    const view = render(page("visible"));
    await uploadMaterial(NOTES);
    view.rerender(page("hidden"));
    view.rerender(page("visible"));
    expect(screen.getByTestId("document-name").textContent).toBe("notes.txt");
  });
});

describe("/create — phone and desktop are the same page", () => {
  const WIDTHS = { phone: 390, desktop: 1440 } as const;

  /** Pretend the window is `width` px wide. The page has one tree; only CSS (md:) differs. */
  function setViewport(width: number) {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
    vi.stubGlobal(
      "matchMedia",
      (query: string) => {
        const min = /min-width:\s*(\d+)px/.exec(query);
        const max = /max-width:\s*(\d+)px/.exec(query);
        const matches = (min ? width >= Number(min[1]) : true) && (max ? width <= Number(max[1]) : true);
        return {
          matches,
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        };
      }
    );
  }

  const testIds = (root: HTMLElement) =>
    Array.from(root.querySelectorAll("[data-testid]"), (el) => el.getAttribute("data-testid")).sort();

  /** Same input at a given width: record the DOM ids, validation hints, and the request sent. */
  async function runFlow(width: number) {
    setViewport(width);
    const route = backendFetch();
    vi.stubGlobal("fetch", route.fetchImpl);
    const view = render(<CreatePage />);

    const hints = [screen.getByTestId("submit-hint").textContent];
    const emptyDisabled = (screen.getByTestId("build-button") as HTMLButtonElement).disabled;
    const emptyIds = testIds(view.container);

    await uploadMaterial(NOTES);
    hints.push(screen.getByTestId("submit-hint").textContent);
    chooseGenre("fantasy");
    hints.push(screen.getByTestId("submit-hint").textContent);
    const readyEnabled = (screen.getByTestId("build-button") as HTMLButtonElement).disabled === false;
    const readyIds = testIds(view.container);

    await act(async () => {
      fireEvent.click(screen.getByTestId("build-button"));
    });
    await screen.findByTestId("concept-review");
    const payload = route.calls[0];
    view.unmount();
    return { hints, emptyDisabled, emptyIds, readyEnabled, readyIds, payload };
  }

  it("gives identical DOM, validation results and payload at phone and desktop widths", async () => {
    const phone = await runFlow(WIDTHS.phone);
    takePendingMaterial();
    const desktop = await runFlow(WIDTHS.desktop);

    expect(phone.emptyIds).toEqual(desktop.emptyIds);
    expect(phone.readyIds).toEqual(desktop.readyIds);
    expect(phone.hints).toEqual(desktop.hints);
    expect(phone.hints[0]).toBe("Upload a material file to begin.");
    expect(phone.emptyDisabled).toBe(true);
    expect(desktop.emptyDisabled).toBe(true);
    expect(phone.readyEnabled).toBe(true);
    expect(desktop.readyEnabled).toBe(true);
    expect(phone.payload).toEqual(desktop.payload);
  });

  it.each(Object.entries(WIDTHS))("keeps the build button disabled without a file at %s width", (_name, width) => {
    setViewport(width);
    render(<CreatePage />);
    const button = screen.getByTestId("build-button");
    expect(button).toBeDisabled();
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByTestId("submit-hint").textContent).toBe("Upload a material file to begin.");
    chooseGenre("fantasy"); // a world alone does not unlock the build
    expect(button).toBeDisabled();
  });

  it.each(Object.entries(WIDTHS))("does not reset the form when the back link is used at %s width", async (_name, width) => {
    setViewport(width);
    render(<CreatePage />);
    await uploadMaterial(NOTES);
    chooseGenre("science_fiction");
    fireEvent.click(screen.getByTestId("advanced-toggle"));
    fireEvent.change(screen.getByLabelText("Instructions for the storyteller"), {
      target: { value: "focus on dot product" },
    });

    const back = screen.getByTestId("prep-back");
    expect(back.getAttribute("href")).toBe("/");
    fireEvent.click(back);

    expect(screen.getByTestId("document-name").textContent).toBe("notes.txt");
    expect(screen.getByTestId("genre-science_fiction").querySelector("input")).toBeChecked();
    expect((screen.getByLabelText("Instructions for the storyteller") as HTMLTextAreaElement).value).toBe(
      "focus on dot product"
    );
    expect(screen.getByTestId("build-button")).toBeEnabled();
  });
});
