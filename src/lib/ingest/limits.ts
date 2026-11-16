/**
 * Ingest limits
 *
 * Shared by the browser (to warn before sending) and the server (to reject
 * oversized requests). No browser- or server-only imports here.
 */

/** Largest file the browser will try to read, in bytes (25 MB). */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * Most material text, in characters, sent to the AI pipeline in one request.
 * Roughly 20k tokens; users deselect sections of longer documents.
 */
export const MAX_MATERIAL_CHARS = 80_000;

/** Fewest characters of material the pipeline accepts. */
export const MIN_MATERIAL_CHARS = 10;
