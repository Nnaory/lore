/**
 * Wires a Flock + AsciiRenderer to a canvas: fixed-timestep loop, resizing,
 * click-to-startle, pausing while hidden, and prefers-reduced-motion (one
 * still frame instead of the loop).
 *
 * Browser only. The constructor throws when the canvas has no 2D context or
 * the page lacks ResizeObserver / IntersectionObserver / matchMedia, so
 * callers can fall back to a plain background.
 *
 * Built to live as long as the page: hiding the canvas (display: none) pauses
 * the loop and showing it again resumes where it left off, and a resize never
 * leaves the canvas blank for a frame.
 *
 * Adapted from ascii-animals (MIT, see ./LICENSE): one species per engine,
 * no runtime knob changes.
 */
import { Flock, type Creature, type Species, type Tuning } from "./flock";
import { AsciiRenderer, type FieldPalette } from "./renderer";

const STEP = 1 / 60;
const MAX_STEPS = 4;

export interface EngineOptions {
  /** Overrides for the species' default tuning. */
  tuning?: Partial<Tuning>;
  /** Which pointer-down targets startle the creatures. Default: the canvas itself. */
  startleOn?: (target: EventTarget | null) => boolean;
}

export class AsciiFieldEngine<C extends Creature> {
  private readonly flock: Flock<C>;
  private readonly renderer: AsciiRenderer;
  private readonly startleOn: (target: EventTarget | null) => boolean;
  private readonly reducedMotion: MediaQueryList;
  private readonly resizeObserver: ResizeObserver;
  private readonly intersectionObserver: IntersectionObserver;
  private raf = 0;
  private last = 0;
  private acc = 0;
  private visible = true;
  private disposed = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    species: Species<C>,
    palette: FieldPalette,
    { tuning = {}, startleOn = (target) => target === canvas }: EngineOptions = {},
  ) {
    const k: Tuning = { ...species.defaults, ...tuning };
    this.startleOn = startleOn;
    this.renderer = new AsciiRenderer(canvas, k, palette, species.trail);
    this.renderer.setFontFamily(getComputedStyle(canvas).fontFamily);
    this.flock = new Flock(species, k);
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.intersectionObserver = new IntersectionObserver(([entry]) => {
      this.visible = entry.isIntersecting;
      this.schedule();
    });
    this.intersectionObserver.observe(canvas);

    this.reducedMotion.addEventListener("change", this.onMotionPreference);
    window.addEventListener("pointerdown", this.onPointerDown, { passive: true });

    this.resize();
    // Canvas text can't trigger a webfont load; once the mono face is in, redraw.
    // (The load rejects when a face is missing; the canvas then keeps the fallback.)
    document.fonts
      ?.load(`600 16px ${getComputedStyle(canvas).fontFamily}`)
      .then(() => {
        if (!this.disposed && this.reducedMotion.matches) this.drawStill();
      })
      .catch(() => {});
    this.schedule();
  }

  destroy() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.intersectionObserver.disconnect();
    this.reducedMotion.removeEventListener("change", this.onMotionPreference);
    window.removeEventListener("pointerdown", this.onPointerDown);
  }

  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return; // hidden: keep the last frame and state
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resized = this.renderer.resize(rect.width, rect.height, dpr);
    this.flock.resize(rect.width, rect.height);
    if (!resized) return; // same size (e.g. the canvas was only hidden): the bitmap is still good
    // Resizing clears the canvas. Draw it again now, before the browser paints:
    // waiting for the loop's next frame (with reduced motion, there is none)
    // would leave it blank.
    if (this.reducedMotion.matches) this.drawStill();
    else this.renderer.render(this.flock, 0);
  }

  private schedule() {
    cancelAnimationFrame(this.raf);
    if (this.disposed || !this.visible || this.reducedMotion.matches) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    // The frame time can be a hair older than the moment the loop was scheduled.
    const dt = clampDt((now - this.last) / 1000);
    this.last = now;
    this.acc += dt;
    let steps = 0;
    while (this.acc >= STEP && steps < MAX_STEPS) {
      this.flock.step(STEP);
      this.acc -= STEP;
      steps++;
    }
    if (steps === MAX_STEPS) this.acc = 0;
    this.renderer.render(this.flock, dt);
    this.raf = requestAnimationFrame(this.frame);
  };

  /** Reduced motion: let the creatures spread out, then show a single frame. */
  private drawStill() {
    if (this.flock.time < 4) {
      for (let i = 0; i < 240; i++) this.flock.step(STEP);
    }
    this.renderer.render(this.flock, STEP);
  }

  private onMotionPreference = () => {
    if (this.reducedMotion.matches) {
      cancelAnimationFrame(this.raf);
      this.drawStill();
    } else {
      this.schedule();
    }
  };

  private onPointerDown = (e: PointerEvent) => {
    // While hidden the loop is paused: leave the creatures alone behind the page.
    if (this.reducedMotion.matches || !this.visible || !this.startleOn(e.target)) return;
    const rect = this.canvas.getBoundingClientRect();
    this.flock.startle(e.clientX - rect.left, e.clientY - rect.top);
  };
}

/** Seconds since the last frame, kept between 0 and 0.1 so a long pause doesn't jump the simulation. */
const clampDt = (dt: number) => Math.min(0.1, Math.max(0, dt));
