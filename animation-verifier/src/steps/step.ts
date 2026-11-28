// Kontrak langkah pipeline verifier (design 5.1 dan 5.3; Requirement 6.4 sampai 6.7, 6.10, 6.16).
// `verify.ts` hanya mengenal bentuk di berkas ini: tiap langkah 1 sampai 7 adalah satu objek
// `VerifierStep` (`number` + `run`) yang didaftarkan di `registry.ts`. Dengan begitu tugas 4.1
// sampai 7.1 cukup mengekspor satu langkah dan mendaftarkannya, tanpa menyentuh alur, deadline,
// pemotongan, atau penyusunan `summary`. `number` menentukan urutan dan nama di `summary.checks`
// (tabel `STEP_TOOL`); urutan di daftar registri tidak berpengaruh.
// Langkah yang membuktikan sesuatu untuk langkah berikutnya (meta statis dari langkah 2, bundle
// dari langkah 5, tangkapan frame dari langkah 6) menaruhnya di `ArtifactStore` lewat kunci bertipe,
// sehingga `verify.ts` tidak perlu tahu bentuk keluaran langkah yang belum ditulis. Modul ini
// murni: tanpa `Date`, `Math.random`, atau iterasi `Map`/`Set`, dan tanpa throw di batas modul.

import type { Clock } from "../clock.js";
import type { Contract } from "../contract.js";
import { makeDiagnostic, type DiagnosticLocation } from "../diagnostics.js";
import type { Diagnostic, MainMeta, Severity, Tool, VerifierInput } from "../types.js";

/** Nomor langkah menurut Requirement 6.4. */
export type StepNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Urutan eksekusi tetap; satu-satunya urutan yang dipakai pipeline. */
export const STEP_NUMBERS: readonly StepNumber[] = [1, 2, 3, 4, 5, 6, 7];

/** Nama langkah di `summary.checks[].name` (Requirement 6.16). */
export const STEP_TOOL: Readonly<Record<StepNumber, Tool>> = {
  1: "size",
  2: "policy",
  3: "eslint",
  4: "tsc",
  5: "esbuild",
  6: "render",
  7: "fidelity",
};

// ---- artefak antar-langkah ----

/** Kunci bertipe: `T` hanya ada di tipe, sehingga `get` dan `set` tidak butuh cast di pemanggil. */
export interface ArtifactKey<T> {
  readonly id: string;
  /** Hanya pembawa tipe; tidak pernah diisi. */
  readonly valueType?: T;
}

export function artifactKey<T>(id: string): ArtifactKey<T> {
  return { id };
}

/** Main_Meta statis yang tervalidasi; diisi langkah 2, dibaca langkah 6 dan 7 dan hasil akhir. */
export const META_ARTIFACT: ArtifactKey<MainMeta> = artifactKey<MainMeta>("meta");

/** Teks `main.js`; diisi langkah 5, dibaca langkah 6 dan hasil akhir. */
export const BUNDLE_ARTIFACT: ArtifactKey<string> = artifactKey<string>("bundle");

/**
 * Penampung artefak untuk satu invokasi. Hanya diakses lewat `get` dan `set` (kunci), tidak
 * pernah diiterasi, sehingga urutan penyisipan tidak memengaruhi keluaran.
 */
export class ArtifactStore {
  private readonly values = new Map<string, unknown>();

  get<T>(key: ArtifactKey<T>): T | undefined {
    return this.values.get(key.id) as T | undefined;
  }

  set<T>(key: ArtifactKey<T>, value: T): void {
    this.values.set(key.id, value);
  }
}

// ---- langkah ----

/** Semua yang boleh dibaca sebuah langkah. Satu objek per invokasi, dipakai bersama oleh semua langkah. */
export interface StepContext {
  readonly input: VerifierInput;
  readonly contract: Contract;
  readonly clock: Clock;
  /**
   * Waktu `clock.now()` saat deadline total habis (`limits.verifier_deadline_ms` sejak mulai).
   * Langkah panjang (langkah 6) memeriksanya sebelum setiap frame; bila sudah lewat, langkah
   * mengembalikan Diagnostic `VERIFIER_DEADLINE` dan pipeline berhenti setelahnya.
   */
  readonly deadlineAt: number;
  readonly artifacts: ArtifactStore;
  /**
   * Membuat Diagnostic dengan batas pesan dari kontrak (`diagnostic_message_max_chars`).
   * Langkah memakai ini, bukan `makeDiagnostic` langsung, agar batas tidak pernah terlupa.
   */
  diagnostic(
    code: string,
    severity: Severity,
    message: string,
    loc?: DiagnosticLocation,
  ): Diagnostic;
}

/**
 * Hasil satu langkah. `ok` langkah itu dihitung `verify.ts` dari `diagnostics` (ada `error` atau
 * tidak); langkah tidak melaporkannya sendiri supaya `summary.checks[].ok` tidak bisa menyimpang.
 */
export interface StepResult {
  readonly diagnostics: readonly Diagnostic[];
}

export interface VerifierStep {
  readonly number: StepNumber;
  /**
   * Menjalankan langkah. Kegagalan yang berasal dari masukan pengarang dilaporkan sebagai
   * Diagnostic. Exception hanya untuk galat internal; `safeVerify` mengubahnya menjadi satu
   * `VERIFIER_INTERNAL`.
   */
  run(context: StepContext): StepResult | Promise<StepResult>;
}

/** Pembuat `StepContext`; dipisah agar tes dapat membuat konteks tanpa menjalankan pipeline. */
export function createStepContext(parts: {
  input: VerifierInput;
  contract: Contract;
  clock: Clock;
  deadlineAt: number;
  artifacts?: ArtifactStore;
}): StepContext {
  const maxChars = parts.contract.limits.diagnostic_message_max_chars;
  return {
    input: parts.input,
    contract: parts.contract,
    clock: parts.clock,
    deadlineAt: parts.deadlineAt,
    artifacts: parts.artifacts ?? new ArtifactStore(),
    diagnostic: (code, severity, message, loc) =>
      makeDiagnostic(code, severity, message, loc, maxChars),
  };
}

// ---- registri ----

export type IndexStepsResult =
  | { ok: true; byNumber: ReadonlyMap<StepNumber, VerifierStep> }
  | { ok: false; reason: string };

function isStepNumber(value: unknown): value is StepNumber {
  return STEP_NUMBERS.some((number) => number === value);
}

/**
 * Menyusun daftar langkah menjadi pencarian menurut nomor. Daftar dengan nomor di luar 1 sampai 7
 * atau nomor ganda adalah galat pemrograman: hasilnya `{ ok: false }`, bukan langkah yang diam-diam
 * menimpa langkah lain. Peta hasil hanya dibaca dengan `get(nomor)` menurut `STEP_NUMBERS`.
 */
export function indexSteps(steps: readonly VerifierStep[]): IndexStepsResult {
  const byNumber = new Map<StepNumber, VerifierStep>();
  for (const step of steps) {
    if (!isStepNumber(step.number)) return { ok: false, reason: "step number is out of range" };
    if (byNumber.has(step.number)) return { ok: false, reason: `step ${step.number} is registered twice` };
    byNumber.set(step.number, step);
  }
  return { ok: true, byNumber };
}
