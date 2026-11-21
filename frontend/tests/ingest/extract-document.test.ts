/**
 * Tests — extractDocument (Layer 0 entry point)
 */

import { describe, it, expect } from "vitest";
import { detectFileKind, extractDocument } from "@/lib/ingest";
import { AnalyzeMaterialRequestSchema } from "@/lib/contracts/ai-requests";
import { MAX_MATERIAL_CHARS } from "@/lib/ingest/limits";

function file(name: string, content: string, type = ""): File {
  return new File([content], name, { type });
}

describe("detectFileKind", () => {
  it.each([
    ["notes.PDF", "", "pdf"],
    ["essay.docx", "", "docx"],
    ["deck.pptx", "", "pptx"],
    ["readme.md", "", "text"],
    ["old.doc", "", "legacy-doc"],
    ["old.ppt", "", "legacy-ppt"],
    ["no-extension", "application/pdf", "pdf"],
    ["photo.png", "image/png", "unsupported"],
  ])("%s (%s) → %s", (name, type, kind) => {
    expect(detectFileKind({ name, type })).toBe(kind);
  });
});

describe("extractDocument", () => {
  it("reads a text file", async () => {
    const result = await extractDocument(file("notes.txt", "## Span\nAll linear combinations."));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.document.sections[0].title).toBe("Span");
  });

  it("explains how to convert a legacy Office file", async () => {
    const result = await extractDocument(file("slides.ppt", "x"));
    expect(result).toEqual({
      ok: false,
      error: { code: "LEGACY_FORMAT", message: expect.stringContaining(".pptx") },
    });
  });

  it("rejects unsupported types", async () => {
    const result = await extractDocument(file("photo.png", "x", "image/png"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNSUPPORTED_TYPE");
  });

  it("rejects files over the size limit before reading them", async () => {
    const result = await extractDocument(file("big.txt", "x".repeat(2048)), { maxBytes: 1024 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FILE_TOO_LARGE");
  });

  it("reports an empty text file as having no text", async () => {
    const result = await extractDocument(file("empty.txt", "   "));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NO_TEXT");
  });
});

describe("server limit on material length", () => {
  it("accepts material up to the limit and rejects anything longer", () => {
    const ok = AnalyzeMaterialRequestSchema.safeParse({ material: "a".repeat(MAX_MATERIAL_CHARS) });
    const tooLong = AnalyzeMaterialRequestSchema.safeParse({ material: "a".repeat(MAX_MATERIAL_CHARS + 1) });
    expect(ok.success).toBe(true);
    expect(tooLong.success).toBe(false);
  });
});
