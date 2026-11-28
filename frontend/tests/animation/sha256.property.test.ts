/**
 * Property tests: the two `sha256Hex` implementations are the same function (task 23.2, design
 * Property 14). Validates Requirement 26.12.
 *
 * Property 14: for every byte array, including lengths 0, 55, 56, 63, 64, 65 and the bundle size
 * limit, the digest from `crypto.subtle` and the digest from the pure TypeScript implementation are
 * the same lower-case hex string.
 *
 * `sha256.test.ts` holds the NIST vectors and a fixed list of lengths. Here fast-check supplies the
 * bytes, 200 runs per property (the task asks for at least 100). `node:crypto` is an extra oracle
 * and appears only in this test file, never in `src/`.
 *
 * Two things keep the property from passing for the wrong reason. The `crypto.subtle` side is
 * called directly (not only through `sha256Hex`, which would silently fall back to the pure code if
 * `subtle` failed and then compare the pure code with itself), and a spy on `digest` shows that
 * `sha256Hex` really tried `subtle` first. The large inputs are expanded from a seed with a small
 * generator, because asking fast-check for 131072 random elements per run is slow.
 *
 * Properties:
 *   1. subtle, pure, `node:crypto` and `sha256Hex` agree on random bytes and on bytes of boundary lengths;
 *   2. the same holds for a view that starts inside a larger buffer;
 *   3. when `subtle` is missing, rejects, throws or answers with something that is not a digest,
 *      `sha256Hex` still returns the right digest, and it tried `subtle` where there was one to try;
 *   4. the digest is 64 lower-case hex characters, the input is not modified, and the answer is repeatable;
 *   5. every length from 0 to 260 and every boundary length (a plain sweep, no randomness).
 */

import { createHash } from "node:crypto";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { CONTRACT } from "@/lib/animation/contract";
import { sha256Hex, sha256HexPure } from "@/lib/animation/sha256";

const RUNS = 200;

/** Lengths around the padding boundaries of one and two blocks, and the largest bundle the contract allows. */
const BOUNDARY_LENGTHS = [
  0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 121, 127, 128, 129, CONTRACT.limits.bundle_max_bytes - 1,
  CONTRACT.limits.bundle_max_bytes,
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Oracles
// ---------------------------------------------------------------------------

/** `node:crypto`: independent of both implementations under test. */
function nodeDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** `crypto.subtle` called directly, not through `sha256Hex`. */
async function subtleDigest(bytes: Uint8Array): Promise<string> {
  const buffer = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Byte generators
// ---------------------------------------------------------------------------

type Fill = "seeded" | "zeros" | "ones" | "ramp";

/** `length` bytes that depend only on the arguments: a xorshift stream, or a constant, or a ramp. */
function expand(length: number, fill: Fill, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = (seed | 0) || 1;
  for (let i = 0; i < length; i += 1) {
    if (fill === "zeros") out[i] = 0;
    else if (fill === "ones") out[i] = 0xff;
    else if (fill === "ramp") out[i] = i & 0xff;
    else {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      out[i] = state & 0xff;
    }
  }
  return out;
}

const boundaryBytesArb = fc
  .record({
    length: fc.constantFrom(...BOUNDARY_LENGTHS),
    fill: fc.constantFrom<Fill>("seeded", "zeros", "ones", "ramp"),
    seed: fc.integer(),
  })
  .map(({ length, fill, seed }) => expand(length, fill, seed));

/** Short random arrays (fast-check shrinks these well) and arrays of the boundary lengths. */
const bytesArb: fc.Arbitrary<Uint8Array> = fc.oneof(
  { weight: 1, arbitrary: fc.uint8Array({ maxLength: 300 }) },
  { weight: 1, arbitrary: boundaryBytesArb },
);

// ---------------------------------------------------------------------------
// 1. The implementations agree
// ---------------------------------------------------------------------------

describe("Property 14: subtle, pure and node:crypto give the same digest", () => {
  it("covers every boundary length (the generator is not missing a case)", () => {
    const lengths = new Set(fc.sample(bytesArb, 800).map((bytes) => bytes.length));
    for (const length of BOUNDARY_LENGTHS) expect(lengths.has(length)).toBe(true);
  });

  it("agree on random bytes and on bytes of boundary lengths", async () => {
    const spy = vi.spyOn(globalThis.crypto.subtle, "digest");
    await fc.assert(
      fc.asyncProperty(bytesArb, async (bytes) => {
        const expected = nodeDigest(bytes);

        spy.mockClear();
        const viaFunction = await sha256Hex(bytes);
        expect(spy).toHaveBeenCalledTimes(1); // sha256Hex tried subtle first
        expect(spy.mock.calls[0][0]).toBe("SHA-256");

        expect(await subtleDigest(bytes)).toBe(expected);
        expect(sha256HexPure(bytes)).toBe(expected);
        expect(viaFunction).toBe(expected);
      }),
      { numRuns: RUNS },
    );
  });

  it("agree on a view that starts inside a larger buffer", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 1, maxLength: 400 }),
        fc.nat(),
        fc.nat(),
        async (backing, startSeed, lengthSeed) => {
          const start = startSeed % backing.length;
          const view = backing.subarray(start, start + (lengthSeed % (backing.length - start + 1)));
          const expected = nodeDigest(view.slice());

          expect(sha256HexPure(view)).toBe(expected);
          expect(await sha256Hex(view)).toBe(expected);
          expect(await subtleDigest(view)).toBe(expected);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// 2. When subtle cannot answer, the pure path answers
// ---------------------------------------------------------------------------

type Failure = "no-crypto" | "no-subtle" | "rejects" | "throws" | "short-result" | "long-result" | "no-result";

/** Failures where `crypto.subtle.digest` exists and is called, and what it does. */
const FAILURES: Failure[] = ["no-crypto", "no-subtle", "rejects", "throws", "short-result", "long-result", "no-result"];
const TRIES_SUBTLE: ReadonlySet<Failure> = new Set(["rejects", "throws", "short-result", "long-result", "no-result"]);

/** Makes `crypto.subtle` fail in the given way and returns the spy on `digest` (or null when there is none). */
function breakSubtle(failure: Failure): MockInstance<SubtleCrypto["digest"]> | null {
  if (failure === "no-crypto") {
    vi.stubGlobal("crypto", undefined);
    return null;
  }
  if (failure === "no-subtle") {
    vi.stubGlobal("crypto", { subtle: undefined });
    return null;
  }
  const spy = vi.spyOn(globalThis.crypto.subtle, "digest");
  if (failure === "rejects") spy.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
  else if (failure === "throws") {
    spy.mockImplementation(() => {
      throw new TypeError("not supported");
    });
  } else if (failure === "short-result") spy.mockResolvedValue(new ArrayBuffer(8));
  else if (failure === "long-result") spy.mockResolvedValue(new ArrayBuffer(64));
  else spy.mockResolvedValue(undefined as unknown as ArrayBuffer);
  return spy;
}

describe("Property 14: sha256Hex falls back to the pure implementation", () => {
  it("returns the right digest for any bytes when subtle is missing, rejects, throws or answers wrongly", async () => {
    await fc.assert(
      fc.asyncProperty(bytesArb, fc.constantFrom(...FAILURES), async (bytes, failure) => {
        const expected = nodeDigest(bytes);
        try {
          const spy = breakSubtle(failure);
          const digest = await sha256Hex(bytes);
          expect(digest).toBe(expected);
          if (TRIES_SUBTLE.has(failure)) expect(spy).toHaveBeenCalledTimes(1);
        } finally {
          vi.restoreAllMocks();
          vi.unstubAllGlobals();
        }
      }),
      { numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Shape, purity, repeatability
// ---------------------------------------------------------------------------

describe("Property 14: the digest is well formed and the input is left alone", () => {
  it("is 64 lower-case hex characters, repeatable, and does not change the bytes", async () => {
    await fc.assert(
      fc.asyncProperty(bytesArb, async (bytes) => {
        const before = bytes.slice();
        const pure = sha256HexPure(bytes);
        expect(pure).toMatch(/^[0-9a-f]{64}$/);
        expect(sha256HexPure(bytes)).toBe(pure);
        const hex = await sha256Hex(bytes);
        expect(hex).toBe(pure);
        expect(Array.from(bytes)).toEqual(Array.from(before));
      }),
      { numRuns: RUNS },
    );
  });

  it("differs when one byte differs", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 1, maxLength: 200 }), fc.nat(), fc.integer({ min: 1, max: 255 }), async (bytes, at, flip) => {
        const changed = bytes.slice();
        changed[at % changed.length] ^= flip;
        expect(sha256HexPure(changed)).not.toBe(sha256HexPure(bytes));
        expect(await sha256Hex(changed)).not.toBe(await sha256Hex(bytes));
      }),
      { numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// 4. A plain sweep over lengths
// ---------------------------------------------------------------------------

describe("Property 14: every length around the block boundaries", () => {
  const lengths = [...new Set([...Array.from({ length: 261 }, (_, i) => i), ...BOUNDARY_LENGTHS])];

  it.each(["seeded", "zeros", "ones"] as const)("agree for each length, %s bytes", async (fill) => {
    for (const length of lengths) {
      const bytes = expand(length, fill, length + 1);
      const expected = nodeDigest(bytes);
      expect(sha256HexPure(bytes)).toBe(expected);
      expect(await sha256Hex(bytes)).toBe(expected);
    }
  });
});
