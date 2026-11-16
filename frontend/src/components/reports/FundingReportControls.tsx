'use client';

import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import { TaggedFundsControls } from '@/components/reports/TaggedFundsControls';
import { nonInvestmentAccounts } from '@/hooks/useReportAccountScope';
import type { FundingReportControls as FundingControls } from '@/hooks/useFundingReportControls';

/**
 * The account filter, tag key, tag value and "Include tagged transfers"
 * controls of a report that takes the funding view, as siblings for the
 * report's own toolbar row.
 */
export function FundingReportControls({ controls }: { controls: FundingControls }) {
  const { scope, filter } = controls;
  return (
    <>
      <ReportAccountMultiSelect
        accounts={scope.offeredAccounts}
        value={scope.selectedAccountIds}
        onChange={scope.setSelectedAccountIds}
        filter={nonInvestmentAccounts}
      />
      <TaggedFundsControls filter={filter} />
    </>
  );
}
