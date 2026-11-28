// Penilaian nilai warna untuk pemindaian kebijakan (design 5.5 "Nilai warna per token"; Requirement
// 1.8, 1.9, 1.15, 1.17, 7.9; tugas 4.3).
// Pertanyaan yang dijawab: apakah sebuah string nilai properti pembawa warna (`fill`, `border`,
// `boxShadow`, dst.) hanya memuat nilai warna yang diizinkan Kit? Nilai dipecah menjadi token tingkat
// atas (pemisah: spasi dan koma pada kedalaman kurung 0). Token diterima bila persis
// `var(--color-<token>)` dengan `<token>` dari `color_tokens`, bila sama dengan salah satu
// `color_keywords`, atau bila bukan bentuk warna (`1px`, `solid`). Token ditolak bila hex, fungsi
// warna (`rgb(`, `oklch(`, `color-mix(`, dst.), nama warna CSS (tanpa memperhatikan huruf besar-kecil),
// atau `var(...)` lain (`var(--color-cloth-mira)`, `var(--color-ink, red)`).
// Perluasan yang disengaja di atas tabel desain: argumen fungsi non-warna dinilai dengan aturan sama
// (`linear-gradient(to right, red, var(--color-ink))` menolak `red`), supaya warna tidak lolos dengan
// dibungkus fungsi. Kedalaman rekursi dibatasi `limits.fold_depth`.
// Semua daftar (token palet, kata kunci, fungsi, nama warna, pola hex) dibaca dari kontrak; satu-satunya
// literal di sini adalah bentuk sintaks CSS `var(--color-...)`, yaitu fakta bahasa, bukan nilai kontrak.
// Modul ini murni terhadap keluaran: tanpa throw (kecuali pola hex kontrak yang rusak, yang menjadi
// `VERIFIER_INTERNAL` lewat `safeVerify`), jam, acak, atau akses disk. Satu-satunya status adalah memo
// `WeakMap` per kontrak (`colorRulesOf`).

import type { Contract } from "../contract.js";

/** Bentuk sintaks CSS untuk variabel warna palet; token dari kontrak disisipkan di tengah. */
const PALETTE_VAR_PREFIX = "var(--color-";
const PALETTE_VAR_SUFFIX = ")";

/** Panjang maksimum potongan nilai yang dicantumkan di pesan (pesan akhir tetap dipotong ke batas kontrak). */
const FRAGMENT_MAX_CHARS = 60;

/** Pesan tabel 5.12 untuk `POLICY_COLOR_LITERAL`; `<token>` adalah bagian sintaks petunjuk, bukan placeholder. */
export function colorLiteralMessage(fragment: string): string {
  return `use var(--color-<token>) from the Kit palette, found ${fragment.slice(0, FRAGMENT_MAX_CHARS)}`;
}

/** Struktur pencarian turunan kontrak, dibangun sekali per kontrak. */
export interface ColorRules {
  /** `var(--color-ink)` dan seterusnya, persis (peka huruf besar-kecil). */
  readonly paletteVars: ReadonlySet<string>;
  /** `color_keywords` dalam huruf kecil. */
  readonly keywords: ReadonlySet<string>;
  /** `color_forms.functions` dalam huruf kecil, mis. `rgb(`. */
  readonly functions: readonly string[];
  /** Nama warna CSS dalam huruf kecil (`Contract.namedColors`). */
  readonly namedColors: ReadonlySet<string>;
  /** `color_forms.hex_pattern` (berjangkar, tanpa flag). */
  readonly hex: RegExp;
  /** `limits.fold_depth`. */
  readonly maxDepth: number;
}

const cache = new WeakMap<Contract, ColorRules>();

export function colorRulesOf(contract: Contract): ColorRules {
  const cached = cache.get(contract);
  if (cached !== undefined) return cached;
  const rules: ColorRules = {
    paletteVars: new Set(
      contract.color_tokens.map((token) => `${PALETTE_VAR_PREFIX}${token}${PALETTE_VAR_SUFFIX}`),
    ),
    keywords: new Set(contract.color_keywords.map((keyword) => keyword.toLowerCase())),
    functions: contract.color_forms.functions.map((name) => name.toLowerCase()),
    namedColors: contract.namedColors,
    hex: new RegExp(contract.color_forms.hex_pattern),
    maxDepth: contract.limits.fold_depth,
  };
  cache.set(contract, rules);
  return rules;
}

// ---- pemecahan token ----

/** ECMAScript `\s`, sama dengan pemisah yang dihapus normalisasi token (`tokens.ts`). */
const WHITESPACE = /\s/;

/** Memecah `value` pada spasi dan koma di kedalaman kurung 0; token kosong dibuang. */
export function splitTopLevel(value: string): string[] {
  const tokens: string[] = [];
  let depth = 0;
  let start = 0;
  const flush = (end: number): void => {
    if (end > start) tokens.push(value.slice(start, end));
  };
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charAt(index);
    if (char === "(") depth += 1;
    else if (char === ")" && depth > 0) depth -= 1;
    else if (depth === 0 && (char === "," || WHITESPACE.test(char))) {
      flush(index);
      start = index + 1;
    }
  }
  flush(value.length);
  return tokens;
}

// ---- bentuk warna ----

/** Karakter yang membuat nama fungsi menjadi bagian dari identifier lain (`collab(` bukan `lab(`). */
const IDENT_CHAR = /[a-z0-9_-]/;

/**
 * Fungsi warna dari kontrak yang muncul di `text` sebagai fungsi tersendiri (karakter sebelumnya
 * bukan bagian identifier), tanpa memperhatikan huruf besar-kecil. Mengembalikan awalan dari kontrak
 * (mis. `rgb(`), atau `undefined`. Tidak membutuhkan `text` seluruhnya berupa warna.
 */
export function containsColorFunction(text: string, rules: ColorRules): string | undefined {
  const lower = text.toLowerCase();
  for (const name of rules.functions) {
    for (let at = lower.indexOf(name); at !== -1; at = lower.indexOf(name, at + 1)) {
      if (at === 0 || !IDENT_CHAR.test(lower.charAt(at - 1))) return name;
    }
  }
  return undefined;
}

/** Benar bila `text` (setelah trim) seluruhnya cocok `hex_pattern`. */
export function isHexColor(text: string, rules: ColorRules): boolean {
  return rules.hex.test(text.trim());
}

/** Fungsi CSS: `nama(` di awal dan `)` di akhir. Mengembalikan isi di antara kurung. */
const FUNCTION_TOKEN = /^[a-z_-][a-z0-9_-]*\(/i;

function functionArguments(token: string): string | undefined {
  if (!FUNCTION_TOKEN.test(token)) return undefined;
  const open = token.indexOf("(");
  return token.endsWith(")") ? token.slice(open + 1, -1) : token.slice(open + 1);
}

/**
 * Potongan nilai yang bukan warna Kit di dalam `value`, dalam urutan kemunculan. Daftar kosong
 * berarti `value` diterima. Untuk fungsi warna potongannya adalah awalan fungsi (`rgb(`), untuk
 * lainnya token apa adanya.
 */
export function colorViolations(value: string, rules: ColorRules, depth = 0): string[] {
  const found: string[] = [];
  for (const token of splitTopLevel(value)) {
    const lower = token.toLowerCase();
    if (rules.paletteVars.has(token)) continue;
    if (lower.startsWith("var(")) {
      found.push(token);
      continue;
    }
    if (rules.keywords.has(lower)) continue;
    if (rules.hex.test(token)) {
      found.push(token);
      continue;
    }
    const colorFunction = rules.functions.find((name) => lower.startsWith(name));
    if (colorFunction !== undefined) {
      found.push(colorFunction);
      continue;
    }
    if (rules.namedColors.has(lower)) {
      found.push(token);
      continue;
    }
    const inner = functionArguments(token);
    if (inner !== undefined && depth < rules.maxDepth) {
      for (const fragment of colorViolations(inner, rules, depth + 1)) found.push(fragment);
    }
  }
  return found;
}
