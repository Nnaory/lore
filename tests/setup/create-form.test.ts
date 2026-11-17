/**
 * Tests — create-story form state (reducer + selectors)
 */

import { describe, it, expect } from "vitest";
import {
  buildWorkflowRequest,
  createFormReducer,
  initialCreateFormState,
  selectMaterialText,
  selectSubmitBlocker,
  MAX_INSTRUCTIONS_CHARS,
  type CreateFormAction,
  type CreateFormState,
} from "@/lib/setup/create-form";
import { extractText } from "@/lib/ingest/text";
import { MAX_MATERIAL_CHARS } from "@/lib/ingest/limits";
import { FullWorkflowRequestSchema } from "@/lib/ai/full-workflow-schema";

const doc = extractText(
  "## Vectors\nA vector has direction and size.\n\n## Span\nThe span is every linear combination.",
  "notes.md"
);

function run(...actions: CreateFormAction[]): CreateFormState {
  return actions.reduce(createFormReducer, initialCreateFormState);
}

const loaded: CreateFormAction[] = [
  { type: "read_started", requestId: 1, fileName: "notes.md" },
  { type: "read_succeeded", requestId: 1, document: doc },
];

describe("reading a document", () => {
  it("selects every section once the document is ready", () => {
    const state = run(...loaded);
    expect(state.doc).toMatchObject({ status: "ready", selected: ["sec_001", "sec_002"] });
  });

  it("ignores the result of a read that was replaced by a newer one", () => {
    const state = run(
      { type: "read_started", requestId: 1, fileName: "old.pdf" },
      { type: "read_started", requestId: 2, fileName: "new.md" },
      { type: "read_succeeded", requestId: 1, document: { ...doc, file_name: "old.pdf" } },
    );
    expect(state.doc).toEqual({ status: "reading", requestId: 2, fileName: "new.md" });
  });

  it("ignores a result that arrives after the document was removed", () => {
    const state = run(
      { type: "read_started", requestId: 1, fileName: "slow.pdf" },
      { type: "document_cleared" },
      { type: "read_failed", requestId: 1, fileName: "slow.pdf", error: { code: "CORRUPT_FILE", message: "x" } },
    );
    expect(state.doc).toEqual({ status: "empty" });
  });

  it("records a read error", () => {
    const state = run(
      { type: "read_started", requestId: 1, fileName: "deck.ppt" },
      { type: "read_failed", requestId: 1, fileName: "deck.ppt", error: { code: "LEGACY_FORMAT", message: "Save as .pptx" } },
    );
    expect(state.doc).toEqual({
      status: "error",
      fileName: "deck.ppt",
      error: { code: "LEGACY_FORMAT", message: "Save as .pptx" },
    });
  });
});

describe("selecting sections", () => {
  it("toggles a section and changes the material text", () => {
    const state = run(...loaded, { type: "section_toggled", sectionId: "sec_001" });
    expect(selectMaterialText(state)).toBe("[Part 2] Span\nThe span is every linear combination.");

    const back = createFormReducer(state, { type: "section_toggled", sectionId: "sec_001" });
    expect(selectMaterialText(back)).toContain("[Part 1] Vectors");
  });

  it("selects none and all", () => {
    const none = run(...loaded, { type: "all_sections_set", selected: false });
    expect(none.doc).toMatchObject({ selected: [] });
    const all = createFormReducer(none, { type: "all_sections_set", selected: true });
    expect(all.doc).toMatchObject({ selected: ["sec_001", "sec_002"] });
  });
});

describe("selectSubmitBlocker", () => {
  it("walks through every reason the form is not ready", () => {
    expect(selectSubmitBlocker(initialCreateFormState)).toBe("no_document");
    expect(selectSubmitBlocker(run(loaded[0]))).toBe("reading");
    expect(selectSubmitBlocker(run(...loaded, { type: "all_sections_set", selected: false }))).toBe("no_sections");
    expect(selectSubmitBlocker(run(...loaded))).toBe("no_genre");
    expect(selectSubmitBlocker(run(...loaded, { type: "genre_set", genre: "fantasy" }))).toBeNull();
  });

  it("blocks material over the limit", () => {
    const huge = extractText("x".repeat(MAX_MATERIAL_CHARS + 10), "huge.txt");
    const state = run(
      { type: "read_started", requestId: 1, fileName: "huge.txt" },
      { type: "read_succeeded", requestId: 1, document: huge },
      { type: "genre_set", genre: "fantasy" },
    );
    expect(selectSubmitBlocker(state)).toBe("too_long");
  });
});

describe("buildWorkflowRequest", () => {
  it("returns null until the form is ready", () => {
    expect(buildWorkflowRequest(run(...loaded))).toBeNull();
  });

  it("builds a request the full-workflow route accepts", () => {
    const state = run(
      ...loaded,
      { type: "genre_set", genre: "science_fiction" },
      { type: "length_set", length: "medium" },
      { type: "language_set", language: "id" },
      { type: "instructions_set", text: "  Keep it light.  " },
    );
    const body = buildWorkflowRequest(state);
    expect(FullWorkflowRequestSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      materials: [
        {
          material: selectMaterialText(state),
          genre: "science_fiction",
          context: { source_file_name: "notes.md", source_file_type: "text", story_length: "medium", language: "id" },
        },
      ],
      campaignOptions: { genre: "science_fiction", language: "id", customInstructions: "Keep it light." },
      storyOptions: { language: "id", customInstructions: "Keep it light." },
    });
  });

  it("omits blank instructions", () => {
    const body = buildWorkflowRequest(run(...loaded, { type: "genre_set", genre: "fantasy" }, { type: "instructions_set", text: "   " }));
    expect(body?.campaignOptions.customInstructions).toBeUndefined();
  });
});

describe("instructions", () => {
  it("are capped at the maximum length", () => {
    const state = run({ type: "instructions_set", text: "a".repeat(MAX_INSTRUCTIONS_CHARS + 50) });
    expect(state.customInstructions).toHaveLength(MAX_INSTRUCTIONS_CHARS);
  });
});
