import { describe, it, expect } from 'vitest';
import { spendingFunds } from './spending-funds';
import type { FundingWindow } from './tagged-funding';

const none = { missingCurrencies: [], excludedCount: 0 };
const window = (over: Partial<FundingWindow> = {}): FundingWindow => ({
  knownIncome: 3279,
  allTotalsKnown: true,
  all: none,
  taggedInflows: 4516,
  taggedOutflows: 0,
  bucket: none,
  ...over,
});
const spending = (over = {}) => ({
  knownSpending: 8486,
  totalSpending: 8486 as number | null,
  ...none,
  ...over,
});

describe('spendingFunds', () => {
  it("reproduces the reporter's August: 3,279 + 4,516 = 7,795 against 8,486 spent", () => {
    const f = spendingFunds(spending(), window());
    expect(f.income).toBe(3279);
    expect(f.netTagged).toBe(4516);
    expect(f.availableFunds).toBe(7795);
    expect(f.spent).toBe(8486);
    expect(f.balance).toBe(-691);
    expect(f.balancePercent).toBe(-8.86);
    expect(f.balanceTotal.excludedCount).toBe(0);
  });

  it('nets tagged outflows off the funds and the balance', () => {
    const f = spendingFunds(spending({ knownSpending: 1000, totalSpending: 1000 }), window({ taggedOutflows: 616 }));
    expect(f.netTagged).toBe(3900);
    expect(f.availableFunds).toBe(7179);
    expect(f.balance).toBe(6179);
  });

  it('keeps a known zero spend a number', () => {
    const f = spendingFunds(spending({ knownSpending: 0, totalSpending: 0 }), window());
    expect(f.balance).toBe(7795);
    expect(f.spent).toBe(0);
  });

  it('withholds the percentage and marks the balance when the spending lost a rate', () => {
    const f = spendingFunds(
      spending({ totalSpending: null, missingCurrencies: ['EUR'], excludedCount: 1 }),
      window(),
    );
    expect(f.balance).toBe(-691);
    expect(f.balancePercent).toBeNull();
    expect(f.balanceTotal).toMatchObject({ missingCurrencies: ['EUR'], excludedCount: 1 });
    expect(f.spentTotal.excludedCount).toBe(1);
    expect(f.incomeTotal.excludedCount).toBe(0);
  });

  it('marks only what the bucket touches when the bucket lost a rate', () => {
    const f = spendingFunds(
      spending(),
      window({ bucket: { missingCurrencies: ['GBP'], excludedCount: 2 } }),
    );
    expect(f.taggedTotal.excludedCount).toBe(2);
    expect(f.availableTotal.excludedCount).toBe(2);
    expect(f.spentTotal.excludedCount).toBe(0);
    expect(f.balancePercent).toBeNull();
  });

  it('treats null All totals as a gap even with no currency named', () => {
    const f = spendingFunds(spending(), window({ allTotalsKnown: false }));
    expect(f.balancePercent).toBeNull();
    expect(f.balanceTotal.excludedCount).toBeGreaterThan(0);
  });
});
