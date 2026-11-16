import type { RawImage } from './document-scan.types';

/**
 * Brightness and contrast, applied to pixels that are already finished.
 *
 * The automatic enhancement is tuned for a printed page under ordinary light,
 * and the two documents it reliably gets wrong are the two people photograph
 * most: a faded thermal receipt comes out too light, a glossy page too dark.
 * These are the repair, and they are deliberately the only two offered --
 * sharpening and denoise sliders invite making a scan worse in ways nobody can
 * predict from the control.
 *
 * It runs here rather than in the worker for the same reason `rotate-image.ts`
 * does: none of the pipeline's decisions depend on it, so it is one pass over
 * the finished image. Measured at 24 ms on the largest output the pipeline can
 * produce (`OUTPUT_MAX_EDGE`, 4.7 megapixels), which is what lets the sliders
 * move the picture as they are dragged instead of waiting for release.
 */

/** How far either control can be pushed in each direction. */
export const ADJUSTMENT_RANGE = 100;

/**
 * What the user asked for, in units of "one hundredth of the way to the end of
 * the slider". Zero is the image exactly as the pipeline produced it.
 */
export interface ImageAdjustments {
  brightness: number;
  contrast: number;
}

/** The pipeline's own output, unmodified. */
export const NEUTRAL_ADJUSTMENTS: ImageAdjustments = {
  brightness: 0,
  contrast: 0,
};

/** Whether these adjustments would change anything. */
export function isNeutral(adjustments: ImageAdjustments): boolean {
  return adjustments.brightness === 0 && adjustments.contrast === 0;
}

/**
 * How much brightness one slider unit is worth, in levels out of 255.
 *
 * At the end of its travel this shifts by 80 levels, which is enough to rescue
 * a badly underexposed capture and short of the point where a page washes out
 * to nothing.
 */
const BRIGHTNESS_PER_UNIT = 0.8;

/**
 * The 256 output values for one setting.
 *
 * Every pixel maps through this rather than being computed, so the arithmetic
 * runs 256 times instead of fourteen million. Contrast uses the standard
 * factor, which pivots around mid-grey so raising it darkens the ink and
 * lightens the paper rather than moving the whole image one way.
 */
export function adjustmentTable(
  adjustments: ImageAdjustments,
): Uint8ClampedArray {
  const contrast = clampSetting(adjustments.contrast);
  const brightness = clampSetting(adjustments.brightness) * BRIGHTNESS_PER_UNIT;
  const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
  const table = new Uint8ClampedArray(256);
  for (let value = 0; value < 256; value++) {
    // Assigning to a Uint8ClampedArray rounds and clamps to 0..255, which is
    // exactly the saturation wanted: a highlight pushed past white stays white.
    table[value] = factor * (value - 128) + 128 + brightness;
  }
  return table;
}

/** Keep a setting inside the range the sliders offer. */
function clampSetting(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-ADJUSTMENT_RANGE, Math.min(ADJUSTMENT_RANGE, value));
}

/**
 * Apply brightness and contrast to an image.
 *
 * Alpha is carried through untouched: these controls are about the ink and the
 * paper, and a document that has become partly transparent is not a thing the
 * user asked for.
 */
export function adjustImage(
  image: RawImage,
  adjustments: ImageAdjustments,
): RawImage {
  // Neutral is the common case -- most scans are accepted as produced -- and
  // returning the same object keeps the memo chain above this from copying
  // fourteen megabytes to change nothing.
  if (isNeutral(adjustments)) return image;

  const table = adjustmentTable(adjustments);
  const source = image.data;
  const target = new Uint8ClampedArray(source.length);
  for (let i = 0; i < source.length; i += 4) {
    target[i] = table[source[i]];
    target[i + 1] = table[source[i + 1]];
    target[i + 2] = table[source[i + 2]];
    target[i + 3] = source[i + 3];
  }
  return { width: image.width, height: image.height, data: target };
}
