/**
 * Property tests: round trip and robustness of the Sandbox_Protocol (task 25.2, design Property 8).
 * Validates Requirement 28.10.
 *
 * Property 8, in two halves:
 *   1. for every valid message `m`, `decodeMessage(encodeMessage(m))` deep-equals `m`, also after
 *      a structured clone and after a JSON text round trip (what `postMessage` and a log do to
 *      it), and neither call changes its input;
 *   2. for every other JavaScript value, `decodeMessage` returns `{ ok: false }` and never throws.
 *
 * "Valid" and "other" need an oracle that does not share code with `protocol.ts`, or a bug in the
 * schema would be repeated in the test. `referenceValid` below is written straight from
 * Requirement 28.1, 28.2 and 28.11 (message set, envelope, key sets, bounds), with the numbers
 * spelled out and no import from the module under test except the functions being tested. It
 * says which values are messages; the properties then demand that `decodeMessage` agrees on
 * every input, and that an accepted value comes back unchanged.
 *
 * Inputs, each 500 fast-check runs (the task asks for 100 or more):
 *   - generated valid messages of all 13 types, with edge values for each bound;
 *   - valid messages with one change: an unknown key (also `__proto__` as an own key), a deleted
 *     key, a value replaced by an edge value or by anything, a getter that throws. The result is
 *     usually invalid but sometimes still valid (a replaced value that is allowed); the oracle
 *     decides, so both outcomes are checked;
 *   - `fc.anything()` with every exotic kind switched on (Map, Set, Date, BigInt, typed arrays,
 *     boxed values, sparse arrays, null prototype), plus hostile objects (throwing getter and
 *     proxy, cyclic object).
 * A sanity test shows that these inputs reach both outcomes, so the oracle cannot be vacuous.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  decodeMessage,
  encodeMessage,
  isFrameMessage,
  isParentMessage,
  type SandboxMessage,
} from "@/lib/animation/protocol";

const RUNS = 500;

// ---------------------------------------------------------------------------
// The oracle: Requirement 28.1, 28.2, 28.11 written out independently of protocol.ts
// ---------------------------------------------------------------------------

const ENVELOPE_KEYS = ["source", "version", "type", "session"];

const isInt = (value: unknown, low: number, high: number): boolean =>
  typeof value === "number" && Number.isInteger(value) && value >= low && value <= high;

const isSafeInt = (value: unknown): boolean =>
  typeof value === "number" && Number.isSafeInteger(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.prototype.toString.call(value) === "[object Object]";

function validSession(value: unknown): boolean {
  return typeof value === "string" && (value === "" || /^[0-9a-f]{32}$/.test(value));
}

function validMeta(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const allowed = ["width", "height", "fps", "duration_in_frames", "pause_at_frame"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return false;
  return (
    isInt(value.width, 1, Infinity) &&
    isInt(value.height, 1, Infinity) &&
    isInt(value.fps, 1, Infinity) &&
    isInt(value.duration_in_frames, 30, 900) &&
    (value.pause_at_frame === undefined || isInt(value.pause_at_frame, 1, 899))
  );
}

/** Keys besides the envelope, and the check of their values, per message type. */
const SPECS: Record<string, { keys: string[]; check: (m: Record<string, unknown>) => boolean }> = {
  load: {
    keys: ["bundle", "meta", "contract_version"],
    check: (m) =>
      typeof m.bundle === "string" &&
      m.bundle.length <= 131072 &&
      validMeta(m.meta) &&
      isInt(m.contract_version, 1, Infinity),
  },
  play: { keys: [], check: () => true },
  pause: { keys: [], check: () => true },
  resume: { keys: [], check: () => true },
  seek: { keys: ["frame"], check: (m) => isSafeInt(m.frame) },
  setMode: { keys: ["mode"], check: (m) => m.mode === "fast" || m.mode === "animate" },
  ready: { keys: [], check: () => true },
  loaded: { keys: ["duration_in_frames"], check: (m) => isInt(m.duration_in_frames, 30, 900) },
  frame: {
    keys: ["frame", "playing"],
    check: (m) => isInt(m.frame, 0, 899) && typeof m.playing === "boolean",
  },
  paused: {
    keys: ["reason", "frame"],
    check: (m) => (m.reason === "interaction" || m.reason === "end") && isInt(m.frame, 0, 899),
  },
  ended: { keys: [], check: () => true },
  error: {
    keys: ["phase", "code"],
    check: (m) =>
      (m.phase === "load" || m.phase === "runtime") &&
      typeof m.code === "string" &&
      /^[A-Z0-9_]{1,64}$/.test(m.code),
  },
  heartbeat: { keys: [], check: () => true },
};

/** True when `value` is a Sandbox_Protocol message. Never throws: a hostile value is not one. */
function referenceValid(value: unknown): boolean {
  try {
    if (!isRecord(value)) return false;
    const type = value.type;
    if (typeof type !== "string" || !Object.prototype.hasOwnProperty.call(SPECS, type)) return false;
    const spec = SPECS[type];
    const allowed = new Set([...ENVELOPE_KEYS, ...spec.keys]);
    if (Object.keys(value).some((key) => !allowed.has(key))) return false;
    if (value.source !== "lore-sandbox" || value.version !== 1) return false;
    if (!validSession(value.session)) return false;
    return spec.check(value);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** An integer in `low..high`, with both edges and their neighbours drawn often. */
const intIn = (low: number, high: number): fc.Arbitrary<number> =>
  fc.oneof(
    { weight: 3, arbitrary: fc.integer({ min: low, max: high }) },
    { weight: 1, arbitrary: fc.constantFrom(low, low + 1, high - 1, high) },
  );

/** fast-check may build records with a null prototype; `noNullPrototype` keeps messages plain. */
const PLAIN = { noNullPrototype: true } as const;

const HEX = "0123456789abcdef".split("");
const hexSession = fc.array(fc.constantFrom(...HEX), { minLength: 32, maxLength: 32 }).map((c) => c.join(""));
const sessionArb = fc.oneof(fc.constant(""), hexSession);

const CODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_".split("");
const codeArb = fc
  .array(fc.constantFrom(...CODE_CHARS), { minLength: 1, maxLength: 64 })
  .map((chars) => chars.join(""));

const bundleArb = fc.oneof(
  { weight: 9, arbitrary: fc.string({ unit: "binary", maxLength: 200 }) },
  { weight: 1, arbitrary: fc.constantFrom(0, 131071, 131072).map((n) => "x".repeat(n)) },
);

const positiveInt = fc.oneof(intIn(1, 5000), fc.constantFrom(1e21, Number.MAX_SAFE_INTEGER));

const metaArb = fc.record(
  {
    width: positiveInt,
    height: positiveInt,
    fps: positiveInt,
    duration_in_frames: intIn(30, 900),
    pause_at_frame: intIn(1, 899),
  },
  { requiredKeys: ["width", "height", "fps", "duration_in_frames"], ...PLAIN },
);

const envelope = <T extends string>(type: T) => ({
  source: fc.constant("lore-sandbox" as const),
  version: fc.constant(1 as const),
  type: fc.constant(type),
  session: sessionArb,
});

const bare = (type: string) => fc.record(envelope(type), PLAIN);

/** Generators of valid messages, one per type. */
const validByType: Record<string, fc.Arbitrary<SandboxMessage>> = {
  load: fc.record(
    { ...envelope("load"), bundle: bundleArb, meta: metaArb, contract_version: positiveInt },
    PLAIN,
  ),
  play: bare("play"),
  pause: bare("pause"),
  resume: bare("resume"),
  seek: fc.record(
    {
      ...envelope("seek"),
      frame: fc.oneof(
        fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
        fc.constantFrom(0, -1, 1, 899, 900, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER),
      ),
    },
    PLAIN,
  ),
  setMode: fc.record({ ...envelope("setMode"), mode: fc.constantFrom("fast", "animate") }, PLAIN),
  ready: bare("ready"),
  loaded: fc.record({ ...envelope("loaded"), duration_in_frames: intIn(30, 900) }, PLAIN),
  frame: fc.record({ ...envelope("frame"), frame: intIn(0, 899), playing: fc.boolean() }, PLAIN),
  paused: fc.record(
    {
      ...envelope("paused"),
      reason: fc.constantFrom("interaction", "end"),
      frame: intIn(0, 899),
    },
    PLAIN,
  ),
  ended: bare("ended"),
  error: fc.record(
    { ...envelope("error"), phase: fc.constantFrom("load", "runtime"), code: codeArb },
    PLAIN,
  ),
  heartbeat: bare("heartbeat"),
} as Record<string, fc.Arbitrary<SandboxMessage>>;

/** A valid message of any of the 13 types. */
const validMessageArb: fc.Arbitrary<SandboxMessage> = fc.oneof(...Object.values(validByType));

/** Values worth putting where a field is expected: edges of every bound, wrong kinds, specials. */
const edgeValueArb: fc.Arbitrary<unknown> = fc.constantFrom(
  undefined,
  null,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  -1,
  -0,
  0,
  1,
  29,
  30,
  31,
  898,
  899,
  900,
  901,
  1.5,
  131072,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 1,
  Number.MIN_SAFE_INTEGER - 1,
  "",
  "0",
  "x",
  "fast",
  "animate",
  "interaction",
  "end",
  "load",
  "runtime",
  "ABC",
  "a".repeat(32),
  "A".repeat(32),
  true,
  false,
  [],
  {},
  [1],
  { a: 1 },
);

const anythingArb = fc.anything({
  maxDepth: 3,
  withBigInt: true,
  withBoxedValues: true,
  withDate: true,
  withMap: true,
  withSet: true,
  withNullPrototype: true,
  withObjectString: true,
  withSparseArray: true,
  withTypedArray: true,
});

const anyValueArb: fc.Arbitrary<unknown> = fc.oneof(edgeValueArb, anythingArb);

type Mutation =
  | { op: "add"; name: string; value: unknown }
  | { op: "drop"; pick: number; inMeta: boolean }
  | { op: "set"; pick: number; inMeta: boolean; value: unknown }
  | { op: "throwing"; pick: number }
  | { op: "tweak"; pick: number; inMeta: boolean; n: number; s: string; b: boolean };

const tweakNumberArb = fc.oneof(
  intIn(-2, 1002),
  fc.constantFrom(Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 1e21, 0.5),
);
const tweakStringArb = fc.constantFrom(
  "",
  "fast",
  "animate",
  "interaction",
  "end",
  "load",
  "runtime",
  "ABC_1",
  "abc",
  "lore-sandbox",
  "frame",
  "ready",
  "a".repeat(32),
  "A".repeat(32),
);

const mutationArb: fc.Arbitrary<Mutation> = fc.oneof(
  fc.record({
    op: fc.constant("add" as const),
    name: fc.constantFrom("extra", "Type", "constructor", "__proto__", "then", "toString", "", "0"),
    value: anyValueArb,
  }),
  fc.record({ op: fc.constant("drop" as const), pick: fc.nat(), inMeta: fc.boolean() }),
  fc.record({
    op: fc.constant("set" as const),
    pick: fc.nat(),
    inMeta: fc.boolean(),
    value: anyValueArb,
  }),
  fc.record({ op: fc.constant("throwing" as const), pick: fc.nat() }),
  {
    weight: 4,
    arbitrary: fc.record({
      op: fc.constant("tweak" as const),
      pick: fc.nat(),
      inMeta: fc.boolean(),
      n: tweakNumberArb,
      s: tweakStringArb,
      b: fc.boolean(),
    }),
  },
);

/** `message` with one change applied to a deep copy. */
function mutate(message: SandboxMessage, mutation: Mutation): unknown {
  const copy = structuredClone(message) as Record<string, unknown>;
  const meta = copy.meta;
  const target =
    "inMeta" in mutation && mutation.inMeta && meta !== null && typeof meta === "object"
      ? (meta as Record<string, unknown>)
      : copy;
  const keys = Object.keys(target);
  const key = keys[("pick" in mutation ? mutation.pick : 0) % keys.length];
  switch (mutation.op) {
    case "add":
      // `defineProperty` also makes `__proto__` an own key, as `JSON.parse` does.
      Object.defineProperty(target, mutation.name, {
        value: mutation.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      break;
    case "drop":
      delete target[key];
      break;
    case "set":
      target[key] = mutation.value;
      break;
    case "tweak": {
      // Replace a value by another of the same kind, so the result is often still valid.
      const current = target[key];
      if (typeof current === "number") target[key] = mutation.n;
      else if (typeof current === "string") target[key] = mutation.s;
      else if (typeof current === "boolean") target[key] = mutation.b;
      break;
    }
    case "throwing":
      Object.defineProperty(target, key, {
        enumerable: true,
        configurable: true,
        get() {
          throw new Error("hostile getter");
        },
      });
      break;
  }
  return copy;
}

const mutatedArb: fc.Arbitrary<unknown> = fc
  .tuple(validMessageArb, mutationArb)
  .map(([message, mutation]) => mutate(message, mutation));

/** Objects that attack the decoder itself. */
const hostile = (() => {
  /** Throws for every string key. fast-check probes each value for a symbol key, which is let through. */
  const trap = (_target: unknown, key: PropertyKey) => {
    if (typeof key === "symbol") return undefined;
    throw new Error("hostile proxy");
  };
  const trapHas = (_target: unknown, key: PropertyKey) => {
    if (typeof key === "symbol") return false;
    throw new Error("hostile proxy");
  };
  const cyclic: Record<string, unknown> = { source: "lore-sandbox", version: 1, type: "ready", session: "" };
  cyclic.self = cyclic;
  const getterOnType = { source: "lore-sandbox", version: 1, session: "" };
  Object.defineProperty(getterOnType, "type", {
    enumerable: true,
    get() {
      throw new Error("hostile getter");
    },
  });
  return [
    new Proxy(
      {},
      {
        get: trap,
        has: trapHas,
        ownKeys: () => {
          throw new Error("hostile proxy");
        },
        getOwnPropertyDescriptor: trap as never,
      },
    ),
    getterOnType,
    cyclic,
  ];
})();
const hostileArb = fc.constantFrom(...hostile);

/** Everything the second half of the property is run on. */
const candidateArb: fc.Arbitrary<unknown> = fc.oneof(
  { weight: 4, arbitrary: mutatedArb },
  { weight: 3, arbitrary: anythingArb },
  { weight: 2, arbitrary: validMessageArb },
  { weight: 1, arbitrary: hostileArb },
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const jsonRoundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const types = (messages: readonly unknown[]): Set<string> =>
  new Set(messages.map((m) => (m as { type: string }).type));

// ---------------------------------------------------------------------------
// The properties
// ---------------------------------------------------------------------------

describe("Property 8: the generators and the oracle", () => {
  it("draw messages of all 13 types, and every generated message is valid for the oracle", () => {
    const sample = fc.sample(validMessageArb, { numRuns: 600, seed: 8 });
    expect(types(sample).size).toBe(13);
    expect(sample.every((message) => referenceValid(message))).toBe(true);
    expect(sample.some((m) => m.type === "load" && m.meta.pause_at_frame === undefined)).toBe(true);
    expect(sample.some((m) => m.type === "load" && m.meta.pause_at_frame !== undefined)).toBe(true);
    expect(sample.some((m) => m.type === "load" && m.bundle.length === 131072)).toBe(true);
    expect(sample.some((m) => m.session === "")).toBe(true);
    expect(sample.some((m) => m.session.length === 32)).toBe(true);
  });

  it("separate valid from invalid among the changed messages, so the oracle decides both ways", () => {
    const sample = fc.sample(mutatedArb, { numRuns: 800, seed: 8 });
    const accepted = sample.filter(referenceValid);
    expect(accepted.length).toBeGreaterThan(20);
    expect(sample.length - accepted.length).toBeGreaterThan(200);
  });

  it("rejects known invalid shapes and accepts known valid ones", () => {
    const ok = { source: "lore-sandbox", version: 1, type: "frame", session: "", frame: 899, playing: false };
    expect(referenceValid(ok)).toBe(true);
    expect(referenceValid({ ...ok, frame: 900 })).toBe(false);
    expect(referenceValid({ ...ok, extra: 1 })).toBe(false);
    expect(referenceValid({ ...ok, session: "A".repeat(32) })).toBe(false);
    expect(referenceValid([ok])).toBe(false);
    expect(referenceValid(null)).toBe(false);
    expect(referenceValid(new Map())).toBe(false);
  });
});

describe("Property 8: decode(encode(m)) is m for every valid message", () => {
  it("returns the same message, and a copy that is not the input", () => {
    fc.assert(
      fc.property(validMessageArb, (message) => {
        const encoded = encodeMessage(message);
        expect(encoded).toStrictEqual(message);
        expect(encoded).not.toBe(message);
        const decoded = decodeMessage(encoded);
        expect(decoded).toStrictEqual({ ok: true, message });
      }),
      { numRuns: RUNS },
    );
  });

  it("survives a structured clone and a JSON text round trip", () => {
    fc.assert(
      fc.property(validMessageArb, (message) => {
        const encoded = encodeMessage(message);
        expect(decodeMessage(structuredClone(encoded))).toStrictEqual({ ok: true, message });
        expect(decodeMessage(jsonRoundTrip(encoded))).toStrictEqual({ ok: true, message });
      }),
      { numRuns: RUNS },
    );
  });

  it("changes nothing in its input: frozen messages encode and decode", () => {
    fc.assert(
      fc.property(validMessageArb, (message) => {
        const frozen = deepFreeze(structuredClone(message));
        const encoded = encodeMessage(frozen);
        expect(decodeMessage(frozen)).toStrictEqual({ ok: true, message });
        expect(decodeMessage(encoded)).toStrictEqual({ ok: true, message });
        // The copy shares nothing mutable with the input: editing it leaves the input alone.
        if (encoded.type === "load") encoded.meta.fps += 1;
        expect(frozen).toStrictEqual(message);
      }),
      { numRuns: RUNS },
    );
  });

  it("is repeatable and puts every message on exactly one side of the direction guards", () => {
    fc.assert(
      fc.property(validMessageArb, (message) => {
        expect(decodeMessage(message)).toStrictEqual(decodeMessage(message));
        expect(isParentMessage(message)).not.toBe(isFrameMessage(message));
      }),
      { numRuns: RUNS },
    );
  });
});

/** Every numeric bound of Requirement 28.2 and 28.11: where the field is and its allowed range. */
const BOUNDS: Array<{ type: string; path: string[]; low: number; high: number }> = [
  { type: "frame", path: ["frame"], low: 0, high: 899 },
  { type: "paused", path: ["frame"], low: 0, high: 899 },
  { type: "loaded", path: ["duration_in_frames"], low: 30, high: 900 },
  { type: "load", path: ["meta", "duration_in_frames"], low: 30, high: 900 },
  { type: "load", path: ["meta", "pause_at_frame"], low: 1, high: 899 },
  { type: "load", path: ["meta", "width"], low: 1, high: 1e21 },
  { type: "load", path: ["meta", "height"], low: 1, high: 1e21 },
  { type: "load", path: ["meta", "fps"], low: 1, high: 1e21 },
  { type: "load", path: ["contract_version"], low: 1, high: 1e21 },
  { type: "seek", path: ["frame"], low: Number.MIN_SAFE_INTEGER, high: Number.MAX_SAFE_INTEGER },
];

/** `message` with the number at `path` replaced (a copy; `pause_at_frame` is added when absent). */
function withNumber(message: SandboxMessage, path: string[], value: number): unknown {
  const copy = structuredClone(message) as Record<string, unknown>;
  const holder = path.length === 2 ? (copy[path[0]] as Record<string, unknown>) : copy;
  holder[path[path.length - 1]] = value;
  return copy;
}

describe("Property 8: every numeric bound accepts its edges and refuses the next value out", () => {
  const caseArb = fc
    .constantFrom(...BOUNDS)
    .chain((bound) => validByType[bound.type].map((message) => ({ bound, message })));

  it("accepts a value inside the range, the edges included", () => {
    fc.assert(
      fc.property(caseArb, fc.double({ min: 0, max: 1, noNaN: true }), ({ bound, message }, ratio) => {
        const { low, high, path } = bound;
        const inside = [low, high, Math.min(high, low + 1), Math.max(low, high - 1)];
        // A point in the middle, kept an integer.
        inside.push(Math.floor(low + (Math.min(high, low + 100000) - low) * ratio));
        for (const value of inside) {
          const result = decodeMessage(withNumber(message, path, value));
          expect(result.ok, `${bound.type}.${path.join(".")} = ${value}`).toBe(true);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("refuses the value just below and just above the range", () => {
    fc.assert(
      fc.property(caseArb, ({ bound, message }) => {
        const { low, high, path } = bound;
        // `low + 0.5` is not exactly representable beside the safe-integer limits, so 0.5 stands in.
        const fraction = Math.abs(low) < 1e15 ? low + 0.5 : 0.5;
        const outside = [low - 1, Number.NaN, fraction, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
        if (high < 1e21) outside.push(high + 1);
        // Below the safe range (`seek`), a number that is no longer exact must be refused too.
        if (low === Number.MIN_SAFE_INTEGER) outside.push(Number.MIN_SAFE_INTEGER - 2, Number.MAX_SAFE_INTEGER + 2);
        for (const value of outside) {
          if (low === Number.MIN_SAFE_INTEGER && value === low - 1) continue; // `low - 1` is not representable
          const result = decodeMessage(withNumber(message, path, value));
          expect(result, `${bound.type}.${path.join(".")} = ${value}`).toStrictEqual({ ok: false });
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("holds the same limits for the bundle length, the error code and the session", () => {
    fc.assert(
      fc.property(
        validByType.load,
        validByType.error,
        validByType.heartbeat,
        (load, error, heartbeat) => {
          const withBundle = (n: number) => ({ ...load, bundle: "x".repeat(n) });
          expect(decodeMessage(withBundle(131072)).ok).toBe(true);
          expect(decodeMessage(withBundle(131073)).ok).toBe(false);
          const withCode = (code: string) => ({ ...error, code });
          expect(decodeMessage(withCode("A".repeat(64))).ok).toBe(true);
          expect(decodeMessage(withCode("A".repeat(65))).ok).toBe(false);
          expect(decodeMessage(withCode("")).ok).toBe(false);
          expect(decodeMessage(withCode("a")).ok).toBe(false);
          const withSession = (session: string) => ({ ...heartbeat, session });
          expect(decodeMessage(withSession("")).ok).toBe(true);
          expect(decodeMessage(withSession("0".repeat(32))).ok).toBe(true);
          expect(decodeMessage(withSession("0".repeat(31))).ok).toBe(false);
          expect(decodeMessage(withSession("0".repeat(33))).ok).toBe(false);
          expect(decodeMessage(withSession("F".repeat(32))).ok).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Property 8: decodeMessage on any other value", () => {
  it("never throws and agrees with the oracle on which values are messages", () => {
    fc.assert(
      fc.property(candidateArb, (value) => {
        const result = decodeMessage(value);
        expect(result.ok).toBe(referenceValid(value));
        if (!result.ok) expect(result).toStrictEqual({ ok: false });
      }),
      { numRuns: RUNS },
    );
  });

  it("hands back an accepted value unchanged and a refused one as exactly { ok: false }", () => {
    fc.assert(
      fc.property(mutatedArb, (value) => {
        const result = decodeMessage(value);
        if (result.ok) {
          expect(result.message).toEqual(value);
          expect(referenceValid(value)).toBe(true);
        } else {
          expect(Object.keys(result)).toEqual(["ok"]);
          expect(referenceValid(value)).toBe(false);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("refuses every message with an unknown key, at the top level and inside load.meta", () => {
    const unknownKey = fc.constantFrom("extra", "Type", "__proto__", "constructor", "then", "session2", "");
    fc.assert(
      fc.property(validMessageArb, unknownKey, anyValueArb, fc.boolean(), (message, name, value, inMeta) => {
        const copy = structuredClone(message) as Record<string, unknown>;
        const target =
          inMeta && message.type === "load" ? (copy.meta as Record<string, unknown>) : copy;
        Object.defineProperty(target, name, { value, enumerable: true, configurable: true, writable: true });
        expect(decodeMessage(copy)).toStrictEqual({ ok: false });
      }),
      { numRuns: RUNS },
    );
  });

  it("refuses a message that lacks any one of its required keys", () => {
    fc.assert(
      fc.property(validMessageArb, fc.nat(), (message, pick) => {
        const copy = structuredClone(message) as Record<string, unknown>;
        const required = Object.keys(copy).filter((key) => key !== "pause_at_frame");
        delete copy[required[pick % required.length]];
        expect(decodeMessage(copy)).toStrictEqual({ ok: false });
      }),
      { numRuns: RUNS },
    );
  });

  it("refuses primitives, arrays and exotic objects, including a valid message wrapped in them", () => {
    fc.assert(
      fc.property(validMessageArb, anythingArb, (message, other) => {
        const text = JSON.stringify(message);
        const wrapped: unknown[] = [
          text,
          [message],
          new Map([["message", message]]),
          new Set([message]),
          Object.assign(Object.create(null), { message }),
          { data: message },
          Promise.resolve(message),
          other,
        ];
        for (const value of wrapped) {
          if (referenceValid(value)) continue; // `other` may itself be a message
          expect(decodeMessage(value)).toStrictEqual({ ok: false });
        }
      }),
      { numRuns: RUNS },
    );
  });
});
