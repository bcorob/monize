import { taggedBalanceWindow, taggedFunds } from './tagged-balance';
import { mergeCompleteness, type FundingWindow } from './tagged-funding';
import type { ConvertedTotal } from './currency-total';

/** The part of a Spending by Category response the strip reads. */
export interface SpendingTotals {
  /** What converted; the figure the donut shows. */
  knownSpending: number;
  totalSpending: number | null;
  missingCurrencies: string[];
  excludedCount: number;
}

export interface SpendingFunds {
  income: number;
  netTagged: number | null;
  availableFunds: number | null;
  spent: number;
  balance: number | null;
  balancePercent: number | null;
  /** Each figure's own gaps, for `PartialTotal`. */
  incomeTotal: ConvertedTotal;
  taggedTotal: ConvertedTotal;
  availableTotal: ConvertedTotal;
  spentTotal: ConvertedTotal;
  balanceTotal: ConvertedTotal;
}

/**
 * The header strip of Spending by Category with the switch on
 * (`docs/specs/report-tag-key-breakdown.md` section 11.4):
 *
 *   available funds = income + net tagged transfers     (income: the funding answer's All income)
 *   spent           = the report's own total            (carries the value filter)
 *   balance         = available funds - spent
 *   balance %       = balance / (income + tagged inflows) * 100
 *
 * Balance is `taggedBalanceWindow` over those four amounts; a gap in any of
 * the spending response, the funding answer's All figures or the bucket makes
 * Balance a subtotal and withholds Balance %.
 */
export function spendingFunds(spending: SpendingTotals, window: FundingWindow): SpendingFunds {
  const spentGaps = {
    missingCurrencies: spending.missingCurrencies,
    excludedCount: spending.excludedCount,
  };
  const { netTagged, availableFunds } = taggedFunds({
    income: window.knownIncome,
    taggedInflows: window.taggedInflows,
    taggedOutflows: window.taggedOutflows,
  });
  const win = taggedBalanceWindow(
    {
      income: window.knownIncome,
      expenses: spending.knownSpending,
      taggedInflows: window.taggedInflows,
      taggedOutflows: window.taggedOutflows,
    },
    window.allTotalsKnown && spending.totalSpending !== null,
    mergeCompleteness(window.all, spentGaps),
    window.bucket,
  );
  return {
    income: window.knownIncome,
    netTagged,
    availableFunds,
    spent: spending.knownSpending,
    balance: win.balance,
    balancePercent: win.balancePercent,
    incomeTotal: { value: window.knownIncome, ...window.all },
    taggedTotal: { value: netTagged ?? 0, ...window.bucket },
    availableTotal: { value: availableFunds ?? 0, ...mergeCompleteness(window.all, window.bucket) },
    spentTotal: { value: spending.knownSpending, ...spentGaps },
    balanceTotal: {
      value: win.balance ?? 0,
      missingCurrencies: win.missingCurrencies,
      excludedCount: win.excludedCount,
    },
  };
}
