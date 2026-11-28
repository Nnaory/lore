// Pelipatan konstanta string untuk pemindaian kebijakan (design 5.5 "Pelipatan konstanta";
// Requirement 7.16; tugas 4.2).
// `x["con" + "structor"]` dan `const k = "constructor"; x[k]` harus dilihat sebagai kunci
// `constructor`. `foldString` mengubah ekspresi menjadi satu string bila seluruhnya dapat diketahui
// tanpa menjalankan kode: literal string, template literal (tanpa substitusi, atau dengan substitusi
// yang juga terlipat), `+` antar hasil lipatan, pembungkus transparan, dan identifier yang
// ter-resolve ke `const` ber-initializer yang dapat dilipat. Hasil `undefined` berarti "tidak
// diketahui" (kunci dinamis seperti `x[i]`), bukan "bukan terlarang".
// Kedalaman: simpul akar berkedalaman 0 dan tiap turunan (operand `+`, isi pembungkus, substitusi,
// initializer `const`) menambah 1. Simpul pada kedalaman lebih dari `maxDepth` (`fold_depth`, 8 pada
// kontrak) tidak dilipat. Batas ini juga menjamin rekursi berhenti pada `const` yang saling
// merujuk. Pelipatan hanya pembaca: tidak ada throw, jam, atau acak.

import ts from "typescript";

export interface FoldOptions {
  readonly checker: ts.TypeChecker;
  readonly sourceFile: ts.SourceFile;
  /** `limits.fold_depth` dari kontrak. */
  readonly maxDepth: number;
}

/** `const` ber-initializer yang didefinisikan di `sourceFile`, atau `undefined`. Dipakai juga aturan props (4.3). */
export function constInitializer(
  identifier: ts.Identifier,
  options: FoldOptions,
): ts.Expression | undefined {
  const symbol = options.checker.getSymbolAtLocation(identifier);
  const declarations = symbol?.declarations;
  if (declarations === undefined || declarations.length !== 1) return undefined;
  const declaration = declarations[0];
  if (
    declaration === undefined ||
    !ts.isVariableDeclaration(declaration) ||
    !ts.isIdentifier(declaration.name) ||
    declaration.initializer === undefined ||
    (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0 ||
    declaration.getSourceFile() !== options.sourceFile
  ) {
    return undefined;
  }
  return declaration.initializer;
}

/**
 * Melipat `node` menjadi string, atau `undefined` bila tidak seluruhnya dapat dilipat atau
 * melebihi `maxDepth`. `depth` adalah kedalaman `node` terhadap akar pelipatan (awal 0).
 */
export function foldString(node: ts.Node, options: FoldOptions, depth = 0): string | undefined {
  if (depth > options.maxDepth) return undefined;

  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;

  if (
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return foldString(node.expression, options, depth + 1);
  }

  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = foldString(node.left, options, depth + 1);
    if (left === undefined) return undefined;
    const right = foldString(node.right, options, depth + 1);
    return right === undefined ? undefined : left + right;
  }

  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    for (const span of node.templateSpans) {
      const inner = foldString(span.expression, options, depth + 1);
      if (inner === undefined) return undefined;
      text += inner + span.literal.text;
    }
    return text;
  }

  if (ts.isIdentifier(node)) {
    const initializer = constInitializer(node, options);
    return initializer === undefined ? undefined : foldString(initializer, options, depth + 1);
  }

  return undefined;
}
