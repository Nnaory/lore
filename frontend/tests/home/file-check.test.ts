/**
 * Property test for the Home file check.
 *
 * Feature: ui-redesign, Property 17: Home accepts a file if and only if its
 * format and size are valid. The oracle is written independently of
 * lib/ingest: an extension in the table wins, otherwise the MIME type decides
 * (this mirrors detectFileKind, where ".doc"/".ppt" are known but unsupported).
 *
 * **Validates: Requirements 11.4, 11.5**
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { validateHomeFile } from "@/lib/home/file-check";

const MAX = 26_214_400;
const RUNS = { numRuns: 200 };

const ACCEPTED_EXT = ["pdf", "docx", "pptx", "txt", "md", "markdown"];
const KNOWN_REJECTED_EXT = ["doc", "ppt"];
const ACCEPTED_MIME = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/markdown",
];
const OTHER_MIME = [
  "",
  "image/png",
  "application/zip",
  "application/msword",
  "application/vnd.ms-powerpoint",
  "application/octet-stream",
];

function formatAccepted(name: string, type: string): boolean {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  if (ext && ACCEPTED_EXT.includes(ext)) return true;
  if (ext && KNOWN_REJECTED_EXT.includes(ext)) return false;
  return ACCEPTED_MIME.includes(type);
}

const nameArb = fc.oneof(
  fc.string({ maxLength: 20 }),
  fc
    .tuple(
      fc.stringMatching(/^[a-zA-Z0-9 _-]{0,12}$/),
      fc.constantFrom(...ACCEPTED_EXT, ...KNOWN_REJECTED_EXT, "png", "zip", "exe", ""),
      fc.boolean(),
    )
    .map(([base, ext, upper]) => `${base}.${upper ? ext.toUpperCase() : ext}`),
);
const mimeArb = fc.oneof(
  fc.constantFrom(...ACCEPTED_MIME, ...OTHER_MIME),
  fc.string({ maxLength: 30 }),
);
const sizeArb = fc.oneof(
  fc.constantFrom(0, 1, 2, MAX - 1, MAX, MAX + 1),
  fc.integer({ min: 0, max: MAX * 2 }),
);

describe("validateHomeFile (Property 17)", () => {
  it("accepts iff format is supported and 1 <= size <= 25 MB", () => {
    fc.assert(
      fc.property(nameArb, mimeArb, sizeArb, (name, type, size) => {
        const r = validateHomeFile({ name, type, size });
        expect(r.ok).toBe(formatAccepted(name, type) && size >= 1 && size <= MAX);
      }),
      RUNS,
    );
  });

  it("rejects with the right reason and a non-empty message", () => {
    fc.assert(
      fc.property(nameArb, mimeArb, sizeArb, (name, type, size) => {
        const r = validateHomeFile({ name, type, size });
        if (r.ok) return;
        const expected = !formatAccepted(name, type)
          ? "unsupported_format"
          : size === 0
            ? "empty_file"
            : "too_large";
        expect(r.reason).toBe(expected);
        expect(r.message.length).toBeGreaterThan(0);
      }),
      RUNS,
    );
  });

  it("covers the size boundaries for a valid file", () => {
    const f = { name: "a.pdf", type: "application/pdf" };
    expect(validateHomeFile({ ...f, size: 0 })).toMatchObject({ ok: false, reason: "empty_file" });
    expect(validateHomeFile({ ...f, size: 1 })).toEqual({ ok: true });
    expect(validateHomeFile({ ...f, size: MAX })).toEqual({ ok: true });
    expect(validateHomeFile({ ...f, size: MAX + 1 })).toMatchObject({
      ok: false,
      reason: "too_large",
    });
  });
});
