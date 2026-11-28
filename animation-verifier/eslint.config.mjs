// Konfigurasi flat INTERNAL untuk langkah 3 (ESLint) pada Main_File (design 5.6; Requirement 8.1,
// 8.10). Ini bukan konfigurasi untuk kode paket verifier sendiri: itu `eslint.package.config.mjs`.
// `steps/lint.ts` memuat berkas ini sebagai objek dan meneruskannya ke `new ESLint({
// overrideConfigFile: true, overrideConfig })`, jadi ESLint tidak pernah mencari konfigurasi di disk.
// Aturannya: `eslint:recommended` dan `@typescript-eslint/recommended` (tanpa aturan type-aware,
// karena tidak ada `parserOptions.project`), ditambah tiga aturan plugin lokal `lore`.
// `noInlineConfig: true` mematikan komentar `eslint-disable` dan kawan-kawannya; komentar itu
// dilaporkan terpisah sebagai `ESLINT_INLINE_DIRECTIVE` oleh pemindai komentar di `lint.ts`.
// Opsi `lore/kit-style` (`kit_style_warnings`, `font_variables`) bukan dari berkas ini: kontrak
// adalah satu-satunya tempat daftar itu ditulis (Requirement 2.6), jadi `lint.ts` menyuntikkannya
// dari kontrak yang dimuat ke aturan itu; di sini aturan hanya dinyalakan sebagai `warn`.
// Plugin diimpor sebagai `./eslint-plugin-lore/index.js`: berkas hasil kompilasi di `dist/`
// (`npm run build` mengompilasi plugin ke `dist/eslint-plugin-lore/`, dan image Lambda menyalin
// berkas ini ke `dist/`). Di pohon sumber hanya ada `index.ts`; Vite (dipakai Vitest) me-resolve
// `index.js` ke `index.ts`, sedangkan menjalankan berkas ini langsung dengan Node di pohon sumber
// tidak didukung (`ERR_MODULE_NOT_FOUND`).
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import lore from "./eslint-plugin-lore/index.js";

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    plugins: { lore },
    languageOptions: { parser: tseslint.parser, sourceType: "module", ecmaVersion: 2022 },
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "off" },
    rules: {
      "lore/no-module-state": "error",
      "lore/uses-frame": "error",
      "lore/kit-style": "warn",
    },
  },
];
