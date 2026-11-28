// Tipe untuk `eslint.config.mjs` (konfigurasi internal langkah 3). Berkas `.mjs` itu JavaScript
// biasa tanpa tipe, jadi `steps/lint.ts` membaca tipenya dari deklarasi ini lewat
// `typeof import("../../eslint.config.mjs")`. Sengaja berupa `.d.mts` dan bukan `allowJs`:
// `allowJs` akan menyeret `.mjs` ke dalam keluaran `tsc` dan menggeser `rootDir` (hasil build
// berubah dari `dist/handler.js` menjadi `dist/src/handler.js`), sedangkan berkas deklarasi
// tidak memengaruhi `rootDir` dan tidak ikut dipancarkan.
import type { Linter } from "eslint";

declare const config: Linter.Config[];
export default config;
