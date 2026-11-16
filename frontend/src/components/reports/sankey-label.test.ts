import { describe, it, expect } from 'vitest';
import { estimateTextWidth, fitSankeyLabel, type TextMeasure } from './sankey-label';

/** Ten pixels a character, so widths are easy to reason about. */
const tenPx: TextMeasure = (text) => Array.from(text).length * 10;

describe('fitSankeyLabel', () => {
  it('leaves a label that fits whole', () => {
    expect(fitSankeyLabel('Rent', 40, 11, tenPx)).toBe('Rent');
  });

  it('cuts a long label to the widest prefix that fits with an ellipsis', () => {
    const fitted = fitSankeyLabel('Savings & investments', 80, 11, tenPx);
    expect(fitted).toBe('Savings…');
    expect(tenPx(fitted, 11)).toBeLessThanOrEqual(80);
  });

  it('never ends the prefix on a space before the ellipsis', () => {
    expect(fitSankeyLabel('Car payment', 50, 11, tenPx)).toBe('Car…');
  });

  it('draws nothing where not even the ellipsis fits', () => {
    expect(fitSankeyLabel('Groceries', 5, 11, tenPx)).toBe('');
  });

  it('keeps every fitted label within the width, whatever the width', () => {
    const label = 'Uncategorized expenses';
    for (let width = 10; width <= 300; width += 7) {
      expect(tenPx(fitSankeyLabel(label, width, 11, tenPx), 11)).toBeLessThanOrEqual(width);
    }
  });

  it('estimates without a canvas, erring wide', () => {
    expect(estimateTextWidth('abcd', 10)).toBeGreaterThan(4 * 10 * 0.55);
  });

  it('measures with the estimate where the DOM has no OffscreenCanvas', () => {
    // jsdom has none, so the default measure is the estimate.
    expect(fitSankeyLabel('Home maintenance and improvements', 88, 11)).toBe(
      fitSankeyLabel('Home maintenance and improvements', 88, 11, estimateTextWidth),
    );
  });
});
