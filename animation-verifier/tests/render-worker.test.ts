// Tes inti Worker langkah 6 dan shim `require` (tugas 6.1; Requirement 9.1, 9.3, 9.4, 9.11,
// 11.1, 11.2, 11.8, 11.11, 11.12; design 5.9, 5.11, D-14).
// Fungsi inti dipanggil langsung di proses tes (tanpa spawn Worker; spawn nyata diuji di 6.3).
// Bundle fixture dibuat dengan esbuild persis seperti langkah 5 (`cjs`, `react` dan `remotion`
// eksternal). Tes korpus mengunci catatan 3.4: pembungkus `Thumbnail` memberi `opacity: 0` di jsdom,
// dan semua fixture bagus tetap harus menghasilkan Required_Token dari teks frame.
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadContract, type Contract } from "../src/contract.js";
import { createRequireShim } from "../src/shim.js";
import {
  extractFrameText,
  runRenderJob,
  type ProgressMessage,
  type ResultMessage,
  type RunMessage,
} from "../src/steps/render-core.js";
import type { MainMeta } from "../src/types.js";

vi.setConfig({ testTimeout: 60_000 });

const PKG_ROOT = new URL("../", import.meta.url).pathname;
const GOOD_DIR = new URL("../fixtures/good/", import.meta.url);

const loaded = loadContract(
  JSON.parse(readFileSync(new URL("../contract/animation-contract.json", import.meta.url), "utf8")),
);
if (!loaded.ok) throw new Error(`contract does not load: ${loaded.reason}`);
const contract: Contract = loaded.contract;

const STATIC_META: MainMeta = { width: 1280, height: 720, fps: 30, durationInFrames: 30 };
const META_LITERAL = "{ width: 1280, height: 720, fps: 30, durationInFrames: 30 }";

// ---- bantuan ----

/** Bundle CJS tulisan tangan; `body` adalah isi `Main`, `top` dijalankan saat evaluasi. */
function handBundle(body: string, options: { top?: string; meta?: string; defaultExport?: string } = {}): string {
  return [
    '"use strict";',
    'const React = require("react"); const R = require("remotion"); const h = React.createElement;',
    options.top ?? "",
    `module.exports = { meta: ${options.meta ?? META_LITERAL}, default: ${options.defaultExport ?? `function Main() { ${body} }`} };`,
  ].join("\n");
}

/** Bundle TypeScript dengan esbuild, sama seperti langkah 5 (design 5.8). */
async function esbuildBundle(source: string): Promise<string> {
  const out = await build({
    stdin: { contents: source, loader: "ts", sourcefile: "main.ts", resolveDir: PKG_ROOT },
    bundle: true,
    format: "cjs",
    platform: "browser",
    target: "es2022",
    external: ["react", "remotion"],
    write: false,
    logLevel: "silent",
    legalComments: "none",
    charset: "utf8",
    absWorkingDir: "/",
  });
  const file = out.outputFiles[0];
  if (file === undefined) throw new Error("esbuild produced no output");
  return file.text;
}

function jobFor(bundle: string, frames: number[], staticMeta: MainMeta = STATIC_META): RunMessage {
  return {
    type: "run",
    bundle,
    frames,
    shim: { allowed_imports: contract.allowed_imports },
    fps: staticMeta.fps,
    width: staticMeta.width,
    height: staticMeta.height,
    staticMeta,
  };
}

async function run(
  bundle: string,
  frames: number[] = [0],
  staticMeta: MainMeta = STATIC_META,
): Promise<{ result: ResultMessage; events: string[] }> {
  const events: string[] = [];
  const post = (message: ProgressMessage): void => {
    events.push(`${message.at}:${message.edge}`);
  };
  const result = await runRenderJob(jobFor(bundle, frames, staticMeta), post);
  return { result, events };
}

function frameOf(result: ResultMessage, frame: number) {
  const capture = result.frames[frame];
  if (capture === undefined) throw new Error(`frame ${frame} was not rendered`);
  return capture;
}

const normalize = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/\s/g, "");

afterEach(() => {
  vi.restoreAllMocks();
});

// ---- shim ----

describe("createRequireShim", () => {
  const host = {
    react: { createElement: () => 1, Fragment: Symbol("fragment"), useMemo: () => 2, useState: () => 3 },
    remotion: Object.fromEntries(
      [...(contract.allowed_imports.remotion?.values ?? []), "Internals", "staticFile"].map((name) => [
        name,
        () => name,
      ]),
    ),
  };

  function shim() {
    const made = createRequireShim({ allowed_imports: contract.allowed_imports }, host);
    if (!made.ok) throw new Error(made.reason);
    return made.require;
  }

  it("mengekspos hanya nama di allowed_imports sebagai objek beku", () => {
    const requireShim = shim();
    for (const [id, allowed] of Object.entries(contract.allowed_imports)) {
      const exposed = requireShim(id) as Record<string, unknown>;
      expect(Object.keys(exposed).sort()).toEqual([...allowed.values].sort());
      expect(Object.isFrozen(exposed)).toBe(true);
      expect(Object.getPrototypeOf(exposed)).toBeNull();
    }
    expect("useState" in (requireShim("react") as object)).toBe(false);
    expect("Internals" in (requireShim("remotion") as object)).toBe(false);
  });

  it("mengembalikan objek yang sama untuk id yang sama dan tidak bisa dimutasi", () => {
    const requireShim = shim();
    const react = requireShim("react") as Record<string, unknown>;
    expect(requireShim("react")).toBe(react);
    expect(() => {
      react.createElement = () => 0;
    }).toThrow(TypeError);
    expect(Object.isFrozen(requireShim)).toBe(true);
  });

  it.each(["fs", "node:fs", "react/jsx-runtime", "react-dom", "constructor", "__proto__", "toString", "", "REACT"])(
    "melempar untuk id %j",
    (id) => {
      expect(() => shim()(id)).toThrow(/is not available/);
    },
  );

  it("melempar untuk id yang bukan string", () => {
    const requireShim = shim();
    for (const id of [1, null, undefined, {}, ["react"], Symbol("react")]) {
      expect(() => requireShim(id)).toThrow(/is not available/);
    }
  });

  it("gagal terang-terangan bila modul host atau namanya tidak ada", () => {
    const noModule = createRequireShim({ allowed_imports: contract.allowed_imports }, { react: host.react });
    expect(noModule.ok).toBe(false);
    if (!noModule.ok) expect(noModule.reason).toContain("remotion");

    const noName = createRequireShim(
      { allowed_imports: { react: { values: ["createElement", "doesNotExist"] } } },
      { react: host.react },
    );
    expect(noName.ok).toBe(false);
    if (!noName.ok) expect(noName.reason).toContain("doesNotExist");
  });
});

// ---- ekstraksi teks (design 5.11) ----

describe("extractFrameText", () => {
  const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
    JSDOM: new (html: string) => { window: { document: { getElementById(id: string): unknown } } };
  };

  function textOf(innerHtml: string, rootAttributes = ""): string {
    const dom = new JSDOM(`<!doctype html><div id="root" ${rootAttributes}>${innerHtml}</div>`);
    return extractFrameText(dom.window.document.getElementById("root") as Parameters<typeof extractFrameText>[0]);
  }

  it("menggabungkan node teks menurut urutan dokumen tanpa pemisah", () => {
    expect(textOf("<p>Hello</p> <p>Wor<b>ld</b></p>")).toBe("Hello World");
  });

  it("melewati subtree title, desc, style, dan script", () => {
    expect(
      textOf(
        "<svg><title>T</title><desc>D</desc><text>X</text></svg><style>.a{color:red}</style><script>var a</script>Y",
      ),
    ).toBe("XY");
  });

  it.each([
    ["display: none", 'style="display: none"'],
    ["visibility: hidden", 'style="visibility: hidden"'],
    ["opacity: 0", 'style="opacity: 0"'],
  ])("melewati seluruh subtree elemen dengan %s, tetapi tidak saudaranya", (_name, attribute) => {
    expect(textOf(`<div ${attribute}>gone<span>deep</span></div><div>kept</div>`)).toBe("kept");
  });

  it("tidak melewati style yang tidak menyembunyikan", () => {
    expect(
      textOf('<div style="opacity: 0.5">a</div><div style="visibility: visible">b</div><div style="display: block">c</div>'),
    ).toBe("abc");
  });

  it("memakai aturan yang sama pada elemen akar (alasan pembungkus Thumbnail ditimpa saat render)", () => {
    expect(textOf("visible", 'style="opacity: 0"')).toBe("");
  });
});

// ---- inti Worker ----

describe("runRenderJob: render dan protokol", () => {
  it("merender frame sampel pada dua lintasan dan mengirim progress di sekitar evaluasi dan tiap frame", async () => {
    const { result, events } = await run(handBundle('return h("div", null, "frame " + R.useCurrentFrame());'), [29, 0, 7]);

    expect(result.evaluateError).toBeUndefined();
    expect(result.metaMatches).toBe(true);
    expect(result.defaultIsFunction).toBe(true);
    expect(result.meta).toEqual(STATIC_META);
    expect(result.console).toEqual({ error: 0, warn: 0 });
    for (const frame of [0, 7, 29]) {
      const capture = frameOf(result, frame);
      expect(capture.error).toBeUndefined();
      expect(capture.text).toBe(`frame ${frame}`);
      expect(capture.html).toContain(`frame ${frame}`);
      expect(capture.secondHtml).toBe(capture.html);
      expect(capture.count).toBeGreaterThan(0);
    }
    expect(events).toEqual([
      "evaluate:start",
      "evaluate:end",
      "0:start", "0:end", "7:start", "7:end", "29:start", "29:end",
      "29:start", "29:end", "7:start", "7:end", "0:start", "0:end",
    ]);
  });

  it("mengirim evaluate end walau evaluasi melempar, dan tidak merender frame", async () => {
    const { result, events } = await run(handBundle("return null;", { top: 'throw new Error("boom at top level");' }), [0, 5]);
    expect(result.evaluateError).toBe("Error: boom at top level");
    expect(result.frames).toEqual({});
    expect(result.metaMatches).toBe(false);
    expect(events).toEqual(["evaluate:start", "evaluate:end"]);
  });

  it("melaporkan SyntaxError bundle sebagai galat evaluasi", async () => {
    const { result } = await run("module.exports = {{{");
    expect(result.evaluateError).toMatch(/^SyntaxError:/);
    expect(result.frames).toEqual({});
  });

  it("mencatat galat per frame tanpa menurunkan frame lain, dan melewati lintasan kedua untuk frame itu", async () => {
    const body = 'const f = R.useCurrentFrame(); if (f === 5) throw new Error("bad frame"); return h("div", null, "ok " + f);';
    const { result, events } = await run(handBundle(body), [0, 5, 29]);

    expect(frameOf(result, 5).error).toMatch(/bad frame/);
    expect(frameOf(result, 5).html).toBeUndefined();
    expect(frameOf(result, 5).secondHtml).toBeUndefined();
    expect(frameOf(result, 0).text).toBe("ok 0");
    expect(frameOf(result, 29).text).toBe("ok 29");
    expect(frameOf(result, 29).secondHtml).toBe(frameOf(result, 29).html);
    expect(events.filter((e) => e.startsWith("5:"))).toEqual(["5:start", "5:end"]);
  });

  it("menandai nondeterminisme lewat secondHtml yang berbeda", async () => {
    const { result } = await run(
      handBundle('calls += 1; return h("div", null, "call " + calls);', { top: "let calls = 0;" }),
      [0, 10],
    );
    for (const frame of [0, 10]) {
      const capture = frameOf(result, frame);
      expect(capture.html).toBeDefined();
      expect(capture.secondHtml).toBeDefined();
      expect(capture.secondHtml).not.toBe(capture.html);
    }
  });
});

describe("runRenderJob: meta dan ekspor default", () => {
  it.each([
    ["durasi berbeda", "{ width: 1280, height: 720, fps: 30, durationInFrames: 31 }"],
    ["kunci kurang", "{ width: 1280, height: 720, fps: 30 }"],
    ["kunci tambahan", "{ width: 1280, height: 720, fps: 30, durationInFrames: 30, extra: 1 }"],
    ["pauseAtFrame tak terduga", "{ width: 1280, height: 720, fps: 30, durationInFrames: 30, pauseAtFrame: 10 }"],
    ["nilai string", '{ width: 1280, height: 720, fps: 30, durationInFrames: "30" }'],
    ["bukan objek", "42"],
  ])("RENDER_META_MISMATCH untuk meta: %s (tanpa frame)", async (_name, meta) => {
    const { result } = await run(handBundle('return h("div", null, "x");', { meta }), [0]);
    expect(result.metaMatches).toBe(false);
    expect(result.frames).toEqual({});
    expect(result.evaluateError).toBeUndefined();
  });

  it("menerima meta ber-pauseAtFrame yang sama dengan staticMeta", async () => {
    const meta = { ...STATIC_META, pauseAtFrame: 10 };
    const { result } = await run(
      handBundle('return h("div", null, "x");', { meta: JSON.stringify(meta) }),
      [0],
      meta,
    );
    expect(result.metaMatches).toBe(true);
    expect(result.meta).toEqual(meta);
  });

  it("melaporkan ekspor default yang bukan fungsi", async () => {
    const { result } = await run(handBundle("", { defaultExport: '"not a function"' }), [0]);
    expect(result.defaultIsFunction).toBe(false);
    expect(result.metaMatches).toBe(true);
    expect(result.frames).toEqual({});
  });

  it("menyalin meta menjadi nilai polos yang aman dikloning, tanpa fungsi atau getter", async () => {
    const meta = '{ width: 1280, height: 720, fps: 30, durationInFrames: 30, fn() {}, get g() { return 1; }, nested: {} }';
    const { result } = await run(handBundle('return h("div", null, "x");', { meta }), [0]);
    expect(result.metaMatches).toBe(false);
    expect(() => structuredClone(result)).not.toThrow();
    expect(result.meta).toEqual({ ...STATIC_META, g: 1 });
  });
});

describe("runRenderJob: isolasi konteks bundle (Requirement 11.2, 11.12)", () => {
  const NAMES = ["process", "Buffer", "fs", "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Worker", "WebAssembly"];

  it("typeof process, Buffer, fs, fetch, XMLHttpRequest, WebSocket, EventSource, Worker, WebAssembly bernilai undefined", async () => {
    const probes = NAMES.map((name) => `typeof ${name}`).join(", ");
    const { result } = await run(handBundle(`return h("div", null, [${probes}].join(","));`), [0]);
    expect(result.evaluateError).toBeUndefined();
    expect(frameOf(result, 0).text).toBe(NAMES.map(() => "undefined").join(","));
  });

  it("menghapus WebAssembly dari konteks (konteks vm bawaan memilikinya)", async () => {
    const { result } = await run(
      handBundle('return h("div", null, typeof WebAssembly + "/" + typeof globalThis.WebAssembly);'),
      [0],
    );
    expect(frameOf(result, 0).text).toBe("undefined/undefined");
  });

  it("hanya mengekspos console, require, module, dan exports sebagai global buatan Worker", async () => {
    const { result } = await run(
      handBundle('return h("div", null, [typeof console, typeof require, typeof module, typeof exports].join(","));'),
      [0],
    );
    expect(frameOf(result, 0).text).toBe("object,function,object,object");
  });

  it("require untuk modul selain react dan remotion melempar, dan bundle yang memanggilnya gagal evaluasi", async () => {
    const { result } = await run(handBundle("return null;", { top: 'require("fs");' }), [0]);
    expect(result.evaluateError).toBe('Error: module "fs" is not available');
    expect(result.frames).toEqual({});
  });

  it("require yang ditangkap bundle tetap melempar untuk node:fs, react-dom, dan jsx-runtime", async () => {
    const body =
      'const out = []; for (const id of ["node:fs", "react-dom", "react/jsx-runtime", "child_process"]) { try { require(id); out.push("loaded"); } catch (e) { out.push("blocked"); } } return h("div", null, out.join(","));';
    const { result } = await run(handBundle(body), [0]);
    expect(frameOf(result, 0).text).toBe("blocked,blocked,blocked,blocked");
  });

  it("require('react') dan require('remotion') hanya berisi nama yang diizinkan", async () => {
    const body =
      'return h("div", null, Object.keys(require("react")).sort().join(",") + "|" + Object.keys(require("remotion")).sort().join(","));';
    const { result } = await run(handBundle(body), [0]);
    const expectedReact = [...(contract.allowed_imports.react?.values ?? [])].sort().join(",");
    const expectedRemotion = [...(contract.allowed_imports.remotion?.values ?? [])].sort().join(",");
    expect(frameOf(result, 0).text).toBe(`${expectedReact}|${expectedRemotion}`);
  });

  it("memblokir eval dan Function di konteks (codeGeneration.strings dimatikan)", async () => {
    const evalRun = await run(handBundle("return null;", { top: 'eval("1 + 1");' }), [0]);
    expect(evalRun.result.evaluateError).toMatch(/EvalError: Code generation from strings disallowed/);
    const fnRun = await run(handBundle("return null;", { top: 'new Function("return 1");' }), [0]);
    expect(fnRun.result.evaluateError).toMatch(/EvalError: Code generation from strings disallowed/);
  });

  it("jsdom hanya host DOM: window tidak punya XMLHttpRequest, WebSocket, EventSource, maupun fetch", async () => {
    // Probe memakai Function dari realm luar (jalan keluar yang diakui di Requirement 11.10),
    // satu-satunya cara bundle melihat global Worker; ini memeriksa window jsdom, bukan batas keamanan.
    const body =
      'const probe = h.constructor("return [typeof window.XMLHttpRequest, typeof window.WebSocket, typeof window.EventSource, typeof window.fetch, typeof XMLHttpRequest, typeof document].join(\',\')"); return h("div", null, probe());';
    const { result } = await run(handBundle(body), [0]);
    expect(result.evaluateError).toBeUndefined();
    expect(frameOf(result, 0).text).toBe("undefined,undefined,undefined,undefined,undefined,object");
  });
});

describe("runRenderJob: console (Requirement 11.11, 9.5)", () => {
  it("menangkap console bundle dan menghitung error dan warn tanpa menulis ke stdout, stderr, atau console Worker", async () => {
    const stdout = vi.spyOn(process.stdout, "write");
    const stderr = vi.spyOn(process.stderr, "write");
    const logSpies = (["log", "info", "debug", "warn", "error"] as const).map((m) => vi.spyOn(console, m));

    const top =
      'for (let i = 0; i < 1000; i += 1) { console.log("LORE_SENTINEL " + i); console.info("LORE_SENTINEL"); console.debug("LORE_SENTINEL"); } console.warn("LORE_SENTINEL"); console.warn("LORE_SENTINEL"); console.error("LORE_SENTINEL"); console.table([1]); console.group("x"); console.groupEnd();';
    const { result } = await run(handBundle('return h("div", null, "x");', { top }), [0]);

    expect(result.evaluateError).toBeUndefined();
    expect(result.console).toEqual({ error: 1, warn: 2 });
    const written = [...stdout.mock.calls, ...stderr.mock.calls].map((call) => String(call[0]));
    expect(written.filter((chunk) => chunk.includes("LORE_SENTINEL"))).toEqual([]);
    for (const spy of logSpies) expect(spy).not.toHaveBeenCalled();
  });

  it("menghitung console yang dipanggil saat render, juga dari React (console Worker)", async () => {
    const warns = await run(handBundle('console.warn("render time"); return h("div", null, "x");'), [0]);
    expect(warns.result.console.warn).toBeGreaterThanOrEqual(2);
    expect(warns.result.console.error).toBe(0);

    // Daftar anak tanpa key membuat React dev memanggil console.error milik Worker.
    const reactError = await run(
      handBundle('return h("div", null, [h("span", null, "a"), h("span", null, "b")]);'),
      [0],
    );
    expect(reactError.result.console.error).toBeGreaterThanOrEqual(1);
  });

  it("mengembalikan console dan global proses tes setelah pekerjaan selesai", async () => {
    const before = { warn: console.warn, error: console.error, log: console.log };
    const hadDocument = "document" in globalThis;
    await run(handBundle('return h("div", null, "x");'), [0]);
    await run(handBundle("return null;", { top: 'throw new Error("x");' }), [0]);

    expect(console.warn).toBe(before.warn);
    expect(console.error).toBe(before.error);
    expect(console.log).toBe(before.log);
    expect("document" in globalThis).toBe(hadDocument);
    expect("window" in globalThis).toBe(false);
    expect(typeof globalThis.fetch).toBe("function");
  });
});

describe("runRenderJob: teks frame dan pembungkus Thumbnail (catatan 3.4)", () => {
  it("tidak menyembunyikan konten karena opacity 0 pada pembungkus Thumbnail", async () => {
    const { result } = await run(handBundle('return h("div", null, "visible text");'), [0]);
    expect(frameOf(result, 0).text).toBe("visible text");
  });

  it("tetap mengecualikan teks yang disembunyikan pengarang animasi sendiri", async () => {
    const body =
      'return h("div", null, h("p", null, "keep"), h("p", { style: { display: "none" } }, "gone-1"), h("p", { style: { visibility: "hidden" } }, "gone-2"), h("p", { style: { opacity: 0 } }, "gone-3"), h("p", { style: { opacity: 0.5 } }, "-half"), h("svg", null, h("title", null, "gone-4"), h("desc", null, "gone-5"), h("text", null, "-svg")));';
    const { result } = await run(handBundle(body), [0]);
    expect(frameOf(result, 0).text).toBe("keep-half-svg");
  });

  it("menghitung elemen turunan kontainer, termasuk SVG", async () => {
    const circles = 'Array.from({ length: 40 }, (_, i) => h("circle", { key: i, cx: i, cy: i, r: 1 }))';
    const { result } = await run(handBundle(`return h("svg", { width: 10, height: 10 }, ${circles});`), [0]);
    const base = await run(handBundle('return h("svg", { width: 10, height: 10 });'), [0]);
    expect(frameOf(result, 0).count).toBe((frameOf(base.result, 0).count ?? 0) + 40);
  });
});

// ---- korpus fixtures/good ----

interface Companion {
  kind: "lesson" | "puzzle";
  required_tokens: string[];
  forbidden_tokens: string[];
}

/** Himpunan sampel design 5.9; sengaja ditulis ulang di sini, `sampleFrames` adalah tugas 6.2. */
function sampleSet(d: number, p: number | undefined, kind: "lesson" | "puzzle"): number[] {
  const frames = new Set([0, Math.floor(d / 4), Math.floor(d / 2), Math.floor((3 * d) / 4), d - 1]);
  if (p !== undefined) {
    frames.add(p);
    if (kind === "puzzle") {
      frames.add(Math.floor(p / 2));
      frames.add(p - 1);
    }
  }
  return [...frames].sort((a, b) => a - b);
}

const fixtureNames = readdirSync(GOOD_DIR)
  .filter((name) => name.endsWith(".ts"))
  .sort();

describe("fixtures/good dirender lewat inti Worker", () => {
  it("memuat sedikitnya 8 fixture", () => {
    expect(fixtureNames.length).toBeGreaterThanOrEqual(8);
  });

  describe.each(fixtureNames)("%s", (name) => {
    it("lolos evaluasi, meta cocok, tanpa galat atau console, deterministik, dan memuat semua Required_Token", async () => {
      const source = readFileSync(new URL(name, GOOD_DIR), "utf8");
      const companion = JSON.parse(readFileSync(new URL(name.replace(/\.ts$/, ".json"), GOOD_DIR), "utf8")) as Companion;

      const durationMatch = /durationInFrames:\s*(\d+)/.exec(source);
      const pauseMatch = /pauseAtFrame:\s*(\d+)/.exec(source);
      const duration = Number(durationMatch?.[1]);
      const pause = pauseMatch === null ? undefined : Number(pauseMatch[1]);
      expect(Number.isInteger(duration)).toBe(true);

      const staticMeta: MainMeta = { width: 1280, height: 720, fps: 30, durationInFrames: duration };
      if (pause !== undefined) staticMeta.pauseAtFrame = pause;
      const frames = sampleSet(duration, pause, companion.kind);

      const { result } = await run(await esbuildBundle(source), frames, staticMeta);

      expect(result.evaluateError).toBeUndefined();
      expect(result.metaMatches).toBe(true);
      expect(result.defaultIsFunction).toBe(true);
      expect(result.console).toEqual({ error: 0, warn: 0 });

      for (const frame of frames) {
        const capture = frameOf(result, frame);
        expect(capture.error, `frame ${frame}`).toBeUndefined();
        expect(capture.secondHtml, `frame ${frame} determinism`).toBe(capture.html);
        expect(capture.count ?? Infinity, `frame ${frame} element count`).toBeLessThanOrEqual(contract.limits.dom_max_elements);
      }

      // Required_Token wajib di frame terakhir, dan di pauseAtFrame untuk puzzle (Requirement 10.2, 10.3).
      const mustContain = companion.kind === "puzzle" && pause !== undefined ? [duration - 1, pause] : [duration - 1];
      for (const frame of mustContain) {
        const text = normalize(frameOf(result, frame).text ?? "");
        expect(text.length, `frame ${frame} has text`).toBeGreaterThan(0);
        for (const token of companion.required_tokens) {
          expect(text, `frame ${frame} must contain ${JSON.stringify(token)}`).toContain(normalize(token));
        }
      }

      // Forbidden_Token tidak tampak pada frame sampel mana pun sampai pauseAtFrame (Requirement 10.4).
      if (companion.kind === "puzzle" && pause !== undefined) {
        for (const frame of frames.filter((f) => f <= pause)) {
          const text = normalize(frameOf(result, frame).text ?? "");
          for (const token of companion.forbidden_tokens) {
            expect(text, `frame ${frame} must not show ${JSON.stringify(token)}`).not.toContain(normalize(token));
          }
        }
      }
    });
  });
});
