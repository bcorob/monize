import { describe, it, expect } from 'vitest';
import {
  foldIncompleteData,
  hasIncompleteData,
} from './incomplete-data-ranges';

describe('foldIncompleteData', () => {
  it('reports nothing for a complete series', () => {
    const causes = foldIncompleteData([
      { date: '2026-06-15' },
      { date: '2026-06-16', unpricedSecurityIds: [], missingRatePairs: [] },
    ]);
    expect(causes).toEqual({ prices: [], rates: [], cash: [] });
    expect(hasIncompleteData(causes)).toBe(false);
  });

  it('folds consecutive points into one range per security', () => {
    const causes = foldIncompleteData([
      { date: '2026-06-15' },
      { date: '2026-06-16', unpricedSecurityIds: ['sec-a'] },
      { date: '2026-06-17', unpricedSecurityIds: ['sec-a'] },
      { date: '2026-06-18', unpricedSecurityIds: ['sec-a'] },
      { date: '2026-06-19' },
    ]);
    expect(causes.prices).toEqual([
      { key: 'sec-a', start: '2026-06-16', end: '2026-06-18' },
    ]);
  });

  it('splits a run that a complete point interrupts', () => {
    // Two outages are two repairs, so one covered day in the middle ends the
    // first range rather than being swallowed by it.
    const causes = foldIncompleteData([
      { date: '2026-06-16', unpricedSecurityIds: ['sec-a'] },
      { date: '2026-06-17' },
      { date: '2026-06-18', unpricedSecurityIds: ['sec-a'] },
    ]);
    expect(causes.prices).toEqual([
      { key: 'sec-a', start: '2026-06-16', end: '2026-06-16' },
      { key: 'sec-a', start: '2026-06-18', end: '2026-06-18' },
    ]);
  });

  it('keeps each key, and each cause, on its own range', () => {
    const causes = foldIncompleteData([
      {
        date: '2026-06-16',
        unpricedSecurityIds: ['sec-a', 'sec-b'],
        missingRatePairs: ['USD->PLN'],
        unknownCashAccountIds: ['acc-1'],
      },
      { date: '2026-06-17', unpricedSecurityIds: ['sec-b'] },
    ]);
    expect(causes.prices).toEqual([
      { key: 'sec-a', start: '2026-06-16', end: '2026-06-16' },
      { key: 'sec-b', start: '2026-06-16', end: '2026-06-17' },
    ]);
    expect(causes.rates).toEqual([
      { key: 'USD->PLN', start: '2026-06-16', end: '2026-06-16' },
    ]);
    expect(causes.cash).toEqual([
      { key: 'acc-1', start: '2026-06-16', end: '2026-06-16' },
    ]);
    expect(hasIncompleteData(causes)).toBe(true);
  });

  it('folds by position in the series, not by calendar adjacency', () => {
    // A monthly series' points are a month apart and still consecutive.
    const causes = foldIncompleteData([
      { date: '2026-01-01', missingRatePairs: ['USD->PLN'] },
      { date: '2026-02-01', missingRatePairs: ['USD->PLN'] },
      { date: '2026-03-01', missingRatePairs: ['USD->PLN'] },
    ]);
    expect(causes.rates).toEqual([
      { key: 'USD->PLN', start: '2026-01-01', end: '2026-03-01' },
    ]);
  });

  it('closes a range that runs to the last point', () => {
    const causes = foldIncompleteData([
      { date: '2026-06-16' },
      { date: '2026-06-17', unknownCashAccountIds: ['acc-1'] },
    ]);
    expect(causes.cash).toEqual([
      { key: 'acc-1', start: '2026-06-17', end: '2026-06-17' },
    ]);
  });

  it('is empty for an empty series', () => {
    expect(foldIncompleteData([])).toEqual({
      prices: [],
      rates: [],
      cash: [],
    });
  });
});
