/**
 * Types and constants of the Sandbox_Runtime page (design 7.8, Requirement 29).
 *
 * The runtime is the script that runs inside the sandboxed iframe. This file holds the few values
 * that the pieces of the runtime share, so each one has a single definition: the timings that
 * Requirement 28 fixes, the element the Player is mounted in, and the error codes the runtime
 * answers with. Contract numbers (canvas size, duration range, allowed imports) are not repeated
 * here; they are read from `CONTRACT` (Requirement 2.6).
 *
 * `OPAQUE_ORIGIN` repeats the literal `"null"` that `lib/animation/sandbox-controller.ts` also
 * defines, on purpose: that file is the parent side of the protocol and would pull the parent's
 * controller into the iframe bundle. Both are the `origin` of a document in an iframe sandboxed
 * without `allow-same-origin`.
 *
 * Bundled by esbuild into `public/sandbox/runtime.js` (task 26.4). No React, DOM or Next imports
 * and no runtime imports at all: `controller.ts` imports this file.
 */

/** `window.origin` of a document in an iframe sandboxed without `allow-same-origin` (Req 27.15). */
export const OPAQUE_ORIGIN = "null";

/** `id` of the page element the Player is mounted in (`<div id="root">` of `runtime.html`). */
export const ROOT_ELEMENT_ID = "root";

/** Time between two `heartbeat` messages, from `ready` on (Requirement 28.8). */
export const HEARTBEAT_INTERVAL_MS = 1000;

/** Least time between two periodic `frame` messages during playback (Requirement 28.6). */
export const FRAME_MIN_INTERVAL_MS = 100;

/** Which side of the handshake an `error` belongs to (Requirement 28.1). */
export type RuntimeErrorPhase = "load" | "runtime";

/**
 * Codes of the `error` messages the runtime sends. Every one matches `/^[A-Z0-9_]{1,64}$/`
 * (Requirement 28.11). The first five end the load; the rest can happen once the animation runs.
 */
export const RUNTIME_ERROR_PHASE = {
  /**
   * The contract copy that ships with the runtime failed `readContract`, or the `require` shim
   * cannot be built from it (the contract and the bundled libraries disagree) (Req 2.10, 2.15).
   */
  CONTRACT_INVALID: "load",
  /** `load.contract_version` is not in `supported_runtime_contract_versions` (Req 29.1). */
  CONTRACT_UNSUPPORTED: "load",
  /** The exported `meta` is not valid or differs from `load.meta` (Req 29.2). */
  META_INVALID: "load",
  /** The module has no default export that is a function (Req 29.2). */
  EXPORT_INVALID: "load",
  /** Evaluating the bundle threw (Req 29.2). */
  EVAL_THROW: "load",
  /** Rendering threw inside the error boundary (Req 29.4). */
  RENDER_THROW: "runtime",
  /** `window.onerror` fired (Req 29.4). */
  UNCAUGHT_ERROR: "runtime",
  /** `unhandledrejection` fired (Req 29.4). */
  UNHANDLED_REJECTION: "runtime",
  /** The runtime's own logic threw; reported so the exception does not escape (Req 29.13). */
  RUNTIME_INTERNAL: "runtime",
} as const satisfies Record<string, RuntimeErrorPhase>;

export type RuntimeErrorCode = keyof typeof RUNTIME_ERROR_PHASE;
