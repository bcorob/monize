import { describe, it, expect } from 'vitest';
import { deriveLoanFigures, isDebtSettled } from './loan-figures';
import type { LoanScheduleResult } from './loan-schedule';

function makeBaseline(overrides: Partial<LoanScheduleResult> = {}): LoanScheduleResult {
  return {
    rows: [],
    payoffDate: '2031-04-15',
    totalInterest: 12345.67,
    totalPaid: 90000,
    totalExtraPrincipal: 0,
    numPayments: 60,
    paidOff: true,
    finalPaymentAmount: 1500,
    ...overrides,
  };
}

describe('isDebtSettled', () => {
  it('treats an outstanding balance as unsettled', () => {
    expect(isDebtSettled(-250000)).toBe(false);
    expect(isDebtSettled(-0.02)).toBe(false);
  });

  it('treats a zero or rounding-residual balance as settled', () => {
    expect(isDebtSettled(0)).toBe(true);
    expect(isDebtSettled(-0.01)).toBe(true);
    expect(isDebtSettled(-0.004)).toBe(true);
  });

  // A liability in credit owes nothing. Taking the magnitude of the balance
  // read an overpayment as debt of the same size, so a finished mortgage that
  // was overpaid by a few dollars reported its payoff as unknown.
  it('treats an overpaid (credit) balance as settled', () => {
    expect(isDebtSettled(250)).toBe(true);
  });
});

describe('deriveLoanFigures', () => {
  it('reports the payment, payoff date and remaining interest of a live loan', () => {
    const baseline = makeBaseline();
    expect(
      deriveLoanFigures({
        currentBalance: -250000,
        currentInstallment: 1500,
        baseline,
      }),
    ).toEqual({
      isSettled: false,
      currentPayment: 1500,
      payoffDate: '2031-04-15',
      remainingInterest: 12345.67,
    });
  });

  // A settled debt is a known end state, not an unknown one: reporting the
  // remaining interest as null would tell the user a finished loan could not
  // be worked out.
  it('reports a settled debt as paid off with zero interest remaining', () => {
    const figures = deriveLoanFigures({
      currentBalance: 0,
      currentInstallment: 1500,
      baseline: null,
    });
    expect(figures.isSettled).toBe(true);
    expect(figures.remainingInterest).toBe(0);
    expect(figures.payoffDate).toBeNull();
  });

  it('reports an unbuildable projection as unknown rather than zero', () => {
    const figures = deriveLoanFigures({
      currentBalance: -250000,
      currentInstallment: null,
      baseline: null,
    });
    expect(figures.currentPayment).toBeNull();
    expect(figures.payoffDate).toBeNull();
    expect(figures.remainingInterest).toBeNull();
  });

  // The schedule stops at its horizon when the installment never amortizes, so
  // its accumulated interest is the interest over that horizon -- a subtotal.
  // Showing it under "Est. Remaining Interest" would put a total's label over a
  // partial number, and the loan has no payoff date at all.
  it('withholds both figures when the projection never pays the loan off', () => {
    const figures = deriveLoanFigures({
      currentBalance: -250000,
      currentInstallment: 400,
      baseline: makeBaseline({ paidOff: false, payoffDate: null, totalInterest: 480000 }),
    });
    expect(figures.payoffDate).toBeNull();
    expect(figures.remainingInterest).toBeNull();
    expect(figures.currentPayment).toBe(400);
  });

  it('treats a non-positive installment as unknown', () => {
    expect(
      deriveLoanFigures({ currentBalance: -1000, currentInstallment: 0, baseline: null })
        .currentPayment,
    ).toBeNull();
  });
});
