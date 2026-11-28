// Kerangka pemindaian kebijakan: konteks bersama, antarmuka aturan, dan penjalan (design 5.5;
// Requirement 7.12; tugas 4.2).
// Seluruh aturan langkah 2 berbagi satu `PolicyScan` per invokasi (Program, TypeChecker, kontrak,
// pelipat string, tabel alias objek global) dan dijalankan dalam satu lintasan: tiap node dikunjungi
// sekali dan setiap aturan melihatnya, sehingga semua temuan terkumpul tanpa berhenti pada yang
// pertama. Aturan yang bersifat tingkat berkas (meta, ekspor) memakai `finish`, yang dipanggil
// sesudah semua node dikunjungi.
// Titik sambung tugas 4.3: aturan baru adalah objek `PolicyRule` yang ditambahkan ke `POLICY_RULES`
// di `steps/policy.ts`. Aturan membuat Diagnostic hanya lewat `scan.report` (posisi basis 1,
// pesan dipotong ke batas kontrak, duplikat pada posisi dan pesan sama dibuang), dan aturan meta
// mengisi `META_ARTIFACT` lewat `scan.context.artifacts` di `finish`.
// Modul ini tidak membaca jam, acak, atau disk, dan tidak melempar di batas modul.

import ts from "typescript";
import type { Contract } from "../contract.js";
import type { StepContext } from "../steps/step.js";
import type { Diagnostic, Severity } from "../types.js";
import { type FoldOptions, foldString } from "./fold.js";
import { type RootOf, collectAliasSymbols, isLocalValue, unwrapExpression } from "./scope.js";
import { walkNodes } from "./walk.js";

export interface PolicyScan {
  readonly context: StepContext;
  readonly contract: Contract;
  readonly sourceFile: ts.SourceFile;
  readonly checker: ts.TypeChecker;
  /**
   * `forbidden.member` dari kontrak dipecah per objek: `"Math.random"` menjadi `Math` dengan
   * himpunan `{random}`. Entri tanpa titik atau dengan sisi kosong diabaikan.
   */
  readonly forbiddenMembers: ReadonlyMap<string, ReadonlySet<string>>;
  /** Tabel `mathAliases`: simbol variabel yang berisi objek global terlarang, dan objeknya. */
  readonly memberAliases: ReadonlyMap<ts.Symbol, string>;
  /** Diagnostic yang terkumpul, dalam urutan penemuan (urutan keluaran dibuat `finalize`). */
  readonly diagnostics: readonly Diagnostic[];
  /** Melipat ekspresi menjadi string (kedalaman `limits.fold_depth`), atau `undefined`. */
  fold(node: ts.Node): string | undefined;
  /** Benar bila `identifier` ter-resolve ke deklarasi lokal (bukan ambient, bukan hanya tipe). */
  isLocalValue(identifier: ts.Identifier): boolean;
  /**
   * Menambah Diagnostic pada awal `at` (node, atau offset karakter). `line` dan `column` basis 1.
   * Diagnostic dengan kode, posisi, dan pesan sama dengan yang sudah ada dibuang.
   */
  report(code: string, at: ts.Node | number, message: string, severity?: Severity): void;
}

export interface PolicyRule {
  /** Dipanggil untuk setiap node menurut urutan dokumen (pra-urut). */
  visit?(node: ts.Node, scan: PolicyScan): void;
  /** Dipanggil sekali setelah semua node dikunjungi, untuk aturan tingkat berkas. */
  finish?(scan: PolicyScan): void;
}

/** `forbidden.member` menjadi peta objek ke himpunan properti terlarang. */
function parseForbiddenMembers(entries: readonly string[]): Map<string, Set<string>> {
  const table = new Map<string, Set<string>>();
  for (const entry of entries) {
    const dot = entry.indexOf(".");
    const object = entry.slice(0, dot);
    const property = entry.slice(dot + 1);
    if (dot < 1 || property === "") continue;
    const properties = table.get(object);
    if (properties === undefined) table.set(object, new Set([property]));
    else properties.add(property);
  }
  return table;
}

export function createPolicyScan(
  context: StepContext,
  program: { readonly checker: ts.TypeChecker; readonly sourceFile: ts.SourceFile },
): PolicyScan {
  const { contract } = context;
  const { checker, sourceFile } = program;
  const foldOptions: FoldOptions = { checker, sourceFile, maxDepth: contract.limits.fold_depth };
  const forbiddenMembers = parseForbiddenMembers(contract.forbidden.member);

  const localValue = (identifier: ts.Identifier): boolean =>
    isLocalValue(checker, sourceFile, identifier);

  // Objek global terlarang (mis. `Math`) hanya bila tidak ter-shadow oleh deklarasi lokal.
  const rootOf: RootOf = (expression) => {
    const target = unwrapExpression(expression);
    if (!ts.isIdentifier(target) || !forbiddenMembers.has(target.text)) return undefined;
    return localValue(target) ? undefined : target.text;
  };
  const memberAliases = collectAliasSymbols(sourceFile, checker, rootOf);

  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();

  return {
    context,
    contract,
    sourceFile,
    checker,
    forbiddenMembers,
    memberAliases,
    diagnostics,
    fold: (node) => foldString(node, foldOptions),
    isLocalValue: localValue,
    report(code, at, message, severity = "error") {
      const start = typeof at === "number" ? at : at.getStart(sourceFile);
      const key = `${code}\u0000${start}\u0000${message}`;
      if (seen.has(key)) return;
      seen.add(key);
      const position = sourceFile.getLineAndCharacterOfPosition(start);
      diagnostics.push(
        context.diagnostic(code, severity, message, {
          line: position.line + 1,
          column: position.character + 1,
        }),
      );
    },
  };
}

/** Satu lintasan: semua aturan melihat setiap node, lalu `finish` tiap aturan. */
export function runPolicyRules(scan: PolicyScan, rules: readonly PolicyRule[]): void {
  walkNodes(scan.sourceFile, (node) => {
    for (const rule of rules) rule.visit?.(node, scan);
  });
  for (const rule of rules) rule.finish?.(scan);
}
