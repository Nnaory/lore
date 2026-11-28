// Langkah 7 pipeline verifier: gerbang kesetiaan data (design 5.10 dan 5.11, tabel 5.12;
// Requirement 10.1 sampai 10.12, 6.7, 12; tugas 7.1).
// Langkah ini hanya berjalan setelah langkah 6 tanpa galat, jadi semua frame sampel sudah dirender
// dan teks mentahnya (aturan 5.11, dihitung `extractFrameText` di `render-core.ts`) ada di artefak
// `FRAMES_ARTIFACT` milik `render.ts`. Meta statis dari langkah 2 (`META_ARTIFACT`) memberi `d`
// dan `p`.
//
// Algoritma (design 5.10):
//  1. Token yang kosong setelah normalisasi dibuang tanpa Diagnostic (Requirement 10.9). `tokens.ts`
//     sengaja tidak membuangnya: `containsToken("", x)` selalu benar, jadi pembuangan ada di sini.
//     Token ganda menurut bentuk ternormalisasi dihitung satu kali (kemunculan pertama menang).
//  2. `lesson`: hanya Required_Token yang diperiksa; Forbidden_Token tidak dipakai sama sekali.
//     `puzzle`: Forbidden_Token yang bentuk ternormalisasinya sama dengan sebuah Required_Token
//     dibuang dengan `FIDELITY_FORBIDDEN_OVERLAPS_REQUIRED` (warning, Requirement 10.5).
//  3. `FIDELITY_TOKEN_MISSING`: satu per Required_Token yang tidak ada di frame `d-1` dan, untuk
//     `puzzle`, juga di frame `p`. Token yang hilang di kedua frame tetap satu Diagnostic dan
//     menyebut frame yang lebih awal (`p`), sehingga nomor `p` muncul seperti yang diminta 10.3.
//  4. `FIDELITY_FORBIDDEN_TOKEN_VISIBLE` (hanya `puzzle`): satu per Forbidden_Token yang ada pada
//     teks frame sampel mana pun dengan nomor <= `p`; pesan menyebut frame terkecil yang
//     menampakkannya (Requirement 10.11 meminta satu Diagnostic per token). Frame setelah `p`
//     tidak diperiksa, karena jawaban boleh diungkap (Requirement 10.6).
//     Bila Forbidden_Token adalah substring Required_Token, kemunculan Required_Token itu
//     (yang terpanjang lebih dulu) disingkirkan dari teks frame sebelum mencocokkan (10.10). Tiap
//     kemunculan diganti satu spasi, bukan dihapus rapat: teks ternormalisasi tidak pernah memuat
//     spasi, jadi sisa teks di kiri dan kanan tidak tersambung menjadi kecocokan palsu.
//
// Urutan keluaran mengikuti Requirement 10.12: OVERLAPS, lalu MISSING, lalu VISIBLE; di dalam satu
// kode menurut urutan token pada masukan. Urutan itu dibuat eksplisit di sini dan dipertahankan
// `orderForOutput` di `diagnostics.ts`. Pesan memuat 80 karakter (titik kode, bukan unit UTF-16)
// pertama token ASLI dan nomor frame; surrogat tunggal diganti U+FFFD agar pesan tetap sah di
// Pydantic. Total pesan paling banyak 196 karakter, di bawah batas 200.
//
// Galat internal (meta atau teks frame tidak ada) dilempar sebagai exception tanpa isi masukan;
// `safeVerify` mengubahnya menjadi satu `VERIFIER_INTERNAL`. Masukan pengarang tidak pernah
// melempar. Modul ini murni: tanpa `Date`, `Math.random`, atau iterasi `Map`/`Set` di jalur keluaran.

import { containsToken, normalizeToken } from "../tokens.js";
import type { Diagnostic, MainMeta } from "../types.js";
import { FRAMES_ARTIFACT, type RenderedFrame } from "./render.js";
import { META_ARTIFACT, type StepContext, type VerifierStep } from "./step.js";

/** Panjang cuplikan token di pesan, dalam titik kode (Requirement 10.11). */
export const TOKEN_ECHO_CHARS = 80;

/** Pengganti kemunculan Required_Token. Spasi tidak pernah ada di token atau teks ternormalisasi (semua `\s` dihapus). */
const SEPARATOR = " ";

const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const REPLACEMENT = "\uFFFD";

/** Token masukan beserta bentuk ternormalisasinya (tidak kosong). */
interface Token {
  readonly original: string;
  readonly form: string;
}

/** Token tak kosong setelah normalisasi, tanpa duplikat bentuk; urutan masukan dipertahankan. */
function prepareTokens(tokens: readonly string[]): Token[] {
  const seen = new Set<string>(); // hanya untuk keanggotaan, tidak pernah diiterasi
  const prepared: Token[] = [];
  for (const original of tokens) {
    const form = normalizeToken(original);
    if (form === "" || seen.has(form)) continue;
    seen.add(form);
    prepared.push({ original, form });
  }
  return prepared;
}

/** 80 titik kode pertama token asli, dengan surrogat tunggal diganti U+FFFD. */
function echo(token: Token): string {
  return Array.from(token.original)
    .slice(0, TOKEN_ECHO_CHARS)
    .join("")
    .replace(LONE_SURROGATES, REPLACEMENT);
}

function uniqueAscending(frames: readonly number[]): number[] {
  return [...new Set(frames)].sort((a, b) => a - b);
}

/** Teks frame ternormalisasi untuk frame yang dibutuhkan saja; frame lain tidak perlu dinormalkan. */
function normalizeNeeded(
  captured: readonly RenderedFrame[],
  needed: (frame: number) => boolean,
): ReadonlyMap<number, string> {
  const normalized = new Map<number, string>();
  for (const entry of captured) {
    if (needed(entry.frame) && !normalized.has(entry.frame)) {
      normalized.set(entry.frame, normalizeToken(entry.text));
    }
  }
  return normalized;
}

function textOf(frames: ReadonlyMap<number, string>, frame: number): string {
  const text = frames.get(frame);
  if (text === undefined) throw new Error(`fidelity step has no captured text for frame ${frame}`);
  return text;
}

/** Benar bila `token` tampak di `text` setelah kemunculan Required_Token yang memuatnya disingkirkan. */
function isShown(text: string, token: Token, containing: readonly Token[]): boolean {
  let remaining = text;
  for (const required of containing) remaining = remaining.split(required.form).join(SEPARATOR);
  return containsToken(remaining, token.form);
}

function checkFidelity(
  context: StepContext,
  meta: MainMeta,
  captured: readonly RenderedFrame[],
): Diagnostic[] {
  const { kind } = context.input;
  const required = prepareTokens(context.input.required_tokens);
  const lastFrame = meta.durationInFrames - 1;
  const pause = kind === "puzzle" ? meta.pauseAtFrame : undefined;
  if (kind === "puzzle" && pause === undefined) {
    throw new Error("fidelity step needs meta.pauseAtFrame for a puzzle");
  }

  const frames = normalizeNeeded(
    captured,
    (frame) => frame === lastFrame || (pause !== undefined && frame <= pause),
  );
  const diagnostics: Diagnostic[] = [];

  // (2) Forbidden_Token hanya untuk puzzle; yang sama dengan Required_Token dibuang dengan peringatan.
  const forbidden: Token[] = [];
  if (pause !== undefined) {
    const requiredForms = new Set(required.map((token) => token.form)); // keanggotaan saja
    for (const token of prepareTokens(context.input.forbidden_tokens)) {
      if (requiredForms.has(token.form)) {
        diagnostics.push(
          context.diagnostic(
            "FIDELITY_FORBIDDEN_OVERLAPS_REQUIRED",
            "warning",
            `forbidden token also required, ignored: "${echo(token)}"`,
          ),
        );
      } else {
        forbidden.push(token);
      }
    }
  }

  // (3) Required_Token di frame terakhir dan, untuk puzzle, di frame jeda; satu Diagnostic per token.
  const checked = uniqueAscending(pause === undefined ? [lastFrame] : [pause, lastFrame]);
  for (const token of required) {
    const missingAt = checked.find((frame) => !containsToken(textOf(frames, frame), token.form));
    if (missingAt !== undefined) {
      diagnostics.push(
        context.diagnostic("FIDELITY_TOKEN_MISSING", "error", `frame=${missingAt} missing "${echo(token)}"`),
      );
    }
  }

  // (4) Forbidden_Token pada frame sampel <= p; frame setelah p tidak diperiksa.
  if (pause !== undefined) {
    const early = uniqueAscending(
      captured.filter((entry) => entry.frame <= pause).map((entry) => entry.frame),
    );
    textOf(frames, pause); // frame jeda wajib ada di sampel (design 5.9), bukan sekadar frame awal
    for (const token of forbidden) {
      const containing = required
        .filter((candidate) => candidate.form !== token.form && candidate.form.includes(token.form))
        .sort((a, b) => b.form.length - a.form.length);
      const shownAt = early.find((frame) => isShown(textOf(frames, frame), token, containing));
      if (shownAt !== undefined) {
        diagnostics.push(
          context.diagnostic(
            "FIDELITY_FORBIDDEN_TOKEN_VISIBLE",
            "error",
            `frame=${shownAt} shows "${echo(token)}" before the answer`,
          ),
        );
      }
    }
  }

  return diagnostics;
}

export const fidelityStep: VerifierStep = {
  number: 7,
  run(context) {
    const meta = context.artifacts.get(META_ARTIFACT);
    if (meta === undefined) throw new Error("fidelity step needs the static meta from step 2");
    const captured = context.artifacts.get(FRAMES_ARTIFACT);
    if (captured === undefined) throw new Error("fidelity step needs the frame texts from step 6");
    return { diagnostics: checkFidelity(context, meta, captured) };
  },
};
