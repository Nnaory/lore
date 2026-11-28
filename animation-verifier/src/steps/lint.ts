// Langkah 3 pipeline verifier: ESLint dan pemindai direktif (design 5.6 dan tabel 5.12; Requirement
// 8.1, 8.2, 8.10, 8.11, 8.12, 8.15, 6.15; tugas 5.2).
// Alur: konfigurasi flat internal (`eslint.config.mjs`: `eslint:recommended`, `@typescript-eslint/
// recommended` tanpa aturan type-aware, dan plugin lokal `lore`) dimuat sebagai objek dan dijalankan
// lewat `new ESLint({ overrideConfigFile: true, overrideConfig, cwd, cache: false })`, sehingga ESLint
// tidak pernah mencari konfigurasi di disk. `lintText(source, { filePath: <file_name kontrak> })`
// menghasilkan pesan yang dipetakan ke Diagnostic:
//   - `code` = `ESLINT_` + `ruleId` huruf besar tanpa awalan `@`, dengan setiap karakter di luar
//     `[A-Z0-9_]` (terutama `/` dan `-`) menjadi `_`; contoh `@typescript-eslint/no-explicit-any`
//     menjadi `ESLINT_TYPESCRIPT_ESLINT_NO_EXPLICIT_ANY`, `lore/kit-style` menjadi `ESLINT_LORE_KIT_STYLE`;
//   - `ruleId === null` menjadi `ESLINT_PARSE_ERROR`, kecuali pesan "has no effect because you have
//     'noInlineConfig'" yang diabaikan karena komentar direktif dilaporkan oleh pemindai di bawah;
//   - severity ESLint 2 menjadi `error` dan 1 menjadi `warning` (warning `lore/kit-style` tidak
//     mengubah `ok`).
// Komentar direktif (`ESLINT_INLINE_DIRECTIVE`, error) ditemukan `scanComments` (policy/comments.ts,
// `ts.createScanner`), bukan oleh ESLint: `noInlineConfig` membuat ESLint mengabaikan direktif,
// jadi tanpa pemindai ini `/* eslint-disable */` lolos tanpa jejak. Bentuk yang dikenali mengikuti
// ESLint: di komentar blok `eslint`, `eslint-disable`, `eslint-disable-line`,
// `eslint-disable-next-line`, `eslint-enable`, `eslint-env`, `globals` dan `global`; di komentar
// baris hanya empat yang berawalan `eslint-` (ESLint sendiri hanya memberlakukan `-line`), supaya
// komentar biasa seperti `// globals are bad` tidak ditolak. Pencocokan dilakukan pada isi komentar
// yang sudah di-`trim`, diikuti spasi atau akhir komentar, persis pola direktif ESLint.
// Opsi `lore/kit-style` (`kit_style_warnings`, `font_variables`) disuntikkan dari kontrak yang sedang
// dipakai ke entri aturan itu pada konfigurasi (severity tetap dari `eslint.config.mjs`), karena
// kontrak adalah satu-satunya tempat daftar itu ditulis (Requirement 2.6).
// Galat internal (konfigurasi tidak ditemukan atau tidak berbentuk larik, pola emoji kontrak bukan
// regex sah sehingga aturan gagal dibuat, ESLint melempar) dipetakan ke satu `VERIFIER_INTERNAL`
// tanpa teks exception, karena teks itu bisa memuat sumber atau pola kontrak.
// Lokasi konfigurasi: `dist/eslint.config.mjs` di image Lambda (Dockerfile menyalinnya ke sebelah
// hasil build) dan `eslint.config.mjs` di akar paket saat tes atau dijalankan dari `src/`, dengan pola
// yang sama seperti `CONTRACT_LOCATIONS` di handler. Berkas itu mengimpor plugin sebagai
// `./eslint-plugin-lore/index.js`: `dist/eslint-plugin-lore/` hasil `npm run build`, atau sumber `.ts`
// lewat resolusi Vite saat tes. `src/` sengaja tidak mengimpor plugin lewat jalur TypeScript: itu
// menggeser `rootDir` dan `tsc` akan menulis `dist/src/handler.js`, bukan `dist/handler.js`.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ESLint, type Linter } from "eslint";
import type { Contract } from "../contract.js";
import { scanComments, type SourceComment } from "../policy/comments.js";
import type { Diagnostic } from "../types.js";
import type { StepContext, StepResult, VerifierStep } from "./step.js";

const CONFIG_FILE_NAME = "eslint.config.mjs";

/** Urutan pencarian konfigurasi: image Lambda (`dist/`) lebih dulu, lalu akar paket (sumber dan tes). */
export const CONFIG_LOCATIONS: readonly URL[] = [
  new URL(`../${CONFIG_FILE_NAME}`, import.meta.url),
  new URL(`../../${CONFIG_FILE_NAME}`, import.meta.url),
];

/** Akar paket: `src/steps/` dan `dist/steps/` sama-sama dua tingkat di bawahnya. Dipakai sebagai `cwd`. */
const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Tipe modul konfigurasi dibaca dari `eslint.config.d.mts` tanpa menarik berkas `.mjs` ke dalam build. */
type ConfigModule = typeof import("../../eslint.config.mjs");

const KIT_STYLE_RULE = "lore/kit-style";

/** Opsi aturan `lore/kit-style`; bentuknya diturunkan dari kontrak, bukan diimpor dari plugin. */
interface KitStyleRuleOptions {
  readonly kit_style_warnings: Contract["kit_style_warnings"];
  readonly font_variables: Contract["font_variables"];
}

const INTERNAL_MESSAGE = "internal verifier error";
const DIRECTIVE_MESSAGE = "eslint directive comments are not allowed";

/** Pesan ESLint yang menyatakan sebuah direktif tidak berlaku karena `noInlineConfig` (diabaikan). */
const NO_EFFECT_MESSAGE = /has no effect because you have 'noInlineConfig'/u;

/** Isi komentar blok yang merupakan direktif ESLint (pola direktif ESLint tanpa `exported`). */
const BLOCK_DIRECTIVE = /^(?:eslint(?:-env|-enable|-disable(?:(?:-next)?-line)?)?|globals?)(?:\s|$)/u;

/** Isi komentar baris yang merupakan direktif: hanya bentuk berawalan `eslint-`. */
const LINE_DIRECTIVE = /^eslint-(?:env|enable|disable(?:(?:-next)?-line)?)(?:\s|$)/u;

// ---- konfigurasi ----

type LoadedConfig = { ok: true; config: readonly Linter.Config[] } | { ok: false };

/** Memuat `eslint.config.mjs` dari lokasi pertama yang ada. Total: kegagalan apa pun menjadi `ok: false`. */
async function loadInternalConfig(): Promise<LoadedConfig> {
  const location = CONFIG_LOCATIONS.find((candidate) => existsSync(fileURLToPath(candidate)));
  if (location === undefined) return { ok: false };
  try {
    const loaded = (await import(/* @vite-ignore */ location.href)) as Partial<ConfigModule>;
    return Array.isArray(loaded.default) ? { ok: true, config: loaded.default } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/**
 * Salinan `config` dengan opsi `options` dipasang pada entri `lore/kit-style`, severity tetap dari
 * berkas konfigurasi. `undefined` bila tidak ada entri yang menyalakan aturan itu (konfigurasi rusak).
 */
function withKitStyleOptions(
  config: readonly Linter.Config[],
  options: KitStyleRuleOptions,
): Linter.Config[] | undefined {
  let found = false;
  const result = config.map((entry): Linter.Config => {
    const setting = entry.rules?.[KIT_STYLE_RULE];
    if (setting === undefined) return entry;
    found = true;
    const severity = Array.isArray(setting) ? setting[0] : setting;
    return { ...entry, rules: { ...entry.rules, [KIT_STYLE_RULE]: [severity, options] } };
  });
  return found ? result : undefined;
}

// ---- pemetaan pesan ESLint ----

/** `@typescript-eslint/no-explicit-any` menjadi `ESLINT_TYPESCRIPT_ESLINT_NO_EXPLICIT_ANY`. */
export function eslintCode(ruleId: string | null): string {
  if (ruleId === null) return "ESLINT_PARSE_ERROR";
  return `ESLINT_${ruleId.replace(/^@/u, "").toUpperCase().replace(/[^A-Z0-9_]/gu, "_")}`;
}

function fromMessage(context: StepContext, message: Linter.LintMessage): Diagnostic | undefined {
  if (message.ruleId === null && NO_EFFECT_MESSAGE.test(message.message)) return undefined;
  return context.diagnostic(
    eslintCode(message.ruleId),
    message.severity === 2 ? "error" : "warning",
    message.message,
    { line: message.line, column: message.column },
  );
}

// ---- pemindai direktif ----

/** Benar bila `comment` adalah direktif konfigurasi ESLint (lihat header). */
export function isEslintDirective(comment: SourceComment): boolean {
  const body = comment.value.trim();
  return (comment.kind === "block" ? BLOCK_DIRECTIVE : LINE_DIRECTIVE).test(body);
}

function directiveDiagnostics(context: StepContext, source: string): Diagnostic[] {
  return scanComments(source)
    .filter(isEslintDirective)
    .map((comment) =>
      context.diagnostic("ESLINT_INLINE_DIRECTIVE", "error", DIRECTIVE_MESSAGE, {
        line: comment.line,
        column: comment.column,
      }),
    );
}

// ---- langkah ----

function internalFailure(context: StepContext): StepResult {
  return { diagnostics: [context.diagnostic("VERIFIER_INTERNAL", "error", INTERNAL_MESSAGE)] };
}

export const lintStep: VerifierStep = {
  number: 3,
  async run(context) {
    const loaded = await loadInternalConfig();
    if (!loaded.ok) return internalFailure(context);
    const { contract } = context;
    const overrideConfig = withKitStyleOptions(loaded.config, {
      kit_style_warnings: contract.kit_style_warnings,
      font_variables: contract.font_variables,
    });
    if (overrideConfig === undefined) return internalFailure(context);

    const { source } = context.input;
    const diagnostics: Diagnostic[] = [];
    try {
      const eslint = new ESLint({
        overrideConfigFile: true,
        overrideConfig,
        cwd: PACKAGE_ROOT,
        cache: false,
      });
      const results = await eslint.lintText(source, {
        filePath: contract.file_name,
        warnIgnored: false,
      });
      for (const result of results) {
        for (const message of result.messages) {
          const diagnostic = fromMessage(context, message);
          if (diagnostic !== undefined) diagnostics.push(diagnostic);
        }
      }
    } catch {
      return internalFailure(context);
    }
    for (const diagnostic of directiveDiagnostics(context, source)) diagnostics.push(diagnostic);
    return { diagnostics };
  },
};
