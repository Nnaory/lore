/**
 * Tests — LruCache (Requirement 26.8, design 7.4).
 *
 * What must hold: the cache never holds more than `capacity` entries, a full cache drops the entry
 * that was used longest ago, and "used" means `get` or `set` (a `get` hit moves the key to the
 * newest place) but not `has` or `size`. The last group compares long random sequences with a
 * plain array model of the same rule, with a fixed seed so a failure repeats.
 */

import { describe, expect, it } from "vitest";
import { LruCache } from "@/lib/animation/lru";

/** A cache of `capacity` with `keys` stored in that order (so the first key is the oldest). */
function filled(capacity: number, keys: string[]): LruCache<string, number> {
  const cache = new LruCache<string, number>(capacity);
  keys.forEach((key, index) => cache.set(key, index));
  return cache;
}

describe("basic reads and writes", () => {
  it("returns undefined for a missing key and the value for a stored one", () => {
    const cache = new LruCache<string, number>(16);
    expect(cache.get("a")).toBeUndefined();
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    expect(cache.size).toBe(1);
  });

  it("keeps a falsy value, which is not a miss", () => {
    const cache = new LruCache<string, number | null>(2);
    cache.set("zero", 0);
    cache.set("null", null);
    expect(cache.get("zero")).toBe(0);
    expect(cache.get("null")).toBeNull();
    expect(cache.has("zero")).toBe(true);
  });

  it("replaces the value of an existing key without growing", () => {
    const cache = filled(2, ["a", "b"]);
    cache.set("a", 99);
    expect(cache.size).toBe(2);
    expect(cache.get("a")).toBe(99);
    expect(cache.has("b")).toBe(true);
  });

  it("delete and clear remove entries", () => {
    const cache = filled(4, ["a", "b", "c"]);
    expect(cache.delete("b")).toBe(true);
    expect(cache.delete("b")).toBe(false);
    expect(cache.has("b")).toBe(false);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });
});

describe("eviction order", () => {
  it("holds 16 entries and drops the oldest when a 17th arrives", () => {
    const keys = Array.from({ length: 16 }, (_, i) => `k${i}`);
    const cache = filled(16, keys);
    expect(cache.size).toBe(16);
    cache.set("k16", 16);
    expect(cache.size).toBe(16);
    expect(cache.has("k0")).toBe(false);
    for (const key of keys.slice(1)) expect(cache.has(key)).toBe(true);
    expect(cache.has("k16")).toBe(true);
  });

  it("a get hit makes the key the newest, so another key is evicted", () => {
    const cache = filled(3, ["a", "b", "c"]);
    expect(cache.get("a")).toBe(0); // a is now the newest; b is the oldest
    cache.set("d", 3);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("a")).toBe(true);
    expect(cache.has("c")).toBe(true);
    expect(cache.has("d")).toBe(true);
  });

  it("a get miss changes nothing", () => {
    const cache = filled(2, ["a", "b"]);
    expect(cache.get("zzz")).toBeUndefined();
    cache.set("c", 2);
    expect(cache.has("a")).toBe(false); // a was still the oldest
  });

  it("setting an existing key makes it the newest and evicts nothing", () => {
    const cache = filled(3, ["a", "b", "c"]);
    cache.set("a", 10);
    expect(cache.size).toBe(3);
    cache.set("d", 3);
    expect(cache.has("b")).toBe(false); // b, not a, was the oldest
    expect(cache.get("a")).toBe(10);
  });

  it("has and size do not change the order", () => {
    const cache = filled(2, ["a", "b"]);
    expect(cache.has("a")).toBe(true);
    expect(cache.size).toBe(2);
    cache.set("c", 2);
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(true);
  });

  it("with capacity 1 every new key replaces the one before", () => {
    const cache = new LruCache<string, number>(1);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.has("a")).toBe(false);
    expect(cache.get("b")).toBe(2);
  });
});

describe("capacity argument", () => {
  it.each([0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "%s becomes a capacity of 1",
    (capacity) => {
      const cache = new LruCache<string, number>(capacity);
      expect(cache.capacity).toBe(1);
      cache.set("a", 1);
      cache.set("b", 2);
      expect(cache.size).toBe(1);
    },
  );

  it("keeps a valid capacity", () => {
    expect(new LruCache<string, number>(16).capacity).toBe(16);
  });
});

describe("against a model", () => {
  /** Small deterministic generator (no Math.random). */
  function makeRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  it("matches a plain list that moves the key to the end on every get hit and set", () => {
    const random = makeRandom(7);
    for (const capacity of [1, 2, 5, 16]) {
      const cache = new LruCache<number, number>(capacity);
      const model: Array<[number, number]> = []; // oldest first
      for (let step = 0; step < 2000; step++) {
        const key = Math.floor(random() * (capacity * 2 + 1));
        if (random() < 0.5) {
          const index = model.findIndex(([k]) => k === key);
          const expected = index === -1 ? undefined : model[index][1];
          if (index !== -1) model.push(model.splice(index, 1)[0]);
          expect(cache.get(key)).toBe(expected);
        } else {
          const index = model.findIndex(([k]) => k === key);
          if (index !== -1) model.splice(index, 1);
          else if (model.length >= capacity) model.shift();
          model.push([key, step]);
          cache.set(key, step);
        }
        expect(cache.size).toBe(model.length);
        expect(cache.size).toBeLessThanOrEqual(capacity);
      }
      for (const [key] of model) expect(cache.has(key)).toBe(true);
    }
  });
});
