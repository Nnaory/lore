// ---- shared ASCII generators (pasted into each artboard script) ----
function rng(seed){ let a = seed >>> 0; return function(){ a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function grid(c, r){ const g = []; for (let i = 0; i < r; i++) g.push(new Array(c).fill(null)); return g; }
function layers(g, spec, mask){
  const out = [];
  if (mask) out.push({ color: mask, op: 1, text: g.map(row => row.map(v => v ? '█' : ' ').join('')).join('\n') });
  Object.keys(spec).forEach(k => {
    const s = spec[k];
    let any = false;
    const text = g.map(row => row.map(v => { if (v === k) { any = true; return s.ch; } return ' '; }).join('')).join('\n');
    if (any) out.push({ color: s.color, op: s.op, text });
  });
  return out;
}
const CREAM = '#F4EFE6', GOLD = '#C9A227', ORANGE = '#FF7A18', INK = '#0F0F12', SMOKE = '#2A2A2E';

// Eldric, Keeper of the Beacon: paper-doll parts on a 44x48 grid (cell aspect 0.6)
function eldric(expr){
  const C = 44, R = 48, g = grid(C, R), A = 0.6, cx = 13.2;
  const put = (c, r, v) => { if (c >= 0 && c < C && r >= 0 && r < R) g[r][c] = v; };
  const each = (fn) => { for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) { const v = fn(c * A + A / 2, r + 0.5, c, r); if (v) g[r][c] = v; } };
  // robe
  each((x, y) => { if (y < 24 || y > 48) return; const t = (y - 24) / 24; const hw = 8.4 + t * 4.2; const d = Math.abs(x - cx);
    if (d > hw) return; if (d > hw - 0.7) return 'c3'; const fold = Math.abs(Math.sin((x - cx) * 1.15 + y * 0.06)); return fold > 0.93 ? 'c2' : 'c1'; });
  // sleeve + hand reaching to the lantern
  each((x, y) => { const sx = 17.5, sy = 27, ex = 20.6, ey = 33; const t = Math.max(0, Math.min(1, ((x - sx) * (ex - sx) + (y - sy) * (ey - sy)) / ((ex - sx) ** 2 + (ey - sy) ** 2)));
    const px = sx + t * (ex - sx), py = sy + t * (ey - sy); const d = Math.hypot((x - px) / 1, (y - py) / 1.6); if (d < 1.5) return d > 1.05 ? 'c3' : 'c2'; });
  each((x, y) => { if (Math.hypot((x - 20.8) / 1.1, (y - 33.6) / 1.1) < 1) return 'c4'; });
  // beard
  each((x, y) => { if (y < 20 || y > 36) return; const t = (y - 20) / 16; const hw = 4.9 * (1 - t * t * 0.95) ; const off = Math.sin(y * 0.5) * 0.25; const d = Math.abs(x - cx - off);
    if (d > hw) return; const strand = Math.abs(Math.sin((x - cx) * 3.1)); return strand > 0.9 ? 'c4' : 'c5'; });
  // face
  each((x, y) => { if (Math.hypot((x - cx) / 4.3, (y - 18.2) / 4.3) < 1 && y < 22.5) return 'c4'; });
  // hair at the sides
  each((x, y) => { if (y < 14 || y > 23) return; const d = Math.abs(x - cx); if (d > 4.2 && d < 5.9) return 'c3'; });
  // hat (bent tip) + brim + gold band + stars
  each((x, y) => { if (y < 1 || y > 13) return; const t = (y - 1) / 12; const tipx = cx + 3.4 * (1 - t) * (1 - t); const hw = 0.35 + t * 5.6; const d = Math.abs(x - tipx);
    if (d > hw) return; if (y > 10.6 && y < 12.4) return 'g2'; return d > hw - 0.8 ? 'c3' : 'c2'; });
  each((x, y) => { if (Math.hypot((x - cx) / 10.2, (y - 13.6) / 1.25) < 1) return Math.hypot((x - cx) / 10.2, (y - 13.6) / 1.25) > 0.72 ? 'c4' : 'c3'; });
  [[14.6, 4], [11.8, 8], [15.6, 9]].forEach(([x, y]) => put(Math.floor(x / A), y, 'g1'));
  // eyes + brows (expression)
  const eyeY = 18, ex1 = Math.floor((cx - 1.9) / A), ex2 = Math.floor((cx + 1.9) / A);
  [ex1, ex2].forEach(c => { put(c, eyeY, 'o2'); put(c + 1, eyeY, 'o2'); });
  const browY = expr === 'worried' ? 16 : 16;
  if (expr === 'worried') { put(ex1 - 1, browY, 'k'); put(ex1, browY, 'k'); put(ex1 + 1, browY - 1, 'k'); put(ex2, browY - 1, 'k'); put(ex2 + 1, browY, 'k'); put(ex2 + 2, browY, 'k'); }
  else { for (let i = -1; i <= 2; i++) { put(ex1 + i, browY, 'k'); put(ex2 + i - 1, browY, 'k'); } }
  // mouth
  const my = 22, mc = Math.floor(cx / A);
  if (expr === 'smile') { put(mc - 2, my - 1, 'k'); put(mc - 1, my, 'k'); put(mc, my, 'k'); put(mc + 1, my, 'k'); put(mc + 2, my - 1, 'k'); }
  else if (expr === 'worried') { put(mc - 1, my, 'k'); put(mc, my - 0, 'k'); put(mc + 1, my, 'k'); put(mc - 2, my + 1, 'k'); put(mc + 2, my + 1, 'k'); }
  else { for (let i = -1; i <= 1; i++) put(mc + i, my, 'k'); }
  // clasp
  put(Math.floor(cx / A) - 5, 25, 'g2'); put(Math.floor(cx / A) + 5, 25, 'g2');
  // lantern: hook, frame, flame, glow
  each((x, y) => { const lx = 21.2, top = 35, bot = 43; if (y < 34 || y > 44.5) return;
    if (Math.abs(x - lx) < 0.4 && y < 35.5) return 'g1';
    const hw = 2.1 - (y < 36 ? (36 - y) * 0.9 : 0) - (y > 42 ? (y - 42) * 0.7 : 0); const d = Math.abs(x - lx);
    if (y < top || y > bot || d > hw) return; if (d > hw - 0.65 || y < top + 1 || y > bot - 1) return 'g2';
    return Math.hypot((x - lx) / 0.9, (y - 39.2) / 2.3) < 1 ? 'o2' : 'o1'; });
  each((x, y, c, r) => { if (g[r][c]) return; const d = Math.hypot((x - 21.2) / 4.2, (y - 39) / 6.5); if (d < 1 && d > 0.55 && ((c * 7 + r * 3) % 5 === 0)) return 'o3'; });
  return layers(g, {
    c1: { ch: '.', color: CREAM, op: 0.42 }, c2: { ch: ':', color: CREAM, op: 0.6 }, c3: { ch: '+', color: CREAM, op: 0.78 },
    c4: { ch: '#', color: CREAM, op: 0.92 }, c5: { ch: '@', color: CREAM, op: 1 }, k: { ch: '-', color: INK, op: 1 },
    g1: { ch: '*', color: GOLD, op: 1 }, g2: { ch: '#', color: GOLD, op: 1 },
    o1: { ch: '*', color: ORANGE, op: 0.9 }, o2: { ch: '@', color: ORANGE, op: 1 }, o3: { ch: '·', color: ORANGE, op: 0.7 }
  }, INK);
}

// Procedural scene from a recipe: { seed, cols, rows, horizon, beaconCol, moon }
function scene(rec){
  const { cols: C, rows: R } = rec, g = grid(C, R), rnd = rng(rec.seed);
  for (let i = 0; i < C * R * 0.012; i++) { const c = Math.floor(rnd() * C), r = Math.floor(rnd() * rec.horizon * 0.9); g[r][c] = rnd() > 0.85 ? 's2' : 's1'; }
  if (rec.moon) { const [mc, mr, rad] = rec.moon; for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) { const d = Math.hypot((c - mc) * 0.6, r - mr); if (d < rad) g[r][c] = d > rad - 0.9 ? 'm2' : 'm1'; } }
  // skyline of towers
  let c = 0;
  while (c < C) { const w = 3 + Math.floor(rnd() * 7), h = Math.floor(rec.horizon * (0.12 + rnd() * 0.3)); const top = rec.horizon - h; const spire = rnd() > 0.7;
    for (let x = c; x < Math.min(C, c + w); x++) for (let y = top; y < R; y++) g[y][x] = 'b';
    if (spire) { const mid = c + Math.floor(w / 2); for (let y = top - 4; y < top; y++) if (y >= 0 && mid < C) g[y][mid] = 'b'; }
    for (let x = c + 1; x < Math.min(C, c + w - 1); x += 2) for (let y = top + 2; y < rec.horizon + 4; y += 3) if (rnd() > 0.82 && y < R) g[y][x] = 'w';
    c += w + (rnd() > 0.6 ? 1 : 0); }
  // the dying beacon tower
  const bc = rec.beaconCol, btop = Math.floor(rec.horizon * 0.18);
  for (let y = btop; y < R; y++) { const hw = y < btop + 4 ? 1 : 2 + Math.floor((y - btop) / 18); for (let x = bc - hw; x <= bc + hw; x++) if (x >= 0 && x < C) g[y][x] = 't'; }
  for (let y = btop - 3; y < btop; y++) for (let x = bc - 2; x <= bc + 2; x++) if (Math.abs(x - bc) <= 2 - (btop - y - 1)) g[y][x] = 'f';
  for (let r = btop - 8; r < btop + 5; r++) for (let x = bc - 10; x <= bc + 10; x++) { if (r < 0 || x < 0 || x >= C) continue; const d = Math.hypot((x - bc) * 0.6, r - (btop - 2)); if (!g[r][x] && d < 6 && d > 2.2 && rnd() > 0.55) g[r][x] = 'gl'; }
  // gate arch
  const gc = rec.gateCol, gw = 9, gtop = rec.horizon - 6;
  for (let y = gtop; y < R; y++) for (let x = gc - gw; x <= gc + gw; x++) { if (x < 0 || x >= C) continue; const inner = Math.abs(x - gc) < gw - 3 && (y > gtop + 3 + (Math.abs(x - gc) > 3 ? 0 : 0)) ; const arch = Math.hypot((x - gc) * 0.6, (y - (gtop + 6))) < 3.6 || (Math.abs(x - gc) < 6 && y > gtop + 6);
    g[y][x] = arch ? null : 't'; }
  // mist bands
  for (let r = rec.horizon; r < R; r++) for (let x = 0; x < C; x++) if (rnd() > 0.6 && (r % 3 === 0)) g[r][x] = 'mi';
  return layers(g, {
    s1: { ch: '.', color: CREAM, op: 0.28 }, s2: { ch: '+', color: GOLD, op: 0.6 }, m1: { ch: '░', color: CREAM, op: 0.16 }, m2: { ch: '▒', color: CREAM, op: 0.3 },
    b: { ch: '▓', color: SMOKE, op: 1 }, w: { ch: '▪', color: GOLD, op: 0.55 }, t: { ch: '█', color: SMOKE, op: 1 },
    f: { ch: '▲', color: ORANGE, op: 0.75 }, gl: { ch: '·', color: ORANGE, op: 0.45 }, mi: { ch: '~', color: SMOKE, op: 1 }
  });
}

// Jack-o'-lantern: { w, seed }
function pumpkin(w, seed){
  const rnd = rng(seed), R = Math.round(w * 0.42) + 3, C = w + 6, g = grid(C, R), cx = C / 2, cy = R / 2 + 1.2, rx = w / 2, ry = (R - 4) / 2;
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) { const dx = (c + 0.5 - cx) / rx, dy = (r + 0.5 - cy) / ry, d = Math.hypot(dx, dy);
    if (d < 1) { const rib = Math.abs(Math.sin(dx * Math.PI * 2.2)); g[r][c] = rib < 0.18 ? 'pr' : 'pb'; }
    else if (d < 1.35 && (c + r) % 2 === 0 && rnd() > 0.35) g[r][c] = 'h'; }
  // stem
  for (let r = 0; r < Math.max(2, Math.round(cy - ry)); r++) { const c = Math.floor(cx + (r === 0 ? 1 : 0)); g[r][c] = 'st'; }
  // face: triangle eyes + zigzag mouth
  const eyeR = Math.round(cy - ry * 0.25), ew = Math.max(2, Math.round(w * 0.09));
  [-1, 1].forEach(s => { const ec = Math.round(cx + s * w * 0.2); for (let i = 0; i < Math.max(2, Math.round(ew / 1.5)); i++) for (let k = -ew + i; k <= ew - i; k++) { const rr = eyeR - Math.max(2, Math.round(ew / 1.5)) + 1 + i; if (g[rr]) g[rr][ec + k] = 'f'; } });
  const mr = Math.round(cy + ry * 0.35), mw = Math.round(w * 0.3);
  for (let k = -mw; k <= mw; k++) { const c = Math.round(cx + k); g[mr][c] = 'f'; if (Math.abs(k) % 4 < 2 && Math.abs(k) < mw - 1) { if (g[mr + 1]) g[mr + 1][c] = 'f'; } else if (g[mr - 1] && Math.abs(k) < mw) g[mr - 1][c] = 'f'; }
  return layers(g, {
    pb: { ch: '▓', color: ORANGE, op: 0.92 }, pr: { ch: '▒', color: ORANGE, op: 0.5 }, f: { ch: '█', color: '#F2D27A', op: 1 }, st: { ch: '▌', color: GOLD, op: 0.8 }, h: { ch: '·', color: ORANGE, op: 0.35 }
  });
}
// Big jack-o'-lantern whose mouth is a rectangular hole (an input sits behind it)
function jackMouth(w, o){
  const C = w + 4, R = Math.round(w * 0.42) + 4, g = grid(C, R), cx = C / 2, cy = R / 2 + 1.5, rx = w / 2, ry = (R - 5) / 2;
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) { const dx = (c + 0.5 - cx) / rx, dy = (r + 0.5 - cy) / ry, d = Math.hypot(dx, dy);
    if (d < 1) g[r][c] = (Math.abs(Math.sin(dx * Math.PI * 2.2)) < 0.13 || d > 0.965) ? 'pr' : 'pb'; }
  const top = Math.round(cy - ry);
  for (let r = 0; r < top + 1; r++) for (let k = 0; k < 3; k++) { const c = Math.round(cx + k - 1 + (top - r) * 0.35); if (g[r] && c < C) g[r][c] = 'st'; }
  const eh = Math.round(ry * 0.3), er0 = Math.round(cy - ry * 0.7), ew = w * 0.085;
  [-1, 1].forEach(s => { const ec = cx + s * w * 0.19; for (let i = 0; i <= eh; i++) { const hw = (i / eh) * ew; for (let c = Math.round(ec - hw / 0.6 * 0.6); c <= Math.round(ec + hw); c++) if (Math.abs(c + 0.5 - ec) <= hw) g[er0 + i][c] = 'eg'; } });
  const nh = Math.max(2, Math.round(eh * 0.35)), nr0 = Math.round(cy - ry * 0.3);
  for (let i = 0; i <= nh; i++) for (let c = 0; c < C; c++) if (Math.abs(c + 0.5 - cx) <= i * 0.9) g[nr0 + i][c] = 'eg';
  const mr0 = Math.round(cy + ry * o.top), mr1 = mr0 + o.rows, mc0 = Math.round(cx - w * o.w / 2), mc1 = Math.round(cx + w * o.w / 2);
  for (let r = mr0; r < mr1; r++) for (let c = mc0; c < mc1; c++) g[r][c] = null;
  for (let c = mc0; c < mc1; c++) { g[mr0 - 1][c] = 'pr'; g[mr1][c] = 'pr'; }
  const tw = o.tooth, gap = o.tooth * 2;
  for (let c = mc0 + gap; c + tw < mc1 - 2; c += tw + gap) for (let k = 0; k < tw; k++) for (let i = 0; i < o.teeth; i++) { if (k >= i && k < tw - i) g[mr0 + i][c + k] = 'pb'; }
  for (let c = mc0 + Math.round(gap * 1.5) + tw; c + tw < mc1 - 2; c += tw + gap) for (let k = 0; k < tw; k++) for (let i = 0; i < o.teeth; i++) { if (k >= i && k < tw - i) g[mr1 - 1 - i][c + k] = 'pb'; }
  return { C: C, R: R, mouth: { c0: mc0, c1: mc1, r0: mr0, r1: mr1 }, layers: layers(g, {
    pb: { ch: '▓', color: ORANGE, op: 0.95 }, pr: { ch: '▒', color: ORANGE, op: 0.55 }, eg: { ch: '█', color: '#F2D27A', op: 1 }, st: { ch: '▌', color: GOLD, op: 0.85 } }) };
}
// LORE as 5x5 block letters, each pixel two cells wide, with an orange drop shadow
function wordmark(){
  const F = { L: ['#    ', '#    ', '#    ', '#    ', '#####'], O: [' ### ', '#   #', '#   #', '#   #', ' ### '], R: ['#### ', '#   #', '#### ', '#  # ', '#   #'], E: ['#####', '#    ', '#### ', '#    ', '#####'] };
  const word = 'LORE', C = word.length * 12 + 2, R = 6, g = grid(C, R);
  word.split('').forEach((ch, i) => F[ch].forEach((row, r) => row.split('').forEach((p, k) => { if (p === '#') { const c = i * 12 + k * 2; [0, 1].forEach(d => { if (!g[r + 1][c + d + 1]) g[r + 1][c + d + 1] = 's'; g[r][c + d] = 'f'; }); } })));
  return layers(g, { s: { ch: '▓', color: ORANGE, op: 0.9 }, f: { ch: '█', color: CREAM, op: 1 } });
}
// ---- end shared ----
if (typeof module !== 'undefined') module.exports = { eldric, scene, pumpkin };
