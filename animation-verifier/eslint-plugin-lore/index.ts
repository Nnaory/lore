// Plugin ESLint lokal `lore` (design 5.6): tiga aturan yang memeriksa Main_File pada langkah 3
// verifier. `no-module-state` dan `uses-frame` menjaga keluaran hanya bergantung pada nomor frame,
// `kit-style` memberi peringatan untuk gaya di luar Kit.
// Ekspor `default` adalah objek plugin flat-config (`meta`, `rules`), dipasang sebagai
// `plugins: { lore }`. Berkas ini sengaja tidak mengimpor apa pun di luar `eslint-plugin-lore/`
// dan tidak bergantung pada vitest, supaya direktori ini dapat dikompilasi sendiri ke `dist/` dan
// dimuat oleh `eslint.config.mjs` di runtime Lambda (design 5.13). Kontrak kit masuk lewat opsi
// aturan `lore/kit-style`, bukan lewat impor JSON.

import type { ESLint } from "eslint";
import { kitStyle } from "./rules/kit-style.js";
import { noModuleState } from "./rules/no-module-state.js";
import { usesFrame } from "./rules/uses-frame.js";

export type { KitStyleOptions } from "./rules/kit-style.js";

const plugin = {
  meta: { name: "eslint-plugin-lore", namespace: "lore" },
  rules: {
    "no-module-state": noModuleState,
    "uses-frame": usesFrame,
    "kit-style": kitStyle,
  },
} satisfies ESLint.Plugin;

export default plugin;
