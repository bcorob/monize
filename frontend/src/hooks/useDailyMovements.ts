import { useMemo } from 'react';
import { useReportData } from '@/hooks/useReportData';
import { investmentsApi } from '@/lib/investments';
import type { DailyMovementPoint, DailyMovementsResponse } from '@/types/investment';

/**
 * The scope's market movement per calendar day, net of the reader's own
 * contributions.
 *
 * `GET /portfolio/daily-movements` decides every day: whether it was a trading
 * day, whether the two values and the flow it needs were all known, and what
 * the percentage is. The client renders `complete` and `reasons` and re-derives
 * none of it (design I4, truth table B), which is why a cell can tell a flat
 * session from a weekend from an unpriced holding without knowing what any of
 * those mean.
 */
export interface DailyMovementsState {
  byDay: ReadonlyMap<string, DailyMovementPoint>;
  /** The currency the movements are reported in, or null before the first load. */
  currencyCode: string | null;
  isLoading: boolean;
  error: Error | null;
  isStale: boolean;
  reload: () => void;
}

export function dailyMovementsKey(
  startDate: string,
  endDate: string,
  accountIds: readonly string[],
  displayCurrency: string | undefined,
): string {
  return JSON.stringify([startDate, endDate, [...accountIds].sort(), displayCurrency ?? '']);
}

export function useDailyMovements(params: {
  startDate: string;
  endDate: string;
  /** The financial today; nothing after it is evaluated, so nothing is asked for. */
  today: string;
  accountIds: readonly string[];
  displayCurrency?: string;
  enabled: boolean;
  refreshKey?: number;
}): DailyMovementsState {
  const { startDate, endDate, today, accountIds, displayCurrency, enabled, refreshKey = 0 } =
    params;

  const clampedEnd = endDate > today ? today : endDate;
  const inRange = startDate <= clampedEnd;

  const requestKey = `${enabled && inRange ? 'on' : 'off'}:${dailyMovementsKey(
    startDate,
    clampedEnd,
    accountIds,
    displayCurrency,
  )}`;

  const result = useReportData<DailyMovementsResponse | null>(
    async () => {
      if (!enabled || !inRange) return null;
      return investmentsApi.getDailyMovements({
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
    const days = new Map<string, DailyMovementPoint>();
    for (const point of result.data?.days ?? []) days.set(point.date, point);
    return days;
  }, [result.data]);

  const isStale = result.data !== null && result.dataKey !== requestKey;

  return useMemo(
    () => ({
      byDay,
      currencyCode: result.data?.currencyCode ?? null,
      isLoading: result.isLoading,
      error: result.error,
      isStale,
      reload: result.reload,
    }),
    [byDay, result.data, result.isLoading, result.error, result.reload, isStale],
  );
}
