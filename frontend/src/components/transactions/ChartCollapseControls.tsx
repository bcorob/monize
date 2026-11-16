'use client';

import { useTranslations } from 'next-intl';
import { ChartBarIcon, ChevronDownIcon, ChevronUpIcon } from '@heroicons/react/24/outline';
import { CARD_CLASS, HOVER_ROW_ON_CARD } from '@/components/ui/Card';

/**
 * The button in a chart card's header that folds the Transactions page's
 * chart band (the chart and any info widget beside it) into
 * `CollapsedChartStrip`. Drawn like the info widgets' own fold chevron.
 */
export function ChartCollapseButton({ onCollapse }: { onCollapse: () => void }) {
  const t = useTranslations('transactions');
  return (
    <button
      type="button"
      onClick={onCollapse}
      aria-label={t('charts.collapse.hide')}
      title={t('charts.collapse.hide')}
      className="text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded p-1"
    >
      <ChevronUpIcon className="h-5 w-5" aria-hidden="true" />
    </button>
  );
}

/**
 * What stands in for the folded chart band: one slim card, the whole of which
 * brings the band back, so restoring it is a single click anywhere on it.
 */
export function CollapsedChartStrip({ onExpand }: { onExpand: () => void }) {
  const t = useTranslations('transactions');
  return (
    <button
      type="button"
      onClick={onExpand}
      aria-expanded={false}
      aria-label={t('charts.collapse.show')}
      data-testid="chart-collapsed-strip"
      className={`${CARD_CLASS} ${HOVER_ROW_ON_CARD} mb-6 w-full flex items-center justify-between gap-3 px-3 sm:px-6 py-2 text-sm text-gray-600 dark:text-gray-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`}
    >
      <span className="inline-flex items-center gap-2">
        <ChartBarIcon className="h-4 w-4 text-gray-400" aria-hidden="true" />
        {t('charts.collapse.hidden')}
      </span>
      <span className="inline-flex items-center gap-1 font-medium text-blue-600 dark:text-blue-400">
        {t('charts.collapse.show')}
        <ChevronDownIcon className="h-4 w-4" aria-hidden="true" />
      </span>
    </button>
  );
}
