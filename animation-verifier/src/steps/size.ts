// Langkah 1 pipeline verifier: ukuran dan encoding sumber (design 5.4 dan tabel 5.12; Requirement
// 7.1, 7.2, 7.18, 6.5, 1.1, 1.12, 1.14, 38.10).
// Urutan pemeriksaan sengaja tetap: (a) ukuran UTF-8 dibandingkan dengan `limits.source_max_bytes`
// dari kontrak (bukan literal); bila melebihi, hanya `SIZE_SOURCE_TOO_LARGE` yang dilaporkan dan
// encoding TIDAK diperiksa (Requirement 7.18). Tepat sebesar batas masih lolos. (b) Baru bila ukuran
// sah, `source` yang memuat NUL, lone surrogate, atau BOM di indeks 0 melapor satu
// `ENCODING_INVALID`. File kosong, spasi saja, atau komentar saja lolos di sini; langkah 2 yang
// melaporkan `POLICY_META_INVALID` dan `POLICY_EXPORT_MISSING` untuknya (Requirement 1.14).
// Ukuran dihitung dalam byte UTF-8, bukan panjang string, sehingga emoji (4 byte, 2 unit UTF-16)
// dan huruf berakses (2 byte) dihitung sebagaimana S3 dan backend menghitungnya. Modul ini murni:
// tanpa `Date`, `Math.random`, atau throw di batas modul.

import type { VerifierStep } from "./step.js";

const NUL = "\u0000";
const BOM = "\uFEFF";

/**
 * Surrogat tinggi tanpa surrogat rendah sesudahnya, atau surrogat rendah tanpa surrogat tinggi
 * sebelumnya. Tanpa flag `u` agar string dibaca per unit UTF-16, yang justru dibutuhkan untuk
 * mendeteksi pasangan yang rusak. Tanpa flag `g` atau `y` agar `test()` tidak menyimpan status.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Ukuran `source` dalam byte UTF-8. Lone surrogate dihitung 3 byte (U+FFFD), seperti saat dikirim. */
export function utf8ByteLength(source: string): number {
  return Buffer.byteLength(source, "utf8");
}

/**
 * Benar bila `source` memuat NUL, lone surrogate, atau BOM di indeks 0. U+FEFF di indeks lain
 * adalah spasi ECMAScript biasa (ZWNBSP) dan bukan BOM, jadi tidak dilaporkan.
 */
export function hasInvalidEncoding(source: string): boolean {
  return source.startsWith(BOM) || source.includes(NUL) || LONE_SURROGATE.test(source);
}

export const sizeStep: VerifierStep = {
  number: 1,
  run(context) {
    const { source } = context.input;
    const maxBytes = context.contract.limits.source_max_bytes;

    const bytes = utf8ByteLength(source);
    if (bytes > maxBytes) {
      return {
        diagnostics: [
          context.diagnostic(
            "SIZE_SOURCE_TOO_LARGE",
            "error",
            `source is ${bytes} bytes, limit is ${maxBytes}`,
          ),
        ],
      };
    }

    if (hasInvalidEncoding(source)) {
      return {
        diagnostics: [
          context.diagnostic(
            "ENCODING_INVALID",
            "error",
            "source contains NUL, a lone surrogate, or a BOM",
          ),
        ],
      };
    }

    return { diagnostics: [] };
  },
};
