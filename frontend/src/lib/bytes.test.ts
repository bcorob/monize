import { describe, it, expect } from 'vitest';
import { scaleBytes } from './bytes';

describe('scaleBytes', () => {
  it('counts whole bytes below a kilobyte, with no fractional part', () => {
    expect(scaleBytes(0)).toEqual({ value: 0, unit: 'byte', decimals: 0 });
    expect(scaleBytes(512)).toEqual({ value: 512, unit: 'byte', decimals: 0 });
    expect(scaleBytes(1023)).toEqual({ value: 1023, unit: 'byte', decimals: 0 });
  });

  it('steps up at each 1024 boundary and measures to one decimal', () => {
    expect(scaleBytes(1024)).toEqual({ value: 1, unit: 'kilobyte', decimals: 1 });
    expect(scaleBytes(1024 * 1024)).toEqual({
      value: 1,
      unit: 'megabyte',
      decimals: 1,
    });
    expect(scaleBytes(1024 ** 3)).toEqual({
      value: 1,
      unit: 'gigabyte',
      decimals: 1,
    });
  });

  it('stops at gigabytes rather than inventing a larger unit', () => {
    const huge = scaleBytes(1024 ** 5);
    expect(huge.unit).toBe('gigabyte');
    expect(huge.value).toBe(1024 * 1024);
  });

  // Not a claim that a size can be unknown -- both the stash and the API always
  // record one. This keeps NaN out of a formatter.
  it('reads a nonsensical size as zero bytes', () => {
    expect(scaleBytes(Number.NaN)).toEqual({ value: 0, unit: 'byte', decimals: 0 });
    expect(scaleBytes(-1)).toEqual({ value: 0, unit: 'byte', decimals: 0 });
    expect(scaleBytes(Number.POSITIVE_INFINITY)).toEqual({
      value: 0,
      unit: 'byte',
      decimals: 0,
    });
  });

  it('keeps the pre-rounding magnitude, so the formatter decides precision', () => {
    // 1.5 KB exactly; the renderer is what rounds to one decimal.
    expect(scaleBytes(1536)).toEqual({
      value: 1.5,
      unit: 'kilobyte',
      decimals: 1,
    });
  });
});
