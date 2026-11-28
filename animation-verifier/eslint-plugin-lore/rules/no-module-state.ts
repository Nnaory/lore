// Aturan `lore/no-module-state` (design 5.6; Requirement 1.7, 1.21, 8.12): keluaran Main_File
// hanya boleh bergantung pada nomor frame dan konstanta berkas, jadi tidak boleh ada state yang
// hidup di level modul. Tiga pemeriksaan:
//   1. `let` atau `var` yang variabelnya tinggal di scope modul atau global (termasuk `var` di
//      dalam blok level atas, karena `var` terangkat ke scope modul);
//   2. penugasan (`=`, operator majemuk, destructuring, kepala `for-in/of`) dan `++`/`--` pada
//      akar variabel scope modul: `x = 1`, `x += 1`, `x++`, `obj.a = 1`, `obj.a.b = 1`;
//   3. pemanggilan mutator (`push`, `pop`, `splice`, `sort`, `reverse`, `set`, `add`, `delete`,
//      `clear`) pada akar variabel scope modul: `items.push(1)`, `state.list.sort()`.
// Variabel yang dideklarasikan di dalam fungsi, termasuk parameter yang menimpa nama level
// modul, tidak dilaporkan. Aturan ini tidak punya opsi dan tidak membaca kontrak.
// Tipe node diturunkan dari `SourceCode.getScope` agar tidak bergantung pada `@types/estree`.

import type { Rule, Scope, SourceCode } from "eslint";

type EsNode = Parameters<SourceCode["getScope"]>[0];
type NodeOf<T extends EsNode["type"]> = Extract<EsNode, { type: T }>;

/** Nama metode yang mengubah penerimanya di tempat (daftar tetap dari Requirement 1.21). */
const MUTATORS: ReadonlySet<string> = new Set([
  "push",
  "pop",
  "splice",
  "sort",
  "reverse",
  "set",
  "add",
  "delete",
  "clear",
]);

/** Tipe scope yang dihitung sebagai level modul. */
const MODULE_LEVEL_SCOPES: ReadonlySet<string> = new Set(["module", "global"]);

/** Pembungkus TypeScript yang tidak mengubah akar: `x!.a`, `(x as T).a`, `(<T>x).a`, `x satisfies T`. */
const TS_TRANSPARENT_WRAPPERS: ReadonlySet<string> = new Set([
  "TSNonNullExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

/** Turun lewat `.object` (dan pembungkus transparan) sampai `Identifier`; null bila akarnya bukan nama. */
function rootIdentifier(node: EsNode): NodeOf<"Identifier"> | null {
  switch (node.type) {
    case "Identifier":
      return node;
    case "MemberExpression":
      return rootIdentifier(node.object);
    case "ChainExpression":
      return rootIdentifier(node.expression);
    default: {
      if (!TS_TRANSPARENT_WRAPPERS.has(node.type)) return null;
      const inner = (node as { expression?: EsNode }).expression;
      return inner === undefined ? null : rootIdentifier(inner);
    }
  }
}

/** Semua akar yang ditugasi oleh `target`, termasuk di dalam pola destructuring. */
function collectAssignedRoots(target: EsNode, out: NodeOf<"Identifier">[]): void {
  switch (target.type) {
    case "ArrayPattern":
      for (const element of target.elements) {
        if (element) collectAssignedRoots(element, out);
      }
      return;
    case "ObjectPattern":
      for (const property of target.properties) {
        collectAssignedRoots(property.type === "RestElement" ? property : property.value, out);
      }
      return;
    case "RestElement":
      collectAssignedRoots(target.argument, out);
      return;
    case "AssignmentPattern":
      collectAssignedRoots(target.left, out);
      return;
    default: {
      const root = rootIdentifier(target);
      if (root) out.push(root);
    }
  }
}

/** Nama metode pada `obj.name(...)` atau `obj["name"](...)`; null untuk bentuk dinamis. */
function calledMethodName(member: NodeOf<"MemberExpression">): string | null {
  const { property } = member;
  if (!member.computed) return property.type === "Identifier" ? property.name : null;
  return property.type === "Literal" && typeof property.value === "string" ? property.value : null;
}

/** Variabel yang dilihat `name` dari `scope`, atau null bila tidak ter-resolve (global tak dikenal). */
function findVariable(scope: Scope.Scope, name: string): Scope.Variable | null {
  for (let current: Scope.Scope | null = scope; current; current = current.upper) {
    const variable = current.set.get(name);
    if (variable) return variable;
  }
  return null;
}

export const noModuleState: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow module-level state in the Main_File: output may depend only on the frame.",
    },
    schema: [],
    messages: {
      moduleState: "module-level state is not allowed: {{name}}",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;

    const isModuleLevel = (identifier: NodeOf<"Identifier">, from: EsNode): boolean => {
      const variable = findVariable(sourceCode.getScope(from), identifier.name);
      return variable !== null && MODULE_LEVEL_SCOPES.has(variable.scope.type);
    };

    const reportIfModuleLevel = (identifier: NodeOf<"Identifier">, from: EsNode): void => {
      if (isModuleLevel(identifier, from)) {
        context.report({
          node: identifier,
          messageId: "moduleState",
          data: { name: identifier.name },
        });
      }
    };

    const reportAssignedRoots = (target: EsNode, from: EsNode): void => {
      const roots: NodeOf<"Identifier">[] = [];
      collectAssignedRoots(target, roots);
      for (const root of roots) reportIfModuleLevel(root, from);
    };

    return {
      VariableDeclaration(node) {
        if (node.kind !== "let" && node.kind !== "var") return;
        for (const variable of sourceCode.getDeclaredVariables(node)) {
          if (!MODULE_LEVEL_SCOPES.has(variable.scope.type)) continue;
          context.report({
            node: variable.identifiers[0] ?? node,
            messageId: "moduleState",
            data: { name: variable.name },
          });
        }
      },
      AssignmentExpression(node) {
        reportAssignedRoots(node.left, node);
      },
      UpdateExpression(node) {
        reportAssignedRoots(node.argument, node);
      },
      ForInStatement(node) {
        if (node.left.type !== "VariableDeclaration") reportAssignedRoots(node.left, node);
      },
      ForOfStatement(node) {
        if (node.left.type !== "VariableDeclaration") reportAssignedRoots(node.left, node);
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression") return;
        const method = calledMethodName(callee);
        if (method === null || !MUTATORS.has(method)) return;
        const root = rootIdentifier(callee.object);
        if (root) reportIfModuleLevel(root, node);
      },
    };
  },
};
