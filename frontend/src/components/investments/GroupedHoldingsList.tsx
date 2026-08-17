'use client';

import { useState, memo } from 'react';
import { useTranslations } from 'next-intl';
import { AccountHoldings, HoldingWithMarketValue } from '@/types/investment';
import { ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { gainLossColor } from '@/lib/format';
import { Skeleton } from '@/components/ui/LoadingSkeleton';

interface GroupedHoldingsListProps {
  holdingsByAccount: AccountHoldings[];
  isLoading: boolean;
  totalPortfolioValue: number;
  /**
   * False when `totalPortfolioValue` is a known subtotal rather than the whole
   * portfolio (a missing price or FX rate). A share of a subtotal is not a
   * share of the portfolio, so the "% Port" column reads unknown then
   * (review #1133). Absent reads as complete.
   */
  valuationComplete?: boolean;
  onSecurityClick?: (securityId: string) => void;
  onCashClick?: (cashAccountId: string) => void;
}

export function GroupedHoldingsList({
  holdingsByAccount,
  isLoading,
  totalPortfolioValue,
  valuationComplete,
  onSecurityClick,
  onCashClick,
}: GroupedHoldingsListProps) {
  const t = useTranslations('investments');
  const { formatCurrency: formatCurrencyBase, formatCurrencyPrecise, formatSignedPercent, formatNumber, formatQuantity } = useNumberFormat();
  const { getRate, defaultCurrency } = useExchangeRates();

  const [expandedAccounts, setExpandedAccounts] = useState<Set<string>>(
    new Set(holdingsByAccount.map((a) => a.accountId)),
  );

  const toggleAccount = (accountId: string) => {
    setExpandedAccounts((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
      }
      return next;
    });
  };

  const formatCurrency = (value: number | null) => {
    if (value === null) return '-';
    return formatCurrencyBase(value);
  };

  const formatPrice = (value: number | null, currencyCode?: string) => {
    if (value === null) return '-';
    // Per-share prices display at 4dp, expanding further only when a sub-penny
    // value would otherwise read as 0.0000.
    return formatCurrencyPrecise(value, currencyCode, 4);
  };

  const formatPercent = (value: number | null, showSign = true) => {
    if (value === null) return '-';
    return showSign ? formatSignedPercent(value) : `${formatNumber(value, 2)}%`;
  };

  const getGainLossColor = (value: number | null) => {
    if (value === null) return 'text-gray-500 dark:text-gray-400';
    return gainLossColor(value);
  };

  // A share of a known subtotal is not a share of the portfolio, and a value
  // whose pair has no rate cannot join the numerator: both read unknown ('-')
  // rather than a definitive-looking percentage of the wrong denominator
  // (review #1133). getRate returns null for an unresolved pair, so the missing
  // conversion surfaces here rather than being silently dropped.
  const getPortfolioPercent = (value: number | null, currencyCode?: string): string => {
    if (value === null || totalPortfolioValue === 0) return '-';
    if (valuationComplete === false) return '-';
    let converted = value;
    if (currencyCode && currencyCode !== defaultCurrency) {
      const rate = getRate(currencyCode, defaultCurrency);
      if (rate === null) return '-';
      converted = value * rate;
    }
    return ((converted / totalPortfolioValue) * 100).toFixed(1) + '%';
  };

  // The "~ default currency" approximation under an account's total: unknown --
  // and unrendered -- when the pair has no rate (getRate returns null) or when
  // the account's own valuation is incomplete (the total being approximated is a
  // subtotal the marker beside it just called partial). The summary card
  // suppresses its ~ line the same way.
  const accountDefaultApprox = (
    account: AccountHoldings,
    accountTotalValue: number,
  ): number | null => {
    if (account.valuationComplete === false) return null;
    const rate = getRate(account.currencyCode, defaultCurrency);
    if (rate === null) return null;
    return accountTotalValue * rate;
  };

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('groupedHoldings.title')}
        </h3>
        <div className="space-y-4">
          {[1, 2].map((i) => (
            <div key={i}>
              <Skeleton className="h-6 w-1/3 mb-3" />
              <div className="space-y-2">
                {[1, 2, 3].map((j) => (
                  <div key={j} className="flex justify-between">
                    <Skeleton className="h-4 w-1/4" />
                    <Skeleton className="h-4 w-1/4" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const totalHoldings = holdingsByAccount.reduce(
    (sum, a) => sum + a.holdings.length,
    0,
  );

  const hasCash = holdingsByAccount.some((a) => a.cashBalance !== 0);

  if (totalHoldings === 0 && !hasCash) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('groupedHoldings.title')}
        </h3>
        <p className="text-gray-500 dark:text-gray-400">
          {t('groupedHoldings.noHoldings')}
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
      <div className="p-3 sm:p-6 pb-3 sm:pb-4 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('groupedHoldings.title')}
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          {t('groupedHoldings.accountSummary', { accounts: holdingsByAccount.length, accountsPlural: holdingsByAccount.length !== 1 ? 's' : '', positions: totalHoldings, positionsPlural: totalHoldings !== 1 ? 's' : '' })}
        </p>
      </div>

      <div className="divide-y divide-gray-200 dark:divide-gray-700">
        {holdingsByAccount.map((account) => {
          const isExpanded = expandedAccounts.has(account.accountId);
          const accountTotalValue = account.totalMarketValue + account.cashBalance;
          const acctDisplayCurrency = account.currencyCode !== defaultCurrency
            ? account.currencyCode
            : null;
          const defaultApprox = acctDisplayCurrency
            ? accountDefaultApprox(account, accountTotalValue)
            : null;
          const fmtAcct = (value: number | null) => {
            if (value === null) return '-';
            if (acctDisplayCurrency) return `${formatCurrencyBase(value, acctDisplayCurrency)} ${acctDisplayCurrency}`;
            return formatCurrency(value);
          };

          return (
            <div key={account.accountId}>
              {/* Account Header */}
              <button
                onClick={() => toggleAccount(account.accountId)}
                className="w-full px-3 sm:px-6 py-3 sm:py-4 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors"
              >
                <div className="flex items-center gap-3">
                  {isExpanded ? (
                    <ChevronDownIcon className="h-5 w-5 text-gray-400" />
                  ) : (
                    <ChevronRightIcon className="h-5 w-5 text-gray-400" />
                  )}
                  <div className="text-left">
                    <div className="font-semibold text-gray-900 dark:text-gray-100">
                      {account.accountName}
                    </div>
                    <div className="text-sm text-gray-500 dark:text-gray-400">
                      {account.cashBalance !== 0
                        ? t('groupedHoldings.positionsWithCash', { count: account.holdings.length, plural: account.holdings.length !== 1 ? 's' : '' })
                        : t('groupedHoldings.positions', { count: account.holdings.length, plural: account.holdings.length !== 1 ? 's' : '' })}
                    </div>
                    {/* This account's totals are in its OWN currency, a different
                        conversion from the portfolio's, so the global state cannot
                        speak for them (recheck RR4-002 / RR3-005). */}
                    {account.valuationComplete === false && (
                      <div className="text-xs text-amber-700 dark:text-amber-300">
                        {t('groupedHoldings.accountIncomplete', {
                          currency: account.currencyCode,
                        })}
                      </div>
                    )}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-semibold text-gray-900 dark:text-gray-100">
                    {fmtAcct(accountTotalValue)}
                  </div>
                  {defaultApprox !== null && (
                    <div className="text-xs text-gray-400 dark:text-gray-500">
                      {'\u2248 '}{formatCurrencyBase(defaultApprox, defaultCurrency)} {defaultCurrency}
                    </div>
                  )}
                  <div className={`text-sm ${getGainLossColor(account.totalGainLoss)}`}>
                    {fmtAcct(account.totalGainLoss)} ({formatPercent(account.totalGainLossPercent)})
                  </div>
                </div>
              </button>

              {/* Account Holdings Table */}
              {isExpanded && (
                <div className="overflow-x-auto">
                  <table className="min-w-full">
                    <thead className="bg-gray-50 dark:bg-gray-700/50">
                      <tr>
                        <th className="px-2 sm:px-6 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                          {t('groupedHoldings.symbolColumn')}
                        </th>
                        <th className="px-1.5 sm:px-4 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                          {t('groupedHoldings.sharesColumn')}
                        </th>
                        <th className="px-1.5 sm:px-4 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                          {t('groupedHoldings.avgCostColumn')}
                        </th>
                        <th className="px-1.5 sm:px-4 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                          {t('groupedHoldings.priceColumn')}
                        </th>
                        <th className="px-1.5 sm:px-4 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                          {t('groupedHoldings.costBasisColumn')}
                        </th>
                        <th className="px-1.5 sm:px-4 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                          {t('groupedHoldings.mktValueColumn')}
                        </th>
                        <th className="px-1.5 sm:px-4 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                          {t('groupedHoldings.gainLossColumn')}
                        </th>
                        <th className="px-1.5 sm:px-4 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                          {t('groupedHoldings.portfolioPercentColumn')}
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                      {account.holdings.map((holding) => (
                        <HoldingRow
                          key={holding.id}
                          holding={holding}
                          defaultCurrency={defaultCurrency}
                          accountCurrency={account.currencyCode}
                          getRate={getRate}
                          formatCurrency={formatCurrency}
                          formatCurrencyWithCode={formatCurrencyBase}
                          formatPrice={formatPrice}
                          formatQuantity={formatQuantity}
                          formatPercent={formatPercent}
                          getGainLossColor={getGainLossColor}
                          getPortfolioPercent={getPortfolioPercent}
                          onSecurityClick={onSecurityClick}
                        />
                      ))}

                      {/* Cash Row */}
                      {account.cashBalance !== 0 && (
                        <tr className="hover:bg-gray-50 dark:hover:bg-gray-700/20">
                          <td className="px-2 sm:px-6 py-3 whitespace-nowrap">
                            <button
                              onClick={() => account.cashAccountId && onCashClick?.(account.cashAccountId)}
                              className="flex items-center gap-2 text-left hover:underline focus:outline-none focus:underline"
                              title={t('groupedHoldings.cashClickTitle')}
                            >
                              <svg className="h-4 w-4 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                              <div>
                                <div className="font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300">{t('groupedHoldings.cashLabel')}</div>
                                <div className="text-xs text-gray-500 dark:text-gray-400">{t('groupedHoldings.availableBalance')}</div>
                              </div>
                            </button>
                          </td>
                          <td className="px-1.5 sm:px-4 py-3 whitespace-nowrap text-right text-sm text-gray-400 dark:text-gray-500">
                            -
                          </td>
                          <td className="px-1.5 sm:px-4 py-3 whitespace-nowrap text-right text-sm text-gray-400 dark:text-gray-500">
                            -
                          </td>
                          <td className="px-1.5 sm:px-4 py-3 whitespace-nowrap text-right text-sm text-gray-400 dark:text-gray-500">
                            -
                          </td>
                          <td className="px-1.5 sm:px-4 py-3 whitespace-nowrap text-right text-sm text-gray-500 dark:text-gray-400">
                            {fmtAcct(account.cashBalance)}
                          </td>
                          <td className="px-1.5 sm:px-4 py-3 whitespace-nowrap text-right text-sm font-medium text-gray-900 dark:text-gray-100">
                            {fmtAcct(account.cashBalance)}
                          </td>
                          <td className="px-1.5 sm:px-4 py-3 whitespace-nowrap text-right">
                            <div className="text-sm text-gray-400 dark:text-gray-500">-</div>
                          </td>
                          <td className="px-1.5 sm:px-4 py-3 whitespace-nowrap text-right text-sm text-gray-500 dark:text-gray-400">
                            {getPortfolioPercent(account.cashBalance, acctDisplayCurrency || account.currencyCode)}
                          </td>
                        </tr>
                      )}

                      {/* Account Summary Row */}
                      <tr className="bg-gray-50 dark:bg-gray-700/30 font-medium">
                        <td className="px-2 sm:px-6 py-3 text-sm text-gray-700 dark:text-gray-300" colSpan={4}>
                          {t('groupedHoldings.accountTotal')}
                        </td>
                        <td className="px-1.5 sm:px-4 py-3 text-right text-sm text-gray-900 dark:text-gray-100">
                          {fmtAcct(account.totalCostBasis + account.cashBalance)}
                        </td>
                        <td className="px-1.5 sm:px-4 py-3 text-right text-sm text-gray-900 dark:text-gray-100">
                          <div>{fmtAcct(accountTotalValue)}</div>
                          {defaultApprox !== null && (
                            <div className="text-xs font-normal text-gray-400 dark:text-gray-500">
                              {'\u2248 '}{formatCurrencyBase(defaultApprox, defaultCurrency)} {defaultCurrency}
                            </div>
                          )}
                        </td>
                        <td className="px-1.5 sm:px-4 py-3 text-right">
                          <div className={`text-sm ${getGainLossColor(account.totalGainLoss)}`}>
                            {fmtAcct(account.totalGainLoss)}
                          </div>
                          <div className={`text-xs ${getGainLossColor(account.totalGainLossPercent)}`}>
                            {formatPercent(account.totalGainLossPercent)}
                          </div>
                        </td>
                        <td className="px-1.5 sm:px-4 py-3 text-right text-sm text-gray-500 dark:text-gray-400">
                          {getPortfolioPercent(accountTotalValue, acctDisplayCurrency || account.currencyCode)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface HoldingRowProps {
  holding: HoldingWithMarketValue;
  defaultCurrency: string;
  accountCurrency: string;
  getRate: (fromCurrency: string, toCurrency?: string) => number | null;
  formatCurrency: (value: number | null) => string;
  formatCurrencyWithCode: (value: number, currencyCode: string) => string;
  formatPrice: (value: number | null, currencyCode?: string) => string;
  formatQuantity: (value: number) => string;
  formatPercent: (value: number | null, showSign?: boolean) => string;
  getGainLossColor: (value: number | null) => string;
  getPortfolioPercent: (value: number | null, currencyCode?: string) => string;
  onSecurityClick?: (securityId: string) => void;
}

const HoldingRow = memo(function HoldingRow({
  holding,
  defaultCurrency,
  accountCurrency,
  getRate,
  formatCurrency,
  formatCurrencyWithCode,
  formatPrice,
  formatQuantity,
  formatPercent,
  getGainLossColor,
  getPortfolioPercent,
  onSecurityClick,
}: HoldingRowProps) {
  const t = useTranslations('investments');
  const isForeign = holding.currencyCode && holding.currencyCode !== defaultCurrency;
  const isForeignToAccount =
    holding.currencyCode && holding.currencyCode !== accountCurrency;

  const fmtVal = (value: number | null) => {
    if (value === null) return '-';
    if (isForeign) return `${formatCurrencyWithCode(value, holding.currencyCode)} ${holding.currencyCode}`;
    return formatCurrency(value);
  };

  const fmtPrice = (value: number | null) => {
    if (value === null) return '-';
    if (isForeign) return `${formatPrice(value, holding.currencyCode)} ${holding.currencyCode}`;
    return formatPrice(value);
  };

  // Cost basis in account currency comes from the backend using historical
  // exchange rates stored on each BUY transaction. Market value uses the
  // current rate (shares are worth what the market says today), so the
  // gain/loss line below it is derived from those two values — keeping the
  // displayed rows aligned with the account total row beneath the table.
  //
  // Through getRate, not convert(): convert passes the amount through
  // unchanged when the pair has no rate, so a EUR value rendered as
  // "≈ ¥600 JPY" directly beside the account's Partial marker saying the
  // value could not be worked out in JPY (review #1133). No rate means the
  // account-currency value is unknown, and the ≈ sub-line stays absent like
  // the backend's own costBasisAccountCurrency does.
  const acctRate = isForeignToAccount
    ? getRate(holding.currencyCode, accountCurrency)
    : 1;
  const marketValueAcct =
    holding.marketValue !== null && acctRate !== null
      ? holding.marketValue * acctRate
      : null;
  // Unknown basis makes the gain unknown, not equal to the market value.
  const gainLossAcct =
    marketValueAcct !== null && holding.costBasisAccountCurrency !== null
      ? marketValueAcct - holding.costBasisAccountCurrency
      : null;

  const fmtAcctConverted = (value: number | null) => {
    if (value === null || !isForeignToAccount) return null;
    return `\u2248 ${formatCurrencyWithCode(value, accountCurrency)} ${accountCurrency}`;
  };

  return (
    <tr className="hover:bg-gray-50 dark:hover:bg-gray-700/20">
      <td className="px-2 sm:px-6 py-3 whitespace-nowrap">
        <button
          onClick={() => onSecurityClick?.(holding.securityId)}
          className="text-left hover:underline focus:outline-none focus:underline"
          title={t('groupedHoldings.symbolClickTitle')}
        >
          <div className="font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300">
            {holding.symbol}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-[120px] sm:max-w-[320px]">
            {holding.name}
          </div>
        </button>
      </td>
      <td className="px-1.5 sm:px-4 py-3 whitespace-nowrap text-right text-sm text-gray-900 dark:text-gray-100">
        {formatQuantity(holding.quantity)}
      </td>
      <td className="px-1.5 sm:px-4 py-3 whitespace-nowrap text-right text-sm text-gray-900 dark:text-gray-100">
        {fmtPrice(holding.averageCost)}
      </td>
      <td className="px-1.5 sm:px-4 py-3 whitespace-nowrap text-right text-sm text-gray-900 dark:text-gray-100">
        {fmtPrice(holding.currentPrice)}
      </td>
      <td className="px-1.5 sm:px-4 py-3 whitespace-nowrap text-right text-sm text-gray-900 dark:text-gray-100">
        <div>{fmtVal(holding.costBasis)}</div>
        {isForeignToAccount && (
          <div className="text-xs font-normal text-gray-400 dark:text-gray-500">
            {fmtAcctConverted(holding.costBasisAccountCurrency)}
          </div>
        )}
      </td>
      <td className="px-1.5 sm:px-4 py-3 whitespace-nowrap text-right text-sm font-medium text-gray-900 dark:text-gray-100">
        <div>{fmtVal(holding.marketValue)}</div>
        {isForeignToAccount && (
          <div className="text-xs font-normal text-gray-400 dark:text-gray-500">
            {fmtAcctConverted(marketValueAcct)}
          </div>
        )}
      </td>
      <td className="px-1.5 sm:px-4 py-3 whitespace-nowrap text-right">
        <div className={`text-sm font-medium ${getGainLossColor(holding.gainLoss)}`}>
          {fmtVal(holding.gainLoss)}
        </div>
        {isForeignToAccount && (
          <div className="text-xs font-normal text-gray-400 dark:text-gray-500">
            {fmtAcctConverted(gainLossAcct)}
          </div>
        )}
        <div className={`text-xs ${getGainLossColor(holding.gainLossPercent)}`}>
          {formatPercent(holding.gainLossPercent)}
        </div>
      </td>
      <td className="px-1.5 sm:px-4 py-3 whitespace-nowrap text-right text-sm text-gray-500 dark:text-gray-400">
        {getPortfolioPercent(holding.marketValue, holding.currencyCode)}
      </td>
    </tr>
  );
});
