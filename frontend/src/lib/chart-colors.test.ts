import { describe, it, expect } from 'vitest';
import {
  CHART_SERIES,
  chartColors,
  chartSeriesColor,
  chartSeriesColorAsidePrimary,
} from './chart-colors';

describe('chartColors', () => {
  it('exposes CSS variables, never literal colours', () => {
    for (const value of Object.values(chartColors)) {
      expect(value).toMatch(/^var\(--chart-[a-z]+\)$/);
    }
  });
});

describe('chartSeriesColor', () => {
  it('walks the categorical palette from its first slot', () => {
    expect(chartSeriesColor(0)).toBe(CHART_SERIES[0]);
    expect(chartSeriesColor(3)).toBe(CHART_SERIES[3]);
  });

  it('cycles once the palette runs out', () => {
    expect(chartSeriesColor(CHART_SERIES.length)).toBe(CHART_SERIES[0]);
  });
});

describe('chartSeriesColorAsidePrimary', () => {
  /**
   * `--chart-1` is the theme accent in every palette, and so is
   * `--chart-primary`. A member series drawn beside a total must not be handed
   * the total's own colour, which is the whole reason this variant exists.
   */
  it('never hands out the slot that collides with the primary series', () => {
    for (let i = 0; i < CHART_SERIES.length * 2; i++) {
      expect(chartSeriesColorAsidePrimary(i)).not.toBe(CHART_SERIES[0]);
    }
  });

  it('starts at the second slot and stays distinct within one palette pass', () => {
    expect(chartSeriesColorAsidePrimary(0)).toBe(CHART_SERIES[1]);
    const assigned = Array.from({ length: CHART_SERIES.length - 1 }, (_, i) =>
      chartSeriesColorAsidePrimary(i),
    );
    expect(new Set(assigned).size).toBe(assigned.length);
  });

  // Cycling over the full palette would give slot 0 back on the tenth series:
  // the same collision, arriving late.
  it('cycles back to the second slot, skipping the first, once the palette runs out', () => {
    expect(chartSeriesColorAsidePrimary(CHART_SERIES.length - 1)).toBe(CHART_SERIES[1]);
    expect(chartSeriesColorAsidePrimary(CHART_SERIES.length)).toBe(CHART_SERIES[2]);
  });
});
