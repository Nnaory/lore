/**
 * Create-story form state
 *
 * Pure reducer and selectors behind the /create page: the material the user
 * provided, which sections they selected, the world (genre) and advanced
 * options, and the submit status. No React, no I/O — testable directly.
 */

import type { Genre } from "@/lib/types/campaign";
import type { ExtractedDocument } from "@/lib/types/document";
import type { IngestFailure } from "@/lib/ingest/errors";
import type { FullWorkflowRequestBody } from "@/lib/ai/full-workflow-schema";
import { buildMaterialText } from "@/lib/ingest/material-text";
import { MAX_MATERIAL_CHARS, MIN_MATERIAL_CHARS } from "@/lib/ingest/limits";

export type StoryLength = "short" | "medium";
export type StoryLanguage = "en" | "id";

/** Longest custom instruction the form accepts. */
export const MAX_INSTRUCTIONS_CHARS = 500;

export type DocumentState =
  | { status: "empty" }
  | { status: "reading"; requestId: number; fileName: string }
  | { status: "ready"; document: ExtractedDocument; selected: string[] }
  | { status: "error"; fileName: string; error: IngestFailure };

export type SubmitState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "failed"; message: string };

export type CreateFormState = {
  doc: DocumentState;
  genre: Genre | null;
  length: StoryLength;
  language: StoryLanguage;
  customInstructions: string;
  submit: SubmitState;
};

export const initialCreateFormState: CreateFormState = {
  doc: { status: "empty" },
  genre: null,
  length: "short",
  language: "en",
  customInstructions: "",
  submit: { status: "idle" },
};

export type CreateFormAction =
  /** Back to an empty form (e.g. after a story was built and saved). */
  | { type: "reset" }
  /** A file started reading. `requestId` must increase with every read. */
  | { type: "read_started"; requestId: number; fileName: string }
  | { type: "read_succeeded"; requestId: number; document: ExtractedDocument }
  | { type: "read_failed"; requestId: number; fileName: string; error: IngestFailure }
  | { type: "document_cleared" }
  | { type: "section_toggled"; sectionId: string }
  | { type: "all_sections_set"; selected: boolean }
  | { type: "genre_set"; genre: Genre }
  | { type: "length_set"; length: StoryLength }
  | { type: "language_set"; language: StoryLanguage }
  | { type: "instructions_set"; text: string }
  | { type: "submit_started" }
  | { type: "submit_failed"; message: string };

/** True when a read result belongs to the read currently in progress. */
function isCurrentRead(doc: DocumentState, requestId: number): boolean {
  return doc.status === "reading" && doc.requestId === requestId;
}

export function createFormReducer(state: CreateFormState, action: CreateFormAction): CreateFormState {
  switch (action.type) {
    case "reset":
      return initialCreateFormState;

    case "read_started":
      return { ...state, doc: { status: "reading", requestId: action.requestId, fileName: action.fileName }, submit: { status: "idle" } };

    case "read_succeeded":
      // Ignore results from a file the user has since replaced or removed.
      if (!isCurrentRead(state.doc, action.requestId)) return state;
      return {
        ...state,
        doc: {
          status: "ready",
          document: action.document,
          selected: action.document.sections.map((s) => s.section_id),
        },
      };

    case "read_failed":
      if (!isCurrentRead(state.doc, action.requestId)) return state;
      return { ...state, doc: { status: "error", fileName: action.fileName, error: action.error } };

    case "document_cleared":
      return { ...state, doc: { status: "empty" }, submit: { status: "idle" } };

    case "section_toggled": {
      if (state.doc.status !== "ready") return state;
      const { selected } = state.doc;
      const next = selected.includes(action.sectionId)
        ? selected.filter((id) => id !== action.sectionId)
        : [...selected, action.sectionId];
      return { ...state, doc: { ...state.doc, selected: next } };
    }

    case "all_sections_set":
      if (state.doc.status !== "ready") return state;
      return {
        ...state,
        doc: {
          ...state.doc,
          selected: action.selected ? state.doc.document.sections.map((s) => s.section_id) : [],
        },
      };

    case "genre_set":
      return { ...state, genre: action.genre };

    case "length_set":
      return { ...state, length: action.length };

    case "language_set":
      return { ...state, language: action.language };

    case "instructions_set":
      return { ...state, customInstructions: action.text.slice(0, MAX_INSTRUCTIONS_CHARS) };

    case "submit_started":
      return { ...state, submit: { status: "submitting" } };

    case "submit_failed":
      return { ...state, submit: { status: "failed", message: action.message } };
  }
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/** The text that will be sent for the selected sections ("" when there is none). */
export function selectMaterialText(state: CreateFormState): string {
  if (state.doc.status !== "ready") return "";
  return buildMaterialText(state.doc.document, state.doc.selected);
}

export type SubmitBlocker =
  | "no_document"
  | "reading"
  | "no_sections"
  | "too_short"
  | "too_long"
  | "no_genre"
  | "submitting";

/**
 * Why the form cannot be submitted yet, or null when it can.
 * Pass `materialText` when it is already computed to avoid rebuilding it.
 */
export function selectSubmitBlocker(
  state: CreateFormState,
  materialText: string = selectMaterialText(state)
): SubmitBlocker | null {
  if (state.submit.status === "submitting") return "submitting";
  if (state.doc.status === "reading") return "reading";
  if (state.doc.status !== "ready") return "no_document";
  if (state.doc.selected.length === 0) return "no_sections";
  if (materialText.length < MIN_MATERIAL_CHARS) return "too_short";
  if (materialText.length > MAX_MATERIAL_CHARS) return "too_long";
  if (state.genre === null) return "no_genre";
  return null;
}

/** The /api/ai/full-workflow request for this form, or null if it is not ready. */
export function buildWorkflowRequest(state: CreateFormState): FullWorkflowRequestBody | null {
  const material = selectMaterialText(state);
  if (selectSubmitBlocker(state, material) !== null) return null;
  if (state.doc.status !== "ready" || state.genre === null) return null;

  const { document } = state.doc;
  const instructions = state.customInstructions.trim() || undefined;
  return {
    materials: [
      {
        material,
        genre: state.genre,
        context: {
          source_file_name: document.file_name,
          source_file_type: document.file_type,
          story_length: state.length,
          language: state.language,
        },
      },
    ],
    campaignOptions: {
      genre: state.genre,
      language: state.language,
      customInstructions: instructions,
    },
    storyOptions: {
      // One concept per chapter: the story length caps the concept count
      // (short = 3, medium = 5), so it also sets the chapter count.
      conceptsPerChapter: 1,
      language: state.language,
      customInstructions: instructions,
    },
  };
}
