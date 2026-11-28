/**
 * Evaluating the bundle of an animation (design 7.8 "Evaluasi bundle", Requirement 29.1, 29.2).
 *
 * `main.tsx` receives a `load` message with the bundle (CommonJS text from the verifier), the
 * `meta` the parent expects and a `contract_version`. Before anything is mounted this module
 * decides, in this order, whether the bundle may run and what it exports:
 *
 * 1. the contract copy that ships with the runtime must be valid (`CONTRACT_INVALID`, Req 2.10);
 * 2. `contract_version` must be one of `supported_runtime_contract_versions`
 *    (`CONTRACT_UNSUPPORTED`). A contract or version that is refused stops here, so the bundle is
 *    never evaluated (Req 2.15);
 * 3. the `require` shim must be buildable from the contract (`CONTRACT_INVALID` too: the contract
 *    and the bundled libraries disagree);
 * 4. the bundle is evaluated with `new Function("require", "module", "exports", bundle)`; any
 *    exception, including a `SyntaxError` and a `require` of a module that is not allowed, is
 *    `EVAL_THROW`;
 * 5. the exported `meta` must match the contract (canvas size and fps; `durationInFrames` an
 *    integer in the allowed range; `pauseAtFrame` absent or an integer from 1 to
 *    `durationInFrames - 1`) and be the same as `load.meta` (`META_INVALID`);
 * 6. the default export must be a function (`EXPORT_INVALID`).
 *
 * The shim, the checks and the limits all read the contract (Requirement 2.6); no number or name
 * of the contract is written here. `evaluateBundle` is total: it returns `{ ok: true }` or
 * `{ ok: false, code }` for any input and never throws. All the codes belong to phase `load`
 * (see `RUNTIME_ERROR_PHASE` in `page.ts`).
 *
 * The bundle runs with `this` set to `module.exports`, as in a CommonJS module, so a stray `this`
 * in it does not reach the window. It runs once; there is no way to evaluate it again.
 *
 * No React, DOM or Next imports (the one `react` import is a type).
 */

import type { FunctionComponent } from "react";
import type { Contract, ReadContractResult } from "@/lib/animation/contract";
import type { LoadMeta } from "@/lib/animation/protocol";
import type { RuntimeMeta } from "./controller";
import type { RuntimeErrorCode } from "./page";
import { createRequireShim, type HostModules } from "./shim";

/** What the parent sent in `load`, without the envelope. */
export interface LoadRequest {
  bundle: string;
  meta: LoadMeta;
  contractVersion: number;
}

/** The validated `meta` of the animation: the canvas, the length and the pause point. */
export interface AnimationMeta extends RuntimeMeta {
  width: number;
  height: number;
  fps: number;
}

/** The failures of this step. */
export type EvaluateErrorCode = Extract<
  RuntimeErrorCode,
  "CONTRACT_INVALID" | "CONTRACT_UNSUPPORTED" | "EVAL_THROW" | "META_INVALID" | "EXPORT_INVALID"
>;

export type EvaluateResult =
  | { ok: true; meta: AnimationMeta; Main: FunctionComponent }
  | { ok: false; code: EvaluateErrorCode };

const isInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value);

/**
 * `raw` as an `AnimationMeta` when it satisfies the contract and equals `load`; otherwise `null`.
 * Reading a property can run a getter that throws; the caller catches that.
 */
function readMeta(raw: unknown, contract: Contract, load: LoadMeta): AnimationMeta | null {
  if (typeof raw !== "object" || raw === null) return null;
  const meta = raw as Record<string, unknown>;
  const { width, height, fps, durationInFrames, pauseAtFrame } = meta;
  const { canvas, duration } = contract;

  if (width !== canvas.width || height !== canvas.height || fps !== canvas.fps) return null;
  if (!isInteger(durationInFrames)) return null;
  if (durationInFrames < duration.min || durationInFrames > duration.max) return null;
  if (pauseAtFrame !== undefined) {
    if (!isInteger(pauseAtFrame) || pauseAtFrame < 1 || pauseAtFrame > durationInFrames - 1) {
      return null;
    }
  }

  const sameAsLoad =
    load.width === width &&
    load.height === height &&
    load.fps === fps &&
    load.duration_in_frames === durationInFrames &&
    load.pause_at_frame === pauseAtFrame;
  if (!sameAsLoad) return null;

  return pauseAtFrame === undefined
    ? { width, height, fps, durationInFrames }
    : { width, height, fps, durationInFrames, pauseAtFrame };
}

/**
 * Checks the contract and the request, evaluates the bundle and validates what it exports.
 * `host` replaces the bundled `react` and `remotion` (tests only).
 */
export function evaluateBundle(
  request: LoadRequest,
  contractRead: ReadContractResult,
  host?: HostModules,
): EvaluateResult {
  if (!contractRead.ok) return { ok: false, code: "CONTRACT_INVALID" };
  const { contract } = contractRead;
  if (!contract.supported_runtime_contract_versions.includes(request.contractVersion)) {
    return { ok: false, code: "CONTRACT_UNSUPPORTED" };
  }

  const shim = createRequireShim(contract, host);
  if (!shim.ok) return { ok: false, code: "CONTRACT_INVALID" };

  let meta: unknown;
  let main: unknown;
  try {
    const cjsModule: { exports: unknown } = { exports: {} };
    const run = new Function("require", "module", "exports", request.bundle);
    run.call(cjsModule.exports, shim.require, cjsModule, cjsModule.exports);
    const exported = cjsModule.exports as Record<string, unknown> | null | undefined;
    meta = exported?.meta;
    main = exported?.default;
  } catch {
    return { ok: false, code: "EVAL_THROW" };
  }

  let validated: AnimationMeta | null;
  try {
    validated = readMeta(meta, contract, request.meta);
  } catch {
    return { ok: false, code: "EVAL_THROW" };
  }
  if (validated === null) return { ok: false, code: "META_INVALID" };
  if (typeof main !== "function") return { ok: false, code: "EXPORT_INVALID" };
  return { ok: true, meta: validated, Main: main as FunctionComponent };
}
