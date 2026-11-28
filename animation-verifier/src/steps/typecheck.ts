// Langkah 4 pipeline verifier: typecheck dengan compiler TypeScript (design 5.7 dan tabel 5.12;
// Requirement 8.3, 8.4, 8.10, 8.15, 7.3; tugas 5.3).
// Alur: satu `ts.Program` untuk `main.ts` virtual di `${PKG_ROOT}/__virtual__/main.ts` (tidak ada di
// disk; dilayani `createDiskBackedHost` di `host/ts-host.ts`). Resolusi modul naik ke
// `${PKG_ROOT}/node_modules`, tempat deklarasi `react` (`@types/react` yang dipin) dan `remotion`
// berada; berkas lib (`lib.es2022.d.ts`, `lib.dom.d.ts`) dibaca dari direktori TypeScript. Hanya dua
// akar itu yang bisa dibaca; jalur lain "tidak ada", jadi `import "fs"` atau `./x` menjadi galat tipe
// biasa (`TSC_2307`), bukan pembacaan disk.
// Opsi compiler persis design 5.7 (`TYPECHECK_COMPILER_OPTIONS`): `noEmit`, `strict`, target ES2022,
// modul ESNext dengan resolusi Bundler, lib ES2022 dan DOM, `skipLibCheck`, `types: []`, tanpa `jsx`.
//
// Pemetaan: setiap galat `getPreEmitDiagnostics(program, main)` menjadi `TSC_<kode numerik>` (mis.
// `TSC_2322`) dengan baris dan kolom basis 1 (unit UTF-16, seperti ESLint dan langkah lain), severity
// `error`, dan pesan `flattenDiagnosticMessageText` yang dipotong ke batas kontrak oleh
// `context.diagnostic`. Diagnostic yang bukan milik `main.ts` (opsi, global) dilaporkan tanpa posisi,
// karena posisi itu milik berkas lain. Kategori `Suggestion` dan `Message` bukan galat dan dibuang.
// Pesan compiler kadang memuat jalur absolut (`import("/abs/node_modules/remotion/...")` bila dua
// tipe bernama sama): awalan akar paket dan direktori lib dibuang dari pesan SEBELUM dipotong,
// sehingga Diagnostic tidak membocorkan lokasi image dan hasilnya sama di mesin mana pun.
//
// `TSC_SUPPRESSION_DIRECTIVE` (error): komentar `@ts-ignore`, `@ts-nocheck`, dan `@ts-expect-error`,
// ditemukan `scanComments` (policy/comments.ts), bukan regex pada teks mentah, jadi string dan
// template yang memuat kata itu tidak dilaporkan. Sebuah komentar dihitung direktif bila salah satu
// barisnya, sesudah membuang `/`, `*`, dan spasi di awal, diawali salah satu dari tiga kata itu. Itu
// mencakup bentuk yang dikenali compiler (`// @ts-ignore`, `/// @ts-ignore`, `/* @ts-ignore */`,
// `/** @ts-ignore */`, dan tiap baris komentar blok) dan sedikit lebih luas, karena yang lolos dari
// pemeriksaan ini akan diam-diam menyembunyikan galat tipe.
//
// Cache: `SourceFile` lib dan deklarasi paket disimpan pada variabel modul (`SOURCE_FILE_CACHE`),
// jadi invokasi hangat Lambda tidak mem-parse ulang `lib.dom.d.ts` dan deklarasi React/Remotion.
// `main.ts` tidak pernah masuk cache. Deklarasi yang tidak bisa diresolusi (image rusak) dilaporkan
// sebagai `VERIFIER_INTERNAL`, bukan `TSC_2307`, supaya kesalahan deploy tidak dituduhkan ke
// pengarang dan memicu perbaikan percuma. Galat internal lain juga menjadi satu `VERIFIER_INTERNAL`
// tanpa teks exception (teks itu bisa memuat sumber). Tanpa jam, acak, atau jaringan.

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createDiskBackedHost, createVirtualProgram, type VirtualFile } from "../host/ts-host.js";
import { scanComments, type SourceComment } from "../policy/comments.js";
import type { Diagnostic, Severity } from "../types.js";
import type { StepContext, StepResult, VerifierStep } from "./step.js";

/** Akar paket tanpa `/` di akhir: `src/steps/` dan `dist/steps/` sama-sama dua tingkat di bawahnya. */
export const PKG_ROOT: string = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/+$/u, "");

/** Opsi compiler persis design 5.7. `jsx` sengaja tidak diisi (Main_File berekstensi `.ts`). */
export const TYPECHECK_COMPILER_OPTIONS: Readonly<ts.CompilerOptions> = {
  noEmit: true,
  strict: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  skipLibCheck: true,
  types: [],
};

/** Direktori semu tempat `main.ts` virtual berada; tidak ada di disk. */
const VIRTUAL_DIRECTORY = "__virtual__";

const INTERNAL_MESSAGE = "internal verifier error";
const SUPPRESSION_MESSAGE = "@ts-ignore, @ts-nocheck and @ts-expect-error are not allowed";

/** Awal sebuah baris komentar yang merupakan direktif penekan galat (lihat header). */
const SUPPRESSION_DIRECTIVE = /^[\s/*]*@ts-(?:ignore|nocheck|expect-error)/u;

/** Pemisah baris ECMAScript, sama dengan yang dipakai pemindai komentar. */
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/u;

/** Ekstensi hasil resolusi yang berarti "ada deklarasi tipe" (bukan `.js` yang membuat tipe jadi `any`). */
const DECLARATION_EXTENSIONS: ReadonlySet<string> = new Set([
  ts.Extension.Dts,
  ts.Extension.Ts,
  ts.Extension.Tsx,
]);

// ---- cache ----

/**
 * `SourceFile` berkas disk (lib dan deklarasi paket) milik seluruh invokasi proses ini. AST tidak
 * berubah setelah dibuat, jadi dipakai bersama oleh Program yang berbeda.
 */
const SOURCE_FILE_CACHE = new Map<string, ts.SourceFile>();

/** Mengosongkan cache. Hanya untuk tes yang membuktikan perilaku cache; produksi tidak memanggilnya. */
export function resetTypecheckCache(): void {
  SOURCE_FILE_CACHE.clear();
}

// ---- pesan ----

/**
 * Membuang awalan jalur absolut dari pesan compiler: `${packageRoot}/node_modules/` dan
 * `${packageRoot}/__virtual__/` menjadi kosong (hingga `import("remotion/dist/cjs/Sequence")` dan
 * `import("main")`), lalu sisa akar paket dan direktori lib. Awalan terpanjang lebih dulu.
 */
export function scrubPaths(
  message: string,
  packageRoot: string,
  libDirectory: string,
): string {
  const prefixes = [
    `${packageRoot}/node_modules/`,
    `${packageRoot}/${VIRTUAL_DIRECTORY}/`,
    `${packageRoot}/`,
    `${libDirectory}/`,
  ];
  return prefixes.reduce((text, prefix) => text.split(prefix).join(""), message);
}

function severityOf(category: ts.DiagnosticCategory): Severity | undefined {
  if (category === ts.DiagnosticCategory.Error) return "error";
  if (category === ts.DiagnosticCategory.Warning) return "warning";
  return undefined;
}

// ---- direktif penekan galat ----

/** Benar bila `comment` adalah direktif `@ts-ignore`, `@ts-nocheck`, atau `@ts-expect-error`. */
export function isTsSuppressionDirective(comment: SourceComment): boolean {
  const lines = comment.kind === "line" ? [comment.value] : comment.value.split(LINE_BREAK);
  return lines.some((line) => SUPPRESSION_DIRECTIVE.test(line));
}

function suppressionDiagnostics(context: StepContext, source: string): Diagnostic[] {
  return scanComments(source)
    .filter(isTsSuppressionDirective)
    .map((comment) =>
      context.diagnostic("TSC_SUPPRESSION_DIRECTIVE", "error", SUPPRESSION_MESSAGE, {
        line: comment.line,
        column: comment.column,
      }),
    );
}

// ---- program ----

/**
 * Nama modul di `allowed_imports` yang tidak punya deklarasi tipe di `packageRoot`. Kosong bila
 * semuanya terresolusi ke berkas `.d.ts` atau `.ts`.
 */
function unresolvedModules(
  names: readonly string[],
  file: VirtualFile,
  host: ts.CompilerHost,
): string[] {
  return names.filter((name) => {
    const { resolvedModule } = ts.resolveModuleName(
      name,
      file.path,
      TYPECHECK_COMPILER_OPTIONS,
      host,
    );
    return resolvedModule === undefined || !DECLARATION_EXTENSIONS.has(resolvedModule.extension);
  });
}

function internalFailure(context: StepContext): StepResult {
  return { diagnostics: [context.diagnostic("VERIFIER_INTERNAL", "error", INTERNAL_MESSAGE)] };
}

/**
 * Langkah 4 untuk akar paket tertentu. Produksi memakai `typecheckStep` (akar = paket ini); tes
 * memberi akar sementara untuk membuktikan perilaku saat deklarasi tidak ada.
 */
export function createTypecheckStep(packageRoot: string = PKG_ROOT): VerifierStep {
  return {
    number: 4,
    run(context) {
      const { source } = context.input;
      const file: VirtualFile = {
        path: `${packageRoot}/${VIRTUAL_DIRECTORY}/${context.contract.file_name}`,
        text: source,
        scriptKind: ts.ScriptKind.TS,
      };
      const diagnostics: Diagnostic[] = [];
      try {
        const libDirectory = dirname(ts.getDefaultLibFilePath(TYPECHECK_COMPILER_OPTIONS));
        const host = createDiskBackedHost(file, {
          readableRoots: [`${packageRoot}/node_modules`, libDirectory],
          libDirectory,
          sourceFileCache: SOURCE_FILE_CACHE,
        });
        if (unresolvedModules(Object.keys(context.contract.allowed_imports), file, host).length > 0) {
          return internalFailure(context);
        }
        const created = createVirtualProgram(file, TYPECHECK_COMPILER_OPTIONS, host);
        if (!created.ok) return internalFailure(context);

        for (const found of ts.getPreEmitDiagnostics(created.program, created.sourceFile)) {
          const severity = severityOf(found.category);
          if (severity === undefined) continue;
          const message = scrubPaths(
            ts.flattenDiagnosticMessageText(found.messageText, "\n"),
            packageRoot,
            libDirectory,
          );
          const start = found.file === created.sourceFile ? found.start : undefined;
          const where =
            start === undefined ? undefined : created.sourceFile.getLineAndCharacterOfPosition(start);
          diagnostics.push(
            context.diagnostic(
              `TSC_${found.code}`,
              severity,
              message,
              where === undefined ? undefined : { line: where.line + 1, column: where.character + 1 },
            ),
          );
        }
      } catch {
        return internalFailure(context);
      }
      for (const diagnostic of suppressionDiagnostics(context, source)) diagnostics.push(diagnostic);
      return { diagnostics };
    },
  };
}

export const typecheckStep: VerifierStep = createTypecheckStep();
