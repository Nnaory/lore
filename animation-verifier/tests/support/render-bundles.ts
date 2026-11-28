// Pembantu tes langkah 6: bundle uji dan korpus `fixtures/good`. `handBundle` menulis bundle CJS
// kecil secara manual (isi `Main`, kode level modul, dan `meta` dapat diatur); `esbuildBundle` membuat
// bundle dari sumber TypeScript persis seperti langkah 5 (design 5.8: `cjs`, `react` dan `remotion`
// eksternal). `loadGoodFixtures` membaca tiap fixture bagus beserta meta statis dan jenisnya, yang
// pada pipeline sungguhan datang dari langkah 2 (`META_ARTIFACT`).

import { readdirSync, readFileSync } from "node:fs";
import { build } from "esbuild";
import type { Kind, MainMeta } from "../../src/types.js";

const PKG_ROOT = new URL("../../", import.meta.url).pathname;
const GOOD_DIR = new URL("../../fixtures/good/", import.meta.url);

export const META_LITERAL = "{ width: 1280, height: 720, fps: 30, durationInFrames: 30 }";

/** Bundle CJS tulisan tangan; `body` adalah isi `Main`, `top` dijalankan saat evaluasi. */
export function handBundle(
  body: string,
  options: { top?: string; meta?: string; defaultExport?: string } = {},
): string {
  return [
    '"use strict";',
    'const React = require("react"); const R = require("remotion"); const h = React.createElement;',
    options.top ?? "",
    `module.exports = { meta: ${options.meta ?? META_LITERAL}, default: ${options.defaultExport ?? `function Main() { ${body} }`} };`,
  ].join("\n");
}

/** Bundle TypeScript dengan esbuild, sama seperti langkah 5. */
export async function esbuildBundle(source: string): Promise<string> {
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

export interface GoodFixture {
  readonly name: string;
  readonly source: string;
  readonly kind: Kind;
  readonly meta: MainMeta;
}

interface Companion {
  kind: Kind;
}

/** Semua `fixtures/good/*.ts` terurut menurut nama, dengan meta yang dibaca dari sumbernya. */
export function loadGoodFixtures(): GoodFixture[] {
  return readdirSync(GOOD_DIR)
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => {
      const source = readFileSync(new URL(name, GOOD_DIR), "utf8");
      const companion = JSON.parse(
        readFileSync(new URL(name.replace(/\.ts$/, ".json"), GOOD_DIR), "utf8"),
      ) as Companion;
      const duration = Number(/durationInFrames:\s*(\d+)/.exec(source)?.[1]);
      const pauseMatch = /pauseAtFrame:\s*(\d+)/.exec(source);
      const meta: MainMeta = { width: 1280, height: 720, fps: 30, durationInFrames: duration };
      if (pauseMatch !== null) meta.pauseAtFrame = Number(pauseMatch[1]);
      return { name, source, kind: companion.kind, meta };
    });
}
