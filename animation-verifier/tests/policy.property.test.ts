// Tes properti langkah 2, soundness pemindaian kebijakan (tugas 4.4, opsional; Requirement 7.13, 7.14,
// 38.3; design bagian 13).
// Feature: ai-remotion-animation, Property 3: Soundness pemindaian kebijakan.
// Dua arah, keduanya atas program yang dirakit dari korpus `fixtures/good`:
//   (a) tanpa false negative: satu konstruksi terlarang yang disisipkan (atau satu suntingan bentuk
//       modul) SELALU melaporkan kode yang dimaksud dengan severity `error`. Tiap kode `POLICY_*`
//       dan `META_PAUSE_*` punya generator, dan tiap item pada `contract.forbidden.{identifier, member,
//       property, element, attribute}` punya sedikitnya satu pemakaian sah (beberapa bentuk penulisan:
//       alias, lipatan string, destructuring, spread, huruf besar-kecil, deklarasi `declare`, dst.).
//       Karena korpus asal bersih, setiap Diagnostic harus jatuh di baris yang disisipkan.
//   (b) tanpa false positive: korpus bagus tanpa perubahan, dan korpus yang dirakit dengan konstruksi
//       netral (nama terlarang sebagai kunci, nama properti, variabel lokal, teks anak, dan sejenisnya),
//       menghasilkan nol Diagnostic.
// Daftar nama (identifier, anggota, properti, elemen, atribut, skema, warna) dibaca dari kontrak,
// bukan ditulis ulang. Bentuk penulisan (`$CE(...)`, `const { x } = Obj`) adalah fakta bahasa.
// Tes ini hanya menjalankan langkah 2 (`policyStep`), tanpa Worker, esbuild, atau jaringan.
import { readFileSync } from "node:fs";
import fc from "fast-check";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../src/clock.js";
import { loadContract, type Contract } from "../src/contract.js";
import { policyStep } from "../src/steps/policy.js";
import { createStepContext } from "../src/steps/step.js";
import type { Diagnostic, Kind } from "../src/types.js";
import { loadCorpus, type CorpusEntry } from "./support/corpus.js";

vi.setConfig({ testTimeout: 120_000 });

// ---- kontrak, korpus, penjalan ----

const loaded = loadContract(
  JSON.parse(readFileSync(new URL("../contract/animation-contract.json", import.meta.url), "utf8")),
);
if (!loaded.ok) throw new Error(`kontrak sumber tidak sah: ${loaded.reason}`);
const contract: Contract = loaded.contract;

const GOOD: readonly CorpusEntry[] = loadCorpus("good");

async function scan(source: string, kind: Kind): Promise<readonly Diagnostic[]> {
  const context = createStepContext({
    input: {
      source,
      kind,
      required_tokens: [],
      forbidden_tokens: [],
      contract_version: contract.contract_version,
    },
    contract,
    clock: new FakeClock(),
    deadlineAt: Number.POSITIVE_INFINITY,
  });
  return (await policyStep.run(context)).diagnostics;
}

/** Kode `POLICY_*` dan `META_PAUSE_*` yang harus punya generator (tabel 5.12). */
const REQUIRED_CODES = [
  "POLICY_JSX_SYNTAX",
  "POLICY_IMPORT_DISALLOWED",
  "POLICY_DYNAMIC_IMPORT",
  "POLICY_FORBIDDEN_IDENTIFIER",
  "POLICY_FORBIDDEN_MEMBER",
  "POLICY_FORBIDDEN_PROPERTY",
  "POLICY_DYNAMIC_ELEMENT",
  "POLICY_FORBIDDEN_ELEMENT",
  "POLICY_FORBIDDEN_ATTRIBUTE",
  "POLICY_URL_LITERAL",
  "POLICY_COLOR_LITERAL",
  "POLICY_META_INVALID",
  "META_PAUSE_REQUIRED",
  "META_PAUSE_FORBIDDEN",
  "POLICY_EXPORT_MISSING",
  "POLICY_EXPORT_UNEXPECTED",
] as const;

// ---- snippet: satu konstruksi yang disisipkan sebagai pernyataan ----

type Placement = "top" | "any";

interface Snippet {
  /** `<kategori>:<item>`, mis. `identifier:window` atau `attribute.names:src`. */
  readonly family: string;
  /** Kode yang wajib dilaporkan; kosong untuk konstruksi netral. */
  readonly code: string;
  readonly text: string;
  /** `top`: hanya antar pernyataan tingkat atas; `any`: juga di dalam badan fungsi. */
  readonly placement: Placement;
  /** Teks memakai `$CE` untuk nama lokal `createElement`. */
  readonly needsCreateElement: boolean;
}

const CE = "$CE";
const OWN_CREATE_ELEMENT = "probeElement";

function snippet(
  family: string,
  code: string,
  text: string,
  options: { placement?: Placement } = {},
): Snippet {
  return {
    family,
    code,
    text,
    placement: options.placement ?? "any",
    needsCreateElement: text.includes(CE),
  };
}

/** Membelah `text` menjadi dua bagian yang bila disambung kembali sama (untuk lipatan `+`). */
function split(text: string, at = Math.ceil(text.length / 2)): [string, string] {
  return [text.slice(0, at), text.slice(at)];
}

function titleCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---- katalog: item terlarang pada kontrak ----

function identifierSnippets(name: string): Snippet[] {
  const family = `identifier:${name}`;
  const code = "POLICY_FORBIDDEN_IDENTIFIER";
  const forms = [
    `void ${name};`,
    `const probeValue = ${name};`,
    `typeof ${name};`,
    `${name};`,
    `String(${name});`,
    `${name}?.x;`,
    `${name}.x;`,
    `new ${name}();`,
    `;({ ${name} });`,
    `;\`\${${name}}\`;`,
  ];
  const found = forms.map((text) => snippet(family, code, text));
  found.push(
    // Deklarasi `declare` tidak mendefinisikan nilai: tetap dilaporkan (Requirement 7.15).
    snippet(family, code, `declare const ${name}: unknown;\nvoid ${name};`, { placement: "top" }),
    // `require(...)` dilaporkan hanya sebagai impor dinamis (Requirement 7.20).
    snippet(
      family,
      name === "require" ? "POLICY_DYNAMIC_IMPORT" : code,
      `${name}(1);`,
    ),
  );
  return found;
}

function memberSnippets(entry: string): Snippet[] {
  const dot = entry.indexOf(".");
  const object = entry.slice(0, dot);
  const property = entry.slice(dot + 1);
  const [head, tail] = split(property);
  const family = `member:${entry}`;
  const code = "POLICY_FORBIDDEN_MEMBER";
  const forms = [
    `${object}.${property}();`,
    `${object}.${property};`,
    `${object}["${property}"]();`,
    `${object}['${head}' + '${tail}']();`,
    `${object}[\`${property}\`]();`,
    `const probeKey = "${property}";\n${object}[probeKey]();`,
    `const probeAlias = ${object};\nprobeAlias.${property}();`,
    `const probeA = ${object};\nconst probeB = probeA;\nprobeB["${property}"]();`,
    `const { ${property}: probeFn } = ${object};`,
    `let probeFn;\n;({ ${property}: probeFn } = ${object});`,
    `;(${object} as unknown as { ${property}(): number }).${property}();`,
  ];
  const found = forms.map((text) => snippet(family, code, text));
  // Nilai impor yang diizinkan, tetapi `random(null)` jatuh ke `Math.random` (Requirement 1.18).
  const allowedValues = contract.allowed_imports["remotion"]?.values ?? [];
  if (allowedValues.includes(property)) {
    found.push(
      snippet(
        family,
        code,
        `import { ${property} as probeSeed } from "remotion";\nprobeSeed(null);`,
        { placement: "top" },
      ),
    );
  }
  return found;
}

function propertySnippets(name: string): Snippet[] {
  const [head, tail] = split(name);
  const family = `property:${name}`;
  const code = "POLICY_FORBIDDEN_PROPERTY";
  return [
    `;({}).${name};`,
    `;({})["${name}"];`,
    `;({})[\`${name}\`];`,
    `;({})["${head}" + "${tail}"];`,
    `const probeKey = "${name}";\n;({})[probeKey];`,
    `const probeHead = "${head}";\n;({})[probeHead + "${tail}"];`,
    `const { ${name}: probeValue } = {};`,
    `;({})?.${name};`,
    `const probeObject = {};\nprobeObject.${name} = 1;`,
    `;({}).${name}.${name};`,
  ].map((text) => snippet(family, code, text));
}

function elementSnippets(name: string): Snippet[] {
  const [head, tail] = split(name);
  const family = `element:${name}`;
  const code = "POLICY_FORBIDDEN_ELEMENT";
  return [
    `${CE}("${name}", null);`,
    `${CE}("${head}" + "${tail}", null);`,
    `${CE}(\`${name}\`, null);`,
    `const probeTag = "${name}";\n${CE}(probeTag, null);`,
    `${CE}("${name}", null, "child text");`,
    `const probeHead = "${head}";\nconst probeFull = probeHead + "${tail}";\n${CE}(probeFull, { id: "x" });`,
    `${CE}(("${name}" as string), null);`,
  ].map((text) => snippet(family, code, text));
}

/** Bentuk `createElement("div", <props>)` dengan `props` memuat satu kunci terlarang `key`. */
function attributeForms(key: string, otherwise: string): string[] {
  const [head, tail] = split(key);
  return [
    `${CE}("div", { ${key}: 1 });`,
    `${CE}("div", { "${key}": 1 });`,
    `${CE}("div", { id: "x", ${key}: ${otherwise} }, null);`,
    `${CE}("div", { ...{ ${key}: 1 } });`,
    `const probeProps = { ${key}: 1 };\n${CE}("div", probeProps);`,
    `const probeBase = { ${key}: 1 };\n${CE}("div", { ...probeBase });`,
    `${CE}("div", { ["${head}" + "${tail}"]: 1 });`,
    `${CE}("div", Math.floor(1) > 0 ? { ${key}: 1 } : null);`,
  ];
}

function attributeNameSnippets(name: string): Snippet[] {
  const code = "POLICY_FORBIDDEN_ATTRIBUTE";
  const forms = attributeForms(name, '"x"');
  // Nama atribut dibandingkan tanpa memperhatikan huruf besar-kecil (Requirement 7.8).
  forms.push(...attributeForms(name.toUpperCase(), '"x"').slice(0, 2));
  forms.push(...attributeForms(titleCase(name), '"x"').slice(0, 2));
  return forms.map((text) => snippet(`attribute.names:${name}`, code, text));
}

function attributePatternSnippets(pattern: string): Snippet[] {
  // Pola kontrak (`^on[A-Z]`) diwujudkan sebagai handler `onClick`, `onLoad`, ...
  const keys = ["onClick", "onLoad", "onMouseEnter", "onX"].filter((key) =>
    new RegExp(pattern).test(key),
  );
  return keys.flatMap((key) =>
    attributeForms(key, "() => 1").map((text) =>
      snippet(`attribute.patterns:${pattern}`, "POLICY_FORBIDDEN_ATTRIBUTE", text),
    ),
  );
}

function attributeStyleSnippets(prefix: string): Snippet[] {
  const code = "POLICY_FORBIDDEN_ATTRIBUTE";
  const family = `attribute.style:${prefix}`;
  const keys = [prefix, `${prefix}Name`, `${prefix}Duration`];
  const forms = keys.flatMap((key) => [
    `${CE}("div", { style: { ${key}: "x" } });`,
    `const probeStyle = { ${key}: 1 };\n${CE}("div", { style: probeStyle });`,
    `${CE}("div", { style: { ...{ ${key}: 1 } } });`,
    `const probeBase = { ${key}: 1 };\n${CE}("div", { style: { ...probeBase } });`,
  ]);
  const [head, tail] = split(prefix);
  forms.push(`${CE}("div", { style: { ["${head}" + "${tail}Name"]: "x" } });`);
  return forms.map((text) => snippet(family, code, text));
}

// ---- katalog: kode `POLICY_*` di luar daftar `forbidden` ----

/** Nama impor yang tidak ada di daftar mana pun pada kontrak. */
const DISALLOWED_NAMES = ["useState", "useEffect", "useRef", "Img", "staticFile", "Video", "OffthreadVideo"];
const DISALLOWED_MODULES = [
  "gsap",
  "lodash",
  "./other",
  "../other",
  "node:fs",
  "fs",
  "https://cdn.example.test/x.js",
  "@scope/pkg",
  "react-dom",
  "react/jsx-runtime",
  "remotion/no-reexport",
  "constructor",
  "__proto__",
  "toString",
];

function importSnippets(): Snippet[] {
  const code = "POLICY_IMPORT_DISALLOWED";
  const top = { placement: "top" } as const;
  const forms = [
    ...DISALLOWED_MODULES.map((module) => `import { probeX } from "${module}";`),
    ...DISALLOWED_NAMES.map((name) => `import { ${name} } from "react";`),
    ...DISALLOWED_NAMES.map((name) => `import { ${name} } from "remotion";`),
    `import type { FC } from "react";`,
    `import * as probeNamespace from "react";`,
    `import * as probeRemotion from "remotion";`,
    `import ProbeDefault from "react";`,
    `import type ProbeType from "react";`,
    `import "react";`,
    `import "remotion";`,
    `import { default as probeDefault } from "react";`,
    `import { createElement as probeCreate, useState as probeState } from "react";`,
    `export { createElement } from "react";`,
    `export * from "remotion";`,
    `export * as probeAll from "remotion";`,
  ];
  return forms.map((text) => snippet("import", code, text, top));
}

function dynamicImportSnippets(): Snippet[] {
  const code = "POLICY_DYNAMIC_IMPORT";
  return [
    snippet("dynamic-import", code, `import("probe-module");`),
    snippet("dynamic-import", code, `const probeLoad = import("probe-module");`),
    snippet("dynamic-import", code, `require("probe-module");`),
    snippet("dynamic-import", code, `const probeModule = require("react");`),
    snippet("dynamic-import", code, `;(require)("probe-module");`),
    snippet("dynamic-import", code, `require?.("probe-module");`),
    snippet("dynamic-import", code, `import probeFs = require("fs");`, { placement: "top" }),
  ];
}

function jsxSnippets(): Snippet[] {
  const code = "POLICY_JSX_SYNTAX";
  return [
    `const probeJsx = <div />;`,
    `const probeJsx = <div>text</div>;`,
    `const probeJsx = <></>;`,
    `const probeJsx = <>text</>;`,
    `const probeJsx = <ul><li>a</li><li>b</li></ul>;`,
    `const probeJsx = <a title="x"><b /></a>;`,
    `const probeJsx = () => <span>{1}</span>;`,
  ].map((text) => snippet("jsx", code, text));
}

function dynamicElementSnippets(): Snippet[] {
  const code = "POLICY_DYNAMIC_ELEMENT";
  return [
    `let probeTag = "div";\n${CE}(probeTag, null);`,
    `${CE}();`,
    `const probeRef = ${CE};`,
    `${CE}.call(null, "div");`,
    `${CE}(...["div"]);`,
    `${CE}(Math.floor(1) > 0 ? "div" : "span", null);`,
    `${CE}(\`d\${1}\`, null);`,
    `const probeFactories = [${CE}];`,
  ].map((text) => snippet("dynamic-element", code, text));
}

function urlSnippets(): Snippet[] {
  const code = "POLICY_URL_LITERAL";
  const found: Snippet[] = [];
  const add = (text: string): void => {
    found.push(snippet("url", code, text));
  };
  for (const scheme of contract.url_schemes) {
    const [head, tail] = split(scheme);
    add(`const probeUrl = "${scheme}:x";`);
    add(`const probeUrl = "${scheme.toUpperCase()}://example.test/a";`);
    add(`const probeUrl = "  ${scheme}:x";`);
    add(`const probeUrl = \`${scheme}:x\`;`);
    add(`const probeUrl = "${head}" + "${tail}:x";`);
    add(`String("${scheme}:x");`);
  }
  for (const fn of contract.css_functions_forbidden) {
    add(`const probeUrl = "${fn}#a)";`);
    add(`const probeUrl = "${fn.toUpperCase()}#a)";`);
    add(`const probeUrl = "fill: ${fn}#grad)";`);
    add(`const probeUrl = \`${fn}\${1})\`;`);
  }
  return found;
}

const HEX_DIGITS = [3, 4, 6, 8];

function colorSnippets(): Snippet[] {
  const code = "POLICY_COLOR_LITERAL";
  const found: Snippet[] = [];
  const add = (text: string): void => {
    found.push(snippet("color", code, text));
  };
  for (const digits of HEX_DIGITS) {
    const hex = "a1B2c3D4".slice(0, digits);
    add(`const probeColor = "#${hex}";`);
    add(`const probeColor = "#${hex.toLowerCase()}";`);
    add(`const probeColor = \`#${hex}\`;`);
  }
  for (const fn of contract.color_forms.functions) {
    add(`const probeColor = "${fn}1, 2, 3)";`);
    add(`const probeColor = "${fn.toUpperCase()}1, 2, 3)";`);
    add(`const probeColor = "1px solid ${fn}0, 0, 0)";`);
  }
  const names = contract.color_forms.named_colors;
  contract.color_properties.forEach((property, index) => {
    const name = names[(index * 11) % names.length] as string;
    add(`${CE}("div", { ${property}: "1px solid ${name}" });`);
    add(`${CE}("div", { style: { ${property}: "1px solid ${name}" } });`);
    add(`${CE}("div", { ${property}: "${name.toUpperCase()}" });`);
    add(`const probeStyle = { ${property}: "${name}" };\n${CE}("div", { style: probeStyle });`);
  });
  add(`${CE}("div", { fill: "gold" });`);
  add(`${CE}("div", { fill: "var(--color-nope)" });`);
  add(`${CE}("div", { stroke: "var(--color-ink, red)" });`);
  return found;
}

function exportSnippets(): Snippet[] {
  const code = "POLICY_EXPORT_UNEXPECTED";
  return [
    `export const probeExtra = 1;`,
    `export let probeExtra = 1;`,
    `export function probeFn() {}`,
    `export class ProbeClass {}`,
    `export type ProbeType = number;`,
    `export interface ProbeInterface {}`,
    `export enum ProbeEnum { A }`,
    `export namespace ProbeNamespace {}`,
    `const probeLocal = 1;\nexport { probeLocal };`,
    `const probeLocal = 1;\nexport { probeLocal as probeOuter };`,
    `export default 1;`,
    `export * from "react";`,
    `export = 1;`,
  ].map((text) => snippet("export", code, text, { placement: "top" }));
}

/** Seluruh katalog: setiap entri adalah satu konstruksi terlarang beserta kode yang wajib dilaporkan. */
function buildCatalog(): Snippet[] {
  const { forbidden } = contract;
  return [
    ...forbidden.identifier.flatMap(identifierSnippets),
    ...forbidden.member.flatMap(memberSnippets),
    ...forbidden.property.flatMap(propertySnippets),
    ...forbidden.element.flatMap(elementSnippets),
    ...forbidden.attribute.names.flatMap(attributeNameSnippets),
    ...forbidden.attribute.patterns.flatMap(attributePatternSnippets),
    ...forbidden.attribute.style_key_prefixes.flatMap(attributeStyleSnippets),
    ...importSnippets(),
    ...dynamicImportSnippets(),
    ...jsxSnippets(),
    ...dynamicElementSnippets(),
    ...urlSnippets(),
    ...colorSnippets(),
    ...exportSnippets(),
  ];
}

const CATALOG = buildCatalog();

// ---- konstruksi netral: harus menghasilkan nol temuan ----

/** Nama yang dapat dideklarasikan sebagai variabel lokal (mode ketat melarang `eval` dan `arguments`). */
const SHADOWABLE = contract.forbidden.identifier.filter((name) => name !== "eval");

function neutralSnippets(): Snippet[] {
  const make = (family: string, text: string): Snippet => snippet(family, "", text);
  return [
    // Kunci object literal dan nama properti bukan referensi (Requirement 7.5).
    make("neutral:key", `const neutralBox = { top: 10, left: 4, window: 2, document: 1 };`),
    make(
      "neutral:property",
      `const neutralAccess = { document: 1, window: 2, top: 3 };\nvoid neutralAccess.document;\nvoid neutralAccess.window;\nvoid neutralAccess.top;`,
    ),
    // Anggota `Math` selain `random` dan `random(seed)` dari remotion diizinkan.
    make("neutral:math", `void (Math.floor(1.5) + Math.max(1, 2) + Math.PI);`),
    snippet(
      "neutral:remotion-random",
      "",
      `import { random as neutralRandom } from "remotion";\nvoid neutralRandom("neutral-seed");`,
      { placement: "top" },
    ),
    // Teks yang menyebut hal terlarang, bukan pemakaiannya.
    make("neutral:text", `const neutralNote = "window.eval(fetch) and top";`),
    make("neutral:url-words", `const neutralUrl = "data: 5";\nconst neutralBare = "data:";`),
    make("neutral:url-inside", `const neutralSee = "see https://example.test";`),
    make("neutral:hex-like", `const neutralHex = "#12345 and #abc is text";`),
    make("neutral:plain-color-word", `const neutralLabel = { label: "red", name: "img", kind: "script" };`),
    make("neutral:palette", `const neutralPalette = "var(--color-gold)";`),
    make("neutral:comment", `// eval(window); <script src="x"> url(x) rgb(0, 0, 0) https://x`),
    // createElement dengan props sah, warna palet, dan teks anak yang menyebut URL dan warna (7.9).
    snippet(
      "neutral:props",
      "",
      `${CE}("div", { id: "src", style: { color: "var(--color-gold)", border: "1px solid var(--color-smoke)", fill: "none" } }, "http://example.test, #fff and rgb(1, 2, 3) are only text");`,
    ),
    snippet(
      "neutral:attributes",
      "",
      `${CE}("div", { "data-probe": 1, "aria-label": "probe", id: "probe-id" });`,
    ),
    snippet("neutral:template-child", "", `void ${CE}("div", null, \`text \${1}\`);`),
    // Variabel lokal dan parameter dengan ejaan nama terlarang (Requirement 7.5).
    ...SHADOWABLE.map((name) =>
      make(`neutral:shadow:${name}`, `{\n  const ${name} = 1;\n  void ${name};\n}`),
    ),
    ...SHADOWABLE.slice(0, 6).map((name) =>
      make(`neutral:param:${name}`, `const neutralFn_${name} = (${name}: number) => ${name} + 1;\nvoid neutralFn_${name};`),
    ),
  ];
}

const NEUTRAL = neutralSnippets();

// ---- perakitan ----

interface Sites {
  readonly top: readonly number[];
  readonly any: readonly number[];
}

const siteCache = new Map<string, Sites>();

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile("main.ts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
}

/** Awal tiap pernyataan tingkat atas, dan (untuk `any`) tiap pernyataan di badan fungsi. */
function sitesOf(source: string): Sites {
  const cached = siteCache.get(source);
  if (cached !== undefined) return cached;
  const file = parse(source);
  const top = file.statements.map((statement) => statement.getStart(file));
  const nested: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isBlock(node) && ts.isFunctionLike(node.parent)) {
      for (const statement of node.statements) nested.push(statement.getStart(file));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const sites: Sites = { top, any: [...top, ...nested] };
  siteCache.set(source, sites);
  return sites;
}

/** Nama lokal `createElement` pada `import { createElement as h } from "react"`, atau `undefined`. */
function createElementNameOf(source: string): string | undefined {
  const imported = /import\s*\{([^}]*)\}\s*from\s*"react"/.exec(source)?.[1];
  const match = imported === undefined ? null : /\bcreateElement\b(?:\s+as\s+(\w+))?/.exec(imported);
  return match === null ? undefined : (match[1] ?? "createElement");
}

interface Inserted {
  readonly source: string;
  /** Baris (basis 1) pertama dan terakhir dari teks yang disisipkan. */
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * Menyisipkan `entry` sebelum pernyataan ke-`pick` (modulo jumlah lokasi) pada `source`.
 * `ownImport` memakai impor `createElement` beralias milik snippet sendiri alih-alih milik korpus.
 */
function insert(source: string, entry: Snippet, pick: number, ownImport: boolean): Inserted {
  let { text, placement } = entry;
  if (entry.needsCreateElement) {
    const name = createElementNameOf(source);
    if (ownImport || name === undefined) {
      text = `import { createElement as ${OWN_CREATE_ELEMENT} } from "react";\n${text.replaceAll(CE, OWN_CREATE_ELEMENT)}`;
      placement = "top";
    } else {
      text = text.replaceAll(CE, name);
    }
  }
  const sites = sitesOf(source)[placement];
  const position = sites[pick % sites.length] as number;
  const before = source.slice(0, position);
  const startLine = before.split("\n").length;
  return {
    source: `${before}${text}\n${source.slice(position)}`,
    startLine,
    endLine: startLine + text.split("\n").length - 1,
  };
}

/** Korpus asal ditambah konstruksi netral (masing-masing di lokasi sendiri). */
function withNeutrals(
  base: CorpusEntry,
  neutrals: ReadonlyArray<readonly [index: number, pick: number]>,
): string {
  let source = base.source;
  for (const [index, pick] of neutrals) {
    source = insert(source, NEUTRAL[index % NEUTRAL.length] as Snippet, pick, false).source;
  }
  return source;
}

function describeCase(entry: Snippet, base: CorpusEntry): string {
  return `${base.name} + ${entry.family}: ${JSON.stringify(entry.text)}`;
}

/** Pernyataan soundness untuk satu sisipan: kode dilaporkan sebagai `error`, di baris yang disisipkan. */
function expectReported(
  entry: Snippet,
  base: CorpusEntry,
  diagnostics: readonly Diagnostic[],
  inserted: Inserted,
): void {
  const label = describeCase(entry, base);
  const matching = diagnostics.filter((diagnostic) => diagnostic.code === entry.code);
  expect(matching.length, `${label} -> ${JSON.stringify(diagnostics.map((d) => d.code))}`).toBeGreaterThan(0);
  expect(matching.every((diagnostic) => diagnostic.severity === "error"), label).toBe(true);
  // Korpus asal bersih, jadi setiap temuan berasal dari teks yang disisipkan.
  for (const diagnostic of diagnostics) {
    expect(diagnostic.line, `${label}: ${diagnostic.code}`).toBeGreaterThanOrEqual(inserted.startLine);
    expect(diagnostic.line, `${label}: ${diagnostic.code}`).toBeLessThanOrEqual(inserted.endLine);
  }
}

// ---- generator ----

const baseArb = fc.constantFrom(...GOOD);
const catalogArb = fc.constantFrom(...CATALOG);

/** Nol sampai tiga konstruksi netral berbeda beserta lokasinya. */
const neutralsArb = fc.uniqueArray(fc.tuple(fc.nat(NEUTRAL.length - 1), fc.nat()), {
  maxLength: 3,
  selector: ([index]) => index,
});

/** Huruf besar-kecil acak untuk `text`, ditentukan topeng boolean. */
function recase(text: string, mask: readonly boolean[]): string {
  return [...text].map((char, i) => (mask[i % mask.length] ? char.toUpperCase() : char.toLowerCase())).join("");
}

/**
 * Snippet berparameter bebas, melengkapi katalog tetap: huruf besar-kecil nama atribut dan skema,
 * digit hex acak, modul dan nama impor acak, titik belah lipatan string, dan nama warna acak.
 */
const parametricArb: fc.Arbitrary<Snippet> = fc.oneof(
  fc
    .tuple(fc.constantFrom(...contract.forbidden.attribute.names), fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }))
    .map(([name, mask]) =>
      snippet(`attribute.names:${name}`, "POLICY_FORBIDDEN_ATTRIBUTE", `${CE}("div", { ${recase(name, mask)}: 1 });`),
    ),
  fc
    .stringMatching(/^on[A-Z][A-Za-z0-9]{0,8}$/)
    .filter((key) => contract.forbidden.attribute.patterns.some((pattern) => new RegExp(pattern).test(key)))
    .map((key) => snippet("attribute.patterns", "POLICY_FORBIDDEN_ATTRIBUTE", `${CE}("div", { ${key}: () => 1 });`)),
  fc
    .tuple(
      fc.constantFrom(...contract.forbidden.attribute.style_key_prefixes),
      fc.stringMatching(/^[A-Z][A-Za-z]{0,10}$/),
    )
    .map(([prefix, suffix]) =>
      snippet("attribute.style", "POLICY_FORBIDDEN_ATTRIBUTE", `${CE}("div", { style: { ${prefix}${suffix}: "x" } });`),
    ),
  fc
    .tuple(fc.constantFrom(...contract.url_schemes), fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }), fc.stringMatching(/^[!-~]{1,12}$/), fc.constantFrom("", " ", "\t", "  \n "))
    .map(([scheme, mask, rest, lead]) =>
      snippet("url", "POLICY_URL_LITERAL", `const probeUrl = ${JSON.stringify(`${lead}${recase(scheme, mask)}:${rest}`)};`),
    ),
  fc
    .tuple(fc.constantFrom(...HEX_DIGITS), fc.array(fc.constantFrom(..."0123456789abcdefABCDEF"), { minLength: 8, maxLength: 8 }))
    .map(([digits, chars]) =>
      snippet("color", "POLICY_COLOR_LITERAL", `const probeColor = "#${chars.slice(0, digits).join("")}";`),
    ),
  fc
    .tuple(fc.constantFrom(...contract.color_properties), fc.constantFrom(...contract.color_forms.named_colors), fc.array(fc.boolean(), { minLength: 1, maxLength: 5 }), fc.boolean())
    .map(([property, color, mask, inStyle]) => {
      const props = `{ ${property}: "1px solid ${recase(color, mask)}" }`;
      return snippet("color", "POLICY_COLOR_LITERAL", `${CE}("div", ${inStyle ? `{ style: ${props} }` : props});`);
    }),
  fc
    .tuple(
      fc.oneof(fc.constantFrom(...DISALLOWED_MODULES), fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/).filter((name) => !(name in contract.allowed_imports))),
      fc.stringMatching(/^[a-z][A-Za-z0-9]{0,8}$/),
    )
    .map(([module, name]) =>
      snippet("import", "POLICY_IMPORT_DISALLOWED", `import { ${name} } from "${module}";`, { placement: "top" }),
    ),
  fc
    .tuple(fc.constantFrom(...contract.forbidden.element), fc.nat())
    .map(([name, at]) => {
      const [head, tail] = split(name, at % (name.length + 1));
      return snippet(`element:${name}`, "POLICY_FORBIDDEN_ELEMENT", `${CE}("${head}" + "${tail}", null);`);
    }),
  fc
    .tuple(fc.constantFrom(...contract.forbidden.property), fc.nat())
    .map(([name, at]) => {
      const [head, tail] = split(name, at % (name.length + 1));
      return snippet(`property:${name}`, "POLICY_FORBIDDEN_PROPERTY", `;({})["${head}" + "${tail}"];`);
    }),
);

// ---- (b) tanpa false positive ----

describe("Property 3 (arah b): korpus bagus tidak menghasilkan temuan kebijakan", () => {
  it("korpus fixtures/good tanpa perubahan: nol Diagnostic langkah 2", async () => {
    expect(GOOD.length).toBeGreaterThanOrEqual(8);
    for (const base of GOOD) {
      expect(await scan(base.source, base.kind), base.name).toEqual([]);
    }
  });

  it("katalog konstruksi netral memuat sedikitnya satu entri per kategori yang dijanjikan", () => {
    const families = new Set(NEUTRAL.map((entry) => entry.family.split(":").slice(0, 2).join(":")));
    for (const family of [
      "neutral:key",
      "neutral:property",
      "neutral:math",
      "neutral:remotion-random",
      "neutral:text",
      "neutral:url-words",
      "neutral:props",
      "neutral:shadow",
      "neutral:param",
    ]) {
      expect(families.has(family), family).toBe(true);
    }
    expect(NEUTRAL.length).toBeGreaterThan(40);
  });

  it("setiap konstruksi netral pada setiap korpus bagus: nol Diagnostic", async () => {
    const failures: string[] = [];
    for (const [index, entry] of NEUTRAL.entries()) {
      const base = GOOD[index % GOOD.length] as CorpusEntry;
      const source = insert(base.source, entry, index * 7919, index % 2 === 0).source;
      const diagnostics = await scan(source, base.kind);
      if (diagnostics.length > 0) {
        failures.push(`${describeCase(entry, base)} -> ${diagnostics.map((d) => `${d.code}@${d.line}`).join(",")}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("korpus bagus yang dirakit dengan nol sampai tiga konstruksi netral: nol Diagnostic", () => {
    return fc.assert(
      fc.asyncProperty(baseArb, neutralsArb, async (base, neutrals) => {
        const source = withNeutrals(base, neutrals);
        const diagnostics = await scan(source, base.kind);
        expect(diagnostics.map((d) => `${d.code}@${d.line}`), base.name).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });
});

// ---- (a) tanpa false negative ----

describe("Property 3 (arah a): satu konstruksi terlarang selalu dilaporkan", () => {
  it("katalog memuat setiap item terlarang kontrak dan setiap kode POLICY_* yang diwajibkan", () => {
    const { forbidden } = contract;
    const families = new Set(CATALOG.map((entry) => entry.family));
    const wanted = [
      ...forbidden.identifier.map((name) => `identifier:${name}`),
      ...forbidden.member.map((name) => `member:${name}`),
      ...forbidden.property.map((name) => `property:${name}`),
      ...forbidden.element.map((name) => `element:${name}`),
      ...forbidden.attribute.names.map((name) => `attribute.names:${name}`),
      ...forbidden.attribute.patterns.map((pattern) => `attribute.patterns:${pattern}`),
      ...forbidden.attribute.style_key_prefixes.map((prefix) => `attribute.style:${prefix}`),
    ];
    expect(wanted.length).toBeGreaterThanOrEqual(54);
    for (const family of wanted) expect(families.has(family), family).toBe(true);

    const catalogCodes = new Set(CATALOG.map((entry) => entry.code));
    // Kode bentuk modul memakai suntingan sumber (di bawah), bukan sisipan.
    for (const code of REQUIRED_CODES) {
      const viaEdit = ["POLICY_META_INVALID", "META_PAUSE_REQUIRED", "META_PAUSE_FORBIDDEN", "POLICY_EXPORT_MISSING"];
      if (!viaEdit.includes(code)) expect(catalogCodes.has(code), code).toBe(true);
    }
    expect(CATALOG.length).toBeGreaterThan(600);
  });

  it("setiap entri katalog, disisipkan ke korpus bagus, melaporkan kodenya", async () => {
    const failures: string[] = [];
    for (const [index, entry] of CATALOG.entries()) {
      const base = GOOD[index % GOOD.length] as CorpusEntry;
      const inserted = insert(base.source, entry, index * 7919, index % 2 === 0);
      const diagnostics = await scan(inserted.source, base.kind);
      try {
        expectReported(entry, base, diagnostics, inserted);
      } catch (error) {
        failures.push(error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error));
      }
    }
    expect(failures).toEqual([]);
  });

  it("korpus bagus + nol sampai tiga konstruksi netral + satu konstruksi terlarang acak: selalu dilaporkan", () => {
    // Feature: ai-remotion-animation, Property 3: Soundness pemindaian kebijakan
    return fc.assert(
      fc.asyncProperty(
        baseArb,
        fc.oneof({ weight: 3, arbitrary: catalogArb }, { weight: 2, arbitrary: parametricArb }),
        fc.nat(),
        fc.boolean(),
        neutralsArb,
        async (base, entry, pick, ownImport, neutrals) => {
          const prepared = { ...base, source: withNeutrals(base, neutrals) };
          const inserted = insert(prepared.source, entry, pick, ownImport);
          const diagnostics = await scan(inserted.source, base.kind);
          expectReported(entry, prepared, diagnostics, inserted);
        },
      ),
      { numRuns: 400 },
    );
  });
});

// ---- (a) suntingan bentuk modul: meta, pause, ekspor ----

type MetaKey = "width" | "height" | "fps" | "durationInFrames";
type MetaOp =
  | "set"
  | "spell"
  | "extra"
  | "duplicate"
  | "delete"
  | "rename"
  | "let"
  | "unexport"
  | "spread";
type MainOp = "rename" | "param" | "async" | "nodefault" | "arrow" | "class" | "assignment" | "delete";

type SourceEdit =
  | { readonly family: "meta"; readonly op: MetaOp; readonly key: MetaKey; readonly n: number }
  | { readonly family: "pause"; readonly op: "remove" | "add" | "flip"; readonly n: number }
  | { readonly family: "main"; readonly op: MainOp; readonly n: number };

interface Edited {
  readonly source: string;
  readonly kind: Kind;
  readonly code: string;
}

const META_KEYS: readonly MetaKey[] = ["width", "height", "fps", "durationInFrames"];

function metaObject(file: ts.SourceFile): { statement: ts.VariableStatement; object: ts.ObjectLiteralExpression } {
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === "meta") {
        const initializer = declaration.initializer;
        if (initializer !== undefined && ts.isObjectLiteralExpression(initializer)) {
          return { statement, object: initializer };
        }
      }
    }
  }
  throw new Error("korpus bagus tanpa meta literal");
}

function propertyOf(object: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === name) {
      return property;
    }
  }
  throw new Error(`meta tanpa ${name}`);
}

function replaceRange(source: string, start: number, end: number, text: string): string {
  return `${source.slice(0, start)}${text}${source.slice(end)}`;
}

/** Nilai di luar rentang kontrak untuk `key`, ditentukan `n`. */
function outOfRange(key: MetaKey, n: number): number {
  const { canvas, duration } = contract;
  const step = (n % 400) + 1;
  switch (key) {
    case "width":
      return canvas.width + step;
    case "height":
      return canvas.height - step;
    case "fps":
      return canvas.fps + step;
    case "durationInFrames":
      return n % 2 === 0 ? duration.max + step : duration.min - step;
  }
}

/** Penulisan lain untuk bilangan bulat `value` yang bukan literal desimal biasa. */
function spellings(value: number): string[] {
  const text = String(value);
  return [
    `${value}.0`,
    `0x${value.toString(16)}`,
    `0b${value.toString(2)}`,
    `0o${value.toString(8)}`,
    `${value}e0`,
    `${value}n`,
    `${value} + 0`,
    `${text.slice(0, 1)}_${text.slice(1)}`,
  ];
}

function editMeta(base: CorpusEntry, edit: Extract<SourceEdit, { family: "meta" }>): Edited {
  const code = "POLICY_META_INVALID";
  const { source } = base;
  const file = parse(source);
  const { statement, object } = metaObject(file);
  const props = object.properties;
  const last = props[props.length - 1] as ts.ObjectLiteralElementLike;
  const done = (text: string): Edited => ({ source: text, kind: base.kind, code });
  const valueOf = (name: MetaKey): number => Number((propertyOf(object, name).initializer as ts.NumericLiteral).text);

  switch (edit.op) {
    case "set": {
      const initializer = propertyOf(object, edit.key).initializer;
      return done(replaceRange(source, initializer.getStart(file), initializer.getEnd(), String(outOfRange(edit.key, edit.n))));
    }
    case "spell": {
      const initializer = propertyOf(object, edit.key).initializer;
      const options = spellings(valueOf(edit.key));
      return done(
        replaceRange(source, initializer.getStart(file), initializer.getEnd(), options[edit.n % options.length] as string),
      );
    }
    case "extra":
      return done(replaceRange(source, last.getEnd(), last.getEnd(), ", extraKey: 1"));
    case "duplicate": {
      const duplicate = `${edit.key}: ${valueOf(edit.key)}`;
      return done(replaceRange(source, last.getEnd(), last.getEnd(), `, ${duplicate}`));
    }
    case "delete": {
      const property = propertyOf(object, edit.key);
      const index = props.indexOf(property);
      // Hapus beserta pemisahnya: koma sesudahnya, atau koma sebelumnya bila ia yang terakhir.
      if (index < props.length - 1) {
        const next = props[index + 1] as ts.ObjectLiteralElementLike;
        return done(replaceRange(source, property.getStart(file), next.getStart(file), ""));
      }
      const previous = props[index - 1] as ts.ObjectLiteralElementLike;
      return done(replaceRange(source, previous.getEnd(), property.getEnd(), ""));
    }
    case "rename": {
      const name = (statement.declarationList.declarations[0] as ts.VariableDeclaration).name;
      return done(replaceRange(source, name.getStart(file), name.getEnd(), "metaRenamed"));
    }
    case "let": {
      const list = statement.declarationList;
      return done(replaceRange(source, list.getStart(file), list.getStart(file) + "const".length, "let"));
    }
    case "unexport": {
      const modifier = statement.modifiers?.find((item) => item.kind === ts.SyntaxKind.ExportKeyword);
      if (modifier === undefined) throw new Error("meta tanpa export");
      return done(replaceRange(source, modifier.getStart(file), list(statement, file), ""));
    }
    case "spread":
      return done(replaceRange(source, props[0]?.getStart(file) ?? object.getStart(file) + 1, props[0]?.getStart(file) ?? object.getStart(file) + 1, "...{}, "));
  }
}

/** Awal token sesudah `export` pada pernyataan (untuk membuang `export ` bersama spasinya). */
function list(statement: ts.VariableStatement, file: ts.SourceFile): number {
  return statement.declarationList.getStart(file);
}

function editPause(base: CorpusEntry, edit: Extract<SourceEdit, { family: "pause" }>): Edited {
  const { source } = base;
  const file = parse(source);
  const { object } = metaObject(file);
  switch (edit.op) {
    case "remove": {
      const props = object.properties;
      const pause = propertyOf(object, "pauseAtFrame");
      const previous = props[props.indexOf(pause) - 1] as ts.ObjectLiteralElementLike;
      return {
        source: replaceRange(source, previous.getEnd(), pause.getEnd(), ""),
        kind: "puzzle",
        code: "META_PAUSE_REQUIRED",
      };
    }
    case "add": {
      const duration = Number((propertyOf(object, "durationInFrames").initializer as ts.NumericLiteral).text);
      const frame = (edit.n % (duration - 1)) + 1;
      const last = object.properties[object.properties.length - 1] as ts.ObjectLiteralElementLike;
      return {
        source: replaceRange(source, last.getEnd(), last.getEnd(), `, pauseAtFrame: ${frame}`),
        kind: "lesson",
        code: "META_PAUSE_FORBIDDEN",
      };
    }
    case "flip": {
      const hasPause = object.properties.some(
        (property) => ts.isPropertyAssignment(property) && (property.name as ts.Identifier).text === "pauseAtFrame",
      );
      // Jenis yang dinyatakan berlawanan dengan isi meta: lesson dengan pause, atau puzzle tanpa pause.
      return hasPause
        ? { source, kind: "lesson", code: "META_PAUSE_FORBIDDEN" }
        : { source, kind: "puzzle", code: "META_PAUSE_REQUIRED" };
    }
  }
}

function mainFunction(file: ts.SourceFile): ts.FunctionDeclaration {
  for (const statement of file.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) === true
    ) {
      return statement;
    }
  }
  throw new Error("korpus bagus tanpa export default function");
}

function editMain(base: CorpusEntry, edit: Extract<SourceEdit, { family: "main" }>): Edited {
  const code = "POLICY_EXPORT_MISSING";
  const { source } = base;
  const file = parse(source);
  const main = mainFunction(file);
  const done = (text: string): Edited => ({ source: text, kind: base.kind, code });
  const start = main.getStart(file);
  const nameNode = main.name as ts.Identifier;
  switch (edit.op) {
    case "rename":
      return done(replaceRange(source, nameNode.getStart(file), nameNode.getEnd(), `Scene${edit.n % 1000}`));
    case "param": {
      const open = source.indexOf("(", nameNode.getEnd());
      return done(replaceRange(source, open + 1, open + 1, "props: unknown"));
    }
    case "async": {
      const keyword = source.indexOf("function", start);
      return done(replaceRange(source, keyword, keyword, "async "));
    }
    case "nodefault": {
      const keyword = source.indexOf("default", start);
      return done(replaceRange(source, keyword, keyword + "default ".length, ""));
    }
    case "arrow":
      return done(replaceRange(source, start, main.getEnd(), "export default () => null;"));
    case "class":
      return done(replaceRange(source, start, main.getEnd(), "export default class Main {}"));
    case "assignment": {
      const keyword = source.indexOf("default", start);
      const withoutDefault = replaceRange(source, keyword, keyword + "default ".length, "");
      return done(`${withoutDefault}\nexport default Main;\n`);
    }
    case "delete":
      return done(replaceRange(source, start, main.getEnd(), ""));
  }
}

function applyEdit(base: CorpusEntry, edit: SourceEdit): Edited {
  if (edit.family === "meta") return editMeta(base, edit);
  if (edit.family === "pause") return editPause(base, edit);
  return editMain(base, edit);
}

const WITH_PAUSE = GOOD.filter((entry) => entry.kind === "puzzle" && entry.source.includes("pauseAtFrame:"));
const WITHOUT_PAUSE = GOOD.filter((entry) => entry.kind === "lesson");

const META_OPS: readonly MetaOp[] = ["set", "spell", "extra", "duplicate", "delete", "rename", "let", "unexport", "spread"];
const MAIN_OPS: readonly MainOp[] = ["rename", "param", "async", "nodefault", "arrow", "class", "assignment", "delete"];

const editCaseArb: fc.Arbitrary<readonly [CorpusEntry, SourceEdit]> = fc.oneof(
  fc.tuple(
    baseArb,
    fc.record({
      family: fc.constant("meta" as const),
      op: fc.constantFrom(...META_OPS),
      key: fc.constantFrom(...META_KEYS),
      n: fc.nat(),
    }),
  ),
  fc.tuple(fc.constantFrom(...WITH_PAUSE), fc.record({ family: fc.constant("pause" as const), op: fc.constant("remove" as const), n: fc.nat() })),
  fc.tuple(fc.constantFrom(...WITHOUT_PAUSE), fc.record({ family: fc.constant("pause" as const), op: fc.constant("add" as const), n: fc.nat() })),
  fc.tuple(baseArb, fc.record({ family: fc.constant("pause" as const), op: fc.constant("flip" as const), n: fc.nat() })),
  fc.tuple(baseArb, fc.record({ family: fc.constant("main" as const), op: fc.constantFrom(...MAIN_OPS), n: fc.nat() })),
);

describe("Property 3 (arah a): satu suntingan bentuk modul selalu dilaporkan", () => {
  it("korpus memuat basis yang dibutuhkan suntingan pause (tes tidak kosong secara diam-diam)", () => {
    expect(WITH_PAUSE.length).toBeGreaterThanOrEqual(1);
    expect(WITHOUT_PAUSE.length).toBeGreaterThanOrEqual(5);
  });

  it("setiap suntingan meta, pause, dan ekspor pada setiap korpus bagus melaporkan kodenya", async () => {
    const failures: string[] = [];
    const cases: Array<[CorpusEntry, SourceEdit]> = [];
    for (const base of GOOD) {
      for (const op of META_OPS) {
        for (const key of META_KEYS) cases.push([base, { family: "meta", op, key, n: 3 }]);
      }
      for (const op of MAIN_OPS) cases.push([base, { family: "main", op, n: 7 }]);
      cases.push([base, { family: "pause", op: "flip", n: 0 }]);
    }
    for (const base of WITH_PAUSE) cases.push([base, { family: "pause", op: "remove", n: 0 }]);
    for (const base of WITHOUT_PAUSE) cases.push([base, { family: "pause", op: "add", n: 5 }]);
    const seen = new Set<string>();
    for (const [base, edit] of cases) {
      const edited = applyEdit(base, edit);
      seen.add(edited.code);
      const diagnostics = await scan(edited.source, edited.kind);
      const hit = diagnostics.some((d) => d.code === edited.code && d.severity === "error");
      if (!hit) {
        failures.push(`${base.name} ${JSON.stringify(edit)} -> ${JSON.stringify(diagnostics.map((d) => d.code))}`);
      }
    }
    expect(failures).toEqual([]);
    expect([...seen].sort()).toEqual(
      ["META_PAUSE_FORBIDDEN", "META_PAUSE_REQUIRED", "POLICY_EXPORT_MISSING", "POLICY_META_INVALID"],
    );
  });

  it("korpus bagus + satu suntingan meta, pause, atau ekspor acak: kode yang dimaksud selalu dilaporkan", () => {
    // Feature: ai-remotion-animation, Property 3: Soundness pemindaian kebijakan
    return fc.assert(
      fc.asyncProperty(editCaseArb, async ([base, edit]) => {
        const edited = applyEdit(base, edit);
        const diagnostics = await scan(edited.source, edited.kind);
        expect(
          diagnostics.some((d) => d.code === edited.code && d.severity === "error"),
          `${base.name} ${JSON.stringify(edit)} -> ${JSON.stringify(diagnostics.map((d) => d.code))}`,
        ).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
