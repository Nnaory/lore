// Tes langkah 7, gerbang kesetiaan data (tugas 7.1; Requirement 10.1 sampai 10.12, 6.7, 12;
// design 5.10 dan 5.11).
// Tiga lapis: (1) matriks `lesson` dan `puzzle` dengan teks frame buatan, supaya tiap cabang
// algoritma diuji tepat dan cepat; (2) tes properti 10.7 dengan `fast-check` yang membangun DOM
// jsdom sungguhan dan mengambil teksnya lewat `extractFrameText`; (3) jalur render nyata
// (`runRenderJob` dari `render-core.ts`) untuk subtree tersembunyi, judul SVG, jeda puzzle, dan
// seluruh `fixtures/good`, yang semuanya harus lolos gerbang bersama pendamping JSON-nya.
// Artefak teks frame dan `sampleFrames` dipakai dari `render.ts` (tugas 6.2), jadi tes ini memakai
// kunci artefak dan himpunan sampel yang sama dengan langkah 6 sungguhan.
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { build } from "esbuild";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../src/clock.js";
import { loadContract, type Contract } from "../src/contract.js";
import { orderForOutput } from "../src/diagnostics.js";
import { fidelityStep, TOKEN_ECHO_CHARS } from "../src/steps/fidelity.js";
import { DEFAULT_STEPS } from "../src/steps/registry.js";
import {
  extractFrameText,
  runRenderJob,
  type FrameCapture,
  type ResultMessage,
  type TextNodeLike,
} from "../src/steps/render-core.js";
import {
  FRAMES_ARTIFACT,
  createRenderStep,
  sampleFrames,
  type RenderHost,
  type RenderedFrame,
} from "../src/steps/render.js";
import { ArtifactStore, BUNDLE_ARTIFACT, META_ARTIFACT, createStepContext } from "../src/steps/step.js";
import { normalizeToken } from "../src/tokens.js";
import type { Diagnostic, Kind, MainMeta } from "../src/types.js";

vi.setConfig({ testTimeout: 60_000 });

// ---- kontrak dan pembantu ----

const PKG_ROOT = new URL("../", import.meta.url).pathname;
const GOOD_DIR = new URL("../fixtures/good/", import.meta.url);

const loaded = loadContract(
  JSON.parse(readFileSync(new URL("../contract/animation-contract.json", import.meta.url), "utf8")),
);
if (!loaded.ok) throw new Error(`kontrak sumber tidak sah: ${loaded.reason}`);
const contract: Contract = loaded.contract;

function metaFor(durationInFrames: number, pauseAtFrame?: number): MainMeta {
  const meta: MainMeta = { width: 1280, height: 720, fps: 30, durationInFrames };
  if (pauseAtFrame !== undefined) meta.pauseAtFrame = pauseAtFrame;
  return meta;
}

/** Teks frame yang diberikan langkah 6 kepada langkah 7. */
type FrameTexts = readonly RenderedFrame[]; // terurut naik menurut nomor frame

/** Seperti langkah 6: teks mentah tiap frame yang berhasil ditangkap, terurut naik. */
function frameTextsFromCaptures(frames: Readonly<Record<number, FrameCapture>>): FrameTexts {
  return Object.keys(frames)
    .map(Number)
    .sort((a, b) => a - b)
    .map((frame) => ({ frame, text: frames[frame]?.text ?? "" }));
}

const LESSON_META = metaFor(60);
const LESSON_FRAMES = sampleFrames(60, undefined, "lesson"); // 0, 15, 30, 45, 59
const PUZZLE_META = metaFor(150, 90);
const PUZZLE_FRAMES = sampleFrames(150, 90, "puzzle"); // 0, 37, 45, 75, 89, 90, 112, 149

/** Teks sama di semua frame, dengan penggantian per frame. */
function textsFor(
  frames: readonly number[],
  base: string,
  overrides: Readonly<Record<number, string>> = {},
): FrameTexts {
  return frames.map((frame) => ({ frame, text: overrides[frame] ?? base }));
}

interface Scenario {
  kind: Kind;
  meta?: MainMeta;
  texts?: FrameTexts;
  required?: readonly string[];
  forbidden?: readonly string[];
}

/** Menjalankan langkah 7 dengan artefak yang diberikan; artefak yang tidak diberikan tidak diisi. */
async function runFidelity(scenario: Scenario): Promise<Diagnostic[]> {
  const artifacts = new ArtifactStore();
  if (scenario.meta !== undefined) artifacts.set(META_ARTIFACT, scenario.meta);
  if (scenario.texts !== undefined) artifacts.set(FRAMES_ARTIFACT, scenario.texts);
  const context = createStepContext({
    input: {
      source: "",
      kind: scenario.kind,
      required_tokens: [...(scenario.required ?? [])],
      forbidden_tokens: [...(scenario.forbidden ?? [])],
      contract_version: contract.contract_version,
    },
    contract,
    clock: new FakeClock(),
    deadlineAt: Number.POSITIVE_INFINITY,
    artifacts,
  });
  return [...(await fidelityStep.run(context)).diagnostics];
}

const lesson = (texts: FrameTexts, required: readonly string[]): Scenario => ({
  kind: "lesson",
  meta: LESSON_META,
  texts,
  required,
});

const puzzle = (
  texts: FrameTexts,
  required: readonly string[],
  forbidden: readonly string[] = [],
): Scenario => ({ kind: "puzzle", meta: PUZZLE_META, texts, required, forbidden });

const messages = (diagnostics: readonly Diagnostic[]): string[] => diagnostics.map((d) => d.message);
const codes = (diagnostics: readonly Diagnostic[]): string[] => diagnostics.map((d) => d.code);

// ---- pendaftaran ----

describe("langkah 7: pendaftaran", () => {
  it("terdaftar di registri produksi sebagai langkah 7", () => {
    expect(fidelityStep.number).toBe(7);
    expect(DEFAULT_STEPS.filter((step) => step.number === 7)).toEqual([fidelityStep]);
  });
});

// ---- lesson ----

describe("langkah 7: lesson (Requirement 10.2, 10.9)", () => {
  it("tanpa Diagnostic bila semua Required_Token ada di frame terakhir", async () => {
    const texts = textsFor(LESSON_FRAMES, "Alpha Beta Gamma");
    expect(await runFidelity(lesson(texts, ["Alpha", "Gamma"]))).toEqual([]);
  });

  it("satu FIDELITY_TOKEN_MISSING per token yang hilang, dengan tool, severity, dan pesan tetap", async () => {
    const texts = textsFor(LESSON_FRAMES, "Alpha");
    const result = await runFidelity(lesson(texts, ["Alpha", "Beta", "Gamma"]));
    expect(result).toEqual([
      { tool: "fidelity", code: "FIDELITY_TOKEN_MISSING", severity: "error", message: 'frame=59 missing "Beta"' },
      { tool: "fidelity", code: "FIDELITY_TOKEN_MISSING", severity: "error", message: 'frame=59 missing "Gamma"' },
    ]);
    for (const diagnostic of result) {
      expect(diagnostic).not.toHaveProperty("line");
      expect(diagnostic).not.toHaveProperty("column");
    }
  });

  it("hanya frame terakhir yang menentukan: token di frame lain tidak menolong", async () => {
    const texts = textsFor(LESSON_FRAMES, "nothing", { 0: "Alpha", 30: "Alpha", 59: "Beta" });
    expect(messages(await runFidelity(lesson(texts, ["Alpha"])))).toEqual(['frame=59 missing "Alpha"']);
  });

  it("tidak memakai Forbidden_Token sama sekali, termasuk peringatan tumpang tindih", async () => {
    const texts = textsFor(LESSON_FRAMES, "Alpha Secret");
    const scenario: Scenario = { ...lesson(texts, ["Alpha"]), forbidden: ["Secret", "alpha", ""] };
    expect(await runFidelity(scenario)).toEqual([]);
  });

  it("mengabaikan pauseAtFrame pada meta lesson", async () => {
    const texts = textsFor(LESSON_FRAMES, "Alpha", { 30: "-" });
    const scenario: Scenario = { ...lesson(texts, ["Alpha"]), meta: metaFor(60, 30) };
    expect(await runFidelity(scenario)).toEqual([]);
  });
});

// ---- puzzle ----

describe("langkah 7: puzzle, Required_Token di frame jeda dan frame terakhir (Requirement 10.3)", () => {
  it.each([
    ["ada di kedua frame", "Alpha", "Alpha", []],
    ["hilang hanya di frame terakhir", "Alpha", "-", ['frame=149 missing "Alpha"']],
    ["hilang hanya di frame jeda", "-", "Alpha", ['frame=90 missing "Alpha"']],
    ["hilang di kedua frame: tetap satu Diagnostic yang menyebut frame jeda", "-", "-", ['frame=90 missing "Alpha"']],
  ])("token %s", async (_name, atPause, atLast, expected) => {
    const texts = textsFor(PUZZLE_FRAMES, "-", { 90: atPause, 149: atLast });
    expect(messages(await runFidelity(puzzle(texts, ["Alpha"])))).toEqual(expected);
  });

  it("memeriksa satu frame saja bila pauseAtFrame sama dengan d - 1", async () => {
    const meta = metaFor(100, 99);
    const frames = sampleFrames(100, 99, "puzzle");
    const base: Scenario = { kind: "puzzle", meta, required: ["Alpha"] };
    expect(await runFidelity({ ...base, texts: textsFor(frames, "Alpha") })).toEqual([]);
    expect(messages(await runFidelity({ ...base, texts: textsFor(frames, "-") }))).toEqual([
      'frame=99 missing "Alpha"',
    ]);
  });

  it("tidak memeriksa Required_Token di frame sampel lain", async () => {
    const texts = textsFor(PUZZLE_FRAMES, "-", { 90: "Alpha", 149: "Alpha" });
    expect(await runFidelity(puzzle(texts, ["Alpha"]))).toEqual([]);
  });
});

describe("langkah 7: puzzle, Forbidden_Token sebelum jawaban (Requirement 10.4, 10.6, 10.11)", () => {
  const SHOWN = "Alpha Secret";
  const base = (overrides: Readonly<Record<number, string>>): FrameTexts =>
    textsFor(PUZZLE_FRAMES, "Alpha", overrides);

  it("tidak melapor bila token hanya tampak setelah frame jeda (jawaban boleh diungkap)", async () => {
    expect(await runFidelity(puzzle(base({ 112: SHOWN, 149: SHOWN }), ["Alpha"], ["Secret"]))).toEqual([]);
  });

  it("melapor bila token tampak tepat di frame jeda", async () => {
    const result = await runFidelity(puzzle(base({ 90: SHOWN }), ["Alpha"], ["Secret"]));
    expect(result).toEqual([
      {
        tool: "fidelity",
        code: "FIDELITY_FORBIDDEN_TOKEN_VISIBLE",
        severity: "error",
        message: 'frame=90 shows "Secret" before the answer',
      },
    ]);
  });

  it("melapor satu Diagnostic per token dengan frame sampel terkecil yang menampakkannya", async () => {
    const texts = base({ 89: SHOWN, 90: SHOWN, 112: SHOWN });
    expect(messages(await runFidelity(puzzle(texts, ["Alpha"], ["Secret"])))).toEqual([
      'frame=89 shows "Secret" before the answer',
    ]);
    const everywhere = textsFor(PUZZLE_FRAMES, SHOWN);
    expect(messages(await runFidelity(puzzle(everywhere, ["Alpha"], ["Secret"])))).toEqual([
      'frame=0 shows "Secret" before the answer',
    ]);
  });

  it("memeriksa setiap frame sampel <= p, bukan hanya frame jeda", async () => {
    expect(messages(await runFidelity(puzzle(base({ 37: SHOWN }), ["Alpha"], ["Secret"])))).toEqual([
      'frame=37 shows "Secret" before the answer',
    ]);
  });

  it("mencocokkan setelah normalisasi (NFKC, huruf kecil, tanpa spasi)", async () => {
    const texts = base({ 45: "Al pha SE\nCRET" });
    expect(messages(await runFidelity(puzzle(texts, ["Alpha"], ["ｓｅｃｒｅｔ"])))).toEqual([
      'frame=45 shows "ｓｅｃｒｅｔ" before the answer',
    ]);
  });

  it("melapor tiap Forbidden_Token secara terpisah menurut urutan masukan", async () => {
    const texts = base({ 0: "Alpha Foo Qux" });
    expect(messages(await runFidelity(puzzle(texts, ["Alpha"], ["Qux", "Absent", "Foo"])))).toEqual([
      'frame=0 shows "Qux" before the answer',
      'frame=0 shows "Foo" before the answer',
    ]);
  });
});

describe("langkah 7: Forbidden_Token yang tumpang tindih dengan Required_Token (Requirement 10.5, 10.10)", () => {
  it("membuang token yang sama dengan Required_Token dan mencatat peringatan, tanpa FORBIDDEN_TOKEN_VISIBLE", async () => {
    const texts = textsFor(PUZZLE_FRAMES, "Ya");
    const result = await runFidelity(puzzle(texts, ["Ya"], [" y A", "Beta"]));
    expect(result).toEqual([
      {
        tool: "fidelity",
        code: "FIDELITY_FORBIDDEN_OVERLAPS_REQUIRED",
        severity: "warning",
        message: 'forbidden token also required, ignored: " y A"',
      },
    ]);
  });

  it("menghapus Required_Token yang memuat Forbidden_Token sebelum mencocokkan", async () => {
    const required = ["Pick 4 items"];
    expect(await runFidelity(puzzle(textsFor(PUZZLE_FRAMES, "Pick 4 items"), required, ["4"]))).toEqual([]);
    expect(await runFidelity(puzzle(textsFor(PUZZLE_FRAMES, "pick4items"), required, ["4"]))).toEqual([]);
    const stray = textsFor(PUZZLE_FRAMES, "Pick 4 items", { 45: "Pick 4 items and 4" });
    expect(messages(await runFidelity(puzzle(stray, required, ["4"])))).toEqual([
      'frame=45 shows "4" before the answer',
    ]);
  });

  it("menghapus semua kemunculan dan semua Required_Token yang memuat token", async () => {
    const required = ["Pick 4 items", "4 items"];
    const texts = textsFor(PUZZLE_FRAMES, "4 items Pick 4 items 4 items");
    expect(await runFidelity(puzzle(texts, required, ["4"]))).toEqual([]);
  });

  it("menghapus Required_Token yang terpanjang lebih dulu", async () => {
    // Menghapus "ab" lebih dulu meninggalkan "b" dari "bab"; terpanjang lebih dulu menghabiskannya.
    const texts = textsFor(PUZZLE_FRAMES, "bab");
    expect(await runFidelity(puzzle(texts, ["ab", "bab"], ["b"]))).toEqual([]);
  });

  it("tidak menyambung teks di kiri dan kanan Required_Token menjadi kecocokan palsu", async () => {
    // "a" + "xaby" + "b": bila "xaby" dihapus rapat, sisanya "ab" cocok dengan token terlarang.
    const texts = textsFor(PUZZLE_FRAMES, "axabyb");
    expect(await runFidelity(puzzle(texts, ["xaby"], ["ab"]))).toEqual([]);
  });

  it("tetap melapor Forbidden_Token yang bukan substring Required_Token mana pun", async () => {
    const texts = textsFor(PUZZLE_FRAMES, "Pick 4 items", { 0: "Pick 4 items 7" });
    expect(messages(await runFidelity(puzzle(texts, ["Pick 4 items"], ["4", "7"])))).toEqual([
      'frame=0 shows "7" before the answer',
    ]);
  });
});

// ---- token kosong, ganda, dan normalisasi ----

describe("langkah 7: token kosong, ganda, dan normalisasi (Requirement 10.1, 10.9)", () => {
  const EMPTY_AFTER_NORMALIZATION = ["", "  ", "\t\n", "\uFEFF", "\u00A0\u3000"];

  it("mengabaikan Required_Token yang kosong setelah normalisasi tanpa Diagnostic", async () => {
    const texts = textsFor(LESSON_FRAMES, "");
    expect(await runFidelity(lesson(texts, EMPTY_AFTER_NORMALIZATION))).toEqual([]);
    expect(await runFidelity(puzzle(textsFor(PUZZLE_FRAMES, ""), EMPTY_AFTER_NORMALIZATION))).toEqual([]);
  });

  it("mengabaikan Forbidden_Token yang kosong setelah normalisasi walau frame penuh teks", async () => {
    const texts = textsFor(PUZZLE_FRAMES, "Alpha");
    expect(await runFidelity(puzzle(texts, ["Alpha"], EMPTY_AFTER_NORMALIZATION))).toEqual([]);
  });

  it("tidak menganggap U+200B (bukan \\s) kosong, sehingga token itu wajib ada", async () => {
    const texts = textsFor(LESSON_FRAMES, "Alpha");
    expect(messages(await runFidelity(lesson(texts, ["\u200B"])))).toEqual(['frame=59 missing "\u200B"']);
  });

  it("menghitung token ganda menurut bentuk ternormalisasi sebagai satu token (kemunculan pertama)", async () => {
    const texts = textsFor(LESSON_FRAMES, "-");
    const result = await runFidelity(lesson(texts, ["Alpha", "alpha", " ALPHA ", "Beta"]));
    expect(messages(result)).toEqual(['frame=59 missing "Alpha"', 'frame=59 missing "Beta"']);
  });

  it("mencocokkan lewat NFKC, huruf kecil, dan penghapusan spasi pada token dan teks frame", async () => {
    const tokens = ["ＡＢＣ", "Hello  World", "ﬁne", "Tab\tSeparated"];
    const texts = textsFor(LESSON_FRAMES, "x", { 59: "abc HELLOworld\nFINE tab separated" });
    expect(await runFidelity(lesson(texts, tokens))).toEqual([]);
  });

  it("memperlakukan teks frame sebagai gabungan satu string: token boleh melintasi batas node", async () => {
    const texts = textsFor(LESSON_FRAMES, "x", { 59: "Hel" + "lo " + "World" });
    expect(await runFidelity(lesson(texts, ["Hello World"]))).toEqual([]);
  });
});

// ---- urutan dan pesan ----

describe("langkah 7: urutan Diagnostic (Requirement 10.12)", () => {
  it("OVERLAPS, lalu MISSING, lalu VISIBLE, dan di dalam satu kode menurut urutan token masukan", async () => {
    const texts = textsFor(PUZZLE_FRAMES, "-", { 0: "qux foo", 90: "-", 149: "-" });
    const result = await runFidelity(
      puzzle(texts, ["zeta", "alpha", "same"], ["qux", "SAME", "foo", "other", "ZETA"]),
    );
    expect(result.map((d) => `${d.code}|${d.message}`)).toEqual([
      'FIDELITY_FORBIDDEN_OVERLAPS_REQUIRED|forbidden token also required, ignored: "SAME"',
      'FIDELITY_FORBIDDEN_OVERLAPS_REQUIRED|forbidden token also required, ignored: "ZETA"',
      'FIDELITY_TOKEN_MISSING|frame=90 missing "zeta"',
      'FIDELITY_TOKEN_MISSING|frame=90 missing "alpha"',
      'FIDELITY_TOKEN_MISSING|frame=90 missing "same"',
      'FIDELITY_FORBIDDEN_TOKEN_VISIBLE|frame=0 shows "qux" before the answer',
      'FIDELITY_FORBIDDEN_TOKEN_VISIBLE|frame=0 shows "foo" before the answer',
    ]);
    expect(orderForOutput(result)).toEqual(result);
  });

  it("urutan token masukan, bukan abjad", async () => {
    const result = await runFidelity(lesson(textsFor(LESSON_FRAMES, "-"), ["zeta", "alpha", "mid"]));
    expect(messages(result)).toEqual([
      'frame=59 missing "zeta"',
      'frame=59 missing "alpha"',
      'frame=59 missing "mid"',
    ]);
  });
});

describe("langkah 7: cuplikan token di pesan (Requirement 10.11)", () => {
  it("memuat 80 karakter pertama token asli", async () => {
    const long = `${"x".repeat(TOKEN_ECHO_CHARS)}${"y".repeat(40)}`;
    const result = await runFidelity(lesson(textsFor(LESSON_FRAMES, "-"), [long]));
    expect(messages(result)).toEqual([`frame=59 missing "${"x".repeat(80)}"`]);
  });

  it("menghitung titik kode, tidak membelah pasangan surrogat, dan tetap <= 200 karakter", async () => {
    const emoji = "\u{1F600}".repeat(100);
    const meta = metaFor(900, 899);
    const frames = [0, 899];
    const texts: FrameTexts = [
      { frame: 0, text: "" },
      { frame: 899, text: emoji },
    ];
    const missing = await runFidelity({
      kind: "puzzle",
      meta,
      texts: textsFor(frames, ""),
      required: [emoji],
    });
    const shown = await runFidelity({ kind: "puzzle", meta, texts, required: [], forbidden: [emoji] });
    const first80 = "\u{1F600}".repeat(80);
    expect(messages(missing)).toEqual([`frame=899 missing "${first80}"`]);
    expect(messages(shown)).toEqual([`frame=899 shows "${first80}" before the answer`]);
    expect(messages(shown)[0]).toHaveLength(196);
    for (const message of [...messages(missing), ...messages(shown)]) {
      expect(message.length).toBeLessThanOrEqual(contract.limits.diagnostic_message_max_chars);
    }
  });

  it("mengganti surrogat tunggal dengan U+FFFD agar pesan tetap sah", async () => {
    const result = await runFidelity(lesson(textsFor(LESSON_FRAMES, "-"), ["ab\uD800cd", "ef\uDC00gh"]));
    expect(messages(result)).toEqual(['frame=59 missing "ab\uFFFDcd"', 'frame=59 missing "ef\uFFFDgh"']);
  });
});

// ---- galat internal ----

describe("langkah 7: artefak yang tidak ada adalah galat internal (gagal tertutup)", () => {
  it("meta statis tidak ada", async () => {
    await expect(runFidelity({ kind: "lesson", texts: textsFor(LESSON_FRAMES, "x") })).rejects.toThrow(
      /static meta/,
    );
  });

  it("teks frame dari langkah 6 tidak ada", async () => {
    await expect(runFidelity({ kind: "lesson", meta: LESSON_META })).rejects.toThrow(/frame texts/);
  });

  it("teks frame terakhir tidak ada", async () => {
    const texts = textsFor(LESSON_FRAMES.filter((frame) => frame !== 59), "x");
    await expect(runFidelity(lesson(texts, ["x"]))).rejects.toThrow(/frame 59/);
  });

  it("puzzle tanpa pauseAtFrame pada meta", async () => {
    const scenario: Scenario = {
      kind: "puzzle",
      meta: LESSON_META,
      texts: textsFor(LESSON_FRAMES, "x"),
      required: ["x"],
    };
    await expect(runFidelity(scenario)).rejects.toThrow(/pauseAtFrame/);
  });

  it("puzzle tanpa teks frame jeda", async () => {
    const texts = textsFor(PUZZLE_FRAMES.filter((frame) => frame !== 90), "x");
    await expect(runFidelity(puzzle(texts, ["x"]))).rejects.toThrow(/frame 90/);
  });

  it("pesan galat tidak memuat token atau teks masukan", async () => {
    const secret = "LORE_SECRET_SENTINEL";
    const failing = runFidelity({ kind: "lesson", meta: LESSON_META, required: [secret] });
    await expect(failing).rejects.toThrow(/frame texts/);
    await failing.catch((error: unknown) => {
      expect(String((error as Error).message)).not.toContain(secret);
    });
  });
});

// ---- tes properti 10.7 ----

interface JsdomDocument {
  getElementById(id: string): (TextNodeLike & {
    replaceChildren(): void;
    appendChild(node: unknown): unknown;
  }) | null;
  createElement(name: string): { textContent: string | null };
  createTextNode(text: string): unknown;
}

describe("langkah 7: properti 10.7 pada DOM jsdom", () => {
  const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
    JSDOM: new (html: string) => { window: { document: JsdomDocument } };
  };
  const document = new JSDOM('<!doctype html><div id="root"></div>').window.document;

  /** Teks frame dari DOM: satu `span` per token, dipisah node teks spasi (token berspasi). */
  function domText(tokens: readonly string[]): string {
    const root = document.getElementById("root");
    if (root === null) throw new Error("jsdom page has no #root");
    root.replaceChildren();
    tokens.forEach((token, index) => {
      if (index > 0) root.appendChild(document.createTextNode(" "));
      const span = document.createElement("span");
      span.textContent = token;
      root.appendChild(span);
    });
    return extractFrameText(root);
  }

  const forms = (tokens: readonly string[]): string[] => tokens.map(normalizeToken);

  /** Daftar yang memenuhi prasyarat 10.7: tak kosong, unik, tanpa substring antartoken. */
  function isEligible(tokens: readonly string[]): boolean {
    const all = forms(tokens);
    return all.every(
      (form, i) => form !== "" && all.every((other, j) => i === j || !other.includes(form)),
    );
  }

  const tokensArb = fc.uniqueArray(fc.string({ minLength: 2, maxLength: 10 }), {
    minLength: 1,
    maxLength: 8,
    selector: normalizeToken,
  });
  const kindArb = fc.constantFrom<Kind>("lesson", "puzzle");

  function scenarioFor(kind: Kind, tokens: readonly string[], text: string): Scenario {
    if (kind === "lesson") {
      return { kind, meta: metaFor(40), texts: textsFor(sampleFrames(40, undefined, kind), text), required: tokens };
    }
    return { kind, meta: metaFor(40, 20), texts: textsFor(sampleFrames(40, 20, kind), text), required: tokens };
  }

  it("DOM yang memuat semua token menghasilkan nol FIDELITY_*", async () => {
    await fc.assert(
      fc.asyncProperty(tokensArb, kindArb, async (tokens, kind) => {
        fc.pre(isEligible(tokens));
        expect(await runFidelity(scenarioFor(kind, tokens, domText(tokens)))).toEqual([]);
      }),
    );
  });

  it("membuang satu token menghasilkan tepat satu FIDELITY_TOKEN_MISSING untuk token itu", async () => {
    await fc.assert(
      fc.asyncProperty(tokensArb, kindArb, fc.nat(), async (tokens, kind, pick) => {
        fc.pre(isEligible(tokens));
        const dropped = pick % tokens.length;
        const rest = tokens.filter((_, index) => index !== dropped);
        const droppedForm = normalizeToken(tokens[dropped] ?? "");
        // Teks sisa tidak boleh memuat token itu karena tersambung antar-token.
        fc.pre(!forms(rest).join("").includes(droppedForm));
        const result = await runFidelity(scenarioFor(kind, tokens, domText(rest)));
        expect(result).toHaveLength(1);
        expect(result[0]?.code).toBe("FIDELITY_TOKEN_MISSING");
        expect(result[0]?.message).toContain(`"${tokens[dropped]}"`);
      }),
    );
  });
});

// ---- jalur render nyata ----

const META_LITERAL = (d: number, p?: number): string =>
  `{ width: 1280, height: 720, fps: 30, durationInFrames: ${d}${p === undefined ? "" : `, pauseAtFrame: ${p}`} }`;

/** Bundle CJS tulisan tangan: `body` adalah isi `Main`. */
function handBundle(body: string, meta: MainMeta): string {
  return [
    '"use strict";',
    'const React = require("react"); const R = require("remotion"); const h = React.createElement;',
    `module.exports = { meta: ${META_LITERAL(meta.durationInFrames, meta.pauseAtFrame)}, default: function Main() { ${body} } };`,
  ].join("\n");
}

/** Bundle TypeScript dengan esbuild, sama seperti langkah 5 (design 5.8). */
async function esbuildBundle(source: string): Promise<string> {
  const out = await build({
    stdin: { contents: source, loader: "ts", sourcefile: "main.ts", resolveDir: PKG_ROOT },
    bundle: true,
    format: "cjs",
    platform: "browser",
    target: "es2022",
    external: ["react", "remotion"],
    write: false,
    logLevel: "silent",
    legalComments: "none",
    charset: "utf8",
    absWorkingDir: "/",
  });
  const file = out.outputFiles[0];
  if (file === undefined) throw new Error("esbuild produced no output");
  return file.text;
}

async function renderReal(bundle: string, meta: MainMeta, kind: Kind): Promise<ResultMessage> {
  const result = await runRenderJob(
    {
      type: "run",
      bundle,
      frames: sampleFrames(meta.durationInFrames, meta.pauseAtFrame, kind),
      shim: { allowed_imports: contract.allowed_imports },
      fps: meta.fps,
      width: meta.width,
      height: meta.height,
      staticMeta: meta,
    },
    () => undefined,
  );
  expect(result.evaluateError).toBeUndefined();
  for (const [frame, capture] of Object.entries(result.frames)) {
    expect(capture.error, `frame ${frame}`).toBeUndefined();
  }
  return result;
}

/** Menjalankan langkah 7 pada hasil render nyata. */
async function fidelityOn(
  result: ResultMessage,
  meta: MainMeta,
  kind: Kind,
  required: readonly string[],
  forbidden: readonly string[] = [],
): Promise<Diagnostic[]> {
  return runFidelity({ kind, meta, texts: frameTextsFromCaptures(result.frames), required, forbidden });
}

describe("langkah 7 pada render nyata: ekstraksi teks frame (design 5.11, Requirement 10.8)", () => {
  const meta = metaFor(30);

  const body =
    'return h("div", null, ' +
    'h("p", null, "shown"), ' +
    'h("p", { style: { display: "none" } }, "hid-display"), ' +
    'h("p", { style: { visibility: "hidden" } }, "hid-visibility"), ' +
    'h("p", { style: { opacity: 0 } }, "hid-opacity"), ' +
    'h("div", { style: { display: "none" } }, h("span", null, h("b", null, "hid-deep"))), ' +
    'h("svg", null, h("title", null, "svg-title"), h("desc", null, "svg-desc"), h("text", null, "svg-text")), ' +
    'h("style", null, "style-text"), ' +
    'h("p", { style: { opacity: 0.5 } }, "half"));';

  it("menghitung teks yang tampak dan tidak menghitung subtree tersembunyi, judul, deskripsi, atau style", async () => {
    const result = await renderReal(handBundle(body, meta), meta, "lesson");
    expect(await fidelityOn(result, meta, "lesson", ["shown", "svg-text", "half"])).toEqual([]);

    const hidden = [
      "hid-display",
      "hid-visibility",
      "hid-opacity",
      "hid-deep",
      "svg-title",
      "svg-desc",
      "style-text",
    ];
    const missing = await fidelityOn(result, meta, "lesson", hidden);
    expect(messages(missing)).toEqual(hidden.map((token) => `frame=29 missing "${token}"`));
    expect(new Set(codes(missing))).toEqual(new Set(["FIDELITY_TOKEN_MISSING"]));
  });

  it("menggabungkan node teks tanpa pemisah sehingga token boleh melintasi elemen", async () => {
    const split = 'return h("div", null, h("span", null, "Hel"), h("b", null, "lo "), "Wor", h("i", null, "ld"));';
    const result = await renderReal(handBundle(split, meta), meta, "lesson");
    expect(await fidelityOn(result, meta, "lesson", ["Hello World", "helloworld"])).toEqual([]);
  });
});

describe("langkah 7 pada render nyata: jeda puzzle (Requirement 10.3, 10.4, 10.6)", () => {
  const meta = metaFor(60, 30);

  /** Menampilkan "ANSWER" mulai frame `from`; "Question" selalu tampak. */
  const revealFrom = (from: number): string =>
    `const f = R.useCurrentFrame(); return h("div", null, "Question ", f >= ${from} ? "ANSWER" : "", " tail");`;

  it("jawaban yang baru muncul setelah frame jeda tidak dilaporkan", async () => {
    const result = await renderReal(handBundle(revealFrom(31), meta), meta, "puzzle");
    expect(await fidelityOn(result, meta, "puzzle", ["Question"], ["ANSWER"])).toEqual([]);
    // Dan token itu memang ada di frame terakhir, jadi pemeriksaan di atas tidak hampa.
    const last = frameTextsFromCaptures(result.frames).find((entry) => entry.frame === 59);
    expect(normalizeToken(last?.text ?? "")).toContain("answer");
  });

  it("jawaban yang tampak di frame jeda dilaporkan dengan nomor frame", async () => {
    const result = await renderReal(handBundle(revealFrom(30), meta), meta, "puzzle");
    expect(messages(await fidelityOn(result, meta, "puzzle", ["Question"], ["ANSWER"]))).toEqual([
      'frame=30 shows "ANSWER" before the answer',
    ]);
  });

  it("jawaban yang tampak sebelum jeda dilaporkan pada frame sampel terkecil yang menampakkannya", async () => {
    const result = await renderReal(handBundle(revealFrom(10), meta), meta, "puzzle");
    // Sampel puzzle d=60, p=30: 0, 15, 29, 30, 45, 59 (dan 15 = floor(p/2)).
    expect(messages(await fidelityOn(result, meta, "puzzle", ["Question"], ["ANSWER"]))).toEqual([
      'frame=15 shows "ANSWER" before the answer',
    ]);
  });

  it("Required_Token yang baru muncul setelah jeda hilang di frame jeda", async () => {
    const result = await renderReal(handBundle(revealFrom(31), meta), meta, "puzzle");
    expect(messages(await fidelityOn(result, meta, "puzzle", ["Question", "ANSWER"], []))).toEqual([
      'frame=30 missing "ANSWER"',
    ]);
  });
});

/** Host dalam proses: menjalankan inti Worker yang sama (`runRenderJob`) tanpa spawn, untuk langkah 6 sungguhan. */
const inProcessHost: RenderHost = {
  async run(request) {
    return { kind: "result", result: await runRenderJob(request.job, () => undefined) };
  },
};

interface Companion {
  kind: Kind;
  required_tokens: string[];
  forbidden_tokens: string[];
}

const fixtureNames = readdirSync(GOOD_DIR)
  .filter((name) => name.endsWith(".ts"))
  .sort();

describe("fixtures/good lolos gerbang kesetiaan lewat render nyata (Requirement 12)", () => {
  it("memuat sedikitnya 8 fixture", () => {
    expect(fixtureNames.length).toBeGreaterThanOrEqual(8);
  });

  describe.each(fixtureNames)("%s", (name) => {
    const source = readFileSync(new URL(name, GOOD_DIR), "utf8");
    const companion = JSON.parse(
      readFileSync(new URL(name.replace(/\.ts$/, ".json"), GOOD_DIR), "utf8"),
    ) as Companion;
    const duration = Number(/durationInFrames:\s*(\d+)/.exec(source)?.[1]);
    const pauseMatch = /pauseAtFrame:\s*(\d+)/.exec(source);
    const meta = metaFor(duration, pauseMatch === null ? undefined : Number(pauseMatch[1]));
    const decisive = companion.kind === "puzzle" ? meta.pauseAtFrame : duration - 1;

    it("langkah 6 lalu langkah 7 berbagi artefak: tanpa galat render dan nol FIDELITY_*", async () => {
      const artifacts = new ArtifactStore();
      artifacts.set(META_ARTIFACT, meta);
      artifacts.set(BUNDLE_ARTIFACT, await esbuildBundle(source));
      const context = createStepContext({
        input: {
          source,
          kind: companion.kind,
          required_tokens: companion.required_tokens,
          forbidden_tokens: companion.forbidden_tokens,
          contract_version: contract.contract_version,
        },
        contract,
        clock: new FakeClock(),
        deadlineAt: Number.POSITIVE_INFINITY,
        artifacts,
      });

      const rendered = await createRenderStep(inProcessHost).run(context);
      expect(rendered.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(artifacts.get(FRAMES_ARTIFACT)?.map((entry) => entry.frame)).toEqual(
        sampleFrames(duration, meta.pauseAtFrame, companion.kind),
      );
      expect((await fidelityStep.run(context)).diagnostics).toEqual([]);
    });

    it("nol Diagnostic FIDELITY_* dengan Required_Token dan Forbidden_Token pendamping", async () => {
      expect(Number.isInteger(duration)).toBe(true);
      const result = await renderReal(await esbuildBundle(source), meta, companion.kind);
      expect(companion.required_tokens.length).toBeGreaterThan(0);

      const diagnostics = await fidelityOn(
        result,
        meta,
        companion.kind,
        companion.required_tokens,
        companion.forbidden_tokens,
      );
      expect(diagnostics).toEqual([]);

      // Token yang tidak ada di animasi terdeteksi tepat satu kali, di frame penentu.
      const withExtra = await fidelityOn(result, meta, companion.kind, [
        ...companion.required_tokens,
        "Zz-not-in-this-animation",
      ]);
      expect(messages(withExtra)).toEqual([`frame=${decisive} missing "Zz-not-in-this-animation"`]);

      // Pemeriksaan Forbidden_Token tidak hampa: setiap token benar-benar tampak di frame terakhir.
      if (companion.kind === "puzzle") {
        const last = frameTextsFromCaptures(result.frames).find((entry) => entry.frame === duration - 1);
        expect(companion.forbidden_tokens.length).toBeGreaterThan(0);
        for (const token of companion.forbidden_tokens) {
          expect(normalizeToken(last?.text ?? "")).toContain(normalizeToken(token));
        }
      }
    });
  });

  it("puzzle-pause: token yang tampak sebelum jeda dan tidak diwajibkan dilaporkan", async () => {
    const source = readFileSync(new URL("puzzle-pause.ts", GOOD_DIR), "utf8");
    const companion = JSON.parse(
      readFileSync(new URL("puzzle-pause.json", GOOD_DIR), "utf8"),
    ) as Companion;
    const meta = metaFor(150, 90);
    const result = await renderReal(await esbuildBundle(source), meta, "puzzle");

    // "What is B?" tampak sejak frame 0 dan bukan Required_Token fixture ini.
    const early = await fidelityOn(result, meta, "puzzle", companion.required_tokens, ["What is B?"]);
    expect(messages(early)).toEqual(['frame=0 shows "What is B?" before the answer']);

    // Keterangan baru muncul di frame 75; dipindah dari Required ke Forbidden, ia terlihat sebelum jeda.
    const caption = companion.required_tokens[0] ?? "";
    const rest = companion.required_tokens.slice(1);
    const moved = await fidelityOn(result, meta, "puzzle", rest, [caption]);
    expect(messages(moved)).toEqual([`frame=75 shows "${caption}" before the answer`]);
  });
});
