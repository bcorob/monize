import { describe, it, expect } from 'vitest';
import { getNextScheduled, getUpcomingScheduled } from './scheduled-utils';
import { ScheduledTransaction } from '@/types/scheduled-transaction';

const makeScheduled = (
  overrides: Partial<ScheduledTransaction> = {},
): ScheduledTransaction =>
  ({
    id: 'st-1',
    accountId: 'a-1',
    payeeId: 'p-1',
    payee: null,
    payeeName: 'Hydro One',
    categoryId: 'c-1',
    amount: -120,
    currencyCode: 'CAD',
    frequency: 'MONTHLY',
    nextDueDate: '2026-08-01T00:00:00.000Z',
    isActive: true,
    nextOverride: null,
    ...overrides,
  }) as ScheduledTransaction;

describe('getNextScheduled', () => {
  it('returns the soonest matching active item', () => {
    const result = getNextScheduled(
      [
        makeScheduled({ id: 'later', nextDueDate: '2026-09-01' }),
        makeScheduled({ id: 'sooner', nextDueDate: '2026-07-15', amount: -55 }),
      ],
      (st) => st.accountId === 'a-1',
    );
    expect(result).toEqual({
      date: '2026-07-15',
      amount: -55,
      currencyCode: 'CAD',
      payeeName: 'Hydro One',
    });
  });

  it('skips inactive and non-matching items', () => {
    const result = getNextScheduled(
      [
        makeScheduled({ isActive: false }),
        makeScheduled({ accountId: 'a-2' }),
      ],
      (st) => st.accountId === 'a-1',
    );
    expect(result).toBeNull();
  });

  it('honours per-occurrence date and amount overrides', () => {
    const result = getNextScheduled(
      [
        makeScheduled({
          nextDueDate: '2026-08-01',
          nextOverride: {
            overrideDate: '2026-07-20T00:00:00.000Z',
            amount: -99.5,
          } as ScheduledTransaction['nextOverride'],
        }),
      ],
      () => true,
    );
    expect(result).toEqual({
      date: '2026-07-20',
      amount: -99.5,
      currencyCode: 'CAD',
      payeeName: 'Hydro One',
    });
  });

  it('prefers the linked payee name over the free-text name', () => {
    const result = getNextScheduled(
      [makeScheduled({ payee: { name: 'Hydro One Networks' } as ScheduledTransaction['payee'] })],
      () => true,
    );
    expect(result?.payeeName).toBe('Hydro One Networks');
  });
});

describe('getUpcomingScheduled', () => {
  it('lists matching active items soonest first, bounded by the limit', () => {
    const result = getUpcomingScheduled(
      [
        makeScheduled({ id: 'st-1', nextDueDate: '2026-08-15T00:00:00.000Z' }),
        makeScheduled({ id: 'st-2', nextDueDate: '2026-08-01T00:00:00.000Z' }),
        makeScheduled({ id: 'st-3', nextDueDate: '2026-08-08T00:00:00.000Z' }),
      ],
      () => true,
      2,
    );
    expect(result.map((item) => item.date)).toEqual(['2026-08-01', '2026-08-08']);
  });

  it('excludes inactive and non-matching items', () => {
    const result = getUpcomingScheduled(
      [
        makeScheduled({ id: 'st-1', isActive: false }),
        makeScheduled({ id: 'st-2', categoryId: 'c-other' }),
        makeScheduled({ id: 'st-3', categoryId: 'c-1' }),
      ],
      (st) => st.categoryId === 'c-1',
      5,
    );
    expect(result).toHaveLength(1);
  });

  it('honours per-occurrence overrides for date and amount', () => {
    const result = getUpcomingScheduled(
      [
        makeScheduled({
          nextOverride: {
            overrideDate: '2026-08-20T00:00:00.000Z',
            amount: -99,
          } as ScheduledTransaction['nextOverride'],
        }),
      ],
      () => true,
      5,
    );
    expect(result[0]).toMatchObject({ date: '2026-08-20', amount: -99 });
  });

  it('returns an empty list when nothing matches', () => {
    expect(getUpcomingScheduled([makeScheduled()], () => false, 5)).toEqual([]);
  });

  // Issue #1247: the amount is what the occurrence would post today, in the
  // settlement currency, from the server's effective-amount contract.
  it("reports the server's effective amount and currency, not the stored pair", () => {
    const result = getUpcomingScheduled(
      [
        makeScheduled({
          isInvestment: true,
          // The security-currency cash impact, under the brokerage's code.
          amount: -1000,
          currencyCode: 'USD',
          effectiveAmount: -1350,
          effectiveAmountComplete: true,
          effectiveCurrencyCode: 'CAD',
        }),
      ],
      () => true,
      5,
    );

    expect(result[0]).toMatchObject({ amount: -1350, currencyCode: 'CAD' });
  });

  it('reports an unresolvable occurrence as unknown, never as its stored amount', () => {
    const result = getUpcomingScheduled(
      [
        makeScheduled({
          isInvestment: true,
          amount: -1000,
          currencyCode: 'CAD',
          effectiveAmount: null,
          effectiveAmountComplete: false,
          effectiveCurrencyCode: 'CAD',
        }),
      ],
      () => true,
      5,
    );

    expect(result[0].amount).toBeNull();
    expect(result[0].amount).not.toBe(-1000);
  });

  it('prefers an override effective amount over the base occurrence', () => {
    const result = getUpcomingScheduled(
      [
        makeScheduled({
          effectiveAmount: -120,
          effectiveAmountComplete: true,
          nextOverride: {
            overrideDate: '2026-08-20T00:00:00.000Z',
            originalDate: '2026-08-01',
            amount: -99,
            effectiveAmount: -99,
            effectiveAmountComplete: true,
          } as ScheduledTransaction['nextOverride'],
        }),
      ],
      () => true,
      5,
    );

    expect(result[0]).toMatchObject({ date: '2026-08-20', amount: -99 });
  });
});
