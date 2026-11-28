/**
 * Sandbox_Builder: builds `public/sandbox/runtime.js` and `public/sandbox/runtime.html`
 * (design 7.9, Requirement 27).
 *
 * `runtime.js` is `sandbox-runtime/main.tsx` bundled by esbuild with `react`, `react-dom`,
 * `remotion`, `@remotion/player` and the protocol schemas: the script that runs inside the
 * sandboxed iframe. `runtime.html` is the page that loads it (`sandbox-page.mjs`), with the Kit's
 * variables read from `src/app/lore-tokens.css` and the four fonts inlined as `data:` URLs, under
 * the CSP of `src/lib/animation/sandbox-policy.json`. `npm run dev` and `npm run build` run this
 * file first (`predev`, `prebuild`), so the output is never committed (`/frontend/public/sandbox/`
 * is in `.gitignore`).
 *
 * The order is: read and check every input, then bundle, then check the bundle, then write. A
 * failure at any step returns `{ ok: false, errors }` before the next step, and nothing is
 * written until every check has passed, so a broken build never leaves a half-new `public/sandbox/`
 * and a stale one is never mistaken for a fresh one. Written files go to a temporary name first
 * and are renamed into place.
 *
 * `buildSandbox` is exported and takes every path as an option, so the tests call it in-process
 * with a temporary output directory and never depend on the output of `npm run build` (CI runs
 * Vitest before the build, note N-7). Run as a script, `runCli` turns the result into an exit
 * code: 0 when written, 1 when not, with the reasons on stderr.
 *
 * Plain `.mjs` so Node runs it with no compiler; `build-sandbox.d.mts` gives the tests its types.
 */

import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FONT_FILES, checkRuntimeHtml, parseThemeTokens, renderRuntimeHtml } from "./sandbox-page.mjs";

/** Largest `runtime.js` the page may load, in bytes (Requirement 27.6, 27.12). */
export const MAX_RUNTIME_BYTES = 1048576;

/** Packages that must appear exactly once in `runtime.js` (Requirement 3.8, 3.13). */
export const SINGLE_COPY_PACKAGES = ["react", "react-dom", "remotion", "@remotion/player"];

/** The `frontend/` directory, from the location of this file. */
export const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Entry of the bundle, relative to the root. */
const ENTRY = "sandbox-runtime/main.tsx";

/** `String(error)` that cannot itself throw. */
function messageOf(error) {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "unknown error";
  }
}

/** Reads and parses a JSON file. */
async function readJson(file) {
  try {
    return { ok: true, value: JSON.parse(await readFile(file, "utf8")) };
  } catch (error) {
    return { ok: false, error: `cannot read ${file}: ${messageOf(error)}` };
  }
}

/** True for an array of non-empty strings. */
function isNameList(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item !== "");
}

/**
 * Checks that every one of `packages` was bundled from `<root>/node_modules/<package>/` and that
 * no nested `node_modules/**\/node_modules/<package>/` copy came along. `inputs` are the keys of
 * the esbuild metafile's `inputs`, relative to the root and always written with `/`.
 *
 * @param {Record<string, unknown>} inputs
 * @param {readonly string[]} [packages]
 * @returns {string[]} problems; empty when each package has one copy, in `<root>/node_modules`
 */
export function checkSingleCopy(inputs, packages = SINGLE_COPY_PACKAGES) {
  const paths = Object.keys(inputs);
  const problems = [];
  for (const name of packages) {
    const marker = `node_modules/${name}/`;
    const hits = paths.filter((file) => file.includes(marker));
    if (hits.length === 0) problems.push(`${name}: not found in the bundle`);
    for (const hit of hits) {
      if (hit.startsWith(marker)) continue;
      const nested = hit.startsWith("node_modules/");
      problems.push(
        nested
          ? `${name}: a second copy is nested at ${hit}`
          : `${name}: ${hit} is not from frontend/node_modules/${name}/`,
      );
    }
  }
  return problems;
}

/**
 * Tells esbuild's failure apart from every other one and turns it into lines of text.
 * @param {unknown} error
 * @returns {string[]}
 */
function esbuildErrorLines(error) {
  const list = typeof error === "object" && error !== null ? error.errors : undefined;
  if (!Array.isArray(list) || list.length === 0) return [`bundling failed: ${messageOf(error)}`];
  return list.map((entry) => {
    const where = entry?.location ? `${entry.location.file}:${entry.location.line}: ` : "";
    return `bundling failed: ${where}${entry?.text ?? "unknown error"}`;
  });
}

/**
 * Builds the runtime. Never throws: the result says whether it wrote.
 *
 * Options (all optional; the defaults are the real repository):
 * - `root`: the frontend directory; esbuild's working directory.
 * - `outDir`: where `runtime.js` and `runtime.html` go (default `<root>/public/sandbox`).
 * - `tokensCssPath`, `contractPath`, `policyPath`: the three inputs of the page.
 * - `fontsRoot`: the directory that holds `@fontsource/*` (default `<root>/node_modules`).
 * - `maxRuntimeBytes`: size limit for `runtime.js` (default `MAX_RUNTIME_BYTES`).
 *
 * @param {import("./build-sandbox.d.mts").BuildOptions} [options]
 * @returns {Promise<import("./build-sandbox.d.mts").BuildResult>}
 */
export async function buildSandbox(options = {}) {
  const root = options.root ?? DEFAULT_ROOT;
  const outDir = options.outDir ?? path.join(root, "public", "sandbox");
  const tokensCssPath = options.tokensCssPath ?? path.join(root, "src", "app", "lore-tokens.css");
  const contractPath =
    options.contractPath ?? path.join(root, "src", "lib", "animation", "animation-contract.json");
  const policyPath =
    options.policyPath ?? path.join(root, "src", "lib", "animation", "sandbox-policy.json");
  const fontsRoot = options.fontsRoot ?? path.join(root, "node_modules");
  const maxRuntimeBytes = options.maxRuntimeBytes ?? MAX_RUNTIME_BYTES;
  const suffix = `${process.pid}.tmp`;
  const temporaries = [];

  try {
    // 1. Read and check every input. Nothing is bundled or written if any of it is wrong.
    const errors = [];
    const [css, contract, policy] = await Promise.all([
      readFile(tokensCssPath, "utf8").then(
        (text) => ({ ok: true, value: text }),
        (error) => ({ ok: false, error: `cannot read ${tokensCssPath}: ${messageOf(error)}` }),
      ),
      readJson(contractPath),
      readJson(policyPath),
    ]);
    for (const input of [css, contract, policy]) if (!input.ok) errors.push(input.error);

    let csp = "";
    if (policy.ok) {
      if (typeof policy.value?.csp !== "string" || policy.value.csp === "") {
        errors.push(`${policyPath}: "csp" is not a non-empty string`);
      } else {
        csp = policy.value.csp;
      }
    }

    let palette = [];
    let fontVariables = [];
    if (contract.ok) {
      if (!isNameList(contract.value?.color_tokens) || contract.value.color_tokens.length === 0) {
        errors.push(`${contractPath}: "color_tokens" is not a non-empty list of names`);
      } else {
        palette = contract.value.color_tokens;
      }
      if (!isNameList(contract.value?.font_variables) || contract.value.font_variables.length === 0) {
        errors.push(`${contractPath}: "font_variables" is not a non-empty list of names`);
      } else {
        fontVariables = contract.value.font_variables;
      }
    }

    /** @type {Record<string, string>} */
    const tokens = {};
    if (css.ok) {
      const parsed = parseThemeTokens(css.value);
      if (!parsed.ok) {
        errors.push(`${tokensCssPath}: ${parsed.reason}`);
      } else {
        for (const name of palette) {
          const property = `--color-${name}`;
          if (parsed.tokens[property] === undefined) {
            errors.push(`${tokensCssPath}: palette token ${property} is missing`);
          } else {
            tokens[property] = parsed.tokens[property];
          }
        }
        for (const property of fontVariables) {
          if (!parsed.tokens[property]) {
            errors.push(`${tokensCssPath}: font token ${property} is missing or has no family left`);
          } else {
            tokens[property] = parsed.tokens[property];
          }
        }
      }
    }

    const fonts = [];
    for (const font of FONT_FILES) {
      const file = path.join(fontsRoot, font.file);
      try {
        const bytes = await readFile(file);
        if (bytes.byteLength === 0) {
          errors.push(`font file is empty: ${file}`);
        } else {
          fonts.push({ family: font.family, weight: font.weight, base64: bytes.toString("base64") });
        }
      } catch {
        errors.push(`font file is missing: ${file} (install the @fontsource packages with npm ci)`);
      }
    }
    if (errors.length > 0) return { ok: false, errors };

    // 2. Bundle in memory.
    let esbuild;
    try {
      esbuild = await import("esbuild");
    } catch (error) {
      return {
        ok: false,
        errors: [`esbuild cannot be loaded (run npm ci in frontend/): ${messageOf(error)}`],
      };
    }
    const build = esbuild.build ?? esbuild.default?.build;
    const tsconfig = path.join(root, "tsconfig.json");
    let bundle;
    try {
      bundle = await build({
        absWorkingDir: root,
        entryPoints: [ENTRY],
        bundle: true,
        format: "iife",
        platform: "browser",
        target: "es2022",
        minify: true,
        sourcemap: false,
        define: { "process.env.NODE_ENV": '"production"' },
        jsx: "automatic",
        write: false,
        metafile: true,
        legalComments: "none",
        logLevel: "silent",
        ...(existsSync(tsconfig) ? { tsconfig } : {}),
      });
    } catch (error) {
      return { ok: false, errors: esbuildErrorLines(error) };
    }
    if (bundle.outputFiles?.length !== 1) {
      return {
        ok: false,
        errors: [`expected one output file from esbuild, got ${bundle.outputFiles?.length ?? 0}`],
      };
    }
    const script = bundle.outputFiles[0].contents;

    // 3. Check the bundle and the page.
    const problems = checkSingleCopy(bundle.metafile.inputs);
    if (script.byteLength > maxRuntimeBytes) {
      problems.push(`runtime.js is ${script.byteLength} bytes, over the limit of ${maxRuntimeBytes}`);
    }
    const html = renderRuntimeHtml({ csp, tokens, fonts });
    for (const problem of checkRuntimeHtml(html)) problems.push(`runtime.html: ${problem}`);
    if (problems.length > 0) return { ok: false, errors: problems };

    // 4. Write both files under temporary names, then move them into place.
    await mkdir(outDir, { recursive: true });
    const jsFile = path.join(outDir, "runtime.js");
    const htmlFile = path.join(outDir, "runtime.html");
    const jsTemporary = `${jsFile}.${suffix}`;
    const htmlTemporary = `${htmlFile}.${suffix}`;
    temporaries.push(jsTemporary, htmlTemporary);
    await writeFile(jsTemporary, script);
    await writeFile(htmlTemporary, html, "utf8");
    await rename(jsTemporary, jsFile);
    await rename(htmlTemporary, htmlFile);

    return {
      ok: true,
      outDir,
      runtimeBytes: script.byteLength,
      htmlBytes: Buffer.byteLength(html, "utf8"),
      warnings: (bundle.warnings ?? []).map((warning) => warning.text),
      metafile: bundle.metafile,
    };
  } catch (error) {
    return { ok: false, errors: [`unexpected failure: ${messageOf(error)}`] };
  } finally {
    await Promise.all(temporaries.map((file) => rm(file, { force: true }).catch(() => undefined)));
  }
}

/** Option names `runCli` accepts, each with the `buildSandbox` option it sets. */
const FLAGS = {
  "--out": "outDir",
  "--fonts-root": "fontsRoot",
  "--tokens": "tokensCssPath",
};

/**
 * Command line of the script: `node scripts/build-sandbox.mjs [--out DIR] [--fonts-root DIR]
 * [--tokens FILE]`. No flags means the real repository. Returns the exit code instead of exiting.
 *
 * @param {readonly string[]} argv
 * @param {{ stdout: { write(text: string): unknown }, stderr: { write(text: string): unknown } }} [io]
 * @returns {Promise<number>} 0 when `runtime.js` and `runtime.html` were written, 1 otherwise
 */
export async function runCli(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = FLAGS[argv[index]];
    const value = argv[index + 1];
    if (key === undefined || value === undefined) {
      io.stderr.write(
        `build-sandbox: unexpected argument ${JSON.stringify(argv[index])}. ` +
          "Usage: build-sandbox.mjs [--out DIR] [--fonts-root DIR] [--tokens FILE]\n",
      );
      return 1;
    }
    options[key] = path.resolve(value);
  }
  const result = await buildSandbox(options);
  if (!result.ok) {
    const lines = result.errors.map((error) => `  - ${error}`).join("\n");
    io.stderr.write(`build-sandbox: FAILED, nothing was written\n${lines}\n`);
    return 1;
  }
  for (const warning of result.warnings) io.stderr.write(`build-sandbox: warning: ${warning}\n`);
  io.stdout.write(
    `build-sandbox: wrote runtime.js (${result.runtimeBytes} bytes) and runtime.html ` +
      `(${result.htmlBytes} bytes) to ${result.outDir}\n`,
  );
  return 0;
}

/** True when this file is the script Node was started with (not when a test imports it). */
function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exitCode = await runCli(process.argv.slice(2));
}
