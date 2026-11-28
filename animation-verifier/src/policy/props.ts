// Bantuan untuk aturan elemen, atribut, URL, dan warna (design 5.5; Requirement 7.7 sampai 7.9, 7.16;
// tugas 4.3): mengenali pemanggilan `createElement` lewat tabel simbol (termasuk alias impor),
// menelusuri object props beserta object yang disebar `{...p}`, dan mengumpulkan nilai string yang
// mungkin dari sebuah ekspresi.
// Penelusuran bersifat statis dan hanya mengikuti hal yang pasti: object literal, `const` yang
// berinisialisasi, kedua cabang `?:`, dan sisi `||`, `??`, `&&`. Kunci dinamis (`{[k]: v}` dengan `k`
// tak terlipat), hasil pemanggilan fungsi, dan `let`/parameter tidak dilacak; ini batas yang sama
// dengan aturan inti (pemindaian adalah pertahanan berlapis, design 12).
// Modul ini murni terhadap keluaran: tanpa throw, jam, acak, atau akses disk. Satu-satunya status adalah
// memo `WeakMap` per node (`isTextChild`), yang hanya mempercepat jawaban yang sama.

import ts from "typescript";
import { propertyNameText } from "./core-rules.js";
import { constInitializer } from "./fold.js";
import type { PolicyScan } from "./scan.js";
import { importOriginOf, unwrapExpression, valueSymbolAt } from "./scope.js";

/** Modul dan nama impor `createElement`: fakta React, bukan nilai kontrak. */
const REACT_MODULE = "react";
const CREATE_ELEMENT = "createElement";

/** Argumen pertama `createElement` adalah tipe, kedua props, ketiga dan seterusnya anak (design 5.5). */
export const PROPS_ARGUMENT_INDEX = 1;
export const FIRST_CHILD_ARGUMENT_INDEX = 2;

// ---- createElement ----

/** Benar bila `identifier` adalah impor `createElement` dari `react` (juga beralias). */
export function isCreateElementIdentifier(scan: PolicyScan, identifier: ts.Identifier): boolean {
  const origin = importOriginOf(valueSymbolAt(scan.checker, identifier));
  return origin?.moduleName === REACT_MODULE && origin.importedName === CREATE_ELEMENT;
}

/** `node` bila ia pemanggilan yang callee langsungnya (setelah pembungkus transparan) adalah `createElement`. */
export function asCreateElementCall(scan: PolicyScan, node: ts.Node): ts.CallExpression | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const callee = unwrapExpression(node.expression);
  return ts.isIdentifier(callee) && isCreateElementIdentifier(scan, callee) ? node : undefined;
}

// ---- object props ----

/** Satu pasangan kunci dan nilai pada object props, sesudah semua spread diuraikan. */
export interface PropEntry {
  /** Kunci (kunci terhitung dilipat); `undefined` bila tidak dapat diketahui. */
  readonly key: string | undefined;
  /** Node nama tempat temuan dilaporkan. */
  readonly at: ts.Node;
  /** Nilai; `undefined` untuk method dan accessor. */
  readonly value: ts.Expression | undefined;
}

/**
 * Nilai sebuah shorthand `{ style }`: initializer `const` yang ia baca, atau namanya bila tidak
 * ter-resolve. `getSymbolAtLocation` pada nama shorthand mengembalikan simbol properti, bukan
 * variabel, jadi simbol nilainya diminta lewat API khusus.
 */
function shorthandValue(scan: PolicyScan, property: ts.ShorthandPropertyAssignment): ts.Expression {
  const declarations = scan.checker.getShorthandAssignmentValueSymbol(property)?.declarations;
  const declaration = declarations?.length === 1 ? declarations[0] : undefined;
  if (
    declaration !== undefined &&
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer !== undefined &&
    (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0 &&
    declaration.getSourceFile() === scan.sourceFile
  ) {
    return declaration.initializer;
  }
  return property.name;
}

function isLogicalOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.BarBarToken ||
    kind === ts.SyntaxKind.QuestionQuestionToken ||
    kind === ts.SyntaxKind.AmpersandAmpersandToken
  );
}

/**
 * Semua pasangan kunci-nilai yang dapat dibaca dari `expression` bila ia object props: object
 * literal, `const` yang berisi object literal, kedua cabang `?:`, sisi `||`/`??`/`&&`, dan object
 * yang disebar `{...p}` (rekursif, dibatasi `fold_depth`, tiap object literal hanya sekali).
 */
export function propEntries(scan: PolicyScan, expression: ts.Expression): PropEntry[] {
  const entries: PropEntry[] = [];
  const seen = new Set<ts.Node>();
  const maxDepth = scan.contract.limits.fold_depth;
  const foldOptions = { checker: scan.checker, sourceFile: scan.sourceFile, maxDepth };

  const visit = (candidate: ts.Expression, depth: number): void => {
    if (depth > maxDepth) return;
    const target = unwrapExpression(candidate);
    if (ts.isObjectLiteralExpression(target)) {
      if (seen.has(target)) return;
      seen.add(target);
      for (const property of target.properties) {
        if (ts.isSpreadAssignment(property)) {
          visit(property.expression, depth + 1);
        } else if (ts.isShorthandPropertyAssignment(property)) {
          entries.push({ key: property.name.text, at: property.name, value: shorthandValue(scan, property) });
        } else if (ts.isPropertyAssignment(property)) {
          entries.push({
            key: propertyNameText(scan, property.name),
            at: property.name,
            value: property.initializer,
          });
        } else {
          entries.push({ key: propertyNameText(scan, property.name), at: property.name, value: undefined });
        }
      }
    } else if (ts.isConditionalExpression(target)) {
      visit(target.whenTrue, depth + 1);
      visit(target.whenFalse, depth + 1);
    } else if (ts.isBinaryExpression(target) && isLogicalOperator(target.operatorToken.kind)) {
      visit(target.left, depth + 1);
      visit(target.right, depth + 1);
    } else if (ts.isIdentifier(target)) {
      const initializer = constInitializer(target, foldOptions);
      if (initializer !== undefined) visit(initializer, depth + 1);
    }
  };
  visit(expression, 0);
  return entries;
}

// ---- nilai string ----

/** Nilai string yang mungkin dari sebuah ekspresi, dengan node tempat ia dilaporkan. */
export interface StringCandidate {
  readonly node: ts.Expression;
  readonly text: string;
}

/**
 * Hasil lipatan `expression`, atau hasil lipatan tiap cabang bila ia `?:`, `||`, `??`, atau `&&`.
 * Cabang yang tidak dapat dilipat tidak menghasilkan apa pun (tidak diketahui, bukan aman).
 */
export function stringCandidates(scan: PolicyScan, expression: ts.Expression): StringCandidate[] {
  const candidates: StringCandidate[] = [];
  const maxDepth = scan.contract.limits.fold_depth;

  const visit = (candidate: ts.Expression, depth: number): void => {
    if (depth > maxDepth) return;
    const folded = scan.fold(candidate);
    if (folded !== undefined) {
      candidates.push({ node: candidate, text: folded });
      return;
    }
    const target = unwrapExpression(candidate);
    if (ts.isConditionalExpression(target)) {
      visit(target.whenTrue, depth + 1);
      visit(target.whenFalse, depth + 1);
    } else if (ts.isBinaryExpression(target) && isLogicalOperator(target.operatorToken.kind)) {
      visit(target.left, depth + 1);
      visit(target.right, depth + 1);
    }
  };
  visit(expression, 0);
  return candidates;
}

// ---- posisi literal ----

/** Pembungkus yang meneruskan nilai string apa adanya ke induknya. */
function passesStringThrough(parent: ts.Node, child: ts.Node): boolean {
  if (
    ts.isParenthesizedExpression(parent) ||
    ts.isAsExpression(parent) ||
    ts.isNonNullExpression(parent) ||
    ts.isSatisfiesExpression(parent) ||
    ts.isTypeAssertionExpression(parent)
  ) {
    return true;
  }
  if (ts.isBinaryExpression(parent)) return parent.operatorToken.kind === ts.SyntaxKind.PlusToken;
  if (ts.isTemplateSpan(parent) || ts.isTemplateExpression(parent)) return true;
  return ts.isConditionalExpression(parent) && parent.condition !== child;
}

/**
 * Posisi `node` terhadap `createElement` tidak berubah di sepanjang rantai pembungkus: semua node
 * pada rantai yang sama punya jawaban sama. Jawaban disimpan per node supaya rantai `+` sangat
 * panjang (ribuan operand) tidak dinaiki berulang dari setiap literalnya (kuadratik).
 */
const textChildCache = new WeakMap<ts.Node, boolean>();

/** `node` sendiri argumen ketiga atau berikutnya dari pemanggilan `createElement`. */
function isChildArgument(scan: PolicyScan, node: ts.Node): boolean {
  const call = node.parent === undefined ? undefined : asCreateElementCall(scan, node.parent);
  if (call === undefined) return false;
  return call.arguments.findIndex((argument) => argument === node) >= FIRST_CHILD_ARGUMENT_INDEX;
}

/**
 * Benar bila `node` adalah teks anak langsung `createElement`: argumen ketiga dan seterusnya,
 * juga bila dibungkus kurung, `as`, `+`, template, atau `?:` (Requirement 7.9).
 */
export function isTextChild(scan: PolicyScan, node: ts.Node): boolean {
  const climbed: ts.Node[] = [];
  let current: ts.Node = node;
  let answer: boolean | undefined;
  while (answer === undefined) {
    answer = textChildCache.get(current);
    if (answer !== undefined) break;
    climbed.push(current);
    const parent: ts.Node | undefined = current.parent;
    if (parent === undefined || !passesStringThrough(parent, current)) {
      answer = isChildArgument(scan, current);
    } else {
      current = parent;
    }
  }
  for (const visited of climbed) textChildCache.set(visited, answer);
  return answer;
}

/**
 * Benar bila `node` adalah nama modul pada `import`, `export ... from`, atau `import x = require()`.
 * Nama modul sudah dilaporkan aturan impor, jadi aturan URL dan warna tidak melaporkannya lagi.
 */
export function isModuleSpecifier(node: ts.Node): boolean {
  const parent = node.parent;
  if (parent === undefined) return false;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) {
    return parent.moduleSpecifier === node;
  }
  return ts.isExternalModuleReference(parent);
}
