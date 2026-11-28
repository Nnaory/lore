// Konfigurasi Vitest paket verifier: semua tes berjalan di Node (tanpa DOM global).
// Tes yang butuh jsdom memasangnya sendiri; korpus fixture dibaca dari disk oleh tesnya.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
