'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import type { ChartMarker } from '@/components/transactions/BalanceHistoryChart';
import type { BalanceForecastState } from './balance-forecast-state';

/**
 * The balance chart's marker for the overdue occurrences a projection applied
 * on its first day (discussion #1784): one dot on that day whose tooltip says
 * how many, so the drop has a visible cause. None when nothing was overdue.
 *
 * The dot's colour is the day's own move, not the overdue net: that day also
 * carries the occurrences due today and its own, so a green dot on a day the
 * line falls would contradict the line. Only a day that does not move falls
 * back to the overdue net.
 *
 * Both account detail views draw the same projection, so they read the marker
 * from here rather than each composing their own.
 */
export function useOverdueForecastMarkers(
  state: BalanceForecastState,
): ChartMarker[] {
  const t = useTranslations('common');
  const { overdue, points } = state;
  return useMemo(() => {
    if (overdue === null || overdue.count === 0) return [];
    const index = points.findIndex((p) => p.date === overdue.date);
    const dayMove =
      index > 0 ? points[index].balance - points[index - 1].balance : 0;
    const moved = dayMove !== 0 ? dayMove : overdue.amount;
    return [
      {
        date: overdue.date,
        direction: moved >= 0 ? 'in' : 'out',
        label: t('scheduledOverdue.included', { count: overdue.count }),
      },
    ];
  }, [overdue, points, t]);
}
