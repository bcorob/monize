import { describe, it, expect } from 'vitest';
import { sumConverted, combineTotals, isComplete } from './currency-total';

interface Row {
  amount: number;
  currency: string;
}

/** A rate table that knows only USD->CAD, so anything else is unconvertible. */
const convert = (amount: number, currency: string): number | null => {
  if (currency === 'CAD') return amount;
  if (currency === 'USD') return amount * 1.35;
  return null;
};

const rows = (...items: [number, string][]): Row[] =>
  items.map(([amount, currency]) => ({ amount, currency }));

const sum = (items: Row[]) =>
  sumConverted(
    items,
    (r) => r.amount,
    (r) => r.currency,
    convert,
  );

describe('sumConverted', () => {
  it('adds converted components and reports the total complete', () => {
    const total = sum(rows([100, 'CAD'], [100, 'USD']));
    expect(total.value).toBe(235);
    expect(total.missingCurrencies).toEqual([]);
    expect(isComplete(total)).toBe(true);
  });

  // The audit's reproduction, in accumulator form: a 100.00 USD account with no
  // rate used to contribute 100.00 to a CAD total. It now contributes nothing and
  // says so, which is what lets the caller mark the figure as a subtotal.
  it('excludes an unconvertible component and names its currency', () => {
    const total = sum(rows([20_000, 'CAD'], [100_000, 'EUR']));
    expect(total.value).toBe(20_000);
    expect(total.missingCurrencies).toEqual(['EUR']);
    expect(total.excludedCount).toBe(1);
    expect(isComplete(total)).toBe(false);
  });

  it('names each missing currency once, however many rows use it', () => {
    const total = sum(rows([1, 'EUR'], [2, 'EUR'], [3, 'GBP']));
    expect(total.missingCurrencies).toEqual(['EUR', 'GBP']);
    expect(total.excludedCount).toBe(3);
  });

  // A non-finite component is an upstream value failure, not a zero and not a
  // missing rate: it is excluded by count, but its currency (which may have a
  // perfectly good rate) is not named.
  it('excludes a NaN component without naming its currency', () => {
    const total = sum(rows([Number.NaN, 'CAD'], [10, 'CAD']));
    expect(total.value).toBe(10);
    expect(total.missingCurrencies).toEqual([]);
    expect(total.excludedCount).toBe(1);
  });

  it('is complete and zero for no components at all', () => {
    const total = sum([]);
    expect(total.value).toBe(0);
    expect(isComplete(total)).toBe(true);
  });

  // A genuine zero balance is a known state and must not look like a missing one.
  it('treats a real zero as a known component', () => {
    const total = sum(rows([0, 'USD']));
    expect(total.value).toBe(0);
    expect(isComplete(total)).toBe(true);
  });

  // A component excluded with no currency to name (an unpriced holding) still
  // makes the total incomplete, even though missingCurrencies is empty.
  it('is incomplete when a component was excluded without a currency', () => {
    expect(isComplete({ value: 100, missingCurrencies: [], excludedCount: 1 })).toBe(false);
  });

  it('accumulates at storage precision rather than drifting', () => {
    const total = sum(rows([0.1, 'CAD'], [0.2, 'CAD']));
    expect(total.value).toBe(0.3);
  });
});

describe('combineTotals', () => {
  it('subtracts values and keeps both totals complete', () => {
    const assets = sum(rows([100, 'CAD']));
    const liabilities = sum(rows([40, 'CAD']));
    const net = combineTotals([assets, liabilities], ([a, l]) => a - l);
    expect(net.value).toBe(60);
    expect(isComplete(net)).toBe(true);
  });

  // Net worth built from a complete asset total and a partial liability total is
  // partial: the hole is in the difference too.
  it('inherits incompleteness from either side', () => {
    const assets = sum(rows([100, 'CAD']));
    const liabilities = sum(rows([40, 'CAD'], [5, 'EUR']));
    const net = combineTotals([assets, liabilities], ([a, l]) => a - l);
    expect(net.value).toBe(60);
    expect(net.missingCurrencies).toEqual(['EUR']);
    expect(isComplete(net)).toBe(false);
  });

  it('unions the missing currencies of both sides', () => {
    const assets = sum(rows([100, 'CAD'], [1, 'GBP']));
    const liabilities = sum(rows([40, 'CAD'], [5, 'EUR']));
    const net = combineTotals([assets, liabilities], ([a, l]) => a - l);
    expect(net.missingCurrencies.sort()).toEqual(['EUR', 'GBP']);
    expect(net.excludedCount).toBe(2);
  });
});
