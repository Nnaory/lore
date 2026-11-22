/** "LORE" in 5×5 block letters (each pixel two cells wide) with an ember drop shadow. */
import { CREAM, ORANGE, grid, layers, type Layer } from './core';

export function wordmark(): Layer[] {
  const F: Record<string, string[]> = { L: ['#    ', '#    ', '#    ', '#    ', '#####'], O: [' ### ', '#   #', '#   #', '#   #', ' ### '], R: ['#### ', '#   #', '#### ', '#  # ', '#   #'], E: ['#####', '#    ', '#### ', '#    ', '#####'] };
  const word = 'LORE', C = word.length * 12 + 2, R = 6, g = grid(C, R);
  word.split('').forEach((ch, i) => F[ch].forEach((row, r) => row.split('').forEach((p, k) => { if (p === '#') { const c = i * 12 + k * 2; [0, 1].forEach(d => { if (!g[r + 1][c + d + 1]) g[r + 1][c + d + 1] = 's'; g[r][c + d] = 'f'; }); } })));
  return layers(g, { s: { ch: '▓', color: ORANGE, op: 0.9 }, f: { ch: '█', color: CREAM, op: 1 } });
}
