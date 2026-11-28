/**
 * Tests: evaluating an animation bundle (task 26.3), design 7.8 "Evaluasi bundle",
 * Requirements 29.1 and 29.2.
 *
 * `evaluateBundle` is the step between the `load` message and the Player: it must refuse a
 * contract or version the runtime cannot honour without ever running the bundle, run the bundle
 * through the `require` shim, and accept only an export that fits the contract and equals the
 * `meta` the parent announced. Each refusal has its own code. The bundles here are written the way
 * the verifier's esbuild produces them (`module.exports = __toCommonJS(...)`, getters, and
 * `(0, import_react.createElement)` calls).
 *
 *   1. a valid lesson and puzzle are accepted, with their `meta` and `Main`;
 *   2. the contract copy is invalid / the version is unsupported: no evaluation at all;
 *   3. evaluation throws: syntax error, `throw`, a refused `require`, a throwing getter;
 *   4. `meta` is wrong against the contract (canvas, fps, duration, pause point) or against
 *      `load.meta`;
 *   5. the default export is missing or not a function;
 *   6. the shim is the one the bundle sees, and `this` is not the window;
 *   7. any input gives a result and never throws.
 */

import { afterEach, describe, expect, it } from "vitest";
import { CONTRACT, readContract, type ReadContractResult } from "@/lib/animation/contract";
import type { LoadMeta } from "@/lib/animation/protocol";
import { evaluateBundle, type LoadRequest } from "../../sandbox-runtime/evaluate";
import { cjsBundle } from "../fixtures/sandbox-bundles";

const VALID_CONTRACT: ReadContractResult = { ok: true, contract: CONTRACT };

const LESSON_META = { width: 1280, height: 720, fps: 30, durationInFrames: 120 };
const PUZZLE_META = { ...LESSON_META, pauseAtFrame: 60 };

/** The `load.meta` that matches a Main_File `meta`. */
function loadMetaOf(meta: Record<string, unknown>): LoadMeta {
  const loadMeta: Record<string, unknown> = {
    width: meta.width,
    height: meta.height,
    fps: meta.fps,
    duration_in_frames: meta.durationInFrames,
  };
  if (meta.pauseAtFrame !== undefined) loadMeta.pause_at_frame = meta.pauseAtFrame;
  return loadMeta as unknown as LoadMeta;
}

/** A bundle in esbuild's shape that exports `meta` and a `Main` function. */
function bundleOf(meta: unknown, extra = "", main = "function Main() { return null; }"): string {
  return cjsBundle(meta, { extra, main });
}

function request(bundle: string, meta: Record<string, unknown> = LESSON_META, version = 1): LoadRequest {
  return { bundle, meta: loadMetaOf(meta), contractVersion: version };
}

const lessonRequest = () => request(bundleOf(LESSON_META));

/** The contract with `supported_runtime_contract_versions` replaced. */
function contractSupporting(versions: number[]): ReadContractResult {
  return readContract({ ...CONTRACT, supported_runtime_contract_versions: versions });
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__evaluated;
});

describe("evaluateBundle: a valid bundle", () => {
  it("accepts a lesson and returns its meta and Main", () => {
    const result = evaluateBundle(lessonRequest(), VALID_CONTRACT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meta).toEqual(LESSON_META);
    expect("pauseAtFrame" in result.meta).toBe(false);
    expect(typeof result.Main).toBe("function");
    expect(result.Main.name).toBe("Main");
  });

  it("accepts a puzzle and keeps its pause point", () => {
    const result = evaluateBundle(request(bundleOf(PUZZLE_META), PUZZLE_META), VALID_CONTRACT);
    expect(result).toMatchObject({ ok: true, meta: PUZZLE_META });
  });

  it.each([
    ["the shortest", 30],
    ["the longest", 900],
  ])("accepts %s allowed duration", (_label, durationInFrames) => {
    const meta = { ...LESSON_META, durationInFrames };
    expect(evaluateBundle(request(bundleOf(meta), meta), VALID_CONTRACT).ok).toBe(true);
  });

  it.each([
    ["the first frame after 0", 1],
    ["the last frame", 119],
  ])("accepts a pause point on %s", (_label, pauseAtFrame) => {
    const meta = { ...LESSON_META, pauseAtFrame };
    expect(evaluateBundle(request(bundleOf(meta), meta), VALID_CONTRACT).ok).toBe(true);
  });

  it("reads the exports after the bundle replaces module.exports", () => {
    const bundle = `module.exports = { meta: ${JSON.stringify(LESSON_META)}, default: function Main() { return null; } };`;
    expect(evaluateBundle(request(bundle), VALID_CONTRACT).ok).toBe(true);
  });

  it("accepts a bundle that adds extra exports", () => {
    const bundle = bundleOf(LESSON_META, "", "function Main() { return null; }\nmodule.exports.extra = 1;");
    expect(evaluateBundle(request(bundle), VALID_CONTRACT).ok).toBe(true);
  });

  it("gives the bundle the shim: allowed names work, a hidden one is not there", () => {
    const extra = `
      if (typeof (0, import_react.createElement) !== "function") throw new Error("createElement missing");
      if (typeof import_remotion.interpolate !== "function") throw new Error("interpolate missing");
      if (import_react.useState !== undefined) throw new Error("useState leaked");
      if (import_remotion.Internals !== undefined) throw new Error("Internals leaked");`;
    expect(evaluateBundle(request(bundleOf(LESSON_META, extra)), VALID_CONTRACT).ok).toBe(true);
  });

  it("runs the bundle with `this` set to its `exports`, not the window", () => {
    const extra = `if (this !== exports) throw new Error("this is not exports");
      if (this === globalThis) throw new Error("this is the global object");`;
    expect(evaluateBundle(request(bundleOf(LESSON_META, extra)), VALID_CONTRACT).ok).toBe(true);
  });
});

describe("evaluateBundle: a contract or version it cannot honour", () => {
  it("refuses a contract copy that failed validation, without running the bundle", () => {
    const extra = `globalThis.__evaluated = true;`;
    const result = evaluateBundle(
      request(bundleOf(LESSON_META, extra)),
      { ok: false, reason: "(root): broken" },
    );
    expect(result).toEqual({ ok: false, code: "CONTRACT_INVALID" });
    expect((globalThis as Record<string, unknown>).__evaluated).toBeUndefined();
  });

  it.each([
    ["a later version", 2],
    ["version 0", 0],
    ["a negative version", -1],
    ["a fractional version", 1.5],
  ])("refuses %s without running the bundle", (_label, version) => {
    const extra = `globalThis.__evaluated = true;`;
    const result = evaluateBundle(request(bundleOf(LESSON_META, extra), LESSON_META, version), VALID_CONTRACT);
    expect(result).toEqual({ ok: false, code: "CONTRACT_UNSUPPORTED" });
    expect((globalThis as Record<string, unknown>).__evaluated).toBeUndefined();
  });

  it("reads the supported versions from the contract, not from a constant", () => {
    const supportsOneAndTwo = contractSupporting([1, 2]);
    expect(evaluateBundle(request(bundleOf(LESSON_META), LESSON_META, 2), supportsOneAndTwo).ok).toBe(true);
    expect(evaluateBundle(request(bundleOf(LESSON_META), LESSON_META, 3), supportsOneAndTwo)).toEqual({
      ok: false,
      code: "CONTRACT_UNSUPPORTED",
    });
  });

  it("fails as CONTRACT_INVALID when the contract names a module the runtime does not bundle", () => {
    const read = readContract({
      ...CONTRACT,
      allowed_imports: { ...CONTRACT.allowed_imports, lodash: { values: ["map"], types: [] } },
    });
    expect(evaluateBundle(lessonRequest(), read)).toEqual({ ok: false, code: "CONTRACT_INVALID" });
  });
});

describe("evaluateBundle: evaluation throws", () => {
  const cases: Array<[string, string]> = [
    ["a syntax error", "var = ;"],
    ["a throw at top level", `throw new Error("boom");`],
    ["a throw of a non-error", `throw 7;`],
    ["a require of fs", `require("fs");`],
    ["a require of a subpath", `require("react/jsx-runtime");`],
    ["a require of the player", `require("@remotion/player");`],
    ["a reference error", `notDefinedAnywhere.x;`],
    ["a call that is not a function", `(void 0)();`],
    ["an assignment to a frozen shim", `require("react").createElement = 1;`],
  ];

  it.each(cases)("%s is EVAL_THROW", (_label, body) => {
    const bundle = `${bundleOf(LESSON_META)}\n${body}`;
    expect(evaluateBundle(request(bundle), VALID_CONTRACT)).toEqual({ ok: false, code: "EVAL_THROW" });
  });

  it("a throwing getter on the exports is EVAL_THROW", () => {
    const bundle = `Object.defineProperty(exports, "meta", { get() { throw new Error("getter"); } });
      Object.defineProperty(exports, "default", { get() { return function Main() { return null; }; } });`;
    expect(evaluateBundle(request(bundle), VALID_CONTRACT)).toEqual({ ok: false, code: "EVAL_THROW" });
  });

  it("a throwing getter on a meta value is EVAL_THROW", () => {
    const bundle = `exports.meta = { get width() { throw new Error("w"); }, height: 720, fps: 30, durationInFrames: 120 };
      exports.default = function Main() { return null; };`;
    expect(evaluateBundle(request(bundle), VALID_CONTRACT)).toEqual({ ok: false, code: "EVAL_THROW" });
  });

  it("an empty bundle has no meta", () => {
    expect(evaluateBundle(request(""), VALID_CONTRACT)).toEqual({ ok: false, code: "META_INVALID" });
  });
});

describe("evaluateBundle: meta against the contract", () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ["a wider canvas", { ...LESSON_META, width: 1920 }],
    ["a taller canvas", { ...LESSON_META, height: 1080 }],
    ["another fps", { ...LESSON_META, fps: 60 }],
    ["a duration under the minimum", { ...LESSON_META, durationInFrames: 29 }],
    ["a duration over the maximum", { ...LESSON_META, durationInFrames: 901 }],
    ["a fractional duration", { ...LESSON_META, durationInFrames: 120.5 }],
    ["a string duration", { ...LESSON_META, durationInFrames: "120" }],
    ["a missing duration", { width: 1280, height: 720, fps: 30 }],
    ["a pause point of 0", { ...LESSON_META, pauseAtFrame: 0 }],
    ["a pause point on the frame after the last", { ...LESSON_META, pauseAtFrame: 120 }],
    ["a negative pause point", { ...LESSON_META, pauseAtFrame: -5 }],
    ["a fractional pause point", { ...LESSON_META, pauseAtFrame: 10.5 }],
    ["a null pause point", { ...LESSON_META, pauseAtFrame: null }],
    ["a string pause point", { ...LESSON_META, pauseAtFrame: "60" }],
  ];

  it.each(bad)("%s is META_INVALID", (_label, meta) => {
    // `load.meta` mirrors the bad value where the protocol schema would allow it, so this
    // checks the contract rules and not the comparison with `load.meta`.
    const result = evaluateBundle(
      { bundle: bundleOf(meta), meta: loadMetaOf(meta), contractVersion: 1 },
      VALID_CONTRACT,
    );
    expect(result).toEqual({ ok: false, code: "META_INVALID" });
  });

  it.each([
    ["null", "null"],
    ["a number", "5"],
    ["a string", `"meta"`],
    ["an array", "[]"],
    ["undefined", "undefined"],
  ])("a meta that is %s is META_INVALID", (_label, literal) => {
    const bundle = `exports.meta = ${literal}; exports.default = function Main() { return null; };`;
    expect(evaluateBundle(request(bundle), VALID_CONTRACT)).toEqual({ ok: false, code: "META_INVALID" });
  });

  it("a bundle with no meta export is META_INVALID", () => {
    const bundle = `exports.default = function Main() { return null; };`;
    expect(evaluateBundle(request(bundle), VALID_CONTRACT)).toEqual({ ok: false, code: "META_INVALID" });
  });

  it("takes the canvas from the contract, not from constants", () => {
    const wide = readContract({ ...CONTRACT, canvas: { width: 1920, height: 1080, fps: 60 } });
    const meta = { width: 1920, height: 1080, fps: 60, durationInFrames: 120 };
    expect(evaluateBundle(request(bundleOf(meta), meta), wide).ok).toBe(true);
    expect(evaluateBundle(lessonRequest(), wide)).toEqual({ ok: false, code: "META_INVALID" });
  });

  it("takes the duration range from the contract, not from constants", () => {
    const narrow = readContract({ ...CONTRACT, duration: { min: 60, max: 100 } });
    for (const durationInFrames of [59, 101]) {
      const meta = { ...LESSON_META, durationInFrames };
      expect(evaluateBundle(request(bundleOf(meta), meta), narrow)).toEqual({ ok: false, code: "META_INVALID" });
    }
    const meta = { ...LESSON_META, durationInFrames: 100 };
    expect(evaluateBundle(request(bundleOf(meta), meta), narrow).ok).toBe(true);
  });
});

describe("evaluateBundle: meta against load.meta", () => {
  const mismatches: Array<[string, LoadMeta]> = [
    ["another duration", { ...loadMetaOf(LESSON_META), duration_in_frames: 121 }],
    ["another width", { ...loadMetaOf(LESSON_META), width: 1281 }],
    ["another height", { ...loadMetaOf(LESSON_META), height: 721 }],
    ["another fps", { ...loadMetaOf(LESSON_META), fps: 31 }],
    ["a pause point the bundle does not have", { ...loadMetaOf(LESSON_META), pause_at_frame: 60 }],
  ];

  it.each(mismatches)("load.meta with %s is META_INVALID", (_label, meta) => {
    const result = evaluateBundle(
      { bundle: bundleOf(LESSON_META), meta, contractVersion: 1 },
      VALID_CONTRACT,
    );
    expect(result).toEqual({ ok: false, code: "META_INVALID" });
  });

  it("a pause point in the bundle that load.meta lacks is META_INVALID", () => {
    const result = evaluateBundle(
      { bundle: bundleOf(PUZZLE_META), meta: loadMetaOf(LESSON_META), contractVersion: 1 },
      VALID_CONTRACT,
    );
    expect(result).toEqual({ ok: false, code: "META_INVALID" });
  });

  it("a pause point that differs is META_INVALID", () => {
    const result = evaluateBundle(
      { bundle: bundleOf(PUZZLE_META), meta: { ...loadMetaOf(PUZZLE_META), pause_at_frame: 61 }, contractVersion: 1 },
      VALID_CONTRACT,
    );
    expect(result).toEqual({ ok: false, code: "META_INVALID" });
  });
});

describe("evaluateBundle: the default export", () => {
  const noMain = (value: string) =>
    `exports.meta = ${JSON.stringify(LESSON_META)}; exports.default = ${value};`;

  it.each([
    ["an object", "{}"],
    ["a string", `"Main"`],
    ["a number", "1"],
    ["null", "null"],
    ["undefined", "undefined"],
    ["an array", "[function () {}]"],
  ])("%s is EXPORT_INVALID", (_label, value) => {
    expect(evaluateBundle(request(noMain(value)), VALID_CONTRACT)).toEqual({
      ok: false,
      code: "EXPORT_INVALID",
    });
  });

  it("a bundle with no default export is EXPORT_INVALID", () => {
    const bundle = `exports.meta = ${JSON.stringify(LESSON_META)};`;
    expect(evaluateBundle(request(bundle), VALID_CONTRACT)).toEqual({ ok: false, code: "EXPORT_INVALID" });
  });

  it("an arrow function and a class are functions, so they pass", () => {
    expect(evaluateBundle(request(noMain("() => null")), VALID_CONTRACT).ok).toBe(true);
    expect(evaluateBundle(request(noMain("class Main {}")), VALID_CONTRACT).ok).toBe(true);
  });

  it("a bad meta is reported before a bad default export", () => {
    const bundle = `exports.meta = null; exports.default = 1;`;
    expect(evaluateBundle(request(bundle), VALID_CONTRACT)).toEqual({ ok: false, code: "META_INVALID" });
  });
});

describe("evaluateBundle: always a result", () => {
  it("returns a result and does not throw for hostile exports", () => {
    const hostile = [
      `module.exports = null;`,
      `module.exports = undefined;`,
      `module.exports = 5;`,
      `module.exports = new Proxy({}, { get() { throw new Error("trap"); } });`,
      `module.exports = Object.create(null);`,
      `exports.meta = new Proxy({}, { get() { throw new Error("trap"); } }); exports.default = function Main() {};`,
    ];
    for (const bundle of hostile) {
      const result = evaluateBundle(request(bundle), VALID_CONTRACT);
      expect(result.ok).toBe(false);
    }
  });
});
