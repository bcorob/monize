import type { RawImage } from './document-scan.types';

/**
 * Quarter turns, applied to pixels that are already enhanced.
 *
 * Rotation used to be part of the scanning pipeline: the worker re-warped the
 * source photo and re-ran the enhancement for every quarter turn. On a 12 MP
 * photo that is measured at ~7.7 seconds, of which the enhancement alone is
 * ~6.1 -- so each press of Rotate cost the user several seconds, and pressing
 * it four times queued half a minute of work to arrive at the image they
 * started from.
 *
 * None of that work depends on the angle. A quarter turn is a permutation of
 * pixels that are already computed, so it belongs here: no OpenCV, no worker,
 * no round trip, and cheap enough to run during a click.
 *
 * It is used for BOTH the preview and the file that is uploaded, which is what
 * keeps "the image you approved is the image that is stored" literally true
 * (`I3`) -- a CSS transform on the preview would look the same and store
 * something else.
 */

/** Clockwise quarter turns. */
export type QuarterTurns = 0 | 1 | 2 | 3;

/** The size an image has after turning it. */
export function rotatedSize(
  image: { width: number; height: number },
  turns: QuarterTurns,
): { width: number; height: number } {
  return turns % 2 === 0
    ? { width: image.width, height: image.height }
    : { width: image.height, height: image.width };
}

/**
 * Turn an image clockwise by whole quarter turns.
 *
 * Pixels move as 32-bit words rather than four bytes each: the source and
 * destination are both RGBA, so a whole pixel is one element copy, and the
 * loop runs about four times fewer iterations for the same work.
 */
export function rotateImage(image: RawImage, turns: QuarterTurns): RawImage {
  if (turns === 0) return image;

  const { width, height } = image;
  const size = rotatedSize(image, turns);
  const source = new Uint32Array(
    image.data.buffer,
    image.data.byteOffset,
    width * height,
  );
  const target = new Uint32Array(size.width * size.height);

  for (let y = 0; y < height; y++) {
    const rowStart = y * width;
    for (let x = 0; x < width; x++) {
      // Where this pixel lands, per turn. Derived rather than looked up so the
      // three cases are visibly the same transform applied 1, 2 and 3 times.
      let tx: number;
      let ty: number;
      if (turns === 1) {
        tx = height - 1 - y;
        ty = x;
      } else if (turns === 2) {
        tx = width - 1 - x;
        ty = height - 1 - y;
      } else {
        tx = y;
        ty = width - 1 - x;
      }
      target[ty * size.width + tx] = source[rowStart + x];
    }
  }

  return {
    width: size.width,
    height: size.height,
    data: new Uint8ClampedArray(target.buffer),
  };
}
