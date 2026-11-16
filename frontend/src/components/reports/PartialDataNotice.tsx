'use client';

import { useTranslations } from 'next-intl';

interface PartialDataNoticeProps {
  /** Source currencies with no rate into `displayCurrency`. */
  missingCurrencies: readonly string[];
  /** Rows the server left out of the figures, by any cause. */
  excludedCount: number;
  /** Currency the figures on the report are expressed in. */
  displayCurrency: string;
}

/**
 * The note a report shows when it has no headline total to mark with
 * `PartialTotal` -- a trend, a breakdown, statistics -- but every figure on it
 * leaves out rows whose currency has no rate. Renders nothing when complete.
 */
export function PartialDataNotice({
  missingCurrencies,
  excludedCount,
  displayCurrency,
}: PartialDataNoticeProps) {
  const t = useTranslations('reports');

  if (missingCurrencies.length === 0 && excludedCount === 0) return null;

  return (
    <p
      className="text-xs text-amber-600 dark:text-amber-400"
      data-testid="partial-data-notice"
      role="note"
    >
      {missingCurrencies.length > 0
        ? t('partialData.notice', {
            count: excludedCount,
            displayCurrency,
            currencies: missingCurrencies.join(', '),
          })
        : t('partialData.noticeExcluded', { count: excludedCount })}
    </p>
  );
}
