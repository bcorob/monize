'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { PerformancePeriodsCard } from '@/components/ui/PerformancePeriodsCard';
import {
  PERFORMANCE_PERIODS,
  computePeriodReturn,
  periodStartDate,
  inferDistributionPolicy,
  type SecurityPricePoint,
} from '@/lib/security-detail';

interface SecurityPerformanceCardProps {
  /** Full close-price history, oldest first. */
  prices: readonly SecurityPricePoint[];
}

/**
 * Price return over the standard trailing periods.
 *
 * A period the history does not cover reads "n/a" rather than 0%: a security
 * listed two years ago has no five-year return, and a zero there would be a
 * statement about its performance instead of about our data.
 *
 * The caption says whether dividends are in these figures. They are whenever the
 * provider supplies an adjusted close; when it does not, the returns are measured
 * on price alone and a fund that pays out looks worse than it was by its whole
 * yield -- which is worth saying out loud rather than leaving to be discovered.
 *
 * The table itself is `PerformancePeriodsCard`, shared with the Investments
 * page's portfolio result: two subjects, one layout, so a reader moving between
 * them does not have to re-learn it.
 */
export function SecurityPerformanceCard({
  prices,
}: SecurityPerformanceCardProps) {
  const t = useTranslations('securityDetail');
  const { formatSignedPercent } = useNumberFormat();

  const entries = useMemo(
    () =>
      PERFORMANCE_PERIODS.map((period) => {
        const value = computePeriodReturn(prices, periodStartDate(period));
        return {
          period,
          label: t(`performance.periods.${period}` as Parameters<typeof t>[0]),
          primary: value === null ? null : formatSignedPercent(value),
          primaryValue: value,
        };
      }),
    [prices, t, formatSignedPercent],
  );

  // `unknown` means no adjusted series exists, so these returns exclude dividends.
  const includesDividends = inferDistributionPolicy(prices) !== 'unknown';

  return (
    <PerformancePeriodsCard
      title={t('performance.title')}
      /* These are the security's returns, not the holder's: they measure the
         instrument over a window regardless of when it was bought or whether it
         was held at all. Readers take any "Performance" heading on a page about
         their own holding to mean their own return, so the card says which one
         it is and where to find the other. */
      subtitle={t('performance.subject')}
      entries={entries}
      unavailableLabel={t('performance.unavailable')}
      emptyMessage={t('performance.empty')}
      footnote={
        includesDividends
          ? t('performance.includesDividends')
          : t('performance.excludesDividends')
      }
      footnoteTone={includesDividends ? 'muted' : 'warning'}
      footnoteTitle={
        includesDividends ? undefined : t('performance.excludesDividendsTitle')
      }
    />
  );
}
