import { describe, expect, it } from 'vitest';

import { rotateImage, rotatedSize, type QuarterTurns } from './rotate-image';
import type { RawImage } from './document-scan.types';

/**
 * Quarter turns on finished pixels.
 *
 * This replaced a rotation that re-ran the scanning pipeline -- measured at
 * ~7.7 seconds per press on a 12 MP photo, and queueing if pressed again. What
 * has to be true of the replacement is that it is the SAME picture turned: the
 * uploaded file is produced from this, so an axis flipped here is a document
 * stored mirrored.
 */

/** An image whose every pixel is identifiable, so a wrong axis cannot hide. */
function gradient(width: number, height: number): RawImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      data[offset] = x * 10 + 1;
      data[offset + 1] = y * 10 + 1;
      data[offset + 2] = 7;
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
}

/** The RGB of one pixel, for comparing positions across a turn. */
function pixelAt(image: RawImage, x: number, y: number): [number, number, number] {
  const offset = (y * image.width + x) * 4;
  return [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
}

describe('rotatedSize', () => {
  it('swaps the dimensions for quarter turns only', () => {
    const size = { width: 300, height: 200 };
    expect(rotatedSize(size, 0)).toEqual(size);
    expect(rotatedSize(size, 1)).toEqual({ width: 200, height: 300 });
    expect(rotatedSize(size, 2)).toEqual(size);
    expect(rotatedSize(size, 3)).toEqual({ width: 200, height: 300 });
  });
});

describe('rotateImage', () => {
  it('returns the same image untouched for no turn', () => {
    const image = gradient(3, 2);
    expect(rotateImage(image, 0)).toBe(image);
  });

  it('turns clockwise, putting the top-left corner top-right', () => {
    const image = gradient(3, 2);
    const turned = rotateImage(image, 1);

    expect(turned.width).toBe(2);
    expect(turned.height).toBe(3);
    // The source's top-left pixel is now at the top-right.
    expect(pixelAt(turned, turned.width - 1, 0)).toEqual(pixelAt(image, 0, 0));
    // ...and its top-right pixel is at the bottom-right.
    expect(pixelAt(turned, turned.width - 1, turned.height - 1)).toEqual(
      pixelAt(image, image.width - 1, 0),
    );
  });

  it('turns a half circle by mirroring both axes', () => {
    const image = gradient(3, 2);
    const turned = rotateImage(image, 2);

    expect(turned.width).toBe(3);
    expect(turned.height).toBe(2);
    expect(pixelAt(turned, 2, 1)).toEqual(pixelAt(image, 0, 0));
    expect(pixelAt(turned, 0, 0)).toEqual(pixelAt(image, 2, 1));
  });

  it('turns three quarters, putting the top-left corner bottom-left', () => {
    const image = gradient(3, 2);
    const turned = rotateImage(image, 3);

    expect(turned.width).toBe(2);
    expect(turned.height).toBe(3);
    expect(pixelAt(turned, 0, turned.height - 1)).toEqual(pixelAt(image, 0, 0));
  });

  // The user presses Rotate four times and expects to be back where they
  // started -- which is only true if the turns compose exactly.
  it('returns to the original after four turns', () => {
    const image = gradient(5, 3);
    let current = image;
    for (let i = 0; i < 4; i++) current = rotateImage(current, 1);

    expect(current.width).toBe(image.width);
    expect(current.height).toBe(image.height);
    expect(Array.from(current.data)).toEqual(Array.from(image.data));
  });

  it('agrees with applying single turns repeatedly', () => {
    const image = gradient(4, 3);
    const twice = rotateImage(rotateImage(image, 1), 1);
    const thrice = rotateImage(twice, 1);

    expect(Array.from(rotateImage(image, 2).data)).toEqual(
      Array.from(twice.data),
    );
    expect(Array.from(rotateImage(image, 3).data)).toEqual(
      Array.from(thrice.data),
    );
  });

  it('keeps the alpha channel', () => {
    const image = gradient(2, 2);
    image.data[3] = 128;
    const turned = rotateImage(image, 1);
    // The pixel that carried it is at the top-right after a clockwise turn.
    const offset = (0 * turned.width + (turned.width - 1)) * 4;
    expect(turned.data[offset + 3]).toBe(128);
  });

  it('does not alias the source buffer', () => {
    // The result is uploaded and drawn; sharing memory with the pipeline's
    // output would make a later turn corrupt the image it turned from.
    const image = gradient(3, 3);
    const turned = rotateImage(image, 1);
    turned.data[0] = 42;
    expect(image.data[0]).not.toBe(42);
  });

  it.each([1, 2, 3] as QuarterTurns[])(
    'preserves every pixel for turn %i',
    (turns) => {
      const image = gradient(4, 6);
      const turned = rotateImage(image, turns);
      // Same multiset of pixels: a turn moves them, it does not drop or
      // invent any. A blank strip down one edge is the shape of an off-by-one.
      const key = (r: number, g: number, b: number) => `${r},${g},${b}`;
      const before = new Set<string>();
      for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) before.add(key(...pixelAt(image, x, y)));
      }
      const after = new Set<string>();
      for (let y = 0; y < turned.height; y++) {
        for (let x = 0; x < turned.width; x++) after.add(key(...pixelAt(turned, x, y)));
      }
      expect([...after].sort()).toEqual([...before].sort());
    },
  );

  // The whole point of moving rotation off the pipeline. A turn of a
  // full-size scan has to be quick enough to happen during a click.
  it('turns a full-size scan in well under a second', () => {
    const image = gradient(2500, 1800);
    const started = Date.now();
    rotateImage(image, 1);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
