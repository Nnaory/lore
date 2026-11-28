// Aturan inti pemindaian kebijakan, langkah 2 bagian 1 (design 5.5 tabel aturan; tugas 4.2).
// Enam kode: `POLICY_JSX_SYNTAX`, `POLICY_IMPORT_DISALLOWED`, `POLICY_DYNAMIC_IMPORT`,
// `POLICY_FORBIDDEN_IDENTIFIER`, `POLICY_FORBIDDEN_MEMBER`, `POLICY_FORBIDDEN_PROPERTY`
// (Requirement 7.3 sampai 7.6, 7.12, 7.15 sampai 7.17, 7.20, 1.6, 1.10, 1.18). Semua daftar nama
// (impor yang diizinkan, identifier, anggota, properti terlarang) dibaca dari kontrak; satu-satunya
// nama yang ditulis di sini adalah `require`, yaitu fakta bahasa (fungsi CommonJS), bukan nilai kontrak.
// Setiap aturan adalah `PolicyRule` bersifat murni terhadap `PolicyScan`: ia hanya menambah Diagnostic
// lewat `scan.report` dan tidak menyimpan status antar-node. Aturan bagian 2 (elemen, atribut, URL,
// warna, meta, ekspor; tugas 4.3) berada di berkas lain dan didaftarkan di `steps/policy.ts`.
// Batasan yang disengaja (pemindaian ini pertahanan berlapis, bukan batas keamanan, design 12): alias
// yang dibentuk lewat ekspresi bercabang atau array (`[Math][0]`) dan kunci dinamis (`x[i]`) tidak dilacak.

import ts from "typescript";
import type { PolicyRule, PolicyScan } from "./scan.js";
import {
  importOriginOf,
  isCalleeExpression,
  isValueReference,
  unwrapExpression,
} from "./scope.js";

/** `require` adalah identifier CommonJS; pemanggilannya dilaporkan sebagai impor dinamis (Requirement 7.20). */
const REQUIRE = "require";

// ---- POLICY_JSX_SYNTAX ----

/** Setiap node JSX, termasuk fragmen dan elemen bersarang (Requirement 7.3). */
export const jsxRule: PolicyRule = {
  visit(node, scan) {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
      scan.report("POLICY_JSX_SYNTAX", node, "JSX is not allowed, use createElement");
    }
  },
};

// ---- POLICY_IMPORT_DISALLOWED ----

export interface AllowedNames {
  readonly values: readonly string[];
  readonly types: readonly string[];
}

/** Nama yang diizinkan untuk `moduleName`, atau `undefined` bila modul tidak diizinkan (hanya kunci milik sendiri). */
export function allowedNamesOf(scan: PolicyScan, moduleName: string): AllowedNames | undefined {
  const table = scan.contract.allowed_imports;
  return Object.hasOwn(table, moduleName) ? table[moduleName] : undefined;
}

function moduleNameOf(specifier: ts.Expression): string {
  return ts.isStringLiteralLike(specifier) ? specifier.text : "(unknown)";
}

function reportDisallowedImport(
  scan: PolicyScan,
  at: ts.Node,
  name: string,
  moduleName: string,
): void {
  scan.report(
    "POLICY_IMPORT_DISALLOWED",
    at,
    `import of ${name} from ${moduleName} is not allowed`,
  );
}

function checkImportDeclaration(scan: PolicyScan, node: ts.ImportDeclaration): void {
  const moduleName = moduleNameOf(node.moduleSpecifier);
  const allowed = allowedNamesOf(scan, moduleName);
  const clause = node.importClause;

  if (clause === undefined) {
    reportDisallowedImport(scan, node, "(side-effect import)", moduleName);
    return;
  }
  if (clause.name !== undefined) reportDisallowedImport(scan, clause.name, "default", moduleName);

  const bindings = clause.namedBindings;
  if (bindings === undefined) return;
  if (ts.isNamespaceImport(bindings)) {
    reportDisallowedImport(scan, bindings, `* as ${bindings.name.text}`, moduleName);
    return;
  }
  for (const specifier of bindings.elements) {
    // Nama yang diimpor (`propertyName`), bukan nama lokal hasil `as`.
    const imported = (specifier.propertyName ?? specifier.name).text;
    const permitted =
      allowed !== undefined && (allowed.values.includes(imported) || allowed.types.includes(imported));
    if (!permitted) reportDisallowedImport(scan, specifier, imported, moduleName);
  }
}

/**
 * Impor di luar daftar kontrak dan semua bentuk impor yang dilarang: modul lain, nama di luar
 * daftar, namespace, default, side-effect, dan `export ... from` (Requirement 7.4).
 * `import x = require()` bukan di sini: itu `POLICY_DYNAMIC_IMPORT`.
 */
export const importRule: PolicyRule = {
  visit(node, scan) {
    if (ts.isImportDeclaration(node)) {
      checkImportDeclaration(scan, node);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      scan.report(
        "POLICY_IMPORT_DISALLOWED",
        node,
        `re-export from ${moduleNameOf(node.moduleSpecifier)} is not allowed`,
      );
    }
  },
};

// ---- POLICY_DYNAMIC_IMPORT ----

/**
 * `import(...)`, pemanggilan `require(...)` yang bukan variabel lokal, dan `import x = require()`
 * (Requirement 7.4, 7.20). Identifier `require` yang tidak dipanggil dilaporkan aturan identifier.
 */
export const dynamicImportRule: PolicyRule = {
  visit(node, scan) {
    const message = "dynamic import and require are not allowed";
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        scan.report("POLICY_DYNAMIC_IMPORT", node, message);
        return;
      }
      const callee = unwrapExpression(node.expression);
      if (ts.isIdentifier(callee) && callee.text === REQUIRE && !scan.isLocalValue(callee)) {
        scan.report("POLICY_DYNAMIC_IMPORT", node, message);
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      scan.report("POLICY_DYNAMIC_IMPORT", node, message);
    }
  },
};

// ---- POLICY_FORBIDDEN_IDENTIFIER ----

/**
 * Referensi nilai bernama terlarang yang tidak ter-resolve ke deklarasi lokal (Requirement 7.5,
 * 7.15). Nama properti, kunci object literal, nama deklarasi, label, dan posisi tipe tidak dihitung;
 * `declare const window: any` dan deklarasi tipe tetap dihitung global.
 */
export const identifierRule: PolicyRule = {
  visit(node, scan) {
    if (!ts.isIdentifier(node) || !scan.contract.forbiddenIdentifiers.has(node.text)) return;
    if (!isValueReference(node) || scan.isLocalValue(node)) return;
    // `require("x")` dilaporkan sebagai impor dinamis oleh `dynamicImportRule`.
    if (node.text === REQUIRE && isCalleeExpression(node)) return;
    scan.report("POLICY_FORBIDDEN_IDENTIFIER", node, `identifier ${node.text} is not allowed`);
  },
};

// ---- bantuan untuk kunci properti ----

/** Teks kunci sebuah nama properti; kunci terhitung dilipat. `undefined` bila tidak diketahui. */
export function propertyNameText(scan: PolicyScan, name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) return scan.fold(name.expression);
  return undefined;
}

interface DestructuredProperty {
  /** Kunci properti yang dibaca dari sumber, bila diketahui. */
  readonly key: string | undefined;
  /** Ekspresi yang dibongkar (`= Math`), bila ada. */
  readonly source: ts.Expression | undefined;
}

/**
 * Kunci yang dibaca oleh satu elemen destructuring: `const { a, b: c, ["d"]: e } = x`, parameter
 * `({ a })`, dan penugasan `({ a, b: c } = x)`. Object literal yang bukan target penugasan
 * (`const o = { constructor: 1 }`) bukan destructuring dan menghasilkan `undefined`.
 */
function destructuredProperty(scan: PolicyScan, node: ts.Node): DestructuredProperty | undefined {
  if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
    if (node.dotDotDotToken !== undefined) return undefined;
    const key =
      node.propertyName !== undefined
        ? propertyNameText(scan, node.propertyName)
        : ts.isIdentifier(node.name)
          ? node.name.text
          : undefined;
    return { key, source: node.parent.parent.initializer };
  }
  if (
    (ts.isShorthandPropertyAssignment(node) || ts.isPropertyAssignment(node)) &&
    ts.isObjectLiteralExpression(node.parent)
  ) {
    const assignment = node.parent.parent;
    const isTarget =
      ts.isBinaryExpression(assignment) &&
      assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      assignment.left === node.parent;
    if (!isTarget) return undefined;
    const key = ts.isShorthandPropertyAssignment(node)
      ? node.name.text
      : propertyNameText(scan, node.name);
    return { key, source: assignment.right };
  }
  return undefined;
}

// ---- POLICY_FORBIDDEN_MEMBER ----

/** Pesan tabel 5.12 untuk `POLICY_FORBIDDEN_MEMBER`. */
function forbiddenMemberMessage(member: string): string {
  return `${member} is not allowed, use random(seed) from remotion`;
}

/** Nama objek global terlarang yang diwakili `expression` (langsung atau lewat alias), atau `undefined`. */
function memberObjectOf(scan: PolicyScan, expression: ts.Expression): string | undefined {
  const target = unwrapExpression(expression);
  if (!ts.isIdentifier(target)) return undefined;
  const symbol = scan.checker.getSymbolAtLocation(target);
  const aliased = symbol === undefined ? undefined : scan.memberAliases.get(symbol);
  if (aliased !== undefined) return aliased;
  return scan.forbiddenMembers.has(target.text) && !scan.isLocalValue(target)
    ? target.text
    : undefined;
}

/** `"Math.random"` bila `object` adalah objek terlarang dan `key` salah satu propertinya. */
function forbiddenMemberName(
  scan: PolicyScan,
  object: ts.Expression,
  key: string | undefined,
): string | undefined {
  if (key === undefined) return undefined;
  const objectName = memberObjectOf(scan, object);
  if (objectName === undefined) return undefined;
  return scan.forbiddenMembers.get(objectName)?.has(key) === true ? `${objectName}.${key}` : undefined;
}

/**
 * Nama impor terlarang bila dipanggil dengan literal `null`: nama properti yang terlarang pada
 * `forbidden.member` yang juga merupakan nilai impor yang diizinkan (`random` dari `remotion`).
 * `random(null)` jatuh ke `Math.random` di dalam remotion (Requirement 1.18).
 */
function seedlessImportCall(scan: PolicyScan, call: ts.CallExpression): string | undefined {
  const callee = unwrapExpression(call.expression);
  const first = call.arguments[0];
  if (!ts.isIdentifier(callee) || first === undefined) return undefined;
  if (unwrapExpression(first).kind !== ts.SyntaxKind.NullKeyword) return undefined;
  const origin = importOriginOf(scan.checker.getSymbolAtLocation(callee));
  if (origin === undefined) return undefined;
  const isForbiddenName = [...scan.forbiddenMembers.values()].some((names) =>
    names.has(origin.importedName),
  );
  const isAllowedValue =
    allowedNamesOf(scan, origin.moduleName)?.values.includes(origin.importedName) === true;
  return isForbiddenName && isAllowedValue ? origin.importedName : undefined;
}

/**
 * `Math.random`, `Math["random"]` (kunci dilipat), alias (`const M = Math; M.random`),
 * destructuring (`const { random } = Math`, juga penugasan), dan `random(null)` dari `remotion`
 * (Requirement 7.6, 7.16, 7.17, 1.18). Objek lokal bernama sama (`const Math = {...}`) tidak dihitung.
 */
export const memberRule: PolicyRule = {
  visit(node, scan) {
    if (ts.isPropertyAccessExpression(node)) {
      const member = forbiddenMemberName(scan, node.expression, node.name.text);
      if (member !== undefined) scan.report("POLICY_FORBIDDEN_MEMBER", node, forbiddenMemberMessage(member));
      return;
    }
    if (ts.isElementAccessExpression(node)) {
      const key = scan.fold(node.argumentExpression);
      const member = forbiddenMemberName(scan, node.expression, key);
      if (member !== undefined) scan.report("POLICY_FORBIDDEN_MEMBER", node, forbiddenMemberMessage(member));
      return;
    }
    if (ts.isCallExpression(node)) {
      const imported = seedlessImportCall(scan, node);
      if (imported !== undefined) {
        scan.report("POLICY_FORBIDDEN_MEMBER", node, forbiddenMemberMessage(`${imported}(null)`));
      }
      return;
    }
    const destructured = destructuredProperty(scan, node);
    if (destructured?.source === undefined) return;
    const member = forbiddenMemberName(scan, destructured.source, destructured.key);
    if (member !== undefined) scan.report("POLICY_FORBIDDEN_MEMBER", node, forbiddenMemberMessage(member));
  },
};

// ---- POLICY_FORBIDDEN_PROPERTY ----

function forbiddenPropertyMessage(name: string): string {
  return `property ${name} is not allowed`;
}

/**
 * Akses properti atau elemen dengan kunci (hasil lipatan) `constructor`, `__proto__`, atau
 * `prototype`, juga lewat destructuring (Requirement 7.6, 7.16). Definisi anggota
 * (`class A { constructor() {} }`, `{ constructor: 1 }`) bukan akses dan tidak dilaporkan.
 */
export const propertyRule: PolicyRule = {
  visit(node, scan) {
    const forbidden = scan.contract.forbidden.property;
    // Dilaporkan pada nama atau kunci, bukan pada awal rantai: `x.constructor.constructor` punya dua
    // akses yang berawal di posisi sama, dan keduanya harus tampil sebagai dua temuan.
    let at: ts.Node = node;
    let key: string | undefined;
    if (ts.isPropertyAccessExpression(node)) {
      at = node.name;
      key = node.name.text;
    } else if (ts.isElementAccessExpression(node)) {
      at = node.argumentExpression;
      key = scan.fold(node.argumentExpression);
    } else {
      key = destructuredProperty(scan, node)?.key;
    }
    if (key !== undefined && forbidden.includes(key)) {
      scan.report("POLICY_FORBIDDEN_PROPERTY", at, forbiddenPropertyMessage(key));
    }
  },
};

/** Aturan inti langkah 2 bagian 1, dalam urutan pendaftaran (urutan keluaran dibuat `finalize`). */
export const CORE_POLICY_RULES: readonly PolicyRule[] = [
  jsxRule,
  importRule,
  dynamicImportRule,
  identifierRule,
  memberRule,
  propertyRule,
];
