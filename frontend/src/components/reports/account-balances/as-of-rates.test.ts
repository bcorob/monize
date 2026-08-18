import { describe, it, expect } from 'vitest';
import { asOfConverter } from './as-of-rates';

describe('asOfConverter', () => {
  const convert = asOfConverter('CAD', { CAD: 1, USD: 1.35 });

  it('converts at the rate the server resolved for the report date', () => {
    expect(convert(100, 'USD')).toBeCloseTo(135, 10);
  });

  // Same currency is 1:1 by definition. It has to stay distinguishable from
  // the missing case, which is why it is not routed through the table.
  it('passes an amount already in the display currency straight through', () => {
    expect(convert(100, 'CAD')).toBe(100);
    expect(asOfConverter('CAD', {})(100, 'CAD')).toBe(100);
  });

  // An omitted currency is one the server found no rate for on that date. The
  // unconverted amount under the display currency's symbol is the silent error
  // this whole contract exists to prevent.
  it('returns null for a currency the rate table omits', () => {
    expect(convert(100, 'EUR')).toBeNull();
  });

  it.each([
    ['zero', 0],
    ['negative', -1.35],
    ['infinite', Number.POSITIVE_INFINITY],
    ['not a number', Number.NaN],
  ])('returns null for a %s rate rather than applying it', (_label, rate) => {
    expect(asOfConverter('CAD', { CAD: 1, USD: rate })(100, 'USD')).toBeNull();
  });

  it('keeps a real zero balance a number', () => {
    expect(convert(0, 'USD')).toBe(0);
  });

  it('converts a negative balance the same way', () => {
    expect(convert(-100, 'USD')).toBeCloseTo(-135, 10);
  });
});
