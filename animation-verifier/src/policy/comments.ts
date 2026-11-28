// Pemindai komentar untuk Main_File (design 5.5 butir (a) dan 5.6; Requirement 8.10; tugas 5.2,
// diperbaiki di follow-up bug 5.3).
// Komentar direktif tidak bisa dicari dengan regex pada teks mentah: `"// eslint-disable"` di dalam
// string, template, atau regex literal bukan komentar, dan komentar sungguhan bisa tersembunyi
// sesudah regex yang berisi tanda kutip. Satu-satunya yang bisa menentukan apakah sebuah `/` adalah
// pembagian atau awal regex (dan apakah `}` menutup blok atau substitusi template) adalah tata
// bahasa, bukan token sebelumnya: `a! / 2` (non-null lalu pembagian) dan `if (x) /"/.test(s)`
// (regex sesudah `)`), `{}` lalu regex, `await /x/`, dan `of /x/` semuanya sah dan tak terbedakan
// oleh heuristik "token sebelumnya". Versi pertama modul ini memakai heuristik itu, dan
// `a! / 2; // @ts-ignore` meloloskan arahan penekan tipe. Karena itu pembagian kerjanya sekarang:
//   1. Parser TypeScript (`ts.createSourceFile`, `ScriptKind.TS` seperti `main.ts` di ESLint dan
//      tsc) menentukan SEMUA teks mentah: string, regex, dan potongan template. Parser memutuskan
//      regex atau pembagian dengan konteks tata bahasa yang sama dengan yang dipakai compiler untuk
//      menilai `@ts-ignore`, jadi tidak ada selisih tafsir antara pemindai ini dan compiler.
//   2. Teks di luar potongan itu hanya berisi spasi, komentar, pengenal, angka, dan tanda baca,
//      yang diurai `ts.createScanner` (tanpa melewati trivia) secara sama di konteks apa pun. Setiap
//      segmen di antara dua potongan teks mentah dipindai sendiri, sehingga scanner tidak pernah
//      memasuki regex atau template dan tidak perlu menebak.
// Akibatnya, untuk sumber yang valid secara sintaks tidak ada komentar yang terlewat atau terhitung
// berlebih. Sumber yang tidak valid secara sintaks tidak dijanjikan apa pun di sini, dan tetap
// ditolak langkah 3 (`ESLINT_PARSE_ERROR`) serta langkah 4 (galat sintaks compiler).
// Jalur cadangan: parser TypeScript bersifat rekursif dan melempar `RangeError` (stack habis) pada
// sumber yang bersarang sangat dalam (sekitar seribu tingkat kurung, jauh di bawah batas 32 KiB).
// Pada kasus itu `scanComments` tetap total dan jatuh ke pemindaian leksikal dengan heuristik
// "token sebelumnya" (`scanLexically`). Sumber seperti itu juga gagal di langkah 3 dan 4
// (`ESLINT_PARSE_ERROR`, `VERIFIER_INTERNAL`), jadi kekurangan heuristik tidak membuka celah; tes
// pipeline di `tests/comments-gate.test.ts` mengunci hal itu.
// Modul ini dipakai langkah 3 (`ESLINT_INLINE_DIRECTIVE`) dan langkah 4 (`TSC_SUPPRESSION_DIRECTIVE`).
// Murni: tanpa disk, jam, atau acak, dan tanpa throw.

import ts from "typescript";

export interface SourceComment {
  readonly kind: "line" | "block";
  /** Isi di antara pembatasnya (setelah `//`, atau di dalam komentar blok), tanpa `trim`. */
  readonly value: string;
  /** Posisi awal komentar, basis 1. Kolom dalam unit UTF-16, sama seperti ESLint dan TypeScript. */
  readonly line: number;
  readonly column: number;
}

const SK = ts.SyntaxKind;

/** Nama berkas untuk parser. Sama dengan berkas yang dilihat ESLint dan compiler: skrip TS biasa. */
const PARSE_FILE_NAME = "main.ts";

/** Jenis node yang isinya teks mentah: `//` atau `/*` di dalamnya bukan komentar. */
const RAW_TEXT_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  SK.StringLiteral,
  SK.RegularExpressionLiteral,
  SK.NoSubstitutionTemplateLiteral,
  SK.TemplateHead,
  SK.TemplateMiddle,
  SK.TemplateTail,
]);

/** Awal tiap baris (pemisah baris ECMAScript: LF, CR, CRLF, U+2028, U+2029). */
function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x0d && text.charCodeAt(index + 1) === 0x0a) index += 1;
    if (code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029) starts.push(index + 1);
  }
  return starts;
}

/** Indeks baris (0-based) dengan awal terbesar yang tidak melebihi `offset`. */
function lineIndexOf(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((starts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

function isCommentKind(kind: ts.SyntaxKind): boolean {
  return kind === SK.SingleLineCommentTrivia || kind === SK.MultiLineCommentTrivia;
}

/** Komentar dari satu token trivia scanner (`text` = teks token, termasuk pembatasnya). */
function commentFrom(
  starts: readonly number[],
  kind: ts.SyntaxKind,
  start: number,
  text: string,
): SourceComment {
  const line = lineIndexOf(starts, start);
  const block = kind === SK.MultiLineCommentTrivia;
  // Komentar blok yang tidak ditutup tidak punya penutup; isinya tetap seluruh sisa teks.
  const closed = block && text.length >= 4 && text.endsWith("*/");
  return {
    kind: block ? "block" : "line",
    value: text.slice(2, closed ? -2 : undefined),
    line: line + 1,
    column: start - (starts[line] ?? 0) + 1,
  };
}

// ---- jalur utama: parser menentukan teks mentah, scanner memindai sisanya ----

/** Rentang teks mentah `[start, end)` di `source`, tanpa trivia di depannya. */
interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * Rentang semua string, regex, dan potongan template menurut parser, urut menurut posisi. `undefined`
 * bila parser tidak bisa berjalan (stack habis pada sumber yang bersarang sangat dalam). Penelusuran
 * memakai tumpukan eksplisit supaya tidak menambah kedalaman rekursi di atas parser. JSDoc tidak
 * diurai (`ParseNone`): isinya hanyalah komentar, dan pohon JSDoc bisa memuat literal di dalam komentar.
 */
function rawTextSpans(source: string): Span[] | undefined {
  try {
    const file = ts.createSourceFile(
      PARSE_FILE_NAME,
      source,
      { languageVersion: ts.ScriptTarget.ES2022, jsDocParsingMode: ts.JSDocParsingMode.ParseNone },
      /* setParentNodes */ false,
      ts.ScriptKind.TS,
    );
    const spans: Span[] = [];
    const pending: ts.Node[] = [file];
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (RAW_TEXT_KINDS.has(node.kind)) {
        const start = node.getStart(file);
        if (node.end > start) spans.push({ start, end: node.end });
        continue;
      }
      const children: ts.Node[] = [];
      ts.forEachChild(node, (child) => {
        children.push(child);
      });
      // Dibalik agar `pop` mengeluarkan anak pertama lebih dulu (urutan dokumen).
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child !== undefined) pending.push(child);
      }
    }
    return spans.sort((left, right) => left.start - right.start);
  } catch {
    return undefined;
  }
}

/** Komentar di semua teks di luar `spans`; tiap segmen dipindai terpisah dengan scanner polos. */
function scanOutside(source: string, spans: readonly Span[]): SourceComment[] {
  const scanner = ts.createScanner(
    ts.ScriptTarget.ES2022,
    /* skipTrivia */ false,
    ts.LanguageVariant.Standard,
  );
  const starts = lineStartsOf(source);
  const comments: SourceComment[] = [];

  const scanSegment = (from: number, to: number): void => {
    if (to <= from) return;
    scanner.setText(source, from, to - from);
    for (let kind = scanner.scan(); kind !== SK.EndOfFileToken; kind = scanner.scan()) {
      if (isCommentKind(kind)) {
        comments.push(commentFrom(starts, kind, scanner.getTokenStart(), scanner.getTokenText()));
      }
    }
  };

  let cursor = 0;
  for (const span of spans) {
    scanSegment(cursor, span.start);
    cursor = Math.max(cursor, span.end);
  }
  scanSegment(cursor, source.length);
  return comments;
}

// ---- jalur cadangan: pemindaian leksikal dengan heuristik "token sebelumnya" ----
// Dipakai hanya bila parser tidak bisa berjalan (lihat header). Dua konteks yang tidak bisa
// diputuskan scanner sendiri ditangani di sini:
//   - template literal: `}` penutup substitusi `${...}` dipindai ulang sebagai lanjutan template
//     (`reScanTemplateToken`), dengan tumpukan hitungan `{` agar `${ {a: 1} }` tetap benar;
//   - `/` dan `/=`: dipindai ulang sebagai regex (`reScanSlashToken`) bila token sebelumnya tidak
//     mengakhiri sebuah ekspresi. Heuristik ini salah pada `a! / 2`, `if (x) /re/`, `await /re/`,
//     dan sejenisnya; itulah sebabnya ia bukan jalur utama.

/** Kata kunci yang diikuti ekspresi (`return /x/`), bukan kata kunci yang bernilai (`this`, `null`). */
const VALUE_KEYWORDS: ReadonlySet<ts.SyntaxKind> = new Set([
  SK.ThisKeyword,
  SK.SuperKeyword,
  SK.TrueKeyword,
  SK.FalseKeyword,
  SK.NullKeyword,
]);

/** Token yang mengakhiri sebuah ekspresi, sehingga `/` sesudahnya adalah pembagian. */
function endsExpression(kind: ts.SyntaxKind): boolean {
  switch (kind) {
    case SK.Identifier:
    case SK.PrivateIdentifier:
    case SK.NumericLiteral:
    case SK.BigIntLiteral:
    case SK.StringLiteral:
    case SK.RegularExpressionLiteral:
    case SK.NoSubstitutionTemplateLiteral:
    case SK.TemplateTail:
    case SK.CloseParenToken:
    case SK.CloseBracketToken:
    case SK.CloseBraceToken:
    case SK.PlusPlusToken:
    case SK.MinusMinusToken:
      return true;
    default:
      break;
  }
  if (VALUE_KEYWORDS.has(kind)) return true;
  // Kata kunci kontekstual (`type`, `of`, `as`, ...) dan kata terlarang di mode strict selain
  // `yield` bisa menjadi nama variabel, jadi `/` sesudahnya dianggap pembagian.
  if (kind >= SK.FirstReservedWord && kind <= SK.LastReservedWord) return false;
  return kind >= SK.FirstFutureReservedWord && kind <= SK.LastKeyword && kind !== SK.YieldKeyword;
}

function scanLexically(source: string): SourceComment[] {
  const scanner = ts.createScanner(
    ts.ScriptTarget.ES2022,
    /* skipTrivia */ false,
    ts.LanguageVariant.Standard,
    source,
  );
  const starts = lineStartsOf(source);
  const comments: SourceComment[] = [];
  /** Satu entri per `${` yang masih terbuka: jumlah `{` yang belum ditutup di dalamnya. */
  const openBraces: number[] = [];
  let previous: ts.SyntaxKind = SK.Unknown;

  for (let kind = scanner.scan(); kind !== SK.EndOfFileToken; kind = scanner.scan()) {
    if (kind === SK.WhitespaceTrivia || kind === SK.NewLineTrivia) continue;
    if (isCommentKind(kind)) {
      comments.push(commentFrom(starts, kind, scanner.getTokenStart(), scanner.getTokenText()));
      continue;
    }

    let current: ts.SyntaxKind = kind;
    const top = openBraces.length - 1;
    if (kind === SK.TemplateHead) {
      openBraces.push(0);
    } else if (kind === SK.OpenBraceToken && top >= 0) {
      openBraces[top] = (openBraces[top] ?? 0) + 1;
    } else if (kind === SK.CloseBraceToken && top >= 0) {
      if ((openBraces[top] ?? 0) > 0) {
        openBraces[top] = (openBraces[top] ?? 0) - 1;
      } else {
        current = scanner.reScanTemplateToken(/* isTaggedTemplate */ false);
        if (current !== SK.TemplateMiddle) openBraces.pop();
      }
    } else if ((kind === SK.SlashToken || kind === SK.SlashEqualsToken) && !endsExpression(previous)) {
      current = scanner.reScanSlashToken();
    }
    previous = current;
  }
  return comments;
}

/**
 * Semua komentar `source` menurut urutan dokumen. Total: teks apa pun menghasilkan larik (token
 * yang tidak dikenal dilewati scanner, parser yang kehabisan stack diganti pemindaian leksikal),
 * tanpa melempar.
 */
export function scanComments(source: string): SourceComment[] {
  const spans = rawTextSpans(source);
  return spans === undefined ? scanLexically(source) : scanOutside(source, spans);
}
