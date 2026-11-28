// Normalisasi dan pencocokan token untuk gerbang kesetiaan data (langkah 7, design 5.10).
// Satu definisi dipakai verifier dan tes paritas: Python (`normalize_token` di backend) harus
// menghasilkan string yang sama untuk setiap vektor di
// `backend/tests/fixtures/animation/token-normalization.json` (Requirement 10.13).

/**
 * Bentuk pembanding sebuah token atau teks frame: Unicode NFKC, `toLowerCase()` tanpa locale,
 * lalu hapus setiap karakter `\s` ECMAScript (termasuk U+00A0, U+3000, dan U+FEFF).
 * Urutan itu bagian dari kontrak: spasi dihapus setelah NFKC, jadi U+200B, U+200C, U+200D,
 * U+2060, U+0085, dan U+180E (bukan `\s`) tetap ada dan dapat memisahkan token di teks frame.
 * Tidak melempar exception untuk string apa pun (Requirement 10.1).
 */
export function normalizeToken(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/\s/g, "");
}

/**
 * Benar bila `token` adalah substring `frameText`. Kedua argumen harus sudah melewati
 * `normalizeToken`; fungsi ini sengaja tidak menormalkan ulang karena langkah kesetiaan
 * memotong dan mencocokkan teks frame yang sudah ternormalisasi (Requirement 10.1, 10.10).
 * Token kosong selalu terkandung. Pemanggil membuang token yang kosong setelah normalisasi
 * sebelum memanggil fungsi ini (Requirement 10.9).
 */
export function containsToken(frameText: string, token: string): boolean {
  return frameText.includes(token);
}
