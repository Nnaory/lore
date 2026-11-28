// Klasifikasi identifier dan cakupan untuk pemindaian kebijakan (design 5.5 "Klasifikasi identifier";
// Requirement 7.5, 7.15, 7.17; tugas 4.2).
// Pertanyaan yang dijawab modul ini: apakah sebuah `Identifier` adalah REFERENSI NILAI (bukan nama
// deklarasi, kunci, nama anggota, label, nama impor/ekspor, atau bagian dari tipe), dan apakah ia
// ter-resolve ke deklarasi LOKAL (di `main.ts`, bukan `declare`, bukan hanya tipe). Nama terlarang
// yang merupakan referensi nilai dan tidak lokal adalah pemakaian global yang terlarang, sedangkan
// `const top = 1` atau kunci `{ top: 10 }` bukan. `declare const window: any` tetap dihitung global
// karena deklarasi ambient tidak mendefinisikan nilai apa pun saat berjalan (Requirement 7.15).
// `importOriginOf` mengenali simbol hasil impor beralias (`import { random as r }`) tanpa meresolusi
// modul; tugas 4.3 memakainya untuk `createElement` beralias dan komponen yang diizinkan.
// Juga memuat tabel alias objek global (`const M = Math`, "mathAliases" pada design) yang dibangun
// tanpa memanggil TypeChecker berulang: simbol alias dicari sekali, lalu rantai alias ditelusuri
// lewat peta pengikut. Tidak ada iterasi `Set`/`Map` di jalur keluaran; semua pencarian lewat `get`/`has`.
// Modul ini murni: tanpa throw, jam, acak, atau akses disk.

import ts from "typescript";
import { walkNodes } from "./walk.js";

// ---- deklarasi ----

/**
 * Benar bila deklarasi memakai `declare` atau berada di dalam konteks ambient (`declare namespace`,
 * `declare global`). Modifier `declare` pada `declare const x` menempel di `VariableStatement`, jadi
 * penelusuran naik lewat induk dan memeriksa modifier tiap node.
 */
export function isAmbientDeclaration(declaration: ts.Declaration): boolean {
  for (let node: ts.Node | undefined = declaration; node !== undefined; node = node.parent) {
    if (!ts.canHaveModifiers(node)) continue;
    const modifiers = ts.getModifiers(node);
    if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) === true) {
      return true;
    }
  }
  return false;
}

/** Benar untuk `interface`, `type`, parameter tipe, dan impor/ekspor `type`: tidak membuat nilai saat berjalan. */
export function isTypeOnlyDeclaration(declaration: ts.Declaration): boolean {
  if (
    ts.isInterfaceDeclaration(declaration) ||
    ts.isTypeAliasDeclaration(declaration) ||
    ts.isTypeParameterDeclaration(declaration)
  ) {
    return true;
  }
  if (ts.isImportSpecifier(declaration)) {
    return declaration.isTypeOnly || declaration.parent.parent.isTypeOnly;
  }
  if (ts.isImportClause(declaration)) return declaration.isTypeOnly;
  if (ts.isNamespaceImport(declaration)) return declaration.parent.isTypeOnly;
  if (ts.isImportEqualsDeclaration(declaration)) return declaration.isTypeOnly;
  return false;
}

/**
 * Benar bila `symbol` punya sedikitnya satu deklarasi yang dibuat di `sourceFile`, bukan ambient,
 * dan bukan hanya tipe. Simbol tanpa deklarasi (nama global tanpa lib) bukan lokal.
 */
export function hasLocalValueDeclaration(
  symbol: ts.Symbol | undefined,
  sourceFile: ts.SourceFile,
): boolean {
  const declarations = symbol?.declarations;
  if (declarations === undefined) return false;
  return declarations.some(
    (declaration) =>
      declaration.getSourceFile() === sourceFile &&
      !isAmbientDeclaration(declaration) &&
      !isTypeOnlyDeclaration(declaration),
  );
}

/**
 * Simbol nilai untuk `identifier`. Shorthand `{ window }` membaca variabel `window`, sedangkan
 * `getSymbolAtLocation` mengembalikan simbol properti; karena itu dipakai API khusus shorthand.
 */
export function valueSymbolAt(
  checker: ts.TypeChecker,
  identifier: ts.Identifier,
): ts.Symbol | undefined {
  const parent = identifier.parent;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === identifier) {
    return checker.getShorthandAssignmentValueSymbol(parent);
  }
  return checker.getSymbolAtLocation(identifier);
}

/** Benar bila `identifier` ter-resolve ke deklarasi lokal (lihat `hasLocalValueDeclaration`). */
export function isLocalValue(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  identifier: ts.Identifier,
): boolean {
  return hasLocalValueDeclaration(valueSymbolAt(checker, identifier), sourceFile);
}

// ---- referensi nilai ----

/**
 * Benar bila `identifier` menempati posisi yang bukan referensi: nama deklarasi apa pun
 * (`name`), kunci atau nama impor/ekspor (`propertyName`), label (`label`), atau sisi kanan
 * nama berkualifikasi (`a.b` pada tipe). Nama anggota `a.name` juga lewat `name`.
 */
function occupiesNonReferenceSlot(parent: ts.Node, identifier: ts.Identifier): boolean {
  if ("name" in parent && parent.name === identifier) return true;
  if ("propertyName" in parent && parent.propertyName === identifier) return true;
  if ("label" in parent && parent.label === identifier) return true;
  return ts.isQualifiedName(parent) && parent.right === identifier;
}

/** `class A extends X {}`: ekspresi pada `extends` kelas adalah nilai walau dibungkus node bertipe. */
function isClassExtendsExpression(node: ts.ExpressionWithTypeArguments): boolean {
  const clause = node.parent;
  return (
    ts.isHeritageClause(clause) &&
    clause.token === ts.SyntaxKind.ExtendsKeyword &&
    ts.isClassLike(clause.parent)
  );
}

/**
 * Benar bila `node` berada di dalam sebuah TypeNode (`let x: typeof window`, `as Window`). Posisi
 * tipe dihapus saat kompilasi, jadi tidak pernah berupa referensi nilai. Pengecualian: ekspresi
 * `extends` kelas, yang dievaluasi saat berjalan.
 */
function isInsideTypeNode(node: ts.Node): boolean {
  for (let ancestor: ts.Node | undefined = node.parent; ancestor !== undefined; ancestor = ancestor.parent) {
    if (!ts.isTypeNode(ancestor)) continue;
    if (ts.isExpressionWithTypeArguments(ancestor) && isClassExtendsExpression(ancestor)) continue;
    return true;
  }
  return false;
}

/**
 * Benar bila `identifier` adalah referensi nilai (Requirement 7.5): bukan nama deklarasi, bukan
 * nama properti pada akses anggota, bukan kunci object literal, bukan label, bukan nama
 * impor/ekspor, dan bukan bagian dari tipe. Shorthand `{ window }` adalah referensi nilai.
 */
export function isValueReference(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === identifier) return true;
  if (occupiesNonReferenceSlot(parent, identifier)) return false;
  return !isInsideTypeNode(identifier);
}

// ---- asal impor ----

export interface ImportOrigin {
  /** Modul sumber, mis. `react`. */
  readonly moduleName: string;
  /** Nama pada modul sumber (`propertyName`), bukan nama lokal hasil `as`. */
  readonly importedName: string;
}

/**
 * Asal sebuah simbol yang diimpor dengan `import { name as local } from "modul"`, atau `undefined`
 * bila simbol itu bukan impor bernama. Tidak meresolusi modul (`noResolve`): hanya membaca deklarasi
 * impor di berkas ini, sehingga alias (`import { createElement as h }`) dikenali lewat simbolnya.
 */
export function importOriginOf(symbol: ts.Symbol | undefined): ImportOrigin | undefined {
  for (const declaration of symbol?.declarations ?? []) {
    if (!ts.isImportSpecifier(declaration)) continue;
    const specifier = declaration.parent.parent.parent.moduleSpecifier;
    if (!ts.isStringLiteralLike(specifier)) continue;
    return {
      moduleName: specifier.text,
      importedName: (declaration.propertyName ?? declaration.name).text,
    };
  }
  return undefined;
}

// ---- pembungkus ekspresi ----

type TransparentWrapper =
  | ts.ParenthesizedExpression
  | ts.NonNullExpression
  | ts.AsExpression
  | ts.TypeAssertion
  | ts.SatisfiesExpression;

/** Pembungkus yang tidak mengubah nilai saat berjalan: `(x)`, `x!`, `x as T`, `<T>x`, `x satisfies T`. */
function isTransparentWrapper(node: ts.Node): node is TransparentWrapper {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node)
  );
}

/** Mengupas pembungkus transparan sampai ekspresi sebenarnya. */
export function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (isTransparentWrapper(current)) current = current.expression;
  return current;
}

/**
 * Benar bila `node` (setelah naik melewati pembungkus transparan) adalah callee sebuah `CallExpression`,
 * mis. `require("x")`, `(require)("x")`, `require?.("x")`.
 */
export function isCalleeExpression(node: ts.Expression): boolean {
  let current: ts.Node = node;
  while (isTransparentWrapper(current.parent)) current = current.parent;
  const parent = current.parent;
  return ts.isCallExpression(parent) && parent.expression === current;
}

// ---- alias objek global ----

/**
 * Menjawab "ekspresi ini adalah objek global terlarang yang mana" (mis. `Math`), atau `undefined`.
 * Pemanggil memberi fungsinya karena daftar objek berasal dari kontrak, bukan dari modul ini.
 */
export type RootOf = (expression: ts.Expression) => string | undefined;

interface AliasCandidate {
  readonly target: ts.Symbol;
  readonly value: ts.Expression;
}

function aliasCandidate(checker: ts.TypeChecker, node: ts.Node): AliasCandidate | undefined {
  if (
    (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) &&
    ts.isIdentifier(node.name) &&
    node.initializer !== undefined
  ) {
    const target = checker.getSymbolAtLocation(node.name);
    return target === undefined ? undefined : { target, value: node.initializer };
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const left = unwrapExpression(node.left);
    if (!ts.isIdentifier(left)) return undefined;
    const target = checker.getSymbolAtLocation(left);
    return target === undefined ? undefined : { target, value: node.right };
  }
  return undefined;
}

/**
 * Tabel alias ("mathAliases"): simbol variabel yang diisi objek global terlarang, langsung
 * (`const M = Math`, juga lewat `(Math)`, `Math as any`) atau lewat rantai (`const N = M`).
 * Jenis deklarasi tidak dibedakan (`let` dan `var` juga), begitu pula penugasan `M = Math`,
 * karena pelacakan alur tidak dilakukan. Urutan sumber tidak berpengaruh: alias yang dipakai
 * sebelum dideklarasikan (di dalam fungsi) tetap tertangkap. Biayanya linear terhadap jumlah deklarasi.
 */
export function collectAliasSymbols(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  rootOf: RootOf,
): ReadonlyMap<ts.Symbol, string> {
  const aliases = new Map<ts.Symbol, string>();
  const followers = new Map<ts.Symbol, ts.Symbol[]>();
  const pending: ts.Symbol[] = [];

  walkNodes(sourceFile, (node) => {
    const candidate = aliasCandidate(checker, node);
    if (candidate === undefined) return;
    const value = unwrapExpression(candidate.value);
    const root = rootOf(value);
    if (root !== undefined) {
      if (!aliases.has(candidate.target)) {
        aliases.set(candidate.target, root);
        pending.push(candidate.target);
      }
      return;
    }
    if (!ts.isIdentifier(value)) return;
    const source = checker.getSymbolAtLocation(value);
    if (source === undefined) return;
    const list = followers.get(source);
    if (list === undefined) followers.set(source, [candidate.target]);
    else list.push(candidate.target);
  });

  for (let source = pending.pop(); source !== undefined; source = pending.pop()) {
    const root = aliases.get(source);
    if (root === undefined) continue;
    for (const follower of followers.get(source) ?? []) {
      if (aliases.has(follower)) continue;
      aliases.set(follower, root);
      pending.push(follower);
    }
  }
  return aliases;
}
