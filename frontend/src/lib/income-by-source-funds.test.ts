import { describe, it, expect } from 'vitest';
import { incomeFundsEntry } from './income-by-source-funds';
import type { FundingWindow } from './tagged-funding';

const win = (taggedInflows: number, taggedOutflows: number, gaps = false): FundingWindow => ({
  knownIncome: 0,
  allTotalsKnown: true,
  all: { missingCurrencies: [], excludedCount: 0 },
  taggedInflows,
  taggedOutflows,
  bucket: gaps
    ? { missingCurrencies: ['EUR'], excludedCount: 1 }
    : { missingCurrencies: [], excludedCount: 0 },
});

describe('incomeFundsEntry', () => {
  it('adds the net tagged inflow to the income total', () => {
    const entry = incomeFundsEntry(3279, win(4516, 0));
    expect(entry?.netTagged).toBe(4516);
    expect(entry?.availableFunds).toBe(7795);
  });

  it('nets outflows', () => {
    expect(incomeFundsEntry(3279, win(4516, 600))?.availableFunds).toBe(7195);
  });

  it.each([
    [500, 500],
    [0, 1000],
    [0, 0],
  ])('has no entry for inflows %d and outflows %d', (inflows, outflows) => {
    expect(incomeFundsEntry(3279, win(inflows, outflows))).toBeNull();
  });

  it('carries the bucket gaps so the figures render as subtotals', () => {
    const entry = incomeFundsEntry(3279, win(4516, 0, true));
    expect(entry?.entryTotal).toEqual({ value: 4516, missingCurrencies: ['EUR'], excludedCount: 1 });
    expect(entry?.availableTotal.value).toBe(7795);
  });
});
