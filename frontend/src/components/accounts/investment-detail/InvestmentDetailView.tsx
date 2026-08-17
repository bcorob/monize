'use client';

import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { accountsApi } from '@/lib/accounts';
import { investmentsApi } from '@/lib/investments';
import { PortfolioSummaryCard } from '@/components/investments/PortfolioSummaryCard';
import { AssetAllocationChart } from '@/components/investments/AssetAllocationChart';
import { InvestmentValueChart } from '@/components/investments/InvestmentValueChart';
import { GroupedHoldingsList } from '@/components/investments/GroupedHoldingsList';
import { InvestmentRegisterPanel } from '@/components/investments/InvestmentRegisterPanel';
import { InvestmentIncomePanel } from './InvestmentIncomePanel';
import type { Account } from '@/types/account';
import type { PortfolioSummary, InvestmentTransaction, RealizedGainEntry } from '@/types/investment';

interface InvestmentDetailViewProps {
  account: Account;
  /**
   * Bumped by the header's Refresh Prices button to re-fetch. The button lives
   * on the title row (`InvestmentDetailActions`), so the signal comes in rather
   * than being raised here.
   */
  refreshKey?: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The investment detail body for a brokerage/cash pair. Resolves the pair (via
 * investment-pair, falling back to a standalone brokerage), then composes the
 * existing portfolio components scoped to the pair's accounts: summary,
 * allocation, value-over-time, holdings, YTD income, and recent transactions.
 */
export function InvestmentDetailView({ account, refreshKey = 0 }: InvestmentDetailViewProps) {
  const [brokerage, setBrokerage] = useState<Account>(account);
  const [cash, setCash] = useState<Account | null>(null);
  const [summary, setSummary] = useState<PortfolioSummary | null>(null);
  const [dividendInterestYtd, setDividendInterestYtd] = useState(0);
  const [realizedGainsYtd, setRealizedGainsYtd] = useState(0);
  const [loadedForId, setLoadedForId] = useState<string | null>(null);
  const isLoading = loadedForId !== account.id;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Resolve the brokerage/cash pair; a standalone account 400s, in which
      // case it is treated as its own brokerage with no cash half.
      let resolvedBrokerage = account;
      let resolvedCash: Account | null = null;
      try {
        const pair = await accountsApi.getInvestmentPair(account.id);
        resolvedBrokerage = pair.brokerageAccount;
        resolvedCash = pair.cashAccount;
      } catch {
        // not part of a pair
      }
      const ids = resolvedCash ? [resolvedBrokerage.id, resolvedCash.id] : [resolvedBrokerage.id];
      const idsStr = ids.join(',');
      const now = new Date();
      const today = format(now, 'yyyy-MM-dd');
      const yearStart = `${now.getFullYear()}-01-01`;

      const [summaryData, incomeTx, realized] = await Promise.all([
        investmentsApi.getPortfolioSummary(ids).catch(() => null),
        investmentsApi
          .getTransactions({ accountIds: idsStr, startDate: yearStart, endDate: today, limit: 500 })
          .catch(() => ({ data: [] as InvestmentTransaction[] })),
        investmentsApi
          .getRealizedGains({ accountIds: idsStr, startDate: yearStart, endDate: today })
          .catch(() => [] as RealizedGainEntry[]),
      ]);

      if (cancelled) return;
      setBrokerage(resolvedBrokerage);
      setCash(resolvedCash);
      setSummary(summaryData);
      const income = incomeTx.data
        .filter((tx) => tx.action === 'DIVIDEND' || tx.action === 'INTEREST')
        .reduce((sum, tx) => sum + (Number(tx.totalAmount) || 0), 0);
      setDividendInterestYtd(round2(income));
      setRealizedGainsYtd(round2(realized.reduce((sum, r) => sum + (Number(r.realizedGain) || 0), 0)));
      setLoadedForId(account.id);
    })();
    return () => {
      cancelled = true;
    };
  }, [account, refreshKey]);

  const accountIds = cash ? [brokerage.id, cash.id] : [brokerage.id];
  const currency = brokerage.currencyCode;

  return (
    <div className="space-y-6">
      <PortfolioSummaryCard summary={summary} isLoading={isLoading} singleAccountCurrency={currency} />

      <div className="grid gap-6 lg:grid-cols-2">
        <AssetAllocationChart
          allocation={
            summary
              ? { allocation: summary.allocation, totalValue: summary.totalPortfolioValue }
              : null
          }
          isLoading={isLoading}
          singleAccountCurrency={currency}
          holdingsByAccount={summary?.holdingsByAccount}
          accountIds={accountIds}
          valuationComplete={summary?.valuationComplete}
        />
        <InvestmentValueChart accountIds={accountIds} displayCurrency={currency} />
      </div>

      <GroupedHoldingsList
        holdingsByAccount={summary?.holdingsByAccount ?? []}
        isLoading={isLoading}
        totalPortfolioValue={summary?.totalPortfolioValue ?? 0}
        valuationComplete={summary?.valuationComplete}
      />

      <InvestmentIncomePanel
        dividendInterestYtd={dividendInterestYtd}
        realizedGainsYtd={realizedGainsYtd}
        currencyCode={currency}
        isLoading={isLoading}
      />

      {/* Both ledgers of this account, behind one toggle: the trades, and the
          cash register that funds them. */}
      <InvestmentRegisterPanel
        holdingsAccount={brokerage}
        cashAccount={cash}
      />
    </div>
  );
}
