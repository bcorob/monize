import type {
  IncomeExpenseTagBucket,
  IncomeVsExpensesResponse,
} from '@/types/built-in-reports';
import type { BalanceCompleteness } from './tagged-balance';

/**
 * Reading the Income vs Expenses answer for the funding view of the other
 * reports (`docs/specs/report-tag-key-breakdown.md` section 11): one place
 * decides which bucket a chosen value means and what an absent one says, so no
 * report restates it.
 */

/** The bucket of the chosen value. The reserved untagged bucket is never one (F6). */
export function findFundingBucket(
  response: IncomeVsExpensesResponse | null | undefined,
  tagValue: string,
): IncomeExpenseTagBucket | undefined {
  return response?.buckets?.find((b) => !b.isUntagged && b.value === tagValue);
}

export interface FundingWindow {
  /** The All totals' income that converted (the figure the Balance view of 10.9 uses). */
  knownIncome: number;
  /** False when the All totals are null (a row could not be converted). */
  allTotalsKnown: boolean;
  /** Completeness of the All figures. */
  all: BalanceCompleteness;
  /**
   * The chosen bucket's window flows. An absent bucket means no row carries the
   * value in the window, a known zero rather than an unknown.
   */
  taggedInflows: number;
  taggedOutflows: number;
  bucket: BalanceCompleteness;
}

const NO_GAPS: BalanceCompleteness = { missingCurrencies: [], excludedCount: 0 };

export function fundingWindow(
  response: IncomeVsExpensesResponse,
  tagValue: string,
): FundingWindow {
  const bucket = findFundingBucket(response, tagValue);
  return {
    knownIncome: response.totals.knownIncome,
    allTotalsKnown: response.totals.income !== null,
    all: {
      missingCurrencies: response.missingCurrencies,
      excludedCount: response.excludedCount,
    },
    taggedInflows: bucket?.taggedInflows ?? 0,
    taggedOutflows: bucket?.taggedOutflows ?? 0,
    bucket: bucket
      ? { missingCurrencies: bucket.missingCurrencies, excludedCount: bucket.excludedCount }
      : NO_GAPS,
  };
}

/** The union of several figures' gaps: every currency named, every exclusion counted. */
export function mergeCompleteness(...parts: BalanceCompleteness[]): BalanceCompleteness {
  return {
    missingCurrencies: [...new Set(parts.flatMap((p) => p.missingCurrencies))],
    excludedCount: parts.reduce((sum, p) => sum + p.excludedCount, 0),
  };
}

export interface FundingCompleteness {
  /** True only when every component is known: the All totals and the bucket. */
  complete: boolean;
  missingCurrencies: string[];
  excludedCount: number;
}

/**
 * Whether the per-period figures read from the funding answer are complete: the
 * All totals are known and neither the response nor the chosen bucket left a row
 * out. The server does not say WHICH period lost a row, so a gap marks every
 * period's figure as a subtotal.
 */
export function fundingCompleteness(
  response: IncomeVsExpensesResponse,
  tagValue: string,
): FundingCompleteness {
  const bucket = findFundingBucket(response, tagValue);
  const gaps = mergeCompleteness(
    { missingCurrencies: response.missingCurrencies, excludedCount: response.excludedCount },
    bucket
      ? { missingCurrencies: bucket.missingCurrencies, excludedCount: bucket.excludedCount }
      : NO_GAPS,
  );
  return {
    complete:
      response.totals.income !== null &&
      gaps.missingCurrencies.length === 0 &&
      gaps.excludedCount === 0,
    ...gaps,
  };
}

/** Last day of a `YYYY-MM` month as `YYYY-MM-DD`, by calendar arithmetic (no local-time Date). */
export function monthEndYmd(monthKey: string): string {
  const [year, month] = monthKey.split('-').map(Number);
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${monthKey}-${String(day).padStart(2, '0')}`;
}
