import { describe, expect, it } from "vitest";
import { asciiRows, DEFAULT_RAMP, imageToAscii, type PixelSource } from "@/lib/ascii/image-to-ascii";

/** An image whose pixel (x, y) has grey level `grey(x, y)` and alpha `alpha(x, y)`. */
function image(
  width: number,
  height: number,
  grey: (x: number, y: number) => number,
  alpha: (x: number, y: number) => number = () => 255
): PixelSource {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const g = grey(x, y);
      data.set([g, g, g, alpha(x, y)], i);
    }
  }
  return { width, height, data };
}

describe("asciiRows", () => {
  it("corrects for tall monospace cells", () => {
    expect(asciiRows(100, 100, 30)).toBe(18); // 30 × 0.6
    expect(asciiRows(200, 100, 40, 0.5)).toBe(10);
    expect(asciiRows(1000, 1, 10)).toBe(1); // never zero rows
  });
});

describe("imageToAscii", () => {
  it("produces a grid of the requested width", () => {
    const art = imageToAscii(image(64, 64, (x) => x * 4), { columns: 20 });
    const lines = art.split("\n");
    expect(lines).toHaveLength(asciiRows(64, 64, 20));
    for (const line of lines) expect(line).toHaveLength(20);
  });

  it("maps dark to blank and bright to dense characters", () => {
    const art = imageToAscii(image(40, 10, (x) => (x < 20 ? 0 : 255)), { columns: 2, cellAspect: 0.5 });
    expect(art).toBe(" @");
  });

  it("spreads a gradient across the whole ramp", () => {
    const art = imageToAscii(image(100, 1, (x) => 60 + x), { columns: 10, cellAspect: 0.1 });
    expect(art[0]).toBe(DEFAULT_RAMP[0]);
    expect(art.at(-1)).toBe(DEFAULT_RAMP.at(-1));
    // Monotonic: each character is at least as dense as the one before.
    const indexes = [...art].map((c) => DEFAULT_RAMP.indexOf(c));
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });

  it("inverts on request", () => {
    const art = imageToAscii(image(40, 10, (x) => (x < 20 ? 0 : 255)), { columns: 2, cellAspect: 0.5, invert: true });
    expect(art).toBe("@ ");
  });

  it("treats transparent pixels as the background", () => {
    // White everywhere, but the left half is fully transparent → dark stage.
    const art = imageToAscii(
      image(40, 10, () => 255, (x) => (x < 20 ? 0 : 255)),
      { columns: 2, cellAspect: 0.5 }
    );
    expect(art).toBe(" @");
  });

  it("does not stretch a flat image into noise", () => {
    const art = imageToAscii(image(10, 10, () => 0), { columns: 5 });
    expect(art.replace(/\n/g, "").trim()).toBe("");
  });

  it("supports a custom ramp", () => {
    const art = imageToAscii(image(40, 10, (x) => (x < 20 ? 0 : 255)), { columns: 2, cellAspect: 0.5, ramp: "_#" });
    expect(art).toBe("_#");
  });

  it("rejects mismatched pixel data and too-short ramps", () => {
    expect(() => imageToAscii({ width: 4, height: 4, data: new Uint8ClampedArray(8) }, { columns: 2 })).toThrow(RangeError);
    expect(() => imageToAscii(image(4, 4, () => 0), { columns: 2, ramp: "#" })).toThrow(RangeError);
  });
});
