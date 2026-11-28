/**
 * Tests: sandbox message protocol and session id (task 25.1, tests-first).
 *
 * Covers Requirement 28.1 / 28.2 (message set, `source`, `version`, strict Zod schemas),
 * 28.10 (decode never throws, valid messages survive encode -> decode), 28.11 (unknown keys and
 * out-of-range values are rejected), 28.13 (`ready` / `heartbeat` carry an empty `session`) and
 * 27.14 (a fresh 32 character hex Session_Id per mount).
 *
 *   1. one example per message type (design 10.6) decodes and round-trips;
 *   2. every example rejects an extra key, a wrong `source`/`version`, and a missing field;
 *   3. each bound of Requirement 28.11 accepts its edge and rejects the value just outside it;
 *   4. `session` of the wrong length or alphabet is rejected;
 *   5. `decodeMessage` returns `{ ok: false }` for anything that is not a message, hostile input
 *      included, and never throws;
 *   6. `newSessionId` yields 32 lowercase hex characters from `crypto.getRandomValues`;
 *   7. `protocol.ts` and `session.ts` import nothing outside `zod` and the contract reader, because
 *      the sandbox runtime bundle includes both (Requirement 27.7).
 *
 * The bound literals in section 3 are the numbers written in the requirements. They pin the
 * values that `protocol.ts` derives from the contract, so a contract change fails here on purpose.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTRACT } from "@/lib/animation/contract";
import {
  ERROR_CODE_PATTERN,
  MAX_BUNDLE_CHARS,
  MAX_DURATION_IN_FRAMES,
  MAX_FRAME_INDEX,
  MIN_DURATION_IN_FRAMES,
  SANDBOX_SOURCE,
  SANDBOX_VERSION,
  SESSION_ID_LENGTH,
  SESSION_PATTERN,
  decodeMessage,
  encodeMessage,
  isFrameMessage,
  isParentMessage,
  type SandboxMessage,
} from "@/lib/animation/protocol";
import { newSessionId } from "@/lib/animation/session";

const SESSION = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const ENVELOPE = { source: "lore-sandbox", version: 1 } as const;

/** One example per message type, as written in design 10.6. */
const EXAMPLES = {
  ready: { ...ENVELOPE, type: "ready", session: "" },
  load: {
    ...ENVELOPE,
    type: "load",
    session: SESSION,
    bundle: '"use strict";var __defProp=Object.defineProperty;',
    meta: { width: 1280, height: 720, fps: 30, duration_in_frames: 210, pause_at_frame: 180 },
    contract_version: 1,
  },
  loaded: { ...ENVELOPE, type: "loaded", session: SESSION, duration_in_frames: 210 },
  setMode: { ...ENVELOPE, type: "setMode", session: SESSION, mode: "animate" },
  frame: { ...ENVELOPE, type: "frame", session: SESSION, frame: 96, playing: true },
  paused: { ...ENVELOPE, type: "paused", session: SESSION, reason: "interaction", frame: 180 },
  resume: { ...ENVELOPE, type: "resume", session: SESSION },
  seek: { ...ENVELOPE, type: "seek", session: SESSION, frame: -40 },
  ended: { ...ENVELOPE, type: "ended", session: SESSION },
  error: { ...ENVELOPE, type: "error", session: SESSION, phase: "runtime", code: "RENDER_THROW" },
  heartbeat: { ...ENVELOPE, type: "heartbeat", session: SESSION },
  // `play` and `pause` are in Requirement 28.1 but not in the design 10.6 list.
  play: { ...ENVELOPE, type: "play", session: SESSION },
  pause: { ...ENVELOPE, type: "pause", session: SESSION },
} as const satisfies Record<string, Record<string, unknown>>;

type ExampleType = keyof typeof EXAMPLES;
const TYPES = Object.keys(EXAMPLES) as ExampleType[];

const PARENT_TYPES: ExampleType[] = ["load", "play", "pause", "resume", "seek", "setMode"];
const FRAME_TYPES: ExampleType[] = [
  "ready",
  "loaded",
  "frame",
  "paused",
  "ended",
  "error",
  "heartbeat",
];

/** `decodeMessage` on the example with `patch` applied; `undefined` values delete the key. */
function decodeWith(type: ExampleType, patch: Record<string, unknown>) {
  const data: Record<string, unknown> = { ...EXAMPLES[type], ...patch };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete data[key];
  }
  return decodeMessage(data);
}

const REJECTED = { ok: false } as const;

describe("message examples (design 10.6)", () => {
  it("covers all 13 message types of Requirement 28.1", () => {
    expect(TYPES).toHaveLength(13);
    expect([...PARENT_TYPES, ...FRAME_TYPES].sort()).toEqual([...TYPES].sort());
  });

  it.each(TYPES)("decodes a valid %s message unchanged", (type) => {
    expect(decodeMessage(EXAMPLES[type])).toEqual({ ok: true, message: EXAMPLES[type] });
  });

  it.each(TYPES)("round-trips %s through encode, structured clone and decode", (type) => {
    const message = EXAMPLES[type] as unknown as SandboxMessage;
    const encoded = encodeMessage(message);
    expect(decodeMessage(encoded)).toEqual({ ok: true, message });
    expect(decodeMessage(structuredClone(encoded))).toEqual({ ok: true, message });
  });

  it("accepts a load message without pause_at_frame", () => {
    const meta: Record<string, unknown> = { ...EXAMPLES.load.meta };
    delete meta.pause_at_frame;
    expect(decodeWith("load", { meta }).ok).toBe(true);
  });

  it("exposes the envelope constants", () => {
    expect(SANDBOX_SOURCE).toBe("lore-sandbox");
    expect(SANDBOX_VERSION).toBe(1);
  });
});

describe("encodeMessage", () => {
  it("returns a plain copy that shares no object with its input", () => {
    const message = EXAMPLES.load as unknown as Extract<SandboxMessage, { type: "load" }>;
    const encoded = encodeMessage(message) as typeof message;
    expect(encoded).not.toBe(message);
    expect(encoded.meta).not.toBe(message.meta);
    expect(Object.getPrototypeOf(encoded)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(encoded.meta)).toBe(Object.prototype);
  });

  it("is not affected by later changes to its input", () => {
    const message = {
      ...EXAMPLES.load,
      meta: { ...EXAMPLES.load.meta },
    } as unknown as Extract<SandboxMessage, { type: "load" }>;
    const encoded = encodeMessage(message) as typeof message;
    message.meta.duration_in_frames = 999;
    expect(encoded.meta.duration_in_frames).toBe(EXAMPLES.load.meta.duration_in_frames);
  });
});

describe("strict schemas (Requirement 28.2, 28.11)", () => {
  it.each(TYPES)("rejects an unknown key on %s", (type) => {
    expect(decodeWith(type, { extra: 1 })).toEqual(REJECTED);
  });

  it.each(TYPES)("rejects a wrong source, wrong version and missing envelope fields on %s", (type) => {
    expect(decodeWith(type, { source: "someone-else" })).toEqual(REJECTED);
    expect(decodeWith(type, { source: undefined })).toEqual(REJECTED);
    expect(decodeWith(type, { version: 2 })).toEqual(REJECTED);
    expect(decodeWith(type, { version: "1" })).toEqual(REJECTED);
    expect(decodeWith(type, { version: undefined })).toEqual(REJECTED);
    expect(decodeWith(type, { session: undefined })).toEqual(REJECTED);
    expect(decodeWith(type, { type: undefined })).toEqual(REJECTED);
  });

  it.each(["Ready", "LOAD", "set_mode", "unknown", "", 7, null])(
    "rejects the unknown type %j",
    (type) => {
      expect(decodeWith("ready", { type })).toEqual(REJECTED);
    },
  );

  it("rejects a message with the __proto__ key set by JSON.parse", () => {
    const data = JSON.parse(
      '{"source":"lore-sandbox","version":1,"type":"ready","session":"","__proto__":{"x":1}}',
    );
    expect(decodeMessage(data)).toEqual(REJECTED);
  });

  it("rejects an unknown key inside load.meta", () => {
    expect(decodeWith("load", { meta: { ...EXAMPLES.load.meta, depth: 3 } })).toEqual(REJECTED);
  });

  it.each(["width", "height", "fps", "duration_in_frames"] as const)(
    "rejects load.meta without %s",
    (key) => {
      const meta: Record<string, unknown> = { ...EXAMPLES.load.meta };
      delete meta[key];
      expect(decodeWith("load", { meta })).toEqual(REJECTED);
    },
  );

  it.each([
    ["a non-integer width", { width: 1280.5 }],
    ["a zero height", { height: 0 }],
    ["a negative fps", { fps: -30 }],
    ["a string fps", { fps: "30" }],
    ["a duration of 29", { duration_in_frames: 29 }],
    ["a duration of 901", { duration_in_frames: 901 }],
    ["a pause_at_frame of 0", { pause_at_frame: 0 }],
    ["a pause_at_frame of 900", { pause_at_frame: 900 }],
    ["a fractional pause_at_frame", { pause_at_frame: 10.5 }],
  ])("rejects load.meta with %s", (_label, patch) => {
    expect(decodeWith("load", { meta: { ...EXAMPLES.load.meta, ...patch } })).toEqual(REJECTED);
  });

  it.each([
    ["a zero contract_version", 0],
    ["a fractional contract_version", 1.5],
    ["a string contract_version", "1"],
  ])("rejects load with %s", (_label, contract_version) => {
    expect(decodeWith("load", { contract_version })).toEqual(REJECTED);
  });

  it.each([
    ["load without bundle", "load", { bundle: undefined }],
    ["load with a numeric bundle", "load", { bundle: 12 }],
    ["load without meta", "load", { meta: undefined }],
    ["load without contract_version", "load", { contract_version: undefined }],
    ["loaded without duration_in_frames", "loaded", { duration_in_frames: undefined }],
    ["setMode with another mode", "setMode", { mode: "slow" }],
    ["setMode without mode", "setMode", { mode: undefined }],
    ["frame without playing", "frame", { playing: undefined }],
    ["frame with playing as a number", "frame", { playing: 1 }],
    ["frame without frame", "frame", { frame: undefined }],
    ["paused with another reason", "paused", { reason: "stop" }],
    ["paused without frame", "paused", { frame: undefined }],
    ["seek without frame", "seek", { frame: undefined }],
    ["error with another phase", "error", { phase: "timeout" }],
    ["error without code", "error", { code: undefined }],
  ] as const)("rejects %s", (_label, type, patch) => {
    expect(decodeWith(type, patch)).toEqual(REJECTED);
  });
});

describe("bounds (Requirement 28.2, 28.11)", () => {
  it("pins the limits derived from the contract to the numbers of the requirements", () => {
    expect(MAX_BUNDLE_CHARS).toBe(131072);
    expect(MIN_DURATION_IN_FRAMES).toBe(30);
    expect(MAX_DURATION_IN_FRAMES).toBe(900);
    expect(MAX_FRAME_INDEX).toBe(899);
    expect(SESSION_ID_LENGTH).toBe(32);
  });

  it("reads the limits from the contract instead of repeating them", () => {
    expect(MAX_BUNDLE_CHARS).toBe(CONTRACT.limits.bundle_max_bytes);
    expect(MIN_DURATION_IN_FRAMES).toBe(CONTRACT.duration.min);
    expect(MAX_DURATION_IN_FRAMES).toBe(CONTRACT.duration.max);
    expect(MAX_FRAME_INDEX).toBe(CONTRACT.duration.max - 1);
  });

  describe("session", () => {
    it.each(TYPES)("accepts an empty session and a 32 character hex session on %s", (type) => {
      expect(decodeWith(type, { session: "" }).ok).toBe(true);
      expect(decodeWith(type, { session: SESSION }).ok).toBe(true);
    });

    it.each([
      ["31 characters", SESSION.slice(0, 31)],
      ["33 characters", `${SESSION}0`],
      ["1 character", "a"],
      ["64 characters", SESSION + SESSION],
      ["upper case hex", SESSION.toUpperCase()],
      ["a non-hex letter", `g${SESSION.slice(1)}`],
      ["a trailing newline", `${SESSION.slice(1)}\n`],
      ["surrounding spaces", ` ${SESSION.slice(2)} `],
      ["a dash separated uuid", "a1b2c3d4-e5f6-0718-293a-4b5c6d7e8f90"],
      ["a number", 12],
      ["null", null],
    ])("rejects a session of %s", (_label, session) => {
      expect(decodeWith("heartbeat", { session })).toEqual(REJECTED);
      expect(decodeWith("load", { session })).toEqual(REJECTED);
    });

    it("exposes a pattern that matches the same strings", () => {
      expect(SESSION_PATTERN.test("")).toBe(true);
      expect(SESSION_PATTERN.test(SESSION)).toBe(true);
      expect(SESSION_PATTERN.test(SESSION.slice(1))).toBe(false);
    });
  });

  describe("frame 0..899", () => {
    it.each(["frame", "paused"] as const)("accepts the edges on %s", (type) => {
      expect(decodeWith(type, { frame: 0 }).ok).toBe(true);
      expect(decodeWith(type, { frame: 899 }).ok).toBe(true);
    });

    it.each([-1, 900, 1000, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "5", null])(
      "rejects frame %j on frame and paused",
      (frame) => {
        expect(decodeWith("frame", { frame })).toEqual(REJECTED);
        expect(decodeWith("paused", { frame })).toEqual(REJECTED);
      },
    );
  });

  describe("loaded.duration_in_frames 30..900", () => {
    it("accepts the edges", () => {
      expect(decodeWith("loaded", { duration_in_frames: 30 }).ok).toBe(true);
      expect(decodeWith("loaded", { duration_in_frames: 900 }).ok).toBe(true);
    });

    it.each([29, 0, -1, 901, 30.5, Number.NaN, "210"])("rejects %j", (duration_in_frames) => {
      expect(decodeWith("loaded", { duration_in_frames })).toEqual(REJECTED);
    });
  });

  describe("seek.frame is a safe integer", () => {
    it.each([0, -40, 5000, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER])(
      "accepts %d",
      (frame) => {
        expect(decodeWith("seek", { frame }).ok).toBe(true);
      },
    );

    it.each([
      Number.MAX_SAFE_INTEGER + 1,
      -Number.MAX_SAFE_INTEGER - 1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      "3",
    ])("rejects %j", (frame) => {
      expect(decodeWith("seek", { frame })).toEqual(REJECTED);
    });
  });

  describe("load.bundle up to 131072 characters", () => {
    it("accepts a bundle of exactly the limit and a one character bundle", () => {
      expect(decodeWith("load", { bundle: "x".repeat(131072) }).ok).toBe(true);
      expect(decodeWith("load", { bundle: "x" }).ok).toBe(true);
    });

    it("rejects a bundle one character over the limit", () => {
      expect(decodeWith("load", { bundle: "x".repeat(131073) })).toEqual(REJECTED);
    });
  });

  describe("error.code matches [A-Z0-9_]{1,64}", () => {
    it.each(["A", "RENDER_THROW", "E_404", "_", "A".repeat(64)])("accepts %s", (code) => {
      expect(decodeWith("error", { code }).ok).toBe(true);
    });

    it.each([
      ["an empty code", ""],
      ["65 characters", "A".repeat(65)],
      ["lower case", "render_throw"],
      ["a dash", "RENDER-THROW"],
      ["a space", "RENDER THROW"],
      ["a trailing newline", "RENDER_THROW\n"],
      ["a number", 404],
      ["null", null],
    ])("rejects %s", (_label, code) => {
      expect(decodeWith("error", { code })).toEqual(REJECTED);
    });

    it("exposes a pattern that matches the same strings", () => {
      expect(ERROR_CODE_PATTERN.test("RENDER_THROW")).toBe(true);
      expect(ERROR_CODE_PATTERN.test("render_throw")).toBe(false);
    });
  });

  describe("enumerations", () => {
    it.each(["fast", "animate"])("accepts setMode %s", (mode) => {
      expect(decodeWith("setMode", { mode }).ok).toBe(true);
    });

    it.each(["interaction", "end"])("accepts paused reason %s", (reason) => {
      expect(decodeWith("paused", { reason }).ok).toBe(true);
    });

    it.each(["load", "runtime"])("accepts error phase %s", (phase) => {
      expect(decodeWith("error", { phase }).ok).toBe(true);
    });
  });
});

describe("direction guards", () => {
  it.each(PARENT_TYPES)("treats %s as a parent message only", (type) => {
    const message = EXAMPLES[type] as unknown as SandboxMessage;
    expect(isParentMessage(message)).toBe(true);
    expect(isFrameMessage(message)).toBe(false);
  });

  it.each(FRAME_TYPES)("treats %s as an iframe message only", (type) => {
    const message = EXAMPLES[type] as unknown as SandboxMessage;
    expect(isFrameMessage(message)).toBe(true);
    expect(isParentMessage(message)).toBe(false);
  });
});

describe("decodeMessage on values that are not messages", () => {
  const circular: Record<string, unknown> = { ...EXAMPLES.ready };
  circular.self = circular;

  const throwingGetter = { ...EXAMPLES.ready };
  Object.defineProperty(throwingGetter, "type", {
    enumerable: true,
    get() {
      throw new Error("hostile getter");
    },
  });

  const throwingProxy = new Proxy(
    {},
    {
      get() {
        throw new Error("hostile proxy");
      },
      has() {
        throw new Error("hostile proxy");
      },
      ownKeys() {
        throw new Error("hostile proxy");
      },
      getOwnPropertyDescriptor() {
        throw new Error("hostile proxy");
      },
    },
  );

  const NOT_MESSAGES: Array<[string, unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["an empty array", []],
    ["an array holding a valid message", [EXAMPLES.ready]],
    ["an empty string", ""],
    ["a string", "ready"],
    ["the JSON text of a valid message", JSON.stringify(EXAMPLES.ready)],
    ["zero", 0],
    ["a number", 42],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["true", true],
    ["false", false],
    ["a bigint", BigInt(10)],
    ["a symbol", Symbol("message")],
    ["a function", () => EXAMPLES.ready],
    ["an empty object", {}],
    ["a Date", new Date(0)],
    ["a Map", new Map([["type", "ready"]])],
    ["an object with only a type", { type: "ready" }],
    ["an object with a circular key", circular],
    ["an object with a throwing getter", throwingGetter],
    ["a throwing proxy", throwingProxy],
  ];

  it.each(NOT_MESSAGES)("returns { ok: false } for %s", (_label, value) => {
    expect(() => decodeMessage(value)).not.toThrow();
    expect(decodeMessage(value)).toEqual(REJECTED);
  });

  it("returns exactly { ok: false } with no other key", () => {
    expect(Object.keys(decodeMessage(null))).toEqual(["ok"]);
  });
});

describe("newSessionId (Requirement 27.14)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 32 lower case hexadecimal characters", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(newSessionId()).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it("returns ids that the protocol accepts as a session", () => {
    const session = newSessionId();
    expect(SESSION_PATTERN.test(session)).toBe(true);
    expect(decodeMessage({ ...EXAMPLES.heartbeat, session }).ok).toBe(true);
  });

  it("returns a different id on every call", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newSessionId()));
    expect(ids.size).toBe(500);
  });

  it("draws 16 bytes from crypto.getRandomValues and pads each byte to two digits", () => {
    // Bytes 0, 1, 2 ... 14, 255: the single digit bytes must come out as "00", "01" ... "0e".
    const fill = (array: Uint8Array) => {
      for (let index = 0; index < array.length; index += 1) {
        array[index] = index === array.length - 1 ? 255 : index;
      }
      return array;
    };
    const spy = vi
      .spyOn(globalThis.crypto, "getRandomValues")
      .mockImplementation(fill as unknown as typeof crypto.getRandomValues);

    expect(newSessionId()).toBe("000102030405060708090a0b0c0d0eff");
    expect(spy).toHaveBeenCalledTimes(1);
    const argument = spy.mock.calls[0]?.[0] as Uint8Array;
    expect(argument).toBeInstanceOf(Uint8Array);
    expect(argument).toHaveLength(16);
  });
});

describe("module imports (Requirement 27.7)", () => {
  const SRC = join(__dirname, "..", "..", "src", "lib", "animation");

  /**
   * Module specifiers of `import ... from "x"`, `export ... from "x"`, `import "x"`,
   * `import("x")` and `require("x")` in a file.
   */
  function importsOf(file: string): string[] {
    const text = readFileSync(join(SRC, file), "utf8");
    const patterns = [
      /^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gm,
      /^\s*import\s+["']([^"']+)["']/gm,
      /\b(?:import|require)\(\s*["']([^"']+)["']/g,
    ];
    return patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((m) => m[1] ?? ""));
  }

  it("keeps protocol.ts free of React, DOM and Next imports", () => {
    const imports = importsOf("protocol.ts");
    expect(imports).toContain("zod");
    expect(imports.filter((name) => name !== "zod" && name !== "./contract")).toEqual([]);
  });

  it("keeps session.ts free of imports", () => {
    expect(importsOf("session.ts")).toEqual([]);
  });
});
