/**
 * Hand-written animation bundles for the Sandbox_Runtime tests (tasks 26.3 and later).
 *
 * The verifier hands the frontend a CommonJS bundle made by esbuild: a few helper functions,
 * `module.exports = __toCommonJS(...)` with getters for `default` and `meta`, and calls of the form
 * `(0, import_react.createElement)(...)`. `cjsBundle` writes a bundle in exactly that shape around
 * a `meta` and a body chosen by the test, so the runtime tests exercise the same module format
 * they get in production without running esbuild.
 *
 * `mainBody` and the helpers below build the `Main` function bodies the tests need: a component
 * that shows the current frame, and ones that throw at a chosen frame.
 */

/** esbuild's CommonJS helpers, copied from a verified bundle. */
export const CJS_HELPERS = `"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
`;

/** A `Main` that draws the current frame as text; it counts its renders in `globalThis`. */
export const FRAME_TEXT_MAIN = `function Main() {
  const frame = (0, import_remotion.useCurrentFrame)();
  globalThis.__mainRenders = (globalThis.__mainRenders || 0) + 1;
  return (0, import_react.createElement)("div", { "data-testid": "main", "data-frame": frame }, "frame " + frame);
}`;

/** A `Main` that throws once the frame reaches `frame` (0 throws on the very first render). */
export function throwingMain(frame: number): string {
  return `function Main() {
  const frame = (0, import_remotion.useCurrentFrame)();
  if (frame >= ${frame}) throw new Error("Main failed at frame " + frame);
  return (0, import_react.createElement)("div", null, "frame " + frame);
}`;
}

export interface CjsBundleOptions {
  /** Extra statements that run after the module is set up and before `Main` is defined. */
  extra?: string;
  /** The source of the `Main` function (a `function Main() {...}` declaration). */
  main?: string;
}

/**
 * A bundle in esbuild's CommonJS shape that exports `meta` (written as JSON) and a `Main`
 * function. `main` defaults to `FRAME_TEXT_MAIN`.
 */
export function cjsBundle(meta: unknown, options: CjsBundleOptions = {}): string {
  return `${CJS_HELPERS}
var main_exports = {};
__export(main_exports, { default: () => Main, meta: () => meta });
module.exports = __toCommonJS(main_exports);
var import_react = require("react");
var import_remotion = require("remotion");
var meta = ${JSON.stringify(meta)};
${options.extra ?? ""}
${options.main ?? FRAME_TEXT_MAIN}
`;
}
