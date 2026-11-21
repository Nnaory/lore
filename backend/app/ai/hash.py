"""Small deterministic string hash shared with the frontend.

Why: port of `stableHash` in `frontend/src/lib/contracts/hash.ts` (32-bit FNV-1a over UTF-16
code units, base 36). Generated IDs such as `material_<hash>` must match what the Next.js
pipeline produced for the same text. seeded_shuffle ports seededShuffle (mulberry32 seeded
by that hash) so puzzle choices come out in the same order as in the TypeScript pipeline.
Not for security.
"""

from __future__ import annotations

_FNV_OFFSET = 0x811C9DC5
_FNV_PRIME = 0x01000193
_BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz"


_U32 = 0xFFFFFFFF


def seeded_shuffle[T](items: list[T], seed: str) -> list[T]:
    """Deterministic Fisher-Yates shuffle, identical to `seededShuffle` in the frontend.

    The generator is mulberry32 seeded with `stable_hash(seed)`. JavaScript's `Math.imul` and
    `>>> 0` wrap to 32 bits, so every step here is masked to 32 bits, which gives the same
    sequence. Returns a new list.
    """
    out = list(items)
    state = int(stable_hash(seed), 36) & _U32

    def next_random() -> float:
        nonlocal state
        state = (state + 0x6D2B79F5) & _U32
        t = state
        t = ((t ^ (t >> 15)) * (t | 1)) & _U32
        t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & _U32)) & _U32
        return ((t ^ (t >> 14)) & _U32) / 0x100000000

    for i in range(len(out) - 1, 0, -1):
        j = int(next_random() * (i + 1))
        out[i], out[j] = out[j], out[i]
    return out


def stable_hash(text: str) -> str:
    """FNV-1a hash of `text`, as lowercase base 36."""
    raw = text.encode("utf-16-le", errors="surrogatepass")
    value = _FNV_OFFSET
    for i in range(0, len(raw), 2):
        unit = raw[i] | (raw[i + 1] << 8)
        value = ((value ^ unit) * _FNV_PRIME) & 0xFFFFFFFF
    digits = ""
    while value:
        value, rem = divmod(value, 36)
        digits = _BASE36[rem] + digits
    return digits or "0"
