import { describe, it, expect } from 'vitest';
import { createScenarioLabels } from './loan-scenario-labels';
import type { LoanScenario } from '@/types/loan-scenario';
import type { ScenarioComparison } from '@/lib/loan-schedule';

const labels = createScenarioLabels({
  t: (key, values) => `${key}${values ? ':' + Object.values(values).join(',') : ''}`,
  formatCurrency: (amount) => `$${amount.toFixed(2)}`,
  formatChartDate: (date) => date.slice(0, 7),
  currencyCode: 'PLN',
});

const scenario = {
  id: 's1',
  name: 'Extra 200',
  recurringExtraAmount: 200,
  lumpSums: [{ date: '2026-06-01', amount: 5000 }],
} as LoanScenario;

const comparison = {
  scenario: { payoffDate: '2040-06-15', finalPaymentAmount: 500 },
  paymentsSaved: 24,
  monthsSaved: 24,
  interestSaved: 15000,
  installmentReduction: 0,
} as unknown as ScenarioComparison;

describe('createScenarioLabels', () => {
  it('builds the comparison table exactly as the panel displays it', () => {
    const table = labels.comparisonTable([scenario], new Map([['s1', comparison]]));

    expect(table.headers).toHaveLength(6);
    expect(table.rows).toEqual([
      [
        'Extra 200',
        '$200.00',
        'loanDetail.scenarios.recurringSummary:$200.00 + loanDetail.scenarios.lumpSumSummary:1',
        '2040-06',
        'loanDetail.comparison.monthsSaved:24',
        '$15000.00',
      ],
    ]);
  });

  it('renders em dashes for scenarios without a projectable comparison', () => {
    const table = labels.comparisonTable([scenario], new Map([['s1', null]]));
    expect(table.rows[0].slice(3)).toEqual(['—', '—', '—']);
  });

  it('reflects a non-monthly cadence in the overpayment label and summary', () => {
    const quarterly = {
      id: 's2',
      name: 'Quarterly 300',
      recurringExtraAmount: 300,
      recurringExtraFrequency: 'QUARTERLY',
      lumpSums: [],
    } as unknown as LoanScenario;

    expect(labels.overpaymentLabel(quarterly)).toBe(
      'loanDetail.scenarios.overpaymentWithFrequency:$300.00,loanDetail.simulator.frequencyQuarterly',
    );
    expect(labels.describeScenario(quarterly)).toBe(
      'loanDetail.scenarios.overpaymentWithFrequency:$300.00,loanDetail.simulator.frequencyQuarterly',
    );
  });

  it('renders an em dash for a saving that is unknown', () => {
    // A schedule that stopped at the projection horizon has no lifetime figure
    // to compare, so the table shows the same em dash as a missing comparison
    // rather than "0 payments" or "$0.00".
    const incomparable = {
      scenario: { payoffDate: null, finalPaymentAmount: 500 },
      paymentsSaved: null,
      monthsSaved: null,
      interestSaved: null,
      installmentReduction: 0,
    } as unknown as ScenarioComparison;

    expect(labels.timeSavedLabel(incomparable)).toBe('\u2014');
    expect(labels.interestSavedLabel(incomparable)).toBe('\u2014');
    expect(labels.payoffLabel(incomparable)).toBe(
      'loanDetail.comparison.beyondProjection',
    );
  });

  it('says nothing rather than 0.00 when a truncated comparison is lower-installment', () => {
    // The state this replaced could not occur: it set installmentReduction to a
    // number beside three nulls, but `compareSchedules` gates all four on the
    // single `baseline.paidOff && scenario.paidOff` flag, so the reduction is
    // null exactly when the others are. A fixture the producer cannot produce
    // pins a branch nothing reaches, and it would have stayed green while the
    // real path broke.
    //
    // The reachable truncated state is all four null, and it is read with the
    // MODE the caller now always supplies -- the parameter that exists because
    // inferring lower-installment from a null reduction is what the old
    // heuristic did.
    const truncated = {
      scenario: { payoffDate: null, finalPaymentAmount: 400 },
      paymentsSaved: null,
      monthsSaved: null,
      interestSaved: null,
      installmentReduction: null,
    } as unknown as ScenarioComparison;

    expect(labels.timeSavedLabel(truncated, 'LOWER_INSTALLMENT')).toBe('—');
  });

  it('reports the drop when a lower-installment comparison did complete', () => {
    // The state that IS reachable: both schedules paid off, so all four figures
    // are numbers, and the mode comes from the plan rather than from the drop.
    const lowered = {
      scenario: { payoffDate: '2036-01-15', finalPaymentAmount: 400 },
      paymentsSaved: 0,
      monthsSaved: 0,
      interestSaved: 4200,
      installmentReduction: 100,
    } as unknown as ScenarioComparison;

    expect(labels.timeSavedLabel(lowered, 'LOWER_INSTALLMENT')).toBe(
      'loanDetail.comparison.installmentDrop:$400.00,$100.00',
    );
  });
});
