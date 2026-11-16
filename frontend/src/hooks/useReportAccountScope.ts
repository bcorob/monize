'use client';

import { useMemo } from 'react';
import { accountsApi } from '@/lib/accounts';
import { useReportData } from '@/hooks/useReportData';
import { usePersistedAccountFilter } from '@/hooks/usePersistedAccountFilter';
import { transferScopeFor, type TransferScope } from '@/lib/transfer-scope';
import type { Account } from '@/types/account';

// An investment account's cash legs are excluded from these reports by
// linkage, so the picker does not offer one (Income vs Expenses, Cash Flow).
export const nonInvestmentAccounts = (a: Account) => a.accountType !== 'INVESTMENT';

const NO_SELECTION: string[] = [];

export interface ReportAccountScope {
  offeredAccounts: Account[];
  selectedAccountIds: string[];
  setSelectedAccountIds: (ids: string[]) => void;
  /** Stable key of the selection, for a fetch's dependency list. */
  accountIdsKey: string;
  /**
   * The tagged-transfer boundary for the funding fetch (spec 10.8.1): every
   * offered account while the selection is "All Accounts", so the default and
   * an explicit every-account selection read the same tagged flows.
   */
  transferScope: TransferScope;
}

/** The offered (non-investment) account ids, null while they load; a failed load is empty. */
function useOfferedAccounts(): { offeredAccounts: Account[]; offeredIds: string[] | null } {
  const { data, error } = useReportData(() => accountsApi.getAll(), []);
  const offeredAccounts = useMemo(
    () => (data ?? []).filter(nonInvestmentAccounts),
    [data],
  );
  const settled = data !== null || error !== null;
  const offeredIds = useMemo(
    () => (settled ? offeredAccounts.map((a) => a.id) : null),
    [settled, offeredAccounts],
  );
  return { offeredAccounts, offeredIds };
}

/**
 * The account filter of a report: the non-investment accounts, and the
 * persisted selection (empty means every account, the report as it always was).
 */
export function useReportAccountScope(storageKey: string): ReportAccountScope {
  const { offeredAccounts, offeredIds } = useOfferedAccounts();
  const [selectedAccountIds, setSelectedAccountIds] = usePersistedAccountFilter(
    storageKey,
    offeredAccounts,
  );
  const transferScope = useMemo(
    () => transferScopeFor(selectedAccountIds, offeredIds),
    [selectedAccountIds, offeredIds],
  );
  return {
    offeredAccounts,
    selectedAccountIds,
    setSelectedAccountIds,
    accountIdsKey: selectedAccountIds.join(','),
    transferScope,
  };
}

/**
 * The "All Accounts" tagged-transfer boundary for a report with no account
 * picker of its own (Budget vs Actual): the same offered accounts.
 */
export function useDefaultTransferScope(): TransferScope {
  const { offeredIds } = useOfferedAccounts();
  return useMemo(() => transferScopeFor(NO_SELECTION, offeredIds), [offeredIds]);
}
