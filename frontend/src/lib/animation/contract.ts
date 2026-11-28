/**
 * Animation contract reader (frontend / Sandbox_Runtime side).
 *
 * `animation-contract.json` in this folder is a byte-for-byte copy of
 * `animation-verifier/contract/animation-contract.json`, written by
 * `scripts/sync-animation-contract.py`. The contract is the single place where the numbers and
 * rule lists of a Main_File are written (Requirement 2.6): this module validates the shape of the
 * copy and exposes it as `CONTRACT`. No contract value is repeated as a literal anywhere else in
 * the frontend; other code reads `CONTRACT.canvas`, `CONTRACT.duration`, `CONTRACT.allowed_imports`
 * and so on.
 *
 * `readContract` applies the same minimum checks as the verifier (`animation-verifier/src/contract.ts`)
 * and the backend reader, design section 4.3 / Requirement 2.11, so a copy that one reader accepts
 * is accepted by all three. It is total: any input, including `null`,
 * arrays or objects with a throwing getter, yields `{ ok: true }` or `{ ok: false, reason }`
 * and never throws (Requirement 2.10). The sandbox runtime uses the failure to answer an `error`
 * of phase `load` without evaluating the bundle.
 *
 * The two counts below (`color_tokens` = 9, `diagnostic_code_prefixes` = 11 with `AGENT`) are the
 * structural minimum of design 4.3, not Main_File rules; the verifier and backend repeat them too.
 * This file stays free of React, DOM and Next imports because the runtime bundle includes it.
 */

import { z } from "zod";
import rawContract from "./animation-contract.json";

/** Integer >= 1: base for `contract_version`, `canvas.*`, `duration.*` and `limits.*`. */
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

/** The ten limits the verifier reads; every one is an integer > 0. */
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

/** Code prefix created by the backend agent, not by the verifier (Requirement 2.13). */
const AGENT_PREFIX = "AGENT";

/** Number of code prefixes: ten owned by the verifier plus `AGENT`. */
const DIAGNOSTIC_PREFIX_COUNT = 11;

/** Number of colour tokens in the Kit palette. */
const COLOR_TOKEN_COUNT = 9;

/** The 20 fields. Extra keys in the JSON are dropped, as in the verifier and backend readers. */
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

/** A contract that passed the minimum checks. */
export type Contract = z.infer<typeof ContractSchema>;

export type ReadContractResult = { ok: true; contract: Contract } | { ok: false; reason: string };

const MAX_REASON_ISSUES = 5;

/** Operator summary as `path: message`, capped so logs stay short. */
function describeIssues(error: z.ZodError): string {
  const shown = error.issues.slice(0, MAX_REASON_ISSUES).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
  const hidden = error.issues.length - shown.length;
  return hidden > 0 ? `${shown.join("; ")}; +${hidden} more` : shown.join("; ");
}

/**
 * Validates `raw` (the parsed JSON of a contract copy) against the minimum checks of design 4.3.
 * Never throws: any input yields `{ ok: true, contract }` or `{ ok: false, reason }`.
 */
export function readContract(raw: unknown): ReadContractResult {
  try {
    const parsed = ContractSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: describeIssues(parsed.error) };
    return { ok: true, contract: parsed.data };
  } catch {
    return { ok: false, reason: "(root): contract could not be read" };
  }
}

/**
 * Outcome of reading the copy that ships with this build. Callers that must refuse to run on a
 * broken copy (the sandbox runtime answers `CONTRACT_INVALID`, Requirement 2.10 / 2.15) check
 * `.ok` before using `CONTRACT`.
 */
export const CONTRACT_READ: ReadContractResult = readContract(rawContract);

/**
 * The contract of this build, read from `animation-contract.json`. When the shipped copy is
 * invalid (a build defect that `contract-parity.test.ts` and the CI sync check catch) it falls
 * back to the unvalidated JSON so that importing this module never throws; consult
 * `CONTRACT_READ.ok` wherever an invalid copy must stop the work.
 */
export const CONTRACT: Contract = CONTRACT_READ.ok
  ? CONTRACT_READ.contract
  : (rawContract as unknown as Contract);
