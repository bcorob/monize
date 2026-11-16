import { describe, it, expect } from 'vitest';
import {
  deriveLoanFigures,
  isDebtSettled,
  loanNotAmortizingReason,
} from './loan-figures';
import type { LoanScheduleInput, LoanScheduleResult } from './loan-schedule';

function makeBaseline(overrides: Partial<LoanScheduleResult> = {}): LoanScheduleResult {
  return {
    rows: [],
    payoffDate: '2031-04-15',
    totalInterest: 12345.67,
    totalPaid: 90000,
    totalExtraPrincipal: 0,
    numPayments: 60,
    paidOff: true,
    coveredInterest: true,
    finalPaymentAmount: 1500,
    ...overrides,
  };
}

function makeInput(
  overrides: Partial<LoanScheduleInput> = {},
): LoanScheduleInput {
  return {
    startingBalance: 135662.61,
    annualRate: 5.5,
    paymentAmount: 591.67,
    frequency: 'MONTHLY',
    mortgageType: 'ANNUITY',
    firstPaymentDate: new Date('2026-09-05'),
    rateChanges: [],
    ...overrides,
  };
}

describe('isDebtSettled', () => {
  it('treats an outstanding balance as unsettled', () => {
    expect(isDebtSettled(-250000)).toBe(false);
    expect(isDebtSettled(-0.02)).toBe(false);
    // One whole minor unit is owed (A26-S15-06), not a rounding residue.
    expect(isDebtSettled(-0.01)).toBe(false);
  });

  it('treats a zero or rounding-residual balance as settled', () => {
    expect(isDebtSettled(0)).toBe(true);
    expect(isDebtSettled(-0.0099)).toBe(true);
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
      currentPaymentDate: null,
      finalPayment: null,
      payoffDate: '2031-04-15',
      remainingInterest: 12345.67,
    });
  });

  it('carries the date of a dated installment and an interest-only bullet', () => {
    const figures = deriveLoanFigures({
      currentBalance: -300000,
      currentInstallment: 500,
      currentInstallmentDate: '2024-01-01',
      finalPayment: { amount: 300500, date: '2053-12-01' },
      baseline: makeBaseline(),
    });
    expect(figures.currentPaymentDate).toBe('2024-01-01');
    expect(figures.finalPayment).toEqual({ amount: 300500, date: '2053-12-01' });
  });

  it('dates no installment that is unknown, and no bullet once settled', () => {
    expect(
      deriveLoanFigures({
        currentBalance: -300000,
        currentInstallment: null,
        currentInstallmentDate: '2024-01-01',
        baseline: makeBaseline(),
      }).currentPaymentDate,
    ).toBeNull();
    expect(
      deriveLoanFigures({
        currentBalance: 0,
        currentInstallment: 500,
        finalPayment: { amount: 300500, date: '2053-12-01' },
        baseline: null,
      }).finalPayment,
    ).toBeNull();
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

describe('loanNotAmortizingReason', () => {
  // docs/specs/mortgage-types.md section 5.4: these methods set the principal
  // independently of the interest, so neither reason applies.
  it.each(['LINEAR', 'INTEREST_ONLY'] as const)('does not apply to a %s mortgage', (type) => {
    expect(
      loanNotAmortizingReason(
        makeInput({ mortgageType: type }),
        makeBaseline({ paidOff: false, coveredInterest: false }),
      ),
    ).toBeNull();
  });

  it('is null when there is no projection or it pays off', () => {
    expect(loanNotAmortizingReason(null, makeBaseline())).toBeNull();
    expect(loanNotAmortizingReason(makeInput(), null)).toBeNull();
    expect(
      loanNotAmortizingReason(makeInput(), makeBaseline({ paidOff: true })),
    ).toBeNull();
  });

  it("reports 'payment-below-interest' with the two figures to compare", () => {
    // 135662.61 * 5.5% / 12 = 621.79; the 591.67 installment is below it.
    const reason = loanNotAmortizingReason(
      makeInput(),
      makeBaseline({ paidOff: false, coveredInterest: false }),
    );
    expect(reason).toEqual({
      kind: 'payment-below-interest',
      payment: 591.67,
      periodInterest: 621.79,
      annualRate: 5.5,
    });
  });

  it("reports 'beyond-horizon' when the payment covers interest but the term is too long", () => {
    const reason = loanNotAmortizingReason(
      makeInput({ paymentAmount: 700 }),
      makeBaseline({ paidOff: false, coveredInterest: true }),
    );
    expect(reason).toEqual({ kind: 'beyond-horizon' });
  });
});
