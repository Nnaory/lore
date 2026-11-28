// Pembaca kontrak verifier: skema Zod 20 bidang `animation-contract.json`, pemeriksaan minimum
// (design bagian 4.3), dan turunan set cepat yang dipakai langkah pemindaian.
// Kontrak adalah satu-satunya tempat angka dan daftar aturan Main_File ditulis (Requirement 2.6);
// modul ini hanya memvalidasi bentuknya dan menurunkan struktur pencarian, tidak menyalin nilainya.
// `loadContract` total: masukan apa pun menghasilkan `{ ok: true }` atau `{ ok: false, reason }`,
// tanpa throw, sehingga handler dapat memetakan kegagalan ke `VERIFIER_INTERNAL` (Requirement 2.10).

import { z } from "zod";

/** Bilangan bulat >= 1: dasar untuk `contract_version`, `canvas.*`, `duration.*`, dan `limits.*`. */
const positiveInt = z.number().int().min(1);

const stringList = z.array(z.string());

const ImportNamesSchema = z.object({
  values: stringList,
  types: stringList,
});

const CanvasSchema = z.object({
  width: positiveInt,
  height: positiveInt,
  fps: positiveInt,
});

const DurationSchema = z
  .object({
    min: positiveInt,
    max: positiveInt,
  })
  .superRefine((duration, ctx) => {
    if (duration.min > duration.max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["min"],
        message: "must be less than or equal to duration.max",
      });
    }
  });

/** Sepuluh batas yang dibaca verifier; semuanya bilangan bulat > 0. */
const LimitsSchema = z.object({
  source_max_bytes: positiveInt,
  bundle_max_bytes: positiveInt,
  dom_max_elements: positiveInt,
  frame_timeout_ms: positiveInt,
  verifier_deadline_ms: positiveInt,
  diagnostics_max: positiveInt,
  diagnostic_message_max_chars: positiveInt,
  worker_heap_mb: positiveInt,
  rss_limit_mb: positiveInt,
  fold_depth: positiveInt,
});

const RequiredExportsSchema = z.object({
  meta: z.object({
    keys: stringList,
    optional_keys: stringList,
  }),
  default: z.object({
    function_name: z.string().min(1),
    param_count: z.number().int().min(0),
  }),
});

const PauseRuleSchema = z.enum(["required", "forbidden"]);

const ForbiddenSchema = z.object({
  identifier: stringList,
  member: stringList,
  property: stringList,
  element: stringList,
  attribute: z.object({
    names: stringList,
    patterns: stringList,
    style_key_prefixes: stringList,
  }),
});

const ColorFormsSchema = z.object({
  hex_pattern: z.string(),
  functions: stringList,
  named_colors: stringList,
});

const KitStyleWarningsSchema = z.object({
  border_radius_property: z.string(),
  shadow_properties: stringList,
  gradient_functions: stringList,
  filter_functions: stringList,
  backdrop_property: z.string(),
  emoji_pattern: z.string(),
  font_family_property: z.string(),
});

/** Awalan kode yang dibuat agent backend, bukan verifier (Requirement 2.13). */
export const AGENT_PREFIX = "AGENT";

/** Jumlah awalan kode: sepuluh milik verifier ditambah `AGENT`. */
const DIAGNOSTIC_PREFIX_COUNT = 11;

/** Jumlah token warna palet Kit. */
const COLOR_TOKEN_COUNT = 9;

/** Skema 20 bidang. Bidang tambahan di JSON dibuang, sama seperti pembaca backend dan runtime. */
export const ContractSchema = z
  .object({
    contract_version: positiveInt,
    file_name: z.string().min(1),
    canvas: CanvasSchema,
    duration: DurationSchema,
    limits: LimitsSchema,
    allowed_imports: z.record(z.string(), ImportNamesSchema),
    required_exports: RequiredExportsSchema,
    pause_rules: z.object({ lesson: PauseRuleSchema, puzzle: PauseRuleSchema }),
    forbidden: ForbiddenSchema,
    url_schemes: stringList,
    url_schemes_strict_colon: stringList,
    css_functions_forbidden: stringList,
    color_tokens: stringList.length(COLOR_TOKEN_COUNT),
    color_keywords: stringList,
    color_properties: stringList,
    color_forms: ColorFormsSchema,
    font_variables: stringList,
    kit_style_warnings: KitStyleWarningsSchema,
    diagnostic_code_prefixes: stringList
      .length(DIAGNOSTIC_PREFIX_COUNT)
      .refine((prefixes) => prefixes.includes(AGENT_PREFIX), {
        message: `must include ${AGENT_PREFIX}`,
      }),
    supported_runtime_contract_versions: z.array(positiveInt).min(1),
  })
  .superRefine((contract, ctx) => {
    if (!contract.supported_runtime_contract_versions.includes(contract.contract_version)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["supported_runtime_contract_versions"],
        message: "must include contract_version",
      });
    }
  });

/** Isi kontrak hasil validasi, tanpa turunan. */
export type RawContract = z.infer<typeof ContractSchema>;

/** Struktur pencarian cepat yang diturunkan sekali saat kontrak dimuat. */
export interface DerivedContract {
  /** `forbidden.identifier` sebagai set (peka huruf besar-kecil, seperti identifier JavaScript). */
  forbiddenIdentifiers: ReadonlySet<string>;
  /** `color_forms.named_colors` dalam huruf kecil; pencocokan nama warna CSS tak peka huruf. */
  namedColors: ReadonlySet<string>;
  /** Regex bentuk kode Diagnostic verifier, dibangun dari semua awalan selain `AGENT`. */
  diagnosticCodeRegex: RegExp;
}

export type Contract = RawContract & DerivedContract;

export type LoadContractResult = { ok: true; contract: Contract } | { ok: false; reason: string };

/** Hanya cegah karakter khusus regex pada awalan; awalan sah selalu huruf kapital. */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Membangun `^(<awalan>|...)_[A-Z0-9_]+$` dari semua awalan selain `AGENT` (Requirement 2.13,
 * 6.8). Urutan awalan mengikuti kontrak supaya `source` regex sama dengan pola literal di tes.
 * Regex tanpa flag `g` atau `y` agar `test()` tidak menyimpan status antar-panggilan.
 */
export function buildDiagnosticCodeRegex(prefixes: readonly string[]): RegExp {
  const verifierPrefixes = prefixes.filter((prefix) => prefix !== AGENT_PREFIX);
  return new RegExp(`^(${verifierPrefixes.map(escapeRegex).join("|")})_[A-Z0-9_]+$`);
}

const MAX_REASON_ISSUES = 5;

/** Ringkasan galat untuk operator: `path: pesan`, dibatasi agar log tetap pendek. */
function describeIssues(error: z.ZodError): string {
  const shown = error.issues.slice(0, MAX_REASON_ISSUES).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
  const hidden = error.issues.length - shown.length;
  return hidden > 0 ? `${shown.join("; ")}; +${hidden} more` : shown.join("; ");
}

function derive(raw: RawContract): Contract {
  return {
    ...raw,
    forbiddenIdentifiers: new Set(raw.forbidden.identifier),
    namedColors: new Set(raw.color_forms.named_colors.map((name) => name.toLowerCase())),
    diagnosticCodeRegex: buildDiagnosticCodeRegex(raw.diagnostic_code_prefixes),
  };
}

/**
 * Memvalidasi `raw` (hasil `JSON.parse` salinan kontrak) dengan pemeriksaan minimum bagian 4.3
 * dan menurunkan set cepat. Tidak pernah melempar: masukan apa pun, termasuk `null`, array,
 * atau objek dengan getter yang melempar, menghasilkan `{ ok: false, reason }`.
 */
export function loadContract(raw: unknown): LoadContractResult {
  try {
    const parsed = ContractSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: describeIssues(parsed.error) };
    return { ok: true, contract: derive(parsed.data) };
  } catch {
    return { ok: false, reason: "(root): contract could not be read" };
  }
}
