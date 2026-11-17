/**
 * The shared world a species lives in: a population that crosses the screen
 * along one course, re-entering upstream once it leaves downstream.
 *
 * Size stands in for distance. Each creature gets a fixed random roll that
 * maps to a depth (0 far → 1 near) through the tuning; depth scales its size
 * and speed (parallax) and how far it fades into the background. The list
 * stays sorted far → near, so near creatures draw over far ones.
 *
 * What a species does with that (bob, flicker, rock…) lives in its Species
 * definition; the helpers here cover the steering they share.
 *
 * Adapted from ascii-animals (MIT, see ./LICENSE): the tweak-panel knobs,
 * pinned counts and tap handling are left out.
 */
import type { RGB } from "./ink";
import { clamp, rand } from "./math";
import type { Pen } from "./renderer";

export interface Creature {
  id: number;
  /** Fixed per creature; depth is derived from it with the tuning. */
  roll: number;
  /** 0 far / faded → 1 near / vivid. */
  depth: number;
  /** Size of this creature in px (whatever its shape is measured in). */
  span: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  heading: number;
  /** Personal deviation from the course, -1 → 1 (scaled by tuning.spread). */
  bias: number;
  startledUntil: number;
  /** Removed from the flock; anyone holding a reference should let go. */
  gone: boolean;
}

/** Knobs every species has. Each species' defaults start from these. */
export const SHARED_TUNING = {
  // Movement
  /** Individuals per screen, relative to the area-based default. */
  density: 1,
  /** Cross corner to corner (bottom-left → top-right) whatever the screen shape. */
  corner: false,
  /** Course in degrees when not corner to corner: 0 → right, 90 → up. */
  direction: 49,
  speed: 1,
  /** How far the whole stream sways off course, radians. */
  sway: 0.04,
  /** How far each individual's own course can differ from the stream's, radians. */
  spread: 0.06,
  /** Size multiplier. */
  size: 1,
  /** Depth of the farthest individuals (1 = everyone equally near). */
  farthest: 0.45,
  /** >1 puts more of the population far away; <1 brings it close. */
  farBias: 1.6,
  /** How tightly individuals hold their course. */
  grip: 2,
  /** Push between neighbours at the same depth. */
  separation: 300,

  // Look
  /** Chance a plain cell glints; it is a third of this. */
  sparkle: 0.12,
  /** How much the farthest individuals fade into the background. */
  fog: 0.75,
  /** How much they leave in the trail. */
  trail: 1,
  /** How fast the trail fades, per second. */
  trailFade: 1.3,
  /** Grid line strength. */
  grid: 1.05,
  /** ASCII resolution: higher means smaller cells. */
  detail: 1.3,
};

export type Tuning = typeof SHARED_TUNING;

export interface Species<C extends Creature> {
  key: string;
  defaults: Tuning;
  /** Screen area per individual at density 1 on a laptop-sized screen (see REFERENCE_SIZE), px². */
  area: number;
  /** Most individuals the flock will hold. */
  max?: number;
  /** Size of the nearest at size 1, relative to the shared base (a fifth of the screen's short side). */
  scale: number;
  /** Cruising speed of the nearest at speed 1, px/s. */
  speed: number;
  /** Colour of what it sheds into the trail. */
  trail: RGB;

  /** Add this species' own fields to a fresh creature. */
  create(c: Creature, flock: Flock<C>): C;
  /** A creature has just been placed at the upstream edge (or anywhere, when seeding). */
  enter?(c: C, flock: Flock<C>): void;
  /** Once per step, before any individual moves. */
  prepare?(flock: Flock<C>, dt: number): void;
  update(c: C, flock: Flock<C>, dt: number): void;
  /** React to a click; (dx, dy) points away from it and strength fades 1 → 0 with distance. */
  startle?(c: C, dx: number, dy: number, strength: number, flock: Flock<C>): void;
  /** Draw one creature. */
  draw?(c: C, pen: Pen, flock: Flock<C>): void;
  /** Draw the whole flock at once instead (e.g. to add ambient specks under it). */
  drawAll?(flock: Flock<C>, pen: Pen): void;
}

export interface WorldEvent {
  x: number;
  y: number;
  /** In cells. */
  radius: number;
  amount: number;
}

const STARTLE_RADIUS = 240;
/**
 * Size of the nearest individuals (before a species' own scale) on a
 * laptop-sized screen, about 800px on the short side, px. Populations are tuned
 * at this size; smaller screens draw everyone smaller and spawn more to cover
 * the same share of the screen.
 */
const REFERENCE_SIZE = 160;

export class Flock<C extends Creature> {
  width = 0;
  height = 0;
  time = 0;
  creatures: C[] = [];
  events: WorldEvent[] = [];
  /** Size of the nearest individuals at size 1, px. */
  base = 120;
  /** Scratch acceleration the steering helpers add into. */
  readonly acc = { x: 0, y: 0 };

  private nextId = 1;

  constructor(
    readonly species: Species<C>,
    readonly tuning: Tuning,
  ) {}

  resize(width: number, height: number) {
    const first = this.width === 0;
    this.width = width;
    this.height = height;
    this.base = clamp(Math.min(width, height) * 0.2, 80, 190) * this.species.scale;
    if (first) this.populate(true);
  }

  /** Course in radians (screen space, y down). */
  get course() {
    const k = this.tuning;
    return k.corner ? Math.atan2(-this.height, this.width) : (-k.direction * Math.PI) / 180;
  }

  /** The course with the whole stream's slow sway applied. */
  get heading() {
    const t = this.time;
    return this.course + this.tuning.sway * (Math.sin(t * 0.13) + 0.5 * Math.sin(t * 0.31 + 1.7));
  }

  /**
   * How many to keep on screen, by how much of the screen they cover rather
   * than raw area: on a small screen each one draws smaller (see base), so
   * more of them spawn, and a phone looks as lively as a laptop.
   */
  get target() {
    const { width: W, height: H, species } = this;
    const shrink = (this.base / species.scale / REFERENCE_SIZE) ** 2;
    return clamp(Math.round(((W * H) / (species.area * shrink)) * this.tuning.density), 1, species.max ?? 200);
  }

  depthOf(roll: number) {
    const k = this.tuning;
    return k.farthest + (1 - k.farthest) * Math.pow(roll, k.farBias);
  }

  /** Parallax: far individuals cover less screen per second. */
  cruise(c: Creature) {
    return this.species.speed * (0.55 + 0.45 * c.depth) * this.tuning.speed;
  }

  /** Click: everything nearby reacts, then rejoins the stream. */
  startle(x: number, y: number) {
    this.events.push({ x, y, radius: 6, amount: 1.4 });
    for (const c of this.creatures) {
      const dx = c.x - x;
      const dy = c.y - y;
      const d = Math.hypot(dx, dy) || 1;
      if (d > STARTLE_RADIUS) continue;
      const strength = 1 - d / STARTLE_RADIUS;
      if (this.species.startle) {
        this.species.startle(c, dx / d, dy / d, strength, this);
      } else {
        const k = strength * 420 * c.depth;
        c.vx += (dx / d) * k;
        c.vy += (dy / d) * k;
        c.startledUntil = this.time + rand(0.6, 1.2);
      }
    }
  }

  step(dt: number) {
    this.time += dt;
    this.populate(false);
    for (const c of this.creatures) {
      c.depth = this.depthOf(c.roll);
      c.span = this.base * c.depth * this.tuning.size;
    }
    this.species.prepare?.(this, dt);
    for (const c of this.creatures) this.species.update(c, this, dt);
  }

  /** Add or remove individuals until the population matches the tuning. */
  private populate(scatter: boolean) {
    const target = this.target;
    while (this.creatures.length > target) {
      const [c] = this.creatures.splice(Math.floor(Math.random() * this.creatures.length), 1);
      c.gone = true;
    }
    while (this.creatures.length < target) {
      const c = this.spawn();
      if (scatter || Math.random() < 0.5) {
        // Seeding (or growing the flock): drop it in anywhere so the screen fills at once.
        c.x = rand(0, this.width);
        c.y = rand(0, this.height);
        this.species.enter?.(c, this);
      }
      this.insert(c);
    }
  }

  /** Keep farther individuals first so the near ones draw over them. */
  insert(c: C) {
    const at = this.creatures.findIndex((o) => o.roll > c.roll);
    this.creatures.splice(at < 0 ? this.creatures.length : at, 0, c);
  }

  private spawn(): C {
    const base: Creature = {
      id: this.nextId++,
      roll: Math.random(),
      depth: 1,
      span: 0,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      heading: 0,
      bias: 0,
      startledUntil: 0,
      gone: false,
    };
    base.depth = this.depthOf(base.roll);
    base.span = this.base * base.depth * this.tuning.size;
    const c = this.species.create(base, this);
    this.reenter(c);
    return c;
  }

  /** Bring a creature back in from the upstream edges, spread evenly across the flow. */
  reenter(c: C) {
    const { width: W, height: H, course } = this;
    const m = c.span * 0.6;
    const cos = Math.cos(course);
    const sin = Math.sin(course);
    // Upstream edges: the side the stream comes from, weighted by how much of it crosses each.
    const sideways = H * Math.abs(cos);
    const vertical = W * Math.abs(sin);
    if (Math.random() * (sideways + vertical) < sideways) {
      c.x = cos >= 0 ? -m : W + m;
      c.y = rand(0, H);
    } else {
      c.x = rand(0, W);
      c.y = sin <= 0 ? H + m : -m;
    }
    const cruise = this.cruise(c);
    c.heading = course;
    c.vx = cos * cruise;
    c.vy = sin * cruise;
    c.bias = rand(-1, 1);
    this.species.enter?.(c, this);
  }

  /** Past the downstream edges (done crossing), or lost far off any edge. */
  passed(c: Creature, margin = c.span) {
    const { width: W, height: H, course } = this;
    const cos = Math.cos(course);
    const sin = Math.sin(course);
    const out =
      (cos > 0.05 && c.x > W + margin) ||
      (cos < -0.05 && c.x < -margin) ||
      (sin < -0.05 && c.y < -margin) ||
      (sin > 0.05 && c.y > H + margin);
    const lost = c.x < -3 * margin || c.x > W + 3 * margin || c.y < -3 * margin || c.y > H + 3 * margin;
    return out || lost;
  }

  // ── steering helpers: each adds into this.acc ─────────────────────

  /** Clear the scratch acceleration. */
  begin() {
    this.acc.x = 0;
    this.acc.y = 0;
    return this.acc;
  }

  /** Pull the velocity toward `speed` along `dir`, as hard as `grip`. */
  steer(c: Creature, dir: number, speed: number, grip: number) {
    this.acc.x += (Math.cos(dir) * speed - c.vx) * grip;
    this.acc.y += (Math.sin(dir) * speed - c.vy) * grip;
  }

  /** Push away from neighbours at about the same depth, within `range` × their combined size. */
  separate(c: Creature, strength = this.tuning.separation, range = 0.42) {
    if (strength <= 0) return;
    for (const o of this.creatures) {
      if (o === c || Math.abs(o.depth - c.depth) > 0.18) continue;
      const ox = c.x - o.x;
      const oy = c.y - o.y;
      const d = Math.hypot(ox, oy);
      const r = (c.span + o.span) * range;
      if (d < r && d > 1e-3) {
        const w = (1 - d / r) * strength;
        this.acc.x += (ox / d) * w;
        this.acc.y += (oy / d) * w;
      }
    }
  }

  /** Apply this.acc, cap the speed (startled creatures may go faster), move. Returns the speed. */
  move(c: Creature, dt: number, max: number) {
    c.vx += this.acc.x * dt;
    c.vy += this.acc.y * dt;
    let speed = Math.hypot(c.vx, c.vy);
    const cap = max + (this.time < c.startledUntil ? 300 : 0);
    if (speed > cap) {
      c.vx *= cap / speed;
      c.vy *= cap / speed;
      speed = cap;
    }
    c.x += c.vx * dt;
    c.y += c.vy * dt;
    return speed;
  }
}
