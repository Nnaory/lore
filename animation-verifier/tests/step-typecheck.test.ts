// Tes langkah 4, typecheck dengan compiler TypeScript (tugas 5.3; Requirement 8.3, 8.4, 8.10, 8.15,
// 7.3; design 5.7). Yang diuji: pemetaan galat compiler ke Diagnostic (`TSC_<kode>`, baris dan kolom
// basis 1, severity, `tool`, pemotongan 200 karakter), opsi compiler (strict, lib ES2022 dan DOM,
// `types: []`), deklarasi `react` dan `remotion` yang benar-benar terbaca, hermetisitas host (hanya
// `node_modules` paket dan direktori lib yang dibaca), tidak ada jalur absolut di pesan, direktif
// penekan galat (`TSC_SUPPRESSION_DIRECTIVE`), cache `SourceFile` yang dibuktikan lewat pembacaan
// disk (bukan waktu), galat internal bila deklarasi tidak ada, keterpasangan di registri dan pipeline,
// dan korpus `fixtures/good` yang bebas galat `TSC_*`. Program pertama memuat lib DOM dan deklarasi
// paket (sekitar setengah detik); batas waktu dinaikkan agar mesin lambat tidak menggagalkan tes.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../src/clock.js";
import { loadContract, type Contract } from "../src/contract.js";
import { DEFAULT_STEPS } from "../src/steps/registry.js";
import { sizeStep } from "../src/steps/size.js";
import { createStepContext, indexSteps, type VerifierStep } from "../src/steps/step.js";
import {
  PKG_ROOT,
  TYPECHECK_COMPILER_OPTIONS,
  createTypecheckStep,
  isTsSuppressionDirective,
  resetTypecheckCache,
  scrubPaths,
  typecheckStep,
} from "../src/steps/typecheck.js";
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

function inputFor(source: string) {
  return {
    source,
    kind: "lesson" as const,
    required_tokens: [],
    forbidden_tokens: [],
    contract_version: contract.contract_version,
  };
}

async function runTsc(
  source: string,
  step: VerifierStep = typecheckStep,
): Promise<readonly Diagnostic[]> {
  const context = createStepContext({
    input: inputFor(source),
    contract,
    clock: new FakeClock(),
    deadlineAt: Number.POSITIVE_INFINITY,
  });
  return (await step.run(context)).diagnostics;
}

const codesOf = (diagnostics: readonly Diagnostic[]): string[] =>
  diagnostics.map((diagnostic) => diagnostic.code);

/** Main_File terkecil yang bersih bagi compiler. Baris 6 adalah `export default`. */
const CLEAN_MAIN = `import { createElement } from "react";
import { useCurrentFrame } from "remotion";

export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };

export default function Main() {
  const frame = useCurrentFrame();
  return createElement("div", null, String(frame));
}
`;

/** `CLEAN_MAIN` dengan `extra` disisipkan sebelum `export default` (mulai baris 6). */
function withExtra(extra: string): string {
  return CLEAN_MAIN.replace("export default", `${extra}\nexport default`);
}

const VIRTUAL_PATH = `${PKG_ROOT}/__virtual__/main.ts`;

afterEach(() => {
  vi.restoreAllMocks();
});

// ---- pemetaan galat compiler ----

describe("langkah 4: pemetaan galat compiler", () => {
  it("Main_File bersih tidak menghasilkan Diagnostic", async () => {
    expect(await runTsc(CLEAN_MAIN)).toEqual([]);
  });

  it("galat tipe menjadi TSC_2322 dengan baris dan kolom basis 1, tool tsc, severity error", async () => {
    const diagnostics = await runTsc(withExtra('export const count: number = "x";'));
    expect(diagnostics).toEqual([
      {
        tool: "tsc",
        code: "TSC_2322",
        severity: "error",
        message: "Type 'string' is not assignable to type 'number'.",
        line: 6,
        column: 14,
      },
    ]);
  });

  it("kolom dihitung dalam unit UTF-16 dan baris mengikuti CRLF", async () => {
    const line = 'export const s = "\u{1F600}"; export const n: number = "x";';
    const source = withExtra(line).replaceAll("\n", "\r\n");
    const [found] = (await runTsc(source)).filter((d) => d.code === "TSC_2322");
    // `indexOf` pada string JS menghitung unit UTF-16, seperti compiler; emoji bernilai dua unit.
    expect(found).toMatchObject({ line: 6, column: line.indexOf("n: number") + 1 });
    expect(line.indexOf("n: number")).toBeGreaterThan([...line].indexOf("n"));
  });

  it("kode galat memakai nomor diagnostik compiler apa adanya dan sah menurut regex kontrak", async () => {
    const diagnostics = await runTsc(
      withExtra(
        [
          "export const untyped = (x) => x;",
          "export const nothing: string = null;",
          "export const missing = unknownName;",
        ].join("\n"),
      ),
    );
    expect(codesOf(diagnostics).sort()).toEqual(["TSC_2322", "TSC_2304", "TSC_7006"].sort());
    expect(diagnostics.map((d) => d.line)).toEqual([6, 7, 8]);
    for (const diagnostic of diagnostics) {
      expect(diagnostic.code).toMatch(contract.diagnosticCodeRegex);
      expect(diagnostic.tool).toBe("tsc");
      expect(diagnostic.severity).toBe("error");
    }
  });

  it("semua galat dikumpulkan dalam satu lintasan", async () => {
    const diagnostics = await runTsc(
      withExtra('export const a: number = "x";\nexport const b: string = 1;\nexport const c: boolean = 2;'),
    );
    expect(codesOf(diagnostics)).toEqual(["TSC_2322", "TSC_2322", "TSC_2322"]);
    expect(diagnostics.map((d) => d.line)).toEqual([6, 7, 8]);
  });

  it("dua kali jalan menghasilkan Diagnostic identik", async () => {
    const source = withExtra('export const a: number = "x";\nexport const b = unknownName;');
    const first = await runTsc(source);
    expect(first.length).toBe(2);
    expect(await runTsc(source)).toEqual(first);
  });

  it("pesan dipotong ke batas kontrak (200 karakter)", async () => {
    // Dua tipe bernama sama menghasilkan pesan compiler yang jauh lebih panjang dari 200 karakter.
    const diagnostics = await runTsc(
      `import { createElement } from "react";
import { Sequence } from "remotion";
export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };
export interface SequenceProps { z: 1 }
declare const given: import("remotion").SequenceProps;
export const mine: SequenceProps = given;
export default function Main() { return createElement(Sequence); }
`,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message.length).toBe(contract.limits.diagnostic_message_max_chars);
  });
});

// ---- opsi compiler ----

describe("langkah 4: opsi compiler (design 5.7)", () => {
  it("opsi persis design 5.7", () => {
    expect(TYPECHECK_COMPILER_OPTIONS).toEqual({
      noEmit: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
      skipLibCheck: true,
      types: [],
    });
    expect(TYPECHECK_COMPILER_OPTIONS.jsx).toBeUndefined();
  });

  it("strict: null pada tipe string dan parameter tanpa tipe ditolak", async () => {
    const diagnostics = await runTsc(
      withExtra("export const a: string = null;\nexport const b = (x) => x;"),
    );
    expect(codesOf(diagnostics).sort()).toEqual(["TSC_2322", "TSC_7006"]);
  });

  it("lib DOM tersedia (document, HTMLElement) dan lib ES2022 tersedia (Object.hasOwn, Array.at)", async () => {
    const diagnostics = await runTsc(
      withExtra(
        [
          "export const title: string = document.title;",
          "export const el: HTMLElement | null = document.getElementById('x');",
          "export const own: boolean = Object.hasOwn({ a: 1 }, 'a');",
          "export const last: number | undefined = [1, 2, 3].at(-1);",
        ].join("\n"),
      ),
    );
    expect(diagnostics).toEqual([]);
  });

  it("lib melampaui ES2022 tidak tersedia (Array.findLast adalah ES2023)", async () => {
    const diagnostics = await runTsc(
      withExtra("export const hit = [1, 2, 3].findLast((n: number) => n > 1);"),
    );
    expect(codesOf(diagnostics)).toEqual(["TSC_2550"]);
  });

  it("types kosong: tidak ada tipe Node (process, Buffer, require) dan tidak ada tipe dari paket lain", async () => {
    const diagnostics = await runTsc(
      withExtra(
        [
          "export const p = process.env.X;",
          "export const b = Buffer.from('x');",
          "export const r = require('fs');",
        ].join("\n"),
      ),
    );
    expect(diagnostics).toHaveLength(3);
    expect(diagnostics.every((d) => d.code.startsWith("TSC_25") || d.code === "TSC_2304")).toBe(true);
    expect(diagnostics.map((d) => d.line)).toEqual([6, 7, 8]);
  });

  it("deklarasi react terbaca: CSSProperties dan ReactElement dikenal compiler", async () => {
    const diagnostics = await runTsc(
      `import { createElement } from "react";
import type { ReactElement, CSSProperties } from "react";
import { useCurrentFrame } from "remotion";
export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };
export const style: CSSProperties = { color: 5 };
export const el: ReactElement = "plain text";
export default function Main() { return createElement("div", null, String(useCurrentFrame())); }
`,
    );
    expect(diagnostics.map((d) => [d.code, d.line, d.message])).toEqual([
      // `Color` berasal dari `csstype`, yang diresolusi lewat deklarasi `@types/react`.
      ["TSC_2322", 5, "Type 'number' is not assignable to type 'Color | undefined'."],
      [
        "TSC_2322",
        6,
        "Type 'string' is not assignable to type 'ReactElement<unknown, string | JSXElementConstructor<any>>'.",
      ],
    ]);
  });

  it("deklarasi remotion terbaca: tipe kembalian, jumlah argumen, dan anggota ekspor dikenal", async () => {
    const diagnostics = await runTsc(
      `import { createElement } from "react";
import { useCurrentFrame, nopeExport } from "remotion";
export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };
export const text: string = useCurrentFrame();
export const arity = useCurrentFrame("x");
export default function Main() { return createElement("div", null, String(nopeExport)); }
`,
    );
    expect(diagnostics.map((d) => [d.code, d.line])).toEqual([
      ["TSC_2305", 2],
      ["TSC_2322", 4],
      ["TSC_2554", 5],
    ]);
    expect(diagnostics[0]?.message).toBe("Module '\"remotion\"' has no exported member 'nopeExport'.");
    expect(diagnostics[1]?.message).toBe("Type 'number' is not assignable to type 'string'.");
  });
});

// ---- hermetisitas ----

describe("langkah 4: host hermetik", () => {
  it("modul di luar node_modules paket tidak terbaca (fs, jalur relatif ke src paket)", async () => {
    const result = await runTsc(`import * as fs from "fs";
import * as own from "../src/types";
import * as other from "./sibling";
import { createElement } from "react";
import { useCurrentFrame } from "remotion";
export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };
export const used = [fs, own, other];
export default function Main() { return createElement("div", null, String(useCurrentFrame())); }
`);
    expect(result.map((d) => [d.code, d.line])).toEqual([
      ["TSC_2307", 1],
      ["TSC_2307", 2],
      ["TSC_2307", 3],
    ]);
    // `../src/types` ada di disk (`src/types.ts`) tetapi di luar akar yang boleh dibaca.
    expect(result[1]?.message).toBe(
      "Cannot find module '../src/types' or its corresponding type declarations.",
    );
  });

  it("host hanya menyentuh disk di bawah node_modules paket dan direktori lib TypeScript", async () => {
    resetTypecheckCache();
    const touched: string[] = [];
    const record =
      <A extends unknown[], R>(real: (...args: A) => R) =>
      (...args: A): R => {
        touched.push(String(args[0]));
        return real(...args);
      };
    vi.spyOn(ts.sys, "readFile").mockImplementation(record(ts.sys.readFile.bind(ts.sys)));
    vi.spyOn(ts.sys, "fileExists").mockImplementation(record(ts.sys.fileExists.bind(ts.sys)));
    vi.spyOn(ts.sys, "directoryExists").mockImplementation(record(ts.sys.directoryExists.bind(ts.sys)));
    vi.spyOn(ts.sys, "getDirectories").mockImplementation(record(ts.sys.getDirectories.bind(ts.sys)));

    await runTsc(
      `import * as own from "../src/types";\nimport * as fs from "fs";\nexport const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };\nexport default own;\nexport const f = fs;\n`,
    );
    const libDirectory = dirname(ts.getDefaultLibFilePath(TYPECHECK_COMPILER_OPTIONS));
    const allowed = [`${PKG_ROOT}/node_modules`, libDirectory];
    expect(touched.length).toBeGreaterThan(50);
    const outside = touched.filter(
      (path) => !allowed.some((root) => path === root || path.startsWith(`${root}/`)),
    );
    expect(outside).toEqual([]);
    expect(touched).not.toContain(VIRTUAL_PATH);
  });

  it("deklarasi paket tidak ada: satu VERIFIER_INTERNAL, bukan TSC_2307 yang dituduhkan ke pengarang", async () => {
    const root = mkdtempSync(join(tmpdir(), "lore-typecheck-"));
    try {
      const empty = await runTsc(CLEAN_MAIN, createTypecheckStep(root));
      expect(empty).toEqual([
        {
          tool: "verifier",
          code: "VERIFIER_INTERNAL",
          severity: "error",
          message: "internal verifier error",
        },
      ]);
      expect(JSON.stringify(empty)).not.toContain(root);

      // Paket ada tetapi hanya berisi JavaScript (tanpa deklarasi tipe): tetap galat internal.
      for (const name of Object.keys(contract.allowed_imports)) {
        mkdirSync(join(root, "node_modules", name), { recursive: true });
        writeFileSync(join(root, "node_modules", name, "package.json"), `{"name":"${name}","main":"index.js"}`);
        writeFileSync(join(root, "node_modules", name, "index.js"), "module.exports = {};\n");
      }
      expect(codesOf(await runTsc(CLEAN_MAIN, createTypecheckStep(root)))).toEqual(["VERIFIER_INTERNAL"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---- jalur absolut ----

describe("langkah 4: pesan tanpa jalur absolut", () => {
  it("scrubPaths membuang akar paket, node_modules, __virtual__, dan direktori lib", () => {
    expect(
      scrubPaths(
        `Type 'import("/r/node_modules/remotion/dist/cjs/Sequence").P' is not assignable to type 'import("/r/__virtual__/main").P'.`,
        "/r",
        "/ts/lib",
      ),
    ).toBe(`Type 'import("remotion/dist/cjs/Sequence").P' is not assignable to type 'import("main").P'.`);
    expect(scrubPaths("see /r/other/file.ts and /ts/lib/lib.dom.d.ts", "/r", "/ts/lib")).toBe(
      "see other/file.ts and lib.dom.d.ts",
    );
    expect(scrubPaths("tidak ada jalur", "/r", "/ts/lib")).toBe("tidak ada jalur");
  });

  it("nama tipe yang bentrok memaksa compiler menulis import(\"/abs/...\"), dan hasilnya tanpa jalur", async () => {
    const diagnostics = await runTsc(
      `import { createElement } from "react";
import { useCurrentFrame, Sequence } from "remotion";
export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };
export interface SequenceProps { z: 1 }
declare const given: import("remotion").SequenceProps;
export const mine: SequenceProps = given;
export default function Main() { return createElement(Sequence, null, String(useCurrentFrame())); }
`,
    );
    const [found] = diagnostics;
    expect(codesOf(diagnostics)).toEqual(["TSC_2322"]);
    expect(found?.message.startsWith(
      `Type 'import("remotion/dist/cjs/Sequence").SequenceProps' is not assignable to type 'import("main").SequenceProps'.`,
    )).toBe(true);
    expect(found?.message.length).toBe(contract.limits.diagnostic_message_max_chars);
    for (const diagnostic of diagnostics) {
      expect(diagnostic.message).not.toContain(PKG_ROOT);
      expect(diagnostic.message).not.toContain("node_modules");
      expect(diagnostic.message).not.toContain("__virtual__");
      expect(diagnostic.message).not.toMatch(/\/home\/|\/var\/task|\/Users\//u);
    }
  });
});

// ---- direktif penekan galat ----

/** Satu komentar pada baris 1 dari sumber yang selebihnya bersih. */
async function directivesIn(comment: string): Promise<readonly Diagnostic[]> {
  const diagnostics = await runTsc(`${comment}\n${CLEAN_MAIN}`);
  return diagnostics.filter((d) => d.code === "TSC_SUPPRESSION_DIRECTIVE");
}

describe("langkah 4: TSC_SUPPRESSION_DIRECTIVE", () => {
  const FLAGGED = [
    "// @ts-ignore",
    "// @ts-ignore: alasan",
    "//@ts-ignore",
    "/// @ts-ignore",
    "// @ts-nocheck",
    "// @ts-expect-error",
    "// @ts-expect-error TS2322",
    "/* @ts-ignore */",
    "/*@ts-nocheck*/",
    "/** @ts-expect-error */",
    "/*\n * @ts-ignore\n */",
    "/* alasan\n   @ts-expect-error */",
    "  // @ts-ignore",
    "\t/* @ts-ignore */",
  ];

  for (const comment of FLAGGED) {
    it(`melaporkan ${JSON.stringify(comment)} (error, pada awal komentar)`, async () => {
      const found = await directivesIn(comment);
      expect(found).toEqual([
        {
          tool: "tsc",
          code: "TSC_SUPPRESSION_DIRECTIVE",
          severity: "error",
          message: "@ts-ignore, @ts-nocheck and @ts-expect-error are not allowed",
          line: 1,
          column: comment.length - comment.trimStart().length + 1,
        },
      ]);
    });
  }

  const IGNORED = [
    "// ts-ignore tanpa tanda at",
    "// jangan pakai @ts-ignore di sini",
    "// lihat @ts-expect-error di dokumen",
    "/* contoh: @ts-nocheck dilarang */",
    "// @ts-check",
    "// @tsignore",
  ];

  for (const comment of IGNORED) {
    it(`tidak melaporkan ${JSON.stringify(comment)}`, async () => {
      expect(await directivesIn(comment)).toEqual([]);
    });
  }

  it("tidak melaporkan teks mirip direktif di dalam string, template, atau regex", async () => {
    const source = withExtra(
      [
        'export const a = "// @ts-ignore";',
        "export const b = '/* @ts-nocheck */';",
        "export const c = `// @ts-expect-error ${1 + 1} /* @ts-ignore */`;",
        "export const d = /\\/\\/ @ts-expect-error/;",
      ].join("\n"),
    );
    expect(await runTsc(source)).toEqual([]);
  });

  it("melaporkan setiap direktif dengan baris dan kolomnya, dan galat tipe lain tetap dilaporkan", async () => {
    const source = withExtra(
      '// @ts-expect-error\nexport const fine = 1;\nexport const bad: number = "x";\n  /* @ts-ignore */',
    );
    const diagnostics = await runTsc(source);
    const directives = diagnostics.filter((d) => d.code === "TSC_SUPPRESSION_DIRECTIVE");
    expect(directives.map((d) => [d.line, d.column])).toEqual([
      [6, 1],
      [9, 3],
    ]);
    // `@ts-expect-error` di atas baris yang tidak bergalat dilaporkan compiler sebagai TS2578,
    // dan galat tipe yang tidak ditekan tetap muncul.
    expect(codesOf(diagnostics)).toEqual(expect.arrayContaining(["TSC_2578", "TSC_2322"]));
  });

  it("@ts-nocheck menyembunyikan galat tipe di compiler, jadi direktif itu sendiri yang dilaporkan", async () => {
    const diagnostics = await runTsc(`// @ts-nocheck\n${withExtra('export const bad: number = "x";')}`);
    expect(codesOf(diagnostics)).toEqual(["TSC_SUPPRESSION_DIRECTIVE"]);
  });

  it("isTsSuppressionDirective: tiap baris komentar blok diperiksa, komentar baris hanya isinya", () => {
    const at = { line: 1, column: 1 };
    expect(isTsSuppressionDirective({ kind: "line", value: " @ts-ignore", ...at })).toBe(true);
    expect(isTsSuppressionDirective({ kind: "line", value: "/ @ts-ignore", ...at })).toBe(true);
    expect(isTsSuppressionDirective({ kind: "line", value: " catatan @ts-ignore", ...at })).toBe(false);
    expect(isTsSuppressionDirective({ kind: "block", value: "\n * x\n * @ts-nocheck\n ", ...at })).toBe(true);
    expect(isTsSuppressionDirective({ kind: "block", value: "\u2028@ts-ignore", ...at })).toBe(true);
    expect(isTsSuppressionDirective({ kind: "block", value: "", ...at })).toBe(false);
    expect(isTsSuppressionDirective({ kind: "block", value: " @ts-check ", ...at })).toBe(false);
  });
});

// ---- cache ----

describe("langkah 4: cache SourceFile lib dan deklarasi", () => {
  /** Jalur berkas deklarasi (`.d.ts`) yang dibaca dari disk selama `action`. */
  async function declarationReads(action: () => Promise<unknown>): Promise<string[]> {
    const reads: string[] = [];
    const real = ts.sys.readFile.bind(ts.sys);
    vi.spyOn(ts.sys, "readFile").mockImplementation((path, encoding) => {
      if (path.endsWith(".d.ts")) reads.push(path);
      return real(path, encoding);
    });
    try {
      await action();
    } finally {
      vi.restoreAllMocks();
    }
    return reads;
  }

  it("invokasi pertama membaca lib dan deklarasi dari disk; invokasi kedua tidak membaca satu pun", async () => {
    resetTypecheckCache();
    const cold = await declarationReads(() => runTsc(CLEAN_MAIN));
    const libDirectory = dirname(ts.getDefaultLibFilePath(TYPECHECK_COMPILER_OPTIONS));
    expect(cold).toContain(`${libDirectory}/lib.dom.d.ts`);
    expect(cold).toContain(`${libDirectory}/lib.es2022.d.ts`);
    expect(cold).toContain(`${PKG_ROOT}/node_modules/@types/react/index.d.ts`);
    expect(cold).toContain(`${PKG_ROOT}/node_modules/remotion/dist/cjs/index.d.ts`);
    // Setiap berkas dibaca paling banyak sekali, sehingga tidak ada yang di-parse dua kali.
    expect(new Set(cold).size).toBe(cold.length);

    const warm = await declarationReads(() => runTsc(withExtra('export const other = "berbeda";')));
    expect(warm).toEqual([]);
  });

  it("main.ts tidak pernah masuk cache: sumber berbeda memberi hasil berbeda pada invokasi hangat", async () => {
    await runTsc(CLEAN_MAIN);
    const bad = await runTsc(withExtra('export const n: number = "x";'));
    expect(codesOf(bad)).toEqual(["TSC_2322"]);
    expect(await runTsc(CLEAN_MAIN)).toEqual([]);
  });

  it("hasil invokasi dingin dan hangat untuk sumber yang sama identik", async () => {
    const source = withExtra('export const n: number = "x";\nexport const m = missingName;');
    resetTypecheckCache();
    const cold = await runTsc(source);
    const warm = await runTsc(source);
    expect(cold.length).toBe(2);
    expect(warm).toEqual(cold);
  });

  it("resetTypecheckCache membuat invokasi berikutnya membaca disk lagi", async () => {
    await runTsc(CLEAN_MAIN);
    resetTypecheckCache();
    const reads = await declarationReads(() => runTsc(CLEAN_MAIN));
    expect(reads.length).toBeGreaterThan(50);
  });
});

// ---- registri dan pipeline ----

describe("langkah 4: registri dan pipeline", () => {
  it("DEFAULT_STEPS memuat typecheckStep sebagai langkah bernomor 4, dan registri tetap valid", () => {
    expect(typecheckStep.number).toBe(4);
    expect(DEFAULT_STEPS.find((step) => step.number === 4)).toBe(typecheckStep);
    expect(indexSteps(DEFAULT_STEPS).ok).toBe(true);
  });

  it("temuan compiler masuk Verifier_Result: ok false, tool tsc, checks mencatat langkah tsc gagal", async () => {
    const result = await safeVerify(inputFor(withExtra('export const n: number = "x";')), {
      clock: new FakeClock(),
      contract,
      steps: [sizeStep, typecheckStep],
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => [d.tool, d.code, d.line, d.column])).toEqual([
      ["tsc", "TSC_2322", 6, 14],
    ]);
    expect(result.summary.checks.map((check) => [check.name, check.ok])).toEqual([
      ["size", true],
      ["tsc", false],
    ]);
    expect("bundle" in result).toBe(false);
    expect("meta" in result).toBe(false);
  });

  it("langkah 1 yang gagal menghentikan pipeline sebelum typecheck", async () => {
    const huge = `${CLEAN_MAIN}// ${"x".repeat(contract.limits.source_max_bytes)}\n`;
    const result = await safeVerify(inputFor(huge), {
      clock: new FakeClock(),
      contract,
      steps: [sizeStep, typecheckStep],
    });
    expect(result.summary.checks.map((check) => check.name)).toEqual(["size"]);
    expect(codesOf(result.diagnostics)).toEqual(["SIZE_SOURCE_TOO_LARGE"]);
  });
});

// ---- korpus ----

describe("langkah 4: korpus fixtures/good", () => {
  const GOOD_DIR = new URL("fixtures/good/", PACKAGE_URL);
  const files = readdirSync(GOOD_DIR)
    .filter((name) => name.endsWith(".ts"))
    .sort();

  it("korpus berisi sedikitnya delapan berkas", () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  for (const file of files) {
    it(`${file}: nol Diagnostic TSC_*`, async () => {
      const diagnostics = await runTsc(readFileSync(new URL(file, GOOD_DIR), "utf8"));
      expect(diagnostics.filter((d) => d.code.startsWith("TSC_"))).toEqual([]);
      expect(diagnostics).toEqual([]);
    });
  }
});
