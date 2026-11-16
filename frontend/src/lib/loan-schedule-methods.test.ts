import { describe, it, expect } from 'vitest';
import {
  generateLoanSchedule,
  type LoanScheduleInput,
  type LumpSum,
  type OverpaymentMode,
  type ScheduleRow,
} from './loan-schedule';
import {
  calendarPaymentNumber,
  methodScheduleTerms,
  nextScheduledPaymentDate,
  remainingScheduledPayments,
  type MethodScheduleTerms,
} from './mortgage-installment';
import type { PrepaymentMode } from './mortgage-type';
import type { MortgageType } from '@/types/account';

/**
 * The LINEAR and INTEREST_ONLY projection against docs/specs/mortgage-types.md
 * section 7, the worked example of #1501: EUR 300,000 over 360 monthly
 * payments from 2024-01-01, 2.00% until a step to 4.00% on 2027-01-01, and
 * repayments of 20,000 and 15,000 counted in the debt of the 2025-07-01 and
 * 2026-01-01 installments.
 *
 * The figures are copied from the spec's tables, which were produced
 * independently of this engine (section 7.6), and asserted at cents, the
 * precision a row carries. A repayment that counts for the installment due on
 * a date lands on the row before it: a lump sum is applied after the regular
 * payment of the row it is dated on.
 */

const TERMS = {
  originalPrincipal: 300000,
  amortizationMonths: 360,
  paymentStartDate: '2024-01-01',
  paymentFrequency: 'MONTHLY',
};

function termsFor(type: MortgageType, prepaymentMode: PrepaymentMode): MethodScheduleTerms {
  const resolved = methodScheduleTerms(type, { ...TERMS, prepaymentMode }, '2024-01-01');
  if (!resolved?.terms) throw new Error('the fixture terms are complete');
  return resolved.terms;
}

function repayments(mode?: OverpaymentMode): LumpSum[] {
  return [
    { date: '2025-06-01', amount: 20000, mode },
    { date: '2025-12-01', amount: 15000, mode },
  ];
}

function workedExample(
  type: MortgageType,
  prepaymentMode: PrepaymentMode,
  overrides: Partial<LoanScheduleInput> = {},
): LoanScheduleInput {
  return {
    startingBalance: 300000,
    annualRate: 2,
    paymentAmount: 0,
    frequency: 'MONTHLY',
    mortgageType: type,
    methodTerms: termsFor(type, prepaymentMode),
    firstPaymentDate: new Date(2024, 0, 1),
    rateChanges: [{ effectiveDate: '2027-01-01', annualRate: 4 }],
    ...overrides,
  };
}

function rowOn(rows: ScheduleRow[], date: string): ScheduleRow {
  const row = rows.find((r) => r.date === date);
  if (!row) throw new Error(`no row on ${date}`);
  return row;
}

function split(row: ScheduleRow) {
  return { principal: row.principal, interest: row.interest, payment: row.payment };
}

describe('methodScheduleTerms', () => {
  it('derives N, c, the term end and the payments left from the account', () => {
    expect(termsFor('LINEAR', 'SHORTEN_TERM')).toEqual({
      prepaymentMode: 'SHORTEN_TERM',
      constantPrincipal: 833.3333,
      scheduledPayments: 360,
      remainingAtFirstRow: 360,
      termEndDate: '2053-12-01',
    });
    // k(d) counts calendar dates on or before d, so a date off the calendar
    // counts like the due date before it (spec section 2).
    expect(
      methodScheduleTerms('LINEAR', { ...TERMS, prepaymentMode: null }, '2025-07-10')?.terms
        ?.remainingAtFirstRow,
    ).toBe(342);
  });

  it('gives INTEREST_ONLY no constant principal and ignores the mode', () => {
    expect(termsFor('INTEREST_ONLY', 'LOWER_INSTALLMENT')).toMatchObject({
      prepaymentMode: 'SHORTEN_TERM',
      constantPrincipal: 0,
    });
  });

  it('names what is missing rather than defaulting it (spec section 8)', () => {
    expect(
      methodScheduleTerms(
        'LINEAR',
        { paymentFrequency: 'MONTHLY', openingBalance: 0 },
        '2024-01-01',
      ),
    ).toEqual({
      terms: null,
      missing: ['amortizationMonths', 'paymentStartDate', 'originalPrincipal'],
    });
    expect(
      methodScheduleTerms('INTEREST_ONLY', { ...TERMS, paymentFrequency: 'FORTNIGHTLY' }, '2024-01-01')
        ?.missing,
    ).toEqual(['paymentFrequency']);
  });

  it('reads abs(opening balance) when the original principal is unset', () => {
    expect(
      methodScheduleTerms(
        'LINEAR',
        { ...TERMS, originalPrincipal: null, openingBalance: -300000 },
        '2024-01-01',
      )?.terms?.constantPrincipal,
    ).toBe(833.3333);
  });

  it('leaves c unknown, not 0, on a LOWER_INSTALLMENT mortgage with no amount borrowed', () => {
    const resolved = methodScheduleTerms(
      'LINEAR',
      { ...TERMS, originalPrincipal: null, openingBalance: 0, prepaymentMode: 'LOWER_INSTALLMENT' },
      '2024-01-01',
    );
    expect(resolved?.missing).toBeNull();
    expect(resolved?.terms?.constantPrincipal).toBeNull();
  });

  it('is null for the annuity types', () => {
    expect(methodScheduleTerms('ANNUITY', TERMS, '2024-01-01')).toBeNull();
    expect(methodScheduleTerms('CANADIAN_FIXED', TERMS, '2024-01-01')).toBeNull();
  });
});

describe('the calendar: k(d), remaining(d) and the next due date', () => {
  it('counts due dates on or before a date, on or off the calendar', () => {
    expect(calendarPaymentNumber(TERMS, '2023-12-31')).toBe(0);
    expect(calendarPaymentNumber(TERMS, '2024-01-01')).toBe(1);
    expect(calendarPaymentNumber(TERMS, '2025-07-01')).toBe(19);
    expect(calendarPaymentNumber(TERMS, '2025-07-10')).toBe(19);
    expect(calendarPaymentNumber(TERMS, '2099-01-01')).toBe(361);
  });

  it('never spreads over more than N, and runs out past the term end', () => {
    expect(remainingScheduledPayments(TERMS, '2023-06-01')).toBe(360);
    expect(remainingScheduledPayments(TERMS, '2053-12-01')).toBe(1);
    expect(remainingScheduledPayments(TERMS, '2054-01-01')).toBe(0);
  });

  it('finds the next due date after a day, payment 1 included', () => {
    expect(nextScheduledPaymentDate(TERMS, '2023-12-15')).toBe('2024-01-01');
    expect(nextScheduledPaymentDate(TERMS, '2024-01-01')).toBe('2024-02-01');
    expect(nextScheduledPaymentDate(TERMS, '2025-07-10')).toBe('2025-08-01');
    expect(nextScheduledPaymentDate(TERMS, '2053-12-01')).toBeNull();
    expect(nextScheduledPaymentDate({ ...TERMS, paymentStartDate: null }, '2025-07-10')).toBeNull();
  });
});

describe('generateLoanSchedule: LINEAR, SHORTEN_TERM (spec table 7.1)', () => {
  const result = generateLoanSchedule(
    workedExample('LINEAR', 'SHORTEN_TERM', { overpayments: { lumpSums: repayments() } }),
  );

  it('prices each row of the table', () => {
    expect(split(rowOn(result.rows, '2024-01-01'))).toEqual({
      principal: 833.33,
      interest: 500,
      payment: 1333.33,
    });
    expect(split(rowOn(result.rows, '2024-02-01'))).toEqual({
      principal: 833.33,
      interest: 498.61,
      payment: 1331.94,
    });
    expect(split(rowOn(result.rows, '2025-07-01'))).toEqual({
      principal: 833.33,
      interest: 441.67,
      payment: 1275,
    });
    expect(split(rowOn(result.rows, '2026-01-01'))).toEqual({
      principal: 833.33,
      interest: 408.33,
      payment: 1241.67,
    });
    expect(split(rowOn(result.rows, '2026-12-01'))).toEqual({
      principal: 833.33,
      interest: 393.06,
      payment: 1226.39,
    });
  });

  it('moves only the interest on the rate change', () => {
    expect(split(rowOn(result.rows, '2027-01-01'))).toEqual({
      principal: 833.33,
      interest: 783.33,
      payment: 1616.67,
    });
  });

  it('carries the debt as posted', () => {
    // The balance after a row is the debt the next one prices.
    expect(rowOn(result.rows, '2025-06-01').balance).toBe(265000);
    expect(rowOn(result.rows, '2026-11-01').balance).toBe(235833.33);
  });

  it('ends on 2050-06-01 after 318 payments, the last absorbing the leftover', () => {
    expect(result.numPayments).toBe(318);
    expect(result.paidOff).toBe(true);
    expect(result.payoffDate).toBe('2050-06-01');
    expect(split(result.rows[result.rows.length - 1])).toEqual({
      principal: 833.34,
      interest: 2.78,
      payment: 836.12,
    });
    // Decision 8: no payment of a fraction of a cent follows.
    expect(result.rows.some((r) => r.date === '2050-07-01')).toBe(false);
  });

  it('sums the interest of every row to the lifetime figure', () => {
    expect(result.totalInterest).toBe(127066.67);
    expect(result.totalExtraPrincipal).toBe(35000);
  });

  it('reads a null mode as SHORTEN_TERM', () => {
    const resolved = methodScheduleTerms(
      'LINEAR',
      { ...TERMS, prepaymentMode: null },
      '2024-01-01',
    )?.terms;
    expect(resolved?.prepaymentMode).toBe('SHORTEN_TERM');
  });
});

describe('generateLoanSchedule: LINEAR, LOWER_INSTALLMENT (spec table 7.3)', () => {
  const result = generateLoanSchedule(
    workedExample('LINEAR', 'LOWER_INSTALLMENT', { overpayments: { lumpSums: repayments() } }),
  );

  it('re-derives the principal after each repayment and holds the term end', () => {
    expect(split(rowOn(result.rows, '2024-01-01'))).toEqual({
      principal: 833.33,
      interest: 500,
      payment: 1333.33,
    });
    expect(split(rowOn(result.rows, '2025-07-01'))).toEqual({
      principal: 774.85,
      interest: 441.67,
      payment: 1216.52,
    });
    expect(split(rowOn(result.rows, '2026-01-01'))).toEqual({
      principal: 730.21,
      interest: 408.92,
      payment: 1139.13,
    });
    expect(split(rowOn(result.rows, '2027-01-01'))).toEqual({
      principal: 730.21,
      interest: 788.63,
      payment: 1518.84,
    });
  });

  it('ends on payment N, 2053-12-01', () => {
    expect(result.numPayments).toBe(360);
    expect(result.payoffDate).toBe('2053-12-01');
    expect(split(result.rows[result.rows.length - 1])).toEqual({
      principal: 730.21,
      interest: 2.43,
      payment: 732.64,
    });
    expect(result.totalInterest).toBe(144396.84);
  });
});

describe('generateLoanSchedule: INTEREST_ONLY (spec table 7.4)', () => {
  const result = generateLoanSchedule(
    workedExample('INTEREST_ONLY', 'SHORTEN_TERM', { overpayments: { lumpSums: repayments() } }),
  );

  it('charges interest only, falling with each repayment and moving with the rate', () => {
    expect(split(rowOn(result.rows, '2024-01-01'))).toEqual({
      principal: 0,
      interest: 500,
      payment: 500,
    });
    expect(split(rowOn(result.rows, '2025-07-01'))).toEqual({
      principal: 0,
      interest: 466.67,
      payment: 466.67,
    });
    expect(split(rowOn(result.rows, '2026-01-01'))).toEqual({
      principal: 0,
      interest: 441.67,
      payment: 441.67,
    });
    expect(split(rowOn(result.rows, '2027-01-01'))).toEqual({
      principal: 0,
      interest: 883.33,
      payment: 883.33,
    });
  });

  it('ends with the bullet on payment N', () => {
    expect(result.numPayments).toBe(360);
    expect(result.paidOff).toBe(true);
    expect(result.payoffDate).toBe('2053-12-01');
    expect(split(result.rows[result.rows.length - 1])).toEqual({
      principal: 265000,
      interest: 883.33,
      payment: 265883.33,
    });
    expect(result.finalPaymentAmount).toBe(265883.33);
  });

  it('is not paid off when the projection stops before the bullet', () => {
    const truncated = generateLoanSchedule(
      workedExample('INTEREST_ONLY', 'SHORTEN_TERM', { maxPayments: 100 }),
    );
    expect(truncated.numPayments).toBe(100);
    expect(truncated.paidOff).toBe(false);
    expect(truncated.payoffDate).toBeNull();
  });

  it('prices the whole debt on a row past the term end', () => {
    const overdue = generateLoanSchedule({
      ...workedExample('INTEREST_ONLY', 'SHORTEN_TERM'),
      methodTerms: { ...termsFor('INTEREST_ONLY', 'SHORTEN_TERM'), remainingAtFirstRow: 0 },
    });
    expect(overdue.numPayments).toBe(1);
    expect(split(overdue.rows[0])).toEqual({ principal: 300000, interest: 500, payment: 300500 });
  });
});

describe('generateLoanSchedule: preview with no events (spec table 7.5)', () => {
  it('LINEAR: 360 payments, the closed-form lifetime interest at cents', () => {
    const result = generateLoanSchedule(
      workedExample('LINEAR', 'SHORTEN_TERM', { rateChanges: [] }),
    );
    expect(result.rows[0].payment).toBe(1333.33);
    expect(result.numPayments).toBe(360);
    expect(result.payoffDate).toBe('2053-12-01');
    expect(result.totalInterest).toBe(90250);
  });

  it('INTEREST_ONLY: 500 a month and a bullet of 300,500', () => {
    const result = generateLoanSchedule(
      workedExample('INTEREST_ONLY', 'SHORTEN_TERM', { rateChanges: [] }),
    );
    expect(result.rows.slice(0, -1).every((r) => r.payment === 500)).toBe(true);
    expect(result.rows[result.rows.length - 1].payment).toBe(300500);
    expect(result.totalInterest).toBe(180000);
  });
});

describe('generateLoanSchedule: annuity-only machinery does not apply', () => {
  it('ignores re-levelling, the stall rescue and stated rate-change payments', () => {
    const plain = generateLoanSchedule(workedExample('LINEAR', 'SHORTEN_TERM'));
    const decorated = generateLoanSchedule(
      workedExample('LINEAR', 'SHORTEN_TERM', {
        paymentAmount: 99,
        fixedEndPeriod: 120,
        rescueEndPeriod: 120,
        rateChanges: [{ effectiveDate: '2027-01-01', annualRate: 4, paymentAmount: 5000 }],
      }),
    );
    expect(decorated).toEqual(plain);
    expect(plain.coveredInterest).toBe(true);
  });

  it('withholds a schedule whose method terms are missing', () => {
    const result = generateLoanSchedule({
      ...workedExample('LINEAR', 'SHORTEN_TERM'),
      methodTerms: undefined,
    });
    expect(result.rows).toEqual([]);
    expect(result.paidOff).toBe(false);
  });
});

describe('generateLoanSchedule: the simulator modes on a LINEAR loan', () => {
  it('a LOWER_INSTALLMENT repayment on a SHORTEN_TERM loan follows table 7.3', () => {
    const simulated = generateLoanSchedule(
      workedExample('LINEAR', 'SHORTEN_TERM', {
        overpayments: { lumpSums: repayments('LOWER_INSTALLMENT') },
      }),
    );
    const setting = generateLoanSchedule(
      workedExample('LINEAR', 'LOWER_INSTALLMENT', { overpayments: { lumpSums: repayments() } }),
    );
    expect(simulated.rows).toEqual(setting.rows);
    expect(split(rowOn(simulated.rows, '2026-01-01'))).toEqual({
      principal: 730.21,
      interest: 408.92,
      payment: 1139.13,
    });
  });

  it('a SHORTEN_TERM repayment prices the constant principal and ends the loan earlier', () => {
    const result = generateLoanSchedule(
      workedExample('LINEAR', 'LOWER_INSTALLMENT', {
        overpayments: { lumpSums: repayments('SHORTEN_TERM') },
      }),
    );
    expect(rowOn(result.rows, '2025-07-01').principal).toBe(833.33);
    expect(rowOn(result.rows, '2027-01-01').principal).toBe(833.33);
    expect(result.payoffDate).toBe('2050-06-01');
  });

  describe('SHORTEN_TERM on a LOWER_INSTALLMENT loan already underway', () => {
    // Table 7.3 after the 20,000 repayment: 265,000.0006 owed on 2025-07-01,
    // payment 19, 342 left, the principal in force re-derived to 774.8538.
    // SHORTEN_TERM is the account setting's rule, min(c, debt) with
    // c = P / N = 833.3333, whichever carrier asks for it.
    const underway = (overrides: Partial<LoanScheduleInput> = {}): LoanScheduleInput => ({
      ...workedExample('LINEAR', 'LOWER_INSTALLMENT', { rateChanges: [] }),
      startingBalance: 265000.0006,
      firstPaymentDate: new Date(2025, 6, 1),
      methodTerms: { ...termsFor('LINEAR', 'LOWER_INSTALLMENT'), remainingAtFirstRow: 342 },
      ...overrides,
    });

    it('prices the re-derived principal on its own rule', () => {
      expect(generateLoanSchedule(underway()).rows[0].principal).toBe(774.85);
    });

    it('a SHORTEN_TERM budget and a SHORTEN_TERM lump sum price the same principal', () => {
      const budget = generateLoanSchedule(
        underway({
          overpayments: { targetMonthlyPayment: 1500, targetMonthlyPaymentMode: 'SHORTEN_TERM' },
        }),
      );
      const lump = generateLoanSchedule(
        underway({
          overpayments: {
            lumpSums: [{ date: '2025-07-01', amount: 100, mode: 'SHORTEN_TERM' }],
          },
        }),
      );
      expect(budget.rows[0].principal).toBe(833.33);
      // The lump sum takes effect from the row after the one it lands on.
      expect(lump.rows[0].principal).toBe(774.85);
      expect(lump.rows[1].principal).toBe(833.33);
      expect(budget.rows[1].principal).toBe(833.33);
    });

    it('withholds a SHORTEN_TERM what-if when the amount borrowed is unknown', () => {
      const unknownC = {
        ...termsFor('LINEAR', 'LOWER_INSTALLMENT'),
        remainingAtFirstRow: 342,
        constantPrincipal: null,
      };
      // Its own rule never reads c, so the baseline still projects.
      const baseline = generateLoanSchedule(underway({ methodTerms: unknownC }));
      expect(baseline.rows[0].principal).toBe(774.85);
      expect(baseline.paidOff).toBe(true);

      for (const overpayments of [
        { targetMonthlyPayment: 1500, targetMonthlyPaymentMode: 'SHORTEN_TERM' as const },
        {
          targetMonthlyPayment: 1500,
          targetMonthlyPaymentMode: 'SHORTEN_TERM' as const,
          targetMonthlyPaymentEnd: '2025-09-01',
        },
        { lumpSums: [{ date: '2025-07-01', amount: 100, mode: 'SHORTEN_TERM' as const }] },
      ]) {
        const result = generateLoanSchedule(underway({ methodTerms: unknownC, overpayments }));
        expect(result.rows).toEqual([]);
        expect(result.paidOff).toBe(false);
      }
    });
  });

  it('a budget overpays each row by what is left after that row\'s installment', () => {
    const result = generateLoanSchedule(
      workedExample('LINEAR', 'SHORTEN_TERM', {
        rateChanges: [],
        overpayments: { targetMonthlyPayment: 1500, targetMonthlyPaymentMode: 'SHORTEN_TERM' },
      }),
    );
    expect(result.rows[0]).toMatchObject({ payment: 1333.33, extraPrincipal: 166.67 });
    expect(result.rows[1].payment + result.rows[1].extraPrincipal).toBeCloseTo(1500, 2);
    expect(result.rows[1].principal).toBe(833.33);
    expect(result.paidOff).toBe(true);
    expect(result.numPayments).toBeLessThan(360);
  });

  it('a budget below an installment pays the installment and no extra', () => {
    const result = generateLoanSchedule(
      workedExample('INTEREST_ONLY', 'SHORTEN_TERM', {
        rateChanges: [],
        maxPayments: 2,
        overpayments: { targetMonthlyPayment: 400 },
      }),
    );
    expect(result.rows[0]).toMatchObject({ payment: 500, extraPrincipal: 0 });
  });
});
