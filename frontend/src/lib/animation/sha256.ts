/**
 * SHA-256 as lowercase hex, with a pure TypeScript fallback (Requirement 26.9, 26.12, 26.18,
 * design 7.4, D-19).
 *
 * The Animation_Loader checks the SHA-256 of the downloaded bundle against
 * `bundle_sha256` before anything is executed. `crypto.subtle` is the fast path, but browsers expose
 * it only in secure contexts, and the site can be served over plain HTTP from an Elastic IP.
 * Without a second implementation the integrity check would be impossible there, or would be
 * skipped. So `sha256Hex` uses `crypto.subtle.digest` when it exists and answers, and otherwise
 * (no `subtle`, `digest` rejects or throws, or an unexpected result) computes the digest with
 * `sha256HexPure`. Both paths return the same string, which `tests/animation/sha256.test.ts`
 * checks against NIST vectors and `node:crypto`.
 *
 * `sha256Hex` never rejects: any input `Uint8Array` has a digest, so there is no failure to put in
 * a result union. This file has no imports and touches no DOM, Node or React API (no `Buffer`)
 * because the Sandbox_Runtime bundle may include it. It reads `globalThis.crypto` only.
 */

/** Round constants: the first 32 bits of the fractional parts of the cube roots of the first 64 primes. */
const K: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** Initial hash value: the first 32 bits of the fractional parts of the square roots of the first 8 primes. */
const H0: readonly number[] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

/** A digest is 32 bytes. */
const DIGEST_BYTES = 32;

/** Rotate a 32-bit word right by `n` bits (0 < n < 32). */
function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** Lowercase hex of the 32 bytes in `digest`. */
function toHex(digest: Uint8Array): string {
  let out = "";
  for (let i = 0; i < digest.length; i++) out += digest[i].toString(16).padStart(2, "0");
  return out;
}

/**
 * SHA-256 of `bytes` as 64 lowercase hex characters, in plain TypeScript. Synchronous, with no
 * platform API. It is exported for the tests and as the fallback of `sha256Hex`.
 */
export function sha256HexPure(bytes: Uint8Array): string {
  const length = bytes.length;

  // Padding: the message, one 0x80 byte, zeros up to 8 bytes short of a 64-byte block, then the
  // message length in bits as a 64-bit big-endian integer (bits = length * 8).
  const paddedLength = Math.ceil((length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[length] = 0x80;
  const bitsHigh = Math.floor(length / 0x20000000); // floor(length * 8 / 2^32)
  const bitsLow = (length * 8) >>> 0; // length * 8 mod 2^32
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, bitsHigh);
  view.setUint32(paddedLength - 4, bitsLow);

  const hash = H0.map((word) => word | 0);
  const w = new Int32Array(64);

  for (let block = 0; block < paddedLength; block += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getInt32(block + t * 4);
    for (let t = 16; t < 64; t++) {
      const x = w[t - 15];
      const y = w[t - 2];
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }

    let a = hash[0];
    let b = hash[1];
    let c = hash[2];
    let d = hash[3];
    let e = hash[4];
    let f = hash[5];
    let g = hash[6];
    let h = hash[7];

    for (let t = 0; t < 64; t++) {
      const bigS1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + bigS1 + ch + K[t] + w[t]) | 0;
      const bigS0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (bigS0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }

    hash[0] = (hash[0] + a) | 0;
    hash[1] = (hash[1] + b) | 0;
    hash[2] = (hash[2] + c) | 0;
    hash[3] = (hash[3] + d) | 0;
    hash[4] = (hash[4] + e) | 0;
    hash[5] = (hash[5] + f) | 0;
    hash[6] = (hash[6] + g) | 0;
    hash[7] = (hash[7] + h) | 0;
  }

  const digest = new Uint8Array(DIGEST_BYTES);
  const out = new DataView(digest.buffer);
  for (let i = 0; i < 8; i++) out.setInt32(i * 4, hash[i]);
  return toHex(digest);
}

/**
 * SHA-256 through `crypto.subtle`, or `null` when that path is unavailable or fails: there is no
 * `subtle` (non-secure context), `digest` throws or rejects, or it answers with something other
 * than 32 bytes. The caller then uses the pure implementation.
 */
async function sha256Subtle(bytes: Uint8Array): Promise<string | null> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle || typeof subtle.digest !== "function") return null;
    // A view over a SharedArrayBuffer is not a BufferSource: `digest` rejects it and the caller
    // falls back, so the cast only silences the compile-time `ArrayBufferLike` mismatch.
    const result = await subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
    // No `instanceof ArrayBuffer`: that fails for a buffer made in another realm (iframe, jsdom).
    if (result?.byteLength !== DIGEST_BYTES) return null;
    return toHex(new Uint8Array(result));
  } catch {
    return null;
  }
}

/**
 * SHA-256 of `bytes` as 64 lowercase hex characters. Uses `crypto.subtle.digest` when it is
 * available and succeeds, and the pure TypeScript implementation otherwise. Never rejects.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const viaSubtle = await sha256Subtle(bytes);
  return viaSubtle ?? sha256HexPure(bytes);
}
