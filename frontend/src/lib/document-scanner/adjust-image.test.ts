import { describe, expect, it } from 'vitest';

import {
  ADJUSTMENT_RANGE,
  NEUTRAL_ADJUSTMENTS,
  adjustImage,
  adjustmentTable,
  isNeutral,
} from './adjust-image';
import type { RawImage } from './document-scan.types';

/**
 * Brightness and contrast over finished pixels.
 *
 * The uploaded file is produced from this, so what has to be true is that it
 * only ever moves values along the grey axis: a channel treated differently
 * from its neighbours is a colour cast in every scan the user adjusts, and a
 * clamp that wraps instead of saturating turns a highlight black.
 */

/** A ramp through every level, so nothing can hide between two samples. */
function ramp(): RawImage {
  const data = new Uint8ClampedArray(256 * 4);
  for (let value = 0; value < 256; value++) {
    const offset = value * 4;
    data[offset] = value;
    data[offset + 1] = value;
    data[offset + 2] = value;
    data[offset + 3] = 200;
  }
  return { width: 256, height: 1, data };
}

describe('isNeutral', () => {
  it('is true only when neither control has been moved', () => {
    expect(isNeutral(NEUTRAL_ADJUSTMENTS)).toBe(true);
    expect(isNeutral({ brightness: 1, contrast: 0 })).toBe(false);
    expect(isNeutral({ brightness: 0, contrast: -1 })).toBe(false);
  });
});

describe('adjustmentTable', () => {
  it('maps every level to itself when nothing was asked for', () => {
    const table = adjustmentTable(NEUTRAL_ADJUSTMENTS);
    for (let value = 0; value < 256; value++) expect(table[value]).toBe(value);
  });

  it('never lets a brighter input come out darker', () => {
    for (const contrast of [-ADJUSTMENT_RANGE, -30, 0, 30, ADJUSTMENT_RANGE]) {
      const table = adjustmentTable({ brightness: 0, contrast });
      for (let value = 1; value < 256; value++) {
        expect(table[value]).toBeGreaterThanOrEqual(table[value - 1]);
      }
    }
  });

  // Contrast pivots on mid-grey, which is what makes it darken the ink and
  // lighten the paper rather than moving the whole page one way.
  it('holds mid-grey still while pushing the ends apart', () => {
    const raised = adjustmentTable({ brightness: 0, contrast: 50 });
    expect(raised[128]).toBe(128);
    expect(raised[200]).toBeGreaterThan(200);
    expect(raised[60]).toBeLessThan(60);
  });

  it('flattens towards mid-grey when contrast is lowered', () => {
    const lowered = adjustmentTable({ brightness: 0, contrast: -50 });
    expect(lowered[255]).toBeLessThan(255);
    expect(lowered[0]).toBeGreaterThan(0);
  });

  // A value pushed past white stays white. Left to wrap it would come back as
  // black, which reads as a hole punched in the page.
  it('saturates rather than wrapping', () => {
    const bright = adjustmentTable({
      brightness: ADJUSTMENT_RANGE,
      contrast: ADJUSTMENT_RANGE,
    });
    expect(bright[255]).toBe(255);
    const dark = adjustmentTable({
      brightness: -ADJUSTMENT_RANGE,
      contrast: ADJUSTMENT_RANGE,
    });
    expect(dark[0]).toBe(0);
  });

  it('ignores a setting outside the range the sliders offer', () => {
    const clamped = adjustmentTable({ brightness: 5000, contrast: 5000 });
    const limit = adjustmentTable({
      brightness: ADJUSTMENT_RANGE,
      contrast: ADJUSTMENT_RANGE,
    });
    expect(Array.from(clamped)).toEqual(Array.from(limit));
  });

  it('treats a value that is not a number as no adjustment', () => {
    const table = adjustmentTable({ brightness: Number.NaN, contrast: 0 });
    expect(table[128]).toBe(128);
  });
});

describe('adjustImage', () => {
  it('returns the same image untouched when nothing was asked for', () => {
    const image = ramp();
    expect(adjustImage(image, NEUTRAL_ADJUSTMENTS)).toBe(image);
  });

  it('applies the table to every colour channel', () => {
    const image = ramp();
    const table = adjustmentTable({ brightness: 20, contrast: 15 });
    const result = adjustImage(image, { brightness: 20, contrast: 15 });

    for (let value = 0; value < 256; value++) {
      const offset = value * 4;
      expect(result.data[offset]).toBe(table[value]);
      expect(result.data[offset + 1]).toBe(table[value]);
      expect(result.data[offset + 2]).toBe(table[value]);
    }
  });

  // A channel moved differently from its neighbours is a colour cast on every
  // scan the user brightens.
  it('leaves a grey pixel grey', () => {
    const result = adjustImage(ramp(), { brightness: -35, contrast: 40 });
    for (let value = 0; value < 256; value++) {
      const offset = value * 4;
      expect(result.data[offset + 1]).toBe(result.data[offset]);
      expect(result.data[offset + 2]).toBe(result.data[offset]);
    }
  });

  it('carries the alpha channel through untouched', () => {
    const result = adjustImage(ramp(), { brightness: 60, contrast: 60 });
    for (let value = 0; value < 256; value++) {
      expect(result.data[value * 4 + 3]).toBe(200);
    }
  });

  it('keeps the size', () => {
    const image = ramp();
    const result = adjustImage(image, { brightness: 10, contrast: 0 });
    expect([result.width, result.height]).toEqual([image.width, image.height]);
  });

  it('does not alias the source buffer', () => {
    // The result is uploaded and drawn; sharing memory with the pipeline's
    // output would make the next slider move adjust an already-adjusted image.
    const image = ramp();
    const result = adjustImage(image, { brightness: 10, contrast: 0 });
    result.data[0] = 42;
    expect(image.data[0]).not.toBe(42);
  });

  // The whole reason this is not in the worker: the sliders move the picture as
  // they are dragged, so a pass has to fit inside a frame's worth of time.
  it('adjusts a full-size scan in well under a second', () => {
    const width = 2500;
    const height = 1800;
    const image: RawImage = {
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4),
    };
    const started = Date.now();
    adjustImage(image, { brightness: 25, contrast: 25 });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
