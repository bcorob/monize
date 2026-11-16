import { useMemo } from 'react';
import { useReportData } from '@/hooks/useReportData';
import { accountsApi } from '@/lib/accounts';
import type { DailyBalanceTotal, DailyBalanceTotalsResponse } from '@/types/account';

/**
 * The scope's end-of-day total for every day of one calendar grid.
 *
 * One request per grid range, answered by `GET /accounts/daily-balance-totals`:
 * actual through the server's today, projected after it, both already summed
 * and converted server-side. The client neither adds a day up nor decides which
 * side of today it falls on -- `isProjected` and `today` are the server's
 * (design I1, I2).
 *
 * Scoped by ACCOUNTS only. A balance is not a filtered figure: narrowing by
 * category or payee would produce the balance of a subset of the rows that
 * moved it, which is not a balance of anything (design decision 2).
 */
export interface DailyBalanceTotalsState {
  /** The response, or null before the first successful load. */
  data: DailyBalanceTotalsResponse | null;
  /** That response's days, by date, for the cell that draws one. */
  byDay: ReadonlyMap<string, DailyBalanceTotal>;
  isLoading: boolean;
  error: Error | null;
  /** What is on screen answers a request the reader has already left. */
  isStale: boolean;
  reload: () => void;
}

/**
 * The request this layer's payload belongs to.
 *
 * The scope is sorted so the same set of accounts arriving in a different order
 * is the same question; the display currency is part of it because the totals
 * are reported in it.
 */
export function dailyBalanceTotalsKey(
  startDate: string,
  endDate: string,
  accountIds: readonly string[],
  displayCurrency: string | undefined,
): string {
  return JSON.stringify([startDate, endDate, [...accountIds].sort(), displayCurrency ?? '']);
}

export function useDailyBalanceTotals(params: {
  /** The grid's first day, `YYYY-MM-DD`. */
  startDate: string;
  /** The grid's last day; the endpoint bounds the range at 93 days. */
  endDate: string;
  /** Empty means every active account, which is what the endpoint does with no ids. */
  accountIds: readonly string[];
  displayCurrency?: string;
  /**
   * False while the Balances layer is off, so a reader who never switches it on
   * costs no request. It is part of the request key, so switching the layer on
   * asks the question rather than adopting a payload from before it was asked.
   */
  enabled: boolean;
  /** Bumped by the page after a write: the same question asked again. */
  refreshKey?: number;
}): DailyBalanceTotalsState {
  const { startDate, endDate, accountIds, displayCurrency, enabled, refreshKey = 0 } = params;

  const scopeKey = useMemo(
    () => dailyBalanceTotalsKey(startDate, endDate, accountIds, displayCurrency),
    [startDate, endDate, accountIds, displayCurrency],
  );
  const requestKey = `${enabled ? 'on' : 'off'}:${scopeKey}`;

  const result = useReportData<DailyBalanceTotalsResponse | null>(
    async () => {
      if (!enabled) return null;
      return accountsApi.getDailyBalanceTotals({
        startDate,
        endDate,
        // Absent rather than empty: the endpoint reads no ids as "every active
        // account", and an empty string would be a scope of nothing.
        accountIds: accountIds.length > 0 ? [...accountIds].join(',') : undefined,
        displayCurrency,
      });
    },
    [requestKey, refreshKey],
    { requestKey },
  );

  const byDay = useMemo(() => {
    const days = new Map<string, DailyBalanceTotal>();
    for (const day of result.data?.days ?? []) days.set(day.date, day);
    return days;
  }, [result.data]);

  const isStale = result.data !== null && result.dataKey !== requestKey;

  return useMemo(
    () => ({
      data: result.data,
      byDay,
      isLoading: result.isLoading,
      error: result.error,
      isStale,
      reload: result.reload,
    }),
    [result.data, result.isLoading, result.error, result.reload, byDay, isStale],
  );
}
