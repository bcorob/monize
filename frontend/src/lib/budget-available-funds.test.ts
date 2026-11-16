import { describe, it, expect } from 'vitest';
import { budgetFundsSeries, trendWindow } from './budget-available-funds';
import type { BudgetTrendPoint } from '@/types/budget';
import type { IncomeVsExpensesResponse } from '@/types/built-in-reports';

const point = (monthKey: string, budgeted: number, actual: number): BudgetTrendPoint => ({
  monthKey,
  budgeted,
  actual,
  variance: actual - budgeted,
  percentUsed: Math.round((actual / budgeted) * 100),
});
const totals = { income: 6279, expenses: 0, net: 0, knownIncome: 6279, knownExpenses: 0, knownNet: 0 };
const period = (p: string, income: number) => ({
  period: p,
  periodStart: `${p}-01`,
  periodEnd: `${p}-28`,
  income,
  expenses: 0,
  net: income,
});
const flow = (p: string, taggedInflows: number, taggedOutflows = 0) => ({
  ...period(p, 0),
  taggedInflows,
  taggedOutflows,
});
const response = (over: Partial<IncomeVsExpensesResponse> = {}): IncomeVsExpensesResponse => ({
  data: [period('2026-07', 3000), period('2026-08', 3279)],
  totals,
  currency: 'CAD',
  missingCurrencies: [],
  excludedCount: 0,
  tagKey: 'scope',
  buckets: [
    {
      value: 'household',
      isUntagged: false,
      data: [flow('2026-07', 0, 200), flow('2026-08', 4516)],
      totals,
      taggedInflows: 4516,
      taggedOutflows: 200,
      missingCurrencies: [],
      excludedCount: 0,
    },
  ],
  ...over,
});

describe('budgetFundsSeries', () => {
  it("adds income + tagged inflows - tagged outflows per month: August 3,279 + 4,516 = 7,795", () => {
    const { points, complete } = budgetFundsSeries(
      [point('2026-07', 2500, 2300), point('2026-08', 8000, 8486)],
      response(),
      'household',
    );
    expect(points[0].availableFunds).toBe(2800);
    expect(points[0].actualVsAvailable).toBe(500);
    expect(points[1].availableFunds).toBe(7795);
    // Actual 8,486 against 7,795 available: 691 over.
    expect(points[1].actualVsAvailable).toBe(-691);
    expect(complete).toBe(true);
  });

  it('leaves every budget figure exactly as the server sent it', () => {
    const trend = [point('2026-07', 2500, 2300), point('2026-08', 8000, 8486)];
    const { points } = budgetFundsSeries(trend, response(), 'household');
    points.forEach((p, i) => {
      const { availableFunds, actualVsAvailable, ...budget } = p;
      void availableFunds;
      void actualVsAvailable;
      expect(budget).toEqual(trend[i]);
    });
  });

  it('shows a month the funding answer lacks as unknown, not zero', () => {
    const { points } = budgetFundsSeries(
      [point('2026-08', 8000, 8486), point('2026-09', 8000, 100)],
      response(),
      'household',
    );
    expect(points[1].availableFunds).toBeNull();
    expect(points[1].actualVsAvailable).toBeNull();
  });

  it('ignores funding months the budget trend does not have', () => {
    const { points } = budgetFundsSeries([point('2026-08', 8000, 100)], response(), 'household');
    expect(points).toHaveLength(1);
  });

  it('reads an absent bucket as known-zero tagged flows', () => {
    const { points } = budgetFundsSeries([point('2026-08', 8000, 100)], response(), 'stall');
    expect(points[0].availableFunds).toBe(3279);
  });

  it('marks the series incomplete when a rate is missing', () => {
    const r = response({ missingCurrencies: ['EUR'], excludedCount: 1 });
    expect(budgetFundsSeries([point('2026-08', 1, 1)], r, 'household')).toMatchObject({
      complete: false,
      missingCurrencies: ['EUR'],
    });
  });
});

describe('trendWindow', () => {
  it('spans the first of the earliest month to the last day of the latest', () => {
    expect(trendWindow([point('2026-08', 1, 1), point('2026-02', 1, 1), point('2026-05', 1, 1)])).toEqual({
      startDate: '2026-02-01',
      endDate: '2026-08-31',
    });
  });

  it('has no window for an empty trend', () => {
    expect(trendWindow([])).toBeNull();
  });
});
