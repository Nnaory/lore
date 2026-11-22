// Re-export frontend/tests/fixtures/ascii-golden.json from the canvas generators
// (reference/generators/*.js — the exact code the design canvas runs).
// Run ONLY after the design itself changed:  node scripts/export-ascii-golden.cjs
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'reference', 'generators');
const a = fs.readFileSync(path.join(dir, 'gen.js'), 'utf8');
const b = fs.readFileSync(path.join(dir, 'figure.js'), 'utf8');
const lib = a.slice(a.indexOf('// ---- shared'), a.indexOf('// ---- end shared')) + b.slice(b.indexOf('// ---- shared figure'), b.indexOf('// ---- end figure'));
const L = new Function(lib + 'return {figure,CAST,scene,pumpkin,jackMouth,wordmark,cauldron};')();
const out = { figure: {}, scene: {}, pumpkin: {}, jackMouth: {}, wordmark: L.wordmark() };
for (const id of Object.keys(L.CAST)) for (const e of ['calm', 'smile', 'worried', 'surprised', 'angry']) out.figure[id + ':' + e] = L.figure(L.CAST[id], e);
out.scene.stageDesktop = L.scene({ seed: 7, cols: 167, rows: 57, horizon: 30, beaconCol: 55, gateCol: 55, moon: [12, 4, 2.6] });
out.scene.stagePhone = L.scene({ seed: 7, cols: 82, rows: 99, horizon: 52, beaconCol: 60, gateCol: 60, moon: [70, 36, 2.2] });
for (const [w, s] of [[12, 2], [14, 5], [16, 4], [16, 7], [18, 2], [20, 8], [22, 6], [26, 9], [30, 11], [34, 3]]) out.pumpkin[w + ':' + s] = L.pumpkin(w, s);
out.jackMouth.desktop = L.jackMouth(130, { top: 0.02, rows: 11, w: 0.64, tooth: 6, teeth: 2 });
out.jackMouth.phone = L.jackMouth(112, { top: -0.06, rows: 14, w: 0.76, tooth: 5, teeth: 2 });
out.cauldron = [0, 1, 2, 3].map((f) => L.cauldron(f));
out.scene.credits = L.scene({ seed: 7, cols: 267, rows: 100, horizon: 74, beaconCol: 200, gateCol: 46, moon: [30, 8, 4] });
out.scene.creditsPhone = L.scene({ seed: 7, cols: 109, rows: 60, horizon: 30, beaconCol: 80, gateCol: 24, moon: [14, 6, 2.6] });
const target = path.join(__dirname, '..', 'frontend', 'tests', 'fixtures', 'ascii-golden.json');
fs.writeFileSync(target, JSON.stringify(out));
console.log('wrote', target);
