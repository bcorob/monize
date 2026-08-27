import { describe, it, expect } from 'vitest';
import {
  nextOccurrenceEffectiveAmount,
  overrideEffectiveAmount,
  scheduleEffectiveAmount,
  sumEffectiveOccurrences,
} from './scheduled-effective-amount';
import { isComplete } from './currency-total';
import type {
  ScheduledTransaction,
  ScheduledTransactionOverride,
} from '@/types/scheduled-transaction';

/**
 * The client half of the effective-amount contract (issue #1247). The numbers are
 * the issue's worked example: 10 shares at 100, pinned at 1.50 while the security
 * was priced in EUR (so the persisted amount implies 1,500 CAD), re-priced to
 * 1,350 CAD once the security became USD at 1.35.
 *
 * Every case also asserts what must NOT come back, because the defect is a
 * plausible number rather than an error.
 */
describe('scheduled effective amounts', () => {
  const plain = (overrides: Partial<ScheduledTransaction> = {}) =>
    ({
      id: 'st-plain',
      amount: -1200,
      currencyCode: 'CAD',
      isInvestment: false,
      isSplit: false,
      isTransfer: false,
      ...overrides,
    }) as ScheduledTransaction;

  const investment = (overrides: Partial<ScheduledTransaction> = {}) =>
    ({
      id: 'st-inv',
      // The security-currency cash impact, at the account's own currency code.
      amount: -1000,
      currencyCode: 'CAD',
      isInvestment: true,
      isSplit: false,
      isTransfer: false,
      ...overrides,
    }) as ScheduledTransaction;

  const override = (
    overrides: Partial<ScheduledTransactionOverride> = {},
  ) =>
    ({
      id: 'ovr-1',
      scheduledTransactionId: 'st-plain',
      originalDate: '2026-09-01',
      overrideDate: '2026-09-03',
      amount: null,
      ...overrides,
    }) as ScheduledTransactionOverride;

  describe('scheduleEffectiveAmount', () => {
    it('reads the server figure and its settlement currency', () => {
      expect(
        scheduleEffectiveAmount(
          investment({
            effectiveAmount: -1350,
            effectiveAmountComplete: true,
            effectiveCurrencyCode: 'CAD',
          }),
        ),
      ).toEqual({ amount: -1350, currencyCode: 'CAD', complete: true });
    });

    it('reports an explicit null as unknown, never as the persisted amount', () => {
      const result = scheduleEffectiveAmount(
        investment({
          effectiveAmount: null,
          effectiveAmountComplete: false,
          effectiveCurrencyCode: 'CAD',
        }),
      );

      expect(result.amount).toBeNull();
      expect(result.complete).toBe(false);
      expect(result.amount).not.toBe(-1000);
    });

    it('keeps a plain schedule on its stored amount', () => {
      expect(scheduleEffectiveAmount(plain({ effectiveAmount: -1200 }))).toEqual(
        { amount: -1200, currencyCode: 'CAD', complete: true },
      );
    });

    // A rolling deploy serves some responses from a backend that predates the
    // field. Absent is "no information", so it is read as unknown for anything
    // an exchange rate re-prices and as the stored amount for everything else --
    // the same split `lib/forecast.ts` makes.
    describe('when the server did not send the field (older backend)', () => {
      it('treats a top-level investment schedule as unknown', () => {
        const result = scheduleEffectiveAmount(investment());

        expect(result.amount).toBeNull();
        expect(result.complete).toBe(false);
      });

      it('treats a split parent with an investment line as unknown', () => {
        const result = scheduleEffectiveAmount(
          plain({
            isSplit: true,
            splits: [
              { kind: 'investment', investmentAction: 'BUY' },
            ] as never,
          }),
        );

        expect(result.amount).toBeNull();
        expect(result.complete).toBe(false);
      });

      it('keeps a plain schedule known', () => {
        expect(scheduleEffectiveAmount(plain())).toEqual({
          amount: -1200,
          currencyCode: 'CAD',
          complete: true,
        });
      });

      it('keeps a split parent with no investment line known', () => {
        const result = scheduleEffectiveAmount(
          plain({
            isSplit: true,
            splits: [{ kind: 'category', amount: -1200 }] as never,
          }),
        );

        expect(result).toEqual({
          amount: -1200,
          currencyCode: 'CAD',
          complete: true,
        });
      });
    });
  });

  describe('overrideEffectiveAmount', () => {
    it('reads the override figure the server resolved', () => {
      const result = overrideEffectiveAmount(
        investment({
          effectiveAmount: -1350,
          effectiveAmountComplete: true,
          effectiveCurrencyCode: 'CAD',
        }),
        override({ effectiveAmount: -675, effectiveAmountComplete: true }),
      );

      expect(result).toEqual({
        amount: -675,
        currencyCode: 'CAD',
        complete: true,
      });
    });

    it('reports an unknown override as unknown', () => {
      const result = overrideEffectiveAmount(
        investment({ effectiveAmount: null, effectiveAmountComplete: false }),
        override({ effectiveAmount: null, effectiveAmountComplete: false }),
      );

      expect(result.amount).toBeNull();
      expect(result.complete).toBe(false);
    });

    it('falls through to the base occurrence for a date-only override', () => {
      const schedule = plain({ effectiveAmount: -1200 });

      expect(
        overrideEffectiveAmount(schedule, override({ amount: null })),
      ).toEqual(scheduleEffectiveAmount(schedule));
    });

    it('uses a non-investment override stored amount on an older backend', () => {
      expect(
        overrideEffectiveAmount(plain(), override({ amount: -1350 })),
      ).toEqual({ amount: -1350, currencyCode: 'CAD', complete: true });
    });
  });

  describe('nextOccurrenceEffectiveAmount', () => {
    it('prefers the next override over the base occurrence', () => {
      const result = nextOccurrenceEffectiveAmount(
        plain({
          effectiveAmount: -1200,
          nextOverride: override({ effectiveAmount: -1350 }),
        }),
      );

      expect(result.amount).toBe(-1350);
    });

    it('uses the base occurrence when there is no override', () => {
      expect(
        nextOccurrenceEffectiveAmount(plain({ effectiveAmount: -1200 })).amount,
      ).toBe(-1200);
    });
  });

  describe('sumEffectiveOccurrences', () => {
    const at = (amount: number, currencyCode = 'CAD') => ({
      amount,
      currencyCode,
      complete: true,
    });
    const unknown = { amount: null, currencyCode: 'CAD', complete: false };
    /** A converter that knows exactly one pair, so a second currency is a gap. */
    const cadOnly = (amount: number, from: string) =>
      from === 'CAD' ? amount : null;
    const identity = (amount: number) => amount;

    it('totals a complete single-currency set', () => {
      const result = sumEffectiveOccurrences(
        [at(-1200), at(-1350)],
        (x) => x,
        cadOnly,
        Math.abs,
      );

      expect(result.value).toBe(2550);
      expect(isComplete(result)).toBe(true);
    });

    it('converts before summing, so currencies cannot be added as numbers', () => {
      // 1,350 CAD at 0.74 is 999 USD; beside a 500 USD bill the answer is 1,499
      // USD, not the 1,850 an adder that ignored the currency produced.
      const toUsd = (amount: number, from: string) =>
        from === 'USD' ? amount : amount * 0.74;
      const result = sumEffectiveOccurrences(
        [at(-1350, 'CAD'), at(-500, 'USD')],
        (x) => x,
        toUsd,
        Math.abs,
      );

      expect(result.value).toBe(1499);
      expect(result.value).not.toBe(1850);
      expect(isComplete(result)).toBe(true);
    });

    it('withholds the total when a rate is missing, and names the currency', () => {
      const result = sumEffectiveOccurrences(
        [at(-1200, 'CAD'), at(-500, 'USD')],
        (x) => x,
        cadOnly,
        Math.abs,
      );

      expect(isComplete(result)).toBe(false);
      expect(result.value).toBe(1200);
      expect(result.missingCurrencies).toEqual(['USD']);
      expect(result.excludedCount).toBe(1);
    });

    it('excludes an unpriceable occurrence by count, with no currency to blame', () => {
      // Its own settlement rate is what is missing, so it is unknown in every
      // currency -- naming CAD would send the reader to fix the wrong rate.
      const result = sumEffectiveOccurrences(
        [at(-1200), unknown],
        (x) => x,
        cadOnly,
        Math.abs,
      );

      expect(isComplete(result)).toBe(false);
      expect(result.value).toBe(1200);
      expect(result.missingCurrencies).toEqual([]);
      expect(result.excludedCount).toBe(1);
    });

    it('totals an empty set as a known zero, not as unknown', () => {
      // Nothing upcoming is a settled answer; reporting it as unknown would take
      // a question the user can act on away from them.
      const result = sumEffectiveOccurrences([], (x: never) => x, cadOnly);

      expect(result.value).toBe(0);
      expect(isComplete(result)).toBe(true);
    });

    it('accumulates in integer ten-thousandths, so cents do not drift', () => {
      const result = sumEffectiveOccurrences(
        [at(0.1), at(0.2)],
        (x) => x,
        cadOnly,
        identity,
      );

      expect(result.value).toBe(0.3);
    });
  });
});
