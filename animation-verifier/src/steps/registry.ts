// Registri langkah produksi pipeline verifier (design 5.1; tugas 4.1 sampai 7.1).
// Daftar ini adalah satu-satunya tempat sebuah langkah dipasang ke `verify()`. Menambah langkah:
// ekspor satu `VerifierStep` dari modul langkahnya (`{ number, run }`, lihat `step.ts`), impor di
// sini, dan tambahkan ke `DEFAULT_STEPS`. Urutan elemen tidak berpengaruh; `number` yang menentukan.
//
// Hanya langkah yang benar-benar ada yang terdaftar. Langkah yang belum ada tidak diganti stub yang
// selalu lolos: `verify()` hanya melaporkan `ok` bila ketujuh langkah berjalan dan menghasilkan
// bundle serta meta, selain itu hasilnya `VERIFIER_INTERNAL` (gagal tertutup). Rencana pengisian:
//   langkah 1 `size`     tugas 4.1 (terdaftar)   langkah 2 `policy`  tugas 4.2 (terdaftar, aturan inti)
//                                                                       dan 4.3 (aturan lain, di `POLICY_RULES`)
//   langkah 3 `eslint`   tugas 5.2 (terdaftar)   langkah 4 `tsc`     tugas 5.3 (terdaftar)
//   langkah 5 `esbuild`  tugas 5.4 (terdaftar)   langkah 6 `render`  tugas 6.2 (dibuat dengan RenderHost)
//   langkah 7 `fidelity` tugas 7.1

import { bundleVerifierStep } from "./bundle.js";
import { fidelityStep } from "./fidelity.js";
import { lintStep } from "./lint.js";
import { policyStep } from "./policy.js";
import { renderStep } from "./render.js";
import { sizeStep } from "./size.js";
import type { VerifierStep } from "./step.js";
import { typecheckStep } from "./typecheck.js";

export const DEFAULT_STEPS: readonly VerifierStep[] = [sizeStep, policyStep, lintStep, typecheckStep, bundleVerifierStep, renderStep, fidelityStep];
