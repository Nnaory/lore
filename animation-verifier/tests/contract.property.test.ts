// Tes properti `loadContract` (tugas 1.5, opsional; Requirement 2.10, 2.11, 38.3; design bagian 13).
// Feature: ai-remotion-animation, Property 1: Validasi kontrak total tanpa exception (sisi verifier).
// Pernyataan utama: untuk nilai JSON sembarang dan untuk kontrak sah yang dimutasi (kunci dihapus,
// tipe diganti, nilai diganti JSON acak, kunci tambahan, beberapa mutasi berturut-turut),
// `loadContract` selalu menjawab `{ ok: true }` atau `{ ok: false, reason }`, tidak melempar,
// tidak mengubah masukannya, dan menjawab sama untuk masukan yang sama.
// Tes ini tidak berhenti di "tidak melempar". Penerimaan diperiksa terhadap pemeriksaan minimum
// design 4.3 (`meetsMinimum`, ditulis ulang di sini tanpa memakai skema produksi): `ok: true`
// hanya boleh bila pemeriksaan itu lolos. Penolakan diperiksa lewat oracle yang pasti benar:
//   - menghapus satu kunci dari objek yang bidangnya tetap (semua objek kontrak selain
//     `allowed_imports`, yang kuncinya bebas) SELALU menolak, dan alasannya menyebut path kunci itu;
//   - mengganti satu simpul dengan nilai berjenis JSON lain SELALU menolak, dan alasannya menyebut path itu;
//   - mengganti satu bilangan dengan bilangan lain: hasilnya `ok === meetsMinimum(...)` (dua arah).
// Kunci tambahan pada objek yang bidangnya tetap dibuang tanpa menolak kontrak (pembaca toleran).
// Generator memakai `fc.jsonValue()` dan simpul kontrak sumber; tiap properti berjalan >= 100 iterasi.
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { loadContract } from "../src/contract.js";

// ---- JSON dan kontrak sumber ----

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Path = ReadonlyArray<string | number>;
type JsonKind = "null" | "boolean" | "number" | "string" | "array" | "object";

const SOURCE = JSON.parse(
  readFileSync(new URL("../contract/animation-contract.json", import.meta.url), "utf8"),
) as Json;

/** Dua puluh bidang tingkat atas (Requirement 2.1 dan 2.16), ditulis ulang di sini sebagai oracle. */
const FIELDS = [
  "contract_version",
  "file_name",
  "canvas",
  "duration",
  "limits",
  "allowed_imports",
  "required_exports",
  "pause_rules",
  "forbidden",
  "url_schemes",
  "url_schemes_strict_colon",
  "css_functions_forbidden",
  "color_tokens",
  "color_keywords",
  "color_properties",
  "color_forms",
  "font_variables",
  "kit_style_warnings",
  "diagnostic_code_prefixes",
  "supported_runtime_contract_versions",
] as const;

/** Sepuluh batas yang dibaca verifier (`limits.*`, Requirement 2.1); kunci lain di `limits` dibuang pembaca. */
const LIMIT_KEYS = [
  "source_max_bytes",
  "bundle_max_bytes",
  "dom_max_elements",
  "frame_timeout_ms",
  "verifier_deadline_ms",
  "diagnostics_max",
  "diagnostic_message_max_chars",
  "worker_heap_mb",
  "rss_limit_mb",
  "fold_depth",
] as const;

/** Berjalan lebih dari 100 iterasi (design 14.1 dan Requirement 38.3). */
const RUNS = 200;

/** `fc.jsonValue()` bertipe `JsonValue` milik fast-check; bentuknya sama dengan `Json` di sini. */
const jsonArb = fc.jsonValue() as unknown as fc.Arbitrary<Json>;

function kindOf(value: Json): JsonKind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value === "object" ? "object" : (typeof value as JsonKind);
}

function isObject(value: unknown): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---- oracle: pemeriksaan minimum design 4.3 (identik di tiga pembaca) ----

const isPositiveInt = (value: unknown): boolean =>
  typeof value === "number" && Number.isInteger(value) && value >= 1;

const isStringArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * Semua 20 bidang ada; `contract_version` int >= 1; `supported_runtime_contract_versions` tidak
 * kosong dan memuat `contract_version`; `canvas.*` int > 0; 1 <= `duration.min` <= `duration.max`;
 * `limits.*` int > 0; `color_tokens` tepat 9; `diagnostic_code_prefixes` tepat 11 dan memuat `AGENT`.
 */
function meetsMinimum(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (!FIELDS.every((field) => Object.hasOwn(value, field))) return false;
  const { contract_version: version, supported_runtime_contract_versions: supported } = value;
  if (!isPositiveInt(version)) return false;
  if (!Array.isArray(supported) || supported.length === 0) return false;
  if (!supported.every(isPositiveInt) || !supported.includes(version as number)) return false;

  const { canvas, duration, limits, color_tokens: tokens, diagnostic_code_prefixes: prefixes } = value;
  if (!isObject(canvas) || !["width", "height", "fps"].every((key) => isPositiveInt(canvas[key]))) {
    return false;
  }
  if (!isObject(duration)) return false;
  const { min, max } = duration;
  if (!isPositiveInt(min) || !isPositiveInt(max) || (min as number) > (max as number)) return false;
  if (!isObject(limits) || !LIMIT_KEYS.every((key) => isPositiveInt(limits[key]))) return false;
  if (!isStringArray(tokens) || (tokens as string[]).length !== 9) return false;
  if (!isStringArray(prefixes) || (prefixes as string[]).length !== 11) return false;
  return (prefixes as string[]).includes("AGENT");
}

it("oracle meetsMinimum menerima kontrak sumber (kontrol positif)", () => {
  expect(meetsMinimum(SOURCE)).toBe(true);
  expect(loadContract(SOURCE).ok).toBe(true);
});

// ---- simpul dan mutasi ----

interface Slot {
  readonly path: Path;
  readonly value: Json;
  /** Induknya objek yang bidangnya ditetapkan skema: kunci yang hilang selalu galat. */
  readonly inStruct: boolean;
}

/**
 * `allowed_imports` adalah satu-satunya objek yang kuncinya bebas (`z.record`, satu kunci per
 * modul). Menghapus anaknya tetap sah, jadi tidak dipakai oracle penghapusan.
 */
const isRecordPath = (path: Path): boolean => path.length === 1 && path[0] === "allowed_imports";

/** Semua simpul `root` (termasuk akar), urutan kedalaman-dahulu. */
function slotsOf(root: Json): Slot[] {
  const out: Slot[] = [];
  const visit = (value: Json, path: Path, inStruct: boolean): void => {
    out.push({ path, value, inStruct });
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, index], false));
    } else if (isObject(value)) {
      const struct = !isRecordPath(path);
      for (const [key, child] of Object.entries(value)) visit(child, [...path, key], struct);
    }
  };
  visit(root, [], false);
  return out;
}

/** Mengisi `key` sebagai properti data biasa, juga untuk kunci `__proto__`. */
function define(target: Json[] | Record<string, Json>, key: string | number, value: Json): void {
  if (Array.isArray(target)) {
    target[Number(key)] = value;
    return;
  }
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function parentOf(root: Json, path: Path): Json[] | Record<string, Json> {
  let node = root;
  for (const step of path.slice(0, -1)) node = (node as Record<string | number, Json>)[step] as Json;
  return node as Json[] | Record<string, Json>;
}

/** Salinan `root` dengan simpul di `path` diganti `replacement`. */
function replaceAt(root: Json, path: Path, replacement: Json): Json {
  if (path.length === 0) return structuredClone(replacement);
  const copy = structuredClone(root);
  const last = path[path.length - 1] as string | number;
  define(parentOf(copy, path), last, structuredClone(replacement));
  return copy;
}

/** Salinan `root` tanpa simpul di `path` (kunci objek dihapus, elemen array dibuang). */
function deleteAt(root: Json, path: Path): Json {
  const copy = structuredClone(root);
  const last = path[path.length - 1] as string | number;
  const parent = parentOf(copy, path);
  if (Array.isArray(parent)) parent.splice(Number(last), 1);
  else delete parent[last as string];
  return copy;
}

/** Salinan `root` dengan kunci `key` ditambahkan pada objek di `path`. */
function addKeyAt(root: Json, path: Path, key: string, value: Json): Json {
  const copy = structuredClone(root);
  let node: Json = copy;
  for (const step of path) node = (node as Record<string | number, Json>)[step] as Json;
  define(node as Record<string, Json>, key, structuredClone(value));
  return copy;
}

const pathText = (path: Path): string => (path.length === 0 ? "(root)" : path.join("."));

// ---- hasil yang diperiksa pada setiap masukan ----

/** Pernyataan umum atas satu masukan: tanpa exception, bentuk hasil, murni, masukan tak berubah. */
function expectWellBehaved(input: unknown): ReturnType<typeof loadContract> {
  const before = safeStringify(input);
  const first = loadContract(input);
  const second = loadContract(input);
  expect(safeStringify(input)).toBe(before);
  expect(second).toEqual(first);
  if (first.ok) {
    expect(first.contract.contract_version).toBeGreaterThanOrEqual(1);
    expect(meetsMinimum(input)).toBe(true);
  } else {
    expect(typeof first.reason).toBe("string");
    expect(first.reason.length).toBeGreaterThan(0);
  }
  return first;
}

/** `JSON.stringify` yang tidak melempar, untuk membandingkan masukan sebelum dan sesudah. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "(unserializable)";
  }
}

// ---- generator mutasi ----

type Mutation =
  | { op: "delete"; at: number }
  | { op: "replace"; at: number; value: Json }
  | { op: "extra"; at: number; key: string; value: Json };

const mutationArb: fc.Arbitrary<Mutation> = fc.oneof(
  fc.record({ op: fc.constant("delete" as const), at: fc.nat() }),
  fc.record({
    op: fc.constant("replace" as const),
    at: fc.nat(),
    // Sering bilangan kecil: nilai di sekitar batas (0, 1, -1) lebih berguna daripada JSON acak.
    value: fc.oneof(jsonArb, fc.integer({ min: -2, max: 1000 })),
  }),
  fc.record({ op: fc.constant("extra" as const), at: fc.nat(), key: fc.string(), value: jsonArb }),
);

/** Menerapkan satu mutasi pada simpul ke-`at` (modulo jumlah simpul) dari nilai sekarang. */
function applyMutation(current: Json, mutation: Mutation): Json {
  const slots = slotsOf(current);
  const slot = slots[mutation.at % slots.length] as Slot;
  if (mutation.op === "replace") return replaceAt(current, slot.path, mutation.value);
  if (mutation.op === "delete") {
    return slot.path.length === 0 ? current : deleteAt(current, slot.path);
  }
  return isObject(slot.value) ? addKeyAt(current, slot.path, mutation.key, mutation.value) : current;
}

const mutatedContractArb: fc.Arbitrary<Json> = fc
  .array(mutationArb, { minLength: 1, maxLength: 4 })
  .map((mutations) => mutations.reduce<Json>(applyMutation, SOURCE));

// ---- Property 1 ----

describe("Property 1: validasi kontrak total tanpa exception", () => {
  it("nilai JSON sembarang dan kontrak sah yang dimutasi: tidak melempar, murni, ok hanya bila lolos pemeriksaan minimum", () => {
    // Feature: ai-remotion-animation, Property 1: Validasi kontrak total tanpa exception
    fc.assert(
      fc.property(fc.oneof(jsonArb, mutatedContractArb), (input) => {
        expectWellBehaved(input);
      }),
      { numRuns: RUNS },
    );
  });

  it("nilai yang bukan JSON (undefined, bigint, Date, Map, Set, objek tanpa prototipe) ditolak tanpa melempar", () => {
    fc.assert(
      fc.property(
        fc.anything({
          withBigInt: true,
          withDate: true,
          withMap: true,
          withSet: true,
          withNullPrototype: true,
          withObjectString: true,
          withSparseArray: true,
          withTypedArray: true,
          withBoxedValues: true,
        }),
        (input) => {
          const result = loadContract(input);
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("nilai JSON sembarang hampir tak pernah lolos, dan yang lolos memenuhi pemeriksaan minimum", () => {
    let accepted = 0;
    fc.assert(
      fc.property(jsonArb, (input) => {
        if (expectWellBehaved(input).ok) accepted += 1;
      }),
      { numRuns: RUNS },
    );
    expect(accepted).toBe(0);
  });
});

// ---- oracle penolakan pasti ----

describe("oracle penolakan: satu mutasi yang pasti membuat kontrak tidak sah", () => {
  const sourceSlots = slotsOf(SOURCE);
  const deletable = sourceSlots.filter((slot) => slot.inStruct && slot.path.length > 0);

  it("kontrak sumber punya simpul yang cukup untuk dimutasi (tes tidak kosong secara diam-diam)", () => {
    expect(sourceSlots.length).toBeGreaterThan(200);
    // 20 bidang tingkat atas ditambah kunci bersarang pada objek-objek tetap (canvas, limits, forbidden, ...).
    expect(deletable.length).toBeGreaterThanOrEqual(60);
    const deletablePaths = new Set(deletable.map((slot) => pathText(slot.path)));
    for (const field of FIELDS) expect(deletablePaths.has(field), field).toBe(true);
    // Kunci modul pada `allowed_imports` bebas, jadi bukan kandidat penghapusan pasti-galat.
    expect(deletablePaths.has("allowed_imports.react")).toBe(false);
    expect(deletablePaths.has("allowed_imports.react.values")).toBe(true);
  });

  it("menghapus satu kunci dari objek yang bidangnya tetap menolak dan menyebut path kunci itu", () => {
    fc.assert(
      fc.property(fc.nat(), (pick) => {
        const slot = deletable[pick % deletable.length] as Slot;
        const mutated = deleteAt(SOURCE, slot.path);
        const result = loadContract(mutated);
        expect(result.ok, `menghapus ${pathText(slot.path)}`).toBe(false);
        if (!result.ok) expect(result.reason).toContain(pathText(slot.path));
        expectWellBehaved(mutated);
      }),
      { numRuns: RUNS },
    );
  });

  it("mengganti satu simpul dengan nilai berjenis JSON lain menolak dan menyebut path simpul itu", () => {
    const replacement = fc
      .tuple(fc.nat(), jsonArb)
      .filter(([pick, value]) => {
        const slot = sourceSlots[pick % sourceSlots.length] as Slot;
        return kindOf(value) !== kindOf(slot.value);
      });
    fc.assert(
      fc.property(replacement, ([pick, value]) => {
        const slot = sourceSlots[pick % sourceSlots.length] as Slot;
        const mutated = replaceAt(SOURCE, slot.path, value);
        const result = loadContract(mutated);
        expect(result.ok, `mengganti ${pathText(slot.path)}`).toBe(false);
        if (!result.ok) expect(result.reason).toContain(pathText(slot.path));
        expectWellBehaved(mutated);
      }),
      { numRuns: RUNS },
    );
  });

  it("mengganti satu bilangan dengan bilangan lain: ok sama dengan pemeriksaan minimum (dua arah)", () => {
    // `required_exports.default.param_count` boleh 0 (skema `min(0)`); semua bilangan lain bilangan bulat >= 1.
    const numeric = sourceSlots.filter(
      (slot) => typeof slot.value === "number" && slot.path[slot.path.length - 1] !== "param_count",
    );
    expect(numeric.length).toBeGreaterThan(15);
    const anyNumber = fc.oneof(
      { weight: 4, arbitrary: fc.integer({ min: 1, max: 2000 }) },
      { weight: 2, arbitrary: fc.integer({ min: -50, max: 0 }) },
      { weight: 1, arbitrary: fc.double({ noInteger: true, noNaN: true, noDefaultInfinity: true }) },
    );
    let accepted = 0;
    let rejected = 0;
    fc.assert(
      fc.property(fc.nat(), anyNumber, (pick, value) => {
        const slot = numeric[pick % numeric.length] as Slot;
        const mutated = replaceAt(SOURCE, slot.path, value);
        const expected = meetsMinimum(mutated);
        expect(loadContract(mutated).ok, `${pathText(slot.path)} = ${value}`).toBe(expected);
        if (expected) accepted += 1;
        else rejected += 1;
      }),
      { numRuns: RUNS },
    );
    // Kedua cabang benar-benar terjangkau: bilangan sah lain diterima, yang tidak sah ditolak.
    expect(accepted).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(0);
  });

  it("kunci tambahan pada objek yang bidangnya tetap dibuang tanpa menolak kontrak", () => {
    const structs = sourceSlots.filter((slot) => isObject(slot.value) && !isRecordPath(slot.path));
    expect(structs.length).toBeGreaterThan(10);
    const pristine = loadContract(SOURCE);
    if (!pristine.ok) throw new Error(pristine.reason);
    const key = fc.oneof(
      fc.string().map((text) => `x_${text}`),
      fc.constantFrom("__proto__", "constructor", "prototype", "toString"),
    );
    fc.assert(
      fc.property(fc.nat(), key, jsonArb, (pick, extraKey, value) => {
        const slot = structs[pick % structs.length] as Slot;
        fc.pre(!Object.hasOwn(slot.value as object, extraKey));
        const mutated = addKeyAt(SOURCE, slot.path, extraKey, value);
        const result = loadContract(mutated);
        expect(result.ok, `kunci ${JSON.stringify(extraKey)} di ${pathText(slot.path)}`).toBe(true);
        if (!result.ok) return;
        for (const field of FIELDS) expect(result.contract[field]).toEqual(pristine.contract[field]);
        expect(Object.keys(result.contract)).not.toContain(extraKey);
      }),
      { numRuns: RUNS },
    );
  });
});
