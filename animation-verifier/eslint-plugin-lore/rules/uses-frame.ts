// Aturan `lore/uses-frame` (design 5.6; Requirement 1.7, 8.1, 8.12): animasi yang tidak membaca
// nomor frame adalah gambar diam, jadi Main_File wajib memanggil `useCurrentFrame` paling sedikit
// sekali. Yang dihitung hanya pemanggilan identifier yang ter-resolve ke binding impor
// `useCurrentFrame` dari `remotion`, termasuk alias (`import { useCurrentFrame as f }`).
// Fungsi lokal bernama sama, impor dari modul lain, dan parameter yang menimpa nama itu tidak
// dihitung, karena pencocokan memakai referensi variabel hasil analisis scope, bukan nama.
// Nol pemanggilan dilaporkan di baris 1 kolom 1 (berkas kosong pun punya baris 1).
// Aturan ini tidak punya opsi dan tidak membaca kontrak.

import type { Rule, SourceCode } from "eslint";

type EsNode = Parameters<SourceCode["getScope"]>[0];
type NodeOf<T extends EsNode["type"]> = Extract<EsNode, { type: T }>;

const REMOTION_MODULE = "remotion";
const FRAME_HOOK = "useCurrentFrame";

/** Nama yang diekspor modul: `Identifier` biasa atau string literal (`import { "x" as y }`). */
function importedName(specifier: NodeOf<"ImportSpecifier">): string {
  const { imported } = specifier;
  return imported.type === "Identifier" ? imported.name : String(imported.value);
}

export const usesFrame: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description: "Require at least one call to useCurrentFrame imported from remotion.",
    },
    schema: [],
    messages: {
      missingCall: "Main must call useCurrentFrame() imported from remotion at least once",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;

    return {
      "Program:exit"(program) {
        let calls = 0;
        for (const statement of program.body) {
          if (statement.type !== "ImportDeclaration" || statement.source.value !== REMOTION_MODULE) {
            continue;
          }
          for (const specifier of statement.specifiers) {
            if (specifier.type !== "ImportSpecifier" || importedName(specifier) !== FRAME_HOOK) {
              continue;
            }
            for (const variable of sourceCode.getDeclaredVariables(specifier)) {
              for (const reference of variable.references) {
                // `parent` dipasang ESLint saat traversal; tipe `Identifier` dari scope tidak memuatnya.
                const parent = (reference.identifier as Rule.Node).parent;
                if (parent?.type === "CallExpression" && parent.callee === reference.identifier) {
                  calls += 1;
                }
              }
            }
          }
        }
        if (calls === 0) {
          context.report({ loc: { line: 1, column: 0 }, messageId: "missingCall" });
        }
      },
    };
  },
};
