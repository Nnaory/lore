// Penelusuran AST iteratif untuk pemindaian kebijakan (design 5.5; tugas 4.2).
// Rekursi biasa pada `forEachChild` melampaui tumpukan JavaScript untuk ekspresi biner sangat dalam
// (`1+1+1+...` dalam 32 KB menghasilkan puluhan ribu tingkat), padahal sumber sah menurut langkah 1.
// Karena itu penelusuran memakai tumpukan eksplisit. Urutannya pra-urut menurut urutan dokumen,
// sehingga hasil tidak bergantung pada mesin. Modul ini murni: tanpa throw, jam, atau acak.

import ts from "typescript";

/** Anak langsung `node` menurut urutan dokumen. Callback tidak mengembalikan nilai agar iterasi tidak berhenti. */
function childrenOf(node: ts.Node): ts.Node[] {
  const children: ts.Node[] = [];
  ts.forEachChild(node, (child) => {
    children.push(child);
  });
  return children;
}

/** Mengunjungi `root` dan semua turunannya (pra-urut, urutan dokumen) tanpa rekursi. */
export function walkNodes(root: ts.Node, visit: (node: ts.Node) => void): void {
  const pending: ts.Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    visit(node);
    const children = childrenOf(node);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) pending.push(child);
    }
  }
}
