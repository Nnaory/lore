// Langkah 5 pipeline verifier: bundle esbuild (design 5.8, tabel 5.12 dan keputusan D-5;
// Requirement 8.5 sampai 8.9, 8.14, 8.15, 6.7; tugas 5.4).
// `bundleStep(source, maxBytes, options?)` membundel `main.ts` menjadi `main.js` (CJS, `react` dan
// `remotion` eksternal). `main.js` inilah yang disimpan, di-hash, dan dijalankan Worker langkah 6
// serta Sandbox_Runtime, jadi berkas yang dijalankan sama persis dengan yang diuji (D-5).
// Opsi esbuild mengikuti design 5.8 (`bundleBuildOptions`): `bundle`, `format: "cjs"`,
// `platform: "browser"`, `target: "es2022"`, tanpa minify dan tanpa sourcemap, `write: false`,
// `logLevel: "silent"`, `legalComments: "none"`, `charset: "utf8"`, `absWorkingDir: "/"`.
// Satu penyimpangan dari cuplikan design, dengan alasan: `resolveDir` sama dengan `absWorkingDir`
// ("/"), bukan akar paket. esbuild menulis komentar `// <path>` di atas tiap modul, dihitung dari
// `absWorkingDir` ke `resolveDir/sourcefile`. Dengan `resolveDir` akar paket komentarnya menjadi
// `// var/task/main.ts` di Lambda dan `// home/<pengguna>/.../main.ts` di mesin pengembang:
// itu membocorkan letak pemasangan ke bundle (Requirement 8.14) dan membuat hash bergantung pada
// letak itu. Dengan keduanya "/" komentarnya selalu `// main.ts`, berapa pun cwd proses dan nilai
// `absWorkingDir` yang diberikan tes (Requirement 8.9, Property 4). Efek samping yang diinginkan:
// impor selain `react` dan `remotion` tidak lagi menemukan `node_modules` paket, jadi gagal
// "Could not resolve" (`BUNDLE_FAILED`) alih-alih ikut terbundel. Langkah 2 sudah menolak impor
// itu; ini lapisan kedua. esbuild tidak membaca `tsconfig.json` untuk `stdin`, jadi tidak ada
// masukan tersembunyi lain. Komentar `sourceMappingURL` pada masukan dibuang esbuild sendiri.
// Hasil, dalam satu lintasan (semua temuan dikumpulkan):
//   - esbuild gagal: satu `BUNDLE_FAILED` pada lokasi galat pertama (baris dan kolom basis 1; kolom
//     esbuild berbasis 0 dalam byte, dikonversi ke unit UTF-16 lewat `lineText`). Lokasi dibuang bila
//     galat bukan di `main.ts`. Tidak melempar (Requirement 8.8). Pelempar yang bukan galat esbuild
//     (proses esbuild tak bisa jalan, opsi tak sah) menjadi satu `VERIFIER_INTERNAL` tanpa teks
//     exception, sama seperti `lint.ts`.
//   - teks bundle > `maxBytes` byte UTF-8: `BUNDLE_TOO_LARGE`. `maxBytes` adalah argumen (tes memakai
//     nilai kecil, Requirement 8.15); langkah produksi mengambilnya dari `limits.bundle_max_bytes`.
//   - pemanggilan `require` yang argumennya bukan tepat satu literal string `react` atau `remotion`:
//     `BUNDLE_UNEXPECTED_REQUIRE`, satu per modul berbeda menurut urutan kemunculan, tanpa baris
//     (baris bundle tidak berarti bagi pengarang). Pemindaian memakai AST (`walkNodes` pada hasil
//     `ts.createSourceFile`), bukan regex pada teks, supaya string atau komentar yang memuat
//     `require('fs')` tidak ditolak keliru. Callee yang dibungkus tanda kurung atau operator koma
//     (`(0, require)("fs")`) ikut dihitung. Pemanggilan lewat alias (`const r = require`) tidak
//     dilacak di sini; penjaga terakhirnya shim `require` Worker, yang melempar untuk id selain
//     `allowed_imports`. Kondisi ini jarang tercapai lewat pipeline (langkah 2 menolak impor lain),
//     jadi tes memanggil `bundleStep` langsung dengan `try { require("fs") } catch {}`, yang oleh
//     esbuild dibiarkan apa adanya.
//   - path absolut dibuang dari semua pesan (`scrubAbsolutePaths`); esbuild kadang mengutip path
//     (misal "Could not read from file").
// `bundleVerifierStep` adalah langkah 5 untuk registri: ia mengisi `BUNDLE_ARTIFACT` hanya bila
// langkah sukses (tanpa Diagnostic `error`), supaya langkah 6 dan hasil akhir tidak pernah memegang
// bundle dari langkah yang gagal. Modul ini tidak membaca jam atau acak dan tidak melempar di batas
// modul.

import { build, type BuildOptions, type Message } from "esbuild";
import ts from "typescript";
import {
  DEFAULT_MESSAGE_MAX_CHARS,
  makeDiagnostic,
  type DiagnosticLocation,
} from "../diagnostics.js";
import { walkNodes } from "../policy/walk.js";
import type { Diagnostic, Severity } from "../types.js";
import { utf8ByteLength } from "./size.js";
import { BUNDLE_ARTIFACT, type VerifierStep } from "./step.js";

/** Nama berkas sumber virtual; sama dengan `file_name` kontrak (dijaga tes). */
export const BUNDLE_SOURCE_FILE = "main.ts";

/** `absWorkingDir` dan `resolveDir`: tetap, agar bundle tidak bergantung pada cwd atau letak paket. */
export const BUNDLE_WORKING_DIR = "/";

/** Modul yang tidak dibundel dan satu-satunya argumen `require` yang sah; sama dengan `allowed_imports`. */
export const BUNDLE_EXTERNALS: readonly string[] = ["react", "remotion"];

const INTERNAL_MESSAGE = "internal verifier error";
const FAILED_FALLBACK_MESSAGE = "esbuild failed";
const NON_LITERAL_REQUIRE_MESSAGE = "bundle requires a module by a non-literal id";

/**
 * Path absolut dalam teks galat: POSIX dengan dua segmen atau lebih (`/var/task/x`), atau Windows
 * (`C:\x`). Didahului bukan karakter nama paket, supaya `react/jsx-runtime/x` dan `"/"` utuh.
 */
const ABSOLUTE_PATH = /(?<![\w.@~+-])(?:[A-Za-z]:[\\/][^\s"'`),;]*|(?:\/[\w.@~+-]+){2,}\/?)/gu;

/** Mengganti path absolut dengan `<path>`. */
export function scrubAbsolutePaths(text: string): string {
  return text.replace(ABSOLUTE_PATH, "<path>");
}

// ---- opsi esbuild ----

/**
 * Opsi `esbuild.build` persis design 5.8 (lihat header untuk `resolveDir`). Hanya data yang dapat
 * diserialisasi JSON, supaya tes dapat menjalankannya di proses lain dengan cwd berbeda.
 * `absWorkingDir` hanya untuk tes reproducibility; produksi memakai nilai bawaan.
 */
export function bundleBuildOptions(source: string, absWorkingDir: string = BUNDLE_WORKING_DIR) {
  return {
    stdin: {
      contents: source,
      loader: "ts",
      sourcefile: BUNDLE_SOURCE_FILE,
      resolveDir: absWorkingDir,
    },
    bundle: true,
    format: "cjs",
    platform: "browser",
    target: "es2022",
    minify: false,
    sourcemap: false,
    external: [...BUNDLE_EXTERNALS],
    write: false,
    logLevel: "silent",
    legalComments: "none",
    charset: "utf8",
    absWorkingDir,
  } satisfies BuildOptions;
}

// ---- galat esbuild ----

/** Daftar galat bila `error` adalah `BuildFailure` esbuild; `undefined` untuk pelempar lain. */
function esbuildErrors(error: unknown): readonly Message[] | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const errors: unknown = Reflect.get(error, "errors");
  return Array.isArray(errors) ? (errors as Message[]) : undefined;
}

/** Kolom basis 0 dalam byte (esbuild) menjadi basis 1 dalam unit UTF-16 (editor dan Diagnostic). */
function utf16Column(lineText: string, byteColumn: number): number {
  if (!Number.isInteger(byteColumn) || byteColumn < 0) return 1;
  return Buffer.from(lineText, "utf8").subarray(0, byteColumn).toString("utf8").length + 1;
}

/** Lokasi hanya untuk galat di `main.ts`; galat di berkas lain (atau tanpa lokasi) tidak punya posisi. */
function locationOf(message: Message | undefined): DiagnosticLocation | undefined {
  const location = message?.location;
  if (location === null || location === undefined) return undefined;
  if (location.file !== BUNDLE_SOURCE_FILE) return undefined;
  if (!Number.isInteger(location.line) || location.line < 1) return undefined;
  return { line: location.line, column: utf16Column(location.lineText, location.column) };
}

// ---- pemindaian require ----

const isCommaExpression = (node: ts.Node): node is ts.BinaryExpression =>
  ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken;

/** Identifier callee setelah membuang tanda kurung dan operator koma: `(0, require)` menjadi `require`. */
function calleeIdentifier(expression: ts.Expression): ts.Identifier | undefined {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || isCommaExpression(current)) {
    current = ts.isParenthesizedExpression(current) ? current.expression : current.right;
  }
  return ts.isIdentifier(current) ? current : undefined;
}

/**
 * Modul yang dipanggil lewat `require(...)` di `bundle` selain `react` dan `remotion`, tanpa
 * duplikat, menurut urutan kemunculan. Elemen `null` berarti `require` dipanggil dengan argumen
 * yang bukan tepat satu literal string (id dinamis, tanpa argumen, atau lebih dari satu).
 */
export function findUnexpectedRequires(bundle: string): readonly (string | null)[] {
  const sourceFile = ts.createSourceFile(
    "main.js",
    bundle,
    ts.ScriptTarget.ES2022,
    false,
    ts.ScriptKind.JS,
  );
  const found: (string | null)[] = [];
  const seen = new Set<string>();
  const record = (id: string | null): void => {
    const key = id === null ? "dynamic" : `literal:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(id);
  };
  walkNodes(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    if (calleeIdentifier(node.expression)?.text !== "require") return;
    const [only] = node.arguments;
    if (node.arguments.length !== 1 || only === undefined || !ts.isStringLiteral(only)) {
      record(null);
    } else if (!BUNDLE_EXTERNALS.includes(only.text)) {
      record(only.text);
    }
  });
  return found;
}

// ---- langkah ----

/** Hasil `bundleStep`. `bundle` hanya ada bila tidak ada Diagnostic `error`. */
export type BundleOutcome =
  | { ok: true; bundle: string }
  | { ok: false; diagnostics: readonly Diagnostic[] };

export interface BundleOptions {
  /** Batas pesan Diagnostic; bawaan 200, produksi memakai `diagnostic_message_max_chars` kontrak. */
  messageMaxChars?: number;
  /** Hanya untuk tes reproducibility (Property 4); bawaan `BUNDLE_WORKING_DIR`. */
  absWorkingDir?: string;
}

/**
 * Membundel `source`. Tidak melempar dan tidak menolak (reject): semua kegagalan menjadi
 * Diagnostic. Lihat header untuk aturan hasil.
 */
export async function bundleStep(
  source: string,
  maxBytes: number,
  options: BundleOptions = {},
): Promise<BundleOutcome> {
  const maxChars = options.messageMaxChars ?? DEFAULT_MESSAGE_MAX_CHARS;
  const diagnose = (
    code: string,
    severity: Severity,
    message: string,
    location?: DiagnosticLocation,
  ): Diagnostic =>
    makeDiagnostic(code, severity, scrubAbsolutePaths(message), location, maxChars);

  let text: string;
  try {
    const result = await build(bundleBuildOptions(source, options.absWorkingDir));
    const [output] = result.outputFiles;
    if (result.outputFiles.length !== 1 || output === undefined) {
      return { ok: false, diagnostics: [diagnose("BUNDLE_FAILED", "error", FAILED_FALLBACK_MESSAGE)] };
    }
    text = output.text;
  } catch (error) {
    const errors = esbuildErrors(error);
    if (errors === undefined) {
      return { ok: false, diagnostics: [diagnose("VERIFIER_INTERNAL", "error", INTERNAL_MESSAGE)] };
    }
    const first: Message | undefined = errors[0];
    const message =
      typeof first?.text === "string" && first.text !== "" ? first.text : FAILED_FALLBACK_MESSAGE;
    return {
      ok: false,
      diagnostics: [diagnose("BUNDLE_FAILED", "error", message, locationOf(first))],
    };
  }

  const diagnostics: Diagnostic[] = [];
  const bytes = utf8ByteLength(text);
  if (bytes > maxBytes) {
    diagnostics.push(
      diagnose("BUNDLE_TOO_LARGE", "error", `bundle is ${bytes} bytes, limit is ${maxBytes}`),
    );
  }
  for (const id of findUnexpectedRequires(text)) {
    diagnostics.push(
      diagnose(
        "BUNDLE_UNEXPECTED_REQUIRE",
        "error",
        id === null ? NON_LITERAL_REQUIRE_MESSAGE : `bundle requires ${JSON.stringify(id)}`,
      ),
    );
  }
  return diagnostics.length === 0 ? { ok: true, bundle: text } : { ok: false, diagnostics };
}

/** Langkah 5 untuk registri (`registry.ts`): batas ukuran dan batas pesan dari kontrak, bukan literal. */
export const bundleVerifierStep: VerifierStep = {
  number: 5,
  async run(context) {
    const { limits } = context.contract;
    const outcome = await bundleStep(context.input.source, limits.bundle_max_bytes, {
      messageMaxChars: limits.diagnostic_message_max_chars,
    });
    if (!outcome.ok) return { diagnostics: outcome.diagnostics };
    context.artifacts.set(BUNDLE_ARTIFACT, outcome.bundle);
    return { diagnostics: [] };
  },
};
