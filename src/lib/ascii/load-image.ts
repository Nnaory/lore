/**
 * Read an image file into pixels (browser only).
 *
 * The image is decoded on the device, centre-cropped to a square, and
 * scaled down onto a small canvas — enough detail for ASCII art, and the
 * original file is never stored or uploaded.
 */

import type { PixelSource } from "./image-to-ascii";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export class ImageReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageReadError";
  }
}

/** Decodes an image file into square RGBA pixels. Injectable for tests. */
export type ReadImagePixels = (file: File) => Promise<PixelSource>;

/** Pixels of `file`, centre-cropped to a square of `size` × `size`. */
export async function readImagePixels(file: File, size = 160): Promise<PixelSource> {
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
    throw new ImageReadError("Choose a PNG, JPG, WebP or GIF image.");
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new ImageReadError("This image is larger than 10 MB. Choose a smaller one.");
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ImageReadError("This image could not be opened. It may be damaged.");
  }

  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new ImageReadError("This browser cannot read images here.");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
    const { data, width, height } = ctx.getImageData(0, 0, size, size);
    return { data, width, height };
  } finally {
    bitmap.close();
  }
}
