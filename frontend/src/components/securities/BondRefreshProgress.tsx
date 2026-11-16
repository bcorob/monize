'use client';

import { useTranslations } from 'next-intl';
import { useBondRefreshProgress } from '@/hooks/useBondRefreshProgress';

interface BondRefreshProgressProps {
  programId: string | null;
  /** True while the Refresh request is running; the bar is hidden otherwise. */
  active: boolean;
}

/**
 * The server's progress through a bond Refresh: the current offer, then each
 * history series. Indeterminate until the series count is known.
 */
export function BondRefreshProgress({ programId, active }: BondRefreshProgressProps) {
  const t = useTranslations('bonds');
  const progress = useBondRefreshProgress(programId, active);

  if (!active || !programId) return null;

  const inSeries = progress?.phase === 'series' || progress?.phase === 'done';
  const total = progress?.total ?? 0;
  const determinate = inSeries && total > 0;
  const done = progress ? Math.min(Math.max(progress.done, 0), total) : 0;
  const percent = determinate ? Math.round((done / total) * 100) : 0;

  let text: string;
  if (!progress) {
    text = t('refreshProgress.starting');
  } else if (progress.phase === 'offer') {
    text = t('refreshProgress.offer');
  } else if (inSeries && total === 0) {
    text = t('refreshProgress.historyComplete');
  } else if (determinate) {
    text = t('refreshProgress.series', {
      done,
      total,
      seriesCode: progress.seriesCode ?? '',
    });
  } else {
    text = t('refreshProgress.starting');
  }

  return (
    <div className="mb-6" aria-busy="true">
      <div
        className="h-2 w-full overflow-hidden rounded bg-muted"
        {...(determinate
          ? {
              role: 'progressbar',
              'aria-valuenow': done,
              'aria-valuemin': 0,
              'aria-valuemax': total,
              'aria-label': t('refreshProgress.label'),
            }
          : {})}
      >
        <div
          className={
            determinate
              ? 'h-2 rounded bg-primary transition-all motion-reduce:transition-none'
              : 'h-2 w-1/3 animate-pulse rounded bg-primary motion-reduce:animate-none'
          }
          style={determinate ? { width: `${percent}%` } : undefined}
        />
      </div>
      <p
        aria-live="polite"
        className="mt-1 text-sm text-gray-600 dark:text-gray-400"
      >
        {text}
      </p>
    </div>
  );
}
