// Tes langkah 2 bagian 1, pemindaian kebijakan AST aturan inti (tugas 4.2; Requirement 7.3 sampai 7.6,
// 7.12, 7.15 sampai 7.17, 7.20, 1.6, 1.10, 1.18, 7.14; design 5.5).
// Setiap aturan punya kasus tolak dan kasus lolos. Tes hanya menegaskan keenam kode inti
// (`CORE_CODES`), supaya aturan bagian 2 (tugas 4.3: meta, ekspor, warna, dan seterusnya) yang
// berjalan di langkah yang sama tidak mengubah hasil tes ini. Snippet sengaja kecil dan tidak
// memuat `meta` atau ekspor; yang diuji hanya aturan inti.
import { readdirSync, readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/clock.js";
import { loadContract, type Contract } from "../src/contract.js";
import { createVirtualProgram, virtualPath } from "../src/host/ts-host.js";
import { foldString } from "../src/policy/fold.js";
import { DEFAULT_STEPS } from "../src/steps/registry.js";
import { policyStep } from "../src/steps/policy.js";
import { sizeStep } from "../src/steps/size.js";
import { createStepContext, indexSteps } from "../src/steps/step.js";
import type { Diagnostic, Kind } from "../src/types.js";
import { safeVerify } from "../src/verify.js";

// ---- kontrak dan penjalan ----

const CONTRACT_URL = new URL("../contract/animation-contract.json", import.meta.url);
const loaded = loadContract(JSON.parse(readFileSync(CONTRACT_URL, "utf8")));
if (!loaded.ok) throw new Error(`kontrak sumber tidak sah: ${loaded.reason}`);
const contract: Contract = loaded.contract;

/** Keenam kode yang dimiliki tugas 4.2. */
const CORE_CODES: ReadonlySet<string> = new Set([
  "POLICY_JSX_SYNTAX",
  "POLICY_IMPORT_DISALLOWED",
  "POLICY_DYNAMIC_IMPORT",
  "POLICY_FORBIDDEN_IDENTIFIER",
  "POLICY_FORBIDDEN_MEMBER",
  "POLICY_FORBIDDEN_PROPERTY",
]);

async function scan(source: string, kind: Kind = "lesson"): Promise<Diagnostic[]> {
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
  return [...(await policyStep.run(context)).diagnostics];
}

/** Hanya Diagnostic inti, dalam urutan temuan. */
async function core(source: string): Promise<Diagnostic[]> {
  return (await scan(source)).filter((diagnostic) => CORE_CODES.has(diagnostic.code));
}

async function coreCodes(source: string): Promise<string[]> {
  return (await core(source)).map((diagnostic) => diagnostic.code);
}

/** Menegaskan bahwa setiap sumber melapor tepat `code` sebanyak `count` dan tidak ada kode inti lain. */
async function expectOnly(source: string, code: string, count = 1): Promise<void> {
  expect(await coreCodes(source)).toEqual(Array<string>(count).fill(code));
}

async function expectClean(source: string): Promise<void> {
  expect(await coreCodes(source)).toEqual([]);
}

const lines = (...parts: string[]): string => parts.join("\n");

// ---- POLICY_JSX_SYNTAX ----

describe("POLICY_JSX_SYNTAX", () => {
  it("elemen JSX, self-closing, dan fragmen dilaporkan", async () => {
    await expectOnly("const a = <div>hi</div>;", "POLICY_JSX_SYNTAX");
    await expectOnly("const a = <div />;", "POLICY_JSX_SYNTAX");
    await expectOnly("const a = <></>;", "POLICY_JSX_SYNTAX");
    await expectOnly("const a = <>text</>;", "POLICY_JSX_SYNTAX");
  });

  it("setiap node JSX bersarang dilaporkan sendiri (Requirement 7.3)", async () => {
    await expectOnly("const a = <ul><li>a</li><li>b</li></ul>;", "POLICY_JSX_SYNTAX", 3);
    await expectOnly("const a = <><div /></>;", "POLICY_JSX_SYNTAX", 2);
  });

  it("createElement dan operator perbandingan tidak dianggap JSX", async () => {
    await expectClean(
      lines(
        'import { createElement } from "react";',
        'const a = createElement("div", null, "hi");',
        "const b = 1 < 2 && 3 > 2;",
      ),
    );
  });
});

// ---- POLICY_IMPORT_DISALLOWED ----

describe("POLICY_IMPORT_DISALLOWED", () => {
  const rejected: ReadonlyArray<readonly [string, string]> = [
    ["modul lain", 'import { gsap } from "gsap";'],
    ["modul relatif", 'import { x } from "./other";'],
    ["nama di luar daftar react", 'import { useState } from "react";'],
    ["nama di luar daftar remotion", 'import { Img } from "remotion";'],
    ["tipe di luar daftar", 'import type { FC } from "react";'],
    ["impor namespace", 'import * as R from "react";'],
    ["impor default", 'import React from "react";'],
    ["impor default bertipe", 'import type React from "react";'],
    ["impor side-effect", 'import "react";'],
    ["impor `default` bernama", 'import { default as r } from "react";'],
    ["re-ekspor bernama", 'export { createElement } from "react";'],
    ["re-ekspor semua", 'export * from "remotion";'],
    ["re-ekspor namespace", 'export * as r from "remotion";'],
    ["nama modul kunci prototipe", 'import { x } from "constructor";'],
    ["nama modul __proto__", 'import { x } from "__proto__";'],
    ["nama modul toString", 'import { x } from "toString";'],
  ];

  it.each(rejected)("%s dilaporkan", async (_name, source) => {
    await expectOnly(source, "POLICY_IMPORT_DISALLOWED");
  });

  it("satu temuan per nama yang salah, nama sah di impor yang sama tidak ikut dilaporkan", async () => {
    const found = await core('import { createElement, useState, useEffect } from "react";');
    expect(found.map((d) => d.message)).toEqual([
      "import of useState from react is not allowed",
      "import of useEffect from react is not allowed",
    ]);
  });

  it("memeriksa nama yang diimpor, bukan nama lokal hasil alias", async () => {
    await expectClean('import { createElement as useState } from "react";');
    await expectOnly('import { useState as createElement } from "react";', "POLICY_IMPORT_DISALLOWED");
  });

  it("pesan memuat nama dan modul", async () => {
    const [first] = await core('import { gsap } from "gsap";');
    expect(first?.message).toBe("import of gsap from gsap is not allowed");
    const [star] = await core('import * as R from "react";');
    expect(star?.message).toBe("import of * as R from react is not allowed");
  });

  it("semua nama pada daftar kontrak lolos, termasuk tipe dan alias", async () => {
    const reactValues = contract.allowed_imports["react"]?.values.join(", ") ?? "";
    const reactTypes = contract.allowed_imports["react"]?.types.join(", ") ?? "";
    const remotion = contract.allowed_imports["remotion"]?.values.join(", ") ?? "";
    await expectClean(
      lines(
        `import { ${reactValues} } from "react";`,
        `import type { ${reactTypes} } from "react";`,
        `import { ${remotion} } from "remotion";`,
        'import { createElement as h, type ReactElement } from "react";',
        'import { interpolate as lerp } from "remotion";',
      ),
    );
  });
});

// ---- POLICY_DYNAMIC_IMPORT ----

describe("POLICY_DYNAMIC_IMPORT", () => {
  it("import() dilaporkan sebagai impor dinamis saja", async () => {
    await expectOnly('const m = import("x");', "POLICY_DYNAMIC_IMPORT");
    await expectOnly('const m = import("react");', "POLICY_DYNAMIC_IMPORT");
    await expectOnly("async function f() { return (await import(`./${1}`)).default; }", "POLICY_DYNAMIC_IMPORT");
  });

  it("pemanggilan require() dilaporkan hanya sebagai impor dinamis, bukan identifier (Requirement 7.20)", async () => {
    await expectOnly('const fs = require("fs");', "POLICY_DYNAMIC_IMPORT");
    await expectOnly('const fs = (require)("fs");', "POLICY_DYNAMIC_IMPORT");
    await expectOnly('const fs = require!("fs");', "POLICY_DYNAMIC_IMPORT");
    await expectOnly('const fs = (require as any)("fs");', "POLICY_DYNAMIC_IMPORT");
    await expectOnly('const fs = require?.("fs");', "POLICY_DYNAMIC_IMPORT");
  });

  it("import x = require() dilaporkan hanya sebagai impor dinamis (Requirement 7.20)", async () => {
    await expectOnly('import fs = require("fs");', "POLICY_DYNAMIC_IMPORT");
  });

  it("require yang tidak dipanggil dilaporkan sebagai identifier terlarang", async () => {
    await expectOnly("const r = require;", "POLICY_FORBIDDEN_IDENTIFIER");
    await expectOnly('const p = require.resolve("x");', "POLICY_FORBIDDEN_IDENTIFIER");
    await expectOnly('const p = typeof require === "function";', "POLICY_FORBIDDEN_IDENTIFIER");
    await expectOnly('const x = new require("x");', "POLICY_FORBIDDEN_IDENTIFIER");
  });

  it("require deklarasi ambient tetap global", async () => {
    await expectOnly('declare const require: any; const m = require("x");', "POLICY_DYNAMIC_IMPORT");
    await expectOnly('declare function require(id: string): unknown; require("x");', "POLICY_DYNAMIC_IMPORT");
  });

  it("require lokal bukan impor dinamis", async () => {
    await expectClean('function require(id: string) { return id; } const m = require("x");');
    await expectClean('const f = (require: (id: string) => string) => require("x");');
  });

  it("teks 'import' dan 'require' sebagai string, komentar, atau nama properti lolos", async () => {
    await expectClean(
      lines(
        '// import("x") and require("y") appear only in this comment',
        'const a = "import(\\"x\\") require(\\"y\\")";',
        "const o = { require: 1, import: 2 };",
        "const b = o.require + o.import;",
      ),
    );
  });
});

// ---- POLICY_FORBIDDEN_IDENTIFIER ----

describe("POLICY_FORBIDDEN_IDENTIFIER", () => {
  const rejected: ReadonlyArray<readonly [string, string]> = [
    ["window", "window.alert(1);"],
    ["document", "const d = document.body;"],
    ["new Date", "const d = new Date();"],
    ["Date.now", "const d = Date.now();"],
    ["setTimeout", "setTimeout(() => 1, 5);"],
    ["setInterval", "setInterval(() => 1, 5);"],
    ["requestAnimationFrame", "requestAnimationFrame(() => 1);"],
    ["fetch", 'fetch("x");'],
    ["eval", 'eval("1");'],
    ["Function", 'const f = new Function("return 1");'],
    ["globalThis", "const g = globalThis;"],
    ["self", "const s = self;"],
    ["parent", "const p = parent;"],
    ["top", "const t = top;"],
    ["process", "const e = process.env;"],
    ["Buffer", "const b = Buffer.from([]);"],
    ["performance", "const t = performance.now();"],
    ["crypto", "const c = crypto.getRandomValues;"],
    ["localStorage", 'localStorage.setItem("a", "b");'],
    ["navigator", "const n = navigator.userAgent;"],
    ["XMLHttpRequest", "const x = new XMLHttpRequest();"],
    ["WebSocket", 'const w = new WebSocket("x");'],
    ["Worker", 'const w = new Worker("x");'],
    ["Image", "const i = new Image();"],
    ["Audio", "const a = new Audio();"],
    ["typeof", 'const u = typeof document === "undefined";'],
    ["argumen pemanggilan", "f(window);"],
    ["dalam template", "const s = `${window}`;"],
    ["kunci terhitung", "const o = { [top]: 1 };"],
    ["shorthand membaca variabel global", "const w = { fetch };"],
    ["ekspresi extends kelas", "class A extends Worker {}"],
    ["di dalam fungsi", "function f() { return window; }"],
    ["pembungkus tipe", "const w = window as unknown;"],
    ["ekspor default", "export default window;"],
  ];

  it.each(rejected)("%s dilaporkan", async (_name, source) => {
    await expectOnly(source, "POLICY_FORBIDDEN_IDENTIFIER");
  });

  it("pesan memuat nama identifier", async () => {
    const [first] = await core("window.alert(1);");
    expect(first?.message).toBe("identifier window is not allowed");
  });

  it("setiap pemakaian dilaporkan sendiri", async () => {
    await expectOnly("window.a(); window.b(); document.c();", "POLICY_FORBIDDEN_IDENTIFIER", 3);
  });

  const accepted: ReadonlyArray<readonly [string, string]> = [
    ["kunci object literal (Requirement 7.5)", "const o = { top: 10, window: 1, Date: 2 };"],
    ["membaca kunci object literal", "const o = { top: 10 }; const v = o.top + o.window;"],
    ["variabel lokal bernama sama (Requirement 7.5)", "const top = 1; const v = top + 1;"],
    ["let lokal", "let self = 2; self += 1;"],
    ["parameter fungsi", "function f(window: number) { return window + 1; }"],
    ["parameter panah", "const f = (document: string) => document;"],
    ["fungsi lokal", "function fetch(u: string) { return u; } fetch('x');"],
    ["kelas lokal", "class Image {} const i = new Image();"],
    ["enum lokal", "enum Audio { A } const a = Audio.A;"],
    ["destructuring lokal", "const { window, document } = { window: 1, document: 2 }; const n = window + document;"],
    ["shorthand dari variabel lokal", "const fetch = 1; const o = { fetch };"],
    ["nama properti pada akses anggota", "const o = { document: 1 }; const v = o.document;"],
    ["akses anggota berantai", "const o = { a: { window: 1 } }; const v = o.a.window;"],
    ["nama method", "const o = { fetch() { return 1; }, get top() { return 2; } };"],
    ["method kelas dan properti kelas", "class A { fetch() { return 1; } top = 2; static Date = 3; }"],
    ["label", "top: for (;;) { break top; }"],
    ["posisi tipe", "type W = typeof window; let w: W | undefined;"],
    ["anotasi tipe dengan nama global", "let d: Date | undefined; let i: Image | null = null;"],
    ["deklarasi tipe bernama sama dipakai sebagai tipe", "interface Date { x: number } let d: Date | undefined;"],
    ["as typeof", "const v = 1 as unknown as typeof globalThis;"],
    ["nama anggota enum", "enum E { window, top }"],
    ["argumen bernama pada impor sah", 'import { createElement as top } from "react"; const a = top("div", null);'],
    ["string dan komentar", 'const s = "window document Date"; // fetch eval'],
    ["JSON-like", 'const o = { "setTimeout": 1 }; const v = o["setTimeout"];'],
  ];

  it.each(accepted)("%s tidak dilaporkan", async (_name, source) => {
    await expectClean(source);
  });

  it("deklarasi `declare` tidak membuat nama menjadi lokal (Requirement 7.15)", async () => {
    await expectOnly("declare const window: any; window.alert(1);", "POLICY_FORBIDDEN_IDENTIFIER");
    await expectOnly("declare var document: any; const d = document;", "POLICY_FORBIDDEN_IDENTIFIER");
    await expectOnly("declare function fetch(u: string): void; fetch('x');", "POLICY_FORBIDDEN_IDENTIFIER");
    await expectOnly("declare class Worker {} const w = new Worker();", "POLICY_FORBIDDEN_IDENTIFIER");
    await expectOnly("declare global { const document: any } const d = document;", "POLICY_FORBIDDEN_IDENTIFIER");
    await expectOnly("declare namespace NS { const top: number } const t = top;", "POLICY_FORBIDDEN_IDENTIFIER");
  });

  it("deklarasi tipe tidak membuat nama menjadi lokal (Requirement 7.15)", async () => {
    await expectOnly("type Date = string; const d = new Date();", "POLICY_FORBIDDEN_IDENTIFIER");
    await expectOnly("interface Image { x: number } const i = new Image();", "POLICY_FORBIDDEN_IDENTIFIER");
    // `window` tidak ada di daftar impor react, jadi impornya juga dilaporkan; pemakaiannya tetap global.
    expect(await coreCodes('import type { window } from "react"; window.alert(1);')).toEqual([
      "POLICY_IMPORT_DISALLOWED",
      "POLICY_FORBIDDEN_IDENTIFIER",
    ]);
  });

  it("nama yang dideklarasikan ambient tetapi tidak dipakai tidak dilaporkan", async () => {
    await expectClean("declare const window: any;");
  });

  it("deklarasi lokal di lingkup dalam tidak menutupi pemakaian global di lingkup luar", async () => {
    await expectOnly(
      lines("function f() { const top = 1; return top; }", "const g = top;"),
      "POLICY_FORBIDDEN_IDENTIFIER",
    );
  });
});

// ---- POLICY_FORBIDDEN_MEMBER ----

describe("POLICY_FORBIDDEN_MEMBER", () => {
  const rejected: ReadonlyArray<readonly [string, string]> = [
    ["Math.random", "const r = Math.random();"],
    ["Math.random tanpa panggilan", "const f = Math.random;"],
    ["Math['random'] (Requirement 7.17)", "const r = Math['random']();"],
    ["Math[\"random\"]", 'const r = Math["random"]();'],
    ["kunci hasil penjumlahan", 'const r = Math["ran" + "dom"]();'],
    ["kunci template literal", "const r = Math[`random`]();"],
    ["kunci dari const", 'const k = "random"; const r = Math[k]();'],
    ["kunci dari const bertingkat", 'const a = "ran"; const b = a + "dom"; const r = Math[b]();'],
    ["Math dalam kurung", "const r = (Math).random();"],
    ["Math dengan as", "const r = (Math as any).random();"],
    ["alias const (Requirement 7.17)", "const M = Math; const r = M.random();"],
    ["alias dalam kurung", "const M = (Math); const r = M.random();"],
    ["alias dengan as", "const M = Math as any; const r = M.random();"],
    ["alias berantai", "const A = Math; const B = A; const C = B; const r = C.random();"],
    ["alias dengan kunci elemen", "const M = Math; const r = M['random']();"],
    ["alias dideklarasikan setelah dipakai", "function f() { return M.random(); } const M = Math;"],
    ["alias let", "let M = Math; const r = M.random();"],
    ["alias lewat penugasan", "let M: any; M = Math; const r = M.random();"],
    ["alias sebagai parameter bawaan", "function f(M = Math) { return M.random(); }"],
    ["destructuring (Requirement 7.17)", "const { random } = Math;"],
    ["destructuring dengan nama baru", "const { random: r } = Math;"],
    ["destructuring kunci terhitung", 'const { ["random"]: r } = Math;'],
    ["destructuring dari alias", "const M = Math; const { random } = M;"],
    ["destructuring beberapa nama", "const { floor, random } = Math;"],
    ["destructuring penugasan", "let random: any; ({ random } = Math);"],
    ["destructuring penugasan dengan kunci", "let r: any; ({ random: r } = Math);"],
    ["destructuring parameter bawaan", "function f({ random } = Math) { return random(); }"],
    ["random(null) dari remotion (Requirement 1.18)", 'import { random } from "remotion"; random(null);'],
    ["random(null) beralias", 'import { random as r } from "remotion"; r(null);'],
    ["random((null))", 'import { random } from "remotion"; random((null));'],
    ["random(null as ...)", 'import { random } from "remotion"; random(null as unknown as number);'],
    ["random(null, ...)", 'import { random } from "remotion"; random(null, 1);'],
  ];

  it.each(rejected)("%s dilaporkan", async (_name, source) => {
    await expectOnly(source, "POLICY_FORBIDDEN_MEMBER");
  });

  it("pesan mengikuti tabel 5.12", async () => {
    const [direct] = await core("const r = Math.random();");
    expect(direct?.message).toBe("Math.random is not allowed, use random(seed) from remotion");
    const [seedless] = await core('import { random } from "remotion"; random(null);');
    expect(seedless?.message).toBe("random(null) is not allowed, use random(seed) from remotion");
  });

  it("destructuring dua properti terlarang dilaporkan per elemen", async () => {
    // Hanya `random` terlarang pada kontrak; `floor` tidak ikut.
    const found = await core("const { floor, random } = Math;");
    expect(found).toHaveLength(1);
    expect(found[0]?.column).toBe(16);
  });

  const accepted: ReadonlyArray<readonly [string, string]> = [
    ["anggota Math lain", "const v = Math.floor(1.5) + Math.PI + Math.max(1, 2) + Math['abs'](-1);"],
    ["alias Math dengan anggota lain", "const M = Math; const v = M.floor(1.5) + M.sin(1);"],
    ["destructuring anggota lain", "const { floor, sin } = Math;"],
    ["anggota bernama random pada objek lain", "const o = { random: () => 1 }; const v = o.random();"],
    ["x.random() umum", "declare const x: { random(): number }; const v = x.random();"],
    ["random dengan seed teks", 'import { random } from "remotion"; const v = random("seed");'],
    ["random dengan seed angka", 'import { random } from "remotion"; const v = random(42);'],
    ["random dengan seed dari frame", 'import { random, useCurrentFrame } from "remotion"; const v = random(useCurrentFrame());'],
    ["random sebagai nilai tanpa panggilan", 'import { random } from "remotion"; const f = random;'],
    ["Math lokal menutupi global", "const Math = { random: () => 1 }; const v = Math.random();"],
    ["parameter bernama Math", "function f(Math: { random(): number }) { return Math.random(); }"],
    ["alias dari Math lokal", "const Math = { random: () => 1 }; const M = Math; const v = M.random();"],
    ["random lokal dipanggil dengan null", "function random(x: null) { return x; } random(null);"],
    ["random dari modul lain dengan null (impor sudah ditolak oleh aturan impor)", "const random = (x: null) => x; random(null);"],
    ["Math[kunci dinamis]", "declare const k: string; const v = Math[k];"],
  ];

  it.each(accepted)("%s tidak dilaporkan", async (_name, source) => {
    await expectClean(source);
  });
});

// ---- POLICY_FORBIDDEN_PROPERTY ----

describe("POLICY_FORBIDDEN_PROPERTY", () => {
  const rejected: ReadonlyArray<readonly [string, string]> = [
    ["x.constructor", "declare const x: any; const c = x.constructor;"],
    ["x.__proto__", "declare const x: any; const c = x.__proto__;"],
    ["x.prototype", "declare const x: any; const c = x.prototype;"],
    ["x['constructor']", 'declare const x: any; const c = x["constructor"];'],
    ["x[`__proto__`]", "declare const x: any; const c = x[`__proto__`];"],
    ["kunci hasil penjumlahan (Requirement 7.16)", 'declare const x: any; const c = x["con" + "structor"];'],
    ["kunci tiga potong", 'declare const x: any; const c = x["con" + "str" + "uctor"];'],
    ["kunci dalam kurung", 'declare const x: any; const c = x[("proto" + "type")];'],
    ["kunci dari const", 'declare const x: any; const k = "constructor"; const c = x[k];'],
    ["kunci dari const yang disusun", 'declare const x: any; const a = "__pro"; const b = "to__"; const c = x[a + b];'],
    ["kunci dengan as const", 'declare const x: any; const k = "constructor" as const; const c = x[k];'],
    ["kunci template dengan substitusi terlipat", 'declare const x: any; const p = "proto"; const c = x[`${p}type`];'],
    ["optional chaining", "declare const x: any; const c = x?.constructor;"],
    ["optional chaining elemen", 'declare const x: any; const c = x?.["constructor"];'],
    ["this.constructor", "class A { m() { return this.constructor; } }"],
    ["destructuring", "declare const x: any; const { constructor } = x;"],
    ["destructuring kunci terhitung", 'declare const x: any; const { ["__proto__"]: p } = x;'],
    ["destructuring dengan nama baru", "declare const x: any; const { prototype: p } = x;"],
    ["destructuring parameter", "function f({ constructor }: { constructor: unknown }) { return constructor; }"],
    ["destructuring penugasan", "declare const x: any; let c: any; ({ constructor: c } = x);"],
  ];

  it.each(rejected)("%s dilaporkan", async (_name, source) => {
    await expectOnly(source, "POLICY_FORBIDDEN_PROPERTY");
  });

  it("rantai akses menghasilkan satu temuan per akses, pada nama masing-masing", async () => {
    const found = await core('const f = [].constructor.constructor("x");');
    expect(found.map((d) => d.code)).toEqual(["POLICY_FORBIDDEN_PROPERTY", "POLICY_FORBIDDEN_PROPERTY"]);
    expect(found.map((d) => d.column).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([14, 26]);
    await expectOnly('declare const x: any; const f = x["constructor"]["constructor"];', "POLICY_FORBIDDEN_PROPERTY", 2);
  });

  it("pesan memuat nama properti", async () => {
    const [first] = await core('declare const x: any; const c = x["con" + "structor"];');
    expect(first?.message).toBe("property constructor is not allowed");
  });

  const accepted: ReadonlyArray<readonly [string, string]> = [
    ["definisi constructor kelas", "class A { constructor() {} }"],
    ["kelas turunan memanggil super", "class A {} class B extends A { constructor() { super(); } }"],
    ["kunci object literal", "const o = { constructor: 1, __proto__: null, prototype: 2 };"],
    ["method object literal", "const o = { constructor() { return 1; } };"],
    ["properti kelas bernama prototype statis", "class A { static prototype2 = 1; }"],
    ["nama mirip", "declare const x: any; const c = x.constructors + x.proto + x.constructorName;"],
    ["kunci pendek", 'declare const x: any; const c = x["con"] + x["constr"];'],
    ["kunci dinamis", "declare const x: any; declare const i: number; const c = x[i] + x[i + 1];"],
    ["kunci string sah lain", 'declare const x: any; const c = x["a" + "b"] + x["key-1"];'],
    ["indeks angka", "declare const x: any[]; const c = x[0];"],
    ["const non-string", "declare const x: any; const k = 1; const c = x[k];"],
    ["let tidak dilipat", 'declare const x: any; let k = "constructor"; const c = x[k];'],
    ["destructuring biasa", "declare const x: any; const { a, b: c } = x;"],
    ["object literal bukan target penugasan", "const o = { constructor: 1 }; const p = { prototype: 2 };"],
    ["rest destructuring", "declare const x: any; const { ...rest } = x;"],
    ["komentar dan string", 'const s = "x.constructor"; // x.prototype'],
  ];

  it.each(accepted)("%s tidak dilaporkan", async (_name, source) => {
    await expectClean(source);
  });
});

// ---- foldString ----

describe("foldString (Requirement 7.16)", () => {
  function foldFirstInitializer(source: string, maxDepth: number): string | undefined {
    const built = createVirtualProgram({
      path: virtualPath("main.ts"),
      text: source,
      scriptKind: ts.ScriptKind.TSX,
    });
    if (!built.ok) throw new Error(built.reason);
    // Yang dilipat adalah initializer variabel bernama `v`; deklarasi lain hanya pendukung.
    const declaration = built.sourceFile.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) => [...statement.declarationList.declarations])
      .find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === "v");
    const initializer = declaration?.initializer;
    if (initializer === undefined) throw new Error("no `v` initializer in test source");
    return foldString(initializer, {
      checker: built.checker,
      sourceFile: built.sourceFile,
      maxDepth,
    });
  }

  /** Rantai kiri `"a" + "a" + ...` dengan `terms` suku. */
  const chain = (terms: number): string =>
    `const v = ${Array.from({ length: terms }, () => '"a"').join(" + ")};`;

  it("melipat literal, penjumlahan, template, kurung, dan const", () => {
    expect(foldFirstInitializer('const v = "abc";', 8)).toBe("abc");
    expect(foldFirstInitializer('const v = "a" + "b";', 8)).toBe("ab");
    expect(foldFirstInitializer("const v = `abc`;", 8)).toBe("abc");
    expect(foldFirstInitializer('const v = ("a" + ("b"));', 8)).toBe("ab");
    expect(foldFirstInitializer('const k = "x"; const v = k + "y";', 8)).toBe("xy");
  });

  it("kedalaman 0 adalah akar: rantai 9 suku terlipat, 10 suku tidak (fold_depth 8)", () => {
    expect(contract.limits.fold_depth).toBe(8);
    expect(foldFirstInitializer(chain(9), contract.limits.fold_depth)).toBe("a".repeat(9));
    expect(foldFirstInitializer(chain(10), contract.limits.fold_depth)).toBeUndefined();
  });

  it("kedalaman dibaca dari argumen, bukan literal", () => {
    expect(foldFirstInitializer(chain(10), 9)).toBe("a".repeat(10));
    expect(foldFirstInitializer(chain(2), 0)).toBeUndefined();
    expect(foldFirstInitializer('const v = "a";', 0)).toBe("a");
  });

  it("const yang saling merujuk berhenti di batas kedalaman dan tidak menggantung", () => {
    const cyclic = lines("const v = a;", "const a = b;", "const b = a;");
    expect(foldFirstInitializer(cyclic, 8)).toBeUndefined();
  });

  it("tidak melipat nilai dinamis", () => {
    expect(foldFirstInitializer("declare const d: string; const v = d;", 8)).toBeUndefined();
    expect(foldFirstInitializer('declare const d: string; const v = "a" + d;', 8)).toBeUndefined();
    expect(foldFirstInitializer('let k = "a"; const v = k;', 8)).toBeUndefined();
    expect(foldFirstInitializer("const v = 1 + 2;", 8)).toBeUndefined();
    expect(foldFirstInitializer('const v = "a" - "b";', 8)).toBeUndefined();
    expect(foldFirstInitializer("const v = `${Math.PI}x`;", 8)).toBeUndefined();
  });
});

// ---- satu lintasan, posisi ----

describe("satu lintasan dan posisi (Requirement 7.12)", () => {
  it("mengumpulkan semua temuan, masing-masing dengan baris dan kolom basis 1", async () => {
    const source = lines(
      'import { gsap } from "gsap";', // 1
      "const a = <div />;", // 2
      "const b = window.alert(1);", // 3
      "const c = Math.random();", // 4
      'declare const x: any; const d = x["constructor"];', // 5
      'const e = require("fs");', // 6
    );
    const found = await core(source);
    expect(found.map((d) => [d.code, d.line, d.column])).toEqual([
      ["POLICY_IMPORT_DISALLOWED", 1, 10],
      ["POLICY_JSX_SYNTAX", 2, 11],
      ["POLICY_FORBIDDEN_IDENTIFIER", 3, 11],
      ["POLICY_FORBIDDEN_MEMBER", 4, 11],
      ["POLICY_FORBIDDEN_PROPERTY", 5, 35],
      ["POLICY_DYNAMIC_IMPORT", 6, 11],
    ]);
    expect(found.every((d) => d.tool === "policy" && d.severity === "error")).toBe(true);
  });

  it("kolom menghitung indentasi dan baris menghitung komentar", async () => {
    const found = await core(lines("// satu", "/* dua", "tiga */", "  setTimeout(f, 1);"));
    expect(found.map((d) => [d.line, d.column])).toEqual([[4, 3]]);
  });

  it("pesan tidak lebih dari batas kontrak walau nama sangat panjang", async () => {
    const longName = "n".repeat(500);
    const found = await core(`import { ${longName} } from "react";`);
    expect(found).toHaveLength(1);
    expect(found[0]?.message.length).toBe(contract.limits.diagnostic_message_max_chars);
  });

  it("temuan identik pada posisi yang sama tidak digandakan", async () => {
    // `Math.random` dalam rantai alias dipanggil sekali per node, tetapi aturan tidak boleh melapor ganda.
    const found = await core("const M = Math; const r = M.random() + M.random();");
    expect(found).toHaveLength(2);
    expect(new Set(found.map((d) => d.column)).size).toBe(2);
  });
});

// ---- ketahanan ----

describe("sumber rusak atau ganjil tidak melempar", () => {
  const odd: readonly string[] = [
    "",
    "   ",
    "// hanya komentar",
    "const = ;",
    "function (",
    "import { from",
    "export default",
    "class { }",
    "{{{{{{{{",
    "}}}}}}}}",
    "const a = <div>",
    "const a = </div>;",
    "x = `${",
    'import "',
    "import(",
    "require(",
    "a.constructor.constructor.constructor",
    "const { = Math;",
    "const [a, b] = Math;",
    "label: label: window",
    "@dec class A {}",
    "\u0000",
    "const \u{1F600} = 1;",
    "declare module 'x' { const window: number }",
    "namespace window { export const a = 1 } const v = window.a;",
    "enum Date { A } const v = Date.A;",
  ];

  it.each(odd.map((source, index) => [index, source] as const))(
    "sumber ganjil #%i menghasilkan hasil, bukan exception",
    async (_index, source) => {
      const result = await scan(source);
      expect(Array.isArray(result)).toBe(true);
      for (const diagnostic of result) {
        expect(diagnostic.tool).toBe("policy");
        expect(diagnostic.code).toMatch(contract.diagnosticCodeRegex);
      }
    },
  );

  it("ekspresi biner sangat dalam tidak melampaui tumpukan", async () => {
    const source = `const v = ${Array.from({ length: 6000 }, () => "1").join(" + ")}; const w = window;`;
    const found = await core(source);
    expect(found.map((d) => d.code)).toEqual(["POLICY_FORBIDDEN_IDENTIFIER"]);
  });
});

// ---- korpus ----

const GOOD_DIR = new URL("../fixtures/good/", import.meta.url);
const BAD_DIR = new URL("../fixtures/bad/", import.meta.url);

describe("korpus fixtures/good: nol Diagnostic dari aturan inti (Requirement 7.14)", () => {
  const goodSources = readdirSync(GOOD_DIR).filter((name) => name.endsWith(".ts")).sort();

  it("korpus tidak kosong", () => {
    expect(goodSources.length).toBeGreaterThanOrEqual(8);
  });

  it.each(goodSources)("%s", async (name) => {
    const source = readFileSync(new URL(name, GOOD_DIR), "utf8");
    expect(await core(source)).toEqual([]);
  });

  it("Series.Sequence pada impor Series yang diizinkan diterima (temuan dari 3.4)", async () => {
    await expectClean(
      lines(
        'import { createElement } from "react";',
        'import { Series } from "remotion";',
        "const x = createElement(Series.Sequence, { durationInFrames: 30 });",
      ),
    );
  });
});

describe("korpus fixtures/bad: kode inti pada expected.json", () => {
  const expected = JSON.parse(readFileSync(new URL("expected.json", BAD_DIR), "utf8")) as Record<
    string,
    string[]
  >;
  // Hanya berkas yang seluruh kode harapannya milik aturan inti; berkas lain milik tugas lain.
  const ownEntries = Object.entries(expected).filter(([, codes]) =>
    codes.every((code) => CORE_CODES.has(code)),
  );

  it("memuat satu berkas untuk setiap kode inti", () => {
    const covered = new Set(ownEntries.flatMap(([, codes]) => codes));
    expect([...CORE_CODES].filter((code) => !covered.has(code))).toEqual([]);
  });

  it.each(ownEntries)("%s melaporkan kode yang diharapkan", async (name, codes) => {
    const source = readFileSync(new URL(name, BAD_DIR), "utf8");
    const reported = new Set((await scan(source)).map((diagnostic) => diagnostic.code));
    for (const code of codes) expect(reported.has(code)).toBe(true);
    // Fixture hanya melanggar satu aturan inti.
    expect([...reported].filter((code) => CORE_CODES.has(code))).toEqual(codes);
  });
});

// ---- pendaftaran dan alur pipeline ----

describe("registri produksi memuat langkah 2", () => {
  it("DEFAULT_STEPS memuat policyStep sebagai langkah bernomor 2, dan registri tetap valid", () => {
    expect(DEFAULT_STEPS.find((step) => step.number === 2)).toBe(policyStep);
    expect(indexSteps(DEFAULT_STEPS).ok).toBe(true);
  });

  it("lewat verify(): temuan kebijakan menjadi Diagnostic tool=policy dan langkah tercatat di checks", async () => {
    const result = await safeVerify(
      {
        source: "const t = window.location;",
        kind: "lesson",
        required_tokens: [],
        forbidden_tokens: [],
        contract_version: contract.contract_version,
      },
      { clock: new FakeClock(), contract, steps: [sizeStep, policyStep] },
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => [d.tool, d.code])).toContainEqual([
      "policy",
      "POLICY_FORBIDDEN_IDENTIFIER",
    ]);
    expect(result.summary.checks.map(({ name, ok }) => ({ name, ok }))).toEqual([
      { name: "size", ok: true },
      { name: "policy", ok: false },
    ]);
  });

  it("sumber berukuran berlebih berhenti di langkah 1 dan tidak sampai ke pemindaian", async () => {
    const result = await safeVerify(
      {
        source: `${"a".repeat(contract.limits.source_max_bytes + 1)} window`,
        kind: "lesson",
        required_tokens: [],
        forbidden_tokens: [],
        contract_version: contract.contract_version,
      },
      { clock: new FakeClock(), contract, steps: [sizeStep, policyStep] },
    );
    expect(result.diagnostics.map((d) => d.code)).toEqual(["SIZE_SOURCE_TOO_LARGE"]);
    expect(result.summary.checks.map((check) => check.name)).toEqual(["size"]);
  });
});
