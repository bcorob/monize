import { sumMoney } from './format';
import { taggedFunds } from './tagged-balance';
import { findFundingBucket, fundingCompleteness, monthEndYmd } from './tagged-funding';
import type { BudgetTrendPoint } from '@/types/budget';
import type { IncomeVsExpensesResponse } from '@/types/built-in-reports';

/** A budget trend point with the funding view's two extra figures. */
export interface BudgetFundsPoint extends BudgetTrendPoint {
  /**
   * `income + taggedInflows - taggedOutflows` for the month; null when the
   * funding answer has no row for it (unknown, never 0).
   */
  availableFunds: number | null;
  /** `availableFunds - actual`: positive is money left. Null when funds are unknown. */
  actualVsAvailable: number | null;
}

export interface BudgetFundsSeries {
  points: BudgetFundsPoint[];
  /** False when a missing rate left a figure out: the series is a set of subtotals. */
  complete: boolean;
  missingCurrencies: string[];
}

/**
 * The Available funds series of Budget vs Actual
 * (`docs/specs/report-tag-key-breakdown.md` section 11.6). Months align by
 * `monthKey` (the funding answer's `period` is the same `YYYY-MM`). The budget
 * figures of every point are the server's, untouched; a month the funding
 * answer does not cover is unknown, and a month the chosen bucket has no row
 * for had no tagged transfer, which is a known zero.
 */
export function budgetFundsSeries(
  trend: readonly BudgetTrendPoint[],
  response: IncomeVsExpensesResponse,
  tagValue: string,
): BudgetFundsSeries {
  const bucket = findFundingBucket(response, tagValue);
  const flowsByPeriod = new Map((bucket?.data ?? []).map((d) => [d.period, d]));
  const itemsByPeriod = new Map(response.data.map((d) => [d.period, d]));
  const { complete, missingCurrencies } = fundingCompleteness(response, tagValue);

  const points = trend.map<BudgetFundsPoint>((point) => {
    const item = itemsByPeriod.get(point.monthKey);
    if (!item) return { ...point, availableFunds: null, actualVsAvailable: null };
    const flows = flowsByPeriod.get(point.monthKey);
    const { availableFunds } = taggedFunds({
      income: item.income,
      taggedInflows: flows ? flows.taggedInflows : 0,
      taggedOutflows: flows ? flows.taggedOutflows : 0,
    });
    return {
      ...point,
      availableFunds,
      actualVsAvailable:
        availableFunds === null ? null : sumMoney([availableFunds, -point.actual]),
    };
  });
  return { points, complete, missingCurrencies };
}

/** The first and last day the trend covers, for the funding request; null for an empty trend. */
export function trendWindow(
  trend: readonly BudgetTrendPoint[],
): { startDate: string; endDate: string } | null {
  if (trend.length === 0) return null;
  const keys = trend.map((p) => p.monthKey).sort();
  return { startDate: `${keys[0]}-01`, endDate: monthEndYmd(keys[keys.length - 1]) };
}
