/**
 * Jack-o'-lanterns floating across a Halloween night, in the Trick-or-Treat
 * palette (Bright Pumpkin, Candy Corn Yellow, Candy Apple Red, Grape Purple
 * and Licorice Black).
 *
 * Each pumpkin drifts with the stream, bobbing and rocking gently. A candle
 * inside flickers on its own clock, so the carved face glows brighter and
 * dimmer and sends embers up into the trail; now and then a draught nearly
 * puts it out. A click nearby startles them: they are pushed away and spin,
 * the candle flares, and the face gapes for a moment before it settles.
 *
 *   body   five lobes side by side, shaded round, with dark ribs between
 *          them (kept clear of the face) and a dip where the stem sits
 *   stem   a short dark stalk leaning off the top
 *   face   carved eyes, nose and a toothy grin, lit from within and edged
 *          by the dark cut, so it reads even at a few cells across (three
 *          faces: classic triangles, a scowl, round eyes)
 *   halo   faint candlelight spilling around it
 *   motes  grape-purple dust and the odd candy-corn spark drifting upward
 *
 * Body coordinates: u runs right and v runs down, in fractions of the span,
 * and the pose's heading is the rock angle, so the pumpkins stay upright.
 */
import { SHARED_TUNING, type Creature, type Flock, type Species } from "./flock";
import { INK_DARK, INK_GLOW, INK_SCALE, ink, type RGB } from "./ink";
import { clamp, hash3, rand, TAU } from "./math";
import type { FieldPalette, Pen, Pose } from "./renderer";

export interface Pumpkin extends Creature {
  /** Bob phase, radians. */
  bob: number;
  /** Rock angle (radians) and its angular velocity. */
  tilt: number;
  spin: number;
  /** When a click last flared the candle; -Infinity until one does. */
  flaredAt: number;
  /** 0 classic triangles, 1 scowl, 2 round eyes. */
  face: number;
  /** Height multiplier: below 1 squat, above 1 tall. */
  squat: number;
}

/** The night behind them: Licorice Black with a faint grape-purple grid. */
export const HALLOWEEN_NIGHT: FieldPalette = {
  background: [34, 34, 34],
  grid: [150, 110, 200, 0.07],
  trailAlpha: 0.85,
};

const DEFAULTS = {
  ...SHARED_TUNING,
  direction: 16,
  sway: 0.05,
  spread: 0.12,
  farthest: 0.32,
  farBias: 1.5,
  grip: 1.2,
  separation: 260,
  sparkle: 0.05,
  fog: 0.72,
  trail: 1.2,
  trailFade: 1.1,
  grid: 1,
  detail: 1.7,
};

const SKIN: RGB = [246, 137, 40]; // Bright Pumpkin
const SHADE: RGB = [150, 52, 34]; // toward Candy Apple Red, in shadow
const SHEEN: RGB = [246, 200, 78]; // Candy Corn Yellow, where the moonlight catches it
const RIB: RGB = [136, 46, 26];
const CUT: RGB = [96, 34, 16]; // the dark wall of a carved hole
const STEM: RGB = [84, 62, 36];
const FLAME: RGB = [246, 200, 78]; // Candy Corn Yellow
const HOT: RGB = [255, 240, 196]; // the candle's white-hot core
const HALO: RGB = [246, 137, 40];
const DUST: RGB = [116, 67, 168]; // Grape Purple
const SPARK: RGB = [246, 200, 78];

/** Lobes from left to right: [centre u, half-width, share of the full half-height]. */
const LOBES: Array<[number, number, number]> = [
  [-0.3, 0.14, 0.74],
  [-0.16, 0.155, 0.9],
  [0, 0.165, 1],
  [0.16, 0.155, 0.9],
  [0.3, 0.14, 0.74],
];
/** Half-height of the middle lobe at squat 1, in spans. */
const HALF_HEIGHT = 0.31;
/** Width of the dark cut around each carved hole, and how far ribs keep clear of the face, in spans. */
const CUT_WIDTH = 0.022;
const RIB_CLEARANCE = 0.06;
/** Screen area per mote of dust, px². */
const MOTE_AREA = 9000;

const mix = (a: RGB, b: RGB, f: number): RGB => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];

/** Inside the ellipse centred on (cu, cv) with half-axes a and b, grown by g? */
function inEllipse(u: number, v: number, cu: number, cv: number, a: number, b: number, g = 0) {
  const x = (u - cu) / (a + g);
  const y = (v - cv) / (b + g);
  return x * x + y * y <= 1;
}

/** Distance from (u, v) to the segment a → b. */
function toSegment(u: number, v: number, au: number, av: number, bu: number, bv: number) {
  const su = bu - au;
  const sv = bv - av;
  const t = clamp(((u - au) * su + (v - av) * sv) / (su * su + sv * sv || 1), 0, 1);
  return Math.hypot(u - au - su * t, v - av - sv * t);
}

/** Inside the triangle abc, or within g of its edges? */
function inTriangle(u: number, v: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number, g = 0) {
  // Most samples are nowhere near the face: reject on the bounding box first.
  if (u < Math.min(ax, bx, cx) - g || u > Math.max(ax, bx, cx) + g || v < Math.min(ay, by, cy) - g || v > Math.max(ay, by, cy) + g) {
    return false;
  }
  const d1 = (u - bx) * (ay - by) - (ax - bx) * (v - by);
  const d2 = (u - cx) * (by - cy) - (bx - cx) * (v - cy);
  const d3 = (u - ax) * (cy - ay) - (cx - ax) * (v - ay);
  const negative = d1 < 0 || d2 < 0 || d3 < 0;
  const positive = d1 > 0 || d2 > 0 || d3 > 0;
  if (!(negative && positive)) return true;
  if (g <= 0) return false;
  return Math.min(toSegment(u, v, ax, ay, bx, by), toSegment(u, v, bx, by, cx, cy), toSegment(u, v, cx, cy, ax, ay)) <= g;
}

/** What the face has at a point: nothing, a carved hole, or a tooth left standing in the grin. */
const NONE = 0;
const HOLE = 1;
const TOOTH = 2;

/**
 * What the face has at (u, y). `y` is v over the pumpkin's height, so the face
 * stretches with it; `g` grows the holes (and shrinks the teeth), to find the
 * dark cut around them. A startled pumpkin gapes: round eyes and an O.
 */
function faceAt(face: number, u: number, y: number, gape: boolean, g = 0) {
  const au = Math.abs(u);
  if (gape) return inEllipse(au, y, 0.14, -0.06, 0.06, 0.085, g) || inEllipse(u, y, 0, 0.17, 0.085, 0.095, g) ? HOLE : NONE;

  const eye =
    face === 2
      ? inEllipse(au, y, 0.14, -0.06, 0.065, 0.075, g)
      : face === 1
        ? inTriangle(au, y, 0.06, 0, 0.23, 0, 0.22, -0.15, g) // brows slanting down to the nose
        : inTriangle(au, y, 0.06, 0, 0.23, 0, 0.145, -0.15, g);
  if (eye) return HOLE;
  if (inTriangle(u, y, -0.04, 0.08, 0.04, 0.08, 0, 0.028, g)) return HOLE;

  // The grin: a crescent, thickest in the middle.
  if (au > 0.28 + g) return NONE;
  const k = Math.max(0, 1 - (u / 0.28) ** 2);
  const top = 0.105 + 0.05 * k;
  const bottom = 0.125 + 0.15 * k;
  if (y < top - g || y > bottom + g) return NONE;
  // Teeth: two hanging from the top (not on the round-eyed face), one standing up from the bottom.
  if (face !== 2 && Math.abs(au - 0.1) < 0.03 - g && y < top + 0.05 - g) return TOOTH;
  if (au < 0.032 - g && y > bottom - 0.055 + g) return TOOTH;
  return HOLE;
}

/**
 * How bright the candle burns: a quick shimmer on a slower waver, a dip now
 * and then as if in a draught, and a flare that fades after a click.
 */
function flameOf(p: Pumpkin, t: number) {
  const id = p.id;
  const flicker = 0.08 * Math.sin(t * 13.7 + id * 1.9) + 0.06 * Math.sin(t * 7.3 + id * 0.7) + 0.05 * Math.sin(t * 23.1 + id * 3.3);
  const draught = 0.35 * Math.max(0, Math.sin(t * 0.43 + id * 2.1)) ** 8;
  const flare = Math.exp(-(t - p.flaredAt) * 2.2);
  return clamp(0.82 + flicker - draught + 0.9 * flare, 0.3, 1.8);
}

const at = { x: 0, y: 0 };

export const pumpkins: Species<Pumpkin> = {
  key: "pumpkins",
  defaults: DEFAULTS,
  area: 130000,
  max: 20,
  scale: 1.8,
  speed: 38,
  trail: [246, 137, 40],

  create: (c) => ({
    ...c,
    bob: rand(0, TAU),
    tilt: 0,
    spin: 0,
    flaredAt: -Infinity,
    face: Math.floor(rand(0, 3)),
    squat: rand(0.85, 1.1),
  }),

  update(p, flock, dt) {
    const k = flock.tuning;
    p.bob += dt * (1.1 + 0.5 * p.roll);
    // Rocking: a damped spring toward a slow sway, so a startled spin settles back upright.
    const rest = 0.08 * Math.sin(p.bob * 0.5 + p.id);
    p.spin += ((rest - p.tilt) * 10 - p.spin * 2.4) * dt;
    p.tilt += p.spin * dt;

    const cruise = flock.cruise(p);
    flock.begin();
    flock.steer(p, flock.heading + p.bias * k.spread, cruise, k.grip);
    flock.separate(p);
    flock.move(p, dt, cruise * 1.5);
    if (flock.passed(p, p.span)) flock.reenter(p);
  },

  startle(p, dx, dy, strength, flock) {
    const push = strength * 320 * p.depth;
    p.vx += dx * push;
    p.vy += dy * push;
    p.spin += (dx < 0 ? -1 : 1) * (1.5 + 2 * strength);
    p.flaredAt = flock.time;
    p.startledUntil = flock.time + rand(0.6, 1);
  },

  drawAll(flock, pen) {
    drawMotes(flock, pen);
    for (const p of flock.creatures) drawPumpkin(p, pen);
  },
};

function drawPumpkin(p: Pumpkin, pen: Pen) {
  const t = pen.t;
  const S = p.span;
  const sq = p.squat;
  const pose: Pose = { x: p.x, y: p.y + Math.sin(p.bob) * 0.05 * S, heading: p.tilt, span: S, depth: p.depth, id: p.id };
  const flame = flameOf(p, t);
  const flare = Math.exp(-(t - p.flaredAt) * 2.2);
  const gape = t - p.flaredAt < 1.1;
  const base = pen.fogFor(p.depth);
  const out = pen.ink;
  const top = HALF_HEIGHT * sq;

  // Candlelight spilling around it, brighter while the candle burns high.
  pen.shape(
    pose,
    0.6,
    (u, v) => inEllipse(u, v, 0, 0, 0.52, top + 0.08) && ink(out, ...HALO, INK_GLOW, "."),
    { fog: clamp(base + 0.52 - 0.28 * Math.min(flame, 1.5), 0, 0.95) },
  );

  const light = mix(FLAME, HOT, clamp(0.25 + (flame - 0.8) * 1.2, 0, 1));
  const glow = 0.68 + 0.36 * flame;

  pen.shape(
    pose,
    0.56,
    (u, v) => {
      // The stem rises out of the top, leaning a little to the right.
      if (v < -0.2 * sq && toSegment(u, v, 0, -0.26 * sq, 0.05, -0.41 * sq) < 0.03) {
        return ink(out, ...STEM, INK_DARK, "/|");
      }

      // Which lobe is this point most inside, and how close is the next one?
      let e1 = Infinity;
      let e2 = Infinity;
      let best = 0;
      for (let i = 0; i < LOBES.length; i++) {
        const [cu, a, share] = LOBES[i];
        const x = (u - cu) / a;
        const y = v / (top * share);
        const e = x * x + y * y;
        if (e < e1) {
          e2 = e1;
          e1 = e;
          best = i;
        } else if (e < e2) {
          e2 = e;
        }
      }
      if (e1 > 1) return false;
      // A dip in the top where the stem sits.
      if (Math.abs(u) < 0.06 && v < -0.86 * top) return false;

      // The face. Holes are dark here (the glowing pass below lights them), and so is the cut
      // around them; teeth stay skin, and the ribs keep clear of it all.
      const y = v / sq;
      const at0 = faceAt(p.face, u, y, gape);
      if (at0 === HOLE || (at0 === NONE && faceAt(p.face, u, y, gape, CUT_WIDTH) === HOLE)) {
        return ink(out, ...CUT, INK_SCALE, " ");
      }
      const clearOfFace = at0 === NONE && faceAt(p.face, u, y, gape, RIB_CLEARANCE) === NONE;

      // Ribs where two lobes meet, curving with them.
      if (clearOfFace && e2 - e1 < 0.16) return ink(out, ...RIB, INK_SCALE, u < 0 ? "(" : ")");

      // Skin: shaded round across each lobe, lit from the upper left, darker underneath;
      // the outer lobes turn away from the light.
      const [cu, a, share] = LOBES[best];
      const x = (u - cu) / a;
      const ly = v / (top * share);
      let shade = 0.5 + 0.5 * Math.sqrt(Math.max(0, 1 - x * x));
      shade *= 1 - 0.06 * x - 0.05 * ly;
      shade *= 1 - 0.3 * Math.max(0, ly) ** 2;
      shade *= best === 2 ? 1 : best === 1 || best === 3 ? 0.93 : 0.84;
      const c = shade > 1.04 ? mix(SKIN, SHEEN, Math.min(1, (shade - 1.04) * 4)) : mix(SHADE, SKIN, Math.min(1, shade));
      return ink(out, c[0], c[1], c[2], INK_SCALE, "  .");
    },
    { light: 1 + 0.12 * flare },
  );

  // The carved holes, lit by the candle. Light carries through the night, so they fade far less
  // with distance than the skin; partly covered cells keep the dark cut drawn above.
  pen.shape(
    pose,
    0.36,
    (u, v) =>
      faceAt(p.face, u, v / sq, gape) === HOLE &&
      ink(out, Math.min(255, light[0] * glow), Math.min(255, light[1] * glow), Math.min(255, light[2] * glow), INK_SCALE, " "),
    { fog: base * 0.3 },
  );

  // Embers rising from the candle through the top.
  pen.toWorld(pose, 0.02, -0.33 * sq, at);
  pen.shed(at.x, at.y, 0.02 * p.depth * flame);
}

/** Grape-purple dust and the odd candy-corn spark, drifting up through the night and twinkling. */
function drawMotes(flock: Flock<Pumpkin>, pen: Pen) {
  const { width: W, height: H } = flock;
  const n = Math.round((W * H) / MOTE_AREA);
  const t = pen.t;
  for (let i = 0; i < n; i++) {
    const rise = 4 + 10 * hash3(i, 3, 2);
    const x = hash3(i, 1, 2) * W + Math.sin(t * 0.3 + i) * 8;
    const y = (((hash3(i, 2, 2) * H - t * rise) % H) + H) % H;
    const twinkle = 0.5 + 0.5 * Math.sin(t * (0.7 + 1.5 * hash3(i, 4, 2)) + i);
    const spark = hash3(i, 5, 2) > 0.93;
    pen.dot(x, y, spark ? "*" : ".", spark ? SPARK : DUST, 1, Math.min(0.95, 0.25 + 0.5 * (1 - twinkle) + (spark ? 0.05 : 0)));
  }
}
