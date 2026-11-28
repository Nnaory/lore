// Tipe publik verifier: bentuk Diagnostic, masukan, dan Verifier_Result (design bagian 5.2).
// Dipisah dari logika agar handler, pipeline, langkah, dan tes memakai satu definisi; padanan
// Pydantic di backend (`backend/app/ai/animation/models.py`) harus mengikuti bentuk ini.
// Verifier tidak pernah mengirim `tool: "agent"` (itu milik agent backend), jadi tidak ada di `Tool`.

export type Severity = "error" | "warning";

export type Tool =
  | "size"
  | "policy"
  | "eslint"
  | "tsc"
  | "esbuild"
  | "render"
  | "fidelity"
  | "verifier";

export interface Diagnostic {
  tool: Tool;
  /** Cocok dengan `^(SIZE|ENCODING|POLICY|META|ESLINT|TSC|BUNDLE|RENDER|FIDELITY|VERIFIER)_[A-Z0-9_]+$`. */
  code: string;
  severity: Severity;
  /** Basis 1. */
  line?: number;
  /** Basis 1. */
  column?: number;
  /** Paling banyak 200 karakter, tanpa durasi atau id invokasi. */
  message: string;
}

export type Kind = "lesson" | "puzzle";

/** Tepat lima kunci; bidang tambahan pada event diabaikan. */
export interface VerifierInput {
  source: string;
  kind: Kind;
  required_tokens: string[];
  forbidden_tokens: string[];
  contract_version: number;
}

export interface MainMeta {
  width: 1280;
  height: 720;
  fps: 30;
  durationInFrames: number;
  pauseAtFrame?: number;
}

export interface CheckSummary {
  name: Tool;
  ok: boolean;
  ms: number;
}

export interface VerifierSummary {
  verifier_version: string;
  contract_version: number;
  runtime_version: { react: string; remotion: string };
  checks: CheckSummary[];
  truncated: boolean;
}

/** `bundle` dan `meta` hanya ada bila `ok` true. */
export type VerifierResult =
  | { ok: true; diagnostics: Diagnostic[]; bundle: string; meta: MainMeta; summary: VerifierSummary }
  | { ok: false; diagnostics: Diagnostic[]; summary: VerifierSummary };
