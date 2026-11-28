/**
 * `LruCache`: a small least-recently-used map (Requirement 26.8, design 7.4).
 *
 * The Animation_Loader keeps verified bundles in page memory so that showing the same animation
 * again costs no network. Memory must stay bounded (a bundle is up to 128 KiB and a long session
 * can pass through many animations), so the cache holds at most `capacity` entries and, when a new
 * key arrives and it is full, drops the entry that was used least recently.
 *
 * "Used" means `get` or `set`: a `get` that finds the key moves it to the newest position, which is
 * what makes a bundle that is shown again and again survive while one shown once is evicted.
 * `has` and `size` are for inspection and do not change the order. The order is the insertion order
 * of a `Map`, so the oldest key is the first one.
 *
 * Nothing here throws. A `capacity` that is not a whole number >= 1 becomes 1, so a bad argument
 * cannot produce a cache that stores nothing or never evicts. There is no React, DOM or timer.
 */

export class LruCache<K, V> {
  private readonly entries = new Map<K, V>();
  readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = Number.isSafeInteger(capacity) && capacity >= 1 ? capacity : 1;
  }

  /** The value for `key`, which becomes the most recently used, or `undefined` when absent. */
  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as V;
    // Re-insert so the key moves to the newest position.
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  /**
   * Stores `value` as the most recently used entry. A new key in a full cache evicts the least
   * recently used one; replacing an existing key evicts nothing.
   */
  set(key: K, value: V): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= this.capacity) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, value);
  }

  /** Whether `key` is stored. Does not change the order. */
  has(key: K): boolean {
    return this.entries.has(key);
  }

  /** Removes `key`. Returns whether it was there. */
  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  /** Removes every entry. */
  clear(): void {
    this.entries.clear();
  }

  /** Number of stored entries, never more than `capacity`. */
  get size(): number {
    return this.entries.size;
  }
}
