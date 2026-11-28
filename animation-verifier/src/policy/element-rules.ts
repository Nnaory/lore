// Aturan elemen dan atribut, langkah 2 bagian 2 (design 5.5 tabel aturan; Requirement 7.7, 7.8, 1.11,
// 1.15, 1.20; tugas 4.3). Empat kode:
//   `POLICY_DYNAMIC_ELEMENT`    referensi `createElement` selain callee langsung, dan argumen pertama
//                               yang bukan string terlipat, impor yang diizinkan, atau fungsi lokal;
//   `POLICY_FORBIDDEN_ELEMENT`  argumen pertama (terlipat) ada di `forbidden.element`;
//   `POLICY_FORBIDDEN_ATTRIBUTE` kunci object props (juga yang disebar) pada `attribute.names`,
//                               `attribute.patterns`, dan kunci `style` berawalan `style_key_prefixes`;
//   `POLICY_COLOR_LITERAL`      bagian (b): nilai properti pembawa warna pada props dan `style`.
// `createElement` dikenali lewat simbol impor (alias seperti `import { createElement as h }` ikut),
// bukan lewat nama. Daftar elemen, atribut, dan properti warna dibaca dari kontrak; nama lain yang
// ditulis di sini (`style`, vendor prefix CSS) adalah fakta React/CSS, bukan nilai kontrak.
// Batasan yang disengaja (pertahanan berlapis, design 12): props yang berasal dari pemanggilan fungsi,
// `let`, parameter, atau kunci dinamis tak terlipat tidak diperiksa. Memo `WeakMap` per kontrak
// (`attributeRulesOf`) hanya mempercepat; keluaran tidak bergantung padanya.

import ts from "typescript";
import type { Contract } from "../contract.js";
import { colorLiteralMessage, colorRulesOf, colorViolations } from "./colors.js";
import { allowedNamesOf } from "./core-rules.js";
import {
  PROPS_ARGUMENT_INDEX,
  asCreateElementCall,
  isCreateElementIdentifier,
  propEntries,
  stringCandidates,
  type PropEntry,
} from "./props.js";
import type { PolicyRule, PolicyScan } from "./scan.js";
import {
  importOriginOf,
  isAmbientDeclaration,
  isCalleeExpression,
  isValueReference,
  unwrapExpression,
  valueSymbolAt,
} from "./scope.js";

/** Nama prop React untuk gaya inline. */
const STYLE_PROP = "style";

// ---- aturan turunan kontrak ----

interface AttributeRules {
  /** `attribute.names` dalam huruf kecil. */
  readonly names: ReadonlySet<string>;
  readonly patterns: readonly RegExp[];
  /** `attribute.style_key_prefixes` dalam huruf kecil. */
  readonly stylePrefixes: readonly string[];
  /** `forbidden.element` dalam huruf kecil: nama elemen HTML tidak peka huruf besar-kecil. */
  readonly elements: ReadonlySet<string>;
  /** `color_properties` dinormalisasi (`normalizeProperty`). */
  readonly colorProperties: ReadonlySet<string>;
}

/** `background-color`, `backgroundColor`, dan `BACKGROUNDCOLOR` menjadi `backgroundcolor`. */
function normalizeProperty(key: string): string {
  return key.replace(/-/g, "").toLowerCase();
}

const attributeRulesCache = new WeakMap<Contract, AttributeRules>();

function attributeRulesOf(contract: Contract): AttributeRules {
  const cached = attributeRulesCache.get(contract);
  if (cached !== undefined) return cached;
  const { attribute, element } = contract.forbidden;
  const rules: AttributeRules = {
    names: new Set(attribute.names.map((name) => name.toLowerCase())),
    patterns: attribute.patterns.map((pattern) => new RegExp(pattern)),
    stylePrefixes: attribute.style_key_prefixes.map((prefix) => prefix.toLowerCase()),
    elements: new Set(element.map((name) => name.toLowerCase())),
    colorProperties: new Set(contract.color_properties.map(normalizeProperty)),
  };
  attributeRulesCache.set(contract, rules);
  return rules;
}

// ---- POLICY_DYNAMIC_ELEMENT dan POLICY_FORBIDDEN_ELEMENT ----

type ElementType =
  | { readonly kind: "string"; readonly name: string }
  | { readonly kind: "known" }
  | { readonly kind: "dynamic" };

/** Impor yang diizinkan kontrak (mis. `AbsoluteFill`, `Fragment`) lewat simbolnya, juga beralias. */
function isAllowedImportValue(scan: PolicyScan, identifier: ts.Identifier): boolean {
  const origin = importOriginOf(valueSymbolAt(scan.checker, identifier));
  if (origin === undefined) return false;
  return allowedNamesOf(scan, origin.moduleName)?.values.includes(origin.importedName) === true;
}

function isFunctionExpressionLike(expression: ts.Expression): boolean {
  const target = unwrapExpression(expression);
  return ts.isArrowFunction(target) || ts.isFunctionExpression(target);
}

/**
 * Fungsi yang dideklarasikan di berkas ini: `function F() {}` atau `const F = () => ...` (juga
 * `function` ekspresi). Deklarasi `declare` dan parameter bukan fungsi lokal yang dapat dipercaya.
 */
function isLocalFunction(scan: PolicyScan, identifier: ts.Identifier): boolean {
  const declarations = valueSymbolAt(scan.checker, identifier)?.declarations ?? [];
  return declarations.some((declaration) => {
    if (declaration.getSourceFile() !== scan.sourceFile || isAmbientDeclaration(declaration)) {
      return false;
    }
    if (ts.isFunctionDeclaration(declaration)) return true;
    return (
      ts.isVariableDeclaration(declaration) &&
      (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0 &&
      declaration.initializer !== undefined &&
      isFunctionExpressionLike(declaration.initializer)
    );
  });
}

function classifyElementType(scan: PolicyScan, expression: ts.Expression): ElementType {
  const folded = scan.fold(expression);
  if (folded !== undefined) return { kind: "string", name: folded };
  const target = unwrapExpression(expression);
  if (ts.isIdentifier(target)) {
    return isAllowedImportValue(scan, target) || isLocalFunction(scan, target)
      ? { kind: "known" }
      : { kind: "dynamic" };
  }
  // `Series.Sequence`: anggota dari nilai impor yang diizinkan.
  if (
    ts.isPropertyAccessExpression(target) &&
    ts.isIdentifier(target.expression) &&
    isAllowedImportValue(scan, target.expression)
  ) {
    return { kind: "known" };
  }
  return { kind: "dynamic" };
}

const DYNAMIC_ELEMENT_MESSAGE = "createElement type must be a string literal, Fragment, or a known component";

export const elementRule: PolicyRule = {
  visit(node, scan) {
    // Referensi `createElement` yang bukan callee langsung: `const f = createElement`, `.call`, `new`.
    if (
      ts.isIdentifier(node) &&
      !isCalleeExpression(node) &&
      isValueReference(node) &&
      isCreateElementIdentifier(scan, node)
    ) {
      scan.report("POLICY_DYNAMIC_ELEMENT", node, DYNAMIC_ELEMENT_MESSAGE);
      return;
    }

    const call = asCreateElementCall(scan, node);
    if (call === undefined) return;
    const first = call.arguments[0];
    if (first === undefined || ts.isSpreadElement(first)) {
      scan.report("POLICY_DYNAMIC_ELEMENT", first ?? call, DYNAMIC_ELEMENT_MESSAGE);
      return;
    }
    const type = classifyElementType(scan, first);
    if (type.kind === "dynamic") {
      scan.report("POLICY_DYNAMIC_ELEMENT", first, DYNAMIC_ELEMENT_MESSAGE);
    } else if (type.kind === "string" && attributeRulesOf(scan.contract).elements.has(type.name.toLowerCase())) {
      scan.report("POLICY_FORBIDDEN_ELEMENT", first, `element ${type.name} is not allowed`);
    }
  },
};

// ---- POLICY_FORBIDDEN_ATTRIBUTE (dan POLICY_COLOR_LITERAL bagian b) ----

/** `Webkit`, `moz`, `ms`, `o` di awal kunci gaya ("WebkitAnimationName") tidak boleh menyembunyikan awalan terlarang. */
const VENDOR_PREFIX = /^-?(?:webkit|moz|ms|o)(?=[-a-z])/;

function startsWithForbiddenStylePrefix(key: string, rules: AttributeRules): boolean {
  const lower = key.toLowerCase();
  const bare = lower.replace(VENDOR_PREFIX, "").replace(/^-/, "");
  return rules.stylePrefixes.some((prefix) => lower.startsWith(prefix) || bare.startsWith(prefix));
}

function reportAttribute(scan: PolicyScan, at: ts.Node, key: string): void {
  scan.report("POLICY_FORBIDDEN_ATTRIBUTE", at, `attribute ${key} is not allowed`);
}

/** Bagian (b) `POLICY_COLOR_LITERAL`: setiap nilai string yang mungkin dari `entry` dinilai per token. */
function checkColorValue(scan: PolicyScan, entry: PropEntry): void {
  if (entry.value === undefined) return;
  const rules = colorRulesOf(scan.contract);
  for (const candidate of stringCandidates(scan, entry.value)) {
    for (const fragment of colorViolations(candidate.text, rules)) {
      scan.report("POLICY_COLOR_LITERAL", candidate.node, colorLiteralMessage(fragment));
    }
  }
}

function checkStyleEntry(scan: PolicyScan, rules: AttributeRules, entry: PropEntry): void {
  if (entry.key === undefined) return;
  if (startsWithForbiddenStylePrefix(entry.key, rules)) reportAttribute(scan, entry.at, entry.key);
  if (rules.colorProperties.has(normalizeProperty(entry.key))) checkColorValue(scan, entry);
}

function checkPropsEntry(scan: PolicyScan, rules: AttributeRules, entry: PropEntry): void {
  const { key } = entry;
  if (key === undefined) return;
  if (rules.names.has(key.toLowerCase()) || rules.patterns.some((pattern) => pattern.test(key))) {
    reportAttribute(scan, entry.at, key);
    return;
  }
  if (key === STYLE_PROP && entry.value !== undefined) {
    for (const styleEntry of propEntries(scan, entry.value)) checkStyleEntry(scan, rules, styleEntry);
    return;
  }
  if (rules.colorProperties.has(normalizeProperty(key))) checkColorValue(scan, entry);
}

/**
 * Object props (argumen kedua `createElement`), termasuk object yang disebar: atribut terlarang,
 * kunci gaya animasi, dan nilai warna pada properti pembawa warna (Requirement 7.8, 1.20, 1.15).
 */
export const attributeRule: PolicyRule = {
  visit(node, scan) {
    const call = asCreateElementCall(scan, node);
    const props = call?.arguments[PROPS_ARGUMENT_INDEX];
    if (props === undefined) return;
    const rules = attributeRulesOf(scan.contract);
    for (const entry of propEntries(scan, props)) checkPropsEntry(scan, rules, entry);
  },
};

/** Aturan elemen dan atribut langkah 2 bagian 2, dalam urutan pendaftaran. */
export const ELEMENT_POLICY_RULES: readonly PolicyRule[] = [elementRule, attributeRule];
