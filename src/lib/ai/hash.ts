/**
 * Small deterministic string hash (32-bit FNV-1a, base36).
 * Used for stable IDs and seeded ordering — not for security.
 */
export function stableHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** Deterministic Fisher–Yates shuffle seeded by `seed`. Returns a new array. */
export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const out = [...items];
  // mulberry32: well-mixed even for near-identical seeds (e.g. "…_c01" / "…_c02").
  let state = parseInt(stableHash(seed), 36) >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
