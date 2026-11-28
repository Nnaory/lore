// Pembantu tes: memuat korpus fixture (`fixtures/good`, `bad`, dan `warn`) sebagai masukan
// verifier. Satu konvensi untuk semua folder, supaya tes bentuk korpus (8.1), tes korpus (8.2), dan skrip
// RIE (9.2) membaca fixture dengan cara yang sama:
//   - `<nama>.ts` adalah Main_File.
//   - `<nama>.json` (pendamping) memuat `kind`, `required_tokens`, dan `forbidden_tokens`. Di `good/`
//     pendamping WAJIB ada (juga memuat `visual`, yang diabaikan di sini). Di `bad/` dan `warn/`
//     pendamping OPSIONAL dan hanya ada bila fixture butuh `kind` selain `lesson` atau token
//     (META_PAUSE_REQUIRED, FIDELITY_*); tanpa pendamping masukan bernilai `lesson`, `[]`, `[]`.
//   - `expected.json` (hanya `bad/` dan `warn/`) memetakan `<nama>.ts` ke daftar kode minimal
//     yang harus muncul pada `diagnostics`.
// Berkas dibaca sebagai UTF-8 tanpa membuang BOM (fixture ENCODING_INVALID justru memerlukannya).

import { readFileSync, readdirSync } from "node:fs";
import { z } from "zod";
import type { Kind } from "../../src/types.js";

export type CorpusFolder = "good" | "bad" | "warn";

export interface CorpusEntry {
  /** Nama berkas Main_File, mis. `policy-jsx-syntax.ts`. */
  readonly name: string;
  readonly source: string;
  readonly kind: Kind;
  readonly required_tokens: string[];
  readonly forbidden_tokens: string[];
  /** Ada bila pendamping ada. */
  readonly hasCompanion: boolean;
  /** Kode minimal dari `expected.json`; `undefined` untuk `good/` atau bila fixture tidak terdaftar. */
  readonly expectedCodes: readonly string[] | undefined;
}

const CompanionSchema = z.object({
  kind: z.enum(["lesson", "puzzle"]).default("lesson"),
  required_tokens: z.array(z.string()).default([]),
  forbidden_tokens: z.array(z.string()).default([]),
});

const ExpectedSchema = z.record(z.array(z.string().min(1)).min(1));

export function corpusDir(folder: CorpusFolder): URL {
  return new URL(`../../fixtures/${folder}/`, import.meta.url);
}

/** Isi `expected.json` folder itu (kosong untuk `good/`, yang tidak punya berkas ini). */
export function loadExpected(folder: CorpusFolder): Readonly<Record<string, readonly string[]>> {
  if (folder === "good") return {};
  const raw: unknown = JSON.parse(readFileSync(new URL("expected.json", corpusDir(folder)), "utf8"));
  return ExpectedSchema.parse(raw);
}

/** Nama semua `*.ts` di folder, terurut menurut nama. */
export function listSources(folder: CorpusFolder): string[] {
  return readdirSync(corpusDir(folder))
    .filter((name) => name.endsWith(".ts"))
    .sort();
}

/** Semua Main_File di folder beserta masukan verifier-nya, terurut menurut nama. */
export function loadCorpus(folder: CorpusFolder): CorpusEntry[] {
  const dir = corpusDir(folder);
  const present = new Set(readdirSync(dir));
  const expected = loadExpected(folder);
  return listSources(folder).map((name) => {
    const companionName = name.replace(/\.ts$/, ".json");
    const hasCompanion = present.has(companionName);
    const companion = hasCompanion
      ? CompanionSchema.parse(JSON.parse(readFileSync(new URL(companionName, dir), "utf8")))
      : CompanionSchema.parse({});
    return {
      name,
      source: readFileSync(new URL(name, dir), "utf8"),
      kind: companion.kind,
      required_tokens: companion.required_tokens,
      forbidden_tokens: companion.forbidden_tokens,
      hasCompanion,
      expectedCodes: expected[name],
    };
  });
}
