// Konfigurasi lint untuk kode paket verifier sendiri (dipakai `npm run lint` dan job CI `verifier`).
// Sengaja bukan `eslint.config.mjs`: nama itu dicadangkan untuk konfigurasi internal yang
// dipakai langkah 3 untuk memeriksa Main_File (tugas 5.2, Catatan N-1). Fixture berisi
// Main_File yang sengaja salah, jadi tidak ikut di-lint sebagai kode paket.
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["dist/**", "node_modules/**", "fixtures/**"]),
  js.configs.recommended,
  ...tseslint.configs.recommended,
]);
