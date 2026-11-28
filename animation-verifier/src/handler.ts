// Handler AWS Lambda verifier (design 5.3 "Handler dan pipeline"; Requirement 6.1, 6.13, 11.6, 2.10).
// Tugasnya tiga: memuat Animation_Contract dari disk (dan memetakan kontrak rusak ke
// `VERIFIER_INTERNAL`, Requirement 2.10), memanggil `safeVerify`, dan menulis TEPAT SATU baris JSON
// ke stdout per invokasi: `request_id`, `ok`, `checks`, `by_code`. Baris itu tidak pernah memuat
// sumber, bundle, token, atau pesan Diagnostic (Requirement 11.6), dan kegagalan menulis log tidak
// menggagalkan invokasi. Handler total: tidak ada exception yang lolos.
// `createHandler` memisahkan dependensi (jam, pemuat kontrak, penulis baris, langkah) dari handler
// produksi supaya tes dapat menyuntikkan kontrak rusak atau langkah yang melempar; `handler`
// yang diekspor memakai jam sistem, berkas kontrak asli, dan `process.stdout`.
// Lokasi kontrak: `dist/animation-contract.json` di image Lambda (Dockerfile menyalinnya ke sebelah
// handler) dan `contract/animation-contract.json` saat tes atau dijalankan dari `src/`.

import { readFileSync } from "node:fs";
import { systemClock, type Clock } from "./clock.js";
import { loadContract, type Contract, type LoadContractResult } from "./contract.js";
import type { VerifierStep } from "./steps/step.js";
import type { Diagnostic, VerifierResult } from "./types.js";
import { UNKNOWN_CONTRACT_VERSION, internalFailure, safeVerify } from "./verify.js";
import type { VersionInfo } from "./versions.js";

const CONTRACT_FILE_NAME = "animation-contract.json";

/** Urutan pencarian kontrak; berkas pertama yang ada dipakai, yang rusak tidak dilewati. */
export const CONTRACT_LOCATIONS: readonly URL[] = [
  new URL(`./${CONTRACT_FILE_NAME}`, import.meta.url),
  new URL(`../contract/${CONTRACT_FILE_NAME}`, import.meta.url),
];

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

/**
 * Membaca dan memvalidasi kontrak dari `locations`. Berkas yang tidak ada dilewati; berkas yang
 * ada tetapi tidak terbaca, bukan JSON, atau gagal skema menghasilkan `{ ok: false }` tanpa
 * mencoba lokasi berikutnya, supaya kontrak rusak tidak tersamarkan oleh salinan lain.
 */
export function readContractFromLocations(locations: readonly URL[]): LoadContractResult {
  for (const location of locations) {
    let text: string;
    try {
      text = readFileSync(location, "utf8");
    } catch (error) {
      if (isMissingFile(error)) continue;
      return { ok: false, reason: "contract file could not be read" };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, reason: "contract file is not valid JSON" };
    }
    return loadContract(raw);
  }
  return { ok: false, reason: "contract file was not found" };
}

// ---- log satu baris ----

/** Jumlah Diagnostic per `code`, kunci terurut abjad agar baris log deterministik. */
function countByCode(diagnostics: readonly Diagnostic[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const diagnostic of diagnostics) {
    counts.set(diagnostic.code, (counts.get(diagnostic.code) ?? 0) + 1);
  }
  const codes = [...counts.keys()].sort(); // diurutkan, jadi urutan penyisipan Map tidak berpengaruh
  return Object.fromEntries(codes.map((code) => [code, counts.get(code) ?? 0]));
}

/** Satu baris JSON; `JSON.stringify` tanpa indentasi tidak pernah menghasilkan newline mentah. */
function buildLogLine(requestId: string, result: VerifierResult): string {
  return JSON.stringify({
    request_id: requestId,
    ok: result.ok,
    checks: result.summary.checks,
    by_code: countByCode(result.diagnostics),
  });
}

function requestIdOf(context: unknown): string {
  const id = (context as { awsRequestId?: unknown } | null | undefined)?.awsRequestId;
  return typeof id === "string" ? id : "unknown";
}

// ---- handler ----

export interface HandlerDeps {
  readonly clock: Clock;
  /** Dipanggil sampai berhasil sekali; hasil sukses di-cache selama proses hidup. */
  readonly loadContract: () => LoadContractResult;
  /** Menulis satu baris (tanpa newline akhir). Galat penulisan diabaikan. */
  readonly writeLine: (line: string) => void;
  readonly steps?: readonly VerifierStep[];
  readonly versions?: VersionInfo;
}

export type LambdaHandler = (
  event: unknown,
  context: { awsRequestId: string },
) => Promise<VerifierResult>;

export function createHandler(deps: HandlerDeps): LambdaHandler {
  let contract: Contract | undefined;

  function currentContract(): Contract | undefined {
    if (contract === undefined) {
      const loaded = deps.loadContract();
      if (loaded.ok) contract = loaded.contract;
    }
    return contract;
  }

  async function run(event: unknown): Promise<VerifierResult> {
    try {
      const loaded = currentContract();
      if (loaded === undefined) return internalFailure(UNKNOWN_CONTRACT_VERSION, deps.versions);
      return await safeVerify(event, {
        clock: deps.clock,
        contract: loaded,
        steps: deps.steps,
        versions: deps.versions,
      });
    } catch {
      return internalFailure(UNKNOWN_CONTRACT_VERSION, deps.versions);
    }
  }

  return async (event, context) => {
    const result = await run(event);
    try {
      deps.writeLine(buildLogLine(requestIdOf(context), result));
    } catch {
      // Log yang gagal ditulis tidak boleh mengubah hasil verifikasi.
    }
    return result;
  };
}

/** Handler produksi: jam sistem, berkas kontrak asli, dan stdout proses. */
export const handler: LambdaHandler = createHandler({
  clock: systemClock(),
  loadContract: () => readContractFromLocations(CONTRACT_LOCATIONS),
  writeLine: (line) => {
    process.stdout.write(`${line}\n`);
  },
});
