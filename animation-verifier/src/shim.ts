// Shim `require` untuk bundle Main_File yang dievaluasi di konteks `vm` (design 5.9 langkah 4,
// Requirement 9.1 dan 11.12). Bundle esbuild berformat CJS memanggil `require("react")` dan
// `require("remotion")` untuk impor yang tidak dibundel; shim ini adalah satu-satunya pintu keluar
// dari konteks `vm`, jadi ia hanya mengembalikan objek beku berisi nama yang diizinkan kontrak
// (`allowed_imports[modul].values`) dan melempar untuk id lain, termasuk `fs`, `node:fs`, subpath
// seperti `react/jsx-runtime`, dan nama prototipe seperti `constructor`.
// Modul yang dibungkus adalah milik Worker (realm luar), supaya React, `remotion`, dan
// `@remotion/player` berbagi satu instans konteks. Pembuatan shim total: kegagalan konfigurasi
// dikembalikan sebagai `{ ok: false }`; hanya fungsi `require` hasilnya yang melempar, karena itu
// kontrak `require` yang diharapkan bundle (Requirement 11.12).

/** Bagian kontrak yang dibaca shim. `Contract` penuh juga memenuhi bentuk ini. */
export interface ShimSpec {
  readonly allowed_imports: Readonly<Record<string, { readonly values: readonly string[] }>>;
}

/** Modul milik Worker, menurut id (`react`, `remotion`), tempat nama yang diizinkan diambil. */
export type HostModules = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/** Fungsi yang dipasang sebagai `require` global konteks bundle. */
export type RequireShim = (id: unknown) => unknown;

export type CreateShimResult =
  | { ok: true; require: RequireShim }
  | { ok: false; reason: string };

/** Panjang id yang disalin ke pesan galat, agar pesan tetap pendek. */
const MAX_ID_CHARS = 60;

function describeId(id: unknown): string {
  return typeof id === "string" ? JSON.stringify(id.slice(0, MAX_ID_CHARS)) : `of type ${typeof id}`;
}

/**
 * Membangun `require` dari `spec.allowed_imports` dan modul Worker `host`. Tiap modul diekspos
 * sebagai objek beku tanpa prototipe yang hanya memuat nama di `values`. Nama yang tidak ada di
 * modul Worker menggagalkan pembuatan (versi paket dan kontrak tidak selaras), bukan diam-diam
 * hilang, supaya kesalahan konfigurasi tidak tampak sebagai galat kode pengarang.
 */
export function createRequireShim(spec: ShimSpec, host: HostModules): CreateShimResult {
  const table = new Map<string, Readonly<Record<string, unknown>>>();

  for (const [id, allowed] of Object.entries(spec.allowed_imports)) {
    const source = Object.hasOwn(host, id) ? host[id] : undefined;
    if (source === undefined) return { ok: false, reason: `host module ${JSON.stringify(id)} is not loaded` };

    const exposed: Record<string, unknown> = Object.create(null);
    for (const name of allowed.values) {
      const value = source[name];
      if (value === undefined) {
        return { ok: false, reason: `host module ${JSON.stringify(id)} has no export ${JSON.stringify(name)}` };
      }
      exposed[name] = value;
    }
    table.set(id, Object.freeze(exposed));
  }

  const shimRequire: RequireShim = (id) => {
    const found = typeof id === "string" ? table.get(id) : undefined;
    if (found === undefined) throw new Error(`module ${describeId(id)} is not available`);
    return found;
  };
  return { ok: true, require: Object.freeze(shimRequire) };
}
