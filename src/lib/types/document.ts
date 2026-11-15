/**
 * Extracted Document Types
 *
 * The output of Layer 0 (Ingest): text read from a user's file in the
 * browser, split into sections the user can include or exclude before the
 * material is sent to the AI pipeline. The original file never leaves the
 * device — only the text of the selected sections does.
 */

export type DocumentFileType = "pdf" | "docx" | "pptx" | "text";

/** One selectable unit of the document (a page, a slide, or a heading's section). */
export type DocumentSection = {
  /** Stable within the document: "sec_001", "sec_002", … */
  section_id: string;
  title: string;
  text: string;
  /** Where this text came from in the original file, e.g. "Slide 5", "Page 3". */
  source_ref: string;
};

export type DocumentWarningCode =
  /** Some PDF pages have no selectable text (likely scanned images). */
  | "PARTIAL_TEXT_LAYER"
  /** Some slides have no body text and were skipped. */
  | "EMPTY_SLIDES_SKIPPED";

/** A non-blocking problem the user should know about. */
export type DocumentWarning = {
  code: DocumentWarningCode;
  message: string;
};

export type ExtractedDocument = {
  file_name: string;
  file_type: DocumentFileType;
  sections: DocumentSection[];
  stats: {
    /** Pages (PDF), slides (PPTX), or sections (DOCX, text) in the source. */
    units: number;
    words: number;
    chars: number;
  };
  warnings: DocumentWarning[];
};
