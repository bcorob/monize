import { describe, it, expect } from 'vitest';
import {
  findFundingBucket,
  fundingCompleteness,
  fundingWindow,
  mergeCompleteness,
  monthEndYmd,
} from './tagged-funding';
import type { IncomeVsExpensesResponse } from '@/types/built-in-reports';

const totals = { income: 3279, expenses: 0, net: 3279, knownIncome: 3279, knownExpenses: 0, knownNet: 3279 };
const bucket = (value: string, isUntagged = false, inflows = 0) => ({
  value,
  isUntagged,
  data: [],
  totals,
  taggedInflows: inflows,
  taggedOutflows: 2,
  missingCurrencies: ['EUR'],
  excludedCount: 1,
});
const response = (over: Partial<IncomeVsExpensesResponse> = {}): IncomeVsExpensesResponse => ({
  data: [],
  totals,
  currency: 'CAD',
  missingCurrencies: [],
  excludedCount: 0,
  tagKey: 'scope',
  buckets: [bucket('household', false, 4516), bucket('__untagged__', true, 9)],
  ...over,
});

describe('findFundingBucket', () => {
  it('finds a value and never the untagged bucket', () => {
    expect(findFundingBucket(response(), 'household')?.taggedInflows).toBe(4516);
    expect(findFundingBucket(response(), '__untagged__')).toBeUndefined();
    expect(findFundingBucket(null, 'household')).toBeUndefined();
  });
});

describe('fundingWindow', () => {
  it('reads the All income and the chosen bucket', () => {
    expect(fundingWindow(response(), 'household')).toEqual({
      knownIncome: 3279,
      allTotalsKnown: true,
      all: { missingCurrencies: [], excludedCount: 0 },
      taggedInflows: 4516,
      taggedOutflows: 2,
      bucket: { missingCurrencies: ['EUR'], excludedCount: 1 },
    });
  });

  it('treats an absent bucket as a known zero and null All totals as unknown', () => {
    const w = fundingWindow(
      response({ totals: { ...totals, income: null }, excludedCount: 1 }),
      'stall',
    );
    expect(w.taggedInflows).toBe(0);
    expect(w.taggedOutflows).toBe(0);
    expect(w.bucket).toEqual({ missingCurrencies: [], excludedCount: 0 });
    expect(w.allTotalsKnown).toBe(false);
  });
});

describe('fundingCompleteness', () => {
  it('is complete when nothing was left out and the All totals are known', () => {
    const r = response({ buckets: [{ ...bucket('household', false, 1), missingCurrencies: [], excludedCount: 0 }] });
    expect(fundingCompleteness(r, 'household')).toEqual({
      complete: true,
      missingCurrencies: [],
      excludedCount: 0,
    });
  });

  it('is incomplete when the bucket lost a rate, naming the currency', () => {
    expect(fundingCompleteness(response(), 'household')).toEqual({
      complete: false,
      missingCurrencies: ['EUR'],
      excludedCount: 1,
    });
  });

  it('is incomplete when the response lost a rate or its All totals are null', () => {
    const clean = [{ ...bucket('household', false, 1), missingCurrencies: [], excludedCount: 0 }];
    expect(
      fundingCompleteness(response({ buckets: clean, missingCurrencies: ['GBP'], excludedCount: 2 }), 'household'),
    ).toMatchObject({ complete: false, missingCurrencies: ['GBP'], excludedCount: 2 });
    expect(
      fundingCompleteness(response({ buckets: clean, totals: { ...totals, income: null } }), 'household').complete,
    ).toBe(false);
  });

  it('reads an absent bucket as no gap of its own', () => {
    expect(fundingCompleteness(response(), 'stall')).toMatchObject({ complete: true });
  });
});

describe('mergeCompleteness', () => {
  it('unions currencies and sums exclusions', () => {
    expect(
      mergeCompleteness(
        { missingCurrencies: ['EUR'], excludedCount: 1 },
        { missingCurrencies: ['EUR', 'GBP'], excludedCount: 2 },
      ),
    ).toEqual({ missingCurrencies: ['EUR', 'GBP'], excludedCount: 3 });
  });
});

describe('monthEndYmd', () => {
  it.each([
    ['2024-02', '2024-02-29'],
    ['2025-02', '2025-02-28'],
    ['2026-08', '2026-08-31'],
    ['2026-09', '2026-09-30'],
    ['2026-12', '2026-12-31'],
  ])('%s ends on %s', (month, end) => {
    expect(monthEndYmd(month)).toBe(end);
  });
});
