// Tes bentuk korpus fixtures/good, bad, dan warn (Requirement 38.1, 38.2, 38.11, 38.13, 1.2, 1.3;
// design 5.14; tugas 3.4 dan 8.1).
// Korpus ini nanti dijalankan melalui tujuh langkah verifier, jadi tes ini menjaga hal yang
// tidak dijaga langkah itu. good/: setiap Main_File punya pendamping JSON yang sah, `required_tokens`
// pendamping sama dengan hasil penurunan dari `visual` menurut Requirement 12, kelima jenis
// `visual` ada, dan komposisi korpus (puzzle, Sequence+Series, interpolate+spring+Easing) lengkap.
// Penurunan token di sini sengaja berdiri sendiri (tanpa src/tokens.ts) dan tidak memuat judul,
// karena pendamping hanya berisi {kind, visual, required_tokens, forbidden_tokens}.
// bad/ dan warn/: jumlah fixture (sedikitnya 31 di bad/), `expected.json` memetakan tepat berkas yang
// ada, setiap kode pada daftar Requirement 38.2 (dan tiga kode warn) punya fixture, pendamping opsional
// sah dan sesuai kode yang diharapkan (jenis `puzzle` untuk META_PAUSE_REQUIRED, token untuk FIDELITY_*),
// serta fixture ukuran dan encoding memang melanggar batasnya sedangkan yang lain tidak. Apakah kode
// itu benar-benar muncul dari pipeline adalah urusan tes korpus (8.2), bukan berkas ini.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { corpusDir, listSources, loadCorpus, loadExpected, type CorpusFolder } from "./support/corpus.js";

const GOOD_DIR = new URL("../fixtures/good/", import.meta.url);
// Batas ukuran sumber menurut tugas 3.4: setiap fixture harus lebih kecil dari 32768 byte.
const SOURCE_SIZE_LIMIT = 32768;
const MIN_FIXTURES = 8;

// ---- skema `visual` (cermin backend/app/ai/contracts/visual.py, hanya untuk memeriksa pendamping) ----

const label = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => s.trim() === s, "no surrounding whitespace");
const coord = z.number().min(-1000).max(1000);
const vec2 = z.tuple([coord, coord]);
const range = vec2.refine(([lo, hi]) => lo < hi, "range must be [min, max] with min < max");
const tone = z.enum(["primary", "secondary", "result", "muted"]);
const caption = label(160).optional();

const vectorsVisual = z
  .object({
    kind: z.literal("vectors"),
    x_range: range.optional(),
    y_range: range.optional(),
    vectors: z
      .array(
        z
          .object({ from: vec2, to: vec2, label: label(24).optional(), tone: tone.optional() })
          .strict()
          .refine((v) => v.from[0] !== v.to[0] || v.from[1] !== v.to[1], "a vector must have length"),
      )
      .min(1)
      .max(6),
    points: z.array(z.object({ at: vec2, label: label(24).optional() }).strict()).max(6).optional(),
    caption,
  })
  .strict();

const plotVisual = z
  .object({
    kind: z.literal("plot"),
    x_label: label(24).optional(),
    y_label: label(24).optional(),
    series: z
      .array(
        z
          .object({
            label: label(24).optional(),
            points: z.array(vec2).min(2).max(60),
            tone: tone.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(3),
    caption,
  })
  .strict();

const diagramVisual = z
  .object({
    kind: z.literal("diagram"),
    layout: z.enum(["flow", "tree", "cycle"]),
    nodes: z
      .array(z.object({ id: label(40), label: label(32), detail: label(70).optional() }).strict())
      .min(2)
      .max(8),
    edges: z
      .array(z.object({ from: label(40), to: label(40), label: label(24).optional() }).strict())
      .max(12)
      .default([]),
    caption,
  })
  .strict();

const tableVisual = z
  .object({
    kind: z.literal("table"),
    headers: z.array(label(24)).min(1).max(6),
    rows: z.array(z.array(z.string().max(40))).min(1).max(10),
    highlight_rows: z.array(z.number().int().min(0)).max(10).optional(),
    caption,
  })
  .strict();

const formulaVisual = z
  .object({
    kind: z.literal("formula"),
    expression: label(80),
    terms: z.array(z.object({ symbol: label(16), meaning: label(80) }).strict()).min(1).max(5),
    example: label(120).optional(),
    caption,
  })
  .strict();

const lessonVisual = z
  .discriminatedUnion("kind", [vectorsVisual, plotVisual, diagramVisual, tableVisual, formulaVisual])
  .superRefine((v, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (v.kind === "diagram") {
      const ids = new Set(v.nodes.map((n) => n.id));
      if (ids.size !== v.nodes.length) fail("duplicate node id");
      for (const e of v.edges) {
        if (!ids.has(e.from) || !ids.has(e.to)) fail("edge must connect existing nodes");
        if (e.from === e.to) fail("edge must connect two different nodes");
      }
    }
    if (v.kind === "table") {
      if (v.rows.some((row) => row.length !== v.headers.length)) fail("every row needs one cell per header");
      if ((v.highlight_rows ?? []).some((r) => r >= v.rows.length)) fail("highlighted row does not exist");
    }
  });

type Visual = z.infer<typeof lessonVisual>;

const companionSchema = z
  .object({
    kind: z.enum(["lesson", "puzzle"]),
    visual: lessonVisual,
    required_tokens: z.array(z.string().min(1)).min(1),
    forbidden_tokens: z.array(z.string().min(1).max(80)).max(8),
  })
  .strict();

// ---- penurunan Required_Tokens dari `visual` (Requirement 12 kriteria 1, 2, 3, 10; tanpa judul) ----

const normalize = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/\s/g, "");

function visualTexts(v: Visual): string[] {
  const texts: (string | undefined)[] = [v.caption];
  switch (v.kind) {
    case "vectors":
      texts.push(...v.vectors.map((x) => x.label), ...(v.points ?? []).map((p) => p.label));
      break;
    case "plot":
      texts.push(v.x_label, v.y_label, ...v.series.map((s) => s.label));
      break;
    case "diagram":
      for (const n of v.nodes) texts.push(n.label, n.detail);
      texts.push(...v.edges.map((e) => e.label));
      break;
    case "table":
      texts.push(...v.headers, ...v.rows.flat());
      break;
    case "formula":
      texts.push(v.expression);
      for (const t of v.terms) texts.push(t.symbol, t.meaning);
      texts.push(v.example);
      break;
  }
  return texts.filter((t): t is string => t !== undefined);
}

/** Teks asli kemunculan pertama, urutan dipertahankan, kosong dan duplikat ternormalisasi dibuang. */
function deriveRequiredTokens(v: Visual): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const text of visualTexts(v)) {
    const key = normalize(text);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

// ---- pemuatan korpus ----

const files = readdirSync(GOOD_DIR);
const sources = files.filter((f) => f.endsWith(".ts")).sort();
const companionFiles = files.filter((f) => f.endsWith(".json")).sort();

const sourceOf = (name: string): string => readFileSync(new URL(name, GOOD_DIR), "utf8");
const companionOf = (name: string) =>
  companionSchema.safeParse(JSON.parse(readFileSync(new URL(name.replace(/\.ts$/, ".json"), GOOD_DIR), "utf8")));

/** Nama yang diimpor dari `remotion` (tanpa alias), cukup untuk memeriksa komposisi korpus. */
function remotionImports(source: string): Set<string> {
  const match = /import\s*\{([^}]*)\}\s*from\s*"remotion"/.exec(source);
  const names = (match?.[1] ?? "").split(",").map((n) => n.trim()).filter(Boolean);
  return new Set(names);
}

describe("fixtures/good: jumlah dan pasangan berkas", () => {
  it(`memuat sedikitnya ${MIN_FIXTURES} Main_File`, () => {
    expect(sources.length).toBeGreaterThanOrEqual(MIN_FIXTURES);
  });

  it("setiap pendamping JSON punya Main_File dengan nama sama", () => {
    const expected = sources.map((s) => s.replace(/\.ts$/, ".json"));
    expect(companionFiles).toEqual(expected);
  });
});

describe.each(sources)("fixtures/good/%s", (name) => {
  it("lebih kecil dari batas ukuran sumber", () => {
    expect(statSync(new URL(name, GOOD_DIR)).size).toBeLessThan(SOURCE_SIZE_LIMIT);
  });

  it("punya pendamping yang sah dengan Required_Tokens turunan dari visual", () => {
    const parsed = companionOf(name);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.required_tokens).toEqual(deriveRequiredTokens(parsed.data.visual));
  });

  it("memakai Forbidden_Tokens hanya untuk puzzle, dan tidak tumpang tindih dengan Required_Tokens", () => {
    const parsed = companionOf(name);
    if (!parsed.success) throw new Error(`invalid companion for ${name}`);
    const { kind, required_tokens, forbidden_tokens } = parsed.data;
    expect(forbidden_tokens.length > 0).toBe(kind === "puzzle");
    const required = required_tokens.map(normalize);
    for (const token of forbidden_tokens) {
      expect(required.some((r) => r.includes(normalize(token)))).toBe(false);
    }
  });

  it("menetapkan pauseAtFrame pada meta jika dan hanya jika jenisnya puzzle", () => {
    const parsed = companionOf(name);
    if (!parsed.success) throw new Error(`invalid companion for ${name}`);
    const metaBlock = /export const meta\s*=\s*\{[^}]*\}/.exec(sourceOf(name))?.[0] ?? "";
    expect(metaBlock).not.toBe("");
    expect(/\bpauseAtFrame\s*:/.test(metaBlock)).toBe(parsed.data.kind === "puzzle");
  });
});

describe("fixtures/good: cakupan korpus", () => {
  const parsedAll = sources.map((s) => ({ name: s, companion: companionOf(s) }));

  it("memuat kelima jenis visual sebagai lesson", () => {
    const lessonKinds = new Set(
      parsedAll.flatMap(({ companion }) =>
        companion.success && companion.data.kind === "lesson" ? [companion.data.visual.kind] : [],
      ),
    );
    expect([...lessonKinds].sort()).toEqual(["diagram", "formula", "plot", "table", "vectors"]);
  });

  it("memuat sedikitnya satu puzzle ber-pauseAtFrame", () => {
    const puzzles = parsedAll.filter(({ companion }) => companion.success && companion.data.kind === "puzzle");
    expect(puzzles.length).toBeGreaterThanOrEqual(1);
  });

  it("memuat satu fixture yang memakai Sequence dan Series", () => {
    const users = sources.filter((s) => {
      const imports = remotionImports(sourceOf(s));
      return imports.has("Sequence") && imports.has("Series") && sourceOf(s).includes("Series.Sequence");
    });
    expect(users.length).toBeGreaterThanOrEqual(1);
  });

  it("memuat satu fixture yang memakai interpolate, spring, dan Easing", () => {
    const users = sources.filter((s) => {
      const imports = remotionImports(sourceOf(s));
      return imports.has("interpolate") && imports.has("spring") && imports.has("Easing");
    });
    expect(users.length).toBeGreaterThanOrEqual(1);
  });

  it("menyediakan vectors-lesson.ts, contoh lengkap untuk system prompt (Catatan N-3)", () => {
    expect(sources).toContain("vectors-lesson.ts");
  });
});

// ---- bad/ dan warn/: bentuk korpus (Requirement 38.2, 38.11; design 5.14) ----

const MIN_BAD_FIXTURES = 31;
const SOURCE_BYTE_LIMIT = 32768;
const CODE_SHAPE = /^(SIZE|ENCODING|POLICY|META|ESLINT|TSC|BUNDLE|RENDER|FIDELITY|VERIFIER)_[A-Z0-9_]+$/;

/**
 * Kode pada daftar Requirement 38.2 yang dapat dicapai lewat sumber, ditulis ulang dari requirement.
 * `TSC_` berarti "satu galat compiler": kode apa pun berawalan itu. `BUNDLE_TOO_LARGE`,
 * `BUNDLE_UNEXPECTED_REQUIRE`, dan `VERIFIER_DEADLINE` tidak ada di sini (diuji langsung, tugas 3.3, 5.4).
 */
const REQUIRED_BAD_CODES: readonly string[] = [
  "SIZE_SOURCE_TOO_LARGE",
  "ENCODING_INVALID",
  "POLICY_JSX_SYNTAX",
  "POLICY_IMPORT_DISALLOWED",
  "POLICY_DYNAMIC_IMPORT",
  "POLICY_FORBIDDEN_IDENTIFIER",
  "POLICY_FORBIDDEN_MEMBER",
  "POLICY_FORBIDDEN_PROPERTY",
  "POLICY_DYNAMIC_ELEMENT",
  "POLICY_FORBIDDEN_ELEMENT",
  "POLICY_FORBIDDEN_ATTRIBUTE",
  "POLICY_URL_LITERAL",
  "POLICY_COLOR_LITERAL",
  "POLICY_META_INVALID",
  "META_PAUSE_REQUIRED",
  "META_PAUSE_FORBIDDEN",
  "POLICY_EXPORT_MISSING",
  "POLICY_EXPORT_UNEXPECTED",
  "ESLINT_LORE_NO_MODULE_STATE",
  "ESLINT_LORE_USES_FRAME",
  "TSC_",
  "RENDER_EXCEPTION",
  "RENDER_CONSOLE_ERROR",
  "RENDER_DOM_LIMIT",
  "RENDER_EMPTY",
  "RENDER_META_MISMATCH",
  "RENDER_FRAME_TIMEOUT",
  "RENDER_NONDETERMINISTIC",
  "RENDER_RESOURCE_LIMIT",
  "FIDELITY_TOKEN_MISSING",
  "FIDELITY_FORBIDDEN_TOKEN_VISIBLE",
];

/** Dua kode arahan yang ditegakkan langkah 3 dan 4 (Requirement 8.10), selain daftar 38.2. */
const DIRECTIVE_CODES: readonly string[] = ["ESLINT_INLINE_DIRECTIVE", "TSC_SUPPRESSION_DIRECTIVE"];

/** Kode peringatan wajib di warn/ (Requirement 38.11 dan tugas 8.1). */
const REQUIRED_WARN_CODES: readonly string[] = [
  "RENDER_CONSOLE_WARN",
  "ESLINT_LORE_KIT_STYLE",
  "FIDELITY_FORBIDDEN_OVERLAPS_REQUIRED",
];

const BOM = [0xef, 0xbb, 0xbf];

const sourceBytes = (folder: CorpusFolder, name: string): Buffer => readFileSync(new URL(name, corpusDir(folder)));

/** Semua `*.json` di folder selain `expected.json`: pendamping, yang harus punya Main_File dengan nama sama. */
const companionNames = (folder: CorpusFolder): string[] =>
  readdirSync(corpusDir(folder))
    .filter((name) => name.endsWith(".json") && name !== "expected.json")
    .sort();

const covers = (codes: ReadonlySet<string>, wanted: string): boolean =>
  wanted.endsWith("_") ? [...codes].some((code) => code.startsWith(wanted)) : codes.has(wanted);

describe.each(["bad", "warn"] as const)("fixtures/%s: pasangan berkas dan expected.json", (folder) => {
  const sources = listSources(folder);
  const expected = loadExpected(folder);

  it("expected.json memetakan tepat berkas Main_File yang ada", () => {
    expect(Object.keys(expected).sort()).toEqual(sources);
  });

  it("setiap kode yang diharapkan berbentuk kode Diagnostic dan tidak berulang dalam satu berkas", () => {
    for (const [name, codes] of Object.entries(expected)) {
      expect(new Set(codes).size, name).toBe(codes.length);
      for (const code of codes) expect(code, `${name}: ${code}`).toMatch(CODE_SHAPE);
    }
  });

  it("setiap pendamping JSON punya Main_File dengan nama sama dan bentuk yang sah", () => {
    for (const companion of companionNames(folder)) {
      expect(sources, companion).toContain(companion.replace(/\.json$/, ".ts"));
    }
    // `loadCorpus` memvalidasi tiap pendamping dengan skema Zod (kunci opsional, token berupa string).
    expect(loadCorpus(folder).map((entry) => entry.name)).toEqual(sources);
  });

  it("setiap berkas diawali komentar header (setelah BOM bila ada)", () => {
    for (const name of sources) {
      const text = sourceBytes(folder, name).toString("utf8").replace(/^\uFEFF/, "");
      expect(text.startsWith("//") || text.startsWith("/*"), name).toBe(true);
    }
  });
});

describe("fixtures/bad: jumlah dan cakupan kode (Requirement 38.2)", () => {
  const entries = loadCorpus("bad");
  const expectedCodes = new Set(entries.flatMap((entry) => entry.expectedCodes ?? []));

  it(`memuat sedikitnya ${MIN_BAD_FIXTURES} Main_File`, () => {
    expect(entries.length).toBeGreaterThanOrEqual(MIN_BAD_FIXTURES);
  });

  it.each(REQUIRED_BAD_CODES)("ada fixture untuk %s", (code) => {
    expect(covers(expectedCodes, code)).toBe(true);
  });

  it.each(DIRECTIVE_CODES)("ada fixture untuk arahan %s (Requirement 8.10)", (code) => {
    expect(expectedCodes.has(code)).toBe(true);
  });

  it("tidak memuat kode yang hanya dapat dicapai lewat panggilan langsung (diuji di tugas 3.3, 5.4)", () => {
    for (const code of ["BUNDLE_TOO_LARGE", "BUNDLE_UNEXPECTED_REQUIRE", "VERIFIER_DEADLINE"]) {
      expect(expectedCodes.has(code), code).toBe(false);
    }
  });
});

describe("fixtures/bad: ukuran, encoding, dan pendamping sesuai kode yang diharapkan", () => {
  const entries = loadCorpus("bad");
  const byCode = (code: string) => entries.filter((entry) => entry.expectedCodes?.includes(code));

  it("hanya fixture SIZE_SOURCE_TOO_LARGE yang melebihi 32768 byte, dan yang lain di bawahnya", () => {
    for (const entry of entries) {
      const size = sourceBytes("bad", entry.name).length;
      const oversize = entry.expectedCodes?.includes("SIZE_SOURCE_TOO_LARGE") === true;
      expect(size > SOURCE_BYTE_LIMIT, `${entry.name} (${size} byte)`).toBe(oversize);
    }
  });

  it("hanya fixture ENCODING_INVALID yang diawali BOM, dan tidak ada yang memuat NUL", () => {
    for (const entry of entries) {
      const bytes = sourceBytes("bad", entry.name);
      const hasBom = BOM.every((byte, index) => bytes[index] === byte);
      expect(hasBom, entry.name).toBe(entry.expectedCodes?.includes("ENCODING_INVALID") === true);
      expect(bytes.includes(0), entry.name).toBe(false);
    }
  });

  it("META_PAUSE_REQUIRED memakai pendamping puzzle dan META_PAUSE_FORBIDDEN tetap lesson", () => {
    const required = byCode("META_PAUSE_REQUIRED");
    const forbidden = byCode("META_PAUSE_FORBIDDEN");
    expect(required.length).toBeGreaterThanOrEqual(1);
    expect(forbidden.length).toBeGreaterThanOrEqual(1);
    for (const entry of required) {
      expect(entry.hasCompanion, entry.name).toBe(true);
      expect(entry.kind, entry.name).toBe("puzzle");
      expect(/\bpauseAtFrame\s*:/.test(entry.source), entry.name).toBe(false);
    }
    for (const entry of forbidden) {
      expect(entry.kind, entry.name).toBe("lesson");
      expect(/\bpauseAtFrame\s*:/.test(entry.source), entry.name).toBe(true);
    }
  });

  it("FIDELITY_TOKEN_MISSING membawa Required_Token dan FIDELITY_FORBIDDEN_TOKEN_VISIBLE membawa puzzle dengan Forbidden_Token", () => {
    const missing = byCode("FIDELITY_TOKEN_MISSING");
    const visible = byCode("FIDELITY_FORBIDDEN_TOKEN_VISIBLE");
    expect(missing.length).toBeGreaterThanOrEqual(1);
    expect(visible.length).toBeGreaterThanOrEqual(1);
    for (const entry of missing) {
      expect(entry.required_tokens.length, entry.name).toBeGreaterThanOrEqual(1);
    }
    for (const entry of visible) {
      expect(entry.kind, entry.name).toBe("puzzle");
      expect(entry.forbidden_tokens.length, entry.name).toBeGreaterThanOrEqual(1);
      expect(/\bpauseAtFrame\s*:/.test(entry.source), entry.name).toBe(true);
    }
  });

  it("fixture tanpa pendamping berarti masukan lesson tanpa token", () => {
    for (const entry of entries.filter((candidate) => !candidate.hasCompanion)) {
      expect([entry.kind, entry.required_tokens, entry.forbidden_tokens], entry.name).toEqual(["lesson", [], []]);
    }
  });
});

describe("fixtures/warn: cakupan peringatan (Requirement 38.11)", () => {
  const entries = loadCorpus("warn");
  const expectedCodes = new Set(entries.flatMap((entry) => entry.expectedCodes ?? []));

  it("memuat tepat tiga kode peringatan yang diwajibkan", () => {
    expect([...expectedCodes].sort()).toEqual([...REQUIRED_WARN_CODES].sort());
  });

  it("semua berkas lebih kecil dari batas ukuran dan tanpa BOM", () => {
    for (const entry of entries) {
      const bytes = sourceBytes("warn", entry.name);
      expect(bytes.length, entry.name).toBeLessThan(SOURCE_BYTE_LIMIT);
      expect(BOM.every((byte, index) => bytes[index] === byte), entry.name).toBe(false);
    }
  });

  it("fixture FIDELITY_FORBIDDEN_OVERLAPS_REQUIRED adalah puzzle yang token terlarangnya juga diminta", () => {
    const overlap = entries.filter((entry) => entry.expectedCodes?.includes("FIDELITY_FORBIDDEN_OVERLAPS_REQUIRED"));
    expect(overlap.length).toBe(1);
    for (const entry of overlap) {
      expect(entry.kind, entry.name).toBe("puzzle");
      const required = new Set(entry.required_tokens.map(normalize));
      expect(entry.forbidden_tokens.some((token) => required.has(normalize(token))), entry.name).toBe(true);
      // Token terlarang lain tetap bermakna: ada sedikitnya satu yang tidak tumpang tindih.
      expect(entry.forbidden_tokens.some((token) => !required.has(normalize(token))), entry.name).toBe(true);
    }
  });
});

describe("fixtures/good: pendamping wajib untuk setiap Main_File (Requirement 38.13)", () => {
  it("loadCorpus membaca seluruh korpus bagus dengan pendamping", () => {
    const entries = loadCorpus("good");
    expect(entries.length).toBeGreaterThanOrEqual(MIN_FIXTURES);
    expect(entries.every((entry) => entry.hasCompanion)).toBe(true);
  });
});
