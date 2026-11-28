/**
 * Tests: incremental SSE parser (task 22.1, tests-first).
 *
 * Covers Requirement 25.2 / 25.12 (line separators, `data:` joining, `id:`/`retry:` ignored, an
 * unfinished last event is dropped) and Requirement 17.2 (the wire format the endpoint writes).
 *
 *   1. one case per line separator (`\n`, `\r\n`, `\r`) and a stream that mixes them;
 *   2. a `\r` at the end of a chunk is held until the next character decides if it is `\r\n`;
 *   3. comment lines (`: ping`), events without `data`, multi-line `data`, the default name
 *      `message`, the one-space rule, and fields that are ignored;
 *   4. `end()` drops the unfinished event, partial line and held `\r`, and resets the parser;
 *   5. text that merely looks like a separator (U+2028, U+0085) stays inside the data;
 *   6. the shared stream fixture read in one piece gives the expected events.
 *
 * The cut-at-every-offset property (Requirement 17.9, 25.7) is task 22.2 and is not tested here.
 *
 * About the fixture: the stream is the one file `backend/tests/fixtures/animation/sse-stream.txt`,
 * which the backend tests and `animation-client.test.ts` read as well. There is no frontend copy.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSseParser, type RawEvent } from "@/lib/animation/sse-parser";

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

/** Pushes every chunk in order and collects what comes out. */
function run(...chunks: string[]): RawEvent[] {
  const parser = createSseParser();
  return chunks.flatMap((chunk) => parser.push(chunk));
}

describe("line separators (Requirement 25.12)", () => {
  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
    ["CR", "\r"],
  ])("reads an event written with %s", (_name, nl) => {
    // The second chunk is a comment start. A `\r` at the very end of the text is held (see the
    // next group), so something has to follow the last separator for the CR-only case to close.
    const text = `event: stage${nl}data: {"a":1}${nl}${nl}`;
    expect(run(text, ":")).toEqual([{ event: "stage", data: '{"a":1}' }]);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
    ["CR", "\r"],
  ])("reads two events in a row written with %s", (_name, nl) => {
    const text = `data: one${nl}${nl}data: two${nl}${nl}`;
    expect(run(text, ":")).toEqual([
      { event: "message", data: "one" },
      { event: "message", data: "two" },
    ]);
  });

  it("accepts all three separators inside one event", () => {
    const text = "event: x\r\ndata: a\ndata: b\rdata: c\r\n\r\n";
    expect(run(text)).toEqual([{ event: "x", data: "a\nb\nc" }]);
  });

  it("treats CR LF as one separator, not as a blank line", () => {
    // If \r\n counted as two breaks, the blank line would end the event after `event: x`.
    expect(run("event: x\r\ndata: y\r\n\r\n")).toEqual([{ event: "x", data: "y" }]);
  });

  it("treats CR CR as a blank line", () => {
    expect(run("data: a\r\rdata: b\r\r", ":")).toEqual([
      { event: "message", data: "a" },
      { event: "message", data: "b" },
    ]);
  });
});

describe("a CR at the end of a chunk is held", () => {
  it("does not close the line until the next chunk arrives", () => {
    const parser = createSseParser();
    expect(parser.push("data: x\r\n\r")).toEqual([]); // the last \r may start \r\n
    expect(parser.push("\n")).toEqual([{ event: "message", data: "x" }]);
  });

  it("keeps CR LF split across chunks as one separator", () => {
    const parser = createSseParser();
    expect(parser.push("event: a\r")).toEqual([]);
    expect(parser.push("\ndata: b\r\n\r\n")).toEqual([{ event: "a", data: "b" }]);
  });

  it("closes the line as a CR when the next character is not LF", () => {
    const parser = createSseParser();
    expect(parser.push("data: a\r")).toEqual([]);
    expect(parser.push("data: b\r")).toEqual([]);
    expect(parser.push("\r")).toEqual([]); // "\r\r" closes data: b, the new last \r is held
    expect(parser.push("x")).toEqual([{ event: "message", data: "a\nb" }]);
  });

  it("holds a lone trailing CR that would otherwise close an event", () => {
    const parser = createSseParser();
    expect(parser.push("data: a\r\r")).toEqual([]); // the second \r is held
    expect(parser.push("\n")).toEqual([{ event: "message", data: "a" }]);
  });

  it("does not hold anything when the chunk ends with LF", () => {
    const parser = createSseParser();
    expect(parser.push("data: a\n\n")).toEqual([{ event: "message", data: "a" }]);
  });
});

describe("comments", () => {
  it("ignores a ping and emits nothing for it", () => {
    expect(run(": ping\n\n")).toEqual([]);
  });

  it("ignores a ping between two events", () => {
    expect(run("data: a\n\n: ping\n\ndata: b\n\n")).toEqual([
      { event: "message", data: "a" },
      { event: "message", data: "b" },
    ]);
  });

  it("ignores a comment inside an event and keeps the event whole", () => {
    expect(run("event: x\n: note\ndata: 1\n: more\ndata: 2\n\n")).toEqual([
      { event: "x", data: "1\n2" },
    ]);
  });

  it("ignores a bare colon and a comment written with CRLF", () => {
    expect(run(":\r\n: ping\r\n\r\ndata: a\r\n\r\n")).toEqual([{ event: "message", data: "a" }]);
  });

  it("does not read a field out of a comment", () => {
    expect(run(":data: hidden\n\n")).toEqual([]);
  });
});

describe("event name and data", () => {
  it("uses the name `message` when there is no event line", () => {
    expect(run("data: hi\n\n")).toEqual([{ event: "message", data: "hi" }]);
  });

  it("uses the name `message` when the event line is empty", () => {
    expect(run("event:\ndata: hi\n\n")).toEqual([{ event: "message", data: "hi" }]);
    expect(run("event\ndata: hi\n\n")).toEqual([{ event: "message", data: "hi" }]);
  });

  it("drops an event that has no data line", () => {
    expect(run("event: stage\n\n")).toEqual([]);
  });

  it("does not leak the name of a dropped event into the next one", () => {
    expect(run("event: stage\n\ndata: x\n\n")).toEqual([{ event: "message", data: "x" }]);
  });

  it("does not leak the name or data of one event into the next", () => {
    expect(run("event: a\ndata: 1\n\ndata: 2\n\n")).toEqual([
      { event: "a", data: "1" },
      { event: "message", data: "2" },
    ]);
  });

  it("keeps an event whose data line is empty", () => {
    expect(run("data:\n\n")).toEqual([{ event: "message", data: "" }]);
    expect(run("data\n\n")).toEqual([{ event: "message", data: "" }]);
  });

  it("joins several data lines with a line feed", () => {
    expect(run("data: a\ndata: b\ndata: c\n\n")).toEqual([{ event: "message", data: "a\nb\nc" }]);
  });

  it("keeps empty lines between data lines", () => {
    expect(run("data: a\ndata:\ndata: c\n\n")).toEqual([{ event: "message", data: "a\n\nc" }]);
  });

  it("lets the last event line win", () => {
    expect(run("event: a\nevent: b\ndata: x\n\n")).toEqual([{ event: "b", data: "x" }]);
  });

  it("removes exactly one space after the colon", () => {
    expect(run("data:x\n\n")).toEqual([{ event: "message", data: "x" }]);
    expect(run("data: x\n\n")).toEqual([{ event: "message", data: "x" }]);
    expect(run("data:  x\n\n")).toEqual([{ event: "message", data: " x" }]);
    expect(run("data:\tx\n\n")).toEqual([{ event: "message", data: "\tx" }]);
    expect(run("event:  a\ndata: x\n\n")).toEqual([{ event: " a", data: "x" }]);
  });

  it("splits a line at the first colon only", () => {
    expect(run('data: {"a":"b:c"}\n\n')).toEqual([{ event: "message", data: '{"a":"b:c"}' }]);
    expect(run("data::x\n\n")).toEqual([{ event: "message", data: ":x" }]);
  });

  it("keeps trailing spaces in the value", () => {
    expect(run("data: x  \n\n")).toEqual([{ event: "message", data: "x  " }]);
  });

  it("matches field names exactly", () => {
    expect(run("Data: x\nDATA: y\n\n")).toEqual([]);
    expect(run("data : x\n\n")).toEqual([]);
    expect(run("event: a\nEvent: b\ndata: x\n\n")).toEqual([{ event: "a", data: "x" }]);
  });
});

describe("fields that are ignored (Requirement 25.12)", () => {
  it("ignores id and retry lines", () => {
    expect(run("id: 7\nretry: 3000\nevent: a\ndata: x\n\n")).toEqual([{ event: "a", data: "x" }]);
  });

  it("does not make an event out of id or retry alone", () => {
    expect(run("id: 7\n\nretry: 100\n\n")).toEqual([]);
  });

  it("ignores unknown fields", () => {
    expect(run("foo: bar\ndata: x\n\n")).toEqual([{ event: "message", data: "x" }]);
  });
});

describe("chunking", () => {
  it("returns events in the push that completes them", () => {
    const parser = createSseParser();
    expect(parser.push("event: a\n")).toEqual([]);
    expect(parser.push("data: x\n")).toEqual([]);
    expect(parser.push("\n")).toEqual([{ event: "a", data: "x" }]);
  });

  it("returns several events from one push, in order", () => {
    expect(run("data: 1\n\ndata: 2\n\ndata: 3\n\n")).toEqual([
      { event: "message", data: "1" },
      { event: "message", data: "2" },
      { event: "message", data: "3" },
    ]);
  });

  it("returns an empty list for an empty chunk and keeps its place", () => {
    const parser = createSseParser();
    expect(parser.push("")).toEqual([]);
    expect(parser.push("data: x")).toEqual([]);
    expect(parser.push("")).toEqual([]);
    expect(parser.push("\n\n")).toEqual([{ event: "message", data: "x" }]);
  });

  it("completes a field name and a value across pushes", () => {
    const parser = createSseParser();
    expect(parser.push("eve")).toEqual([]);
    expect(parser.push("nt: st")).toEqual([]);
    expect(parser.push("age\nda")).toEqual([]);
    expect(parser.push("ta: 12")).toEqual([]);
    expect(parser.push("3\n\n")).toEqual([{ event: "stage", data: "123" }]);
  });

  it("gives the same events one character at a time as in one piece", () => {
    const text = "event: a\r\ndata: x\r\n\r\n: ping\r\n\r\ndata: y\rdata: z\r\r\ndata: end\n\n";
    const whole = run(text);
    const parser = createSseParser();
    const pieces = [...text].flatMap((ch) => parser.push(ch));
    expect(pieces).toEqual(whole);
    expect(whole).toHaveLength(3);
  });

  it("stays correct for a long line pushed in tiny chunks", () => {
    const payload = "x".repeat(20_000);
    const text = `data: ${payload}\n\n`;
    const parser = createSseParser();
    const events: RawEvent[] = [];
    for (let i = 0; i < text.length; i += 3) events.push(...parser.push(text.slice(i, i + 3)));
    expect(events).toEqual([{ event: "message", data: payload }]);
  });

  it("returns a new array every time", () => {
    const parser = createSseParser();
    const first = parser.push("data: a\n\n");
    first.push({ event: "forged", data: "" });
    expect(parser.push("data: b\n\n")).toEqual([{ event: "message", data: "b" }]);
  });

  it("keeps parsers independent of each other", () => {
    const one = createSseParser();
    const two = createSseParser();
    one.push("event: a\ndata: 1\n");
    expect(two.push("\n")).toEqual([]);
    expect(one.push("\n")).toEqual([{ event: "a", data: "1" }]);
  });
});

describe("end() (Requirement 25.12)", () => {
  it("returns nothing and drops an event that has no closing blank line", () => {
    const parser = createSseParser();
    expect(parser.push("event: a\ndata: x\n")).toEqual([]);
    expect(parser.end()).toBeUndefined();
    expect(parser.push("data: y\n\n")).toEqual([{ event: "message", data: "y" }]);
  });

  it("drops a last line that has no line break", () => {
    const parser = createSseParser();
    expect(parser.push("data: partial")).toEqual([]);
    parser.end();
    expect(parser.push("\n\n")).toEqual([]);
  });

  it("drops a held CR", () => {
    const parser = createSseParser();
    expect(parser.push("data: x\r\n\r")).toEqual([]);
    parser.end();
    expect(parser.push("\n")).toEqual([]);
  });

  it("does not drop events that were already complete", () => {
    const parser = createSseParser();
    const events = parser.push("data: a\n\ndata: b\n");
    parser.end();
    expect(events).toEqual([{ event: "message", data: "a" }]);
  });

  it("can be called on a fresh parser and more than once", () => {
    const parser = createSseParser();
    expect(() => {
      parser.end();
      parser.end();
    }).not.toThrow();
    expect(parser.push("data: z\n\n")).toEqual([{ event: "message", data: "z" }]);
  });
});

describe("text that only looks like a separator", () => {
  it.each([
    ["U+2028 line separator", "\u2028"],
    ["U+2029 paragraph separator", "\u2029"],
    ["U+0085 next line", "\u0085"],
    ["U+000B vertical tab", "\u000b"],
    ["U+000C form feed", "\u000c"],
    ["U+001C file separator", "\u001c"],
  ])("keeps %s inside the data", (_name, ch) => {
    expect(run(`data: a${ch}b\n\n`)).toEqual([{ event: "message", data: `a${ch}b` }]);
  });

  it("passes non-ASCII text through unchanged", () => {
    const text = "caf\u00e9 na\u00efve \u65e5\u672c\u8a9e \u{1F600}";
    expect(run(`event: n\ndata: ${text}\n\n`)).toEqual([{ event: "n", data: text }]);
  });
});

describe("shared stream fixture, read in one piece (Requirement 17.9, 17.15)", () => {
  const text = new TextDecoder("utf-8").decode(readFileSync(STREAM_FIXTURE));

  it("still has the features it exists for", () => {
    expect(text).toContain(": ping");
    expect(text).toContain("\r\n");
    expect([...text].some((ch) => (ch.codePointAt(0) ?? 0) > 0x7f)).toBe(true);
    expect(text).toContain("\u2028");
    expect(text.endsWith("\n\n")).toBe(true);
  });

  it("yields the expected events in order", () => {
    const parser = createSseParser();
    const events = parser.push(text);
    parser.end();

    expect(events.map((e) => e.event)).toEqual([
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
    const data = events.map((e) => JSON.parse(e.data) as Record<string, unknown>);
    expect(data[0]).toEqual({ max_attempts: 4, deadline_ms: 240000, cached: false });
    expect(data[1]).toEqual({ stage: "generating", attempt: 1 });
    expect(data[2]).toEqual({ stage: "verifying", attempt: 1 });
    expect(data[3]).toEqual({
      attempt: 1,
      ok: false,
      error_count: 2,
      warning_count: 0,
      items: [
        { tool: "policy", code: "POLICY_IMPORT_DISALLOWED", line: 3 },
        { tool: "tsc", code: "TSC_2322", line: 17 },
      ],
    });
    expect(data[4]).toEqual({ stage: "repairing", attempt: 2 });
    expect(data[5]).toEqual({
      text: "caf\u00e9 na\u00efve \u65e5\u672c\u8a9e \u{1F600} line\u2028break",
    });
    expect(data[6]).toEqual({ stage: "verifying", attempt: 2 });
    expect(data[7]).toEqual({ attempt: 2, ok: true, error_count: 0, warning_count: 0, items: [] });
    expect(data[8]).toEqual({ stage: "publishing", attempt: 2 });
    expect(data[9]).toEqual({
      animation: {
        animation_id: "3f8e2b1c-6d4a-4e5f-9a7b-0c1d2e3f4a5b",
        source_sha256: "a27321c1c0f1407c835394676fb809e185474ec0c0ce213e0c7cffedfa857750",
        bundle_sha256: "9aecee4acec55281859c57184dec790783d3c59b71aaf923de28e1d8b0dc9b73",
        width: 1280,
        height: 720,
        fps: 30,
        duration_in_frames: 150,
        contract_version: 1,
      },
      cached: false,
      attempts: 2,
    });
  });

  it("starts with `started` and has exactly one final event, last (Requirement 17.4)", () => {
    const events = run(text);
    expect(events[0].event).toBe("started");
    const final = events.map((e, i) => (e.event === "done" || e.event === "error" ? i : -1));
    expect(final.filter((i) => i >= 0)).toEqual([events.length - 1]);
  });

  it("leaves nothing pending after the last event", () => {
    const parser = createSseParser();
    parser.push(text);
    parser.end();
    expect(parser.push("data: next\n\n")).toEqual([{ event: "message", data: "next" }]);
  });
});
