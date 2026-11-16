'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useDateFormat } from '@/hooks/useDateFormat';
import {
  hasIncompleteData,
  type IncompleteDataCauses,
  type IncompleteDataRange,
} from '@/lib/incomplete-data-ranges';

/**
 * What a withheld portfolio figure is waiting for, named.
 *
 * Withholding a figure is only honest if the reader learns why: "some days are
 * incomplete" is a dead end, while "AGGG, Jun 16 to Jun 20" is a repair. The
 * server dates each cause per point and `foldIncompleteData` folds those into
 * runs; this renders them under the three headings that map to three different
 * places to go -- a security's price history, the exchange rates screen, and the
 * cash account whose missing balance is a defect to report (#1389).
 *
 * Names, never ids: an unresolved id would be a worse dead end than the sentence
 * it replaced, so the caller supplies the lookups it already has loaded.
 */
export interface IncompleteDataDetailsProps {
  causes: IncompleteDataCauses;
  /** Symbol or name for a security id; the id itself is never shown. */
  securityLabel: (securityId: string) => string;
  /** Name for a cash account id. */
  accountLabel: (accountId: string) => string;
}

export function IncompleteDataDetails({
  causes,
  securityLabel,
  accountLabel,
}: IncompleteDataDetailsProps) {
  const t = useTranslations('reports');
  const { formatDate } = useDateFormat();

  if (!hasIncompleteData(causes)) return null;

  const dates = (range: IncompleteDataRange) =>
    range.start === range.end
      ? formatDate(range.start)
      : t('portfolioValue.incompleteDateRange', {
          start: formatDate(range.start),
          end: formatDate(range.end),
        });

  const rangeKey = (range: IncompleteDataRange) =>
    `${range.key}-${range.start}-${range.end}`;

  return (
    <div
      className="rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-900/20 p-4 text-sm"
      data-testid="incomplete-data-details"
    >
      <h4 className="font-medium text-amber-900 dark:text-amber-200">
        {t('portfolioValue.incompleteDetailsTitle')}
      </h4>
      <div className="mt-2 space-y-3 text-amber-900/90 dark:text-amber-100/90">
        {causes.prices.length > 0 && (
          <section>
            <h5 className="font-medium">
              {t('portfolioValue.incompleteMissingPrices')}
            </h5>
            <ul className="mt-1 space-y-1">
              {causes.prices.map((range) => (
                <li key={rangeKey(range)}>
                  {/* Straight to the security's price history, which is where
                      the missing close is entered or backfilled. */}
                  <Link
                    href={`/securities/${range.key}?tab=prices`}
                    className="font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded-sm"
                  >
                    {securityLabel(range.key)}
                  </Link>
                  {t('portfolioValue.incompleteEntrySeparator')}
                  {dates(range)}
                </li>
              ))}
            </ul>
          </section>
        )}
        {causes.rates.length > 0 && (
          <section>
            <h5 className="font-medium">
              {t('portfolioValue.incompleteMissingRates')}
            </h5>
            <ul className="mt-1 space-y-1">
              {causes.rates.map((range) => (
                <li key={rangeKey(range)}>
                  <span className="font-medium">{range.key}</span>
                  {t('portfolioValue.incompleteEntrySeparator')}
                  {dates(range)}
                </li>
              ))}
            </ul>
          </section>
        )}
        {causes.cash.length > 0 && (
          <section>
            <h5 className="font-medium">
              {t('portfolioValue.incompleteMissingCash')}
            </h5>
            <ul className="mt-1 space-y-1">
              {causes.cash.map((range) => (
                <li key={rangeKey(range)}>
                  <span className="font-medium">{accountLabel(range.key)}</span>
                  {t('portfolioValue.incompleteEntrySeparator')}
                  {dates(range)}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
