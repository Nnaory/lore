// Tes langkah 5, bundle esbuild (tugas 5.4; Requirement 8.5, 8.6, 8.7, 8.8, 8.9, 8.14, 8.15, 6.7;
// design 5.8, D-5). Yang diuji: opsi esbuild persis design 5.8, seluruh korpus `fixtures/good` lolos
// bundle tanpa `BUNDLE_UNEXPECTED_REQUIRE` dan menghasilkan CJS yang dapat dieksekusi, bundle yang
// identik byte demi byte untuk `absWorkingDir` dan cwd proses yang berbeda (cwd diuji di proses anak
// sungguhan, karena proses layanan esbuild di proses tes menetap pada cwd saat pertama dijalankan),
// bundle tanpa path absolut dan tanpa `sourceMappingURL`, `BUNDLE_TOO_LARGE` (hitungan byte UTF-8),
// `BUNDLE_UNEXPECTED_REQUIRE` (bundle rekayasa lewat `try { require("fs") } catch {}`, yang dibiarkan
// esbuild), `BUNDLE_FAILED` (lokasi basis 1 dalam unit UTF-16, hanya galat pertama, tanpa path
// absolut), pengisian `BUNDLE_ARTIFACT`, dan keterpasangan di registri.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../src/clock.js";
import { loadContract, type Contract } from "../src/contract.js";
import {
  BUNDLE_EXTERNALS,
  BUNDLE_SOURCE_FILE,
  BUNDLE_WORKING_DIR,
  bundleBuildOptions,
  bundleStep,
  bundleVerifierStep,
  findUnexpectedRequires,
  scrubAbsolutePaths,
  type BundleOptions,
} from "../src/steps/bundle.js";
import { DEFAULT_STEPS } from "../src/steps/registry.js";
import { utf8ByteLength } from "../src/steps/size.js";
import { BUNDLE_ARTIFACT, createStepContext, indexSteps } from "../src/steps/step.js";
import type { Diagnostic } from "../src/types.js";

vi.setConfig({ testTimeout: 60_000 });

// `build` meneruskan ke esbuild asli; hanya tes "kegagalan di luar esbuild" yang menggantinya sekali
// pakai (`mockRejectedValueOnce`) untuk meniru proses esbuild yang mati atau hasil tanpa keluaran.
vi.mock("esbuild", async (importOriginal) => {
  const actual = await importOriginal<typeof import("esbuild")>();
  return { ...actual, build: vi.fn(actual.build) };
});

// ---- kontrak dan pembantu ----

const PACKAGE_URL = new URL("../", import.meta.url);
const PKG_ROOT = fileURLToPath(PACKAGE_URL);
const GOOD_DIR = new URL("fixtures/good/", PACKAGE_URL);

const loaded = loadContract(
  JSON.parse(readFileSync(new URL("contract/animation-contract.json", PACKAGE_URL), "utf8")),
);
if (!loaded.ok) throw new Error(`kontrak sumber tidak sah: ${loaded.reason}`);
const contract: Contract = loaded.contract;
const LIMIT = contract.limits.bundle_max_bytes;

const GOOD_FILES = readdirSync(GOOD_DIR)
  .filter((name) => name.endsWith(".ts"))
  .sort();

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Main_File terkecil yang sah; `extra` disisipkan sebelum `export default`. */
function mainWith(extra = ""): string {
  return `import { createElement } from "react";
import { useCurrentFrame } from "remotion";

export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };
${extra}
export default function Main() {
  const frame = useCurrentFrame();
  return createElement("div", null, String(frame));
}
`;
}
const CLEAN_MAIN = mainWith();

async function bundleOf(source: string, options?: BundleOptions): Promise<string> {
  const outcome = await bundleStep(source, LIMIT, options);
  if (!outcome.ok) throw new Error(`bundle gagal: ${JSON.stringify(outcome.diagnostics)}`);
  return outcome.bundle;
}

async function failureOf(
  source: string,
  maxBytes: number = LIMIT,
  options?: BundleOptions,
): Promise<readonly Diagnostic[]> {
  const outcome = await bundleStep(source, maxBytes, options);
  if (outcome.ok) throw new Error("bundle seharusnya gagal");
  return outcome.diagnostics;
}

const codesOf = (diagnostics: readonly Diagnostic[]): string[] =>
  diagnostics.map((diagnostic) => diagnostic.code);

const goodSource = (name: string): string => readFileSync(new URL(name, GOOD_DIR), "utf8");

// ---- opsi esbuild ----

describe("langkah 5: opsi esbuild", () => {
  it("memakai opsi design 5.8 dengan versi esbuild yang dipin", () => {
    const options = bundleBuildOptions("export {};");
    expect(options).toMatchObject({
      bundle: true,
      format: "cjs",
      platform: "browser",
      target: "es2022",
      minify: false,
      sourcemap: false,
      external: ["react", "remotion"],
      write: false,
      logLevel: "silent",
      legalComments: "none",
      charset: "utf8",
      absWorkingDir: "/",
      stdin: { contents: "export {};", loader: "ts", sourcefile: "main.ts", resolveDir: "/" },
    });
    expect(Object.keys(options)).not.toContain("outfile");
    expect(Object.keys(options)).not.toContain("outdir");
  });

  it("batas ukuran bundle dari kontrak adalah 131072 byte", () => {
    expect(LIMIT).toBe(131072);
  });

  it("modul eksternal dan nama berkas sama dengan kontrak", () => {
    expect([...BUNDLE_EXTERNALS]).toEqual(Object.keys(contract.allowed_imports));
    expect(BUNDLE_SOURCE_FILE).toBe(contract.file_name);
    expect(BUNDLE_WORKING_DIR).toBe("/");
  });

  it("versi esbuild terpasang sama dengan pin di package.json", () => {
    const pinned = (
      JSON.parse(readFileSync(new URL("package.json", PACKAGE_URL), "utf8")) as {
        dependencies: Record<string, string>;
      }
    ).dependencies.esbuild;
    const installed = (
      createRequire(import.meta.url)("esbuild/package.json") as { version: string }
    ).version;
    expect(installed).toBe(pinned);
  });
});

// ---- korpus ----

/** `require` pengganti: modul sah menjadi objek yang menerima pemakaian apa pun tanpa melempar. */
function stubRequire(id: string): unknown {
  if (id !== "react" && id !== "remotion") throw new Error(`unexpected require: ${id}`);
  const callable = (): unknown => stubProxy;
  const stubProxy: unknown = new Proxy(callable, {
    get: (_target, name) => (name === Symbol.toPrimitive ? () => 0 : stubProxy),
    apply: () => stubProxy,
  });
  return stubProxy;
}

describe("langkah 5: korpus fixtures/good", () => {
  it("korpus memuat fixture (tes tidak kosong secara diam-diam)", () => {
    expect(GOOD_FILES.length).toBeGreaterThanOrEqual(8);
  });

  it.each(GOOD_FILES)("%s lolos bundle tanpa Diagnostic dan hanya me-require react dan remotion", async (name) => {
    const outcome = await bundleStep(goodSource(name), LIMIT);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(utf8ByteLength(outcome.bundle)).toBeLessThanOrEqual(LIMIT);
    expect(findUnexpectedRequires(outcome.bundle)).toEqual([]);
    // Pemeriksa independen: setiap `require("...")` di teks hasil adalah react atau remotion.
    const ids = [...outcome.bundle.matchAll(/\brequire\(\s*"([^"]*)"\s*\)/gu)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(["react", "remotion"]).toContain(id);
    expect(outcome.bundle).not.toMatch(/\brequire\((?!\s*"(?:react|remotion)"\s*\))/u);
  });

  it.each(GOOD_FILES)("%s menghasilkan CJS yang mengekspor meta dan fungsi Main", async (name) => {
    const bundle = await bundleOf(goodSource(name));
    const moduleObject: { exports: Record<string, unknown> } = { exports: {} };
    vm.runInNewContext(bundle, {
      module: moduleObject,
      exports: moduleObject.exports,
      require: stubRequire,
    });
    expect(moduleObject.exports.meta).toMatchObject({ width: 1280, height: 720, fps: 30 });
    expect(typeof moduleObject.exports.default).toBe("function");
  });
});

// ---- reproducible ----

/** Skrip proses anak: membangun dengan opsi JSON yang sama dan mencetak teks bundle ke stdout. */
const CHILD_SCRIPT = `
const [esbuildUrl, optionsJson] = process.argv.slice(1);
const { build } = await import(esbuildUrl);
const result = await build(JSON.parse(optionsJson));
process.stdout.write(result.outputFiles[0].text);
`;

function bundleInChildProcess(source: string, cwd: string): string {
  const esbuildUrl = pathToFileURL(createRequire(import.meta.url).resolve("esbuild")).href;
  return execFileSync(
    process.execPath,
    ["--input-type=module", "-e", CHILD_SCRIPT, esbuildUrl, JSON.stringify(bundleBuildOptions(source))],
    { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
}

describe("langkah 5: bundle reproducible (Requirement 8.9, 8.14)", () => {
  it("sumber yang sama menghasilkan bundle yang sama", async () => {
    const first = await bundleOf(CLEAN_MAIN);
    const second = await bundleOf(CLEAN_MAIN);
    expect(second).toBe(first);
  });

  it.each(GOOD_FILES)("%s: SHA-256 sama untuk absWorkingDir yang berbeda", async (name) => {
    const source = goodSource(name);
    const hashes = new Set<string>();
    for (const absWorkingDir of ["/", tmpdir(), PKG_ROOT, homedir()]) {
      hashes.add(sha256(await bundleOf(source, { absWorkingDir })));
    }
    expect(hashes.size).toBe(1);
  });

  it("SHA-256 sama untuk dua cwd proses yang berbeda (proses anak sungguhan)", async () => {
    const source = goodSource(GOOD_FILES[0] ?? "");
    const inProcess = await bundleOf(source);
    const fromTmp = bundleInChildProcess(source, tmpdir());
    const fromPackage = bundleInChildProcess(source, PKG_ROOT);
    expect(sha256(fromTmp)).toBe(sha256(fromPackage));
    expect(fromTmp).toBe(inProcess);
  });

  it("bundle tidak memuat path absolut atau letak pemasangan paket", async () => {
    for (const name of GOOD_FILES) {
      const bundle = await bundleOf(goodSource(name));
      for (const place of [PKG_ROOT, tmpdir(), homedir(), process.cwd()]) {
        const bare = place.replace(/^\/+|\/+$/gu, "");
        expect(bundle, `${name} memuat ${place}`).not.toContain(bare === "" ? "\u0000" : bare);
      }
      // Satu-satunya komentar modul adalah `// main.ts`, tanpa awalan direktori.
      const moduleComments = bundle.split("\n").filter((line) => line.startsWith("//"));
      expect(moduleComments).toEqual(["// main.ts"]);
    }
  });

  it("komentar sourceMappingURL pada masukan tidak sampai ke bundle", async () => {
    const source = `${CLEAN_MAIN}//# sourceMappingURL=main.js.map\n/*# sourceMappingURL=other.map */\n`;
    const bundle = await bundleOf(source);
    expect(bundle).not.toContain("sourceMappingURL");
    expect(bundle).not.toContain(".map");
  });
});

// ---- BUNDLE_TOO_LARGE ----

describe("langkah 5: BUNDLE_TOO_LARGE (Requirement 8.6, 8.15)", () => {
  it("maxBytes kecil menghasilkan satu BUNDLE_TOO_LARGE dengan tool esbuild dan tanpa posisi", async () => {
    const full = await bundleOf(CLEAN_MAIN);
    const bytes = utf8ByteLength(full);
    const diagnostics = await failureOf(CLEAN_MAIN, 10);
    expect(diagnostics).toEqual([
      {
        tool: "esbuild",
        code: "BUNDLE_TOO_LARGE",
        severity: "error",
        message: `bundle is ${bytes} bytes, limit is 10`,
      },
    ]);
  });

  it("tepat sebesar batas lolos, satu byte di bawahnya gagal", async () => {
    const bytes = utf8ByteLength(await bundleOf(CLEAN_MAIN));
    expect((await bundleStep(CLEAN_MAIN, bytes)).ok).toBe(true);
    expect(codesOf(await failureOf(CLEAN_MAIN, bytes - 1))).toEqual(["BUNDLE_TOO_LARGE"]);
  });

  it("ukuran dihitung dalam byte UTF-8, bukan jumlah karakter", async () => {
    const source = mainWith('export const note = "é😀é😀é😀";');
    const text = await bundleOf(source);
    const bytes = utf8ByteLength(text);
    expect(bytes).toBeGreaterThan(text.length);
    // Batas di antara jumlah karakter dan jumlah byte: hanya hitungan byte yang menolak.
    expect(codesOf(await failureOf(source, bytes - 1))).toEqual(["BUNDLE_TOO_LARGE"]);
    expect((await bundleStep(source, bytes)).ok).toBe(true);
  });

  it("pesan dipotong ke batas yang diberikan pemanggil", async () => {
    const bytes = utf8ByteLength(await bundleOf(CLEAN_MAIN));
    const diagnostics = await failureOf(CLEAN_MAIN, 10, { messageMaxChars: 12 });
    expect(diagnostics[0]?.message).toBe(`bundle is ${bytes} bytes, limit is 10`.slice(0, 12));
  });
});

// ---- BUNDLE_UNEXPECTED_REQUIRE ----

/** esbuild membiarkan `require` yang tak bisa di-resolve bila ada di dalam try/catch. */
const guarded = (call: string): string =>
  `declare const require: (...ids: unknown[]) => unknown;\ndeclare const dynamicId: string;\n${mainWith(`try { ${call}; } catch {}`)}`;

describe("langkah 5: BUNDLE_UNEXPECTED_REQUIRE (Requirement 8.7)", () => {
  it('bundle rekayasa dengan require("fs") menghasilkan BUNDLE_UNEXPECTED_REQUIRE error tanpa posisi', async () => {
    const source = guarded('require("fs")');
    // Prasyarat tes: esbuild memang membiarkan pemanggilan itu di bundle.
    const diagnostics = await failureOf(source);
    expect(diagnostics).toEqual([
      {
        tool: "esbuild",
        code: "BUNDLE_UNEXPECTED_REQUIRE",
        severity: "error",
        message: 'bundle requires "fs"',
      },
    ]);
  });

  it("satu Diagnostic per modul berbeda, menurut urutan kemunculan", async () => {
    const source = guarded('require("fs"); require("path"); require("fs")');
    const diagnostics = await failureOf(source);
    expect(diagnostics.map((d) => d.message)).toEqual(['bundle requires "fs"', 'bundle requires "path"']);
  });

  it("require react dan remotion yang disengaja lolos", async () => {
    const outcome = await bundleStep(guarded('require("react"); require("remotion")'), LIMIT);
    expect(outcome.ok).toBe(true);
  });

  it("id dinamis dilaporkan sebagai id bukan-literal", async () => {
    const diagnostics = await failureOf(guarded("require(dynamicId)"));
    expect(codesOf(diagnostics)).toEqual(["BUNDLE_UNEXPECTED_REQUIRE"]);
    expect(diagnostics[0]?.message).toBe("bundle requires a module by a non-literal id");
  });

  it("BUNDLE_TOO_LARGE dan BUNDLE_UNEXPECTED_REQUIRE dilaporkan bersama", async () => {
    const diagnostics = await failureOf(guarded('require("fs")'), 10);
    expect(codesOf(diagnostics)).toEqual(["BUNDLE_TOO_LARGE", "BUNDLE_UNEXPECTED_REQUIRE"]);
  });

  it("teks 'require(\"fs\")' di dalam string, komentar, dan regex tidak dihitung", async () => {
    const source = mainWith(
      [
        'export const note = "call require(\\"fs\\") later";',
        '// require("fs") in a comment',
        "export const pattern = /require\\(\"fs\"\\)/u;",
      ].join("\n"),
    );
    expect((await bundleStep(source, LIMIT)).ok).toBe(true);
  });

  it("id berupa path absolut dibuang dari pesan", async () => {
    const diagnostics = await failureOf(guarded('require("/var/task/secret/x")'));
    expect(diagnostics[0]?.message).toBe('bundle requires "<path>"');
  });
});

describe("findUnexpectedRequires (teks bundle tulisan tangan)", () => {
  it("melaporkan callee yang dibungkus tanda kurung, koma, dan rantai opsional", () => {
    expect(findUnexpectedRequires('(0, require)("a"); (require)("b"); require?.("c");')).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("argumen selain tepat satu literal string menjadi null (satu kali)", () => {
    expect(findUnexpectedRequires('require(); require("fs", 1); require(`fs`); require(x);')).toEqual([
      null,
    ]);
  });

  it("react dan remotion sah, modul lain tidak, duplikat dibuang", () => {
    expect(
      findUnexpectedRequires('require("react"); require("remotion"); require("fs"); require("fs");'),
    ).toEqual(["fs"]);
  });

  it("bukan pemanggilan require: properti, deklarasi, string, komentar", () => {
    const text = [
      'const a = module.require("fs");',
      'const b = obj.require("fs");',
      'const c = "require(\\"fs\\")";',
      '/* require("fs") */ // require("fs")',
      "const d = { require: 1 }; function f(require) { return 1; }",
    ].join("\n");
    expect(findUnexpectedRequires(text)).toEqual([]);
  });

  it("teks kosong dan teks rusak tidak melempar", () => {
    expect(findUnexpectedRequires("")).toEqual([]);
    expect(() => findUnexpectedRequires("require(( {{{ ")).not.toThrow();
  });
});

// ---- BUNDLE_FAILED ----

describe("langkah 5: BUNDLE_FAILED (Requirement 8.8)", () => {
  it("sintaks rusak menghasilkan satu BUNDLE_FAILED pada baris dan kolom basis 1 yang benar", async () => {
    const source = `export const a = 1;\nexport const b = 2;\nexport const c = ;\n`;
    const diagnostics = await failureOf(source);
    expect(diagnostics).toEqual([
      {
        tool: "esbuild",
        code: "BUNDLE_FAILED",
        severity: "error",
        message: 'Unexpected ";"',
        line: 3,
        column: 18,
      },
    ]);
  });

  it("kolom dihitung dalam unit UTF-16, bukan byte (karakter non-ASCII sebelum galat)", async () => {
    // `;` ada di indeks UTF-16 27 (kolom 28), tetapi di byte 31 karena empat huruf "é".
    const diagnostics = await failureOf('const é = "ééé"; const x = ;\n');
    expect(diagnostics[0]).toMatchObject({ code: "BUNDLE_FAILED", line: 1, column: 28 });
  });

  it("emoji (dua unit UTF-16, empat byte) sebelum galat tidak menggeser kolom", async () => {
    const diagnostics = await failureOf('const s = "😀"; const x = ;\n');
    expect(diagnostics[0]).toMatchObject({ code: "BUNDLE_FAILED", line: 1, column: 27 });
  });

  it("impor yang tak bisa di-resolve gagal pada lokasi impor", async () => {
    const diagnostics = await failureOf('import x from "./nope";\nexport default x;\n');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "BUNDLE_FAILED",
      message: 'Could not resolve "./nope"',
      line: 1,
      column: 15,
    });
  });

  it("hanya galat pertama yang dilaporkan", async () => {
    const source = 'import a from "./one";\nconst gap = 1;\nimport b from "./two";\nexport default [a, b];\n';
    const diagnostics = await failureOf(source);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ code: "BUNDLE_FAILED", line: 1 });
  });

  it("paket yang terpasang di node_modules paket tidak ikut terbundel", async () => {
    const diagnostics = await failureOf('import { z } from "zod";\nexport default z;\n');
    expect(codesOf(diagnostics)).toEqual(["BUNDLE_FAILED"]);
    expect(diagnostics[0]?.message).toBe('Could not resolve "zod"');
  });

  it("path absolut tidak muncul di pesan", async () => {
    const diagnostics = await failureOf('import x from "/var/task/nope/main";\nexport default x;\n');
    expect(codesOf(diagnostics)).toEqual(["BUNDLE_FAILED"]);
    expect(diagnostics[0]?.message).not.toContain("/var/task");
    expect(diagnostics[0]?.message).toContain("<path>");
  });

  it("masukan kosong dan sintaks TypeScript valid tidak gagal", async () => {
    expect((await bundleStep("", LIMIT)).ok).toBe(true);
    expect((await bundleStep("export default <T,>(x: T) => x;\n", LIMIT)).ok).toBe(true);
  });

  it("absWorkingDir yang bukan path absolut dilaporkan esbuild sebagai BUNDLE_FAILED", async () => {
    const diagnostics = await failureOf(CLEAN_MAIN, LIMIT, { absWorkingDir: "relative/dir" });
    expect(codesOf(diagnostics)).toEqual(["BUNDLE_FAILED"]);
  });
});

describe("langkah 5: kegagalan di luar galat esbuild (tanpa melempar)", () => {
  it("pelempar yang bukan BuildFailure menjadi satu VERIFIER_INTERNAL tanpa teks exception", async () => {
    vi.mocked(build).mockRejectedValueOnce(new Error("boom at /var/task/secret/esbuild"));
    expect(await failureOf(CLEAN_MAIN)).toEqual([
      {
        tool: "verifier",
        code: "VERIFIER_INTERNAL",
        severity: "error",
        message: "internal verifier error",
      },
    ]);
    vi.mocked(build).mockRejectedValueOnce("boom");
    expect(codesOf(await failureOf(CLEAN_MAIN))).toEqual(["VERIFIER_INTERNAL"]);
  });

  it("BuildFailure tanpa galat atau tanpa teks memakai pesan cadangan", async () => {
    vi.mocked(build).mockRejectedValueOnce(Object.assign(new Error("failed"), { errors: [] }));
    const empty = await failureOf(CLEAN_MAIN);
    expect(empty).toHaveLength(1);
    expect(empty[0]).toMatchObject({ code: "BUNDLE_FAILED", message: "esbuild failed" });
    expect(empty[0]).not.toHaveProperty("line");
  });

  it("hasil tanpa berkas keluaran menjadi BUNDLE_FAILED", async () => {
    vi.mocked(build).mockResolvedValueOnce({
      errors: [],
      warnings: [],
      outputFiles: [],
      metafile: undefined,
      mangleCache: undefined,
    } as unknown as Awaited<ReturnType<typeof build>>);
    expect(codesOf(await failureOf(CLEAN_MAIN))).toEqual(["BUNDLE_FAILED"]);
  });

  it("galat di berkas selain main.ts tidak diberi posisi dan path-nya dibuang", async () => {
    const failure = Object.assign(new Error("failed"), {
      errors: [
        {
          text: "Could not read from file: /var/task/dist/other.js",
          location: { file: "var/task/dist/other.js", line: 3, column: 4, lineText: "x" },
        },
      ],
    });
    vi.mocked(build).mockRejectedValueOnce(failure);
    const diagnostics = await failureOf(CLEAN_MAIN);
    expect(diagnostics).toEqual([
      {
        tool: "esbuild",
        code: "BUNDLE_FAILED",
        severity: "error",
        message: "Could not read from file: <path>",
      },
    ]);
  });
});

describe("scrubAbsolutePaths", () => {
  it("mengganti path POSIX dan Windows", () => {
    expect(scrubAbsolutePaths("Could not read from file: /var/task/dist/main.ts")).toBe(
      "Could not read from file: <path>",
    );
    expect(scrubAbsolutePaths('Could not resolve "/home/vert/p/x.js" (also C:\\Users\\vert\\x.js)')).toBe(
      'Could not resolve "<path>" (also <path>)',
    );
  });

  it("membiarkan teks yang bukan path absolut", () => {
    for (const text of [
      'Could not resolve "./nope"',
      'Could not resolve "react/jsx-runtime/extra"',
      'Unexpected "/"',
      "a / b / c and a/b/c",
      "Expected identifier but found \"/\"",
    ]) {
      expect(scrubAbsolutePaths(text)).toBe(text);
    }
  });
});

// ---- langkah untuk registri ----

function stepContext(source: string, using: Contract = contract) {
  return createStepContext({
    input: {
      source,
      kind: "lesson",
      required_tokens: [],
      forbidden_tokens: [],
      contract_version: using.contract_version,
    },
    contract: using,
    clock: new FakeClock(),
    deadlineAt: Number.POSITIVE_INFINITY,
  });
}

describe("langkah 5: bundleVerifierStep", () => {
  it("adalah langkah nomor 5 dan terdaftar di registri produksi", () => {
    expect(bundleVerifierStep.number).toBe(5);
    const indexed = indexSteps(DEFAULT_STEPS);
    expect(indexed.ok).toBe(true);
    if (!indexed.ok) return;
    expect(indexed.byNumber.get(5)).toBe(bundleVerifierStep);
  });

  it.each(GOOD_FILES)("%s: sukses tanpa Diagnostic dan mengisi BUNDLE_ARTIFACT", async (name) => {
    const source = goodSource(name);
    const context = stepContext(source);
    const result = await bundleVerifierStep.run(context);
    expect(result.diagnostics).toEqual([]);
    expect(context.artifacts.get(BUNDLE_ARTIFACT)).toBe(await bundleOf(source));
  });

  it("gagal: Diagnostic ada dan BUNDLE_ARTIFACT tidak diisi", async () => {
    const context = stepContext("export const x = ;\n");
    const result = await bundleVerifierStep.run(context);
    expect(codesOf(result.diagnostics)).toEqual(["BUNDLE_FAILED"]);
    expect(context.artifacts.get(BUNDLE_ARTIFACT)).toBeUndefined();
  });

  it("batas ukuran dan batas pesan diambil dari kontrak, bukan literal", async () => {
    const small: Contract = {
      ...contract,
      limits: { ...contract.limits, bundle_max_bytes: 10, diagnostic_message_max_chars: 20 },
    };
    const context = stepContext(CLEAN_MAIN, small);
    const result = await bundleVerifierStep.run(context);
    expect(codesOf(result.diagnostics)).toEqual(["BUNDLE_TOO_LARGE"]);
    expect(result.diagnostics[0]?.message.length).toBeLessThanOrEqual(20);
    expect(context.artifacts.get(BUNDLE_ARTIFACT)).toBeUndefined();
  });

  it("memakai batas kontrak yang lebih besar untuk bundle yang lolos", async () => {
    const bytes = utf8ByteLength(await bundleOf(CLEAN_MAIN));
    const exact: Contract = { ...contract, limits: { ...contract.limits, bundle_max_bytes: bytes } };
    const context = stepContext(CLEAN_MAIN, exact);
    expect((await bundleVerifierStep.run(context)).diagnostics).toEqual([]);
    const tooSmall: Contract = {
      ...contract,
      limits: { ...contract.limits, bundle_max_bytes: bytes - 1 },
    };
    expect(codesOf((await bundleVerifierStep.run(stepContext(CLEAN_MAIN, tooSmall))).diagnostics)).toEqual([
      "BUNDLE_TOO_LARGE",
    ]);
  });
});
