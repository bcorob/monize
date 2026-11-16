import { taggedBalance } from './tagged-balance';
import { findFundingBucket, fundingCompleteness } from './tagged-funding';
import type { IncomeVsExpensesResponse } from '@/types/built-in-reports';

export interface MonthlyFundsColumn {
  /** `YYYY-MM`. */
  month: string;
  /** False when the funding answer has no row for the month: every figure is unknown. */
  known: boolean;
  income: number | null;
  taggedInflows: number | null;
  expenses: number | null;
  taggedOutflows: number | null;
  balance: number | null;
  balancePercent: number | null;
}

export interface MonthlyFundsSummary {
  columns: MonthlyFundsColumn[];
  /** Any shown month moved tagged money out: only then is the row worth a line. */
  showOutflows: boolean;
  /** False when a missing rate left a figure out: Balance is a subtotal. */
  complete: boolean;
  missingCurrencies: string[];
}

/**
 * The per-month Balance block under the Monthly Breakdown table
 * (`docs/specs/report-tag-key-breakdown.md` section 11.5), from the Income vs
 * Expenses answer for the same window. Each month goes through `taggedBalance`,
 * the one Balance formula. A month the answer does not cover is unknown, never
 * 0; a month the chosen bucket has no row for had no tagged transfer, which is
 * a known zero. Under a gap (a missing rate) Balance is a subtotal and Balance %
 * is withheld.
 */
export function monthlyFundsSummary(
  response: IncomeVsExpensesResponse,
  tagValue: string,
  months: readonly string[],
): MonthlyFundsSummary {
  const bucket = findFundingBucket(response, tagValue);
  const flowsByPeriod = new Map((bucket?.data ?? []).map((d) => [d.period, d]));
  const { complete, missingCurrencies } = fundingCompleteness(response, tagValue);

  const itemsByPeriod = new Map(response.data.map((d) => [d.period, d]));
  const columns = months.map<MonthlyFundsColumn>((month) => {
    const item = itemsByPeriod.get(month);
    if (!item) {
      return {
        month,
        known: false,
        income: null,
        taggedInflows: null,
        expenses: null,
        taggedOutflows: null,
        balance: null,
        balancePercent: null,
      };
    }
    const flows = flowsByPeriod.get(month);
    const taggedInflows = flows ? flows.taggedInflows : 0;
    const taggedOutflows = flows ? flows.taggedOutflows : 0;
    const { balance, balancePercent } = taggedBalance({
      income: item.income,
      expenses: item.expenses,
      taggedInflows,
      taggedOutflows,
    });
    return {
      month,
      known: true,
      income: item.income,
      taggedInflows,
      expenses: item.expenses,
      taggedOutflows,
      balance,
      balancePercent: complete ? balancePercent : null,
    };
  });

  return {
    columns,
    showOutflows: columns.some((c) => c.taggedOutflows !== null && c.taggedOutflows !== 0),
    complete,
    missingCurrencies,
  };
}
