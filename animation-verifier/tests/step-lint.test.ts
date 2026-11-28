// Tes langkah 3, ESLint dan pemindai direktif (tugas 5.2; Requirement 8.1, 8.2, 8.10, 8.11, 8.12,
// 8.15, 6.15; design 5.6). Yang diuji: pemetaan pesan ESLint ke Diagnostic (kode `ESLINT_<RULE>`,
// `ESLINT_PARSE_ERROR`, severity, posisi, `tool`), komentar direktif yang tidak berlaku tetapi
// tetap dilaporkan, galat internal yang menjadi `VERIFIER_INTERNAL`, keterpasangan di registri dan
// pipeline, korpus `fixtures/good` yang bebas galat ESLint, dan tata letak build yang menjaga
// `dist/handler.js` (bukan `dist/src/handler.js`). ESLint dan parser TypeScript dimuat sekali per
// berkas tes dan butuh beberapa detik pada pemanggilan pertama, jadi batas waktu dinaikkan.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../src/clock.js";
import { loadContract, type Contract } from "../src/contract.js";
import { CONFIG_LOCATIONS, eslintCode, isEslintDirective, lintStep } from "../src/steps/lint.js";
import { DEFAULT_STEPS } from "../src/steps/registry.js";
import { sizeStep } from "../src/steps/size.js";
import { createStepContext, indexSteps } from "../src/steps/step.js";
import type { Diagnostic } from "../src/types.js";
import { safeVerify } from "../src/verify.js";

vi.setConfig({ testTimeout: 60_000 });

// ---- kontrak dan pembantu ----

const PACKAGE_URL = new URL("../", import.meta.url);
const loaded = loadContract(
  JSON.parse(readFileSync(new URL("contract/animation-contract.json", PACKAGE_URL), "utf8")),
);
if (!loaded.ok) throw new Error(`kontrak sumber tidak sah: ${loaded.reason}`);
const contract: Contract = loaded.contract;

function inputFor(source: string, kind: "lesson" | "puzzle" = "lesson") {
  return {
    source,
    kind,
    required_tokens: [],
    forbidden_tokens: [],
    contract_version: contract.contract_version,
  };
}

async function runLint(source: string, using: Contract = contract): Promise<readonly Diagnostic[]> {
  const context = createStepContext({
    input: inputFor(source),
    contract: using,
    clock: new FakeClock(),
    deadlineAt: Number.POSITIVE_INFINITY,
  });
  return (await lintStep.run(context)).diagnostics;
}

const codesOf = (diagnostics: readonly Diagnostic[]): string[] =>
  diagnostics.map((diagnostic) => diagnostic.code);

const find = (diagnostics: readonly Diagnostic[], code: string): Diagnostic | undefined =>
  diagnostics.find((diagnostic) => diagnostic.code === code);

/** Main_File terkecil yang bersih bagi semua aturan ESLint langkah ini. */
const CLEAN_MAIN = `import { createElement } from "react";
import { useCurrentFrame } from "remotion";

export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };

export default function Main() {
  const frame = useCurrentFrame();
  return createElement("div", null, String(frame));
}
`;

/** `CLEAN_MAIN` dengan `extra` disisipkan sebelum `export default`, supaya baris lain tetap tetap. */
function withExtra(extra: string): string {
  return CLEAN_MAIN.replace("export default", `${extra}\nexport default`);
}

// ---- pemetaan pesan ESLint ----

describe("langkah 3: pemetaan pesan ESLint", () => {
  it("Main_File bersih tidak menghasilkan Diagnostic", async () => {
    expect(await runLint(CLEAN_MAIN)).toEqual([]);
  });

  it("@typescript-eslint/no-explicit-any menjadi ESLINT_TYPESCRIPT_ESLINT_NO_EXPLICIT_ANY dengan tool eslint", async () => {
    const diagnostics = await runLint(withExtra("export const pick = (value: any) => value;"));
    expect(diagnostics.filter((d) => d.code.includes("EXPLICIT_ANY"))).toEqual([
      {
        tool: "eslint",
        code: "ESLINT_TYPESCRIPT_ESLINT_NO_EXPLICIT_ANY",
        severity: "error",
        message: "Unexpected any. Specify a different type.",
        line: 6,
        column: 29,
      },
    ]);
  });

  it("aturan inti ESLint tanpa awalan `@` menjadi ESLINT_<RULE> (no-var)", async () => {
    // `var` di level modul juga ditolak plugin lore; keduanya dilaporkan dalam satu lintasan.
    const diagnostics = await runLint(withExtra("var legacy = 1;\nexport { legacy };"));
    expect(codesOf(diagnostics)).toEqual(
      expect.arrayContaining(["ESLINT_NO_VAR", "ESLINT_LORE_NO_MODULE_STATE"]),
    );
  });

  it("kesalahan sintaks menjadi ESLINT_PARSE_ERROR (error, dengan posisi)", async () => {
    const diagnostics = await runLint("export const = ;\n");
    expect(diagnostics).toHaveLength(1);
    const [parseError] = diagnostics;
    expect(parseError).toMatchObject({
      tool: "eslint",
      code: "ESLINT_PARSE_ERROR",
      severity: "error",
      line: 1,
    });
    expect(parseError?.column).toBeGreaterThanOrEqual(1);
    expect(parseError?.message.length).toBeGreaterThan(0);
  });

  it("aturan plugin lore dipetakan ke ESLINT_LORE_* (no-module-state, uses-frame)", async () => {
    const stateful = await runLint(withExtra("let tick = 0;\nexport const bump = () => { tick += 1; };"));
    expect(find(stateful, "ESLINT_LORE_NO_MODULE_STATE")).toMatchObject({
      tool: "eslint",
      severity: "error",
      message: "module-level state is not allowed: tick",
    });

    const frameless = await runLint(
      'export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };\nexport default function Main() { return null; }\n',
    );
    expect(find(frameless, "ESLINT_LORE_USES_FRAME")).toMatchObject({
      tool: "eslint",
      severity: "error",
      line: 1,
      column: 1,
    });
  });

  it("lore/kit-style menjadi warning ESLINT_LORE_KIT_STYLE (severity ESLint 1) dari opsi kontrak", async () => {
    const styled = CLEAN_MAIN.replace(
      'createElement("div", null, String(frame))',
      'createElement("div", { style: { borderRadius: 8, fontFamily: "Arial" } }, String(frame))',
    );
    const diagnostics = await runLint(styled);
    const kit = diagnostics.filter((d) => d.code === "ESLINT_LORE_KIT_STYLE");
    expect(kit).toHaveLength(2);
    for (const diagnostic of kit) {
      expect(diagnostic).toMatchObject({ tool: "eslint", severity: "warning", line: 8 });
    }
    expect(diagnostics.every((d) => d.severity === "warning")).toBe(true);
  });

  it("opsi kit-style berasal dari kontrak yang dipakai, bukan dari literal di langkah", async () => {
    const styled = CLEAN_MAIN.replace(
      'createElement("div", null, String(frame))',
      'createElement("div", { style: { fontFamily: "var(--font-mono)" } }, String(frame))',
    );
    expect(await runLint(styled)).toEqual([]);
    const narrowed: Contract = { ...contract, font_variables: ["--font-display"] };
    expect(codesOf(await runLint(styled, narrowed))).toEqual(["ESLINT_LORE_KIT_STYLE"]);
  });

  it("setiap kode dan tool yang dihasilkan sah menurut regex kontrak", async () => {
    const messy = withExtra(
      'var legacy = 1;\nexport const pick = (value: any) => value;\nexport { legacy };\n/* eslint-disable */',
    );
    const diagnostics = await runLint(messy);
    expect(diagnostics.length).toBeGreaterThan(3);
    for (const diagnostic of diagnostics) {
      expect(diagnostic.code).toMatch(contract.diagnosticCodeRegex);
      expect(diagnostic.tool).toBe("eslint");
      expect(diagnostic.message.length).toBeLessThanOrEqual(contract.limits.diagnostic_message_max_chars);
    }
  });

  it("eslintCode: awalan @ dibuang, / dan - menjadi _, karakter lain dinormalkan ke [A-Z0-9_]", () => {
    expect(eslintCode(null)).toBe("ESLINT_PARSE_ERROR");
    expect(eslintCode("@typescript-eslint/no-explicit-any")).toBe(
      "ESLINT_TYPESCRIPT_ESLINT_NO_EXPLICIT_ANY",
    );
    expect(eslintCode("no-unused-vars")).toBe("ESLINT_NO_UNUSED_VARS");
    expect(eslintCode("lore/kit-style")).toBe("ESLINT_LORE_KIT_STYLE");
    expect(eslintCode("lore/no-module-state")).toBe("ESLINT_LORE_NO_MODULE_STATE");
    expect(eslintCode("plugin/rule.name:v2")).toBe("ESLINT_PLUGIN_RULE_NAME_V2");
    expect(eslintCode("@scope/plugin/some-rule")).toBe("ESLINT_SCOPE_PLUGIN_SOME_RULE");
    expect(eslintCode("@a/b/c")).toMatch(contract.diagnosticCodeRegex);
  });
});

// ---- direktif inline ----

/** Satu komentar pada baris 1 dari sumber yang selebihnya bersih. */
async function directivesIn(comment: string): Promise<readonly Diagnostic[]> {
  const diagnostics = await runLint(`${comment}\n${CLEAN_MAIN}`);
  return diagnostics.filter((d) => d.code === "ESLINT_INLINE_DIRECTIVE");
}

describe("langkah 3: ESLINT_INLINE_DIRECTIVE", () => {
  const FLAGGED = [
    "/* eslint-disable */",
    "/*eslint-disable*/",
    "/* eslint-disable no-var */",
    "/* eslint-disable-line */",
    "/* eslint-disable-next-line no-var */",
    "/* eslint-enable */",
    "/* eslint-env browser */",
    "/* eslint no-var: 0 */",
    "/* globals window */",
    "/* global window */",
    "/* eslint-disable -- alasan */",
    "// eslint-disable-next-line no-var",
    "// eslint-disable-line no-var",
    "// eslint-disable",
    "// eslint-enable",
    "// eslint-env node",
    "//eslint-disable-line",
    "   // eslint-disable-line   ",
  ];

  for (const comment of FLAGGED) {
    it(`melaporkan ${JSON.stringify(comment)} (error, pada awal komentar)`, async () => {
      const found = await directivesIn(comment);
      expect(found).toEqual([
        {
          tool: "eslint",
          code: "ESLINT_INLINE_DIRECTIVE",
          severity: "error",
          message: "eslint directive comments are not allowed",
          line: 1,
          column: comment.length - comment.trimStart().length + 1,
        },
      ]);
    });
  }

  const IGNORED = [
    "// eslint is a linter",
    "// globals are not allowed here",
    "// global state is bad",
    "// eslint-disabled",
    "// see eslint-disable for details",
    "/** eslint-disable */",
    "/* not an eslint-disable */",
    "/* eslinted */",
    "// ts-ignore is a different check",
  ];

  for (const comment of IGNORED) {
    it(`tidak melaporkan ${JSON.stringify(comment)}`, async () => {
      expect(await directivesIn(comment)).toEqual([]);
    });
  }

  it("tidak melaporkan teks mirip direktif di dalam string, template, atau regex", async () => {
    const source = withExtra(
      [
        'export const a = "// eslint-disable";',
        "export const b = '/* eslint-disable */';",
        "export const c = `// eslint-disable-line ${1 + 1} /* eslint-env node */`;",
        "export const d = /\\/\\/ eslint-disable/;",
        'export const e = /"/.test("x") ? 1 : 2;',
      ].join("\n"),
    );
    expect(codesOf(await runLint(source))).not.toContain("ESLINT_INLINE_DIRECTIVE");
  });

  it("menemukan komentar yang muncul sesudah regex, template bersarang, dan pembagian", async () => {
    const source = withExtra(
      [
        'export const r = /"/; // eslint-disable-line',
        "export const t = `a ${`b ${1}`} c`; // eslint-disable-line",
        "export const q = 4 / 2; /* eslint-disable */",
        "export const u = [1, 2].length / 2; // eslint-disable-line",
      ].join("\n"),
    );
    const found = (await runLint(source)).filter((d) => d.code === "ESLINT_INLINE_DIRECTIVE");
    expect(found.map((d) => d.line)).toEqual([6, 7, 8, 9]);
  });

  it("melaporkan setiap direktif, masing-masing dengan baris dan kolomnya", async () => {
    const source = `/* eslint-disable */\n${CLEAN_MAIN}// eslint-disable-line\n`;
    const found = (await runLint(source)).filter((d) => d.code === "ESLINT_INLINE_DIRECTIVE");
    expect(found.map((d) => [d.line, d.column])).toEqual([
      [1, 1],
      [CLEAN_MAIN.split("\n").length + 1, 1],
    ]);
  });

  it("direktif tidak berlaku: temuan yang hendak dimatikan tetap dilaporkan, tanpa ESLINT_PARSE_ERROR", async () => {
    const diagnostics = await runLint(
      `/* eslint-disable */\n${withExtra("export const pick = (value: any) => value; // eslint-disable-line")}`,
    );
    const codes = codesOf(diagnostics);
    expect(codes).toContain("ESLINT_TYPESCRIPT_ESLINT_NO_EXPLICIT_ANY");
    expect(codes).toContain("ESLINT_INLINE_DIRECTIVE");
    // Pesan "has no effect because you have 'noInlineConfig'" milik ESLint diabaikan.
    expect(codes).not.toContain("ESLINT_PARSE_ERROR");
    expect(diagnostics.filter((d) => d.message.includes("noInlineConfig"))).toEqual([]);
  });

  it("isEslintDirective: komentar blok lebih luas daripada komentar baris", () => {
    const at = { line: 1, column: 1 };
    expect(isEslintDirective({ kind: "block", value: " globals x ", ...at })).toBe(true);
    expect(isEslintDirective({ kind: "line", value: " globals x", ...at })).toBe(false);
    expect(isEslintDirective({ kind: "line", value: " eslint-disable-line", ...at })).toBe(true);
    expect(isEslintDirective({ kind: "block", value: "", ...at })).toBe(false);
  });
});

// ---- galat internal ----

describe("langkah 3: galat internal", () => {
  it("pola emoji kontrak yang bukan regex sah menjadi satu VERIFIER_INTERNAL tanpa teks exception", async () => {
    const broken: Contract = {
      ...contract,
      kit_style_warnings: { ...contract.kit_style_warnings, emoji_pattern: "(unclosed" },
    };
    const diagnostics = await runLint(CLEAN_MAIN, broken);
    expect(diagnostics).toEqual([
      {
        tool: "verifier",
        code: "VERIFIER_INTERNAL",
        severity: "error",
        message: "internal verifier error",
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("unclosed");
  });

  it("lewat pipeline, galat internal membuat ok false dan checks mencatat langkah eslint gagal", async () => {
    const broken: Contract = {
      ...contract,
      kit_style_warnings: { ...contract.kit_style_warnings, emoji_pattern: "[" },
    };
    const result = await safeVerify(
      inputFor(CLEAN_MAIN),
      { clock: new FakeClock(), contract: broken, steps: [sizeStep, lintStep] },
    );
    expect(result.ok).toBe(false);
    expect(codesOf(result.diagnostics)).toEqual(["VERIFIER_INTERNAL"]);
    expect(result.summary.checks.map((check) => [check.name, check.ok])).toEqual([
      ["size", true],
      ["eslint", false],
    ]);
  });
});

// ---- registri dan pipeline ----

describe("langkah 3: registri dan pipeline", () => {
  it("DEFAULT_STEPS memuat lintStep sebagai langkah bernomor 3, dan registri tetap valid", () => {
    expect(lintStep.number).toBe(3);
    expect(DEFAULT_STEPS.find((step) => step.number === 3)).toBe(lintStep);
    expect(indexSteps(DEFAULT_STEPS).ok).toBe(true);
  });

  it("langkah 1 yang gagal menghentikan pipeline sebelum ESLint", async () => {
    const huge = `${CLEAN_MAIN}// ${"x".repeat(contract.limits.source_max_bytes)}\n`;
    const result = await safeVerify(inputFor(huge), {
      clock: new FakeClock(),
      contract,
      steps: [sizeStep, lintStep],
    });
    expect(result.summary.checks.map((check) => check.name)).toEqual(["size"]);
    expect(codesOf(result.diagnostics)).toEqual(["SIZE_SOURCE_TOO_LARGE"]);
  });

  it("temuan ESLint masuk Verifier_Result: warning tidak mengubah ok, error mengubahnya", async () => {
    const run = (source: string) =>
      safeVerify(inputFor(source), { clock: new FakeClock(), contract, steps: [sizeStep, lintStep] });

    const bad = await run(withExtra("export const pick = (value: any) => value;"));
    expect(bad.ok).toBe(false);
    expect(bad.diagnostics.map((d) => d.tool)).toEqual(["eslint"]);
    expect(bad.summary.checks.map((c) => [c.name, c.ok])).toEqual([
      ["size", true],
      ["eslint", false],
    ]);
    expect("bundle" in bad).toBe(false);
    expect("meta" in bad).toBe(false);
  });

  it("dua kali jalan menghasilkan Diagnostic identik dan berurutan menurut posisi", async () => {
    const source = `/* eslint-disable */\n${withExtra("var legacy = 1;\nexport const pick = (value: any) => value;\nexport { legacy };")}`;
    const first = await runLint(source);
    const second = await runLint(source);
    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(3);
  });
});

// ---- korpus ----

describe("langkah 3: korpus fixtures/good", () => {
  const GOOD_DIR = new URL("fixtures/good/", PACKAGE_URL);
  const files = readdirSync(GOOD_DIR)
    .filter((name) => name.endsWith(".ts"))
    .sort();

  it("korpus berisi sedikitnya delapan berkas", () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  for (const file of files) {
    it(`${file}: nol Diagnostic error, dan warning hanya dari lore/kit-style`, async () => {
      const diagnostics = await runLint(readFileSync(new URL(file, GOOD_DIR), "utf8"));
      expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(diagnostics.filter((d) => d.code !== "ESLINT_LORE_KIT_STYLE")).toEqual([]);
    });
  }
});

// ---- tata letak build ----

describe("tata letak build plugin dan konfigurasi", () => {
  const readJson = (relative: string): Record<string, unknown> => {
    const parsed = ts.parseConfigFileTextToJson(
      relative,
      readFileSync(new URL(relative, PACKAGE_URL), "utf8"),
    );
    return (parsed.config ?? {}) as Record<string, unknown>;
  };

  it("eslint.config.mjs berada di akar paket dan terbaca dari src (lokasi kedua)", () => {
    const second = CONFIG_LOCATIONS[1];
    expect(second).toBeDefined();
    expect(existsSync(fileURLToPath(second as URL))).toBe(true);
    expect(fileURLToPath(second as URL)).toBe(fileURLToPath(new URL("eslint.config.mjs", PACKAGE_URL)));
    expect(existsSync(fileURLToPath(new URL("eslint.config.d.mts", PACKAGE_URL)))).toBe(true);
  });

  it("skrip build mengompilasi src lalu plugin, dan tsconfig plugin menulis ke dist/eslint-plugin-lore", () => {
    const pkg = JSON.parse(readFileSync(new URL("package.json", PACKAGE_URL), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.build).toBe("tsc -p tsconfig.json && tsc -p eslint-plugin-lore/tsconfig.json");
    const plugin = readJson("eslint-plugin-lore/tsconfig.json") as {
      extends: string;
      compilerOptions: Record<string, unknown>;
    };
    expect(plugin.extends).toBe("../tsconfig.json");
    expect(plugin.compilerOptions.rootDir).toBe(".");
    expect(plugin.compilerOptions.outDir).toBe("../dist/eslint-plugin-lore");
  });

  it("build utama tidak memakai allowJs dan memancarkan dist/handler.js, bukan dist/src/handler.js", () => {
    const config = ts.getParsedCommandLineOfConfigFile(
      fileURLToPath(new URL("tsconfig.json", PACKAGE_URL)),
      {},
      { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
    );
    expect(config).toBeDefined();
    expect(config?.options.allowJs).toBeUndefined();
    const program = ts.createProgram({
      rootNames: config?.fileNames ?? [],
      options: { ...config?.options, noEmitOnError: false },
    });
    const written: string[] = [];
    program.emit(undefined, (fileName) => {
      written.push(fileName); // tidak menulis ke disk
    });
    const dist = fileURLToPath(new URL("dist/", PACKAGE_URL));
    expect(written).toContain(`${dist}handler.js`);
    expect(written).toContain(`${dist}steps/lint.js`);
    expect(written.filter((fileName) => fileName.startsWith(`${dist}src/`))).toEqual([]);
    expect(written.filter((fileName) => fileName.includes("eslint-plugin-lore"))).toEqual([]);
  });
});
