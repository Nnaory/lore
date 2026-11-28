// Aturan literal string, langkah 2 bagian 2 (design 5.5 tabel aturan; Requirement 7.9, 7.16, 1.9, 1.11,
// 1.17; tugas 4.3). Dua kode:
//   `POLICY_URL_LITERAL`    literal yang memuat `url(` atau diawali skema URL terlarang;
//   `POLICY_COLOR_LITERAL`  bagian (a): literal yang seluruhnya hex, atau yang memuat fungsi warna.
// (Bagian (b), nilai properti pembawa warna, ada di `element-rules.ts`.)
// Yang dipindai: literal string, template literal tanpa substitusi, template dengan substitusi (per
// potongan, atau seluruhnya bila terlipat), dan penjumlahan `+` yang terlipat menjadi satu string
// (`"java" + "script:1"`). Penjumlahan hanya dilaporkan bila gabungannya melanggar sedangkan tiap
// operandnya tidak, supaya satu pelanggaran tidak muncul dua kali. Dikecualikan: teks anak langsung
// `createElement` (argumen ketiga dan seterusnya, Requirement 7.9) dan nama modul pada impor.
// Aturan skema sama dengan `url_scheme_prefix` di `backend/app/ai/animation/tokens.py` (tugas 11.3):
// setelah trim awal, string diawali `<skema>:` tanpa memperhatikan huruf besar-kecil ASCII. Untuk skema di
// `url_schemes_strict_colon` karakter sesudah `:` harus ada dan bukan spasi (`Data: 5` dan `data:`
// polos bukan URL); skema lain cukup `skema:`. Semua daftar dibaca dari kontrak.
// Modul ini murni: tanpa throw, jam, acak, atau akses disk.

import ts from "typescript";
import {
  colorLiteralMessage,
  colorRulesOf,
  containsColorFunction,
  isHexColor,
} from "./colors.js";
import { isModuleSpecifier, isTextChild } from "./props.js";
import type { PolicyRule, PolicyScan } from "./scan.js";

/** Satu potongan teks yang diperiksa, dan hubungannya dengan string tempat ia berada. */
interface Piece {
  readonly text: string;
  /** Benar bila potongan ini awal string (hanya awal string yang diperiksa terhadap skema dan hex). */
  readonly atStart: boolean;
  /** Benar bila sebuah substitusi `${...}` menyambung sesudah potongan ini. */
  readonly continues: boolean;
}

/** Hasil pemeriksaan: potongan yang dilaporkan, atau `undefined` bila bersih. URL tidak punya potongan: `""`. */
type Inspector = (scan: PolicyScan, piece: Piece) => string | undefined;

/** Huruf kecil khusus A sampai Z: `toLowerCase()` memetakan juga huruf non-ASCII (mis. U+212A menjadi `k`). */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));
}

const WHITESPACE = /\s/;

// ---- potongan dari node ----

function wholePiece(text: string): Piece {
  return { text, atStart: true, continues: false };
}

function piecesOfTemplate(scan: PolicyScan, node: ts.TemplateExpression): Piece[] {
  const folded = scan.fold(node);
  if (folded !== undefined) return [wholePiece(folded)];
  const pieces: Piece[] = [{ text: node.head.text, atStart: true, continues: true }];
  for (const span of node.templateSpans) {
    pieces.push({
      text: span.literal.text,
      atStart: false,
      continues: ts.isTemplateMiddle(span.literal),
    });
  }
  return pieces;
}

/** Potongan yang diperiksa untuk `node`, atau daftar kosong bila `node` bukan literal string. */
function piecesOf(scan: PolicyScan, node: ts.Node): Piece[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return [wholePiece(node.text)];
  }
  if (ts.isTemplateExpression(node)) return piecesOfTemplate(scan, node);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const folded = scan.fold(node);
    return folded === undefined ? [] : [wholePiece(folded)];
  }
  return [];
}

/** Benar bila salah satu operand `+` sudah melanggar sendiri (dan dilaporkan oleh node operandnya). */
function operandViolates(scan: PolicyScan, node: ts.Node, inspect: Inspector): boolean {
  if (!ts.isBinaryExpression(node)) return false;
  return [node.left, node.right].some((operand) => {
    const folded = scan.fold(operand);
    return folded !== undefined && inspect(scan, wholePiece(folded)) !== undefined;
  });
}

function literalRule(
  inspect: Inspector,
  report: (scan: PolicyScan, node: ts.Node, finding: string) => void,
): PolicyRule {
  return {
    visit(node, scan) {
      const pieces = piecesOf(scan, node);
      if (pieces.length === 0) return;
      if (isModuleSpecifier(node) || isTextChild(scan, node)) return;
      if (operandViolates(scan, node, inspect)) return;
      for (const piece of pieces) {
        const finding = inspect(scan, piece);
        if (finding !== undefined) report(scan, node, finding);
      }
    },
  };
}

// ---- POLICY_URL_LITERAL ----

const URL_MESSAGE = "url() and URL schemes are not allowed in strings";

const inspectUrl: Inspector = (scan, piece) => {
  const { contract } = scan;
  const folded = asciiLower(piece.text);
  if (contract.css_functions_forbidden.some((name) => folded.includes(asciiLower(name)))) return "";
  if (!piece.atStart) return undefined;

  const leading = piece.text.trimStart();
  const leadingFolded = asciiLower(leading);
  const strict = new Set(contract.url_schemes_strict_colon.map(asciiLower));
  for (const scheme of contract.url_schemes) {
    const name = asciiLower(scheme);
    const marker = `${name}:`;
    if (!leadingFolded.startsWith(marker)) continue;
    if (strict.has(name)) {
      const following = leading.charAt(marker.length);
      // Tanpa karakter sesudah titik dua: string berakhir (bukan URL), kecuali substitusi menyambung.
      const isBare = following === "" ? !piece.continues : WHITESPACE.test(following);
      if (isBare) continue;
    }
    return "";
  }
  return undefined;
};

/** `url(` dan skema URL terlarang di awal string (Requirement 7.9, 1.11). */
export const urlLiteralRule: PolicyRule = literalRule(inspectUrl, (scan, node) => {
  scan.report("POLICY_URL_LITERAL", node, URL_MESSAGE);
});

// ---- POLICY_COLOR_LITERAL (bagian a) ----

const inspectColor: Inspector = (scan, piece) => {
  const rules = colorRulesOf(scan.contract);
  const colorFunction = containsColorFunction(piece.text, rules);
  if (colorFunction !== undefined) return colorFunction;
  if (piece.atStart && !piece.continues && isHexColor(piece.text, rules)) return piece.text.trim();
  return undefined;
};

/**
 * Literal string (bukan teks anak) yang seluruhnya hex 3, 4, 6, atau 8 digit, atau yang memuat
 * fungsi warna tanpa memperhatikan huruf besar-kecil (Requirement 7.9, 1.9, 1.17).
 */
export const colorLiteralRule: PolicyRule = literalRule(inspectColor, (scan, node, fragment) => {
  scan.report("POLICY_COLOR_LITERAL", node, colorLiteralMessage(fragment));
});

/** Aturan literal langkah 2 bagian 2, dalam urutan pendaftaran. */
export const LITERAL_POLICY_RULES: readonly PolicyRule[] = [urlLiteralRule, colorLiteralRule];
