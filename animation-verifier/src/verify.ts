// Orkestrasi verifier: dari event mentah ke Verifier_Result (design 5.3; Requirement 6.1 sampai
// 6.7, 6.9, 6.10, 6.11, 6.13, 6.14, 6.16).
// Urutan kerja `verify`: (1) `parseInput` memvalidasi lima kunci masukan; (2) `contract_version`
// dibandingkan dengan salinan kontrak milik verifier; (3) tujuh langkah dijalankan menurut nomor
// dengan aturan alir bagian 5.3 butir 4 dan deadline berbasis `Clock`; (4) `finalize` menghitung
// `ok` SEBELUM memotong ke `diagnostics_max`, lalu mengurutkan; (5) `bundle` dan `meta` hanya
// disertakan bila `ok`; (6) `summary` memuat versi, `checks`, dan `truncated`.
//
// Gagal tertutup: `ok: true` hanya dikembalikan bila ketujuh langkah benar-benar berjalan dan
// menghasilkan bundle serta meta. Langkah yang belum terdaftar tidak diganti stub; pipeline yang
// tidak lengkap menghasilkan `VERIFIER_INTERNAL`, sehingga berkas yang belum dibuktikan tidak
// pernah dilaporkan lolos.
//
// `safeVerify` adalah batas modul: exception apa pun (dari langkah, jam, atau kode ini) menjadi
// tepat satu Diagnostic `VERIFIER_INTERNAL` tanpa teks exception, karena teks itu bisa memuat
// sumber. Jalur keluaran tidak memakai `Date`, `Math.random`, atau iterasi `Set`/`Map`: semua
// urutan eksplisit (`STEP_NUMBERS`, `orderForOutput`), dan durasi hanya masuk ke `checks[].ms`.

import { z } from "zod";
import type { Clock } from "./clock.js";
import type { Contract } from "./contract.js";
import { DEFAULT_MESSAGE_MAX_CHARS, finalize, makeDiagnostic } from "./diagnostics.js";
import { DEFAULT_STEPS } from "./steps/registry.js";
import {
  ArtifactStore,
  BUNDLE_ARTIFACT,
  META_ARTIFACT,
  STEP_NUMBERS,
  STEP_TOOL,
  createStepContext,
  indexSteps,
  type StepNumber,
  type VerifierStep,
} from "./steps/step.js";
import type {
  CheckSummary,
  Diagnostic,
  VerifierInput,
  VerifierResult,
  VerifierSummary,
} from "./types.js";
import { UNKNOWN_VERSIONS, loadVersionInfo, type VersionInfo } from "./versions.js";

// ---- masukan ----

/** Batas larik token pada Requirement 6.2: hanya perisai, skema `visual` menghasilkan jauh lebih sedikit. */
export const MAX_TOKENS = 200;
export const MAX_TOKEN_CHARS = 400;

const TokenListSchema = z.array(z.string().max(MAX_TOKEN_CHARS)).max(MAX_TOKENS);

/**
 * Lima kunci masukan. Bidang tambahan dibuang, bukan ditolak (Requirement 6.2); inilah yang
 * dimaksud "strict" pada design 5.3: tidak ada kunci selain kelima ini yang sampai ke langkah.
 */
const InputSchema = z.object({
  source: z.string(),
  kind: z.enum(["lesson", "puzzle"]),
  required_tokens: TokenListSchema,
  forbidden_tokens: TokenListSchema,
  contract_version: z.number().int().min(1),
});

export type ParseInputResult = { ok: true; input: VerifierInput } | { ok: false };

/** Total: event apa pun (termasuk objek dengan getter yang melempar) menghasilkan union, tanpa throw. */
export function parseInput(event: unknown): ParseInputResult {
  try {
    const parsed = InputSchema.safeParse(event);
    return parsed.success ? { ok: true, input: parsed.data } : { ok: false };
  } catch {
    return { ok: false };
  }
}

// ---- kode dan pesan Diagnostic milik orkestrator (tabel 5.12) ----

const BAD_INPUT_MESSAGE = "event does not match the input schema";
const INTERNAL_MESSAGE = "internal verifier error";
const DEADLINE_MESSAGE = "verification deadline reached";
const DEADLINE_CODE = "VERIFIER_DEADLINE";

/** Nilai `summary.contract_version` bila kontrak tidak terbaca sama sekali. */
export const UNKNOWN_CONTRACT_VERSION = 0;

// ---- dependensi ----

export interface VerifyDeps {
  readonly clock: Clock;
  readonly contract: Contract;
  /**
   * Langkah yang dijalankan. Bawaannya `DEFAULT_STEPS` (registri produksi). Langkah 6 membawa
   * `RenderHost`-nya sendiri, jadi tes menyuntikkan host palsu dengan membuat langkah itu sendiri.
   */
  readonly steps?: readonly VerifierStep[];
  /** Bawaannya dibaca dari paket terpasang (`loadVersionInfo`). */
  readonly versions?: VersionInfo;
}

// ---- ringkasan dan hasil ----

function makeSummary(
  contractVersion: number,
  versions: VersionInfo,
  checks: readonly CheckSummary[],
  truncated: boolean,
): VerifierSummary {
  return {
    verifier_version: versions.verifier_version,
    contract_version: contractVersion,
    runtime_version: {
      react: versions.runtime_version.react,
      remotion: versions.runtime_version.remotion,
    },
    checks: checks.map((check) => ({ name: check.name, ok: check.ok, ms: check.ms })),
    truncated,
  };
}

function failure(diagnostics: Diagnostic[], summary: VerifierSummary): VerifierResult {
  return { ok: false, diagnostics, summary };
}

/**
 * Hasil galat internal: tepat satu `VERIFIER_INTERNAL`, tanpa `bundle` dan `meta`, `checks`
 * kosong secara bawaan. Dipakai `safeVerify`, `verify` (pipeline tidak lengkap), dan handler
 * (kontrak tidak terbaca). Total: hanya memakai nilai yang diberikan dan `loadVersionInfo`.
 */
export function internalFailure(
  contractVersion: number,
  versions?: VersionInfo,
  maxChars: number = DEFAULT_MESSAGE_MAX_CHARS,
  checks: readonly CheckSummary[] = [],
): VerifierResult {
  const resolved = versions ?? resolveVersions();
  return failure(
    [makeDiagnostic("VERIFIER_INTERNAL", "error", INTERNAL_MESSAGE, undefined, maxChars)],
    makeSummary(contractVersion, resolved ?? UNKNOWN_VERSIONS, checks, false),
  );
}

function resolveVersions(): VersionInfo | undefined {
  const loaded = loadVersionInfo();
  return loaded.ok ? loaded.versions : undefined;
}

// ---- aturan alir ----

type StepStatus = "clean" | "error";
type StatusTable = Partial<Record<StepNumber, StepStatus>>;

/**
 * Aturan alir bagian 5.3 butir 4. Langkah 1 selalu; langkah 2, 3, 4 bersama bila langkah 1 bersih;
 * langkah 5 bila langkah 1 sampai 4 tanpa galat; langkah 6 hanya bila langkah 5 berjalan dan
 * sukses; langkah 7 hanya bila langkah 6 berjalan dan tanpa galat. "Bersih" berarti tanpa
 * Diagnostic `error` (warning tidak menghalangi). Langkah yang belum terdaftar tidak punya status,
 * sehingga langkah yang bergantung padanya (5 pada 1, 6 pada 5, 7 pada 6) tidak berjalan.
 */
function mayRun(step: StepNumber, status: StatusTable): boolean {
  switch (step) {
    case 1:
      return true;
    case 2:
    case 3:
    case 4:
      return status[1] === "clean";
    case 5:
      return (
        status[1] === "clean" &&
        status[2] !== "error" &&
        status[3] !== "error" &&
        status[4] !== "error"
      );
    case 6:
      return status[5] === "clean";
    case 7:
      return status[6] === "clean";
  }
}

/** Milidetik utuh tak negatif; selisih tidak sah (jam tes yang mundur atau NaN) menjadi 0. */
function elapsedMs(clock: Clock, startedAt: number): number {
  const elapsed = clock.now() - startedAt;
  return Number.isFinite(elapsed) && elapsed > 0 ? Math.round(elapsed) : 0;
}

// ---- pipeline ----

/**
 * Menjalankan pipeline untuk satu event. Tidak melempar karena masukan pengarang (itu
 * Diagnostic); exception hanya muncul dari galat internal dan ditangkap `safeVerify`.
 */
export async function verify(event: unknown, deps: VerifyDeps): Promise<VerifierResult> {
  const { clock, contract } = deps;
  const maxChars = contract.limits.diagnostic_message_max_chars;
  const versions = deps.versions ?? resolveVersions();
  if (versions === undefined) return internalFailure(contract.contract_version, undefined, maxChars);

  const noChecks = (): VerifierSummary => makeSummary(contract.contract_version, versions, [], false);

  // (1) masukan
  const parsed = parseInput(event);
  if (!parsed.ok) {
    return failure(
      [makeDiagnostic("VERIFIER_BAD_INPUT", "error", BAD_INPUT_MESSAGE, undefined, maxChars)],
      noChecks(),
    );
  }
  const input = parsed.input;

  // (2) versi kontrak
  if (input.contract_version !== contract.contract_version) {
    return failure(
      [
        makeDiagnostic(
          "VERIFIER_CONTRACT_MISMATCH",
          "error",
          `contract_version ${input.contract_version} differs from verifier ${contract.contract_version}`,
          undefined,
          maxChars,
        ),
      ],
      noChecks(),
    );
  }

  const indexed = indexSteps(deps.steps ?? DEFAULT_STEPS);
  if (!indexed.ok) return internalFailure(contract.contract_version, versions, maxChars);

  // (3) langkah
  const deadlineAt = clock.now() + contract.limits.verifier_deadline_ms;
  const artifacts = new ArtifactStore();
  const context = createStepContext({ input, contract, clock, deadlineAt, artifacts });
  const collected: Diagnostic[] = [];
  const checks: CheckSummary[] = [];
  const status: StatusTable = {};

  for (const number of STEP_NUMBERS) {
    const step = indexed.byNumber.get(number);
    if (step === undefined || !mayRun(number, status)) continue;

    if (clock.now() >= deadlineAt) {
      collected.push(makeDiagnostic(DEADLINE_CODE, "error", DEADLINE_MESSAGE, undefined, maxChars));
      break;
    }

    const startedAt = clock.now();
    const result = await step.run(context);
    const stepFailed = result.diagnostics.some((diagnostic) => diagnostic.severity === "error");
    for (const diagnostic of result.diagnostics) collected.push(diagnostic); // bukan spread: larik besar melampaui batas argumen
    checks.push({ name: STEP_TOOL[number], ok: !stepFailed, ms: elapsedMs(clock, startedAt) });
    status[number] = stepFailed ? "error" : "clean";

    if (result.diagnostics.some((diagnostic) => diagnostic.code === DEADLINE_CODE)) break;
  }

  // (4) gagal tertutup: tanpa galat pun, `ok` butuh ketujuh langkah dan bukti bundle serta meta
  const bundle = artifacts.get(BUNDLE_ARTIFACT);
  const meta = artifacts.get(META_ARTIFACT);
  const everyStepRan = STEP_NUMBERS.every((number) => status[number] !== undefined);
  const hasError = collected.some((diagnostic) => diagnostic.severity === "error");
  if (!hasError && !(everyStepRan && bundle !== undefined && meta !== undefined)) {
    return internalFailure(contract.contract_version, versions, maxChars, checks);
  }

  // (5) `ok` sebelum pemotongan, lalu urutan keluaran
  const finalized = finalize(collected, contract.limits);
  const summary = makeSummary(contract.contract_version, versions, checks, finalized.truncated);
  if (finalized.ok && bundle !== undefined && meta !== undefined) {
    return { ok: true, diagnostics: finalized.diagnostics, bundle, meta: { ...meta }, summary };
  }
  return failure(finalized.diagnostics, summary);
}

/**
 * Batas modul: tidak pernah menolak (reject) dan tidak pernah melempar. Exception apa pun,
 * termasuk dari jam atau langkah, menjadi satu `VERIFIER_INTERNAL` dengan `checks` kosong
 * (Requirement 6.13). Teks exception tidak ikut keluar.
 */
export async function safeVerify(event: unknown, deps: VerifyDeps): Promise<VerifierResult> {
  try {
    return await verify(event, deps);
  } catch {
    return internalFailureFor(deps);
  }
}

function internalFailureFor(deps: VerifyDeps): VerifierResult {
  try {
    return internalFailure(
      deps.contract.contract_version,
      deps.versions,
      deps.contract.limits.diagnostic_message_max_chars,
    );
  } catch {
    return internalFailure(UNKNOWN_CONTRACT_VERSION);
  }
}
