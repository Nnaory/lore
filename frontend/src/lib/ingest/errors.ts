/**
 * Ingest errors
 *
 * Format readers throw IngestError for expected, user-explainable problems.
 * `extractDocument` turns them into a result value; nothing throws past it.
 */

export type IngestErrorCode =
  | "UNSUPPORTED_TYPE"
  | "LEGACY_FORMAT"
  | "FILE_TOO_LARGE"
  | "ENCRYPTED"
  | "CORRUPT_FILE"
  | "NO_TEXT"
  | "READ_FAILED";

/** A serialisable description of why a document could not be read. */
export type IngestFailure = {
  code: IngestErrorCode;
  message: string;
};

export class IngestError extends Error {
  readonly code: IngestErrorCode;

  constructor(code: IngestErrorCode, message: string) {
    super(message);
    this.name = "IngestError";
    this.code = code;
  }

  toFailure(): IngestFailure {
    return { code: this.code, message: this.message };
  }
}

/** First 8 bytes of an OLE compound file (legacy .doc/.ppt, or an encrypted .docx/.pptx). */
const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export function isOleCompoundFile(data: ArrayBuffer): boolean {
  if (data.byteLength < OLE_SIGNATURE.length) return false;
  const head = new Uint8Array(data, 0, OLE_SIGNATURE.length);
  return OLE_SIGNATURE.every((byte, i) => head[i] === byte);
}
