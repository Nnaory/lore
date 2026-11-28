// Pembantu tes: mengompilasi Worker render (`src/steps/render-worker.ts`) dan host-nya
// (`src/steps/render-host.ts`) dengan compiler TypeScript ke direktori sementara, supaya tes dapat
// menjalankan Worker NYATA dari hasil `tsc` (JavaScript), bukan dari `.ts` (Worker tidak bisa memuat
// `.ts`; ledger 6.1). Dipakai tugas 6.2 dan 6.3 dan dapat dipakai ulang tugas 8.2.
// Direktori sementara dibuat di `dist/` paket (diabaikan git), BUKAN di `os.tmpdir()`: modul `react`,
// `jsdom`, dan seterusnya di-resolve dari lokasi berkas hasil kompilasi, jadi berkas itu harus berada
// di bawah paket (`node_modules` paket ini) dan di bawah `package.json` bertipe `module`. Opsi
// kompilasi dibaca dari `tsconfig.json` yang sama dengan `npm run build`; hanya `outDir` yang diganti.
// `hostUrl` (tugas 6.3) adalah `render-host.js` hasil kompilasi, untuk tes yang menjalankan host
// di PROSES TERPISAH (mis. memeriksa stdout proses yang sebenarnya); `createWorkerRenderHost()` di
// sana memakai `render-worker.js` di sebelahnya tanpa opsi `workerUrl`.
// Beberapa berkas tes dapat memakai pembantu ini bersamaan (Vitest menjalankan berkas paralel):
// tiap pemanggil mendapat direktori `mkdtemp` sendiri, `dist/` dibuat ulang bila dihapus pemanggil
// lain di antara dua langkah, dan `dispose()` menghapus `dist/` hanya bila sudah kosong.

import { mkdirSync, mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export interface CompiledRenderWorker {
  /** `render-worker.js` hasil kompilasi, untuk `createWorkerRenderHost({ workerUrl })`. */
  readonly workerUrl: URL;
  /** `render-host.js` hasil kompilasi (tugas 6.3). */
  readonly hostUrl: URL;
  /** Menghapus hasil kompilasi. Aman dipanggil berkali-kali. */
  dispose(): void;
}

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WORKER_SOURCE = join(PACKAGE_ROOT, "src", "steps", "render-worker.ts");
const HOST_SOURCE = join(PACKAGE_ROOT, "src", "steps", "render-host.ts");
const MKDTEMP_ATTEMPTS = 3;

/** `mkdtemp` di `dist/`; mengulang bila pemanggil lain menghapus `dist/` yang kosong di antara dua langkah. */
function makeOutDir(distDir: string): string {
  let lastError: unknown;
  for (let attempt = 0; attempt < MKDTEMP_ATTEMPTS; attempt += 1) {
    try {
      mkdirSync(distDir, { recursive: true });
      return mkdtempSync(join(distDir, ".render-worker-test-"));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export function compileRenderWorker(): CompiledRenderWorker {
  const distDir = join(PACKAGE_ROOT, "dist");
  const outDir = makeOutDir(distDir);

  const dispose = (): void => {
    rmSync(outDir, { recursive: true, force: true });
    try {
      rmdirSync(distDir); // gagal bila masih ada isi (build asli atau direktori pemanggil lain)
    } catch {
      // `dist/` tidak kosong atau sudah dihapus pemanggil lain.
    }
  };

  try {
    const configPath = join(PACKAGE_ROOT, "tsconfig.json");
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error !== undefined) throw new Error("tsconfig.json could not be read");
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, PACKAGE_ROOT, undefined, configPath);
    const program = ts.createProgram({
      rootNames: [WORKER_SOURCE, HOST_SOURCE],
      options: {
        ...parsed.options,
        outDir,
        rootDir: join(PACKAGE_ROOT, "src"),
        noEmit: false,
        noEmitOnError: false,
        declaration: false,
      },
    });
    if (program.emit().emitSkipped) throw new Error("the render worker was not emitted");
    return {
      workerUrl: pathToFileURL(join(outDir, "steps", "render-worker.js")),
      hostUrl: pathToFileURL(join(outDir, "steps", "render-host.js")),
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
