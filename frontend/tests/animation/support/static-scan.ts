/**
 * Static scan helpers for the animation guard tests (flags-static, reuse-guards).
 *
 * The guards read the repository's own source and fail when a rule of the feature is broken
 * (a second `@remotion/player` import, a second `useIsClient`, a flag read that Next cannot
 * inline). They look at the syntax tree, not at text, so a name in a comment or in a string does
 * not count and `import type` is told apart from a value import. Every function takes the text of
 * a file, so the tests also run each rule on small broken samples and show that it fails.
 *
 * Files are listed from `frontend/` and parsed with the `typescript` package that is already a
 * dev dependency. Nothing is executed and nothing is written.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

/** The `frontend/` directory (this file is `frontend/tests/animation/support/static-scan.ts`). */
export const FRONTEND = join(__dirname, "..", "..", "..");

/** Directories that hold build output or other people's code, never scanned. */
const SKIP_DIRS = new Set(["node_modules", ".next", "public", "coverage", "out", "dist"]);

const SCRIPT_KINDS: Readonly<Record<string, ts.ScriptKind>> = {
  ".ts": ts.ScriptKind.TS,
  ".mts": ts.ScriptKind.TS,
  ".cts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
  ".js": ts.ScriptKind.JS,
  ".mjs": ts.ScriptKind.JS,
  ".cjs": ts.ScriptKind.JS,
  ".jsx": ts.ScriptKind.JSX,
};

/** A parsed source file and its path relative to `frontend/`, written with `/`. */
export type Source = { readonly path: string; readonly sf: ts.SourceFile };

/** Parses `text` as the file `path` (the extension picks TS, TSX, JS or JSX). */
export function parseSource(path: string, text: string): ts.SourceFile {
  const dot = path.lastIndexOf(".");
  const kind = SCRIPT_KINDS[dot < 0 ? "" : path.slice(dot)] ?? ts.ScriptKind.TS;
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
}

function collect(dir: string, found: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      collect(full, found);
    } else if (name.endsWith(".d.ts") || name.endsWith(".d.mts")) {
      continue;
    } else {
      const dot = name.lastIndexOf(".");
      if (dot >= 0 && SCRIPT_KINDS[name.slice(dot)] !== undefined) found.push(full);
    }
  }
}

const parsed = new Map<string, Source>();

/**
 * Every script file under the given directories of `frontend/` (default: all of `frontend/`
 * except `node_modules`, `.next`, `public`, `coverage`, `out`, `dist` and dot-directories),
 * parsed and sorted by path. A directory that does not exist is skipped.
 */
export function loadSources(directories: readonly string[] = ["."]): Source[] {
  const files: string[] = [];
  for (const directory of directories) {
    const root = join(FRONTEND, directory);
    try {
      collect(root, files);
    } catch {
      // A directory that is not there has no sources.
    }
  }
  const sources: Source[] = [];
  for (const file of new Set(files)) {
    const path = relative(FRONTEND, file).split(sep).join("/");
    let source = parsed.get(path);
    if (source === undefined) {
      source = { path, sf: parseSource(path, readFileSync(file, "utf8")) };
      parsed.set(path, source);
    }
    sources.push(source);
  }
  return sources.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Calls `visit` for `node` and every node under it, parents first. */
export function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** 1-based line of `node` in `sf`. */
export function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** `path:line` for a report. */
export function where(path: string, sf: ts.SourceFile, node: ts.Node): string {
  return `${path}:${lineOf(sf, node)}`;
}

/** True when `node` has the `export` keyword in front of it. */
export function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/** A declaration of a name: `function f`, `class C`, `interface I`, `type T` or `const v`. */
export type Declaration = { readonly name: string; readonly node: ts.Node; readonly exported: boolean };

/**
 * Declarations made at any depth of `sf`. A name exported later with `export { name }` is
 * reported as exported too. Parameters, properties and import bindings are not declarations here.
 */
export function declarationsOf(sf: ts.SourceFile): Declaration[] {
  const found: Declaration[] = [];
  const exportedLater = new Set<string>();
  walk(sf, (node) => {
    if (ts.isExportDeclaration(node) && node.moduleSpecifier === undefined && node.exportClause) {
      if (ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          exportedLater.add((element.propertyName ?? element.name).text);
        }
      }
    }
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node)) &&
      node.name
    ) {
      found.push({ name: node.name.text, node, exported: hasExportModifier(node) });
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const statement = node.parent.parent;
      found.push({
        name: node.name.text,
        node,
        exported: ts.isVariableStatement(statement) && hasExportModifier(statement),
      });
    }
  });
  return found.map((declaration) =>
    exportedLater.has(declaration.name) ? { ...declaration, exported: true } : declaration,
  );
}
