// Tes gerbang untuk pemindai komentar (`src/policy/comments.ts`; follow-up bug 5.3 pada tugas 5.2).
// Bug: heuristik "token sebelumnya" membaca `/` sesudah `!` (non-null) sebagai awal regex, sehingga
// `a! / 2; // @ts-ignore` kehilangan komentarnya dan `TSC_SUPPRESSION_DIRECTIVE` serta
// `ESLINT_INLINE_DIRECTIVE` lolos di gerbang kualitas. Tes ini menguji akibatnya di langkah 3 dan 4
// (bukan hanya `scanComments`), menjaga bahwa sumber yang bersarang sangat dalam (jalur cadangan
// pemindai) tetap ditolak pipeline, dan membandingkan pemindai dengan compiler TypeScript itu sendiri:
// untuk sumber yang valid secara sintaks, komentar `@ts-ignore` yang menekan galat di compiler
// HARUS ditemukan pemindai, dengan posisi yang tepat dan tanpa komentar tambahan (tanpa temuan palsu).
import { readdirSync, readFileSync } from "node:fs";
import fc from "fast-check";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../src/clock.js";
import { loadContract, type Contract } from "../src/contract.js";
import { createVirtualProgram } from "../src/host/ts-host.js";
import { scanComments } from "../src/policy/comments.js";
import { lintStep } from "../src/steps/lint.js";
import { sizeStep } from "../src/steps/size.js";
import { typecheckStep } from "../src/steps/typecheck.js";
import { createStepContext, type VerifierStep } from "../src/steps/step.js";
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

async function runStep(step: VerifierStep, source: string): Promise<readonly Diagnostic[]> {
  const context = createStepContext({
    input: inputFor(source),
    contract,
    clock: new FakeClock(),
    deadlineAt: Number.POSITIVE_INFINITY,
  });
  return (await step.run(context)).diagnostics;
}

/** Awal Main_File yang bersih; `CASE_LINE` adalah baris basis 1 tempat sumber kasus disisipkan. */
const HEAD = `import { createElement } from "react";
import { useCurrentFrame } from "remotion";

export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };
declare const a: number | undefined;
declare const s: string;
declare const x: boolean;
`;
const CASE_LINE = HEAD.split("\n").length;
const TAIL = `
export default function Main() {
  const frame = useCurrentFrame();
  return createElement("div", null, String(frame));
}
`;

/** `line` disisipkan sebagai satu baris di `CASE_LINE`; `comment` adalah komentar sungguhannya. */
interface DirectiveCase {
  readonly line: string;
  readonly comment: string;
}

/** Kolom basis 1 dari komentar sungguhan (kemunculan terakhir, sesudah string atau regex di baris itu). */
function columnOf(testCase: DirectiveCase): number {
  return testCase.line.lastIndexOf(testCase.comment) + 1;
}

const sourceOf = (line: string): string => `${HEAD}${line}\n${TAIL}`;

// ---- akibat bug di langkah 3 dan 4 ----

describe("gerbang: TSC_SUPPRESSION_DIRECTIVE tidak lolos di balik `/`", () => {
  const CASES: readonly DirectiveCase[] = [
    // Bentuk yang dilaporkan di tugas 5.3 dan variasinya.
    { line: "export const q = a! / 2; // @ts-ignore", comment: "// @ts-ignore" },
    { line: "export const q = a!! / 2; // @ts-nocheck", comment: "// @ts-nocheck" },
    { line: "export const q = a! / 2; /* @ts-ignore */", comment: "/* @ts-ignore */" },
    { line: 'export const q = a! / "/" / 2; // @ts-expect-error', comment: "// @ts-expect-error" },
    { line: "export const q = (a!) / 2; // @ts-ignore", comment: "// @ts-ignore" },
    // Kelas bug yang sama: regex atau pembagian di posisi yang heuristik salah baca.
    { line: 'if (x) /"/.test(s); // @ts-ignore', comment: "// @ts-ignore" },
    { line: 'for (const c of /"/.exec(s) ?? []) { void c; } // @ts-ignore', comment: "// @ts-ignore" },
    // Yang harus tetap dikenali seperti sebelumnya.
    { line: 'export const r = /"/; // @ts-ignore', comment: "// @ts-ignore" },
    { line: "export const q = a / 2; // @ts-ignore", comment: "// @ts-ignore" },
    { line: 'export const t = `// x ${a} /* y */`; // @ts-ignore', comment: "// @ts-ignore" },
  ];

  for (const testCase of CASES) {
    it(`melaporkan ${JSON.stringify(testCase.line)}`, async () => {
      const found = (await runStep(typecheckStep, sourceOf(testCase.line))).filter(
        (diagnostic) => diagnostic.code === "TSC_SUPPRESSION_DIRECTIVE",
      );
      expect(found.map((d) => [d.tool, d.severity, d.line, d.column])).toEqual([
        ["tsc", "error", CASE_LINE, columnOf(testCase)],
      ]);
    });
  }

  it("`a! / 2; // @ts-ignore` menyembunyikan galat tipe di compiler, jadi hanya direktifnya yang menolak", async () => {
    const source = sourceOf('export const q = a! / 2; // @ts-ignore\nexport const bad: number = "x";');
    const result = await safeVerify(inputFor(source), {
      clock: new FakeClock(),
      contract,
      steps: [sizeStep, lintStep, typecheckStep],
    });
    const codes = result.diagnostics.map((diagnostic) => diagnostic.code);
    // Compiler menghormati direktif itu: TS2322 pada baris berikutnya tidak dilaporkan.
    expect(codes).not.toContain("TSC_2322");
    expect(codes).toContain("TSC_SUPPRESSION_DIRECTIVE");
    expect(result.ok).toBe(false);
  });
});

describe("gerbang: ESLINT_INLINE_DIRECTIVE tidak lolos di balik `/`", () => {
  const CASES: readonly DirectiveCase[] = [
    { line: "export const q = a! / 2; // eslint-disable-line", comment: "// eslint-disable-line" },
    { line: "export const q = a!! / 2; /* eslint-disable */", comment: "/* eslint-disable */" },
    {
      line: 'export const q = a! / "/" / 2; // eslint-disable-next-line no-var',
      comment: "// eslint-disable-next-line no-var",
    },
    { line: 'if (x) /"/.test(s); // eslint-disable-line', comment: "// eslint-disable-line" },
    { line: "export const r = /ab+c/; // eslint-disable-line", comment: "// eslint-disable-line" },
    { line: "export const q = a / 2; // eslint-disable-line", comment: "// eslint-disable-line" },
  ];

  for (const testCase of CASES) {
    it(`melaporkan ${JSON.stringify(testCase.line)}`, async () => {
      const found = (await runStep(lintStep, sourceOf(testCase.line))).filter(
        (diagnostic) => diagnostic.code === "ESLINT_INLINE_DIRECTIVE",
      );
      expect(found.map((d) => [d.tool, d.severity, d.line, d.column])).toEqual([
        ["eslint", "error", CASE_LINE, columnOf(testCase)],
      ]);
    });
  }
});

describe("gerbang: sumber yang bersarang sangat dalam tetap ditolak pipeline", () => {
  // Parser TypeScript melempar RangeError pada sekitar seribu tingkat kurung, sehingga `scanComments`
  // jatuh ke pemindaian leksikal. Sumber seperti itu tetap tidak boleh lolos: ESLint dan compiler
  // juga gagal pada sumber yang sama (ESLINT_PARSE_ERROR dan VERIFIER_INTERNAL).
  it("ok false, langkah 3 dan 4 gagal, langkah 1 lolos (di bawah batas ukuran)", async () => {
    const depth = 15_000;
    const nested = `${"(".repeat(depth)}1${")".repeat(depth)}`;
    const source = sourceOf(`export const deep = ${nested};\n// @ts-ignore\nexport const bad: number = "x";`);
    expect(Buffer.byteLength(source, "utf8")).toBeLessThanOrEqual(contract.limits.source_max_bytes);

    const result = await safeVerify(inputFor(source), {
      clock: new FakeClock(),
      contract,
      steps: [sizeStep, lintStep, typecheckStep],
    });
    expect(result.ok).toBe(false);
    expect(result.summary.checks.map((check) => [check.name, check.ok])).toEqual([
      ["size", true],
      ["eslint", false],
      ["tsc", false],
    ]);
    const codes = result.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain("ESLINT_PARSE_ERROR");
    expect(codes).toContain("VERIFIER_INTERNAL");
  });

  it("pemindai tetap total dan menemukan komentar yang tidak ambigu pada sumber itu", () => {
    const depth = 15_000;
    const source = `${"(".repeat(depth)}1${")".repeat(depth)};\n// @ts-ignore\n`;
    expect(scanComments(source)).toEqual([
      { kind: "line", value: " @ts-ignore", line: 2, column: 1 },
    ]);
  });
});

// ---- kesepakatan dengan compiler ----

const DIRECTIVE = "// @ts-ignore";
const BAD_LINE = 'export const bad: number = "x";';

interface Analysis {
  /** Sumber utuh: `statements`, spasi, direktif di baris terakhir, lalu `BAD_LINE` di baris berikutnya. */
  readonly source: string;
  /** Komentar yang HARUS ditemukan pemindai: direktif itu di baris dan kolom ujung `statements`. */
  readonly expected: { kind: "line"; value: string; line: number; column: number };
  /** Compiler tidak melaporkan TS2322 di `BAD_LINE`, jadi ia menghormati direktif. */
  readonly suppressed: boolean;
  /** Tanpa direktif, compiler melaporkan TS2322 di `BAD_LINE` (tolok ukur bahwa tes ini tidak hampa). */
  readonly reportedWithoutDirective: boolean;
}

/** TS2322 di baris `line` (basis 1) menurut Program tanpa lib untuk `text`; `undefined` bila sintaks salah. */
function badLineErrors(text: string, line: number): boolean | undefined {
  const made = createVirtualProgram({ path: "/main.ts", text, scriptKind: ts.ScriptKind.TS });
  if (!made.ok) throw new Error("Program tidak memuat berkas virtual");
  const { program, sourceFile } = made;
  if (program.getSyntacticDiagnostics(sourceFile).length > 0) return undefined;
  return program.getSemanticDiagnostics(sourceFile).some(
    (diagnostic) =>
      diagnostic.code === 2322 &&
      diagnostic.start !== undefined &&
      sourceFile.getLineAndCharacterOfPosition(diagnostic.start).line + 1 === line,
  );
}

/** `undefined` bila `statements` bukan sintaks yang valid (tidak diuji; pemindai tidak dijanjikan apa pun). */
function analyse(statements: string): Analysis | undefined {
  const lines = statements.split("\n");
  const source = `${statements} ${DIRECTIVE}\n${BAD_LINE}\n`;
  const withDirective = badLineErrors(source, lines.length + 1);
  const withoutDirective = badLineErrors(`${statements}\n${BAD_LINE}\n`, lines.length + 1);
  if (withDirective === undefined || withoutDirective === undefined) return undefined;
  return {
    source,
    expected: {
      kind: "line",
      value: " @ts-ignore",
      line: lines.length,
      column: (lines.at(-1) ?? "").length + 2,
    },
    suppressed: !withDirective,
    reportedWithoutDirective: withoutDirective,
  };
}

/** Operan dengan beragam akhiran token (`!`, `)`, `]`, `}`, literal, kata kunci) dan awalan regex. */
const OPERANDS: readonly string[] = [
  "a",
  "a!",
  "a!!",
  "a![0]!",
  "a!.b!",
  "(a)",
  "(a!)",
  "[1][0]",
  "f()",
  "f()!",
  "f<T>(a)!",
  "{}",
  "{ k: 1 }",
  "function () {}",
  "class {}",
  '"s"',
  "'/'",
  '"//"',
  "'/*'",
  "`t`",
  "`${a}`",
  "`${a}/*`",
  "`${{}}//`",
  '/"/',
  "/'/g",
  "/[/]/",
  "/\\/\\//",
  "1",
  "1.5",
  "this",
  "null",
  "true",
  "a++",
  "a--",
  "a as number",
  "<number>a",
  'typeof /"/',
  '!/"/.source',
  "void /'/",
  "-a",
  "++a",
];
const OPERATORS: readonly string[] = ["/", "/", "/", "+", "*", "-", "&&", "??", ","];

/** Pernyataan yang memuat ekspresi `e`, dengan regex atau pembagian di posisi yang sulit. */
const STATEMENTS: ReadonlyArray<(e: string) => string> = [
  (e) => `x = ${e};`,
  (e) => `if (${e}) /"/.test(s);`,
  (e) => `while (${e}) /'/.test(s);`,
  (e) => `do /"/.test(s); while (${e});`,
  (e) => `for (const c of [${e}]) /"/.test(s);`,
  (e) => `for (const c of /"/.exec(s) ?? [${e}]) {}`,
  (e) => `const t = \`p \${${e}} q // r\`;`,
  (e) => `f(${e}, /"/);`,
  (e) => `{}\n/"/.test(${e});`,
  (e) => `function f() {}\n/"/.test(${e});`,
  (e) => `class A {}\n/'/.test(${e});`,
  (e) => `async function g() { await /"/.test(${e}); }`,
  (e) => `label: /'/.test(${e});`,
  (e) => `switch (${e}) { case /"/.source: break; }`,
  () => 'y\n++/"/.lastIndex;',
];

describe("kesepakatan dengan compiler TypeScript", () => {
  it("tolok ukur: tanpa direktif TS2322 dilaporkan, dengan direktif ditekan compiler", () => {
    const analysis = analyse("x = a! / 2;");
    expect(analysis).toBeDefined();
    expect(analysis?.reportedWithoutDirective).toBe(true);
    expect(analysis?.suppressed).toBe(true);
    // Komentar di dalam string tidak menekan apa pun di compiler.
    expect(analyse('x = "// @ts-ignore";')?.suppressed).toBe(true);
    expect(badLineErrors(`x = "${DIRECTIVE}";\n${BAD_LINE}\n`, 2)).toBe(true);
  });

  it("setiap pasangan [operan, operator] yang sah: komentar penutup ditemukan tepat dan compiler menekan", () => {
    let valid = 0;
    const failures: string[] = [];
    for (const left of OPERANDS) {
      for (const operator of new Set(OPERATORS)) {
        const statements = `x = ${left} ${operator} 1;`;
        const analysis = analyse(statements);
        if (analysis === undefined) continue;
        valid += 1;
        const found = scanComments(analysis.source);
        if (JSON.stringify(found) !== JSON.stringify([analysis.expected]) || !analysis.suppressed) {
          failures.push(statements);
        }
      }
    }
    expect(failures).toEqual([]);
    // Sapuan ini tidak boleh hampa karena hampir semua pasangan ditolak parser.
    expect(valid).toBeGreaterThan(OPERANDS.length * 4);
  });

  it("sumber acak yang valid: pemindai menemukan persis satu komentar, di tempat yang sama dengan compiler", () => {
    const chain = fc
      .tuple(
        fc.constantFrom(...OPERANDS),
        fc.array(fc.tuple(fc.constantFrom(...OPERATORS), fc.constantFrom(...OPERANDS)), { maxLength: 3 }),
      )
      .map(([first, rest]) => [first, ...rest.map(([operator, operand]) => `${operator} ${operand}`)].join(" "));
    const statement = fc
      .tuple(chain, fc.constantFrom(...STATEMENTS))
      .map(([expression, make]) => make(expression));
    const runs = 200;
    let valid = 0;

    fc.assert(
      fc.property(fc.array(statement, { minLength: 1, maxLength: 4 }), (pieces) => {
        const analysis = analyse(pieces.join("\n"));
        if (analysis === undefined) return;
        valid += 1;
        expect(scanComments(analysis.source)).toEqual([analysis.expected]);
        expect(analysis.reportedWithoutDirective).toBe(true);
        expect(analysis.suppressed).toBe(true);
      }),
      { numRuns: runs, seed: 20250601 },
    );
    expect(valid).toBeGreaterThan(runs / 2);
  });
});

// ---- korpus ----

describe("korpus fixtures/good: pemindai hanya menemukan komentar yang ada di sumber", () => {
  const GOOD_DIR = new URL("fixtures/good/", PACKAGE_URL);
  const files = readdirSync(GOOD_DIR)
    .filter((name) => name.endsWith(".ts"))
    .sort();

  it("korpus berisi sedikitnya delapan berkas", () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  for (const file of files) {
    it(`${file}: tiap komentar berada tepat di awal \`//\` atau \`/*\` pada teks sumber`, () => {
      const text = readFileSync(new URL(file, GOOD_DIR), "utf8");
      const lines = text.split("\n");
      for (const comment of scanComments(text)) {
        const opener = lines[comment.line - 1]?.slice(comment.column - 1, comment.column + 1);
        expect(opener, `${file}:${comment.line}:${comment.column}`).toBe(
          comment.kind === "line" ? "//" : "/*",
        );
      }
    });
  }
});
