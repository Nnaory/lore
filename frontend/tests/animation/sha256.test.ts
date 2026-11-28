/**
 * Tests — sha256Hex and its pure TypeScript fallback (Requirement 26.9, 26.12, 26.18, design 7.4).
 *
 * Three independent sources must agree: the NIST vectors, `node:crypto` (used only here, as an
 * oracle), and the two code paths of `sha256Hex` (`crypto.subtle` and the pure implementation).
 * Inputs are deterministic (no `Math.random`) so a failure is reproducible. The last group makes
 * `crypto.subtle` absent, rejecting, throwing or returning nonsense and checks that the answer is
 * still right, which proves the switch to the pure path.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex, sha256HexPure } from "@/lib/animation/sha256";

const encoder = new TextEncoder();

/** Independent oracle: Node's own SHA-256. */
function oracle(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** `length` bytes from a fixed linear congruential generator: same input on every run. */
function patterned(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

/** Message lengths around the one-block/two-block padding boundary, plus the bundle size limit. */
const LENGTHS = [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 131072];

const NIST: ReadonlyArray<readonly [string, string, string]> = [
  ["empty message", "", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["abc", "abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  [
    "448-bit message",
    "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  ],
  [
    "896-bit message",
    "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
    "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1",
  ],
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("NIST vectors", () => {
  it.each(NIST)("%s on the pure path", (_name, text, digest) => {
    expect(sha256HexPure(encoder.encode(text))).toBe(digest);
  });

  it.each(NIST)("%s through sha256Hex with crypto.subtle", async (_name, text, digest) => {
    const spy = vi.spyOn(globalThis.crypto.subtle, "digest");
    expect(await sha256Hex(encoder.encode(text))).toBe(digest);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe("SHA-256");
  });

  it.each(NIST)("%s through sha256Hex without crypto.subtle", async (_name, text, digest) => {
    vi.stubGlobal("crypto", {});
    expect(await sha256Hex(encoder.encode(text))).toBe(digest);
  });
});

describe("both paths and the oracle agree", () => {
  it.each(LENGTHS)("for %i bytes", async (length) => {
    const bytes = patterned(length, length + 7);
    const expected = oracle(bytes);

    expect(sha256HexPure(bytes)).toBe(expected);

    const spy = vi.spyOn(globalThis.crypto.subtle, "digest");
    expect(await sha256Hex(bytes)).toBe(expected);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("for a view that starts inside a larger buffer", async () => {
    const backing = patterned(300, 99);
    const view = backing.subarray(5, 5 + 120);
    const expected = oracle(backing.slice(5, 5 + 120));

    expect(sha256HexPure(view)).toBe(expected);
    expect(await sha256Hex(view)).toBe(expected);
  });

  it("returns 64 lowercase hex characters", async () => {
    for (const length of [0, 3, 64]) {
      const digest = sha256HexPure(patterned(length));
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
      expect(await sha256Hex(patterned(length))).toBe(digest);
    }
  });

  it("does not modify its input", () => {
    const bytes = patterned(100, 5);
    const before = bytes.slice();
    sha256HexPure(bytes);
    expect(bytes).toEqual(before);
  });
});

describe("fall back to the pure path", () => {
  const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  const abc = encoder.encode("abc");

  it("when crypto is missing", async () => {
    vi.stubGlobal("crypto", undefined);
    expect(await sha256Hex(abc)).toBe(ABC);
  });

  it("when crypto has no subtle", async () => {
    vi.stubGlobal("crypto", { subtle: undefined });
    expect(await sha256Hex(abc)).toBe(ABC);
  });

  it("when digest rejects", async () => {
    const spy = vi
      .spyOn(globalThis.crypto.subtle, "digest")
      .mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    expect(await sha256Hex(abc)).toBe(ABC);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("when digest throws synchronously", async () => {
    const spy = vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementation(() => {
      throw new TypeError("not supported");
    });
    expect(await sha256Hex(abc)).toBe(ABC);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("when digest answers with something that is not 32 bytes", async () => {
    vi.spyOn(globalThis.crypto.subtle, "digest").mockResolvedValue(new ArrayBuffer(8));
    expect(await sha256Hex(abc)).toBe(ABC);
  });

  it("for every boundary length when digest rejects", async () => {
    vi.spyOn(globalThis.crypto.subtle, "digest").mockRejectedValue(new Error("no"));
    for (const length of LENGTHS) {
      const bytes = patterned(length, length + 3);
      expect(await sha256Hex(bytes)).toBe(oracle(bytes));
    }
  });
});

describe("module source", () => {
  it("imports nothing and uses no Node, DOM or Buffer API (it is bundled into the sandbox runtime)", () => {
    const source = readFileSync(new URL("../../src/lib/animation/sha256.ts", import.meta.url), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/^\s*import\b/m);
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/\bBuffer\b/);
    expect(code).not.toMatch(/node:/);
    expect(code).not.toMatch(/\b(document|window|process)\b/);
  });
});
