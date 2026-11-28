/**
 * Property tests: `readContract` is total (task 20.2, design Property 1, runtime side).
 *
 * Property 1: for every JSON value, `readContract` returns `{ ok: true, contract }` or
 * `{ ok: false, reason }` and never throws. Validates Requirements 2.10, 2.11, 38.3.
 *
 * `contract-parity.test.ts` holds the hand-picked examples. Here fast-check generates the inputs,
 * 200 runs per property (the task asks for at least 100):
 *   1. any JSON value, and any JavaScript value (BigInt, Map, typed arrays, null prototype,
 *      sparse arrays), plus hostile objects (throwing getters, a throwing Proxy, a revoked Proxy,
 *      a cycle): a result of the right shape, no exception, input left untouched, same answer twice;
 *   2. the shipped contract after one to three random edits (delete, set, push, pop on any
 *      structural path): same totality, and `ok: true` only when an independent oracle written in
 *      this file agrees that the minimum of Requirement 2.11 holds;
 *   3. random valid contracts (other numbers, lists and unknown keys): always accepted, unknown keys
 *      dropped, everything else kept;
 *   4. one targeted violation of each minimum check: always rejected, and the reason names the field.
 *
 * Numbers and lists come from the JSON copy itself (the counts of colour tokens and code prefixes,
 * the limit names), so no contract value is restated here. The oracle is deliberately not the Zod
 * schema: it states only the checks of Requirement 2.11 and the two counts of Requirements 2.12
 * and 2.13, so a check dropped from `contract.ts` shows up as a counterexample.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { readContract } from "@/lib/animation/contract";

const RUNS = 200;

const COPY = join(__dirname, "..", "..", "src", "lib", "animation", "animation-contract.json");

type Json = Record<string, unknown>;

/** The shipped copy, parsed once. Never mutated: every use clones it first. */
const SHIPPED = JSON.parse(readFileSync(COPY, "utf8")) as Json;
const FIELDS = Object.keys(SHIPPED);
const LIMIT_KEYS = Object.keys(SHIPPED.limits as Json);
const COLOR_TOKEN_COUNT = (SHIPPED.color_tokens as string[]).length;
const PREFIX_COUNT = (SHIPPED.diagnostic_code_prefixes as string[]).length;
/** The prefix that belongs to the backend agent (Requirement 2.13). */
const AGENT = "AGENT";

const fresh = (): Json => structuredClone(SHIPPED);

// ---------------------------------------------------------------------------
// Oracle: the minimum of Requirement 2.11 / 2.12 / 2.13, written without Zod
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const isPositiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1;

/** True when `input` holds every field and satisfies the minimum checks. JSON input only. */
function meetsMinimum(input: unknown): boolean {
  if (!isRecord(input)) return false;
  if (FIELDS.some((field) => input[field] == null)) return false;
  if (!isPositiveInt(input.contract_version)) return false;

  const { canvas, duration, supported_runtime_contract_versions: supported } = input;
  if (!isRecord(canvas) || !(["width", "height", "fps"] as const).every((k) => isPositiveInt(canvas[k]))) {
    return false;
  }
  if (!isRecord(duration) || !isPositiveInt(duration.min) || !isPositiveInt(duration.max)) return false;
  if (duration.min > duration.max) return false;
  if (!Array.isArray(supported) || supported.length === 0) return false;
  if (!supported.includes(input.contract_version)) return false;

  const { color_tokens: tokens, diagnostic_code_prefixes: prefixes } = input;
  if (!Array.isArray(tokens) || tokens.length !== COLOR_TOKEN_COUNT) return false;
  if (!Array.isArray(prefixes) || prefixes.length !== PREFIX_COUNT || !prefixes.includes(AGENT)) return false;
  return true;
}

/** The two possible shapes of a result, and nothing else. */
function expectResultShape(result: unknown): void {
  expect(isRecord(result)).toBe(true);
  const record = result as Json;
  if (record.ok === true) {
    expect(Object.keys(record).sort()).toEqual(["contract", "ok"]);
    expect(isRecord(record.contract)).toBe(true);
  } else {
    expect(record.ok).toBe(false);
    expect(Object.keys(record).sort()).toEqual(["ok", "reason"]);
    expect(typeof record.reason).toBe("string");
    expect((record.reason as string).length).toBeGreaterThan(0);
  }
}

// ---------------------------------------------------------------------------
// Hostile values
// ---------------------------------------------------------------------------

/** A Proxy that throws on every operation a reader could use. */
function throwingProxy(): unknown {
  const boom = () => {
    throw new Error("boom");
  };
  return new Proxy(
    {},
    {
      get: boom,
      has: boom,
      ownKeys: boom,
      getOwnPropertyDescriptor: boom,
      getPrototypeOf: boom,
    },
  );
}

function revokedProxy(): unknown {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

/** The shipped contract with one field turned into a getter that throws. */
function throwingGetterAt(field: string): unknown {
  const copy = fresh();
  Object.defineProperty(copy, field, {
    enumerable: true,
    get() {
      throw new Error(`boom: ${field}`);
    },
  });
  return copy;
}

/** The shipped contract whose `canvas` is the contract itself. */
function cyclic(): unknown {
  const copy = fresh();
  copy.canvas = copy;
  copy.duration = copy;
  return copy;
}

/**
 * Hostile inputs are produced as factories, not as values: fast-check probes every generated
 * value itself (for a clone method), and a Proxy that throws on every access would fail inside
 * fast-check instead of inside `readContract`. The property calls the factory.
 */
const hostileArb: fc.Arbitrary<() => unknown> = fc.oneof(
  fc.constantFrom(throwingProxy, revokedProxy, cyclic),
  fc.constantFrom(...FIELDS).map((field) => () => throwingGetterAt(field)),
);

const anythingArb = fc.anything({
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

// ---------------------------------------------------------------------------
// 1. Totality on arbitrary input
// ---------------------------------------------------------------------------

describe("Property 1: readContract is total on arbitrary input", () => {
  it("answers ok or not-ok for any JSON value, leaves it alone, and answers the same twice", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const before = structuredClone(value);
        const result = readContract(value);
        expectResultShape(result);
        expect(readContract(value)).toEqual(result);
        expect(value).toEqual(before);
        if (result.ok) expect(meetsMinimum(value)).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });

  it("does not throw for any JavaScript value, including hostile objects", () => {
    const sourceArb = fc.oneof(
      anythingArb.map((value): (() => unknown) => () => value),
      hostileArb,
    );
    fc.assert(
      fc.property(sourceArb, (make) => {
        expectResultShape(readContract(make()));
      }),
      { numRuns: RUNS },
    );
  });

  it("rejects every JSON value that is not an object, with a reason", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.jsonValue().filter((v) => !isRecord(v)), fc.array(fc.jsonValue()), fc.string()),
        (value) => {
          const result = readContract(value);
          expectResultShape(result);
          expect(result.ok).toBe(false);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// 2. The shipped contract after random edits
// ---------------------------------------------------------------------------

type Mutation =
  | { op: "delete"; path: string[] }
  | { op: "set"; path: string[]; value: unknown }
  | { op: "push"; path: string[]; value: unknown }
  | { op: "pop"; path: string[] };

/** Every path that reaches a value through object keys only (arrays are leaves). */
function structuralPaths(node: unknown, prefix: string[] = []): string[][] {
  if (!isRecord(node)) return [];
  return Object.entries(node).flatMap(([key, child]) => [[...prefix, key], ...structuralPaths(child, [...prefix, key])]);
}

const PATHS = structuralPaths(SHIPPED);

/** Applies one edit to `root` in place. An edit that does not fit the shape is a no-op. */
function apply(root: Json, mutation: Mutation): void {
  const parent = mutation.path.slice(0, -1).reduce<unknown>((node, key) => (isRecord(node) ? node[key] : undefined), root);
  const key = mutation.path[mutation.path.length - 1];
  if (!isRecord(parent)) return;
  switch (mutation.op) {
    case "delete":
      delete parent[key];
      break;
    case "set":
      parent[key] = mutation.value;
      break;
    case "push":
      if (Array.isArray(parent[key])) (parent[key] as unknown[]).push(mutation.value);
      break;
    case "pop":
      if (Array.isArray(parent[key])) (parent[key] as unknown[]).pop();
      break;
  }
}

/** Values that are wrong in the ways a bad copy is wrong, next to fully random JSON. */
const editValueArb: fc.Arbitrary<unknown> = fc.oneof(
  { weight: 1, arbitrary: fc.jsonValue() },
  {
    weight: 2,
    // `map(structuredClone)` so that `[]` and `{}` are new objects on every run: edits push into them.
    arbitrary: fc
      .constantFrom<unknown>(0, -1, 1, 1.5, "1", "", null, true, [], {}, [1], [AGENT])
      .map((value) => structuredClone(value)),
  },
);

const pathArb = fc.constantFrom(...PATHS);
const mutationArb: fc.Arbitrary<Mutation> = fc.oneof(
  fc.record({ op: fc.constant("delete" as const), path: pathArb }),
  fc.record({ op: fc.constant("set" as const), path: pathArb, value: editValueArb }),
  fc.record({ op: fc.constant("push" as const), path: pathArb, value: editValueArb }),
  fc.record({ op: fc.constant("pop" as const), path: pathArb }),
);

describe("Property 1: readContract on the shipped contract after random edits", () => {
  it("never throws, and accepts only a contract that meets the minimum (Requirement 2.11)", () => {
    fc.assert(
      fc.property(fc.array(mutationArb, { minLength: 1, maxLength: 3 }), (mutations) => {
        const edited = fresh();
        for (const mutation of mutations) apply(edited, mutation);
        const before = structuredClone(edited);

        const result = readContract(edited);
        expectResultShape(result);
        expect(edited).toEqual(before);
        if (result.ok) {
          expect(meetsMinimum(edited)).toBe(true);
          expect(Object.keys(result.contract).every((key) => FIELDS.includes(key))).toBe(true);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("finds both outcomes among the edits, so the property is not vacuous", () => {
    const outcomes = new Set<boolean>();
    fc.assert(
      fc.property(fc.array(mutationArb, { minLength: 1, maxLength: 3 }), (mutations) => {
        const edited = fresh();
        for (const mutation of mutations) apply(edited, mutation);
        outcomes.add(readContract(edited).ok);
      }),
      { numRuns: RUNS },
    );
    expect([...outcomes].sort()).toEqual([false, true]);
  });
});

// ---------------------------------------------------------------------------
// 3. Random valid contracts are accepted
// ---------------------------------------------------------------------------

const positive = (max: number) => fc.integer({ min: 1, max });
const words = fc.array(fc.string({ maxLength: 12 }), { maxLength: 6 });
const unknownKeys = (taken: readonly string[]) =>
  fc.dictionary(
    fc.string({ maxLength: 10 }).filter((key) => !taken.includes(key)),
    fc.jsonValue(),
    { maxKeys: 4 },
  );

const validContractArb: fc.Arbitrary<{ expected: Json; input: Json }> = fc
  .record({
    version: positive(50),
    others: fc.uniqueArray(positive(50), { maxLength: 5 }),
    insertAt: fc.nat(),
    canvas: fc.record({ width: positive(100_000), height: positive(100_000), fps: positive(1000) }),
    durationMin: positive(1_000_000),
    durationSpan: fc.nat(1_000_000),
    limits: fc.record(Object.fromEntries(LIMIT_KEYS.map((key) => [key, positive(1_000_000_000)]))),
    pause: fc.record({
      lesson: fc.constantFrom("required", "forbidden"),
      puzzle: fc.constantFrom("required", "forbidden"),
    }),
    forbiddenLists: fc.record({ identifier: words, member: words, property: words, element: words }),
    colorTokens: fc.array(fc.string({ maxLength: 12 }), { minLength: COLOR_TOKEN_COUNT, maxLength: COLOR_TOKEN_COUNT }),
    prefixes: fc.array(fc.string({ maxLength: 12 }), { minLength: PREFIX_COUNT - 1, maxLength: PREFIX_COUNT - 1 }),
    agentAt: fc.nat(),
    rootExtras: unknownKeys(FIELDS),
    canvasExtras: unknownKeys(["width", "height", "fps"]),
  })
  .map((v) => {
    const expected = fresh();
    expected.contract_version = v.version;
    const supported = [...v.others];
    supported.splice(v.insertAt % (supported.length + 1), 0, v.version);
    expected.supported_runtime_contract_versions = supported;
    expected.canvas = v.canvas;
    expected.duration = { min: v.durationMin, max: v.durationMin + v.durationSpan };
    expected.limits = v.limits;
    expected.pause_rules = v.pause;
    expected.forbidden = { ...(expected.forbidden as Json), ...v.forbiddenLists };
    expected.color_tokens = v.colorTokens;
    const prefixes = [...v.prefixes];
    prefixes.splice(v.agentAt % (prefixes.length + 1), 0, AGENT);
    expected.diagnostic_code_prefixes = prefixes;

    const input: Json = { ...expected, ...v.rootExtras, canvas: { ...v.canvas, ...v.canvasExtras } };
    return { expected, input };
  });

describe("Property 1: readContract accepts every valid contract", () => {
  it("accepts it, drops unknown keys, and keeps every other value", () => {
    fc.assert(
      fc.property(validContractArb, ({ expected, input }) => {
        const before = structuredClone(input);
        const result = readContract(input);
        expectResultShape(result);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.contract).toEqual(expected);
        expect(input).toEqual(before);
      }),
      { numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Each minimum check rejects its violation
// ---------------------------------------------------------------------------

/** A JSON value that is not an integer >= 1. */
const notPositiveIntArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constantFrom<unknown>(0, -1, 0.5, 1.5),
  fc.integer({ max: 0 }),
  fc.double({ min: 1, max: 1e6, noNaN: true }).filter((n) => !Number.isInteger(n)),
  fc.string(),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.integer()),
  fc.dictionary(fc.string({ maxLength: 4 }), fc.integer(), { maxKeys: 2 }),
);

const POSITIVE_INT_PATHS: string[][] = [
  ["contract_version"],
  ["canvas", "width"],
  ["canvas", "height"],
  ["canvas", "fps"],
  ["duration", "min"],
  ["duration", "max"],
  ...LIMIT_KEYS.map((key) => ["limits", key]),
];

interface Violation {
  edit: (contract: Json) => void;
  /** Text the reason has to contain. */
  names: string;
}

/** One entry per check, so that each check gets its own 200 runs. */
const VIOLATIONS: ReadonlyArray<readonly [string, fc.Arbitrary<Violation>]> = [
  [
    "a positive integer field that is not one",
    fc
      .record({ path: fc.constantFrom(...POSITIVE_INT_PATHS), value: notPositiveIntArb })
      .map(({ path, value }) => ({
        edit: (c: Json) => apply(c, { op: "set", path, value }),
        names: path.join("."),
      })),
  ],
  [
    "duration.min greater than duration.max",
    fc.record({ max: positive(1_000_000), over: positive(1_000_000) }).map(({ max, over }) => ({
      edit: (c: Json) => {
        c.duration = { min: max + over, max };
      },
      names: "duration.min",
    })),
  ],
  [
    "supported versions without contract_version",
    fc.record({ version: positive(50), list: fc.array(positive(50), { maxLength: 5 }) }).map(({ version, list }) => ({
      edit: (c: Json) => {
        c.contract_version = version;
        c.supported_runtime_contract_versions = list.filter((n) => n !== version);
      },
      names: "supported_runtime_contract_versions",
    })),
  ],
  [
    "a wrong number of color tokens",
    fc
      .array(fc.string({ maxLength: 8 }), { maxLength: COLOR_TOKEN_COUNT + 6 })
      .filter((list) => list.length !== COLOR_TOKEN_COUNT)
      .map((list) => ({ edit: (c: Json) => void (c.color_tokens = list), names: "color_tokens" })),
  ],
  [
    "a wrong number of code prefixes",
    fc
      .array(fc.string({ maxLength: 8 }), { maxLength: PREFIX_COUNT + 6 })
      .filter((list) => list.length !== PREFIX_COUNT)
      .map((list) => ({
        edit: (c: Json) => void (c.diagnostic_code_prefixes = list),
        names: "diagnostic_code_prefixes",
      })),
  ],
  [
    "the right number of code prefixes without AGENT",
    fc
      .array(
        fc.string({ maxLength: 8 }).filter((s) => s !== AGENT),
        { minLength: PREFIX_COUNT, maxLength: PREFIX_COUNT },
      )
      .map((list) => ({ edit: (c: Json) => void (c.diagnostic_code_prefixes = list), names: AGENT })),
  ],
  [
    "a missing field",
    fc.constantFrom(...FIELDS).map((field) => ({
      edit: (c: Json) => void delete c[field],
      names: field,
    })),
  ],
];

describe("Property 1: readContract rejects each violation of the minimum", () => {
  it.each(VIOLATIONS)("rejects %s, and the reason names the field", (_name, arbitrary) => {
    fc.assert(
      fc.property(arbitrary, ({ edit, names }) => {
        const broken = fresh();
        edit(broken);
        const result = readContract(broken);
        expectResultShape(result);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toContain(names);
      }),
      { numRuns: RUNS },
    );
  });
});
