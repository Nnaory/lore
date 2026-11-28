/**
 * animation-events.test.ts — the events of the animation stream and the final result.
 *
 * Why: the backend writes five kinds of event (`started`, `stage`, `diagnostics`, `done`, `error`)
 * and the client must read exactly what it writes (Requirements 25.3, 38.4). `done` carries an
 * Animation_Reference, so it must follow the strict reference rules the story schema uses; the
 * shared `reference-*` fixtures prove that here too. The stream itself is read from the shared
 * fixture `backend/tests/fixtures/animation/sse-stream.txt` once the backend task that writes it
 * has landed (until then those tests are reported as skipped, not passed). A stream built in this
 * file from the payloads of design 10.4 runs the same checks in the meantime, including `: ping`
 * comment lines, non-ASCII text and CRLF line ends.
 *
 * `splitStream` below is a small reader for the tests only. The real parser is `sse-parser.ts`;
 * this file does not import it so the schema tests stand on their own.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANIMATION_ATTEMPTS_MAX,
  ANIMATION_DEADLINE_MS_MAX,
  ANIMATION_DIAGNOSTIC_ITEMS_MAX,
  ANIMATION_EVENT_SCHEMAS,
  AnimationResultSchema,
  DiagnosticsSchema,
  DoneSchema,
  ErrorSchema,
  readAnimationEvent,
  StageSchema,
  StartedSchema,
} from "@/lib/contracts/animation-events";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DIR = join(__dirname, "..", "..", "..", "backend", "tests", "fixtures", "animation");
const STREAM_PATH = join(DIR, "sse-stream.txt");

const stems = (prefix: string): string[] =>
  readdirSync(DIR)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();

const load = (stem: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(DIR, `${stem}.json`), "utf8")) as Record<string, unknown>;

const LESSON_REFERENCE = load("reference-valid-lesson");
const PUZZLE_REFERENCE = load("reference-valid-puzzle");

/** The nine keys of a reference; the fixture `reference-valid-unknown-key-dropped` adds one more. */
const REFERENCE_KEYS = [
  "animation_id",
  "source_sha256",
  "bundle_sha256",
  "width",
  "height",
  "fps",
  "duration_in_frames",
  "pause_at_frame",
  "contract_version",
];
const known = (raw: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(raw).filter(([key]) => REFERENCE_KEYS.includes(key)));

// ---------------------------------------------------------------------------
// Payloads of design 10.4
// ---------------------------------------------------------------------------

const STARTED = { max_attempts: 4, deadline_ms: 240000, cached: false };
const DIAGNOSTICS = {
  attempt: 1,
  ok: false,
  error_count: 3,
  warning_count: 1,
  items: [
    { tool: "policy", code: "POLICY_COLOR_LITERAL", line: 41 },
    { tool: "tsc", code: "TSC_2322", line: 57 },
    { tool: "render", code: "RENDER_EMPTY" },
  ],
};
const DONE = { animation: LESSON_REFERENCE, cached: false, attempts: 2 };
const ERROR = {
  code: "ANIMATION_VERIFICATION_FAILED",
  message: "The animation could not be verified. The lesson will use the standard drawing.",
  attempts: 4,
};

const stageOf = (stage: string, attempt: number) => ({ stage, attempt });

// ---------------------------------------------------------------------------
// Payload schemas
// ---------------------------------------------------------------------------

describe("event payload schemas", () => {
  it("accept the payloads of design 10.4", () => {
    expect(StartedSchema.parse(STARTED)).toEqual(STARTED);
    expect(StartedSchema.parse({ ...STARTED, cached: true })).toEqual({ ...STARTED, cached: true });
    for (const stage of ["generating", "verifying", "repairing", "publishing"]) {
      expect(StageSchema.parse(stageOf(stage, 2))).toEqual(stageOf(stage, 2));
    }
    expect(DiagnosticsSchema.parse(DIAGNOSTICS)).toEqual(DIAGNOSTICS);
    expect(DoneSchema.parse(DONE)).toEqual({ ...DONE, animation: known(LESSON_REFERENCE) });
    expect(ErrorSchema.parse(ERROR)).toEqual(ERROR);
  });

  it("accept the value at each edge of a range and refuse the one past it", () => {
    for (const attempt of [1, ANIMATION_ATTEMPTS_MAX]) expect(StageSchema.safeParse(stageOf("verifying", attempt)).success).toBe(true);
    for (const attempt of [0, ANIMATION_ATTEMPTS_MAX + 1]) expect(StageSchema.safeParse(stageOf("verifying", attempt)).success).toBe(false);
    for (const ms of [1, ANIMATION_DEADLINE_MS_MAX]) expect(StartedSchema.safeParse({ ...STARTED, deadline_ms: ms }).success).toBe(true);
    for (const ms of [0, ANIMATION_DEADLINE_MS_MAX + 1]) expect(StartedSchema.safeParse({ ...STARTED, deadline_ms: ms }).success).toBe(false);
    for (const attempts of [0, ANIMATION_ATTEMPTS_MAX]) expect(ErrorSchema.safeParse({ ...ERROR, attempts }).success).toBe(true);
    for (const attempts of [-1, ANIMATION_ATTEMPTS_MAX + 1]) expect(ErrorSchema.safeParse({ ...ERROR, attempts }).success).toBe(false);
  });

  it("refuse malformed payloads", () => {
    const cases: [string, { safeParse: (v: unknown) => { success: boolean } }, unknown][] = [
      ["started: zero attempts", StartedSchema, { ...STARTED, max_attempts: 0 }],
      ["started: five attempts", StartedSchema, { ...STARTED, max_attempts: 5 }],
      ["started: fractional attempts", StartedSchema, { ...STARTED, max_attempts: 1.5 }],
      ["started: attempts as text", StartedSchema, { ...STARTED, max_attempts: "4" }],
      ["started: negative deadline", StartedSchema, { ...STARTED, deadline_ms: -1 }],
      ["started: cached as text", StartedSchema, { ...STARTED, cached: "false" }],
      ["started: cached missing", StartedSchema, { max_attempts: 4, deadline_ms: 1000 }],
      ["started: null", StartedSchema, null],
      ["stage: unknown stage", StageSchema, stageOf("done", 1)],
      ["stage: attempt missing", StageSchema, { stage: "verifying" }],
      ["stage: array", StageSchema, [stageOf("verifying", 1)]],
      ["diagnostics: attempt five", DiagnosticsSchema, { ...DIAGNOSTICS, attempt: 5 }],
      ["diagnostics: negative error count", DiagnosticsSchema, { ...DIAGNOSTICS, error_count: -1 }],
      ["diagnostics: fractional warning count", DiagnosticsSchema, { ...DIAGNOSTICS, warning_count: 0.5 }],
      ["diagnostics: ok as text", DiagnosticsSchema, { ...DIAGNOSTICS, ok: "no" }],
      ["diagnostics: items not a list", DiagnosticsSchema, { ...DIAGNOSTICS, items: {} }],
      ["diagnostics: item without code", DiagnosticsSchema, { ...DIAGNOSTICS, items: [{ tool: "tsc" }] }],
      ["diagnostics: item line zero", DiagnosticsSchema, { ...DIAGNOSTICS, items: [{ tool: "tsc", code: "TSC_1", line: 0 }] }],
      ["diagnostics: item line null", DiagnosticsSchema, { ...DIAGNOSTICS, items: [{ tool: "tsc", code: "TSC_1", line: null }] }],
      ["done: no animation", DoneSchema, { cached: false, attempts: 1 }],
      ["done: null animation", DoneSchema, { ...DONE, animation: null }],
      ["done: cached missing", DoneSchema, { animation: LESSON_REFERENCE, attempts: 1 }],
      ["done: zero attempts", DoneSchema, { ...DONE, attempts: 0 }],
      ["done: five attempts", DoneSchema, { ...DONE, attempts: 5 }],
      ["error: empty code", ErrorSchema, { ...ERROR, code: "" }],
      ["error: code is a number", ErrorSchema, { ...ERROR, code: 500 }],
      ["error: message missing", ErrorSchema, { code: "UNKNOWN", attempts: 0 }],
      ["error: attempts missing", ErrorSchema, { code: "UNKNOWN", message: "x" }],
    ];
    for (const [label, schema, value] of cases) {
      expect(schema.safeParse(value).success, label).toBe(false);
    }
  });

  it("refuse more than ten diagnostics and accept exactly ten", () => {
    const item = { tool: "tsc", code: "TSC_2322", line: 3 };
    const items = (count: number) => Array.from({ length: count }, () => item);
    expect(DiagnosticsSchema.safeParse({ ...DIAGNOSTICS, items: items(ANIMATION_DIAGNOSTIC_ITEMS_MAX) }).success).toBe(true);
    expect(DiagnosticsSchema.safeParse({ ...DIAGNOSTICS, items: items(ANIMATION_DIAGNOSTIC_ITEMS_MAX + 1) }).success).toBe(false);
    expect(DiagnosticsSchema.safeParse({ ...DIAGNOSTICS, items: [] }).success).toBe(true);
  });

  it("drop unknown keys instead of refusing them", () => {
    expect(StartedSchema.parse({ ...STARTED, later: 1 })).toEqual(STARTED);
    expect(StageSchema.parse({ ...stageOf("verifying", 1), later: [] })).toEqual(stageOf("verifying", 1));
    expect(ErrorSchema.parse({ ...ERROR, later: true })).toEqual(ERROR);
    expect(DiagnosticsSchema.parse({ ...DIAGNOSTICS, later: 1, items: [{ tool: "tsc", code: "TSC_1", later: 1 }] })).toEqual({
      ...DIAGNOSTICS,
      items: [{ tool: "tsc", code: "TSC_1" }],
    });
  });

  it("keep the pause frame of a puzzle reference in `done` and leave a lesson reference without one", () => {
    const puzzle = DoneSchema.parse({ ...DONE, animation: PUZZLE_REFERENCE });
    expect(puzzle.animation.pause_at_frame).toBe(PUZZLE_REFERENCE.pause_at_frame);
    expect(Object.prototype.hasOwnProperty.call(DoneSchema.parse(DONE).animation, "pause_at_frame")).toBe(false);
  });
});

describe("`done` follows the strict reference rules of the shared fixtures", () => {
  const VALID = stems("reference-valid-");
  const INVALID = stems("reference-invalid-");

  it("finds the reference fixtures", () => {
    expect(VALID.length).toBeGreaterThan(0);
    expect(INVALID.length).toBeGreaterThan(0);
  });

  it.each(VALID)("accepts %s", (stem) => {
    const raw = load(stem);
    const parsed = DoneSchema.safeParse({ animation: raw, cached: true, attempts: 1 });
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
    if (parsed.success) expect(parsed.data.animation).toEqual(known(raw));
  });

  it.each(INVALID)("rejects %s", (stem) => {
    const parsed = DoneSchema.safeParse({ animation: load(stem), cached: true, attempts: 1 });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0].path[0]).toBe("animation");
  });
});

// ---------------------------------------------------------------------------
// readAnimationEvent
// ---------------------------------------------------------------------------

const raw = (event: string, payload: unknown) => ({ event, data: JSON.stringify(payload) });

describe("readAnimationEvent", () => {
  it("reads each known event into a tagged value", () => {
    expect(readAnimationEvent(raw("started", STARTED))).toEqual({ ok: true, event: { event: "started", data: STARTED } });
    expect(readAnimationEvent(raw("stage", stageOf("repairing", 2)))).toEqual({
      ok: true,
      event: { event: "stage", data: stageOf("repairing", 2) },
    });
    expect(readAnimationEvent(raw("diagnostics", DIAGNOSTICS))).toEqual({
      ok: true,
      event: { event: "diagnostics", data: DIAGNOSTICS },
    });
    expect(readAnimationEvent(raw("done", DONE))).toEqual({
      ok: true,
      event: { event: "done", data: { ...DONE, animation: known(LESSON_REFERENCE) } },
    });
    expect(readAnimationEvent(raw("error", ERROR))).toEqual({ ok: true, event: { event: "error", data: ERROR } });
  });

  it("names every schema it reads with", () => {
    expect(Object.keys(ANIMATION_EVENT_SCHEMAS).sort()).toEqual(["diagnostics", "done", "error", "stage", "started"]);
  });

  it("ignores any other event name, including names that exist on every object", () => {
    for (const name of ["message", "ping", "Started", "", "constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(readAnimationEvent({ event: name, data: "{}" })).toEqual({ ok: false, reason: "unknown_event", event: name });
    }
  });

  it("reports data that is not JSON and data that is not the payload, with the event name", () => {
    for (const data of ["", "{", "not json", "{'a':1}", "undefined", "{\"a\":1}\n{\"b\":2}"]) {
      expect(readAnimationEvent({ event: "done", data })).toMatchObject({ ok: false, reason: "invalid_json", event: "done" });
    }
    for (const data of ["null", "[]", "42", "\"text\"", "{}", "true"]) {
      expect(readAnimationEvent({ event: "stage", data })).toMatchObject({ ok: false, reason: "invalid_payload", event: "stage" });
    }
    expect(readAnimationEvent(raw("error", { ...ERROR, code: "" }))).toMatchObject({ ok: false, reason: "invalid_payload" });
    expect(readAnimationEvent(raw("done", { ...DONE, animation: load("reference-invalid-id-uppercase") }))).toMatchObject({
      ok: false,
      reason: "invalid_payload",
      event: "done",
    });
  });

  it("never throws, whatever the text", () => {
    for (const data of ["\u0000", "\ud800", "😀", "{\"__proto__\":{\"x\":1}}", "9".repeat(5000), "[".repeat(5000)]) {
      for (const name of Object.keys(ANIMATION_EVENT_SCHEMAS)) {
        expect(() => readAnimationEvent({ event: name, data })).not.toThrow();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AnimationResultSchema
// ---------------------------------------------------------------------------

describe("AnimationResultSchema", () => {
  const success = { ok: true, animation: LESSON_REFERENCE, cached: true, attempts: 1 };

  it("accepts a success and each failure shape", () => {
    expect(AnimationResultSchema.parse(success)).toEqual({ ...success, animation: known(LESSON_REFERENCE) });
    expect(AnimationResultSchema.parse({ ok: false, code: "ABORTED", message: "" })).toEqual({
      ok: false,
      code: "ABORTED",
      message: "",
    });
    expect(AnimationResultSchema.parse({ ok: false, code: "RATE_LIMITED", message: "Slow down", retryAfterSeconds: 0 })).toEqual({
      ok: false,
      code: "RATE_LIMITED",
      message: "Slow down",
      retryAfterSeconds: 0,
    });
  });

  it("refuses a result that mixes the two shapes or breaks a field", () => {
    const bad: unknown[] = [
      { ok: true, cached: true, attempts: 1 },
      { ok: true, animation: LESSON_REFERENCE, cached: true },
      { ok: true, animation: LESSON_REFERENCE, cached: true, attempts: 0 },
      { ok: true, animation: load("reference-invalid-fps-24"), cached: true, attempts: 1 },
      { ok: false, message: "no code" },
      { ok: false, code: "", message: "empty code" },
      { ok: false, code: "X" },
      { ok: false, code: "RATE_LIMITED", message: "", retryAfterSeconds: -1 },
      { ok: false, code: "RATE_LIMITED", message: "", retryAfterSeconds: 1.5 },
      { ok: "true", code: "X", message: "" },
      { code: "X", message: "" },
      null,
      [],
    ];
    for (const value of bad) expect(AnimationResultSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A complete stream
// ---------------------------------------------------------------------------

type RawEvent = { event: string; data: string };

/**
 * Test-only reader of SSE text: `\n`, `\r\n` and `\r` end a line, a blank line ends an event, a
 * line that starts with `:` is a comment, one space after `data:` is dropped, and a last event
 * that is not closed by a blank line is thrown away. The real parser is `sse-parser.ts`.
 */
function splitStream(text: string): RawEvent[] {
  const blocks = text.replace(/\r\n|\r/g, "\n").split("\n\n");
  blocks.pop(); // whatever follows the last blank line is an unfinished event
  const events: RawEvent[] = [];
  for (const block of blocks) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line === "" || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length > 0) events.push({ event, data: data.join("\n") });
  }
  return events;
}

type StreamEvent = { event: string; payload: unknown };

/** Writes events the way the backend does: one JSON line per `data:`, non-ASCII left as is. */
function encodeStream(events: StreamEvent[], newline: string, withPing: boolean): string {
  const parts = events.map(({ event, payload }) => `event: ${event}${newline}data: ${JSON.stringify(payload)}${newline}${newline}`);
  if (withPing) parts.splice(2, 0, `: ping${newline}${newline}`);
  return parts.join("");
}

const NON_ASCII_ERROR = {
  code: "ANIMATION_TIMEOUT",
  message: "Animasinya terlalu lama dibuat — pakai gambar standar. 😀 é ü 日本語",
  attempts: 3,
};

const SUCCESS_EVENTS: StreamEvent[] = [
  { event: "started", payload: STARTED },
  { event: "stage", payload: stageOf("generating", 1) },
  { event: "stage", payload: stageOf("verifying", 1) },
  { event: "diagnostics", payload: DIAGNOSTICS },
  { event: "stage", payload: stageOf("repairing", 2) },
  { event: "stage", payload: stageOf("publishing", 2) },
  { event: "done", payload: DONE },
];
const FAILURE_EVENTS: StreamEvent[] = [
  { event: "started", payload: STARTED },
  { event: "stage", payload: stageOf("generating", 1) },
  { event: "error", payload: NON_ASCII_ERROR },
];
const CACHED_EVENTS: StreamEvent[] = [
  { event: "started", payload: { ...STARTED, cached: true } },
  { event: "done", payload: { ...DONE, cached: true } },
];

/** What a complete stream must look like, however it is written (Requirements 17.2, 25.3). */
function expectCompleteStream(events: RawEvent[]): void {
  expect(events.length).toBeGreaterThanOrEqual(2);
  expect(events[0].event).toBe("started");
  const read = events.map((event) => readAnimationEvent(event));
  for (const result of read) expect(result.ok, JSON.stringify(result)).toBe(true);
  const names = events.map((event) => event.event);
  const terminal = names.filter((name) => name === "done" || name === "error");
  expect(terminal).toHaveLength(1);
  expect(["done", "error"]).toContain(names[names.length - 1]);
  expect(names.filter((name) => name === "started")).toHaveLength(1);
}

describe("built streams (design 10.4)", () => {
  const streams: [string, StreamEvent[]][] = [
    ["a success with a repair", SUCCESS_EVENTS],
    ["a failure with non-ASCII text", FAILURE_EVENTS],
    ["a cache hit", CACHED_EVENTS],
  ];

  for (const [label, events] of streams) {
    for (const [newlineLabel, newline] of [["LF", "\n"], ["CRLF", "\r\n"], ["CR", "\r"]] as const) {
      it(`reads ${label} with ${newlineLabel} line ends and a ping`, () => {
        const text = encodeStream(events, newline, events.length > 3);
        const read = splitStream(text);
        expect(read.map((event) => event.event)).toEqual(events.map((event) => event.event));
        expectCompleteStream(read);
        const last = readAnimationEvent(read[read.length - 1]);
        expect(last.ok && last.event.event).toBe(events[events.length - 1].event);
      });
    }
  }

  it("keeps non-ASCII text exactly as written", () => {
    const read = splitStream(encodeStream(FAILURE_EVENTS, "\r\n", false));
    const result = readAnimationEvent(read[read.length - 1]);
    expect(result.ok && result.event.event === "error" && result.event.data.message).toBe(NON_ASCII_ERROR.message);
  });

  it("does not turn a stream cut before its last blank line into an event", () => {
    const text = encodeStream(SUCCESS_EVENTS, "\n", false);
    const cut = text.slice(0, text.length - 1);
    expect(splitStream(cut).map((event) => event.event)).toEqual(SUCCESS_EVENTS.slice(0, -1).map((event) => event.event));
  });
});

describe.skipIf(!existsSync(STREAM_PATH))("shared stream fixture sse-stream.txt", () => {
  const text = (): string => readFileSync(STREAM_PATH, "utf8");
  /** Names the client reads; any other name is ignored (Requirement 25.3). */
  const known = (event: RawEvent): boolean => Object.keys(ANIMATION_EVENT_SCHEMAS).includes(event.event);

  it("is one complete stream whose every known event passes its schema", () => {
    expectCompleteStream(splitStream(text()).filter(known));
  });

  it("holds exactly one event the client must ignore, a `notice`, and no schema reads it", () => {
    const ignored = splitStream(text()).filter((event) => !known(event));
    expect(ignored.map((event) => event.event)).toEqual(["notice"]);
    for (const event of ignored) {
      expect(readAnimationEvent(event)).toEqual({ ok: false, reason: "unknown_event", event: "notice" });
    }
  });

  it("uses CRLF line ends, which the client must accept as well as LF", () => {
    expect(text()).toContain("\r\n");
  });

  it("holds a comment line and non-ASCII text", () => {
    expect(text()).toMatch(/^: ?ping/m);
    expect([...text()].some((char) => char.charCodeAt(0) > 0x7f)).toBe(true);
  });
});
