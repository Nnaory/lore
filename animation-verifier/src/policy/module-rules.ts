// Aturan bentuk modul, langkah 2 bagian 2 (design 5.5 tabel aturan; Requirement 7.10, 7.11, 1.2, 1.3,
// 1.4, 1.5, 1.14, 1.16, 1.19; tugas 4.3). Lima kode:
//   `POLICY_META_INVALID`     `meta` hilang, bukan `export const` berisi object literal, kunci di luar
//                             daftar kontrak atau ganda, lebih dari satu deklarasi, nilai bukan literal
//                             bilangan bulat desimal, atau nilai di luar rentang kontrak;
//   `META_PAUSE_REQUIRED`     jenis `puzzle` tanpa `pauseAtFrame` (menurut `pause_rules`);
//   `META_PAUSE_FORBIDDEN`    jenis `lesson` dengan `pauseAtFrame`;
//   `POLICY_EXPORT_MISSING`   ekspor default bukan `function Main()` tanpa parameter (termasuk berkas kosong);
//   `POLICY_EXPORT_UNEXPECTED` ekspor selain `meta` dan ekspor default.
// Semuanya aturan tingkat berkas: `finish` membaca pernyataan tingkat atas sekali. Bila seluruh `meta`
// valid (struktur, nilai, dan aturan pause), `META_ARTIFACT` diisi dengan Main_Meta statis yang
// dibuktikan di sini, untuk dibaca langkah 6 dan hasil akhir (design 5.1). Kunci, rentang, dan nama
// fungsi dibaca dari kontrak (`required_exports`, `canvas`, `duration`, `pause_rules`); yang ditulis di
// sini hanya pemetaan nama kunci ke jenis pemeriksaannya, yang tidak dapat dinyatakan sebagai data.
// Modul ini murni: tanpa throw, jam, acak, atau akses disk.

import ts from "typescript";
import type { Contract } from "../contract.js";
import type { MainMeta } from "../types.js";
import { META_ARTIFACT } from "../steps/step.js";
import type { PolicyRule, PolicyScan } from "./scan.js";
import { unwrapExpression } from "./scope.js";

/** Nama ekspor yang dikenal bahasa kontrak (`required_exports.meta` dan `required_exports.default`). */
const META_EXPORT = "meta";
const DEFAULT_EXPORT = "default";

/** Bilangan bulat desimal biasa: `30`, bukan `1_000`, `1e3`, `0x10`, `30.0`, atau `010`. */
const DECIMAL_INTEGER = /^(?:0|[1-9][0-9]*)$/;

// ---- bantuan sintaks ----

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === kind) === true;
}

function isConstDeclaration(declaration: ts.VariableDeclaration): boolean {
  return (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0;
}

// ---- pernyataan tingkat atas ----

interface MetaDeclaration {
  /** Node tempat temuan dilaporkan (nama deklarasi). */
  readonly at: ts.Node;
  /** `const` dengan initializer; `undefined` untuk `let`, `var`, fungsi, kelas, dan lainnya. */
  readonly initializer: ts.Expression | undefined;
  readonly isConst: boolean;
  /** Dideklarasikan dengan modifier `export`. */
  readonly exported: boolean;
}

interface TopLevel {
  readonly metaDeclarations: MetaDeclaration[];
  /** Nama lokal yang diekspor sebagai `meta` lewat `export { ... }`. */
  readonly metaExportedLocals: Set<string>;
  /** Setiap ekspor default (deklarasi, `export default expr`, `export { x as default }`). */
  readonly defaults: ts.Node[];
  /** Ekspor selain `meta` dan default. */
  readonly unexpected: ts.Node[];
}

function readExportDeclaration(statement: ts.ExportDeclaration, into: TopLevel): void {
  const clause = statement.exportClause;
  // `export * from`, `export * as ns from`, dan `export { ... } from` mengekspor nama lain.
  if (statement.moduleSpecifier !== undefined || clause === undefined || !ts.isNamedExports(clause)) {
    into.unexpected.push(statement);
    return;
  }
  for (const element of clause.elements) {
    if (element.name.text === DEFAULT_EXPORT) into.defaults.push(element);
    else if (element.name.text === META_EXPORT) {
      into.metaExportedLocals.add((element.propertyName ?? element.name).text);
    } else into.unexpected.push(element);
  }
}

/** Mencatat nama `meta`, ekspor default, dan ekspor tak terduga dari satu pernyataan. */
function readStatement(statement: ts.Statement, into: TopLevel): void {
  const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
  const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);

  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === META_EXPORT) {
        into.metaDeclarations.push({
          at: declaration.name,
          initializer: declaration.initializer,
          isConst: isConstDeclaration(declaration),
          exported,
        });
      } else if (exported) into.unexpected.push(declaration);
    }
  } else if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
    if (ts.isFunctionDeclaration(statement) && statement.body === undefined) return; // tanda tangan overload
    if (isDefault) into.defaults.push(statement);
    else if (statement.name?.text === META_EXPORT) {
      into.metaDeclarations.push({ at: statement.name, initializer: undefined, isConst: false, exported });
    } else if (exported) into.unexpected.push(statement);
  } else if (ts.isEnumDeclaration(statement)) {
    if (statement.name.text === META_EXPORT) {
      into.metaDeclarations.push({ at: statement.name, initializer: undefined, isConst: false, exported });
    } else if (exported) into.unexpected.push(statement);
  } else if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
    if (isDefault) into.defaults.push(statement);
    else if (exported) into.unexpected.push(statement);
  } else if (ts.isModuleDeclaration(statement)) {
    if (exported) into.unexpected.push(statement);
  } else if (ts.isExportAssignment(statement)) {
    (statement.isExportEquals === true ? into.unexpected : into.defaults).push(statement);
  } else if (ts.isExportDeclaration(statement)) {
    readExportDeclaration(statement, into);
  } else if (ts.isImportEqualsDeclaration(statement)) {
    if (exported) into.unexpected.push(statement);
  } else if (ts.isNamespaceExportDeclaration(statement)) {
    into.unexpected.push(statement);
  }
}

function readTopLevel(sourceFile: ts.SourceFile): TopLevel {
  const topLevel: TopLevel = {
    metaDeclarations: [],
    metaExportedLocals: new Set(),
    defaults: [],
    unexpected: [],
  };
  for (const statement of sourceFile.statements) readStatement(statement, topLevel);
  return topLevel;
}

// ---- meta ----

function metaMessage(contract: Contract): string {
  const { canvas, duration } = contract;
  return (
    `meta must be a literal object with width ${canvas.width}, height ${canvas.height}, ` +
    `fps ${canvas.fps}, durationInFrames ${duration.min}..${duration.max}`
  );
}

/**
 * Nilai literal bilangan bulat desimal (`30`, `-5`), atau `undefined` untuk bentuk lain: hex, biner,
 * oktal, eksponen, titik, pemisah `_`, bigint, atau ekspresi. Tanda minus diterima supaya nilai negatif
 * dinilai menurut rentang (Requirement 1.16), bukan menurut bentuknya.
 */
function integerLiteral(expression: ts.Expression, sourceFile: ts.SourceFile): number | undefined {
  let negative = false;
  let target = expression;
  if (
    ts.isPrefixUnaryExpression(target) &&
    target.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(target.operand)
  ) {
    negative = true;
    target = target.operand;
  }
  if (!ts.isNumericLiteral(target) || !DECIMAL_INTEGER.test(target.getText(sourceFile))) {
    return undefined;
  }
  const value = Number(target.text);
  return negative ? -value : value;
}

/** Nama kunci `meta` yang dikenal pemeriksaan nilai; kunci lain dari kontrak hanya diperiksa bentuknya. */
const KEY_WIDTH = "width";
const KEY_HEIGHT = "height";
const KEY_FPS = "fps";
const KEY_DURATION = "durationInFrames";
const KEY_PAUSE = "pauseAtFrame";

/** Apakah `value` memenuhi aturan kunci `key`; `meta` memuat nilai kunci lain yang sudah terbaca. */
function valueInRange(
  key: string,
  value: number,
  meta: ReadonlyMap<string, number>,
  contract: Contract,
): boolean {
  switch (key) {
    case KEY_WIDTH:
      return value === contract.canvas.width;
    case KEY_HEIGHT:
      return value === contract.canvas.height;
    case KEY_FPS:
      return value === contract.canvas.fps;
    case KEY_DURATION:
      return value >= contract.duration.min && value <= contract.duration.max;
    case KEY_PAUSE: {
      const duration = meta.get(KEY_DURATION);
      // Tanpa `durationInFrames` yang terbaca, batas atas tidak dapat dinilai (durasinya sendiri sudah dilaporkan).
      return value >= 1 && (duration === undefined || value <= duration - 1);
    }
    default:
      return true;
  }
}

function propertyKey(property: ts.ObjectLiteralElementLike): string | undefined {
  if (!ts.isPropertyAssignment(property)) return undefined;
  const { name } = property;
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

interface MetaVerdict {
  /** Tidak ada `POLICY_META_INVALID` dan tidak ada galat pause. */
  readonly valid: boolean;
  /** Nilai bilangan bulat yang terbaca per kunci (kemunculan pertama). */
  readonly values: ReadonlyMap<string, number>;
}

/** Memeriksa object literal `meta` dan melaporkan `POLICY_META_INVALID` per masalah. */
function checkMetaObject(scan: PolicyScan, object: ts.ObjectLiteralExpression): MetaVerdict {
  const { contract } = scan;
  const message = metaMessage(contract);
  const { keys, optional_keys: optionalKeys } = contract.required_exports.meta;
  let valid = true;
  const invalid = (at: ts.Node | number): void => {
    valid = false;
    scan.report("POLICY_META_INVALID", at, message);
  };

  const present = new Set<string>();
  const values = new Map<string, number>();
  const parsed: Array<{ key: string; at: ts.Node; value: number }> = [];
  // Spread, shorthand, method, dan kunci terhitung membuat daftar kunci tak terbaca: kunci yang
  // "hilang" lalu tidak dilaporkan lagi, supaya satu penyebab tidak muncul sebagai dua temuan.
  let readable = true;

  for (const property of object.properties) {
    const key = propertyKey(property);
    if (key === undefined || !ts.isPropertyAssignment(property)) {
      readable = false;
      invalid(property);
      continue;
    }
    if (!keys.includes(key)) {
      invalid(property.name);
      continue;
    }
    if (present.has(key)) {
      invalid(property.name); // kunci ganda: kemunculan pertama yang dipakai
      continue;
    }
    present.add(key);
    const value = integerLiteral(property.initializer, scan.sourceFile);
    if (value === undefined) {
      invalid(property.initializer);
      continue;
    }
    values.set(key, value);
    parsed.push({ key, at: property.initializer, value });
  }

  for (const { key, at, value } of parsed) {
    if (!valueInRange(key, value, values, contract)) invalid(at);
  }
  if (readable && keys.some((key) => !optionalKeys.includes(key) && !present.has(key))) invalid(object);

  return { valid, values };
}

/** Aturan pause menurut jenis (`pause_rules`); benar bila tidak ada pelanggaran. */
function checkPause(scan: PolicyScan, object: ts.ObjectLiteralExpression): boolean {
  const kind = scan.context.input.kind;
  const rule = scan.contract.pause_rules[kind];
  const hasPause = object.properties.some((property) => propertyKey(property) === KEY_PAUSE);
  if (rule === "required" && !hasPause) {
    scan.report("META_PAUSE_REQUIRED", object, `${kind} animations must set meta.${KEY_PAUSE}`);
    return false;
  }
  if (rule === "forbidden" && hasPause) {
    scan.report("META_PAUSE_FORBIDDEN", object, `${kind} animations must not set meta.${KEY_PAUSE}`);
    return false;
  }
  return true;
}

function toMainMeta(values: ReadonlyMap<string, number>): MainMeta | undefined {
  const width = values.get(KEY_WIDTH);
  const height = values.get(KEY_HEIGHT);
  const fps = values.get(KEY_FPS);
  const durationInFrames = values.get(KEY_DURATION);
  if (width === undefined || height === undefined || fps === undefined) return undefined;
  if (durationInFrames === undefined) return undefined;
  // Nilai sudah dicocokkan dengan `canvas` kontrak; tipe literal `MainMeta` hanya mencatat hasilnya.
  const meta: MainMeta = {
    width: width as MainMeta["width"],
    height: height as MainMeta["height"],
    fps: fps as MainMeta["fps"],
    durationInFrames,
  };
  const pauseAtFrame = values.get(KEY_PAUSE);
  return pauseAtFrame === undefined ? meta : { ...meta, pauseAtFrame };
}

function checkMeta(scan: PolicyScan, topLevel: TopLevel): void {
  const message = metaMessage(scan.contract);
  const [first, ...extra] = topLevel.metaDeclarations;
  if (first === undefined) {
    scan.report("POLICY_META_INVALID", 0, message);
    return;
  }
  for (const declaration of extra) scan.report("POLICY_META_INVALID", declaration.at, message);

  const exported = first.exported || topLevel.metaExportedLocals.has(META_EXPORT);
  const object =
    first.initializer === undefined ? undefined : unwrapExpression(first.initializer);
  if (!first.isConst || !exported || object === undefined || !ts.isObjectLiteralExpression(object)) {
    scan.report("POLICY_META_INVALID", first.at, message);
    return;
  }

  const verdict = checkMetaObject(scan, object);
  const pauseValid = checkPause(scan, object);
  if (!verdict.valid || !pauseValid || extra.length > 0) return;
  const meta = toMainMeta(verdict.values);
  if (meta !== undefined) scan.context.artifacts.set(META_ARTIFACT, meta);
}

// ---- ekspor ----

/** `export default function Main() {}`: bernama sesuai kontrak, tanpa parameter, bukan async atau generator. */
function isMainFunction(scan: PolicyScan, node: ts.Node): boolean {
  const { function_name: functionName, param_count: paramCount } =
    scan.contract.required_exports.default;
  return (
    ts.isFunctionDeclaration(node) &&
    node.body !== undefined &&
    node.name?.text === functionName &&
    node.parameters.length === paramCount &&
    node.asteriskToken === undefined &&
    !hasModifier(node, ts.SyntaxKind.AsyncKeyword)
  );
}

function checkExports(scan: PolicyScan, topLevel: TopLevel): void {
  const unexpectedMessage = "only meta and the default export are allowed";
  for (const node of topLevel.unexpected) scan.report("POLICY_EXPORT_UNEXPECTED", node, unexpectedMessage);

  const main = topLevel.defaults.find((node) => isMainFunction(scan, node));
  if (main === undefined) {
    scan.report(
      "POLICY_EXPORT_MISSING",
      topLevel.defaults[0] ?? 0,
      `export default function ${scan.contract.required_exports.default.function_name}() with no parameters is required`,
    );
    return;
  }
  // Ekspor default kedua tidak boleh ada di samping `Main`.
  for (const node of topLevel.defaults) {
    if (node !== main) scan.report("POLICY_EXPORT_UNEXPECTED", node, unexpectedMessage);
  }
}

/** `meta`, aturan pause, dan ekspor: dinilai sekali setelah semua node dikunjungi. */
export const moduleShapeRule: PolicyRule = {
  finish(scan) {
    const topLevel = readTopLevel(scan.sourceFile);
    checkMeta(scan, topLevel);
    checkExports(scan, topLevel);
  },
};

export const MODULE_POLICY_RULES: readonly PolicyRule[] = [moduleShapeRule];
