import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import type { PayrollDeductionRule } from '@/types/payroll-deduction';
import { groupYearToDateRows, PayrollDeductionYearToDate } from './PayrollDeductionYearToDate';

const rule = (overrides: Partial<PayrollDeductionRule> = {}): PayrollDeductionRule => ({
  id: 'rule-1',
  userId: 'u1',
  scheduledTransactionId: 'st-pay',
  scheduledTransactionName: 'Paycheque',
  categoryId: 'cat-ei',
  categoryName: 'EI',
  yearlyMaximum: 1077.48,
  resetPeriod: 'YEARLY',
  resetDate: '2026-01-01',
  periodStart: '2026-01-01',
  periodEnd: '2026-12-31',
  nextResetOn: '2027-01-01',
  paidToDate: 1024,
  remaining: 53.48,
  foreignCurrencyRows: 0,
  currencyCode: 'CAD',
  expectedPerPaycheque: 64,
  expectedSource: 'line',
  createdAt: '',
  updatedAt: '',
  ...overrides,
});

describe('groupYearToDateRows', () => {
  it('folds the rules of two paycheques on one category into one row, the lower ceiling binding', () => {
    const rows = groupYearToDateRows([
      rule(),
      rule({ id: 'rule-2', scheduledTransactionId: 'st-mid', scheduledTransactionName: 'Mid-month', yearlyMaximum: 1000, remaining: -24 }),
      rule({ id: 'rule-3', categoryId: 'cat-cpp', categoryName: 'CPP', yearlyMaximum: 4034.1, paidToDate: 3000, remaining: 1034.1 }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      categoryName: 'EI',
      billNames: ['Paycheque', 'Mid-month'],
      paidToDate: 1024,
      yearlyMaximum: 1000,
      remaining: -24,
    });
    expect(rows[1]).toMatchObject({ categoryName: 'CPP', billNames: ['Paycheque'] });
  });

  it('keeps the same category apart when the bills pay in different currencies or measure different periods', () => {
    const rows = groupYearToDateRows([rule(), rule({ id: 'rule-2', currencyCode: 'USD' })]);
    expect(rows.map((r) => r.currencyCode)).toEqual(['CAD', 'USD']);
    const periods = groupYearToDateRows([
      rule(),
      rule({ id: 'rule-3', periodStart: '2026-04-01', periodEnd: '2027-03-31', nextResetOn: '2027-04-01', yearlyMaximum: 900 }),
    ]);
    expect(periods.map((r) => [r.periodStart, r.yearlyMaximum])).toEqual([['2026-01-01', 1077.48], ['2026-04-01', 900]]);
  });
});

describe('PayrollDeductionYearToDate', () => {
  it('shows a category once, naming every bill that caps it', () => {
    render(
      <PayrollDeductionYearToDate
        rules={[rule(), rule({ id: 'rule-2', scheduledTransactionId: 'st-mid', scheduledTransactionName: 'Mid-month' })]}
      />,
    );
    expect(screen.getAllByText('EI')).toHaveLength(1);
    expect(screen.getByText('Paycheque and Mid-month')).toBeInTheDocument();
    expect(screen.getAllByText('$1,024.00')).toHaveLength(1);
  });
});
