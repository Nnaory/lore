/**
 * Tests — Prep screen components (PrepColumn, SectionLabel, MaterialInput,
 * DocumentCard, GenrePicker, action bar)
 *
 * @vitest-environment jsdom
 *
 * Covers what chapters-section.test.tsx and create-page.test.tsx do not:
 * the column frame, the drop zone vs file card states, the single-select world
 * picker, the action bar styling, and that a rejected file keeps the player's
 * world, chapter count and instructions (Requirements 9.6, 9.7, 9.8, 9.11, 9.12).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import CreatePage from "@/app/create/page";
import { PrepColumn } from "@/components/setup/PrepColumn";
import { MaterialInput } from "@/components/setup/MaterialInput";
import { DocumentCard } from "@/components/setup/DocumentCard";
import { GenrePicker } from "@/components/setup/GenrePicker";
import { SectionLabel } from "@/components/ui/SectionLabel";
import { MAX_FILE_BYTES } from "@/lib/ingest/limits";
import { takePendingMaterial } from "@/lib/setup/pending-material";
import { freshStore } from "../fixtures/fresh-store";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

beforeEach(() => {
  takePendingMaterial();
  return freshStore();
});
afterEach(() => vi.restoreAllMocks());

const NOTES = "## Vectors\nA vector has direction and size.\n\n## Span\nEvery linear combination.";

async function uploadFile(file: File, readyOrError: "document-stats" | "document-error") {
  fireEvent.change(screen.getByTestId("material-file-input"), { target: { files: [file] } });
  await screen.findByTestId(readyOrError, {}, { timeout: 10_000 });
}

describe("PrepColumn", () => {
  it("renders the column frame with children, a back link and decorative pumpkins", () => {
    render(
      <PrepColumn backHref="/home">
        <p data-testid="child">hello</p>
      </PrepColumn>
    );
    expect(screen.getByTestId("prep-column")).toContainElement(screen.getByTestId("child"));
    expect(screen.getByTestId("prep-back").getAttribute("href")).toBe("/home");
    expect(screen.queryByTestId("prep-pumpkins")).toBeNull(); // the shared animated backdrop is used instead
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Turn your material into a story");
    expect(screen.getByText("NEW STORY")).toBeTruthy();
  });

  it("links back to / by default", () => {
    render(<PrepColumn />);
    expect(screen.getByTestId("prep-back").getAttribute("href")).toBe("/");
  });
});

describe("SectionLabel", () => {
  it("shows the number and title with a decorative rule", () => {
    render(<SectionLabel number="02" title="WORLD" data-testid="label" />);
    const label = screen.getByTestId("label");
    expect(within(label).getByText("02")).toBeTruthy();
    expect(within(label).getByText("WORLD")).toBeTruthy();
    expect(label.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });
});

describe("MaterialInput", () => {
  it("is a dashed empty drop zone with a Choose a file button", () => {
    render(<MaterialInput onFile={() => {}} />);
    const zone = screen.getByTestId("material-dropzone");
    expect(zone.className).toContain("border-dashed");
    expect(zone.className).not.toContain("border-gold");
    expect(screen.getByText("Choose a file")).toBeTruthy();
    expect(screen.getByText(/up to 25 MB/)).toBeTruthy();
  });

  it("turns solid gold while a file is dragged over and back on leave", () => {
    render(<MaterialInput onFile={() => {}} />);
    const zone = screen.getByTestId("material-dropzone");
    fireEvent.dragEnter(zone);
    expect(zone.className).toContain("border-solid");
    expect(zone.className).toContain("border-gold");
    fireEvent.dragLeave(zone);
    expect(zone.className).toContain("border-dashed");
  });

  it("passes a dropped file to onFile", () => {
    const onFile = vi.fn();
    render(<MaterialInput onFile={onFile} />);
    const file = new File(["x"], "a.txt", { type: "text/plain" });
    fireEvent.drop(screen.getByTestId("material-dropzone"), { dataTransfer: { files: [file] } });
    expect(onFile).toHaveBeenCalledWith(file);
  });
});

describe("DocumentCard", () => {
  const noop = () => {};

  it("shows a gold solid card with Replace once a file is read", async () => {
    render(<CreatePage />);
    await uploadFile(new File([NOTES], "notes.txt", { type: "text/plain" }), "document-stats");
    const card = screen.getByTestId("document-card");
    expect(card.firstElementChild!.className).toContain("border-gold");
    expect(card.firstElementChild!.className).not.toContain("border-dashed");
    expect(screen.getByTestId("document-remove").textContent).toBe("Replace");
    expect(screen.queryByTestId("document-error")).toBeNull();
  });

  it("shows the reading state with the file name", () => {
    render(
      <DocumentCard
        doc={{ status: "reading", fileName: "big.pdf", requestId: 1 } as never}
        materialLength={0}
        onRemove={noop}
        onToggle={noop}
        onSetAll={noop}
      />
    );
    expect(screen.getByTestId("document-card").dataset.status).toBe("reading");
    expect(screen.getByTestId("document-name").textContent).toBe("big.pdf");
    expect(screen.getByText("Reading…")).toBeTruthy();
  });

  it("shows an error line and Choose another for a read failure, then clears on click", () => {
    const onRemove = vi.fn();
    render(
      <DocumentCard
        doc={
          {
            status: "error",
            fileName: "broken.pdf",
            error: { code: "CORRUPT_FILE", message: "This file looks damaged." },
          } as never
        }
        materialLength={0}
        onRemove={onRemove}
        onToggle={noop}
        onSetAll={noop}
      />
    );
    expect(screen.getByTestId("document-error").textContent).toContain("This file looks damaged.");
    expect(screen.getByTestId("document-card").firstElementChild!.className).toContain("border-dashed");
    const button = screen.getByTestId("document-remove");
    expect(button.textContent).toBe("Choose another");
    fireEvent.click(button);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

describe("GenrePicker", () => {
  it("lays out three columns with none selected when value is null", () => {
    render(<GenrePicker value={null} onChange={() => {}} />);
    expect(screen.getByTestId("genre-picker").className).toContain("grid-cols-3");
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(radios.filter((r) => (r as HTMLInputElement).checked)).toHaveLength(0);
  });

  it("selects exactly one cell and reports the choice", () => {
    const onChange = vi.fn();
    const { rerender } = render(<GenrePicker value="modern" onChange={onChange} />);
    expect(screen.getByTestId("genre-modern").className).toContain("bg-cream");
    expect(screen.getByTestId("genre-fantasy").className).not.toContain("bg-cream");
    expect(screen.getAllByRole("radio").filter((r) => (r as HTMLInputElement).checked)).toHaveLength(1);

    fireEvent.click(screen.getByTestId("genre-fantasy").querySelector("input")!);
    expect(onChange).toHaveBeenCalledWith("fantasy");

    rerender(<GenrePicker value="fantasy" onChange={onChange} />);
    expect(screen.getAllByRole("radio").filter((r) => (r as HTMLInputElement).checked)).toHaveLength(1);
    expect(screen.getByTestId("genre-modern").className).not.toContain("bg-cream");
  });
});

describe("Prep action bar", () => {
  it("is smoke/muted with aria-disabled and a hint while blocked", () => {
    render(<CreatePage />);
    const button = screen.getByTestId("build-button");
    expect(button).toBeDisabled();
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.className).toContain("bg-smoke");
    expect(button.className).toContain("text-muted");
    expect(screen.getByTestId("submit-hint").getAttribute("aria-live")).toBe("polite");
    expect(screen.getByTestId("submit-hint").textContent).toBe("Upload a material file to begin.");
  });

  it("is ember/ink and announces Ready with chapters and world once complete", async () => {
    render(<CreatePage />);
    await uploadFile(new File([NOTES], "notes.txt", { type: "text/plain" }), "document-stats");
    fireEvent.click(screen.getByTestId("genre-modern").querySelector("input")!);

    const button = screen.getByTestId("build-button");
    expect(button).toBeEnabled();
    expect(button.getAttribute("aria-disabled")).toBe("false");
    expect(button.className).toContain("bg-ember");
    expect(button.className).toContain("text-ink");
    expect(screen.getByTestId("submit-hint").textContent).toBe("Ready · 3 chapters · Non-fiction");

    fireEvent.click(screen.getByTestId("chapters-5"));
    expect(screen.getByTestId("submit-hint").textContent).toBe("Ready · 5 chapters · Non-fiction");
  });
});

describe("Prep — a rejected file keeps the player's choices", () => {
  async function setChoices() {
    fireEvent.click(screen.getByTestId("genre-science_fiction").querySelector("input")!);
    fireEvent.click(screen.getByTestId("chapters-5"));
    fireEvent.click(screen.getByTestId("advanced-toggle"));
    fireEvent.change(screen.getByLabelText("Instructions for the storyteller"), {
      target: { value: "focus on dot products" },
    });
  }

  function expectChoicesKept() {
    expect((screen.getByTestId("genre-science_fiction").querySelector("input") as HTMLInputElement).checked).toBe(
      true
    );
    expect(screen.getByTestId("chapters-5").getAttribute("aria-checked")).toBe("true");
    expect((screen.getByLabelText("Instructions for the storyteller") as HTMLTextAreaElement).value).toBe(
      "focus on dot products"
    );
  }

  it("keeps world, chapters and instructions after an unsupported type, and blocks Build", async () => {
    render(<CreatePage />);
    await setChoices();
    await uploadFile(new File(["x"], "lecture.ppt", { type: "application/vnd.ms-powerpoint" }), "document-error");

    expectChoicesKept();
    expect(screen.getByTestId("build-button")).toBeDisabled();
  });

  it("keeps the choices after a file over the size limit and again after Choose another", async () => {
    render(<CreatePage />);
    await setChoices();
    const big = new File(["x"], "huge.txt", { type: "text/plain" });
    Object.defineProperty(big, "size", { value: MAX_FILE_BYTES + 1 });
    await uploadFile(big, "document-error");

    expect(screen.getByTestId("document-error").textContent).toMatch(/25 MB/);
    expectChoicesKept();

    fireEvent.click(screen.getByTestId("document-remove"));
    expect(screen.getByTestId("material-dropzone")).toBeTruthy();
    expectChoicesKept();
  });

  it("keeps the choices after a read failure", async () => {
    render(<CreatePage />);
    await setChoices();
    const file = new File([NOTES], "notes.txt", { type: "text/plain" });
    vi.spyOn(file, "text").mockRejectedValue(new Error("read failed"));
    vi.spyOn(file, "arrayBuffer").mockRejectedValue(new Error("read failed"));
    await uploadFile(file, "document-error");

    expect(screen.getByTestId("document-error").textContent).toMatch(/\S/);
    expectChoicesKept();
  });
});
