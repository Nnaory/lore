/**
 * The `require` shim of the Sandbox_Runtime (design 7.8, Requirement 29.1 and 2.7).
 *
 * The bundle of an animation is a CommonJS module that asks for its two libraries with
 * `require("react")` and `require("remotion")`. The runtime evaluates it with
 * `new Function("require", "module", "exports", bundle)`, so the `require` it passes is the only
 * way that code can reach anything outside itself. This shim makes that door narrow: for `react`
 * and `remotion` it returns a frozen object that holds only the names the Animation_Contract
 * allows (`allowed_imports[module].values`), and for every other id (`fs`, a subpath such as
 * `react/jsx-runtime`, `@remotion/player`, a prototype name such as `constructor`, or a value that
 * is not a string) it throws.
 *
 * The values come from the copies of `react` and `remotion` that this runtime bundles, which are
 * the same instances `@remotion/player` uses (Requirement 3.13). The exposed objects have no
 * prototype, so `require("react").constructor` is `undefined` rather than a way to `Function`.
 * `animation-verifier/src/shim.ts` does the same inside the verifier's `vm` context, so a bundle
 * that passes verification sees the same surface here.
 *
 * Building the shim does not throw: when the contract names a module the runtime does not bundle,
 * or a name the bundled module does not have (the contract and the installed package versions
 * disagree), the result is `{ ok: false }`, so that mistake is reported as a broken build and not
 * mistaken for an error in the author's code. Only the `require` function it returns throws,
 * because that is the `require` contract bundles expect.
 *
 * The allowed names are read from the contract, never written here (Requirement 2.6). `host` lets
 * the tests pass other modules; the runtime itself uses the bundled `react` and `remotion`.
 */

import * as React from "react";
import * as Remotion from "remotion";

/** The part of the Animation_Contract the shim reads; the full `Contract` fits this shape. */
export interface ShimSpec {
  readonly allowed_imports: Readonly<Record<string, { readonly values: readonly string[] }>>;
}

/** Modules the runtime can hand out, by id, with the names each one has. */
export type HostModules = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/** The function passed as `require` to the bundle. */
export type RequireShim = (id: unknown) => unknown;

export type CreateShimResult = { ok: true; require: RequireShim } | { ok: false; reason: string };

/** The two libraries this runtime bundles. */
export const BUNDLED_MODULES: HostModules = { react: React, remotion: Remotion };

/** Longest part of a module id copied into an error message, so the message stays short. */
const MAX_ID_CHARS = 60;

function describeId(id: unknown): string {
  return typeof id === "string" ? JSON.stringify(id.slice(0, MAX_ID_CHARS)) : `of type ${typeof id}`;
}

/**
 * Builds the `require` for `spec.allowed_imports`, taking values from `host`. Each allowed module
 * is exposed as one frozen object (the same object on every call) with only its allowed names.
 */
export function createRequireShim(
  spec: ShimSpec,
  host: HostModules = BUNDLED_MODULES,
): CreateShimResult {
  const table = new Map<string, Readonly<Record<string, unknown>>>();

  for (const [id, allowed] of Object.entries(spec.allowed_imports)) {
    const source = Object.hasOwn(host, id) ? host[id] : undefined;
    if (source === undefined) {
      return { ok: false, reason: `module ${JSON.stringify(id)} is not bundled in the runtime` };
    }
    const exposed: Record<string, unknown> = Object.create(null);
    for (const name of allowed.values) {
      const value = source[name];
      if (value === undefined) {
        return { ok: false, reason: `module ${JSON.stringify(id)} has no export ${JSON.stringify(name)}` };
      }
      exposed[name] = value;
    }
    table.set(id, Object.freeze(exposed));
  }

  const shimRequire: RequireShim = (id) => {
    const found = typeof id === "string" ? table.get(id) : undefined;
    if (found === undefined) throw new Error(`module ${describeId(id)} is not available`);
    return found;
  };
  return { ok: true, require: Object.freeze(shimRequire) };
}
