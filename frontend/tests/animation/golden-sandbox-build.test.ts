/**
 * Tests: the Sandbox_Builder (task 26.4), design 7.9, Requirements 27.5, 27.6, 27.11, 27.12,
 * 27.13, 3.8, 3.13 and 32.7.
 *
 * CI runs Vitest before `npm run build`, so none of this depends on `public/sandbox/`
 * (note N-7, Requirement 27.13): `beforeAll` calls `buildSandbox` in-process with a temporary
 * output directory and the tests read what it wrote there. The real `esbuild`, the real
 * `sandbox-runtime/` and the real `lore-tokens.css` are used. The four font files are the one
 * thing that is stand-in: `@fontsource/*` is a build dependency that the builder reads from
 * `node_modules`, so the tests give it a directory of small fake `.woff2` files through
 * `fontsRoot`.
 *
 * What is checked:
 *   1. the built `runtime.js` is an IIFE of at most 1048576 bytes, with `NODE_ENV` defined and no
 *      source map, and the build is reproducible;
 *   2. the metafile has one copy of `react`, `react-dom`, `remotion` and `@remotion/player`, all
 *      from `frontend/node_modules/<package>/`, at the version pinned in `package.json`;
 *   3. the written `runtime.html` has the names and values of `lore-tokens.css` and the fonts;
 *   4. a missing token, a missing font, a size over the limit, a bundling error and a missing
 *      package each give `{ ok: false }` (exit code 1 from the script) and write nothing, and
 *      leave an earlier build as it was;
 *   5. `npm run dev` and `npm run build` run the builder first (`predev`, `prebuild`).
 *
 * The expected values in 2 and 3 are read from the files they come from with plain regexes and
 * `JSON.parse`, not through the code under test.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_ROOT,
  MAX_RUNTIME_BYTES,
  SINGLE_COPY_PACKAGES,
  buildSandbox,
  checkSingleCopy,
  runCli,
  type BuildResult,
} from "../../scripts/build-sandbox.mjs";
import { checkRuntimeHtml } from "../../scripts/sandbox-page.mjs";
import { CONTRACT } from "@/lib/animation/contract";

const FRONTEND = join(__dirname, "..", "..");
const TOKENS_CSS_FILE = join(FRONTEND, "src", "app", "lore-tokens.css");
const TOKENS_CSS = readFileSync(TOKENS_CSS_FILE, "utf8");
const SCRIPT = join(FRONTEND, "scripts", "build-sandbox.mjs");

const FONT_FILES = [
  "@fontsource/space-grotesk/files/space-grotesk-latin-500-normal.woff2",
  "@fontsource/space-grotesk/files/space-grotesk-latin-700-normal.woff2",
  "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2",
  "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2",
];

type Built = Extract<BuildResult, { ok: true }>;

let scratch = "";
let fonts = "";
let built: Built;
let builtDir = "";

/** A path under the scratch directory that nothing has created yet. */
function fresh(name: string): string {
  return join(scratch, name);
}

/** Four small fake woff2 files in `dir/@fontsource/...`, like the installed packages. */
function writeFakeFonts(dir: string, skip: readonly string[] = []): void {
  FONT_FILES.forEach((file, index) => {
    if (skip.includes(file)) return;
    const target = join(dir, file);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, Buffer.from(`wOF2-fake-${index}`));
  });
}

/** `lore-tokens.css` with every line that mentions `needle` removed. */
function cssWithout(needle: string): string {
  const file = fresh(`tokens-without-${needle.replace(/\W/g, "")}.css`);
  const lines = TOKENS_CSS.split("\n").filter((line) => !line.includes(needle));
  expect(lines.length).toBeLessThan(TOKENS_CSS.split("\n").length);
  writeFileSync(file, lines.join("\n"));
  return file;
}

/** The raw value of a declaration of `lore-tokens.css`, read with a regex. */
function rawCssValue(property: string): string {
  const found = new RegExp(`${property}:\\s*([^;]+);`).exec(TOKENS_CSS);
  if (found === null) throw new Error(`${property} is not in lore-tokens.css`);
  return found[1].trim();
}

function readOut(file: string): string {
  return readFileSync(join(builtDir, file), "utf8");
}

// One real build for the whole file: the tests below read what it wrote.
beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "lore-sandbox-build-"));
  fonts = join(scratch, "fonts");
  writeFakeFonts(fonts);
  builtDir = fresh("built");
  const result = await buildSandbox({ outDir: builtDir, fontsRoot: fonts });
  if (!result.ok) throw new Error(`the real build failed:\n${result.errors.join("\n")}`);
  built = result;
}, 60_000);

afterAll(() => {
  if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
});

describe("the real build", () => {
  it("writes exactly runtime.js and runtime.html, with no temporary file left", () => {
    expect(readdirSync(builtDir).sort()).toEqual(["runtime.html", "runtime.js"]);
    expect(built.outDir).toBe(builtDir);
  });

  it("makes runtime.js non-empty and at most 1048576 bytes", () => {
    expect(MAX_RUNTIME_BYTES).toBe(1048576);
    const bytes = readFileSync(join(builtDir, "runtime.js")).byteLength;
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(1048576);
    expect(built.runtimeBytes).toBe(bytes);
  });

  it("is an IIFE with NODE_ENV defined and no source map (Requirement 27.11)", () => {
    const script = readOut("runtime.js");
    expect(script).not.toMatch(/^\s*(?:import|export)\s/m);
    expect(script.startsWith('"use strict";(()=>{') || script.startsWith("(()=>{")).toBe(true);
    expect(script).not.toContain("process.env.NODE_ENV");
    expect(script).not.toContain("sourceMappingURL");
  });

  it("is reproducible: a second build gives the same runtime.js and runtime.html", async () => {
    const again = await buildSandbox({ outDir: fresh("again"), fontsRoot: fonts });
    expect(again.ok).toBe(true);
    expect(readFileSync(join(fresh("again"), "runtime.js")).equals(readFileSync(join(builtDir, "runtime.js")))).toBe(true);
    expect(readFileSync(join(fresh("again"), "runtime.html"), "utf8")).toBe(readOut("runtime.html"));
  });

  it("accepts a limit equal to the size and refuses one byte less", async () => {
    const equal = await buildSandbox({
      outDir: fresh("limit-equal"),
      fontsRoot: fonts,
      maxRuntimeBytes: built.runtimeBytes,
    });
    expect(equal.ok).toBe(true);

    const below = await buildSandbox({
      outDir: fresh("limit-below"),
      fontsRoot: fonts,
      maxRuntimeBytes: built.runtimeBytes - 1,
    });
    expect(below.ok).toBe(false);
    if (!below.ok) expect(below.errors.join("\n")).toMatch(/over the limit/);
    expect(existsSync(fresh("limit-below"))).toBe(false);
  });
});

describe("one copy of each library (Requirements 3.8 and 3.13)", () => {
  it("covers react, react-dom, remotion and @remotion/player", () => {
    expect([...SINGLE_COPY_PACKAGES]).toEqual(["react", "react-dom", "remotion", "@remotion/player"]);
  });

  for (const name of ["react", "react-dom", "remotion", "@remotion/player"]) {
    it(`${name}: every bundled input is from frontend/node_modules/${name}/ and none is nested`, () => {
      const inputs = Object.keys(built.metafile.inputs);
      const own = inputs.filter((file) => file.includes(`node_modules/${name}/`));
      expect(own.length).toBeGreaterThan(0);
      for (const file of own) {
        expect(file.startsWith(`node_modules/${name}/`), file).toBe(true);
        expect(existsSync(join(FRONTEND, file)), file).toBe(true);
      }
      expect(inputs.filter((file) => new RegExp(`node_modules/.*node_modules/${name}/`).test(file))).toEqual([]);
    });

    it(`${name}: the bundled version is the pinned one, and the pin is exact`, () => {
      const manifest = JSON.parse(readFileSync(join(FRONTEND, "package.json"), "utf8")) as {
        dependencies: Record<string, string>;
      };
      const installed = JSON.parse(readFileSync(join(FRONTEND, "node_modules", name, "package.json"), "utf8")) as {
        version: string;
      };
      expect(manifest.dependencies[name]).toMatch(/^\d+\.\d+\.\d+$/);
      expect(installed.version).toBe(manifest.dependencies[name]);
    });
  }

  it("the whole bundle comes from the repository: only frontend/ files and node_modules/", () => {
    for (const file of Object.keys(built.metafile.inputs)) {
      expect(file.startsWith("../"), file).toBe(false);
      expect(/^(?:node_modules|src|sandbox-runtime)\//.test(file), file).toBe(true);
    }
  });
});

describe("checkSingleCopy", () => {
  const good = {
    "node_modules/react/index.js": {},
    "node_modules/react-dom/client.js": {},
    "node_modules/remotion/dist/index.js": {},
    "node_modules/@remotion/player/dist/index.js": {},
    "src/lib/x.ts": {},
  };

  it("accepts one copy of each, even when other packages are nested", () => {
    expect(checkSingleCopy(good)).toEqual([]);
    expect(checkSingleCopy({ ...good, "node_modules/other/node_modules/left-pad/index.js": {} })).toEqual([]);
  });

  it("reports a nested second copy of each package", () => {
    for (const name of SINGLE_COPY_PACKAGES) {
      const problems = checkSingleCopy({ ...good, [`node_modules/lib/node_modules/${name}/index.js`]: {} });
      expect(problems, name).toHaveLength(1);
      expect(problems[0]).toContain(name);
      expect(problems[0]).toContain("nested");
    }
  });

  it("reports a copy from outside frontend/node_modules", () => {
    const problems = checkSingleCopy({ ...good, "../node_modules/react/index.js": {} });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("../node_modules/react/index.js");
  });

  it("reports a package that is not in the bundle at all", () => {
    const without = Object.fromEntries(
      Object.entries(good).filter(([file]) => file !== "node_modules/remotion/dist/index.js"),
    );
    expect(checkSingleCopy(without)).toEqual(["remotion: not found in the bundle"]);
  });

  it("does not confuse react with react-dom, or remotion with @remotion/player", () => {
    expect(checkSingleCopy({ "node_modules/react-dom/client.js": {} }, ["react"])).toEqual([
      "react: not found in the bundle",
    ]);
    expect(checkSingleCopy({ "node_modules/@remotion/player/index.js": {} }, ["remotion"])).toEqual([
      "remotion: not found in the bundle",
    ]);
  });
});

describe("the written runtime.html", () => {
  /** The `name:value` pairs of the `:root{...}` rule. */
  function rootVariables(html: string): Record<string, string> {
    const rule = /:root\{([^}]*)\}/.exec(html);
    if (rule === null) throw new Error("no :root rule");
    const variables: Record<string, string> = {};
    for (const declaration of rule[1].split(";")) {
      const at = declaration.indexOf(":");
      variables[declaration.slice(0, at)] = declaration.slice(at + 1);
    }
    return variables;
  }

  it("has the name and value of every palette token of the contract, as in lore-tokens.css", () => {
    const variables = rootVariables(readOut("runtime.html"));
    expect(CONTRACT.color_tokens).toHaveLength(9);
    for (const name of CONTRACT.color_tokens) {
      expect(variables[`--color-${name}`], name).toBe(rawCssValue(`--color-${name}`));
    }
  });

  it("has --font-display and --font-mono with the css value minus the next/font variables", () => {
    const variables = rootVariables(readOut("runtime.html"));
    for (const property of CONTRACT.font_variables) {
      const expected = rawCssValue(property)
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => !/^var\(--font-(?:space-grotesk|jetbrains-mono)\)$/.test(entry))
        .join(", ");
      expect(variables[property], property).toBe(expected);
    }
  });

  it("has nothing else in :root: the nine colours and the two fonts", () => {
    const variables = rootVariables(readOut("runtime.html"));
    expect(Object.keys(variables)).toHaveLength(9 + 2);
  });

  it("embeds the four font files as data: URLs", () => {
    const html = readOut("runtime.html");
    FONT_FILES.forEach((file) => {
      const base64 = readFileSync(join(fonts, file)).toString("base64");
      expect(html, file).toContain(`url(data:font/woff2;base64,${base64})`);
    });
  });

  it("has the CSP of the policy file in a meta, without frame-ancestors, and one script src", () => {
    const html = readOut("runtime.html");
    const policy = JSON.parse(
      readFileSync(join(FRONTEND, "src", "lib", "animation", "sandbox-policy.json"), "utf8"),
    ) as { csp: string };
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${policy.csp}">`);
    expect(html).not.toContain("frame-ancestors");
    expect(html.match(/<script\b/g)).toHaveLength(1);
    expect(html).toContain('<script src="/sandbox/runtime.js"></script>');
    expect(checkRuntimeHtml(html)).toEqual([]);
  });
});

describe("a build that must fail writes nothing", () => {
  /** Runs `buildSandbox` and asserts it failed and did not create `outDir`. */
  async function expectRefused(options: Parameters<typeof buildSandbox>[0], outDir: string) {
    const result = await buildSandbox({ fontsRoot: fonts, ...options, outDir });
    expect(result.ok).toBe(false);
    expect(existsSync(outDir)).toBe(false);
    return result.ok ? [] : result.errors;
  }

  it.each(CONTRACT.color_tokens)("a missing palette token (%s) is refused and named", async (name) => {
    const errors = await expectRefused({ tokensCssPath: cssWithout(`--color-${name}:`) }, fresh(`no-${name}`));
    expect(errors.join("\n")).toContain(`--color-${name}`);
  });

  it.each(CONTRACT.font_variables)("a missing %s is refused and named", async (property) => {
    const errors = await expectRefused({ tokensCssPath: cssWithout(`${property}:`) }, fresh(`no${property}`));
    expect(errors.join("\n")).toContain(property);
  });

  it("a --font-* value that is only next/font variables is refused", async () => {
    const file = fresh("only-next-font.css");
    writeFileSync(
      file,
      TOKENS_CSS.replace(/--font-mono:[^;]+;/, "--font-mono: var(--font-jetbrains-mono);"),
    );
    const errors = await expectRefused({ tokensCssPath: file }, fresh("only-next-font"));
    expect(errors.join("\n")).toContain("--font-mono");
  });

  it("a css file without @theme, or one that cannot be read, is refused", async () => {
    const plain = fresh("plain.css");
    writeFileSync(plain, ":root { --color-ink: #000; }");
    await expectRefused({ tokensCssPath: plain }, fresh("plain-css"));
    await expectRefused({ tokensCssPath: fresh("not-there.css") }, fresh("missing-css"));
  });

  it.each(FONT_FILES)("a missing font file (%s) is refused and named", async (file) => {
    const dir = fresh(`fonts-without-${FONT_FILES.indexOf(file)}`);
    writeFakeFonts(dir, [file]);
    const errors = await expectRefused({ fontsRoot: dir }, fresh(`no-font-${FONT_FILES.indexOf(file)}`));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(file);
  });

  it("an empty font file is refused", async () => {
    const dir = fresh("fonts-empty-one");
    writeFakeFonts(dir);
    writeFileSync(join(dir, FONT_FILES[2]), "");
    const errors = await expectRefused({ fontsRoot: dir }, fresh("empty-font"));
    expect(errors.join("\n")).toContain(FONT_FILES[2]);
  });

  it("a bundle over the size limit is refused", async () => {
    const errors = await expectRefused({ maxRuntimeBytes: 1000 }, fresh("too-big"));
    expect(errors.join("\n")).toMatch(/runtime\.js is \d+ bytes, over the limit of 1000/);
  });

  it("a bundling error is refused with the error text", async () => {
    const root = fresh("broken-root");
    mkdirSync(join(root, "sandbox-runtime"), { recursive: true });
    writeFileSync(join(root, "sandbox-runtime", "main.tsx"), 'import "./does-not-exist";\nexport {};\n');
    const errors = await expectRefused(
      {
        root,
        tokensCssPath: TOKENS_CSS_FILE,
        contractPath: join(FRONTEND, "src", "lib", "animation", "animation-contract.json"),
        policyPath: join(FRONTEND, "src", "lib", "animation", "sandbox-policy.json"),
      },
      fresh("broken-out"),
    );
    expect(errors.join("\n")).toMatch(/bundling failed:.*does-not-exist/);
  });

  it("a bundle that does not contain the four libraries is refused", async () => {
    const root = fresh("empty-root");
    mkdirSync(join(root, "sandbox-runtime"), { recursive: true });
    writeFileSync(join(root, "sandbox-runtime", "main.tsx"), "console.log(1);\nexport {};\n");
    const errors = await expectRefused(
      {
        root,
        tokensCssPath: TOKENS_CSS_FILE,
        contractPath: join(FRONTEND, "src", "lib", "animation", "animation-contract.json"),
        policyPath: join(FRONTEND, "src", "lib", "animation", "sandbox-policy.json"),
      },
      fresh("empty-out"),
    );
    for (const name of SINGLE_COPY_PACKAGES) expect(errors).toContain(`${name}: not found in the bundle`);
  });

  it("a policy without a csp is refused", async () => {
    const policy = fresh("policy-no-csp.json");
    writeFileSync(policy, JSON.stringify({ frame_ancestors: "'self'" }));
    const errors = await expectRefused({ policyPath: policy }, fresh("no-csp"));
    expect(errors.join("\n")).toContain('"csp"');
  });

  it("leaves an earlier build exactly as it was", async () => {
    const out = fresh("stale-out");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "runtime.js"), "OLD-JS");
    writeFileSync(join(out, "runtime.html"), "OLD-HTML");
    const dir = fresh("fonts-stale");
    writeFakeFonts(dir, [FONT_FILES[0]]);
    const result = await buildSandbox({ outDir: out, fontsRoot: dir });
    expect(result.ok).toBe(false);
    expect(readFileSync(join(out, "runtime.js"), "utf8")).toBe("OLD-JS");
    expect(readFileSync(join(out, "runtime.html"), "utf8")).toBe("OLD-HTML");
    expect(readdirSync(out).sort()).toEqual(["runtime.html", "runtime.js"]);
  });

  it("never throws, whatever the paths are", async () => {
    const result = await buildSandbox({
      root: fresh("no-such-root"),
      outDir: fresh("never"),
      tokensCssPath: fresh("no-such.css"),
      contractPath: fresh("no-such-contract.json"),
      policyPath: fresh("no-such-policy.json"),
      fontsRoot: fresh("no-such-fonts"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThanOrEqual(3);
    expect(existsSync(fresh("never"))).toBe(false);
  });
});

describe("the command line: exit code 1 and no output when something is missing", () => {
  /** An `io` that keeps what the script prints. */
  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    return {
      io: { stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) } },
      out,
      err,
    };
  }

  it("runCli returns 1 and prints the missing fonts when a font file is missing", async () => {
    const { io, err } = capture();
    const empty = fresh("cli-empty-fonts");
    mkdirSync(empty, { recursive: true });
    const code = await runCli(["--fonts-root", empty, "--out", fresh("cli-out-1")], io);
    expect(code).toBe(1);
    expect(err.join("")).toContain("nothing was written");
    for (const file of FONT_FILES) expect(err.join("")).toContain(file);
    expect(existsSync(fresh("cli-out-1"))).toBe(false);
  });

  it("runCli returns 0 and says what it wrote when everything is there", async () => {
    const { io, out } = capture();
    const code = await runCli(["--fonts-root", fonts, "--out", fresh("cli-out-2")], io);
    expect(code).toBe(0);
    expect(out.join("")).toContain("wrote runtime.js");
    expect(readdirSync(fresh("cli-out-2")).sort()).toEqual(["runtime.html", "runtime.js"]);
  });

  const BAD_ARGUMENTS: string[][] = [["--nope", "x"], ["--out"], ["stray"]];
  for (const argv of BAD_ARGUMENTS) {
    it(`runCli returns 1 and shows the usage for ${JSON.stringify(argv)}`, async () => {
      const { io, err } = capture();
      expect(await runCli(argv, io)).toBe(1);
      expect(err.join("")).toContain("Usage");
    });
  }

  it("`node scripts/build-sandbox.mjs` exits 1 and writes nothing without the font files", () => {
    const empty = fresh("proc-empty-fonts");
    mkdirSync(empty, { recursive: true });
    const run = spawnSync(process.execPath, [SCRIPT, "--fonts-root", empty, "--out", fresh("proc-out-1")], {
      cwd: scratch,
      encoding: "utf8",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("nothing was written");
    expect(existsSync(fresh("proc-out-1"))).toBe(false);
  });

  it("`node scripts/build-sandbox.mjs` exits 1 without a palette token", () => {
    const run = spawnSync(
      process.execPath,
      [SCRIPT, "--fonts-root", fonts, "--tokens", cssWithout("--color-candle-ink:"), "--out", fresh("proc-out-2")],
      { cwd: scratch, encoding: "utf8" },
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("--color-candle-ink");
    expect(existsSync(fresh("proc-out-2"))).toBe(false);
  });

  it("`node scripts/build-sandbox.mjs` exits 0 from any working directory and writes both files", () => {
    const run = spawnSync(process.execPath, [SCRIPT, "--fonts-root", fonts, "--out", fresh("proc-out-3")], {
      cwd: scratch,
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    expect(readdirSync(fresh("proc-out-3")).sort()).toEqual(["runtime.html", "runtime.js"]);
  }, 60_000);
});

describe("npm scripts, dependencies and ignore rules (Requirements 27.6, 27.13, 32.7)", () => {
  const manifest = JSON.parse(readFileSync(join(FRONTEND, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  it("`npm run dev` and `npm run build` run the builder first (predev, prebuild)", () => {
    expect(manifest.scripts.predev).toBe("node scripts/build-sandbox.mjs");
    expect(manifest.scripts.prebuild).toBe("node scripts/build-sandbox.mjs");
    expect(existsSync(join(FRONTEND, "scripts", "build-sandbox.mjs"))).toBe(true);
  });

  it("leaves dev, build, lint and test as they were", () => {
    expect(manifest.scripts.dev).toBe("next dev");
    expect(manifest.scripts.build).toBe("next build");
    expect(manifest.scripts.lint).toBe("eslint");
    expect(manifest.scripts.test).toBe("vitest run");
  });

  it("pins esbuild to the version that is installed, with no range", () => {
    const installed = JSON.parse(readFileSync(join(FRONTEND, "node_modules", "esbuild", "package.json"), "utf8")) as {
      version: string;
    };
    expect(manifest.devDependencies.esbuild).toMatch(/^\d+\.\d+\.\d+$/);
    expect(installed.version).toBe(manifest.devDependencies.esbuild);
  });

  it("pins every build dependency of the sandbox exactly (no ^, ~, >=, *, latest)", () => {
    for (const name of ["esbuild", "@fontsource/space-grotesk", "@fontsource/jetbrains-mono"]) {
      const range = manifest.devDependencies[name];
      if (range === undefined) continue; // not installed yet; see the operator step in the report
      expect(range, name).not.toMatch(/[\^~*><]|latest/);
    }
  });

  it("git ignores the output and eslint skips it", () => {
    const ignore = readFileSync(join(DEFAULT_ROOT, "..", ".gitignore"), "utf8").split("\n");
    expect(ignore).toContain("/frontend/public/sandbox/");
    expect(readFileSync(join(FRONTEND, "eslint.config.mjs"), "utf8")).toContain('"public/sandbox/**"');
  });
});
