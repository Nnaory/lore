/**
 * Property tests: the SSE parser does not care where the chunks are cut (task 22.2, design
 * Property 7, frontend side). Validates Requirements 17.9 and 25.7.
 *
 * Property 7: for every valid event stream and every cut of its bytes, including cuts inside a
 * multi-byte UTF-8 character and inside `\r\n`, pushing the pieces one after the other into
 * `createSseParser` gives the same `RawEvent` list as pushing the whole text at once.
 *
 * The bytes are cut first and decoded afterwards with a streaming `TextDecoder`
 * (`decode(chunk, { stream: true })`), the way `animation-client.ts` reads the body, so a character
 * split in half reaches the parser whole. Three oracles are compared on every input:
 *   1. the whole text pushed at once (the property itself);
 *   2. an independent reference parser written in this file (split on `\r\n|\r|\n`, then fold),
 *      so a bug that is the same in whole and chunked reading still shows up;
 *   3. for generated streams, the events the generator meant to write (round trip).
 *
 * Inputs, each 200 fast-check runs (the task asks for at least 100) unless it is exhaustive:
 *   - `backend/tests/fixtures/animation/sse-stream.txt` (shared with the backend tests) cut at
 *     EVERY byte offset, then at random sets of offsets, then one byte at a time;
 *   - generated streams: random events, lines in random order, mixed `\n` / `\r\n` / `\r`,
 *     comments, `id:` and `retry:` lines, non-ASCII and U+2028 text, cut at every byte offset
 *     and at random sets of offsets;
 *   - random text over a small alphabet of separators and field letters (mostly not a valid
 *     stream), cut at random sets of offsets.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createSseParser, type RawEvent } from "@/lib/animation/sse-parser";

const RUNS = 200;

const STREAM_FIXTURE = join(
  __dirname,
  "..",
  "..",
  "..",
  "backend",
  "tests",
  "fixtures",
  "animation",
  "sse-stream.txt",
);

const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Reading helpers
// ---------------------------------------------------------------------------

/** Pushes the chunks in order into a fresh parser, ends it, and returns every event. */
function parseChunks(chunks: readonly string[]): RawEvent[] {
  const parser = createSseParser();
  const events = chunks.flatMap((chunk) => parser.push(chunk));
  parser.end();
  return events;
}

/** The whole body decoded in one go and pushed once: what the property compares against. */
function readWhole(bytes: Uint8Array): RawEvent[] {
  return parseChunks([new TextDecoder().decode(bytes)]);
}

/** `bytes` cut at `cuts` (offsets, any order, repeats and out-of-range values allowed), decoded in streaming mode. */
function decodeCut(bytes: Uint8Array, cuts: readonly number[]): string[] {
  const points = [...new Set(cuts.map((cut) => Math.min(Math.max(cut, 0), bytes.length)))].sort((a, b) => a - b);
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let start = 0;
  for (const point of [...points, bytes.length]) {
    chunks.push(decoder.decode(bytes.subarray(start, point), { stream: true }));
    start = point;
  }
  chunks.push(decoder.decode()); // flush: a character cut in half at the very end would come out here
  return chunks;
}

function readCut(bytes: Uint8Array, cuts: readonly number[]): RawEvent[] {
  return parseChunks(decodeCut(bytes, cuts));
}

/** One byte per chunk. */
function readByteByByte(bytes: Uint8Array): RawEvent[] {
  return readCut(bytes, Array.from({ length: bytes.length }, (_, i) => i));
}

// ---------------------------------------------------------------------------
// Reference parser: a different shape than the module (split first, then fold)
// ---------------------------------------------------------------------------

/**
 * The format as the module documents it: line breaks are `\r\n`, `\r`, `\n`; a `\r` at the very
 * end of the text is not a break yet and is dropped with the unfinished event; the text after the
 * last break is an unfinished line and is dropped.
 */
function referenceParse(text: string): RawEvent[] {
  const body = text.endsWith("\r") ? text.slice(0, -1) : text;
  const lines = body.split(/\r\n|\r|\n/);
  lines.pop(); // text after the last break

  const events: RawEvent[] = [];
  let name = "";
  let data: string[] = [];
  for (const line of lines) {
    if (line === "") {
      if (data.length > 0) events.push({ event: name === "" ? "message" : name, data: data.join("\n") });
      name = "";
      data = [];
    } else if (line.startsWith(":")) {
      // comment
    } else {
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") name = value;
      else if (field === "data") data.push(value);
    }
  }
  return events;
}

/** The three oracles agree on `bytes` cut at `cuts`. */
function expectSameEvents(bytes: Uint8Array, cuts: readonly number[]): void {
  const whole = readWhole(bytes);
  expect(readCut(bytes, cuts)).toEqual(whole);
  expect(whole).toEqual(referenceParse(new TextDecoder().decode(bytes)));
}

/** Random cut offsets for a body of `length` bytes. */
const cutsArb = fc.array(fc.nat(), { maxLength: 40 });
const toOffsets = (numbers: readonly number[], length: number): number[] => numbers.map((n) => n % (length + 1));

// ---------------------------------------------------------------------------
// 1. The shared fixture
// ---------------------------------------------------------------------------

describe("Property 7: the shared stream fixture", () => {
  const bytes = new Uint8Array(readFileSync(STREAM_FIXTURE));
  const whole = readWhole(bytes);

  it("is the stream the cuts are meant for: multi-byte characters, CRLF, U+2028, a ping", () => {
    expect(bytes.length).toBeGreaterThan(100);
    expect(whole.map((event) => event.event)).toEqual([
      "started",
      "stage",
      "stage",
      "diagnostics",
      "stage",
      "notice",
      "stage",
      "diagnostics",
      "stage",
      "done",
    ]);
    // Offsets that fall inside a multi-byte character (the byte there is a continuation byte)...
    const insideCharacter = Array.from(bytes.keys()).filter((i) => (bytes[i] & 0xc0) === 0x80);
    // ...and between the `\r` and the `\n` of a CRLF.
    const insideCrlf = Array.from(bytes.keys()).filter((i) => i > 0 && bytes[i - 1] === 0x0d && bytes[i] === 0x0a);
    expect(insideCharacter.length).toBeGreaterThan(10);
    expect(insideCrlf.length).toBeGreaterThan(3);
    expect(whole).toEqual(referenceParse(new TextDecoder().decode(bytes)));
  });

  it("gives the same events for a cut at every byte offset", () => {
    for (let cut = 0; cut <= bytes.length; cut += 1) {
      expect(readCut(bytes, [cut])).toEqual(whole);
    }
  });

  it("gives the same events for every pair of cuts around each multi-byte character and each CRLF", () => {
    const interesting = Array.from(bytes.keys()).filter(
      (i) => (bytes[i] & 0x80) !== 0 || bytes[i] === 0x0d || bytes[i] === 0x0a,
    );
    for (const a of interesting) {
      for (const b of [a, a + 1, a + 2, a + 3]) expect(readCut(bytes, [a, b])).toEqual(whole);
    }
  });

  it("gives the same events one byte at a time", () => {
    expect(readByteByByte(bytes)).toEqual(whole);
  });

  it("gives the same events for random sets of cuts", () => {
    fc.assert(
      fc.property(cutsArb, (numbers) => {
        expect(readCut(bytes, toOffsets(numbers, bytes.length))).toEqual(whole);
      }),
      { numRuns: RUNS },
    );
  });

  it("gives the same events for random chunk sizes", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 40 }), { minLength: 1, maxLength: 20 }), (sizes) => {
        const cuts: number[] = [];
        let at = 0;
        for (let i = 0; at < bytes.length; i += 1) {
          at += sizes[i % sizes.length];
          cuts.push(at);
        }
        expect(readCut(bytes, cuts)).toEqual(whole);
      }),
      { numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Generated event streams
// ---------------------------------------------------------------------------

/** One character: ASCII (with `:` and space), any non-surrogate code point, or a look-alike separator. */
const unitArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 6, arbitrary: fc.integer({ min: 0x20, max: 0x7e }).map((cp) => String.fromCodePoint(cp)) },
  {
    weight: 3,
    arbitrary: fc
      .integer({ min: 0x80, max: 0x10ffff })
      .filter((cp) => cp < 0xd800 || cp > 0xdfff)
      .map((cp) => String.fromCodePoint(cp)),
  },
  { weight: 2, arbitrary: fc.constantFrom("\u2028", "\u2029", "\u0085", "\u000b", "\u000c", "\u001c", "\t", "\ufeff", ":") },
);

/** Text with no `\r` or `\n`, which is all a field value can hold. */
const textArb = fc.string({ unit: unitArb, maxLength: 24 });

type LineSpec =
  | { k: "event" | "data" | "id" | "retry" | "comment"; v: string; spaced: boolean }
  | { k: "bare-event" | "bare-data" };

const lineSpecArb: fc.Arbitrary<LineSpec> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ k: fc.constant("data" as const), v: textArb, spaced: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("event" as const), v: textArb, spaced: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("comment" as const), v: textArb, spaced: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("id" as const), v: textArb, spaced: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("retry" as const), v: textArb, spaced: fc.boolean() }) },
  { weight: 1, arbitrary: fc.constant<LineSpec>({ k: "bare-data" }) },
  { weight: 1, arbitrary: fc.constant<LineSpec>({ k: "bare-event" }) },
);

/** One event block: its lines, closed by a blank line. Many blocks have no `data` line and mean nothing. */
const blockArb = fc.array(lineSpecArb, { maxLength: 6 });

const SEPARATORS = ["\n", "\r\n", "\r"] as const;
type Separator = (typeof SEPARATORS)[number];
const separatorArb = fc.constantFrom<Separator>(...SEPARATORS);

function renderLine(line: LineSpec): string {
  switch (line.k) {
    case "bare-data":
      return "data";
    case "bare-event":
      return "event";
    case "comment":
      return `:${line.v}`;
    default: {
      // One space after the colon is dropped by the reader, so a value that starts with a space
      // needs it; without the space the value would lose its own.
      const space = line.spaced || line.v.startsWith(" ");
      return `${line.k}:${space ? " " : ""}${line.v}`;
    }
  }
}

/** The events a list of blocks means, worked out from the specs and not from the text. */
function intendedEvents(blocks: readonly LineSpec[][]): RawEvent[] {
  const events: RawEvent[] = [];
  for (const block of blocks) {
    let name = "";
    const data: string[] = [];
    for (const line of block) {
      if (line.k === "event") name = line.v;
      else if (line.k === "bare-event") name = "";
      else if (line.k === "data") data.push(line.v);
      else if (line.k === "bare-data") data.push("");
    }
    if (data.length > 0) events.push({ event: name === "" ? "message" : name, data: data.join("\n") });
  }
  return events;
}

/**
 * Writes the blocks with a separator per line. Two corrections keep the text unambiguous:
 * a `\r` right before a blank line may not be followed by a bare `\n` (that would read as one
 * `\r\n`), and the last blank line may not end in a lone `\r` (the parser holds it, so the last
 * event would never close).
 */
function serialize(blocks: readonly LineSpec[][], separators: readonly Separator[]): string {
  let text = "";
  let previous: Separator | null = null;
  let used = 0;
  const next = (): Separator => separators[used++ % separators.length];
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    for (const line of blocks[blockIndex]) {
      const separator = next();
      text += renderLine(line) + separator;
      previous = separator;
    }
    let separator = next();
    if (previous === "\r" && separator === "\n") separator = "\r\n";
    if (blockIndex === blocks.length - 1 && separator === "\r") separator = previous === "\r" ? "\r\n" : "\n";
    text += separator;
    previous = separator;
  }
  return text;
}

const streamArb = fc
  .record({
    blocks: fc.array(blockArb, { minLength: 1, maxLength: 8 }),
    separators: fc.array(separatorArb, { minLength: 1, maxLength: 12 }),
  })
  .map(({ blocks, separators }) => {
    const text = serialize(blocks, separators);
    return { blocks, text, bytes: encoder.encode(text) };
  });

describe("Property 7: generated event streams", () => {
  it("round-trips: the parser reads back the events that were written", () => {
    fc.assert(
      fc.property(streamArb, ({ blocks, bytes }) => {
        expect(readWhole(bytes)).toEqual(intendedEvents(blocks));
      }),
      { numRuns: RUNS },
    );
  });

  it("gives the same events for a cut at every byte offset", () => {
    fc.assert(
      fc.property(streamArb, ({ blocks, bytes }) => {
        const whole = readWhole(bytes);
        expect(whole).toEqual(intendedEvents(blocks));
        expect(whole).toEqual(referenceParse(new TextDecoder().decode(bytes)));
        for (let cut = 0; cut <= bytes.length; cut += 1) {
          expect(readCut(bytes, [cut])).toEqual(whole);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("gives the same events for random sets of cuts and one byte at a time", () => {
    fc.assert(
      fc.property(streamArb, cutsArb, ({ blocks, bytes }, numbers) => {
        const expected = intendedEvents(blocks);
        expect(readCut(bytes, toOffsets(numbers, bytes.length))).toEqual(expected);
        expect(readByteByByte(bytes)).toEqual(expected);
      }),
      { numRuns: RUNS },
    );
  });

  it("writes streams with all three separators and with characters that need several bytes", () => {
    const sample = fc.sample(streamArb, 300);
    const texts = sample.map((s) => s.text);
    expect(texts.some((t) => t.includes("\r\n"))).toBe(true);
    expect(texts.some((t) => /\r(?!\n)/.test(t))).toBe(true);
    expect(texts.some((t) => /(?<!\r)\n/.test(t))).toBe(true);
    expect(texts.some((t) => t.includes("\u2028"))).toBe(true);
    expect(sample.some((s) => s.bytes.length > s.text.length)).toBe(true);
    expect(sample.some((s) => intendedEvents(s.blocks).length >= 2)).toBe(true);
    expect(sample.some((s) => s.blocks.some((b) => intendedEvents([b]).length === 0))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Text that is not a valid stream
// ---------------------------------------------------------------------------

/** Separators, field letters, a colon, a space, and multi-byte characters: most strings are nonsense. */
const noiseArb = fc.string({
  unit: fc.constantFrom(
    "\r", "\n", "\r", "\n", ":", " ", "d", "a", "t", "e", "v", "n", "\u2028", "\u00e9", "\u65e5", "\u{1f600}", "\ufeff",
  ),
  maxLength: 60,
});

describe("Property 7: any text, valid stream or not", () => {
  it("gives the same events for random cuts, and the reference parser agrees", () => {
    fc.assert(
      fc.property(noiseArb, cutsArb, (text, numbers) => {
        const bytes = encoder.encode(text);
        expectSameEvents(bytes, toOffsets(numbers, bytes.length));
      }),
      { numRuns: RUNS },
    );
  });

  it("gives the same events for a cut at every byte offset", () => {
    fc.assert(
      fc.property(noiseArb, (text) => {
        const bytes = encoder.encode(text);
        const whole = readWhole(bytes);
        expect(whole).toEqual(referenceParse(new TextDecoder().decode(bytes)));
        for (let cut = 0; cut <= bytes.length; cut += 1) expect(readCut(bytes, [cut])).toEqual(whole);
      }),
      { numRuns: RUNS },
    );
  });
});
