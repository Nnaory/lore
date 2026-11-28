// Versi yang dicatat di `summary` setiap Verifier_Result (design 5.2; Requirement 6.10, 6.14, 3.7):
// `verifier_version` dibaca dari `package.json` paket ini, dan `runtime_version` dari `package.json`
// paket `react` dan `remotion` yang benar-benar terpasang di `node_modules` (bukan dari pin), supaya
// berkas yang lolos selalu tercatat dengan versi runtime yang dipakai untuk membuktikannya.
// Modul ini total: kegagalan baca menjadi `{ ok: false }`, tidak throw. Hasil sukses disimpan di
// variabel modul karena versi tidak berubah selama proses hidup.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

export interface VersionInfo {
  verifier_version: string;
  runtime_version: { react: string; remotion: string };
}

export type LoadVersionsResult = { ok: true; versions: VersionInfo } | { ok: false; reason: string };

/** Nilai pengganti bila versi tidak terbaca; hanya dipakai di hasil `VERIFIER_INTERNAL`. */
export const UNKNOWN_VERSION = "unknown";

export const UNKNOWN_VERSIONS: VersionInfo = {
  verifier_version: UNKNOWN_VERSION,
  runtime_version: { react: UNKNOWN_VERSION, remotion: UNKNOWN_VERSION },
};

/** `package.json` paket ini: `../package.json` dari `src/` (tes) maupun `dist/` (image Lambda). */
const OWN_PACKAGE_JSON = new URL("../package.json", import.meta.url);

function versionOf(manifest: unknown): string | undefined {
  if (typeof manifest !== "object" || manifest === null) return undefined;
  const version = (manifest as { version?: unknown }).version;
  return typeof version === "string" && version.length > 0 ? version : undefined;
}

let cached: VersionInfo | undefined;

/** Membaca versi verifier dan runtime terpasang. Hasil sukses di-cache selama proses hidup. */
export function loadVersionInfo(): LoadVersionsResult {
  if (cached !== undefined) return { ok: true, versions: cached };
  try {
    const resolve = createRequire(import.meta.url);
    const verifier = versionOf(JSON.parse(readFileSync(OWN_PACKAGE_JSON, "utf8")));
    const react = versionOf(resolve("react/package.json"));
    const remotion = versionOf(resolve("remotion/package.json"));
    if (verifier === undefined) return { ok: false, reason: "package.json has no version" };
    if (react === undefined || remotion === undefined) {
      return { ok: false, reason: "react or remotion package.json has no version" };
    }
    cached = { verifier_version: verifier, runtime_version: { react, remotion } };
    return { ok: true, versions: cached };
  } catch {
    return { ok: false, reason: "package versions could not be read" };
  }
}
