/**
 * style-guard.test.ts — static guard for Black Cat Gold Kit rules (task 18.4).
 *
 * Why: enforces Requirements 3.1, 3.2, 3.3, 13.9, and 15.5 across
 * `src/components` and `src/app` (plus new `src/lib` modules):
 *   - no literal hex, rgb(), rgba(), hsl(), hsla(), or default Tailwind palette
 *     classes in `src/components` and `src/app` outside `lore-tokens.css`;
 *   - no `rounded-`, `shadow-` (except `.lore-dialog`), `backdrop-`, `blur`,
 *     gradients (except `.lore-grid-bg` / `.lore-grid-lines`), or emoji;
 *   - no `font-family` outside the two Kit font variables;
 *   - every new file starts with a header comment (or `'use client'` + header comment);
 *   - every component using browser APIs or client hooks declares `'use client'`.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC_DIR = path.resolve(__dirname, "../../src");
const COMPONENTS_DIR = path.join(SRC_DIR, "components");
const APP_DIR = path.join(SRC_DIR, "app");

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (/\.(ts|tsx|css)$/.test(entry.name)) out.push(full);
  }
  return out.sort();
}

function rel(file: string): string {
  return path.relative(SRC_DIR, file).replace(/\\/g, "/");
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

const UI_FILES = [...walkFiles(COMPONENTS_DIR), ...walkFiles(APP_DIR)];

describe("Static style guard (task 18.4)", () => {
  it("forbids literal hex, rgb(), hsl(), and default Tailwind color classes in src/components and src/app", () => {
    const hexRe = /#[0-9a-fA-F]{3,8}\b/;
    const fnColorRe = /\b(?:rgba?|hsla?)\s*\(/;
    const twColorRe =
      /\b(?:bg|text|border|ring|outline|from|via|to)-(?:white|black|gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-[0-9]{2,3})?(?:\/[0-9]{1,3})?\b/;

    const violations: string[] = [];
    for (const file of UI_FILES) {
      const r = rel(file);
      if (r === "app/lore-tokens.css") continue;
      const code = stripComments(fs.readFileSync(file, "utf8"));
      if (hexRe.test(code)) violations.push(`${r}: hex literal (${code.match(hexRe)?.[0]})`);
      if (fnColorRe.test(code)) violations.push(`${r}: rgb/hsl function (${code.match(fnColorRe)?.[0]})`);
      if (twColorRe.test(code)) violations.push(`${r}: Tailwind default color (${code.match(twColorRe)?.[0]})`);
    }
    expect(violations).toEqual([]);
  });

  it("forbids rounded-*, shadow-* (except .lore-dialog), backdrop-*, blur, gradients (except .lore-grid-*), and emoji", () => {
    const roundedRe = /\brounded(?:-[a-z0-9]+)?\b/;
    const shadowRe = /\bshadow(?:-[a-z0-9]+)?\b|box-shadow|text-shadow|drop-shadow/;
    const backdropRe = /\bbackdrop-(?:blur|filter|saturate|brightness|contrast)|backdropFilter/;
    const blurRe = /\bblur(?:-[a-z0-9]+|\s*\()/;
    const gradientRe = /\b(?:linear|radial|conic)-gradient\s*\(|\bbg-gradient-to-/;
    // Matches astral plane pictographic emoji while excluding standard BMP typography/arrows/geometric marks.
    const emojiRe = /[\u{1F300}-\u{1FAFF}]/u;

    const violations: string[] = [];
    for (const file of UI_FILES) {
      const r = rel(file);
      const raw = fs.readFileSync(file, "utf8");
      const code = stripComments(raw);

      if (roundedRe.test(code)) violations.push(`${r}: rounded (${code.match(roundedRe)?.[0]})`);
      if (r !== "app/lore-tokens.css" && shadowRe.test(code)) {
        violations.push(`${r}: shadow (${code.match(shadowRe)?.[0]})`);
      }
      if (backdropRe.test(code)) violations.push(`${r}: backdrop (${code.match(backdropRe)?.[0]})`);
      if (blurRe.test(code)) violations.push(`${r}: blur (${code.match(blurRe)?.[0]})`);
      if (r !== "app/lore-tokens.css" && gradientRe.test(code)) {
        violations.push(`${r}: gradient (${code.match(gradientRe)?.[0]})`);
      }
      if (emojiRe.test(raw)) violations.push(`${r}: emoji (${raw.match(emojiRe)?.[0]})`);
    }
    expect(violations).toEqual([]);
  });

  it("forbids font-family declarations outside the two Kit font variables", () => {
    const violations: string[] = [];
    for (const file of UI_FILES) {
      const r = rel(file);
      const code = stripComments(fs.readFileSync(file, "utf8"));
      const hasMonoConst = /const\s+MONO\s*=\s*["'][^"']*--font-mono/.test(code);
      const hasDisplayConst = /const\s+DISPLAY\s*=\s*["'][^"']*--font-display/.test(code);
      for (const m of code.matchAll(/(?:font-family|fontFamily)\s*:\s*([^;\n}]+)/g)) {
        const val = m[1].replace(/,\s*$/, "").trim();
        const isKitFont =
          val.includes("--font-mono") ||
          val.includes("--font-display") ||
          ((val === "MONO" || val.startsWith("MONO,")) && hasMonoConst) ||
          ((val === "DISPLAY" || val.startsWith("DISPLAY,")) && hasDisplayConst);
        if (!isKitFont) {
          violations.push(`${r}: ${val}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("requires a header comment at the top of every new file and 'use client' on components using browser APIs", () => {
    const newDirs = [
      path.join(COMPONENTS_DIR, "ascii"),
      path.join(COMPONENTS_DIR, "ui"),
      path.join(SRC_DIR, "lib/ascii"),
      path.join(SRC_DIR, "lib/cast"),
      path.join(SRC_DIR, "lib/dialogue"),
      path.join(SRC_DIR, "lib/home"),
      path.join(SRC_DIR, "lib/prep"),
      path.join(SRC_DIR, "lib/schemas"),
      path.join(SRC_DIR, "lib/stage"),
    ];
    const newFiles = [
      ...newDirs.flatMap(walkFiles),
      path.join(APP_DIR, "fonts.ts"),
      path.join(APP_DIR, "lore-tokens.css"),
      path.join(COMPONENTS_DIR, "home/HomeHero.tsx"),
      path.join(COMPONENTS_DIR, "home/use-home-composer.ts"),
      path.join(COMPONENTS_DIR, "setup/ChaptersSection.tsx"),
      path.join(COMPONENTS_DIR, "setup/PrepColumn.tsx"),
      path.join(COMPONENTS_DIR, "stage/CanvasPane.tsx"),
      path.join(COMPONENTS_DIR, "stage/KeyHints.tsx"),
      path.join(COMPONENTS_DIR, "stage/PuzzleScope.tsx"),
      path.join(COMPONENTS_DIR, "stage/ScaledBoard.tsx"),
      path.join(COMPONENTS_DIR, "stage/StageDialogue.tsx"),
      path.join(COMPONENTS_DIR, "stage/StageHud.tsx"),
      path.join(COMPONENTS_DIR, "stage/StageScene.tsx"),
      path.join(COMPONENTS_DIR, "stage/StageSprite.tsx"),
      path.join(COMPONENTS_DIR, "stage/chat-entry.ts"),
      path.join(COMPONENTS_DIR, "story/CanvasFrame.tsx"),
      path.join(COMPONENTS_DIR, "story/DialogueBox.tsx"),
    ];

    const headerRe = /^(?:['"]use client['"];?\s*)?(?:\/\*|\/\/)/;
    const missingHeaders: string[] = [];
    for (const file of newFiles) {
      const content = fs.readFileSync(file, "utf8").trimStart();
      if (!headerRe.test(content)) missingHeaders.push(rel(file));
    }
    expect(missingHeaders).toEqual([]);

    const browserApiRe =
      /\b(?:window|document|localStorage|sessionStorage|navigator|matchMedia|ResizeObserver|requestAnimationFrame)\b/;
    const missingUseClient: string[] = [];
    for (const file of UI_FILES) {
      if (!/\.tsx?$/.test(file)) continue;
      const code = stripComments(fs.readFileSync(file, "utf8"));
      if (browserApiRe.test(code) && !/['"]use client['"]/.test(code)) {
        missingUseClient.push(rel(file));
      }
    }
    expect(missingUseClient).toEqual([]);
  });
});
