'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { BondHistoryBody } from '@/components/bonds/BondHistoryTab';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useFinancialToday } from '@/hooks/useFinancialToday';
import { useReportData } from '@/hooks/useReportData';
import { groupLotsBySeries } from '@/lib/bond-series';
import { getErrorMessage } from '@/lib/errors';
import { investmentsApi } from '@/lib/investments';
import type { SecurityBondValuation } from '@/types/bond';
import type { Security } from '@/types/investment';
import { programLabel } from './bond-labels';

interface SecurityBondTermsTabProps {
  security: Security;
  /** Bumped by the page when a price refresh completes: re-reads in place. */
  refreshVersion?: number;
}

/**
 * The "Terms history" tab of a program-linked security: the product's stored
 * series over time (charts, missing months, every series by year), with the
 * series the reader holds marked.
 *
 * The product and the series held come from today's valuation, read here
 * because the bond card keeps its own valuation private to the day and scenario
 * the reader picked.
 */
export function SecurityBondTermsTab({
  security,
  refreshVersion = 0,
}: SecurityBondTermsTabProps) {
  const t = useTranslations('securityDetail');
  const tBonds = useTranslations('bonds');
  const today = useFinancialToday();

  const requestKey = `${security.id}|${today}`;
  const request = useReportData<SecurityBondValuation>(
    () => investmentsApi.getSecurityBondValuation(security.id, today),
    [security.id, today, refreshVersion],
    { requestKey },
  );
  const valuation =
    request.data !== null && request.dataKey === requestKey ? request.data : null;
  const held = useMemo(
    () => (valuation ? groupLotsBySeries(valuation) : []),
    [valuation],
  );

  if (request.error) {
    return (
      <div role="alert" className="space-y-3">
        <p className="text-sm text-red-600 dark:text-red-400">
          {getErrorMessage(request.error, t('bond.loadFailed'))}
        </p>
        <Button variant="outline" size="sm" onClick={request.reload}>
          {t('error.retry')}
        </Button>
      </div>
    );
  }
  if (valuation === null) {
    return (
      <div className="flex justify-center py-8">
        <LoadingSpinner text={t('bond.loading')} />
      </div>
    );
  }

  const title = tBonds('entry.history', {
    program: programLabel(t, valuation.program.programCode),
  });
  return (
    <Card padding="sm" aria-label={title} as="section">
      <h3 className="mb-3 text-lg font-semibold text-gray-900 dark:text-gray-100">
        {title}
      </h3>
      <BondHistoryBody
        countryCode={valuation.program.issuerCountryCode}
        program={valuation.program.programCode}
        currency={valuation.program.currency}
        heldSeries={held.map((h) => h.seriesCode)}
        refreshVersion={refreshVersion}
      />
    </Card>
  );
}
