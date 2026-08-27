import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { ComparisonSummaryCards } from './ComparisonSummaryCards';
import { compareSchedules, generateLoanSchedule } from '@/lib/loan-schedule';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (amount: number) => `$${amount.toFixed(2)}`,
  }),
}));

/**
 * A comparison whose baseline runs past the projection horizon, so no lifetime
 * saving exists: 500k at 6% paying 2510 a month never clears inside 50 years.
 */
function makeIncomparable() {
  const input = {
    startingBalance: 500000,
    annualRate: 6,
    paymentAmount: 2510,
    frequency: 'MONTHLY' as const,
    firstPaymentDate: new Date(2026, 0, 15),
  };
  const baseline = generateLoanSchedule(input);
  const scenario = generateLoanSchedule({
    ...input,
    overpayments: { recurringExtra: { amount: 100, frequency: 'MONTHLY' } },
  });
  return compareSchedules(baseline, scenario);
}

function makeComparison(paymentAmount = 500) {
  const input = {
    startingBalance: 10000,
    annualRate: 6,
    paymentAmount,
    frequency: 'MONTHLY' as const,
    firstPaymentDate: new Date(2026, 0, 15),
  };
  const baseline = generateLoanSchedule(input);
  const scenario = generateLoanSchedule({
    ...input,
    overpayments: { recurringExtra: { amount: 200 } },
  });
  return compareSchedules(baseline, scenario);
}

describe('ComparisonSummaryCards', () => {
  it('shows the scenario payoff date, time saved, and savings', () => {
    const comparison = makeComparison();
    render(<ComparisonSummaryCards comparison={comparison} currencyCode="CAD" />);

    expect(screen.getByText('New Payoff Date')).toBeInTheDocument();
    expect(screen.getByText('Time Saved')).toBeInTheDocument();
    expect(screen.getByText(`${comparison.monthsSaved} months`)).toBeInTheDocument();
    expect(screen.getByText('Interest Saved')).toBeInTheDocument();
    expect(
      screen.getByText(`$${comparison.interestSaved!.toFixed(2)}`),
    ).toBeInTheDocument();
    expect(screen.getByText('Total Extra Contributed')).toBeInTheDocument();
    expect(
      screen.getByText(`$${comparison.scenario.totalExtraPrincipal.toFixed(2)}`),
    ).toBeInTheDocument();
  });

  it('falls back to payments saved when no whole month is saved', () => {
    const baseline = generateLoanSchedule({
      startingBalance: 1000,
      annualRate: 6,
      paymentAmount: 500,
      frequency: 'MONTHLY',
      firstPaymentDate: new Date(2026, 0, 15),
    });
    const comparison = compareSchedules(baseline, baseline);
    render(<ComparisonSummaryCards comparison={comparison} currencyCode="CAD" />);

    expect(screen.getByText('0 payments')).toBeInTheDocument();
    // Interest saved and extra contributed are both $0.00
    expect(screen.getAllByText('$0.00')).toHaveLength(2);
  });

  it('labels a scenario that still never pays off', () => {
    const neverPaysOff = generateLoanSchedule({
      startingBalance: 10000,
      annualRate: 60,
      paymentAmount: 100,
      frequency: 'MONTHLY',
      firstPaymentDate: new Date(2026, 0, 15),
    });
    const comparison = compareSchedules(neverPaysOff, neverPaysOff);
    render(<ComparisonSummaryCards comparison={comparison} currencyCode="CAD" />);

    expect(screen.getByText('Beyond projection')).toBeInTheDocument();
  });

  it('says Unknown rather than 0.00 when the saving cannot be worked out', () => {
    const comparison = makeIncomparable();
    // Both sides of the guard: the schedule really is truncated, and the cards
    // do not print a number for either saving.
    expect(comparison.baseline.paidOff).toBe(false);
    expect(comparison.interestSaved).toBeNull();
    expect(comparison.monthsSaved).toBeNull();

    render(<ComparisonSummaryCards comparison={comparison} currencyCode="CAD" />);

    expect(screen.getByText('Interest Saved')).toBeInTheDocument();
    expect(screen.getByText('Time Saved')).toBeInTheDocument();
    // Two: the time saved and the interest saved, both differences of two
    // schedules where one never ended. The resulting monthly payment is NOT one
    // of them -- this is a SHORTEN_TERM plan, so its installment is the
    // contractual figure the plan never changes, known whether or not the
    // schedule reached payoff. It used to read "Unknown" as well, printing "not
    // known" over a number the borrower had typed in themselves.
    expect(screen.getAllByText('Unknown')).toHaveLength(2);
    // And nothing anywhere claiming a zero saving.
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
    expect(screen.queryByText('0 payments')).not.toBeInTheDocument();
    expect(screen.queryByText('0 months')).not.toBeInTheDocument();
  });

  it('keeps a SHORTEN_TERM installment known when the schedule is truncated', () => {
    // Truncation makes a DIFFERENCE unknown -- time saved, interest saved, the
    // installment drop -- because each subtracts two schedules and one of them
    // never ended. It does not make the borrower's own inputs unknown: a
    // shorten-term plan keeps the contractual installment, so the resulting
    // outlay is installment + extra whether or not the projection reached
    // payoff. `null` means "not known", and a state that IS known must not use
    // it.
    const comparison = makeIncomparable();
    expect(comparison.scenario.paidOff).toBe(false);
    render(
      <ComparisonSummaryCards
        comparison={comparison}
        currencyCode="CAD"
        recurringOverpayment={{ amount: 100, frequency: 'MONTHLY', mode: 'SHORTEN_TERM' }}
        loanFrequency="MONTHLY"
      />,
    );

    const expected =
      Math.round((comparison.scenario.finalPaymentAmount + 100) * 100) / 100;
    expect(screen.getByText(`$${expected.toFixed(2)}`)).toBeInTheDocument();
    // The two genuine unknowns are still unknown.
    expect(screen.getAllByText('Unknown')).toHaveLength(2);
  });

  it('leaves a LOWER_INSTALLMENT installment unknown when the schedule is truncated', () => {
    // The branch the gate really belongs to: here `finalPaymentAmount` is a
    // re-levelled figure at whatever row the horizon stopped on, so a truncated
    // plan has no resulting installment to report.
    const comparison = makeIncomparable();
    render(
      <ComparisonSummaryCards
        comparison={comparison}
        currencyCode="CAD"
        recurringOverpayment={{ amount: 100, frequency: 'MONTHLY', mode: 'LOWER_INSTALLMENT' }}
        loanFrequency="MONTHLY"
      />,
    );

    expect(screen.getByText('Monthly Payment')).toBeInTheDocument();
    const wouldBe = comparison.scenario.finalPaymentAmount;
    expect(screen.queryByText(`$${wouldBe.toFixed(2)}`)).not.toBeInTheDocument();
    // Three unknowns here: time saved, interest saved, and the installment drop
    // -- plus the payment card itself, which shares the drop's reason.
    expect(screen.getAllByText('Unknown').length).toBeGreaterThanOrEqual(3);
  });

  it('reads the mode from the plan, not from the installment drop', () => {
    // A LOWER_INSTALLMENT plan on a baseline that stopped at the horizon: the
    // drop is null, so inferring the mode from it read the scenario as
    // SHORTEN_TERM -- which offers "time saved" for a plan that holds the end
    // date fixed and adds the overpayment on top of an already-reduced
    // installment, counting the same money twice.
    const comparison = makeIncomparable();
    render(
      <ComparisonSummaryCards
        comparison={comparison}
        currencyCode="CAD"
        recurringOverpayment={{ amount: 100, frequency: 'MONTHLY', mode: 'LOWER_INSTALLMENT' }}
        loanFrequency="MONTHLY"
      />,
    );

    // The installment headline, not the time-saved one.
    expect(screen.getByText('New Installment')).toBeInTheDocument();
    expect(screen.queryByText('Time Saved')).not.toBeInTheDocument();
    // The drop itself is unknown rather than 0.00, and so is the resulting
    // payment: `finalPaymentAmount` on a truncated schedule is a mid-schedule
    // installment. What is asserted is that neither is a confident number, and
    // in particular that the overpayment is NOT added on top of an
    // already-reduced installment (which is what reading the mode off the null
    // drop produced).
    expect(comparison.installmentReduction).toBeNull();
    expect(screen.getAllByText('Unknown').length).toBeGreaterThanOrEqual(3);
    const wrongTotal =
      Math.round((comparison.scenario.finalPaymentAmount + 100) * 100) / 100;
    expect(screen.queryByText(`$${wrongTotal.toFixed(2)}`)).not.toBeInTheDocument();
  });

  it('adds the extra on top for a SHORTEN_TERM plan', () => {
    // The other half of the same decision: a shorten-term plan keeps the
    // installment, so the resulting outlay is installment + extra.
    const comparison = makeComparison();
    render(
      <ComparisonSummaryCards
        comparison={comparison}
        currencyCode="CAD"
        recurringOverpayment={{ amount: 100, frequency: 'MONTHLY', mode: 'SHORTEN_TERM' }}
        loanFrequency="MONTHLY"
      />,
    );

    expect(screen.getByText('Time Saved')).toBeInTheDocument();
    expect(screen.queryByText('New Installment')).not.toBeInTheDocument();
    const expected = Math.round((comparison.scenario.finalPaymentAmount + 100) * 100) / 100;
    expect(screen.getByText(`$${expected.toFixed(2)}`)).toBeInTheDocument();
  });
});
