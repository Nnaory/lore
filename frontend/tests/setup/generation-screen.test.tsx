/**
 * Tests — GenerationScreen (Pola K)
 *
 * @vitest-environment jsdom
 *
 * Renders the screen directly with prepared states (the page-level flow is in
 * create-page.test.tsx): step markers, concept review, world preview, error +
 * retry, and both back-to-edit controls.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { GenerationScreen } from "@/components/setup/GenerationScreen";
import { initialGenerationState, type GenerationState } from "@/lib/generation/generation";
import { dummyMaterial, dummyCampaign } from "@/data/dummy-campaign";

afterEach(cleanup);

const ids = dummyMaterial.concepts.map((c) => c.concept_id);

function stateOf(patch: Partial<GenerationState>): GenerationState {
  return { ...initialGenerationState, ...patch };
}

function setup(state: GenerationState) {
  const handlers = {
    onToggleConcept: vi.fn(),
    onConfirmConcepts: vi.fn(),
    onRetry: vi.fn(),
    onBack: vi.fn(),
  };
  render(<GenerationScreen state={state} sourceLabel="3 pages" {...handlers} />);
  return handlers;
}

const statuses = () =>
  ["analyzing", "reviewing", "planning", "writing"].map((s) => screen.getByTestId(`step-${s}`).dataset.status);

describe("GenerationScreen — steps", () => {
  it("marks the running stage active and later stages pending, without a spinner or back button", () => {
    setup(stateOf({}));
    expect(statuses()).toEqual(["active", "pending", "pending", "pending"]);
    expect(screen.getByText(/3 pages/)).toBeTruthy();
    expect(screen.queryByTestId("generation-back")).toBeNull();
    expect(document.querySelector(".animate-spin")).toBeNull();
  });

  it("marks earlier stages done, shows details, and flags the failed stage", () => {
    setup(
      stateOf({
        stage: "planning",
        status: "failed",
        error: "boom",
        material: dummyMaterial,
        selectedConceptIds: ids,
      }),
    );
    expect(statuses()).toEqual(["done", "done", "failed", "pending"]);
    expect(screen.getByTestId("step-analyzing").textContent).toContain(`${ids.length} found`);
    expect(screen.getByTestId("step-reviewing").textContent).toContain(`${ids.length} kept`);
  });
});

describe("GenerationScreen — concept review", () => {
  const reviewing = (selected: string[]) =>
    stateOf({ stage: "reviewing", status: "waiting", material: dummyMaterial, selectedConceptIds: selected });

  it("lists a checkbox per concept that reflects selection and reports toggles", () => {
    const h = setup(reviewing([ids[0]]));
    expect(screen.getByTestId("step-reviewing").dataset.status).toBe("active");
    expect((screen.getByTestId(`concept-checkbox-${ids[0]}`) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId(`concept-checkbox-${ids[1]}`) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByTestId(`concept-checkbox-${ids[1]}`));
    expect(h.onToggleConcept).toHaveBeenCalledWith(ids[1]);
  });

  it("confirms with at least one concept and shows no error line", () => {
    const h = setup(reviewing(ids));
    const confirm = screen.getByTestId("confirm-concepts");
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);
    expect(h.onConfirmConcepts).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Keep at least one concept.")).toBeNull();
  });

  it("disables confirm and shows the ErrorLine when none are kept", () => {
    const h = setup(reviewing([]));
    expect(screen.getByTestId("confirm-concepts")).toBeDisabled();
    expect(screen.getByText("Keep at least one concept.")).toBeTruthy();
    fireEvent.click(screen.getByTestId("confirm-concepts"));
    expect(h.onConfirmConcepts).not.toHaveBeenCalled();
  });

  it("goes back from the icon button and from the bottom button", () => {
    const h = setup(reviewing(ids));
    fireEvent.click(screen.getByTestId("generation-back"));
    fireEvent.click(within(screen.getByTestId("concept-review")).getByRole("button", { name: "Back to edit" }));
    expect(h.onBack).toHaveBeenCalledTimes(2);
  });
});

describe("GenerationScreen — world preview", () => {
  it("shows the campaign title, premise and characters once planned", () => {
    setup(stateOf({ stage: "writing", material: dummyMaterial, selectedConceptIds: ids, campaign: dummyCampaign }));
    const preview = screen.getByTestId("world-preview");
    expect(preview.textContent).toContain(dummyCampaign.title);
    expect(preview.textContent).toContain(dummyCampaign.premise);
    for (const c of dummyCampaign.characters) expect(preview.textContent).toContain(c.name);
    expect(screen.getByTestId("step-planning").textContent).toContain(dummyCampaign.title);
  });

  it("is absent before a campaign exists", () => {
    setup(stateOf({}));
    expect(screen.queryByTestId("world-preview")).toBeNull();
  });
});

describe("GenerationScreen — failure", () => {
  const failed = stateOf({ stage: "writing", status: "failed", error: "The writer stopped.", material: dummyMaterial });

  it("shows the error, retries, and goes back", () => {
    const h = setup(failed);
    expect(screen.getByTestId("generation-error").textContent).toContain("The writer stopped.");
    fireEvent.click(screen.getByTestId("generation-retry"));
    expect(h.onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("generation-back"));
    const backs = screen.getAllByRole("button", { name: "Back to edit" });
    expect(backs).toHaveLength(2);
    fireEvent.click(backs[1]);
    expect(h.onBack).toHaveBeenCalledTimes(2);
  });

  it("uses full-width buttons on phone and auto width on desktop (md:)", () => {
    setup(failed);
    const cls = screen.getByTestId("generation-retry").className;
    expect(cls).toContain("w-full");
    expect(cls).toContain("md:w-auto");
    expect(screen.getByTestId("generation-screen").querySelector("main")!.className).toContain("md:w-[680px]");
  });
});
