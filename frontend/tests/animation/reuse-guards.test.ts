/**
 * Tests — reuse guards of the animation feature (design 15, Requirements 39.7, 39.9, 39.14, 32.7)
 *
 * The feature must extend the Stage, not copy it. These tests read the source of `frontend/` as
 * a syntax tree and fail when something the design says is built once is built twice:
 *
 *   1. a value import of `@remotion/player` (not `import type`) is allowed only in
 *      `src/components/stage/StageCanvas.tsx` and `sandbox-runtime/`; `tests/` is left out because
 *      two existing tests render with `Thumbnail` from the package (see the note in the test);
 *   2. `useIsClient` has one definition in `src`, in `StageCanvas.tsx`, and it is exported when any
 *      other file mentions it; no other hook has the same `useSyncExternalStore(_, () => true,
 *      () => false)` body under another name;
 *   3. there is no second player: nothing in `src` outside the SandboxPlayerRef adaptor builds an
 *      object or class with `play`, `pause` and `seekTo`, no `<video>` or `<audio>` element, and
 *      `StageCanvas`, `CanvasPane`, `PlayerBar`, `useCanvasPlayback`, `PlayerLike`,
 *      `SandboxPlayerRef` and `createSandboxPlayerRef` are each declared once;
 *   4. the canvas size is declared once (`CANVAS_WIDTH`, `CANVAS_HEIGHT`, `CANVAS_FPS` in
 *      `canvas-layout.ts`) and `1280` and `720` are written nowhere else in code;
 *   5. `sha256Hex` and its pure fallback `sha256HexPure` are declared once, in `sha256.ts`, and no
 *      other file calls `crypto.subtle`, `createHash`, or carries the SHA-256 round constants;
 *   6. every dependency of `frontend/package.json` that is not one of the ranged ones from before
 *      the feature is an exact version (no `^`, `~`, `>=`, `*`, `latest`), and `esbuild` is the
 *      `0.28.2` that `animation-verifier` pins.
 *
 * Each rule is a function of source text. The real tree must give no problem, and small broken
 * samples must give one, so a rule that stops matching shows up here instead of passing silently.
 * The `docker build` that the `Dockerfile` change needs is not run here (see flags-static).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  FRONTEND,
  declarationsOf,
  loadSources,
  parseSource,
  walk,
  where,
  type Source,
} from "./support/static-scan";

/** Samples are parsed from text; the real tree comes from `loadSources`. */
const sample = (path: string, text: string): Source => ({ path, sf: parseSource(path, text) });

/** Code that ships: the app, the sandbox runtime and the build scripts. */
const shipped = loadSources(["src", "sandbox-runtime", "scripts"]);
const app = shipped.filter((source) => source.path.startsWith("src/"));

// ---------------------------------------------------------------------------------------------
// 1. @remotion/player
// ---------------------------------------------------------------------------------------------

const PLAYER_MODULE = "@remotion/player";
const PLAYER_ALLOWED = (path: string): boolean =>
  path === "src/components/stage/StageCanvas.tsx" || path.startsWith("sandbox-runtime/");

/** Lines of `source` that import a value (anything that runs) from `@remotion/player`. */
function playerValueImports({ sf }: Source): number[] {
  const lines: number[] = [];
  const isPlayer = (node: ts.Node | undefined): boolean =>
    node !== undefined && ts.isStringLiteralLike(node) && node.text === PLAYER_MODULE;
  const report = (node: ts.Node) => lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
  walk(sf, (node) => {
    if (ts.isImportDeclaration(node) && isPlayer(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause === undefined) return report(node); // import "@remotion/player"
      if (clause.isTypeOnly) return;
      const bindings = clause.namedBindings;
      const named =
        bindings !== undefined && ts.isNamedImports(bindings)
          ? bindings.elements.length === 0 || bindings.elements.some((element) => !element.isTypeOnly)
          : false;
      if (clause.name !== undefined || (bindings !== undefined && ts.isNamespaceImport(bindings)) || named) report(node);
    } else if (ts.isExportDeclaration(node) && isPlayer(node.moduleSpecifier)) {
      if (node.isTypeOnly) return;
      const clause = node.exportClause;
      if (clause === undefined || ts.isNamespaceExport(clause) || clause.elements.some((element) => !element.isTypeOnly)) {
        report(node);
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      if (!node.isTypeOnly && ts.isExternalModuleReference(reference) && isPlayer(reference.expression)) report(node);
    } else if (ts.isCallExpression(node) && isPlayer(node.arguments[0])) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) {
        report(node);
      }
    }
  });
  return lines;
}

describe("@remotion/player value imports (Requirement 39.14)", () => {
  // `tests/` is not scanned: two tests that exist and must stay as they are
  // (`stage/lesson-visual-board.test.tsx`, `stage/puzzle-board.test.tsx`) render the
  // compositions with `Thumbnail` from the package, the pattern design 15 asks the verifier
  // tests to reuse. Nothing under `tests/` ships.
  const everything = loadSources(["."]).filter((source) => !source.path.startsWith("tests/"));
  const importers = everything.filter((source) => playerValueImports(source).length > 0).map((source) => source.path);

  it("scans all of frontend/ except tests/", () => {
    expect(everything.length).toBeGreaterThan(150);
    expect(everything.map((source) => source.path)).toEqual(
      expect.arrayContaining([
        "src/components/stage/StageCanvas.tsx",
        "sandbox-runtime/main.tsx",
        "scripts/build-sandbox.mjs",
        "next.config.ts",
        "vitest.config.ts",
      ]),
    );
    expect(everything.some((source) => source.path.startsWith("tests/"))).toBe(false);
  });

  it("finds the imports that are meant to be there", () => {
    expect(importers).toContain("src/components/stage/StageCanvas.tsx");
    expect(importers).toContain("sandbox-runtime/main.tsx");
  });

  it("allows them only in StageCanvas.tsx and sandbox-runtime/", () => {
    expect(importers.filter((path) => !PLAYER_ALLOWED(path))).toEqual([]);
  });

  describe("the rule on samples", () => {
    const lines = (text: string) => playerValueImports(sample("a.tsx", text));

    it.each([
      ["a named import", `import { Player } from "@remotion/player";`],
      ["a named import next to a type", `import { Player, type PlayerRef } from "@remotion/player";`],
      ["a default import", `import Player from "@remotion/player";`],
      ["a namespace import", `import * as RP from "@remotion/player";`],
      ["a side-effect import", `import "@remotion/player";`],
      ["an empty import", `import {} from "@remotion/player";`],
      ["a re-export", `export { Player } from "@remotion/player";`],
      ["a star re-export", `export * from "@remotion/player";`],
      ["a dynamic import", `const m = await import("@remotion/player");`],
      ["a require call", `const m = require("@remotion/player");`],
      ["an import equals", `import RP = require("@remotion/player");`],
    ])("flags %s", (_label, text) => {
      expect(lines(text)).toEqual([1]);
    });

    it.each([
      ["import type", `import type { PlayerRef } from "@remotion/player";`],
      ["only type specifiers", `import { type PlayerRef } from "@remotion/player";`],
      ["a type re-export", `export type { PlayerRef } from "@remotion/player";`],
      ["a type-only re-export list", `export { type PlayerRef } from "@remotion/player";`],
      ["a mock of the module", `vi.mock("@remotion/player", () => ({}));`],
      ["a type query", `type P = typeof import("@remotion/player");`],
      ["a comment", `// import { Player } from "@remotion/player";`],
      ["a string", `const name = 'import { Player } from "@remotion/player"';`],
      ["another module", `import { Player } from "remotion";`],
    ])("does not flag %s", (_label, text) => {
      expect(lines(text)).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// 2. useIsClient
// ---------------------------------------------------------------------------------------------

const IS_CLIENT = "useIsClient";
const IS_CLIENT_HOME = "src/components/stage/StageCanvas.tsx";

type IsClientReport = {
  readonly definitions: readonly { path: string; line: number; exported: boolean }[];
  /** Files that do not define it and still name it (an import or a re-export). */
  readonly users: readonly string[];
};

function analyseIsClient(sources: readonly Source[]): IsClientReport {
  const definitions: { path: string; line: number; exported: boolean }[] = [];
  const users: string[] = [];
  for (const { path, sf } of sources) {
    const defined = declarationsOf(sf).filter(
      (declaration) =>
        declaration.name === IS_CLIENT &&
        (ts.isFunctionDeclaration(declaration.node) || ts.isVariableDeclaration(declaration.node)),
    );
    for (const declaration of defined) {
      definitions.push({
        path,
        line: sf.getLineAndCharacterOfPosition(declaration.node.getStart(sf)).line + 1,
        exported: declaration.exported,
      });
    }
    if (defined.length > 0) continue;
    let mentioned = false;
    walk(sf, (node) => {
      if (ts.isIdentifier(node) && node.text === IS_CLIENT) mentioned = true;
    });
    if (mentioned) users.push(path);
  }
  return { definitions, users };
}

/** `true` / `false` when `fn` is `() => true` or `() => false` (or a block that returns it). */
function constantResult(fn: ts.Expression | undefined): boolean | undefined {
  if (fn === undefined || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return undefined;
  let result: ts.Node | undefined = fn.body;
  if (ts.isBlock(result)) {
    const [only, ...rest] = result.statements;
    if (only === undefined || rest.length > 0 || !ts.isReturnStatement(only)) return undefined;
    result = only.expression;
  }
  if (result?.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (result?.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

/** Places that read "am I on the client" the way `useIsClient` does: `useSyncExternalStore(_, () => true, () => false)`. */
function isClientBodies({ path, sf }: Source): string[] {
  const found: string[] = [];
  walk(sf, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
    if (name !== "useSyncExternalStore" || node.arguments.length < 3) return;
    if (constantResult(node.arguments[1]) === true && constantResult(node.arguments[2]) === false) {
      found.push(where(path, sf, node));
    }
  });
  return found;
}

describe("useIsClient (Requirement 39.7)", () => {
  const report = analyseIsClient(app);

  it("has exactly one definition in frontend/src, in StageCanvas.tsx", () => {
    expect(report.definitions.map((definition) => definition.path)).toEqual([IS_CLIENT_HOME]);
  });

  it("is exported if any other file in frontend/src names it", () => {
    const [definition] = report.definitions;
    if (report.users.length > 0) {
      expect(definition?.exported, `${report.users.join(", ")} name useIsClient, so StageCanvas.tsx must export it`).toBe(true);
    } else {
      expect(report.users).toEqual([]);
    }
  });

  it("has no other hook with its body under another name", () => {
    const bodies = app.flatMap((source) => isClientBodies(source));
    expect(bodies).toHaveLength(1);
    expect(bodies[0].startsWith(`${IS_CLIENT_HOME}:`)).toBe(true);
  });

  describe("the rule on samples", () => {
    const hook = `function useIsClient(): boolean { return useSyncExternalStore(noSubscribe, () => true, () => false); }`;

    it("accepts one private definition that nobody else uses", () => {
      const sources = [sample("src/a.tsx", hook), sample("src/b.tsx", `export const b = 1;`)];
      expect(analyseIsClient(sources)).toEqual({
        definitions: [{ path: "src/a.tsx", line: 1, exported: false }],
        users: [],
      });
    });

    it("sees an exported definition and the file that imports it", () => {
      const sources = [
        sample("src/a.tsx", `export ${hook}`),
        sample("src/b.tsx", `import { useIsClient } from "./a"; export const b = useIsClient();`),
      ];
      expect(analyseIsClient(sources)).toEqual({
        definitions: [{ path: "src/a.tsx", line: 1, exported: true }],
        users: ["src/b.tsx"],
      });
    });

    it("sees an export made by a separate statement", () => {
      expect(analyseIsClient([sample("src/a.tsx", `${hook}\nexport { useIsClient };`)]).definitions[0].exported).toBe(true);
    });

    it("sees a second definition, as a function, a constant or an arrow", () => {
      const sources = [
        sample("src/a.tsx", hook),
        sample("src/b.tsx", `const useIsClient = () => true;`),
        sample("src/c.tsx", `export function useIsClient() { return false; }`),
      ];
      expect(analyseIsClient(sources).definitions.map((definition) => definition.path)).toEqual([
        "src/a.tsx",
        "src/b.tsx",
        "src/c.tsx",
      ]);
    });

    it("finds the same body under another name", () => {
      const copy = sample("src/b.tsx", `const useMounted = () => useSyncExternalStore(sub, () => true, () => { return false; });`);
      expect(isClientBodies(copy)).toHaveLength(1);
      expect(isClientBodies(sample("src/a.tsx", hook))).toHaveLength(1);
    });

    it("does not take other uses of useSyncExternalStore for it", () => {
      const other = sample("src/c.ts", `useSyncExternalStore(sub, getSnapshot, getServerSnapshot);\nuseSyncExternalStore(sub, () => 1, () => 2);`);
      expect(isClientBodies(other)).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// 3. No second player
// ---------------------------------------------------------------------------------------------

const ADAPTOR = "src/lib/animation/sandbox-player-ref.ts";
const PLAYER_SURFACE = ["play", "pause", "seekTo"];
const BUILT_ONCE = [
  "StageCanvas",
  "CanvasPane",
  "PlayerBar",
  "useCanvasPlayback",
  "PlayerLike",
  "SandboxPlayerRef",
  "createSandboxPlayerRef",
];

function memberName(member: ts.Node): string | undefined {
  const name = (member as { name?: ts.PropertyName }).name;
  return name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : undefined;
}

/** Places that build a value with `play`, `pause` and `seekTo` members: an object literal or a class. */
function playerImplementations({ path, sf }: Source): string[] {
  const found: string[] = [];
  walk(sf, (node) => {
    let members: readonly ts.Node[] | undefined;
    if (ts.isObjectLiteralExpression(node)) members = node.properties;
    else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) members = node.members;
    if (members === undefined) return;
    const names = new Set(members.map(memberName));
    if (PLAYER_SURFACE.every((name) => names.has(name))) found.push(where(path, sf, node));
  });
  return found;
}

/** Places that render a media element: `<video>` or `<audio>`. */
function mediaElements({ path, sf }: Source): string[] {
  const found: string[] = [];
  walk(sf, (node) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ts.isIdentifier(node.tagName)) {
      if (node.tagName.text === "video" || node.tagName.text === "audio") found.push(where(path, sf, node));
    }
  });
  return found;
}

describe("no second player (Requirement 39.9)", () => {
  it("builds a PlayerRef-shaped value only in the SandboxPlayerRef adaptor", () => {
    const builders = app.flatMap((source) => playerImplementations(source));
    expect(builders).toHaveLength(1);
    expect(builders[0].startsWith(`${ADAPTOR}:`)).toBe(true);
  });

  it("renders no <video> or <audio> element", () => {
    expect(app.flatMap((source) => mediaElements(source))).toEqual([]);
  });

  it.each(BUILT_ONCE)("declares %s once in frontend/src", (name) => {
    const places = app.flatMap(({ path, sf }) =>
      declarationsOf(sf)
        .filter((declaration) => declaration.name === name)
        .map((declaration) => where(path, sf, declaration.node)),
    );
    expect(places, `declarations of ${name}`).toHaveLength(1);
  });

  describe("the rule on samples", () => {
    it("finds an object, a shorthand object and a class that look like a player", () => {
      const text = [
        `const a = { play() {}, pause: () => {}, seekTo(frame) {} };`,
        `const play = () => {}; const pause = () => {}; const seekTo = () => {};`,
        `const b = { play, pause, seekTo, extra: 1 };`,
        `class C { play() {} pause() {} seekTo() {} }`,
      ].join("\n");
      expect(playerImplementations(sample("src/a.ts", text))).toHaveLength(3);
    });

    it("does not take a partial surface or a type for a player", () => {
      const text = [
        `const a = { play() {}, pause() {} };`,
        `interface P { play(): void; pause(): void; seekTo(frame: number): void }`,
        `type Q = { play(): void; pause(): void; seekTo(frame: number): void };`,
        `player.play(); player.pause(); player.seekTo(0);`,
      ].join("\n");
      expect(playerImplementations(sample("src/a.ts", text))).toEqual([]);
    });

    it("finds media elements by tag name only", () => {
      const tsx = `export const A = () => <div><video src="x" /><audio></audio><Video /></div>;`;
      expect(mediaElements(sample("src/a.tsx", tsx))).toHaveLength(2);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Canvas constants
// ---------------------------------------------------------------------------------------------

const CANVAS_HOME = "src/components/stage/canvas-layout.ts";
const CANVAS_NAMES = ["CANVAS_WIDTH", "CANVAS_HEIGHT", "CANVAS_FPS"];
const CANVAS_NUMBERS = new Set(["1280", "720"]);

/** Variables declared with one of `names`, as `path:line`. */
function variablesNamed(source: Source, names: readonly string[]): string[] {
  return declarationsOf(source.sf)
    .filter((declaration) => ts.isVariableDeclaration(declaration.node) && names.includes(declaration.name))
    .map((declaration) => `${declaration.name} ${where(source.path, source.sf, declaration.node)}`);
}

/** Numeric literals in code (not comments, not strings) equal to the canvas width or height. */
function canvasNumbers({ path, sf }: Source): string[] {
  const found: string[] = [];
  walk(sf, (node) => {
    if (ts.isNumericLiteral(node) && CANVAS_NUMBERS.has(node.text)) found.push(where(path, sf, node));
  });
  return found;
}

describe("canvas size is declared once", () => {
  it("declares CANVAS_WIDTH, CANVAS_HEIGHT and CANVAS_FPS once each, in canvas-layout.ts", () => {
    const declared = shipped.flatMap((source) => variablesNamed(source, CANVAS_NAMES));
    expect(declared.map((line) => line.split(" ")[0]).sort()).toEqual([...CANVAS_NAMES].sort());
    for (const line of declared) expect(line.split(" ")[1].startsWith(`${CANVAS_HOME}:`)).toBe(true);
  });

  it("writes 1280 and 720 in code only in canvas-layout.ts", () => {
    const places = shipped.flatMap((source) => canvasNumbers(source));
    expect(places.length).toBeGreaterThan(0);
    expect(places.filter((place) => !place.startsWith(`${CANVAS_HOME}:`))).toEqual([]);
  });

  describe("the rule on samples", () => {
    it("finds a copy of the constants and a literal size", () => {
      const copy = sample("src/b.ts", `export const CANVAS_WIDTH = 1280;\nconst h = 720;\nconst w = 0x500;`);
      expect(variablesNamed(copy, CANVAS_NAMES)).toHaveLength(1);
      expect(canvasNumbers(copy)).toHaveLength(3);
    });

    it("ignores comments, strings, other numbers and the name used as a value", () => {
      const clean = sample("src/b.ts", `// 1280 x 720\nconst s = "1280x720"; const n = 7200 + 128; const w = CANVAS_WIDTH;`);
      expect(variablesNamed(clean, CANVAS_NAMES)).toEqual([]);
      expect(canvasNumbers(clean)).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// 5. SHA-256
// ---------------------------------------------------------------------------------------------

const SHA_HOME = "src/lib/animation/sha256.ts";
const SHA_NAMES = ["sha256Hex", "sha256HexPure"];
/** The first SHA-256 round constant, 0x428a2f98. */
const SHA_ROUND_CONSTANT = "1116352408";

/** Where the SHA-256 digest is computed: `.subtle`, `createHash`, or a round constant. */
function digestSites({ path, sf }: Source): string[] {
  const found: string[] = [];
  walk(sf, (node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "subtle") found.push(where(path, sf, node));
    else if (ts.isIdentifier(node) && node.text === "createHash") found.push(where(path, sf, node));
    else if (ts.isNumericLiteral(node) && node.text === SHA_ROUND_CONSTANT) found.push(where(path, sf, node));
  });
  return found;
}

/** Functions and constants named `sha256Hex` or `sha256HexPure`, as `name path:line`. */
function shaDefinitions(source: Source): string[] {
  return declarationsOf(source.sf)
    .filter(
      (declaration) =>
        SHA_NAMES.includes(declaration.name) &&
        (ts.isFunctionDeclaration(declaration.node) || ts.isVariableDeclaration(declaration.node)),
    )
    .map((declaration) => `${declaration.name} ${where(source.path, source.sf, declaration.node)}`);
}

describe("sha256Hex has two implementations, both in sha256.ts", () => {
  it("declares sha256Hex and sha256HexPure once each, in sha256.ts", () => {
    const defined = shipped.flatMap((source) => shaDefinitions(source));
    expect(defined.map((line) => line.split(" ")[0]).sort()).toEqual([...SHA_NAMES].sort());
    for (const line of defined) expect(line.split(" ")[1].startsWith(`${SHA_HOME}:`)).toBe(true);
  });

  it("computes a digest nowhere else (no crypto.subtle, createHash or round constants)", () => {
    const sites = shipped.flatMap((source) => digestSites(source));
    expect(sites.some((site) => site.startsWith(`${SHA_HOME}:`))).toBe(true);
    expect(sites.filter((site) => !site.startsWith(`${SHA_HOME}:`))).toEqual([]);
  });

  it("is imported by the loader instead of copied", () => {
    const loader = shipped.find((source) => source.path === "src/lib/animation/loader.ts");
    expect(loader?.sf.text).toMatch(/import \{[^}]*\bsha256Hex\b[^}]*\} from "\.\/sha256"/);
  });

  describe("the rule on samples", () => {
    it("finds a second digest of each kind", () => {
      const copy = sample(
        "src/b.ts",
        [
          `const d = await crypto.subtle.digest("SHA-256", bytes);`,
          `const h = createHash("sha256");`,
          `const K = [0x428a2f98, 0x71374491];`,
          `export async function sha256Hex(bytes: Uint8Array) { return ""; }`,
        ].join("\n"),
      );
      expect(digestSites(copy)).toHaveLength(3);
      expect(shaDefinitions(copy)).toHaveLength(1);
    });

    it("lets a file import and call sha256Hex", () => {
      const user = sample("src/b.ts", `import { sha256Hex } from "./sha256";\nconst d = await sha256Hex(bytes);`);
      expect(digestSites(user)).toEqual([]);
      expect(shaDefinitions(user)).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// 6. Pinned dependencies
// ---------------------------------------------------------------------------------------------

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

/**
 * The dependencies that were written as ranges before the animation feature. They stay as they
 * are. A dependency that is not in this list, such as `esbuild` or an `@fontsource` package, is
 * new and must be an exact version (Requirement 32.7). Do not add to this list.
 */
const RANGED_BEFORE_THE_FEATURE: ReadonlySet<string> = new Set([
  "jszip",
  "lucide-react",
  "mammoth",
  "pdfjs-dist",
  "zod",
  "@tailwindcss/turbopack",
  "@testing-library/jest-dom",
  "@testing-library/react",
  "@testing-library/user-event",
  "@types/node",
  "@types/react",
  "@types/react-dom",
  "@vitejs/plugin-react",
  "@vitest/coverage-v8",
  "eslint",
  "fake-indexeddb",
  "fast-check",
  "jsdom",
  "tailwindcss",
  "typescript",
  "vitest",
]);

/** A version without `^`, `~`, `>=`, `*`, `latest`, `x`, ranges or tags: `1.2.3` or `1.2.3-rc.1`. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** `name@spec` for every dependency outside `baseline` whose version is not exact. */
function unpinnedDependencies(pkg: PackageJson, baseline: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  for (const section of [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies]) {
    for (const [name, spec] of Object.entries(section ?? {})) {
      if (!baseline.has(name) && !EXACT_VERSION.test(spec)) problems.push(`${name}@${spec}`);
    }
  }
  return problems;
}

const ESBUILD_PIN = "0.28.2";

/** Problems with the `esbuild` pin: exact `0.28.2`, a dev dependency, equal to the verifier's. */
function esbuildProblems(pkg: PackageJson, verifier: PackageJson): string[] {
  const problems: string[] = [];
  const own = pkg.devDependencies?.esbuild;
  if (own !== ESBUILD_PIN) problems.push(`devDependencies.esbuild must be "${ESBUILD_PIN}", found ${JSON.stringify(own)}`);
  if (pkg.dependencies?.esbuild !== undefined) problems.push("esbuild must not be in dependencies");
  const theirs = verifier.dependencies?.esbuild ?? verifier.devDependencies?.esbuild;
  if (theirs !== own) problems.push(`esbuild differs from animation-verifier (${JSON.stringify(theirs)})`);
  return problems;
}

const readPackage = (path: string): PackageJson => JSON.parse(readFileSync(path, "utf8")) as PackageJson;

describe("pinned dependencies (Requirement 32.7)", () => {
  const pkg = readPackage(join(FRONTEND, "package.json"));
  const verifier = readPackage(join(FRONTEND, "..", "animation-verifier", "package.json"));

  it("has every dependency outside the pre-feature ranged ones as an exact version", () => {
    expect(unpinnedDependencies(pkg, RANGED_BEFORE_THE_FEATURE)).toEqual([]);
  });

  it("keeps the ranged baseline honest: each name in it is still a dependency", () => {
    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ]);
    expect([...RANGED_BEFORE_THE_FEATURE].filter((name) => !declared.has(name))).toEqual([]);
  });

  it("pins the Remotion packages and esbuild exactly", () => {
    expect(pkg.dependencies?.["@remotion/player"]).toMatch(EXACT_VERSION);
    expect(pkg.dependencies?.remotion).toMatch(EXACT_VERSION);
    expect(pkg.devDependencies?.esbuild).toBe(ESBUILD_PIN);
  });

  it("uses the esbuild version of animation-verifier", () => {
    expect(esbuildProblems(pkg, verifier)).toEqual([]);
  });

  describe("the rule on samples", () => {
    const none: ReadonlySet<string> = new Set();

    it.each(["^1.0.0", "~1.0.0", ">=1.0.0", "*", "latest", "1.x", "1", "1.0.0 - 2.0.0", "", "next", "github:a/b"])(
      "flags %j",
      (spec) => {
        expect(unpinnedDependencies({ devDependencies: { thing: spec } }, none)).toEqual([`thing@${spec}`]);
      },
    );

    it.each(["1.0.0", "0.28.2", "19.3.0", "1.0.0-rc.1", "4.0.543"])("accepts %j", (spec) => {
      expect(unpinnedDependencies({ dependencies: { thing: spec } }, none)).toEqual([]);
    });

    it("checks dependencies, devDependencies and optionalDependencies", () => {
      const pkgWithAll: PackageJson = {
        dependencies: { a: "^1.0.0" },
        devDependencies: { b: "~1.0.0" },
        optionalDependencies: { c: "*" },
      };
      expect(unpinnedDependencies(pkgWithAll, none)).toEqual(["a@^1.0.0", "b@~1.0.0", "c@*"]);
    });

    it("lets a name in the baseline keep its range, and nothing else", () => {
      const pkgWithTwo: PackageJson = { devDependencies: { old: "^1.0.0", fresh: "^2.0.0" } };
      expect(unpinnedDependencies(pkgWithTwo, new Set(["old"]))).toEqual(["fresh@^2.0.0"]);
    });

    it("flags a new @fontsource package that is a range", () => {
      const fonts: PackageJson = { devDependencies: { "@fontsource/space-grotesk": "^5.2.0", "@fontsource/jetbrains-mono": "5.2.5" } };
      expect(unpinnedDependencies(fonts, RANGED_BEFORE_THE_FEATURE)).toEqual(["@fontsource/space-grotesk@^5.2.0"]);
    });

    it("flags an esbuild pin that is broken", () => {
      const verifierPin: PackageJson = { devDependencies: { esbuild: ESBUILD_PIN } };
      expect(esbuildProblems({ devDependencies: { esbuild: ESBUILD_PIN } }, verifierPin)).toEqual([]);
      expect(esbuildProblems({ devDependencies: { esbuild: `^${ESBUILD_PIN}` } }, verifierPin)).toEqual([
        'devDependencies.esbuild must be "0.28.2", found "^0.28.2"',
        'esbuild differs from animation-verifier ("0.28.2")',
      ]);
      expect(esbuildProblems({ devDependencies: { esbuild: "0.28.1" } }, verifierPin)).toEqual([
        'devDependencies.esbuild must be "0.28.2", found "0.28.1"',
        'esbuild differs from animation-verifier ("0.28.2")',
      ]);
      expect(esbuildProblems({}, verifierPin)).toEqual([
        'devDependencies.esbuild must be "0.28.2", found undefined',
        'esbuild differs from animation-verifier ("0.28.2")',
      ]);
      expect(esbuildProblems({ dependencies: { esbuild: ESBUILD_PIN }, devDependencies: { esbuild: ESBUILD_PIN } }, verifierPin)).toEqual([
        "esbuild must not be in dependencies",
      ]);
    });

    it("flags an esbuild that moved away from the verifier's", () => {
      expect(esbuildProblems({ devDependencies: { esbuild: ESBUILD_PIN } }, { devDependencies: { esbuild: "0.29.0" } })).toEqual([
        'esbuild differs from animation-verifier ("0.29.0")',
      ]);
    });
  });
});
