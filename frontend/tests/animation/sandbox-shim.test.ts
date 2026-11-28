/**
 * Tests: the `require` shim of the Sandbox_Runtime (task 26.3), design 7.8, Requirements 29.1 and
 * 2.7.
 *
 * The shim is the only way the evaluated bundle can reach anything. These tests check that, for
 * the real contract and the real bundled `react` and `remotion`:
 *
 *   1. each allowed module exposes exactly the names of `allowed_imports[module].values`: no
 *      more, no fewer, with the values of the bundled library (the same instances);
 *   2. the exposed objects are frozen and have no prototype (nothing to climb to `Function`);
 *   3. every other id throws: other packages, subpaths, node specifiers, prototype names,
 *      case and whitespace variants, and values that are not strings;
 *   4. the shim follows the contract it is given (a smaller or different list), and building it
 *      from an inconsistent contract or host fails with `{ ok: false }` and does not throw.
 */

import { describe, expect, it } from "vitest";
import * as React from "react";
import * as Remotion from "remotion";
import { CONTRACT } from "@/lib/animation/contract";
import { createRequireShim, type RequireShim } from "../../sandbox-runtime/shim";

function realShim(): RequireShim {
  const result = createRequireShim(CONTRACT);
  if (!result.ok) throw new Error(`shim could not be built: ${result.reason}`);
  return result.require;
}

const BUNDLED: Record<string, Record<string, unknown>> = { react: React, remotion: Remotion };

describe("require shim: exactly the allowed names", () => {
  it("the contract allows react and remotion, so the test below covers both", () => {
    expect(Object.keys(CONTRACT.allowed_imports).sort()).toEqual(["react", "remotion"]);
  });

  for (const [id, allowed] of Object.entries(CONTRACT.allowed_imports)) {
    it(`${id} exposes exactly allowed_imports.${id}.values`, () => {
      const exposed = realShim()(id) as Record<string, unknown>;
      expect(Object.keys(exposed).sort()).toEqual([...allowed.values].sort());
      expect(Object.getOwnPropertyNames(exposed).sort()).toEqual([...allowed.values].sort());
      expect(Object.getOwnPropertySymbols(exposed)).toEqual([]);
    });

    it(`${id}: every allowed name is the value of the bundled library`, () => {
      const exposed = realShim()(id) as Record<string, unknown>;
      for (const name of allowed.values) {
        expect(exposed[name]).toBeDefined();
        expect(exposed[name]).toBe(BUNDLED[id][name]);
      }
    });

    it(`${id}: a name outside the list is not there, even if the library has it`, () => {
      const exposed = realShim()(id) as Record<string, unknown>;
      const extra = Object.keys(BUNDLED[id]).find((name) => !allowed.values.includes(name));
      expect(extra).toBeDefined();
      expect(exposed[extra as string]).toBeUndefined();
      expect(extra as string in exposed).toBe(false);
    });
  }

  it("keeps useState and the other hooks out of react", () => {
    const react = realShim()("react") as Record<string, unknown>;
    expect(react.useState).toBeUndefined();
    expect(react.useEffect).toBeUndefined();
    expect(react.createElement).toBe(React.createElement);
  });

  it("keeps Player-side internals out of remotion", () => {
    const remotion = realShim()("remotion") as Record<string, unknown>;
    expect(remotion.Internals).toBeUndefined();
    expect(remotion.getRemotionEnvironment).toBeUndefined();
    expect(remotion.interpolate).toBe(Remotion.interpolate);
  });
});

describe("require shim: frozen and without a prototype", () => {
  it("returns frozen objects with a null prototype", () => {
    const require = realShim();
    for (const id of Object.keys(CONTRACT.allowed_imports)) {
      const exposed = require(id) as object;
      expect(Object.isFrozen(exposed)).toBe(true);
      expect(Object.getPrototypeOf(exposed)).toBeNull();
    }
  });

  it("cannot be changed, extended or have names deleted", () => {
    const react = realShim()("react") as Record<string, unknown>;
    expect(() => {
      react.createElement = () => null;
    }).toThrow(TypeError);
    expect(() => {
      react.extra = 1;
    }).toThrow(TypeError);
    expect(() => {
      delete react.createElement;
    }).toThrow(TypeError);
    expect(react.createElement).toBe(React.createElement);
  });

  it("has no inherited names to climb through", () => {
    const react = realShim()("react") as Record<string, unknown>;
    expect(react.constructor).toBeUndefined();
    expect(react.__proto__).toBeUndefined();
    expect(react.hasOwnProperty).toBeUndefined();
  });

  it("gives the same object on every call, and is itself frozen", () => {
    const require = realShim();
    expect(require("react")).toBe(require("react"));
    expect(require("remotion")).toBe(require("remotion"));
    expect(Object.isFrozen(require)).toBe(true);
  });

  it("does not change the contract it was built from", () => {
    const before = JSON.stringify(CONTRACT);
    realShim()("react");
    expect(JSON.stringify(CONTRACT)).toBe(before);
  });
});

describe("require shim: every other id throws", () => {
  const refused: Array<[string, unknown]> = [
    ["fs", "fs"],
    ["node:fs", "node:fs"],
    ["child_process", "child_process"],
    ["react/jsx-runtime", "react/jsx-runtime"],
    ["react/jsx-dev-runtime", "react/jsx-dev-runtime"],
    ["react-dom", "react-dom"],
    ["react-dom/client", "react-dom/client"],
    ["@remotion/player", "@remotion/player"],
    ["remotion/no-react", "remotion/no-react"],
    ["a relative path", "./main"],
    ["an absolute path", "/etc/passwd"],
    ["a url", "https://example.com/x.js"],
    ["the empty string", ""],
    ["upper case", "React"],
    ["a trailing space", "react "],
    ["a leading space", " remotion"],
    ["constructor", "constructor"],
    ["__proto__", "__proto__"],
    ["toString", "toString"],
    ["hasOwnProperty", "hasOwnProperty"],
    ["prototype", "prototype"],
    ["a number", 42],
    ["undefined", undefined],
    ["null", null],
    ["an object", { toString: () => "react" }],
    ["an array", ["react"]],
    ["a symbol", Symbol("react")],
  ];

  it.each(refused)("refuses %s", (_label, id) => {
    expect(() => realShim()(id)).toThrow(Error);
  });

  it("names the refused id in the message and cuts a very long one", () => {
    const require = realShim();
    expect(() => require("fs")).toThrow(/"fs"/);
    const long = "x".repeat(5000);
    try {
      require(long);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message.length).toBeLessThan(200);
    }
  });
});

describe("require shim: follows the contract it is given", () => {
  it("exposes only the names of a smaller list", () => {
    const result = createRequireShim({
      allowed_imports: {
        react: { values: ["createElement"] },
        remotion: { values: ["interpolate", "useCurrentFrame"] },
      },
    });
    if (!result.ok) throw new Error(result.reason);
    expect(Object.keys(result.require("react") as object)).toEqual(["createElement"]);
    expect(Object.keys(result.require("remotion") as object).sort()).toEqual([
      "interpolate",
      "useCurrentFrame",
    ]);
    expect((result.require("react") as Record<string, unknown>).Fragment).toBeUndefined();
  });

  it("refuses a module the contract does not list, even if the runtime bundles it", () => {
    const result = createRequireShim({ allowed_imports: { react: { values: ["createElement"] } } });
    if (!result.ok) throw new Error(result.reason);
    expect(() => result.require("remotion")).toThrow(Error);
  });

  it("an empty list gives an empty frozen object", () => {
    const result = createRequireShim({ allowed_imports: { react: { values: [] } } });
    if (!result.ok) throw new Error(result.reason);
    const exposed = result.require("react") as object;
    expect(Object.keys(exposed)).toEqual([]);
    expect(Object.isFrozen(exposed)).toBe(true);
  });

  it("uses the modules it is given instead of the bundled ones", () => {
    const fake = { hello: () => "hi" };
    const result = createRequireShim(
      { allowed_imports: { react: { values: ["hello"] } } },
      { react: fake },
    );
    if (!result.ok) throw new Error(result.reason);
    expect((result.require("react") as typeof fake).hello).toBe(fake.hello);
  });

  it("takes values once: later changes to the host do not show through", () => {
    const host: Record<string, unknown> = { hello: 1 };
    const result = createRequireShim({ allowed_imports: { react: { values: ["hello"] } } }, { react: host });
    if (!result.ok) throw new Error(result.reason);
    host.hello = 2;
    expect((result.require("react") as Record<string, unknown>).hello).toBe(1);
  });
});

describe("require shim: building it never throws", () => {
  it("fails when the contract allows a module the runtime does not bundle", () => {
    const result = createRequireShim({
      allowed_imports: { react: { values: ["createElement"] }, lodash: { values: ["map"] } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("lodash");
  });

  it("fails when the contract allows a name the library does not have", () => {
    const result = createRequireShim({
      allowed_imports: { react: { values: ["createElement", "noSuchName"] } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("noSuchName");
  });

  it("fails when a listed name has the value undefined", () => {
    const result = createRequireShim(
      { allowed_imports: { react: { values: ["gone"] } } },
      { react: { gone: undefined } },
    );
    expect(result.ok).toBe(false);
  });

  it("does not take a module name from the host's prototype", () => {
    const host = Object.create({ react: { createElement: 1 } }) as Record<string, Record<string, unknown>>;
    const result = createRequireShim({ allowed_imports: { react: { values: ["createElement"] } } }, host);
    expect(result.ok).toBe(false);
  });

  it("succeeds with no modules at all, and then refuses everything", () => {
    const result = createRequireShim({ allowed_imports: {} });
    if (!result.ok) throw new Error(result.reason);
    expect(() => result.require("react")).toThrow(Error);
  });
});
