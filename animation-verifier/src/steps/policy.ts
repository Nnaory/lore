// Langkah 2 pipeline verifier: pemindaian kebijakan AST (design 5.5 dan tabel 5.12; Requirement 1, 7,
// 6.5, 6.15; tugas 4.2 dan 4.3).
// Alur: `main.ts` di-parse sebagai TSX (supaya JSX dikenali) dan dimuat ke Program kecil tanpa lib
// (`host/ts-host.ts`), lalu semua `PolicyRule` dijalankan dalam satu lintasan (`policy/scan.ts`) dan
// seluruh temuan dikembalikan, tidak berhenti pada yang pertama (Requirement 7.12). Langkah ini selalu
// berjalan bila langkah 1 bersih, bersama langkah 3 dan 4 (design 5.3 butir 4), dan tidak memanggil
// jaringan atau disk.
//
// STATUS: tugas 4.2 memasang aturan inti (`CORE_POLICY_RULES`: JSX, impor, impor dinamis, identifier,
// anggota, properti) dan tugas 4.3 melengkapinya dengan aturan elemen dan atribut
// (`policy/element-rules.ts`), literal URL dan warna (`policy/literal-rules.ts`), serta bentuk modul
// (`policy/module-rules.ts`: meta, pause, ekspor). Titik sambung tetap satu: tambahkan objek `PolicyRule`
// ke `POLICY_RULES` di bawah (`visit` per node, `finish` untuk aturan tingkat berkas). Aturan meta mengisi
// `META_ARTIFACT` (bagi langkah 6 dan 7) hanya bila seluruh `meta` valid; pipeline tetap gagal tertutup
// karena `verify()` tidak melaporkan `ok` tanpa bundle dari langkah 5.
//
// Galat internal (Program tidak memuat `main.ts`) dilempar sebagai exception biasa tanpa teks sumber,
// sesuai kontrak langkah di `step.ts`: `safeVerify` mengubahnya menjadi satu `VERIFIER_INTERNAL`.

import ts from "typescript";
import { createVirtualProgram, virtualPath } from "../host/ts-host.js";
import { CORE_POLICY_RULES } from "../policy/core-rules.js";
import { ELEMENT_POLICY_RULES } from "../policy/element-rules.js";
import { LITERAL_POLICY_RULES } from "../policy/literal-rules.js";
import { MODULE_POLICY_RULES } from "../policy/module-rules.js";
import { createPolicyScan, runPolicyRules, type PolicyRule } from "../policy/scan.js";
import type { VerifierStep } from "./step.js";

/**
 * Semua aturan langkah 2: inti (4.2), elemen dan atribut, literal URL dan warna, serta bentuk modul
 * (meta, pause, ekspor; 4.3). Urutan tidak memengaruhi keluaran: `finalize` mengurutkannya.
 */
export const POLICY_RULES: readonly PolicyRule[] = [
  ...CORE_POLICY_RULES,
  ...ELEMENT_POLICY_RULES,
  ...LITERAL_POLICY_RULES,
  ...MODULE_POLICY_RULES,
];

export const policyStep: VerifierStep = {
  number: 2,
  run(context) {
    const program = createVirtualProgram({
      path: virtualPath(context.contract.file_name),
      text: context.input.source,
      scriptKind: ts.ScriptKind.TSX,
    });
    if (!program.ok) throw new Error(program.reason);

    const scan = createPolicyScan(context, program);
    runPolicyRules(scan, POLICY_RULES);
    return { diagnostics: scan.diagnostics };
  },
};
