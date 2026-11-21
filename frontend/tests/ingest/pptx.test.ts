/**
 * Tests — PowerPoint (.pptx) reader
 *
 * @vitest-environment jsdom
 *
 * Runs the real JSZip + DOMParser against small presentations generated in
 * memory.
 */

import { describe, it, expect } from "vitest";
import { extractPptx, resolvePartPath } from "@/lib/ingest/pptx";
import { IngestError } from "@/lib/ingest/errors";
import { ExtractedDocumentSchema } from "@/lib/contracts/schemas/document.schema";
import { makeOleHeader, makePptx, toArrayBuffer } from "../fixtures/make-files";

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return err instanceof IngestError ? err.code : `unexpected: ${String(err)}`;
  }
}

describe("resolvePartPath", () => {
  it("resolves relative and absolute relationship targets", () => {
    expect(resolvePartPath("ppt", "slides/slide1.xml")).toBe("ppt/slides/slide1.xml");
    expect(resolvePartPath("ppt/slides", "../notesSlides/notesSlide1.xml")).toBe("ppt/notesSlides/notesSlide1.xml");
    expect(resolvePartPath("ppt/slides", "/ppt/media/a.png")).toBe("ppt/media/a.png");
  });
});

describe("extractPptx", () => {
  it("reads slides in presentation order, not file-name order", async () => {
    const data = await makePptx(
      [
        { title: "Intro", body: ["Why vectors matter"] },
        { title: "Linear Combinations", body: ["Scale, then add"] },
        { title: "Vector Span", body: ["All combinations"] },
      ],
      { fileNumbers: [3, 1, 2] }
    );
    const doc = await extractPptx(data, "deck.pptx");
    expect(doc.sections.map((s) => [s.title, s.source_ref])).toEqual([
      ["Intro", "Slide 1"],
      ["Linear Combinations", "Slide 2"],
      ["Vector Span", "Slide 3"],
    ]);
    expect(ExtractedDocumentSchema.safeParse(doc).success).toBe(true);
  });

  it("joins text runs, keeps paragraphs on separate lines, and reads tables", async () => {
    const data = await makePptx([
      {
        title: "Crystals",
        body: [["Crystal A resonates ", "at (2, 1)."], "Crystal B resonates at (1, 2)."],
        table: [["c1", "c2"], ["2", "1"]],
      },
    ]);
    const [section] = (await extractPptx(data, "deck.pptx")).sections;
    expect(section.text).toBe(
      "Crystal A resonates at (2, 1).\nCrystal B resonates at (1, 2).\nc1 | c2\n2 | 1"
    );
  });

  it("appends speaker notes but not the notes page's slide number", async () => {
    const data = await makePptx([
      { title: "Span", body: ["All combinations"], notes: ["Stress that parallel vectors span a line."] },
    ]);
    const [section] = (await extractPptx(data, "deck.pptx")).sections;
    expect(section.text).toBe("All combinations\n\nSpeaker notes:\nStress that parallel vectors span a line.");
  });

  it("skips slides with no body text and warns, counting every slide", async () => {
    const data = await makePptx([
      { title: "Part 1" },
      { title: "Vectors", body: ["Direction and size"] },
      {},
    ]);
    const doc = await extractPptx(data, "deck.pptx");
    expect(doc.sections.map((s) => s.source_ref)).toEqual(["Slide 2"]);
    expect(doc.stats.units).toBe(3);
    expect(doc.warnings).toEqual([
      expect.objectContaining({ code: "EMPTY_SLIDES_SKIPPED", message: expect.stringContaining("2 of 3 slides") }),
    ]);
  });

  it("uses the slide number as the title when there is no title placeholder", async () => {
    const data = await makePptx([{ body: ["Untitled content"] }]);
    const [section] = (await extractPptx(data, "deck.pptx")).sections;
    expect(section.title).toBe("Slide 1");
  });

  it("falls back to numeric file order without presentation.xml", async () => {
    const data = await makePptx(
      [{ body: ["second"] }, { body: ["tenth"] }],
      { fileNumbers: [10, 2], withPresentationXml: false }
    );
    const doc = await extractPptx(data, "deck.pptx");
    expect(doc.sections.map((s) => s.text)).toEqual(["tenth", "second"]);
  });

  it("rejects a deck with no body text anywhere", async () => {
    const data = await makePptx([{ title: "Only a title" }, {}]);
    expect(await codeOf(extractPptx(data, "deck.pptx"))).toBe("NO_TEXT");
  });

  it("rejects a password-protected deck", async () => {
    expect(await codeOf(extractPptx(makeOleHeader(), "locked.pptx"))).toBe("ENCRYPTED");
  });

  it("rejects bytes that are not a .pptx", async () => {
    const data = toArrayBuffer(new TextEncoder().encode("not a zip"));
    expect(await codeOf(extractPptx(data, "fake.pptx"))).toBe("CORRUPT_FILE");
  });
});
