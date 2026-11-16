import { useMemo } from 'react';
import { useReportData } from '@/hooks/useReportData';
import { netWorthApi } from '@/lib/net-worth';
import type { DailyInvestmentValue } from '@/types/net-worth';

/**
 * The scope's market value plus cash, one point per calendar day of a grid.
 *
 * History only. A market value has no honest forward series, and projecting the
 * cash sleeve alone would put a subtotal under a value's caption, so the range
 * asked for is clamped at today and a day past it simply has no point (design
 * decision 7).
 *
 * Completeness is the response's: `pricesComplete === false`,
 * `fxComplete === false` or `cashComplete === false` is a value the server could
 * not work out, and an
 * ABSENT flag is no information rather than a claim of completeness, which is
 * why both reads are `=== false` (INV-HOLDING-002).
 */
export interface InvestmentDailyValuesState {
  byDay: ReadonlyMap<string, DailyInvestmentValue>;
  isLoading: boolean;
  error: Error | null;
  isStale: boolean;
  reload: () => void;
}

/** Whether a day's value is one the server could actually work out. */
export function isDailyValueComplete(point: DailyInvestmentValue): boolean {
  return (
    point.pricesComplete !== false &&
    point.fxComplete !== false &&
    point.cashComplete !== false
  );
}

export function investmentDailyValuesKey(
  startDate: string,
  endDate: string,
  accountIds: readonly string[],
  displayCurrency: string | undefined,
): string {
  return JSON.stringify([startDate, endDate, [...accountIds].sort(), displayCurrency ?? '']);
}

export function useInvestmentDailyValues(params: {
  /** The grid's first day. */
  startDate: string;
  /** The grid's last day, before the clamp at today. */
  endDate: string;
  /** The financial today; the series stops here, whatever the grid shows. */
  today: string;
  accountIds: readonly string[];
  displayCurrency?: string;
  enabled: boolean;
  refreshKey?: number;
}): InvestmentDailyValuesState {
  const { startDate, endDate, today, accountIds, displayCurrency, enabled, refreshKey = 0 } =
    params;

  // A grid that lies entirely in the future has nothing to ask about; asking
  // anyway would return the clamped end alone and place today's value on a day
  // it is not the value of.
  const clampedEnd = endDate > today ? today : endDate;
  const inRange = startDate <= clampedEnd;

  const requestKey = `${enabled && inRange ? 'on' : 'off'}:${investmentDailyValuesKey(
    startDate,
    clampedEnd,
    accountIds,
    displayCurrency,
  )}`;

  const result = useReportData<DailyInvestmentValue[] | null>(
    async () => {
      if (!enabled || !inRange) return null;
      return netWorthApi.getInvestmentsDaily({
        startDate,
        endDate: clampedEnd,
        accountIds: accountIds.length > 0 ? [...accountIds].join(',') : undefined,
        displayCurrency,
      });
    },
    [requestKey, refreshKey],
    { requestKey },
  );

  const byDay = useMemo(() => {
    const days = new Map<string, DailyInvestmentValue>();
    for (const point of result.data ?? []) days.set(point.date, point);
    return days;
  }, [result.data]);

  const isStale = result.data !== null && result.dataKey !== requestKey;

  return useMemo(
    () => ({
      byDay,
      isLoading: result.isLoading,
      error: result.error,
      isStale,
      reload: result.reload,
    }),
    [byDay, result.isLoading, result.error, result.reload, isStale],
  );
}
