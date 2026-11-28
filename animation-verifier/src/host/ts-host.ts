// CompilerHost virtual untuk satu Main_File di memori (design 5.5 "Program kecil" dan 5.7; tugas 4.2).
// Main_File tidak pernah ada di disk: host hanya melayani satu jalur virtual dan menjawab "tidak ada"
// untuk semua jalur lain (termasuk lib, `react`, dan `remotion`). Dengan `noLib`, `noResolve`, dan
// `types: []` TypeChecker hanya memuat simbol yang dideklarasikan di `main.ts`, sehingga nama global
// seperti `window` tidak punya simbol sama sekali. Itulah dasar pembedaan "referensi ke global"
// versus "variabel lokal dengan ejaan sama" pada pemindaian kebijakan (Requirement 7.5, 7.15).
// `SourceFile` di-parse sekali per host lalu dipakai ulang untuk setiap `getSourceFile` (Program
// memanggilnya lebih dari sekali). Parse memakai `ScriptKind.TSX` supaya JSX dikenali dan dilaporkan
// (Requirement 7.3); `setParentNodes` aktif karena klasifikasi identifier menelusuri induk node.
// Host untuk typecheck (tugas 5.3; `createDiskBackedHost`): `main.ts` tetap virtual, tetapi berkas lib
// TypeScript dan deklarasi paket (`react`, `remotion`) dibaca dari disk, dan HANYA dari direktori yang
// disebut pemanggil (`readableRoots`). Jalur lain menjawab "tidak ada", sehingga resolusi modul tidak
// bisa membaca berkas di luar `node_modules` paket dan direktori lib. `SourceFile` hasil baca disk
// disimpan di `Map` milik pemanggil (variabel modul di `steps/typecheck.ts`) supaya invokasi hangat
// tidak mem-parse ulang lib; AST bersifat tidak berubah, jadi dipakai bersama antar Program (cara
// yang sama dipakai language service). Cache `main.ts` sengaja tidak lintas-invokasi: isinya berbeda
// untuk tiap permintaan.
// `createVirtualHost` dan `createVirtualProgram` (host tanpa disk, untuk pemindaian kebijakan) tidak
// membaca disk, jam, atau lingkungan. Tidak ada fungsi di sini yang melempar di batas modul.

import ts from "typescript";

/** Opsi Program untuk pemindaian kebijakan: tanpa lib, tanpa resolusi modul, tanpa paket tipe. */
export const POLICY_COMPILER_OPTIONS: Readonly<ts.CompilerOptions> = {
  noLib: true,
  noResolve: true,
  types: [],
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  // Setiap berkas dianggap modul (impor atau ekspor ada atau tidak), seperti saat di-bundle.
  moduleDetection: ts.ModuleDetectionKind.Force,
};

/** Satu berkas yang dilayani host. `path` harus absolut (diawali `/`). */
export interface VirtualFile {
  readonly path: string;
  readonly text: string;
  readonly scriptKind: ts.ScriptKind;
}

/** Jalur absolut virtual untuk nama berkas kontrak (`file_name`), mis. `main.ts` menjadi `/main.ts`. */
export function virtualPath(fileName: string): string {
  return `/${fileName}`;
}

/**
 * Host yang hanya mengenal `file.path`. Semua pencarian lain (berkas, direktori, lib) gagal
 * dengan tenang, sehingga resolusi modul tidak menyentuh disk.
 */
export function createVirtualHost(file: VirtualFile): ts.CompilerHost {
  let parsed: ts.SourceFile | undefined;
  return {
    getSourceFile(fileName, languageVersionOrOptions) {
      if (fileName !== file.path) return undefined;
      parsed ??= ts.createSourceFile(
        file.path,
        file.text,
        languageVersionOrOptions,
        /* setParentNodes */ true,
        file.scriptKind,
      );
      return parsed;
    },
    getDefaultLibFileName: () => "/lib.d.ts",
    writeFile: () => undefined,
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (fileName) => fileName === file.path,
    readFile: (fileName) => (fileName === file.path ? file.text : undefined),
    directoryExists: () => false,
    getDirectories: () => [],
  };
}

export interface DiskBackedHostOptions {
  /**
   * Direktori absolut (tanpa `/` di akhir) yang isinya boleh dibaca dari disk. Berkas, direktori,
   * dan `package.json` di bawahnya terlihat oleh compiler; semua jalur lain "tidak ada".
   */
  readonly readableRoots: readonly string[];
  /** Direktori `lib.*.d.ts` bawaan TypeScript; harus berada di bawah salah satu `readableRoots`. */
  readonly libDirectory: string;
  /** Cache `SourceFile` berkas disk, dimiliki pemanggil agar hidup lintas invokasi. */
  readonly sourceFileCache: Map<string, ts.SourceFile>;
}

/** Kunci cache: jalur, versi bahasa, dan format modul tersirat (menentukan bentuk AST yang dihasilkan). */
function sourceFileCacheKey(
  fileName: string,
  languageVersionOrOptions: ts.ScriptTarget | ts.CreateSourceFileOptions,
): string {
  const options =
    typeof languageVersionOrOptions === "number"
      ? { languageVersion: languageVersionOrOptions, impliedNodeFormat: undefined }
      : languageVersionOrOptions;
  return `${fileName}\u0000${options.languageVersion}\u0000${options.impliedNodeFormat ?? ""}`;
}

/**
 * Host untuk typecheck: `file` dilayani dari memori (seperti `createVirtualHost`) dan deklarasi
 * dibaca dari disk hanya di bawah `options.readableRoots`. Tidak ada `realpath`, jadi TypeScript
 * memakai jalur apa adanya (symlink `node_modules` ke tempat lain tidak mengubah jalur di Diagnostic).
 */
export function createDiskBackedHost(
  file: VirtualFile,
  options: DiskBackedHostOptions,
): ts.CompilerHost {
  const virtual = createVirtualHost(file);
  const { readableRoots, libDirectory, sourceFileCache } = options;

  // TypeScript menormalkan jalur sebelum memanggil host; pemeriksaan `..` hanya sabuk pengaman.
  const readable = (path: string): boolean =>
    !path.includes("/../") &&
    !path.endsWith("/..") &&
    readableRoots.some((root) => path === root || path.startsWith(`${root}/`));

  return {
    ...virtual,
    getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) {
      if (fileName === file.path) {
        return virtual.getSourceFile(
          fileName,
          languageVersionOrOptions,
          onError,
          shouldCreateNewSourceFile,
        );
      }
      if (!readable(fileName)) return undefined;
      const key = sourceFileCacheKey(fileName, languageVersionOrOptions);
      const cached = sourceFileCache.get(key);
      if (cached !== undefined) return cached;
      const text = ts.sys.readFile(fileName);
      if (text === undefined) return undefined;
      const parsed = ts.createSourceFile(
        fileName,
        text,
        languageVersionOrOptions,
        /* setParentNodes */ false,
      );
      sourceFileCache.set(key, parsed);
      return parsed;
    },
    getDefaultLibLocation: () => libDirectory,
    getDefaultLibFileName: (compilerOptions) => ts.getDefaultLibFilePath(compilerOptions),
    fileExists: (fileName) =>
      fileName === file.path || (readable(fileName) && ts.sys.fileExists(fileName)),
    readFile: (fileName) => {
      if (fileName === file.path) return file.text;
      return readable(fileName) ? ts.sys.readFile(fileName) : undefined;
    },
    directoryExists: (directory) => readable(directory) && ts.sys.directoryExists(directory),
    getDirectories: (directory) => (readable(directory) ? ts.sys.getDirectories(directory) : []),
  };
}

export interface VirtualProgram {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly sourceFile: ts.SourceFile;
}

export type VirtualProgramResult =
  | ({ ok: true } & VirtualProgram)
  | { ok: false; reason: string };

/**
 * Membuat Program untuk satu berkas virtual. Gagal (`ok: false`) hanya bila Program tidak memuat
 * berkas itu, yang berarti galat pemrograman di pemanggil; alasan tidak memuat teks sumber.
 * `host` bawaannya host tanpa disk; typecheck memberi `createDiskBackedHost`.
 */
export function createVirtualProgram(
  file: VirtualFile,
  options: Readonly<ts.CompilerOptions> = POLICY_COMPILER_OPTIONS,
  host: ts.CompilerHost = createVirtualHost(file),
): VirtualProgramResult {
  const program = ts.createProgram({
    rootNames: [file.path],
    options: { ...options },
    host,
  });
  const sourceFile = program.getSourceFile(file.path);
  if (sourceFile === undefined) return { ok: false, reason: "virtual file was not loaded" };
  return { ok: true, program, checker: program.getTypeChecker(), sourceFile };
}
