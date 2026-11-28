// Tes langkah 2 bagian 2, pemindaian kebijakan AST aturan elemen, atribut, URL, warna, meta, ekspor,
// dan pause (tugas 4.3; Requirement 7.7 sampai 7.11, 7.14, 7.16, 1.2 sampai 1.5, 1.8, 1.9, 1.11, 1.14
// sampai 1.17, 1.19, 1.20; design 5.5).
// Setiap kode punya kasus tolak dan kasus lolos. Sumber uji dirakit dari satu Main_File sah (`file`) yang
// hanya diubah di bagian yang diuji, sehingga hasil `[]` berarti seluruh aturan langkah 2 (bukan hanya
// aturan yang diuji) menerima berkas itu. Daftar nama (elemen, atribut, warna, skema) dibaca dari
// kontrak, bukan ditulis ulang di sini. Korpus `fixtures/good` dijalankan melalui semua aturan.
import { readdirSync, readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/clock.js";
import { loadContract, type Contract } from "../src/contract.js";
import { policyStep } from "../src/steps/policy.js";
import { sizeStep } from "../src/steps/size.js";
import { META_ARTIFACT, createStepContext } from "../src/steps/step.js";
import type { Diagnostic, Kind, MainMeta } from "../src/types.js";
import { safeVerify } from "../src/verify.js";
import { loadCorpus } from "./support/corpus.js";

// ---- kontrak dan penjalan ----

const CONTRACT_URL = new URL("../contract/animation-contract.json", import.meta.url);
const loaded = loadContract(JSON.parse(readFileSync(CONTRACT_URL, "utf8")));
if (!loaded.ok) throw new Error(`kontrak sumber tidak sah: ${loaded.reason}`);
const contract: Contract = loaded.contract;

interface Run {
  readonly diagnostics: Diagnostic[];
  readonly meta: MainMeta | undefined;
}

async function run(source: string, kind: Kind = "lesson"): Promise<Run> {
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
  const result = await policyStep.run(context);
  return { diagnostics: [...result.diagnostics], meta: context.artifacts.get(META_ARTIFACT) };
}

/** Kode semua Diagnostic langkah 2, dalam urutan temuan. */
async function codesOf(source: string, kind: Kind = "lesson"): Promise<string[]> {
  return (await run(source, kind)).diagnostics.map((diagnostic) => diagnostic.code);
}

async function messagesOf(source: string, kind: Kind = "lesson"): Promise<string[]> {
  return (await run(source, kind)).diagnostics.map((diagnostic) => diagnostic.message);
}

// ---- perakit Main_File ----

const IMPORTS = [
  'import { createElement, Fragment } from "react";',
  'import type { ReactElement } from "react";',
  'import { AbsoluteFill, Sequence, Series, interpolate, useCurrentFrame } from "remotion";',
].join("\n");

const META_OK = "export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };";
const MAIN_OPEN = "export default function Main(): ReactElement {\n  useCurrentFrame();\n  return ";
const BODY_OK = 'createElement(AbsoluteFill, { style: { background: "var(--color-ink)" } }, "ok")';

interface FileParts {
  /** Deklarasi tingkat modul tambahan, di antara `meta` dan `Main`. */
  readonly decl?: string;
  /** Ekspresi yang dikembalikan `Main`. */
  readonly body?: string;
  /** Pengganti seluruh baris `export const meta`. */
  readonly meta?: string;
  /** Pengganti seluruh `export default function Main`. */
  readonly main?: string;
}

/** Main_File sah, dengan bagian yang diminta diganti. Tanpa argumen: nol Diagnostic. */
function file(parts: FileParts = {}): string {
  const main = parts.main ?? `${MAIN_OPEN}${parts.body ?? BODY_OK};\n}`;
  return [IMPORTS, parts.meta ?? META_OK, parts.decl ?? "", main, ""].join("\n");
}

/** Main_File sah dengan `body` sebagai isi `Main`. */
const withBody = (body: string, decl?: string): string => file({ body, ...(decl ? { decl } : {}) });

/** Main_File sah dengan `createElement("div", <props>)` sebagai isi `Main`. */
const withProps = (props: string, decl?: string): string =>
  withBody(`createElement("div", ${props})`, decl);

/** Main_File sah dengan `style: { <style> }` pada sebuah div. */
const withStyle = (style: string, decl?: string): string => withProps(`{ style: { ${style} } }`, decl);

/** Main_File sah dengan satu string literal sebagai deklarasi `const`. */
const withLiteral = (literal: string): string => file({ decl: `const LITERAL = ${literal};` });

const metaLine = (inner: string): string => `export const meta = ${inner};`;

// ---- dasar ----

describe("perakit: Main_File dasar tidak menghasilkan Diagnostic", () => {
  it("lesson dan puzzle (dengan pauseAtFrame) sah", async () => {
    expect(await codesOf(file())).toEqual([]);
    expect(
      await codesOf(
        file({ meta: metaLine("{ width: 1280, height: 720, fps: 30, durationInFrames: 60, pauseAtFrame: 30 }") }),
        "puzzle",
      ),
    ).toEqual([]);
  });
});

// ---- POLICY_DYNAMIC_ELEMENT ----

describe("POLICY_DYNAMIC_ELEMENT", () => {
  const rejected: ReadonlyArray<readonly [string, string]> = [
    ["referensi createElement ke variabel", withBody("createElement(AbsoluteFill, null)", "const f = createElement;")],
    ["createElement.call", withBody('createElement.call(null, "div", null)')],
    ["createElement.apply", withBody('createElement.apply(null, ["div", null])')],
    ["new createElement", withBody('new createElement("div")')],
    ["createElement dalam array", withBody("createElement(AbsoluteFill, null)", "const fs = [createElement];")],
    ["createElement sebagai argumen", withBody("createElement(AbsoluteFill, null)", "const g = (f: unknown) => f; g(createElement);")],
    ["createElement dengan as", withBody("createElement(AbsoluteFill, null)", "const f = createElement as unknown;")],
    ["tipe dari parameter", withBody("wrap(AbsoluteFill)", "function wrap(Comp: never): ReactElement { return createElement(Comp, null); }")],
    ["tipe dari deklarasi ambient", withBody("createElement(tag, null)", "declare const tag: string;")],
    ["fungsi ambient", withBody("createElement(Ghost, null)", "declare function Ghost(): ReactElement;")],
    ["tipe dari let", withBody("createElement(tag, null)", 'let tag = "div";')],
    ["tipe dari cabang ?:", withBody('createElement(Math.floor(1) > 0 ? "a" : "b", null)')],
    ["tipe dari pemanggilan fungsi", withBody("createElement(pick(), null)", 'const pick = () => "div";')],
    ["tipe dari akses elemen", withBody('createElement(TAGS[0], null)', 'const TAGS = ["div"];')],
    ["tanpa argumen", withBody("createElement()")],
    ["argumen spread", withBody("createElement(...ARGS)", 'const ARGS: [string] = ["div"];')],
    ["anggota dari objek yang tidak diizinkan", withBody("createElement(registry.Box, null)", "const registry = { Box: AbsoluteFill };")],
  ];

  it.each(rejected)("%s dilaporkan", async (_name, source) => {
    expect(await codesOf(source)).toEqual(["POLICY_DYNAMIC_ELEMENT"]);
  });

  it("alias impor dikenali: referensi beralias dan tipe dinamis dilaporkan", async () => {
    const aliased = (body: string, decl = ""): string =>
      [
        'import { createElement as h } from "react";',
        'import { AbsoluteFill, useCurrentFrame } from "remotion";',
        META_OK,
        decl,
        `export default function Main() { useCurrentFrame(); return ${body}; }`,
      ].join("\n");
    expect(await codesOf(aliased("h(AbsoluteFill, null)"))).toEqual([]);
    expect(await codesOf(aliased("h(AbsoluteFill, null)", "const f = h;"))).toEqual(["POLICY_DYNAMIC_ELEMENT"]);
    expect(await codesOf(aliased("h(tag, null)", "declare const tag: string;"))).toEqual(["POLICY_DYNAMIC_ELEMENT"]);
    expect(await codesOf(aliased('h("img", null)'))).toEqual(["POLICY_FORBIDDEN_ELEMENT"]);
  });

  const accepted: ReadonlyArray<readonly [string, string]> = [
    ["literal string", withBody('createElement("div", null)')],
    ["const berliteral string", withBody("createElement(TAG, null)", 'const TAG = "span";')],
    ["const berantai", withBody("createElement(B, null)", 'const A = "sp"; const B = A + "an";')],
    ["penjumlahan literal", withBody('createElement("d" + "iv", null)')],
    ["template literal tanpa substitusi", withBody("createElement(`div`, null)")],
    ["Fragment", withBody("createElement(Fragment, null, createElement(AbsoluteFill, null))")],
    ["AbsoluteFill", withBody("createElement(AbsoluteFill, null)")],
    ["Sequence", withBody("createElement(Sequence, { from: 0, durationInFrames: 30 })")],
    ["Series.Sequence (temuan dari 3.4)", withBody("createElement(Series, null, createElement(Series.Sequence, { durationInFrames: 30 }))")],
    ["Series.Sequence dalam kurung", withBody("createElement((Series.Sequence), { durationInFrames: 30 })")],
    ["fungsi lokal", withBody("createElement(Box, null)", 'function Box(): ReactElement { return createElement("div", null); }')],
    ["const fungsi panah lokal", withBody("createElement(Box, null)", 'const Box = (): ReactElement => createElement("div", null);')],
    ["const fungsi ekspresi lokal", withBody("createElement(Box, null)", 'const Box = function (): ReactElement { return createElement("div", null); };')],
    ["callee dalam kurung", withBody('(createElement)("div", null)')],
    ["callee optional call", withBody('createElement?.("div", null)')],
    ["nama createElement lokal bukan impor", file({ decl: 'function pick(createElement: (t: string) => null) { return createElement("img"); }' })],
  ];

  it.each(accepted)("%s lolos", async (_name, source) => {
    expect(await codesOf(source)).toEqual([]);
  });

  it("pesan mengikuti tabel 5.12", async () => {
    expect(await messagesOf(withBody("createElement(tag, null)", "declare const tag: string;"))).toEqual([
      "createElement type must be a string literal, Fragment, or a known component",
    ]);
  });

  it("dilaporkan pada argumen pertama, atau pada referensi", async () => {
    const found = (await run(withBody("createElement(tag, null)", "declare const tag: string;"))).diagnostics;
    expect(found).toHaveLength(1);
    // Baris 8 (IMPORTS 3 + meta 1 + decl 1 + 2 baris pembuka Main), kolom tepat sesudah `  return createElement(`.
    expect([found[0]?.line, found[0]?.column]).toEqual([8, 24]);
  });
});

// ---- POLICY_FORBIDDEN_ELEMENT ----

describe("POLICY_FORBIDDEN_ELEMENT", () => {
  it("setiap elemen terlarang pada kontrak dilaporkan, persis satu temuan", async () => {
    for (const name of contract.forbidden.element) {
      expect(await codesOf(withBody(`createElement("${name}", null)`)), name).toEqual(["POLICY_FORBIDDEN_ELEMENT"]);
    }
  });

  it("tanpa memperhatikan huruf besar-kecil, juga lewat pelipatan", async () => {
    const forbidden = "POLICY_FORBIDDEN_ELEMENT";
    expect(await codesOf(withBody('createElement("IMG", null)'))).toEqual([forbidden]);
    expect(await codesOf(withBody('createElement("Script", null)'))).toEqual([forbidden]);
    expect(await codesOf(withBody('createElement("i" + "mg", null)'))).toEqual([forbidden]);
    expect(await codesOf(withBody("createElement(KIND, null)", 'const KIND = "ifr" + "ame";'))).toEqual([forbidden]);
    expect(await codesOf(withBody("createElement(`vid${'eo'}`, null)"))).toEqual([forbidden]);
    expect(await codesOf(withBody('createElement("animateTransform", null)'))).toEqual([forbidden]);
  });

  it("pesan memuat nama elemen apa adanya", async () => {
    expect(await messagesOf(withBody('createElement("img", null)'))).toEqual(["element img is not allowed"]);
    expect(await messagesOf(withBody('createElement("IMG", null)'))).toEqual(["element IMG is not allowed"]);
  });

  it("elemen sah dan nama yang hanya mirip lolos", async () => {
    for (const name of ["div", "span", "svg", "g", "text", "rect", "path", "image", "settings", "setx", "animated", "links", "objects"]) {
      expect(await codesOf(withBody(`createElement("${name}", null)`)), name).toEqual([]);
    }
  });
});

// ---- POLICY_FORBIDDEN_ATTRIBUTE ----

describe("POLICY_FORBIDDEN_ATTRIBUTE", () => {
  it("setiap atribut terlarang pada kontrak dilaporkan, persis satu temuan", async () => {
    for (const name of contract.forbidden.attribute.names) {
      expect(await codesOf(withProps(`{ ${name}: "x" }`)), name).toEqual(["POLICY_FORBIDDEN_ATTRIBUTE"]);
    }
  });

  it("tanpa memperhatikan huruf besar-kecil, juga untuk kunci string dan kunci terlipat", async () => {
    const forbidden = ["POLICY_FORBIDDEN_ATTRIBUTE"];
    expect(await codesOf(withProps('{ SRC: "x" }'))).toEqual(forbidden);
    expect(await codesOf(withProps('{ Href: "x" }'))).toEqual(forbidden);
    expect(await codesOf(withProps('{ XLINKHREF: "x" }'))).toEqual(forbidden);
    expect(await codesOf(withProps('{ srcdoc: "x" }'))).toEqual(forbidden);
    expect(await codesOf(withProps('{ "src": "x" }'))).toEqual(forbidden);
    expect(await codesOf(withProps('{ ["s" + "rc"]: "x" }'))).toEqual(forbidden);
    expect(await codesOf(withProps('{ [KEY]: "x" }', 'const KEY = "hr" + "ef";'))).toEqual(forbidden);
  });

  it("^on[A-Z] sensitif huruf besar-kecil (Requirement 7.8)", async () => {
    const forbidden = ["POLICY_FORBIDDEN_ATTRIBUTE"];
    expect(await codesOf(withProps("{ onClick: () => null }"))).toEqual(forbidden);
    expect(await codesOf(withProps("{ onMouseEnter: () => null }"))).toEqual(forbidden);
    expect(await codesOf(withProps("{ onX: 1 }"))).toEqual(forbidden);
    expect(await codesOf(withProps('{ "onLoad": 1 }'))).toEqual(forbidden);
    expect(await codesOf(withProps("{ onClick() { return 1; } }"))).toEqual(forbidden);
    expect(await codesOf(withProps("{ ...{ onClick: 1 } }"))).toEqual(forbidden);
    for (const name of ["onset", "once", "on", "only", "onclick", "ON"]) {
      expect(await codesOf(withProps(`{ ${name}: 1 }`)), name).toEqual([]);
    }
  });

  it("kunci gaya berawalan animation atau transition dilaporkan, juga bentuk kebab dan vendor", async () => {
    const forbidden = ["POLICY_FORBIDDEN_ATTRIBUTE"];
    for (const key of [
      "animation",
      "animationName",
      "animationDuration",
      "transition",
      "transitionDelay",
      '"animation-name"',
      '"transition-property"',
      "WebkitAnimation",
      "webkitTransition",
      "msTransition",
      "MozAnimationName",
      '"-webkit-animation"',
    ]) {
      expect(await codesOf(withStyle(`${key}: "none"`)), key).toEqual(forbidden);
    }
  });

  it("pesan memuat nama kunci apa adanya", async () => {
    expect(await messagesOf(withProps('{ Src: "x" }'))).toEqual(["attribute Src is not allowed"]);
    expect(await messagesOf(withStyle('transitionDelay: "1s"'))).toEqual(["attribute transitionDelay is not allowed"]);
  });

  it("object yang disebar `{...p}` dipindai, termasuk const, kurung, dan sebar bertingkat (Requirement 7.8)", async () => {
    const forbidden = ["POLICY_FORBIDDEN_ATTRIBUTE"];
    expect(await codesOf(withProps("{ ...P }", 'const P = { onClick: 1 };'))).toEqual(forbidden);
    expect(await codesOf(withProps("{ ...(P) }", 'const P = { src: "x" };'))).toEqual(forbidden);
    expect(await codesOf(withProps("{ ...Q }", 'const P = { href: "x" }; const Q = { ...P };'))).toEqual(forbidden);
    expect(await codesOf(withProps("P", 'const P = { onClick: 1 };'))).toEqual(forbidden);
    expect(await codesOf(withProps("{ ...(Math.floor(1) > 0 ? P : null) }", 'const P = { src: "x" };'))).toEqual(forbidden);
    expect(await codesOf(withProps("(Math.floor(1) > 0 ? { src: 1 } : null)"))).toEqual(forbidden);
    expect(await codesOf(withProps("{ style: S }", 'const S = { transition: "none" };'))).toEqual(forbidden);
    expect(await codesOf(withProps("{ style: { ...S } }", 'const S = { animation: "none" };'))).toEqual(forbidden);
    expect(await codesOf(withProps("{ style }", 'const style = { transitionDuration: "1s" };'))).toEqual(forbidden);
  });

  it("temuan dari object yang disebar dilaporkan pada kunci di object itu", async () => {
    const found = (await run(withProps("{ ...P }", 'const P = {\n  onClick: 1,\n};'))).diagnostics;
    expect(found).toHaveLength(1);
    expect([found[0]?.line, found[0]?.column]).toEqual([6, 3]);
  });

  it("object yang merujuk dirinya sendiri tidak menggantung", async () => {
    const source = withProps("P", "const P: Record<string, unknown> = { ...P, src: 1 };");
    expect(await codesOf(source)).toEqual(["POLICY_FORBIDDEN_ATTRIBUTE"]);
  });

  const accepted: ReadonlyArray<readonly [string, string]> = [
    ["atribut biasa", withProps('{ id: "a", width: 10, viewBox: "0 0 10 10", "data-x": 1 }')],
    ["gaya biasa", withStyle('opacity: 1, transform: "translateX(4px)", color: "var(--color-ink)"')],
    ["props null", withProps("null")],
    ["props bukan object yang dikenal", withProps("makeProps()", "const makeProps = () => ({});")],
    ["kunci src pada object bukan props", withBody('createElement("div", null)', 'const data = { src: "x", onClick: 1, animation: 2 };')],
    ["opsi interpolate", withBody('createElement("div", { style: { opacity: interpolate(0, [0, 1], [0, 1], { extrapolateLeft: "clamp" }) } })')],
    ["kunci animation di luar style tidak dihitung (hanya kunci gaya)", withProps("{ animationX: 1 }")],
    ["kunci transform dan translate di gaya", withStyle("transform: 1, translate: 2, transformOrigin: 3")],
    ["kunci dinamis tak terlipat tidak dilaporkan", withProps("{ [k]: 1 }", "declare const k: string;")],
  ];

  it.each(accepted)("%s lolos", async (_name, source) => {
    expect(await codesOf(source)).toEqual([]);
  });
});

// ---- POLICY_URL_LITERAL ----

describe("POLICY_URL_LITERAL", () => {
  const rejected: readonly string[] = [
    '"url(#a)"',
    '"URL(#a)"',
    '"Url(x)"',
    '"fill: url(#a)"',
    '"http://example.com"',
    '"HTTPS://example.com"',
    '"  https://example.com"',
    '"\\u00a0\\u00a0https://example.com"',
    '"ftp:x"',
    '"ws://x"',
    '"WSS://x"',
    '"file:///etc/passwd"',
    '"http:"',
    '"data:text/html,x"',
    '"DATA:text/html,x"',
    '"blob:abc"',
    '"javascript:alert(1)"',
    '"JavaScript:alert(1)"',
    '"vbscript:x"',
    '"  javascript:x"',
    "`javascript:alert(1)`",
    "`https://${1}`",
    "`javascript:${1}`",
    "`url(${1})`",
    "`${1}url(x)`",
    '"java" + "script:alert(1)"',
    '"ht" + "tps://x"',
  ];

  it.each(rejected)("%s dilaporkan", async (literal) => {
    expect(await codesOf(withLiteral(literal))).toContain("POLICY_URL_LITERAL");
    expect((await codesOf(withLiteral(literal))).filter((code) => code === "POLICY_URL_LITERAL")).toHaveLength(1);
  });

  it("setiap skema pada kontrak: `skema:x` dilaporkan, dengan dan tanpa huruf besar", async () => {
    for (const scheme of contract.url_schemes) {
      expect(await codesOf(withLiteral(`"${scheme}:x"`)), scheme).toEqual(["POLICY_URL_LITERAL"]);
      expect(await codesOf(withLiteral(`"${scheme.toUpperCase()}:x"`)), scheme).toEqual(["POLICY_URL_LITERAL"]);
    }
  });

  it("skema `strict_colon` butuh karakter bukan spasi sesudah titik dua; skema lain cukup `skema:` (Requirement 7.9, 11.3)", async () => {
    const strict = new Set(contract.url_schemes_strict_colon);
    for (const scheme of contract.url_schemes) {
      const spaced = await codesOf(withLiteral(`"${scheme}: x"`));
      const bare = await codesOf(withLiteral(`"${scheme}:"`));
      const expected = strict.has(scheme) ? [] : ["POLICY_URL_LITERAL"];
      expect(spaced, `${scheme}: x`).toEqual(expected);
      expect(bare, `${scheme}:`).toEqual(expected);
    }
    expect(await codesOf(withLiteral('"data:\\tx"'))).toEqual([]);
    expect(await codesOf(withLiteral('"data:\\nx"'))).toEqual([]);
    expect(await codesOf(withLiteral('"javascript:\\u00a0x"'))).toEqual([]);
    expect(await codesOf(withLiteral('"data:x"'))).toEqual(["POLICY_URL_LITERAL"]);
    expect(await codesOf(withLiteral("`data: ${1}`"))).toEqual([]);
    expect(await codesOf(withLiteral("`data:${1}`"))).toEqual(["POLICY_URL_LITERAL"]);
  });

  const accepted: readonly string[] = [
    '"data: 5"',
    '"data:"',
    '"Data: results"',
    '"javascript: void"',
    '"https"',
    '"https ://x"',
    '"httpx://x"',
    '"see http://x"',
    '"the url is x"',
    '"curl x"',
    '"url (x)"',
    '"ur" + "l"',
    '""',
    "`plain ${1}`",
    '"0 0 1280 720"',
  ];

  it.each(accepted)("%s lolos", async (literal) => {
    expect(await codesOf(withLiteral(literal))).toEqual([]);
  });

  it("teks anak langsung createElement (argumen ketiga dan seterusnya) dikecualikan (Requirement 7.9)", async () => {
    expect(await codesOf(withBody('createElement("div", null, "https://example.com")'))).toEqual([]);
    expect(await codesOf(withBody('createElement("div", null, "see url(x)", "javascript:x")'))).toEqual([]);
    expect(await codesOf(withBody("createElement(\"div\", null, `https://${1}`)"))).toEqual([]);
    expect(await codesOf(withBody('createElement("div", null, "a", "http://x" + "y")'))).toEqual([]);
    expect(await codesOf(withBody('createElement("div", null, Math.floor(1) > 0 ? "http://x" : "y")'))).toEqual([]);
    expect(await codesOf(withBody('createElement("div", null, ("http://x"))'))).toEqual([]);
  });

  it("props (argumen kedua) dan argumen pertama tidak dikecualikan", async () => {
    expect(await codesOf(withProps('{ title: "https://example.com" }'))).toEqual(["POLICY_URL_LITERAL"]);
    expect(await codesOf(withBody('createElement("div", null, createElement("span", { title: "url(x)" }))'))).toEqual([
      "POLICY_URL_LITERAL",
    ]);
  });

  it("nama modul pada impor tidak dilaporkan dua kali oleh aturan URL", async () => {
    const source = file({ decl: 'import "https://example.com/x.js";' });
    expect(await codesOf(source)).toEqual(["POLICY_IMPORT_DISALLOWED"]);
  });

  it("paritas dengan `url_scheme_prefix` di backend/app/ai/animation/tokens.py (vektor dihitung dari Python, tugas 11.3)", async () => {
    // Pasangan [string, apakah dianggap URL]; dihasilkan oleh `url_scheme_prefix` pada kontrak yang sama.
    const vectors: ReadonlyArray<readonly [string, boolean]> = [
      ["http://x", true],
      ["HTTPS://x", true],
      ["  https://x", true],
      ["\u00a0javascript:x", true],
      ["\ufeffhttp://x", true],
      ["\u2028data:x", true],
      ["http:", true],
      ["ftp:", true],
      ["ws:", true],
      ["file:", true],
      ["Data:5", true],
      ["DATA:text/html,x", true],
      ["blob:abc", true],
      ["javascript:x", true],
      ["JaVaScRiPt:alert(1)", true],
      ["vbscript:x", true],
      ["wss://x", true],
      ["data:\u200bx", true],
      ["data: 5", false],
      ["data:", false],
      ["blob:\tx", false],
      ["javascript: void", false],
      ["javascript:\u00a0x", false],
      ["data:\u2028x", false],
      ["vbscript:", false],
      ["httpx://x", false],
      ["see http://x", false],
      ["https", false],
      ["  ", false],
      ["", false],
      ["\u212aata:x", false],
    ];
    for (const [text, isUrl] of vectors) {
      const found = (await codesOf(withLiteral(JSON.stringify(text)))).includes("POLICY_URL_LITERAL");
      expect(found, JSON.stringify(text)).toBe(isUrl);
    }
  });

  it("pesan mengikuti tabel 5.12", async () => {
    expect(await messagesOf(withLiteral('"url(#a)"'))).toEqual(["url() and URL schemes are not allowed in strings"]);
  });
});

// ---- POLICY_COLOR_LITERAL ----

describe("POLICY_COLOR_LITERAL: nilai properti pembawa warna (bagian b)", () => {
  const COLOR = ["POLICY_COLOR_LITERAL"];

  it("contoh dari spec: gabungan token palet lolos, nama warna ditolak (Requirement 1.15)", async () => {
    expect(await codesOf(withStyle('border: "1px solid var(--color-smoke)"'))).toEqual([]);
    expect(await codesOf(withStyle('border: "1px solid red"'))).toEqual(COLOR);
    expect(await codesOf(withProps('{ fill: "gold" }'))).toEqual(COLOR);
    expect(await codesOf(withProps('{ fill: "var(--color-gold)" }'))).toEqual([]);
    expect(await codesOf(withStyle('color: "var(--color-ink, red)"'))).toEqual(COLOR);
    expect(await codesOf(withStyle('color: "var(--color-cloth-mira)"'))).toEqual(COLOR);
    expect(await codesOf(withStyle('color: "oklch(0.5 0.1 100)"'))).toEqual(COLOR);
    expect(await codesOf(withStyle('color: "color-mix(in srgb, red, blue)"'))).toEqual(COLOR);
  });

  const rejected: ReadonlyArray<readonly [string, string]> = [
    ["nama warna pada style", withStyle('color: "red"')],
    ["nama warna huruf besar", withStyle('color: "RED"')],
    ["nama warna campuran huruf", withStyle('background: "GoLd"')],
    ["nama warna pada atribut SVG", withProps('{ stroke: "blue" }')],
    ["stopColor", withProps('{ stopColor: "orange" }')],
    ["hex 3 digit", withStyle('color: "#fff"')],
    ["hex 4 digit", withStyle('color: "#ffff"')],
    ["hex 6 digit", withStyle('color: "#ff0000"')],
    ["hex 8 digit", withStyle('color: "#ff0000ff"')],
    ["hex huruf besar", withStyle('color: "#FFF"')],
    ["hex di antara token lain", withStyle('border: "1px solid #fff"')],
    ["rgb", withStyle('color: "rgb(1, 2, 3)"')],
    ["rgba", withStyle('background: "rgba(0,0,0,0.5)"')],
    ["hsl", withStyle('color: "hsl(0 0% 0%)"')],
    ["fungsi warna huruf besar", withStyle('color: "HWB(0 0% 0%)"')],
    ["lab", withProps('{ fill: "lab(50 40 30)" }')],
    ["boxShadow dengan warna", withStyle('boxShadow: "0 0 4px rgba(0,0,0,.5)"')],
    ["boxShadow dengan nama warna", withStyle('boxShadow: "0 0 4px gold"')],
    ["textShadow dengan hex", withStyle('textShadow: "1px 1px #000"')],
    ["outline", withStyle('outline: "2px solid hotpink"')],
    ["caretColor", withStyle('caretColor: "lime"')],
    ["var token tak dikenal", withStyle('color: "var(--color-cloth-mira)"')],
    ["var tanpa --color-", withStyle('color: "var(--font-display)"')],
    ["var dengan fallback", withStyle('color: "var(--color-ink, red)"')],
    ["var dengan spasi di dalam", withStyle('color: "var( --color-ink )"')],
    ["VAR huruf besar", withStyle('color: "VAR(--color-ink)"')],
    ["argumen fungsi non-warna", withStyle('background: "linear-gradient(to right, red, var(--color-ink))"')],
    ["argumen fungsi bersarang", withStyle('background: "linear-gradient(to right, calc(1px + 2px), #fff)"')],
    ["kunci kebab", withStyle('"background-color": "red"')],
    ["kunci kebab stop-color", withProps('{ "stop-color": "red" }')],
    ["const", withStyle("color: RED", 'const RED = "red";')],
    ["const gabungan", withStyle("border: B", 'const B = "1px solid " + "red";')],
    ["template terlipat", withStyle("border: `1px solid ${C}`", 'const C = "red";')],
    ["cabang ?:", withStyle('color: Math.floor(1) > 0 ? "red" : "var(--color-ink)"')],
    ["sisi ||", withStyle('color: undefined || "red"')],
    ["spread const style", withProps("{ style: { ...S } }", 'const S = { color: "red" };')],
    ["style dari const", withProps("{ style: S }", 'const S = { background: "#abc" };')],
    ["style shorthand", withProps("{ style }", 'const style = { fill: "gold" };')],
    ["props const", withProps("P", 'const P = { fill: "gold" };')],
  ];

  it.each(rejected)("%s dilaporkan", async (_name, source) => {
    expect(await codesOf(source)).toEqual(COLOR);
  });

  const accepted: ReadonlyArray<readonly [string, string]> = [
    ["token palet pada style", withStyle('color: "var(--color-cream)", background: "var(--color-ink-soft)"')],
    ["token candle-ink", withStyle('color: "var(--color-candle-ink)"')],
    ["kata kunci transparent", withStyle('background: "transparent"')],
    ["kata kunci currentColor", withStyle('fill: "currentColor"', "")],
    ["kata kunci none", withProps('{ fill: "none", stroke: "none" }')],
    ["kata kunci inherit", withStyle('color: "inherit"')],
    ["kata kunci huruf besar", withStyle('color: "CURRENTCOLOR"')],
    ["border none", withStyle('border: "none"')],
    ["border angka", withStyle("border: 0")],
    ["boxShadow none", withStyle('boxShadow: "none"')],
    ["gradient berisi token palet", withStyle('background: "linear-gradient(to right, var(--color-ink), var(--color-gold))"')],
    ["panjang dan kata kunci non-warna", withStyle('border: "2px dashed var(--color-muted)"')],
    ["const palet", withStyle("color: INK", 'const INK = "var(--color-ink)";')],
    ["cabang palet", withStyle("color: Math.floor(1) > 0 ? INK : MUTED", 'const INK = "var(--color-ink)"; const MUTED = "var(--color-muted)";')],
    ["nilai dinamis tidak dinilai", withStyle("color: pick()", 'const pick = () => "var(--color-ink)";')],
    ["nilai angka", withProps("{ fill: 1, stroke: 2 }")],
    ["nama warna pada properti bukan pembawa warna", withProps('{ title: "red", id: "gold" }')],
    ["nama warna pada object bukan props", withBody('createElement("div", null)', 'const tone = { color: "red" };')],
  ];

  it.each(accepted)("%s lolos", async (_name, source) => {
    expect(await codesOf(source)).toEqual([]);
  });

  it("setiap nama warna pada kontrak ditolak, tiap token palet dan kata kunci diterima", async () => {
    const names = contract.color_forms.named_colors;
    const rejectedSource = withBody(
      `createElement("div", null, ${names.map((name) => `createElement("i", { fill: "${name}" })`).join(", ")})`,
    );
    const diagnostics = (await run(rejectedSource)).diagnostics;
    expect(diagnostics.map((d) => d.code)).toEqual(names.map(() => "POLICY_COLOR_LITERAL"));
    expect(diagnostics.map((d) => d.message.slice(d.message.lastIndexOf(" ") + 1))).toEqual([...names]);

    const upper = withBody(
      `createElement("div", null, ${names.map((name) => `createElement("i", { fill: "${name.toUpperCase()}" })`).join(", ")})`,
    );
    expect((await codesOf(upper)).length).toBe(names.length);

    const ok = [...contract.color_tokens.map((token) => `var(--color-${token})`), ...contract.color_keywords];
    const acceptedSource = withBody(
      `createElement("div", null, ${ok.map((value) => `createElement("i", { fill: "${value}", stroke: "${value}" })`).join(", ")})`,
    );
    expect(await codesOf(acceptedSource)).toEqual([]);
  });

  it("keempat kata kunci kontrak, transparent dan currentColor tidak termasuk nama warna terlarang (Requirement 1.17)", () => {
    expect(contract.namedColors.has("transparent")).toBe(false);
    expect(contract.namedColors.has("currentcolor")).toBe(false);
  });

  it("setiap fungsi warna pada kontrak ditolak sebagai nilai properti", async () => {
    for (const fn of contract.color_forms.functions) {
      expect(await codesOf(withProps(`{ fill: "${fn}0 0 0)" }`)), fn).toEqual(COLOR);
      expect(await codesOf(withProps(`{ fill: "${fn.toUpperCase()}0 0 0)" }`)), fn).toEqual(COLOR);
    }
  });

  it("pesan memuat potongan yang ditolak (`found <fragment>`)", async () => {
    expect(await messagesOf(withStyle('border: "1px solid red"'))).toEqual([
      "use var(--color-<token>) from the Kit palette, found red",
    ]);
    expect(await messagesOf(withStyle('color: "var(--color-ink, red)"'))).toEqual([
      "use var(--color-<token>) from the Kit palette, found var(--color-ink, red)",
    ]);
    expect(await messagesOf(withStyle('color: "rgb(1, 2, 3)"'))).toEqual([
      "use var(--color-<token>) from the Kit palette, found rgb(",
    ]);
  });

  it("dua pelanggaran pada satu nilai dilaporkan masing-masing", async () => {
    expect(await codesOf(withStyle('border: "red blue"'))).toEqual([...COLOR, ...COLOR]);
  });
});

describe("POLICY_COLOR_LITERAL: literal string (bagian a)", () => {
  const COLOR = ["POLICY_COLOR_LITERAL"];
  const rejected: readonly string[] = [
    '"#fff"',
    '"#FFF"',
    '"#abcd"',
    '"#ff0000"',
    '"#FF0000FF"',
    '"  #abc  "',
    '"rgb(0,0,0)"',
    '"RGB(0,0,0)"',
    '"rgba(0,0,0,0.5)"',
    '"hsl(0,0%,0%)"',
    '"hsla(0,0%,0%,0.5)"',
    '"1px solid rgb(1,2,3)"',
    '"oklch(0.5 0.1 100)"',
    '"color-mix(in srgb, red, blue)"',
    "`rgb(${1}, 2, 3)`",
    "`#ff` + `0000`",
    '"#ff" + "ffff"',
    '"rg" + "b(1,2,3)"',
  ];

  it.each(rejected)("%s dilaporkan, tepat sekali", async (literal) => {
    expect(await codesOf(withLiteral(literal))).toEqual(COLOR);
  });

  const accepted: readonly string[] = [
    '"#12"',
    '"#12345"',
    '"#1234567"',
    '"#123456789"',
    '"#ggg"',
    '"Step #1"',
    '"# fff"',
    '"collab(1)"',
    '"hue(1)"',
    '"var(--color-ink)"',
    '"1px solid var(--color-smoke)"',
    '"red"',
    '"gold"',
    "`#${1}`",
  ];

  it.each(accepted)("%s lolos", async (literal) => {
    expect(await codesOf(withLiteral(literal))).toEqual([]);
  });

  it("teks anak langsung createElement dikecualikan", async () => {
    expect(await codesOf(withBody('createElement("div", null, "#fff", "rgb(1,2,3)")'))).toEqual([]);
    expect(await codesOf(withBody("createElement(\"div\", null, `rgb(${1})`)"))).toEqual([]);
  });

  it("props tidak dikecualikan, nama modul tidak dilaporkan dua kali", async () => {
    expect(await codesOf(withProps('{ title: "#fff" }'))).toEqual(COLOR);
    expect(await codesOf(file({ decl: 'import "#fff";' }))).toEqual(["POLICY_IMPORT_DISALLOWED"]);
  });

  it("literal yang sama sebagai nilai properti warna dilaporkan sekali", async () => {
    expect(await codesOf(withProps('{ fill: "#fff" }'))).toEqual(COLOR);
    expect(await codesOf(withStyle('color: "rgba(0,0,0,.5)"'))).toEqual(COLOR);
  });
});

// ---- POLICY_META_INVALID ----

describe("POLICY_META_INVALID", () => {
  const INVALID = ["POLICY_META_INVALID"];

  it("berkas kosong, spasi saja, atau komentar saja: META_INVALID dan EXPORT_MISSING, tanpa SIZE atau ENCODING (Requirement 1.14)", async () => {
    for (const source of ["", "   \n\t  \n", "// hanya komentar", "/* satu */\n// dua\n", "\n\n  /** doc */  \n"]) {
      expect((await codesOf(source)).sort(), JSON.stringify(source)).toEqual([
        "POLICY_EXPORT_MISSING",
        "POLICY_META_INVALID",
      ]);
      const result = await safeVerify(
        { source, kind: "lesson", required_tokens: [], forbidden_tokens: [], contract_version: contract.contract_version },
        { clock: new FakeClock(), contract, steps: [sizeStep, policyStep] },
      );
      expect(result.ok).toBe(false);
      const reported = result.diagnostics.map((diagnostic) => diagnostic.code).sort();
      expect(reported, JSON.stringify(source)).toEqual(["POLICY_EXPORT_MISSING", "POLICY_META_INVALID"]);
    }
  });

  it("berkas kosong dilaporkan di baris 1 kolom 1", async () => {
    const found = (await run("")).diagnostics;
    expect(found.map((d) => [d.code, d.line, d.column])).toEqual([
      ["POLICY_META_INVALID", 1, 1],
      ["POLICY_EXPORT_MISSING", 1, 1],
    ]);
  });

  it("meta hilang", async () => {
    expect(await codesOf(file({ meta: "" }))).toEqual(INVALID);
  });

  it("pesan memuat nilai kontrak", async () => {
    expect(await messagesOf(file({ meta: "" }))).toEqual([
      "meta must be a literal object with width 1280, height 720, fps 30, durationInFrames 30..900",
    ]);
  });

  const notLiteralNumbers: ReadonlyArray<readonly [string, string]> = [
    ["pemisah _ (Requirement 1.19)", "{ width: 1_280, height: 720, fps: 30, durationInFrames: 60 }"],
    ["durasi 1_000 dengan pemisah", "{ width: 1280, height: 720, fps: 30, durationInFrames: 1_000 }"],
    ["eksponen 1e3", "{ width: 1280, height: 720, fps: 30, durationInFrames: 1e3 }"],
    ["eksponen 6e1", "{ width: 1280, height: 720, fps: 30, durationInFrames: 6e1 }"],
    ["heksadesimal 0x10", "{ width: 1280, height: 720, fps: 30, durationInFrames: 0x10 }"],
    ["heksadesimal 0x500", "{ width: 0x500, height: 720, fps: 30, durationInFrames: 60 }"],
    ["biner 0b111100", "{ width: 1280, height: 720, fps: 30, durationInFrames: 0b111100 }"],
    ["oktal 0o74", "{ width: 1280, height: 720, fps: 30, durationInFrames: 0o74 }"],
    ["titik desimal 30.0", "{ width: 1280, height: 720, fps: 30.0, durationInFrames: 60 }"],
    ["titik desimal 60.5", "{ width: 1280, height: 720, fps: 30, durationInFrames: 60.5 }"],
    ["titik di awal .5", "{ width: 1280, height: 720, fps: 30, durationInFrames: .5 }"],
    ["bigint", "{ width: 1280, height: 720, fps: 30, durationInFrames: 60n }"],
    ["string", '{ width: "1280", height: 720, fps: 30, durationInFrames: 60 }'],
    ["ekspresi aritmetika", "{ width: 1280, height: 360 * 2, fps: 30, durationInFrames: 60 }"],
    ["identifier", "{ width: 1280, height: 720, fps: FPS, durationInFrames: 60 }"],
    ["tanda plus", "{ width: 1280, height: 720, fps: 30, durationInFrames: +60 }"],
    ["dalam kurung", "{ width: 1280, height: 720, fps: 30, durationInFrames: (60) }"],
    ["null", "{ width: 1280, height: 720, fps: 30, durationInFrames: null }"],
    ["true", "{ width: 1280, height: 720, fps: 30, durationInFrames: true }"],
    ["NaN", "{ width: 1280, height: 720, fps: 30, durationInFrames: NaN }"],
  ];

  it.each(notLiteralNumbers)("%s ditolak, persis satu temuan", async (_name, object) => {
    expect(await codesOf(file({ meta: metaLine(object), decl: "const FPS = 30;" }))).toEqual(INVALID);
  });

  const notObjectLiteral: ReadonlyArray<readonly [string, string]> = [
    ["let", "export let meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };"],
    ["var", "export var meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };"],
    ["tidak diekspor", "const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };"],
    ["hasil pemanggilan", "export const meta = makeMeta();"],
    ["array", "export const meta = [1280, 720, 30, 60];"],
    ["angka", "export const meta = 1280;"],
    ["null", "export const meta = null;"],
    ["tanpa initializer", "export declare const meta: { width: 1280 };"],
    ["fungsi", "export function meta() { return 1; }"],
    ["kelas", "export class meta {}"],
    ["spread", "export const meta = { ...BASE };"],
    ["shorthand", "export const meta = { width: 1280, height: 720, fps: 30, durationInFrames };"],
    ["metode", "export const meta = { width: 1280, height: 720, fps: 30, durationInFrames() { return 60; } };"],
    ["kunci terhitung", 'export const meta = { ["width"]: 1280, height: 720, fps: 30, durationInFrames: 60 };'],
    ["kunci angka", "export const meta = { 1: 1280, height: 720, fps: 30, durationInFrames: 60 };"],
  ];

  it.each(notObjectLiteral)("meta berbentuk %s ditolak", async (_name, line) => {
    expect(await codesOf(file({ meta: line, decl: "const BASE = {}; const durationInFrames = 60; declare function makeMeta(): never;" }))).toEqual(INVALID);
  });

  it("kunci selain lima kunci, kunci ganda, dan kunci yang hilang", async () => {
    expect(await codesOf(file({ meta: metaLine("{ width: 1280, height: 720, fps: 30, durationInFrames: 60, depth: 3 }") }))).toEqual(INVALID);
    expect(await codesOf(file({ meta: metaLine("{ width: 1280, height: 720, fps: 30, durationInFrames: 60, durationInFrames: 60 }") }))).toEqual(INVALID);
    expect(await codesOf(file({ meta: metaLine("{ width: 1280, height: 720, fps: 30, durationInFrames: 60, width: 1280 }") }))).toEqual(INVALID);
    expect(await codesOf(file({ meta: metaLine("{ width: 1280, height: 720, durationInFrames: 60 }") }))).toEqual(INVALID);
    expect(await codesOf(file({ meta: metaLine("{ height: 720, fps: 30, durationInFrames: 60 }") }))).toEqual(INVALID);
    expect(await codesOf(file({ meta: metaLine("{}") }))).toEqual(INVALID);
  });

  it("kunci ganda dengan nilai berbeda: satu temuan, kemunculan pertama yang dipakai", async () => {
    expect(await codesOf(file({ meta: metaLine("{ width: 1280, width: 1, height: 720, fps: 30, durationInFrames: 60 }") }))).toEqual(INVALID);
  });

  it("lebih dari satu deklarasi meta (Requirement 1.19)", async () => {
    expect(await codesOf(file({ meta: `${META_OK}\nvar meta = 1;` }))).toEqual(INVALID);
    expect(await codesOf(file({ meta: `${META_OK}\nfunction meta() { return 1; }` }))).toEqual(INVALID);
    expect(await codesOf(file({ meta: `${META_OK}\nclass meta {}` }))).toEqual(INVALID);
    expect(await codesOf(file({ meta: `${META_OK}\nenum meta { A }` }))).toEqual(INVALID);
  });

  it("deklarasi bernama meta di dalam fungsi atau tipe bernama meta bukan deklarasi kedua", async () => {
    expect(await codesOf(file({ decl: "function f() { const meta = 1; return meta; }" }))).toEqual([]);
    expect(await codesOf(file({ decl: "type meta = number; interface meta { x: number }" }))).toEqual([]);
  });

  const outOfRange: ReadonlyArray<readonly [string, string]> = [
    ["width 1279", "{ width: 1279, height: 720, fps: 30, durationInFrames: 60 }"],
    ["width 1281", "{ width: 1281, height: 720, fps: 30, durationInFrames: 60 }"],
    ["height 719", "{ width: 1280, height: 719, fps: 30, durationInFrames: 60 }"],
    ["fps 29", "{ width: 1280, height: 720, fps: 29, durationInFrames: 60 }"],
    ["fps 60", "{ width: 1280, height: 720, fps: 60, durationInFrames: 60 }"],
    ["durasi 29", "{ width: 1280, height: 720, fps: 30, durationInFrames: 29 }"],
    ["durasi 901", "{ width: 1280, height: 720, fps: 30, durationInFrames: 901 }"],
    ["durasi 0", "{ width: 1280, height: 720, fps: 30, durationInFrames: 0 }"],
    ["durasi negatif", "{ width: 1280, height: 720, fps: 30, durationInFrames: -60 }"],
    ["width negatif", "{ width: -1280, height: 720, fps: 30, durationInFrames: 60 }"],
    ["angka sangat besar", "{ width: 1280, height: 720, fps: 30, durationInFrames: 99999999999999999999999 }"],
    ["nol di depan", "{ width: 1280, height: 720, fps: 30, durationInFrames: 060 }"],
  ];

  it.each(outOfRange)("%s ditolak", async (_name, object) => {
    expect(await codesOf(file({ meta: metaLine(object) }))).toEqual(INVALID);
  });

  it("batas 30 dan 900 diterima", async () => {
    expect(await codesOf(file({ meta: metaLine("{ width: 1280, height: 720, fps: 30, durationInFrames: 30 }") }))).toEqual([]);
    expect(await codesOf(file({ meta: metaLine("{ width: 1280, height: 720, fps: 30, durationInFrames: 900 }") }))).toEqual([]);
  });

  it("kunci string, urutan kunci bebas, as const, satisfies, dan `export { meta }` diterima", async () => {
    expect(await codesOf(file({ meta: metaLine('{ "width": 1280, fps: 30, "height": 720, durationInFrames: 60 }') }))).toEqual([]);
    expect(await codesOf(file({ meta: metaLine("{ width: 1280, height: 720, fps: 30, durationInFrames: 60 } as const") }))).toEqual([]);
    expect(await codesOf(file({ meta: metaLine("({ width: 1280, height: 720, fps: 30, durationInFrames: 60 })") }))).toEqual([]);
    expect(
      await codesOf(file({ meta: "const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };\nexport { meta };" })),
    ).toEqual([]);
    expect(
      await codesOf(file({ meta: "let meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };\nexport { meta };" })),
    ).toEqual(INVALID);
  });

  it("temuan dilaporkan pada nilai atau kunci yang salah (baris dan kolom basis 1)", async () => {
    const source = file({ meta: "export const meta = {\n  width: 1280,\n  height: 700,\n  fps: 30,\n  durationInFrames: 60,\n};" });
    const found = (await run(source)).diagnostics;
    expect(found.map((d) => [d.code, d.line, d.column])).toEqual([["POLICY_META_INVALID", 6, 11]]);
  });
});

// ---- META_PAUSE_REQUIRED dan META_PAUSE_FORBIDDEN ----

describe("META_PAUSE_REQUIRED dan META_PAUSE_FORBIDDEN", () => {
  const withPause = (p: number | string): string =>
    file({ meta: metaLine(`{ width: 1280, height: 720, fps: 30, durationInFrames: 60, pauseAtFrame: ${p} }`) });

  it("puzzle tanpa pauseAtFrame: META_PAUSE_REQUIRED (Requirement 1.4)", async () => {
    expect(await codesOf(file(), "puzzle")).toEqual(["META_PAUSE_REQUIRED"]);
  });

  it("puzzle dengan pauseAtFrame: lolos", async () => {
    expect(await codesOf(withPause(30), "puzzle")).toEqual([]);
    expect(await codesOf(withPause(1), "puzzle")).toEqual([]);
    expect(await codesOf(withPause(59), "puzzle")).toEqual([]);
  });

  it("lesson dengan pauseAtFrame: META_PAUSE_FORBIDDEN (Requirement 1.5)", async () => {
    expect(await codesOf(withPause(30), "lesson")).toEqual(["META_PAUSE_FORBIDDEN"]);
  });

  it("lesson tanpa pauseAtFrame: lolos", async () => {
    expect(await codesOf(file(), "lesson")).toEqual([]);
  });

  it("pauseAtFrame di luar 1..d-1: META_INVALID, bukan META_PAUSE_REQUIRED", async () => {
    for (const p of [0, 60, 61, -1, 1000]) {
      expect(await codesOf(withPause(p), "puzzle"), `p=${p}`).toEqual(["POLICY_META_INVALID"]);
    }
  });

  it("pauseAtFrame bukan literal: META_INVALID untuk puzzle, dan juga META_PAUSE_FORBIDDEN untuk lesson", async () => {
    expect(await codesOf(withPause("30.5"), "puzzle")).toEqual(["POLICY_META_INVALID"]);
    expect((await codesOf(withPause("0x1e"), "lesson")).sort()).toEqual(["META_PAUSE_FORBIDDEN", "POLICY_META_INVALID"]);
    expect((await codesOf(withPause(0), "lesson")).sort()).toEqual(["META_PAUSE_FORBIDDEN", "POLICY_META_INVALID"]);
  });

  it("pesan mengikuti tabel 5.12", async () => {
    expect(await messagesOf(file(), "puzzle")).toEqual(["puzzle animations must set meta.pauseAtFrame"]);
    expect(await messagesOf(withPause(30), "lesson")).toEqual(["lesson animations must not set meta.pauseAtFrame"]);
  });

  it("aturan pause tidak dinilai bila meta bukan object literal (sudah dilaporkan META_INVALID)", async () => {
    expect(await codesOf(file({ meta: "export const meta = makeMeta();", decl: "declare function makeMeta(): never;" }), "puzzle")).toEqual([
      "POLICY_META_INVALID",
    ]);
  });
});

// ---- tes parametrik 1.16 ----

describe("parametrik Requirement 1.16: hanya meta valid yang lolos langkah 2", () => {
  const puzzle = (w: number, h: number, f: number, d: number, p: number): string =>
    file({
      meta: metaLine(`{ width: ${w}, height: ${h}, fps: ${f}, durationInFrames: ${d}, pauseAtFrame: ${p} }`),
    });

  const isValid = (w: number, h: number, f: number, d: number, p: number): boolean =>
    w === 1280 && h === 720 && f === 30 && d >= 30 && d <= 900 && p >= 1 && p <= d - 1;

  async function check(w: number, h: number, f: number, d: number, p: number): Promise<void> {
    const { diagnostics, meta } = await run(puzzle(w, h, f, d, p), "puzzle");
    const invalid = diagnostics.filter((diagnostic) => diagnostic.code === "POLICY_META_INVALID");
    const label = `w=${w} h=${h} f=${f} d=${d} p=${p}`;
    if (isValid(w, h, f, d, p)) {
      expect(diagnostics, label).toEqual([]);
      expect(meta, label).toEqual({ width: 1280, height: 720, fps: 30, durationInFrames: d, pauseAtFrame: p });
    } else {
      expect(invalid.length, label).toBeGreaterThanOrEqual(1);
      expect(meta, label).toBeUndefined();
    }
    // Aturan pause tidak ikut menolak: `pauseAtFrame` selalu ada pada puzzle ini.
    expect(diagnostics.some((diagnostic) => diagnostic.code.startsWith("META_")), label).toBe(false);
  }

  const edge = [-10, -1, 0, 1, 2, 28, 29, 30, 31, 59, 60, 61, 89, 719, 720, 721, 899, 900, 901, 1279, 1280, 1281, 1999, 2000];

  it("setiap parameter divariasikan pada nilai tepi, parameter lain sah", async () => {
    for (const value of edge) {
      await check(value, 720, 30, 60, 30);
      await check(1280, value, 30, 60, 30);
      await check(1280, 720, value, 60, 30);
      await check(1280, 720, 30, value, 30);
      await check(1280, 720, 30, 900, value);
      await check(1280, 720, 30, 60, value);
    }
  });

  it("kombinasi acak pada -10 sampai 2000, dengan bias ke nilai valid dan tepi", async () => {
    const any = fc.integer({ min: -10, max: 2000 });
    const near = (valid: number): fc.Arbitrary<number> => fc.oneof({ weight: 3, arbitrary: fc.constant(valid) }, { weight: 1, arbitrary: any });
    const duration = fc.oneof({ weight: 3, arbitrary: fc.integer({ min: 30, max: 900 }) }, { weight: 2, arbitrary: fc.constantFrom(...edge) }, { weight: 1, arbitrary: any });
    await fc.assert(
      fc.asyncProperty(near(1280), near(720), near(30), duration, any, async (w, h, f, d, p) => {
        await check(w, h, f, d, p);
      }),
      { numRuns: 150, seed: 20241127 },
    );
  });

  it("pauseAtFrame mengikuti durasi: untuk durasi valid, p valid tepat pada 1..d-1", async () => {
    for (const d of [30, 31, 60, 899, 900]) {
      for (const p of [0, 1, 2, d - 2, d - 1, d, d + 1]) {
        await check(1280, 720, 30, d, p);
      }
    }
  });
});

// ---- POLICY_EXPORT_MISSING dan POLICY_EXPORT_UNEXPECTED ----

describe("POLICY_EXPORT_MISSING", () => {
  const MISSING = ["POLICY_EXPORT_MISSING"];
  const rejected: ReadonlyArray<readonly [string, string]> = [
    ["tanpa ekspor default", "function Main(): ReactElement { return createElement(AbsoluteFill, null); }"],
    ["nama bukan Main", "export default function Other(): ReactElement { return createElement(AbsoluteFill, null); }"],
    ["fungsi anonim", "export default function (): ReactElement { return createElement(AbsoluteFill, null); }"],
    ["dengan parameter", "export default function Main(frame: number): ReactElement { return createElement(AbsoluteFill, null); }"],
    ["dengan parameter opsional", "export default function Main(frame?: number): ReactElement { return createElement(AbsoluteFill, null); }"],
    ["dengan sisa parameter", "export default function Main(...rest: number[]): ReactElement { return createElement(AbsoluteFill, null); }"],
    ["fungsi panah", "export default (): ReactElement => createElement(AbsoluteFill, null);"],
    ["ekspresi", "export default createElement(AbsoluteFill, null);"],
    ["async", "export default async function Main(): Promise<ReactElement> { return createElement(AbsoluteFill, null); }"],
    ["generator", "export default function* Main() { yield 1; }"],
    ["kelas", "export default class Main {}"],
    ["referensi ke fungsi", "function Main(): ReactElement { return createElement(AbsoluteFill, null); }\nexport default Main;"],
    ["export { Main as default }", "function Main(): ReactElement { return createElement(AbsoluteFill, null); }\nexport { Main as default };"],
    ["interface default", "export default interface Main {}"],
  ];

  it.each(rejected)("%s dilaporkan", async (_name, main) => {
    expect(await codesOf(file({ main }))).toEqual(MISSING);
  });

  it("fungsi biasa bernama Main dengan tipe kembalian apa pun lolos, juga tanpa anotasi", async () => {
    const main = "export default function Main() { useCurrentFrame(); return createElement(AbsoluteFill, null); }";
    expect(await codesOf(file({ main }))).toEqual([]);
  });

  it("pesan mengikuti tabel 5.12 dan dilaporkan pada ekspor default yang salah", async () => {
    const source = file({ main: "export default function Other(): ReactElement { return createElement(AbsoluteFill, null); }" });
    const found = (await run(source)).diagnostics;
    expect(found.map((d) => d.message)).toEqual(["export default function Main() with no parameters is required"]);
    expect(found[0]?.line).toBe(6);
  });
});

describe("POLICY_EXPORT_UNEXPECTED", () => {
  const UNEXPECTED = ["POLICY_EXPORT_UNEXPECTED"];
  const rejected: ReadonlyArray<readonly [string, string]> = [
    ["export const", "export const extra = 1;"],
    ["export let", "export let extra = 1;"],
    ["export function", "export function extra() { return 1; }"],
    ["export class", "export class Extra {}"],
    ["export enum", "export enum Extra { A }"],
    ["export type", "export type Extra = number;"],
    ["export interface", "export interface Extra { x: number }"],
    ["export namespace", "export namespace Extra { export const x = 1; }"],
    ["export bernama", "const extra = 1;\nexport { extra };"],
    ["export bernama dengan alias", "const extra = 1;\nexport { extra as other };"],
    ["export type bernama", "type Extra = number;\nexport type { Extra };"],
    ["export destructuring", "export const { a } = { a: 1 };"],
    ["export import", "export import Alias = Extra.Inner;"],
    ["export =", "const extra = 1;\nexport = extra;"],
  ];

  it.each(rejected)("%s dilaporkan", async (_name, decl) => {
    expect(await codesOf(file({ decl }))).toEqual(UNEXPECTED);
  });

  it("ekspor lain dari modul lain: juga POLICY_IMPORT_DISALLOWED", async () => {
    for (const decl of ['export * from "react";', 'export { createElement } from "react";', 'export * as r from "remotion";']) {
      expect((await codesOf(file({ decl }))).sort(), decl).toEqual(["POLICY_EXPORT_UNEXPECTED", "POLICY_IMPORT_DISALLOWED"]);
    }
  });

  it("ekspor default kedua dilaporkan, `Main` sah tetap diterima", async () => {
    const decl = "export { extra as default };\nconst extra = 1;";
    expect(await codesOf(file({ decl }))).toEqual(UNEXPECTED);
    const source = file({ main: `${MAIN_OPEN}${BODY_OK};\n}\nexport default 1;` });
    expect(await codesOf(source)).toEqual(UNEXPECTED);
  });

  it("hanya meta dan ekspor default lolos; deklarasi tanpa export tidak dihitung", async () => {
    expect(
      await codesOf(file({ decl: "const a = 1;\nfunction f() { return a; }\ntype T = number;\ninterface I { x: number }\nenum E { A }\nnamespace N { export const x = 1; }" })),
    ).toEqual([]);
  });

  it("pesan mengikuti tabel 5.12 dan dilaporkan pada deklarasi atau specifier", async () => {
    const found = (await run(file({ decl: "export const extra = 1;" }))).diagnostics;
    expect(found.map((d) => d.message)).toEqual(["only meta and the default export are allowed"]);
    expect([found[0]?.line, found[0]?.column]).toEqual([5, 14]);
  });
});

// ---- ketahanan ----

describe("sumber rusak atau ganjil tidak melempar (aturan bagian 2)", () => {
  const odd: readonly string[] = [
    "export",
    "export default",
    "export const meta",
    "export const meta =",
    "export const meta = {",
    "export const meta = { width: };",
    "export const meta = { ...",
    "export default function Main(",
    'import { createElement } from "react"; createElement(',
    'import { createElement } from "react"; createElement(,)',
    'import { createElement } from "react"; createElement("div", {',
    'import { createElement } from "react"; createElement("div", { style: { color: } })',
    'import { createElement } from "react"; createElement("div", { ...',
    'import { createElement } from "react"; createElement`div`',
    'import { createElement } from "react"; new createElement',
    'const x = `${`;',
    'const x = "url(',
    "export { , };",
    "export * as from;",
    'export default function Main() {} export default function Main() {}',
    "const meta = meta;",
    "export const meta = meta;",
    "const P = { ...P }; export default P;",
    "const a = a + a;",
  ];

  it.each(odd.map((source, index) => [index, source] as const))("sumber ganjil #%i menghasilkan hasil, bukan exception", async (_index, source) => {
    const result = await codesOf(source);
    expect(Array.isArray(result)).toBe(true);
    for (const code of result) expect(code).toMatch(contract.diagnosticCodeRegex);
  });

  it("rantai penjumlahan string yang sangat panjang tidak melampaui tumpukan dan tetap dilaporkan", async () => {
    const chain = Array.from({ length: 6000 }, () => '"a"').join(" + ");
    expect(await codesOf(withLiteral(`${chain} + "url(x)"`))).toContain("POLICY_URL_LITERAL");
    expect(await codesOf(withLiteral(chain))).toEqual([]);
  });

  it("props dengan sebaran sangat dalam berhenti di batas kedalaman", async () => {
    const chain = Array.from({ length: 40 }, (_, i) => `const P${i + 1} = { ...P${i} };`).join("\n");
    const source = withProps("P40", `const P0 = { src: 1 };\n${chain}`);
    // Lebih dalam dari `fold_depth` (8): tidak dilacak, tetapi tidak menggantung dan tidak melempar.
    expect(Array.isArray(await codesOf(source))).toBe(true);
    expect(await codesOf(withProps("P3", "const P0 = { src: 1 };\nconst P1 = { ...P0 };\nconst P2 = { ...P1 };\nconst P3 = { ...P2 };"))).toEqual([
      "POLICY_FORBIDDEN_ATTRIBUTE",
    ]);
  });
});

// ---- korpus ----

const GOOD_DIR = new URL("../fixtures/good/", import.meta.url);
const BAD_DIR = new URL("../fixtures/bad/", import.meta.url);

interface GoodCompanion {
  readonly kind: Kind;
}

describe("korpus fixtures/good melalui seluruh aturan langkah 2: nol Diagnostic (Requirement 7.14)", () => {
  const goodSources = readdirSync(GOOD_DIR).filter((name) => name.endsWith(".ts")).sort();

  it("korpus tidak kosong", () => {
    expect(goodSources.length).toBeGreaterThanOrEqual(8);
  });

  it.each(goodSources)("%s: nol Diagnostic dan meta statis terbukti", async (name) => {
    const source = readFileSync(new URL(name, GOOD_DIR), "utf8");
    const companion = JSON.parse(readFileSync(new URL(name.replace(/\.ts$/, ".json"), GOOD_DIR), "utf8")) as GoodCompanion;
    const { diagnostics, meta } = await run(source, companion.kind);
    expect(diagnostics).toEqual([]);
    expect(meta?.width).toBe(contract.canvas.width);
    expect(meta?.height).toBe(contract.canvas.height);
    expect(meta?.fps).toBe(contract.canvas.fps);
    expect(meta?.durationInFrames).toBeGreaterThanOrEqual(contract.duration.min);
    expect(meta?.durationInFrames).toBeLessThanOrEqual(contract.duration.max);
    expect(meta?.pauseAtFrame !== undefined).toBe(companion.kind === "puzzle");
  });

  it("jenis yang salah memunculkan aturan pause: puzzle dibaca sebagai lesson dan sebaliknya", async () => {
    const puzzle = readFileSync(new URL("puzzle-pause.ts", GOOD_DIR), "utf8");
    expect(await codesOf(puzzle, "lesson")).toEqual(["META_PAUSE_FORBIDDEN"]);
    const lesson = readFileSync(new URL("table-lesson.ts", GOOD_DIR), "utf8");
    expect(await codesOf(lesson, "puzzle")).toEqual(["META_PAUSE_REQUIRED"]);
  });

  it("pauseAtFrame fixture puzzle terbaca persis dari meta", async () => {
    const { meta } = await run(readFileSync(new URL("puzzle-pause.ts", GOOD_DIR), "utf8"), "puzzle");
    expect(meta).toEqual({ width: 1280, height: 720, fps: 30, durationInFrames: 150, pauseAtFrame: 90 });
  });
});

// Hanya fixture yang seluruh kode harapannya milik langkah 2 (awalan POLICY_ dan META_); kode langkah lain
// (SIZE_, ENCODING_, ESLINT_, TSC_, RENDER_, FIDELITY_) diperiksa di pipeline penuh oleh tes korpus (8.2).
// Jenis (`lesson` atau `puzzle`) dibaca dari pendamping fixture bila ada (`tests/support/corpus.ts`).
describe("korpus fixtures/bad: tepat kode langkah 2 pada expected.json", () => {
  const policyEntries = loadCorpus("bad")
    .filter((entry) => entry.expectedCodes?.every((code) => /^(POLICY|META)_/.test(code)) === true)
    .map((entry) => ({ name: entry.name, kind: entry.kind, codes: entry.expectedCodes ?? [] }));

  it("memuat entri", () => {
    expect(policyEntries.length).toBeGreaterThanOrEqual(6);
  });

  it.each(policyEntries)("$name melaporkan tepat kode yang diharapkan (satu pelanggaran per fixture)", async ({ name, kind, codes }) => {
    const source = readFileSync(new URL(name, BAD_DIR), "utf8");
    const reported = [...new Set((await run(source, kind)).diagnostics.map((diagnostic) => diagnostic.code))].sort();
    expect(reported).toEqual([...codes].sort());
  });
});

// ---- alur pipeline ----

describe("lewat verify(): temuan bagian 2 menjadi Diagnostic tool=policy", () => {
  it("meta salah dan ekspor salah dilaporkan bersama dalam satu lintasan, langkah 2 tercatat gagal", async () => {
    const result = await safeVerify(
      {
        source: file({ meta: metaLine("{ width: 1, height: 720, fps: 30, durationInFrames: 60 }"), main: "export default function Other() { return null; }" }),
        kind: "lesson",
        required_tokens: [],
        forbidden_tokens: [],
        contract_version: contract.contract_version,
      },
      { clock: new FakeClock(), contract, steps: [sizeStep, policyStep] },
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => [d.tool, d.code]).sort()).toEqual([
      ["policy", "POLICY_EXPORT_MISSING"],
      ["policy", "POLICY_META_INVALID"],
    ]);
    expect(result.summary.checks.map(({ name, ok }) => ({ name, ok }))).toEqual([
      { name: "size", ok: true },
      { name: "policy", ok: false },
    ]);
  });

  it("META_PAUSE_* memakai tool policy (awalan META)", async () => {
    const result = await safeVerify(
      { source: file(), kind: "puzzle", required_tokens: [], forbidden_tokens: [], contract_version: contract.contract_version },
      { clock: new FakeClock(), contract, steps: [sizeStep, policyStep] },
    );
    expect(result.diagnostics.map((d) => [d.tool, d.code])).toEqual([["policy", "META_PAUSE_REQUIRED"]]);
  });
});

// ---- ringkasan kontrak ----

describe("tes soundness per entri kontrak (Requirement 2.7)", () => {
  it("setiap entri forbidden.element dan forbidden.attribute.names menghasilkan galat; nama impor yang diizinkan tidak", async () => {
    for (const name of contract.forbidden.element) {
      const found = (await run(withBody(`createElement("${name}", null)`))).diagnostics;
      expect(found.some((d) => d.severity === "error" && d.code === "POLICY_FORBIDDEN_ELEMENT"), name).toBe(true);
    }
    for (const name of contract.forbidden.attribute.names) {
      const found = (await run(withProps(`{ ${name}: "x" }`))).diagnostics;
      expect(found.some((d) => d.severity === "error" && d.code === "POLICY_FORBIDDEN_ATTRIBUTE"), name).toBe(true);
    }
  });
});
