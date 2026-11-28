/**
 * stage-boxes.test.ts — pins every DESIGN-SYSTEM §4.1/§4.2 number.
 * Why: the boxes are the pixel spec; any drift must fail a test.
 */
import { describe, expect, it } from "vitest";
import { STAGE_BOXES, visibleSprites } from "@/lib/stage/stage-boxes";

describe("STAGE_BOXES desktop (§4.1)", () => {
  const d = STAGE_BOXES.desktop;
  it("matches the spec numbers", () => {
    expect(d.board).toEqual({ width: 1440, height: 900 });
    expect(d.hud).toEqual({ x: 0, y: 0, width: 1440, height: 64 });
    expect(d.stage).toEqual({ x: 0, y: 64, width: 1440, height: 836 });
    expect(d.scene).toEqual({ x: 0, y: 0, cols: 167, rows: 57, fontPx: 14.37 });
    expect(d.canvas).toEqual({ x: 472, y: 14, width: 736, height: 414 });
    expect(d.dialogue).toEqual({
      x: 344,
      y: 614,
      width: 960,
      height: 181,
      nameTagLeft: 96,
      nameTagTop: -18,
    });
    expect(d.sprite).toEqual({
      x: 64,
      y: 260,
      width: 317,
      height: 576,
      cols: 44,
      rows: 48,
      fontPx: 12,
    });
    expect(d.keyHints).toEqual({ y: 806, width: 1440 });
  });
});

describe("STAGE_BOXES phone (§4.2)", () => {
  const p = STAGE_BOXES.phone;
  it("matches the spec numbers", () => {
    expect(p.board).toEqual({ width: 390, height: 844 });
    expect(p.hud).toEqual({ x: 0, y: 0, width: 390, height: 56 });
    expect(p.scene).toEqual({ x: 0, y: 56, cols: 82, rows: 99, fontPx: 8 });
    expect(p.canvas).toEqual({ x: 12, y: 68, width: 366, height: 246 });
    expect(p.sprite).toEqual({
      x: 6,
      y: 318,
      width: 211,
      height: 384,
      cols: 44,
      rows: 48,
      fontPx: 8,
    });
    expect(p.dialogue).toEqual({ x: 12, y: 582, width: 366, height: 250 });
    expect(p.dialoguePuzzle).toEqual({ x: 12, y: 404, width: 366, height: 428 });
  });
});

describe("visibleSprites", () => {
  it("desktop shows active plus other at 0.4", () => {
    expect(visibleSprites("desktop", "a", "b")).toEqual({
      ok: true,
      sprites: [
        { id: "a", role: "active", opacity: 1 },
        { id: "b", role: "other", opacity: 0.4 },
      ],
    });
  });
  it("phone shows only the active speaker", () => {
    const r = visibleSprites("phone", "a", "b");
    expect(r).toEqual({ ok: true, sprites: [{ id: "a", role: "active", opacity: 1 }] });
  });
  it("skips other when same, empty or missing", () => {
    for (const other of ["a", "", null, undefined]) {
      const r = visibleSprites("desktop", "a", other);
      expect(r.ok && r.sprites.length).toBe(1);
    }
  });
  it("fails without an active character", () => {
    for (const active of [null, undefined, ""]) {
      expect(visibleSprites("desktop", active, "b")).toEqual({
        ok: false,
        reason: "no_active_character",
      });
    }
  });
});
