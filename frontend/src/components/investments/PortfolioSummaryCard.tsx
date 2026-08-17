'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { PortfolioSummary } from '@/types/investment';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { gainLossColor } from '@/lib/format';

interface PortfolioSummaryCardProps {
  summary: PortfolioSummary | null;
  isLoading: boolean;
  singleAccountCurrency?: string | null;
  titleSuffix?: string;
}

export function PortfolioSummaryCard({
  summary,
  isLoading,
  singleAccountCurrency,
  titleSuffix,
}: PortfolioSummaryCardProps) {
  const t = useTranslations('investments');
  const { formatCurrency, formatSignedPercent } = useNumberFormat();
  const { getRate, defaultCurrency } = useExchangeRates();

  // When viewing a single foreign-currency account, show values in that currency
  const foreignCurrency = singleAccountCurrency && singleAccountCurrency !== defaultCurrency
    ? singleAccountCurrency
    : null;

  const converted = useMemo(() => {
    if (!summary) return null;

    if (foreignCurrency) {
      // Single foreign account: use raw values without conversion
      let cash = 0;
      let holdings = 0;
      let costBasis = 0;
      let netInvested = 0;
      for (const acct of summary.holdingsByAccount) {
        cash += acct.cashBalance;
        holdings += acct.totalMarketValue;
        costBasis += acct.totalCostBasis;
        netInvested += acct.netInvested;
      }
      const portfolio = cash + holdings;
      const gainLoss = holdings - costBasis;
      const gainLossPercent = costBasis > 0 ? (gainLoss / costBasis) * 100 : 0;
      return { cash, holdings, costBasis, netInvested, portfolio, gainLoss, gainLossPercent };
    }

    // Default-currency view: use the backend totals as-is. They are already
    // converted to the default currency using live spot FX -- the same rate
    // source the Portfolio Value Over Time chart uses -- so the two stay in
    // sync. Re-converting per account here with the cached daily-snapshot
    // rates from useExchangeRates drifted from the chart (and triangulated
    // through each account's currency); returning null makes every field below
    // fall back to summary.total* directly.
    return null;
  }, [summary, foreignCurrency]);

  // Compute default-currency total when showing foreign, for the "approx" line.
  //
  // Through getRate, never convertToDefault: convertToDefault passes the amount
  // through unchanged when the pair has no rate, so a JPY total with no JPY->USD
  // rate rendered as "~ $15,000.00 USD" -- an implicit rate of 1, which "Rate 1
  // means same currency, never no rate found" forbids (review #1133). A missing
  // rate makes the approximation unknown; null suppresses the line.
  const defaultTotal = useMemo(() => {
    if (!summary || !foreignCurrency) return null;
    let total = 0;
    for (const acct of summary.holdingsByAccount) {
      const rate = getRate(acct.currencyCode, defaultCurrency);
      if (rate === null) return null;
      total += (acct.cashBalance + acct.totalMarketValue) * rate;
    }
    return total;
  }, [summary, getRate, defaultCurrency, foreignCurrency]);

  // Completeness has to come from the SAME aggregate that supplies the displayed
  // values. In the default-currency view that is the summary's own top-level
  // flags; in the single foreign-account view the displayed values are the
  // account-currency subtotals from `holdingsByAccount`, whose conversion path --
  // into the account's currency -- can be incomplete even when the top-level
  // default-currency totals are complete. Reading the top-level flag there let a
  // JPY account whose EUR->JPY rate was missing render 0 JPY under an ordinary
  // total with no warning (recheck RR5-001). Absent fields read as complete
  // (`!== false`), the same rolling-deploy defence as everywhere else here.
  const completeness = useMemo(() => {
    if (!summary) {
      return {
        valuationComplete: true,
        pricesComplete: true,
        fxComplete: true,
        missingRatePairs: [] as string[],
        unpricedSecurityIds: [] as string[],
      };
    }
    if (foreignCurrency) {
      const accounts = summary.holdingsByAccount;
      return {
        valuationComplete: accounts.every((a) => a.valuationComplete !== false),
        pricesComplete: accounts.every((a) => a.pricesComplete !== false),
        fxComplete: accounts.every((a) => a.fxComplete !== false),
        missingRatePairs: [
          ...new Set(accounts.flatMap((a) => a.missingRatePairs ?? [])),
        ].sort(),
        unpricedSecurityIds: [
          ...new Set(accounts.flatMap((a) => a.unpricedSecurityIds ?? [])),
        ].sort(),
      };
    }
    return {
      valuationComplete: summary.valuationComplete !== false,
      pricesComplete: summary.pricesComplete !== false,
      fxComplete: summary.fxComplete !== false,
      missingRatePairs: summary.missingRatePairs ?? [],
      unpricedSecurityIds: summary.unpricedSecurityIds ?? [],
    };
  }, [summary, foreignCurrency]);

  const fmtVal = (value: number) => {
    if (foreignCurrency) return `${formatCurrency(value, foreignCurrency)} ${foreignCurrency}`;
    return formatCurrency(value);
  };

  const formatPercent = (value: number) => formatSignedPercent(value);

  const returnColorClass = (value: number | null | undefined) => {
    if (value == null) return 'text-gray-400 dark:text-gray-500';
    return gainLossColor(value);
  };

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 lg:min-h-[420px]">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('portfolioSummary.title')}{titleSuffix ? ` (${titleSuffix})` : ''}
        </h3>
        <div className="space-y-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="animate-pulse">
              <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-1/3 mb-1" />
              <div className="h-6 bg-gray-200 dark:bg-gray-700 rounded w-1/2" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 lg:min-h-[420px]">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('portfolioSummary.title')}{titleSuffix ? ` (${titleSuffix})` : ''}
        </h3>
        <p className="text-gray-500 dark:text-gray-400">
          {t('portfolioSummary.noData')}
        </p>
      </div>
    );
  }

  // The server knows when a total is a subtotal; it used to say so and this card
  // rendered the number under a total's label anyway (recheck RR4-002). A missing
  // price and a missing rate are different causes, so they get different sentences.
  //
  // Read defensively: during a rolling deploy the page can briefly receive a
  // response from an older backend that has none of these fields. Absent means "no
  // information", which must not render as "incomplete" -- and must certainly not
  // crash the page.
  const unpricedSymbols = completeness.unpricedSecurityIds
    .map(
      (id) =>
        summary.holdings.find((holding) => holding.securityId === id)?.symbol ??
        id,
    )
    .sort();
  const incompleteReasons: string[] = [];
  if (!completeness.pricesComplete && unpricedSymbols.length > 0) {
    incompleteReasons.push(
      t('portfolioSummary.incompletePrices', {
        symbols: unpricedSymbols.join(', '),
      }),
    );
  }
  const missingRatePairs = completeness.missingRatePairs;
  if (!completeness.fxComplete && missingRatePairs.length > 0) {
    incompleteReasons.push(
      t('portfolioSummary.incompleteFx', {
        pairs: missingRatePairs.join(', '),
      }),
    );
  }
  const valuationIncomplete = !completeness.valuationComplete;

  const gainLossVal = converted?.gainLoss ?? summary.totalGainLoss;
  const gainLossPercentVal = converted?.gainLossPercent ?? summary.totalGainLossPercent;
  const twr = summary.timeWeightedReturn;
  const cagrVal = summary.cagr;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 lg:min-h-[420px]">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
        {t('portfolioSummary.title')}{titleSuffix ? ` (${titleSuffix})` : ''}
      </h3>

      {valuationIncomplete && incompleteReasons.length > 0 && (
        <div
          role="status"
          className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200"
        >
          <div className="font-medium">
            {t('portfolioSummary.incompleteHeading')}
          </div>
          <ul className="mt-1 list-disc pl-5 space-y-0.5">
            {incompleteReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-4">
        {/* Total Portfolio Value -- labelled a partial when it is one. */}
        <div>
          <div className="text-sm text-gray-500 dark:text-gray-400">
            {valuationIncomplete
              ? t('portfolioSummary.knownPortfolioSubtotal')
              : t('portfolioSummary.totalPortfolioValue')}
          </div>
          <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {fmtVal(converted?.portfolio ?? summary.totalPortfolioValue)}
          </div>
          {foreignCurrency && defaultTotal !== null && !valuationIncomplete && (
            <div className="text-xs text-gray-400 dark:text-gray-500">
              {'\u2248 '}{formatCurrency(defaultTotal, defaultCurrency)} {defaultCurrency}
            </div>
          )}
        </div>

        {/* Values Section */}
        <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
          <div className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-3">
            {t('portfolioSummary.values')}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
            <div>
              <div className="text-xs sm:text-sm text-gray-500 dark:text-gray-400 flex items-center">
                {t('portfolioSummary.holdingsValue')}
                <InfoTooltip placement="top" text={t('portfolioSummary.holdingsValueTooltip')} />
              </div>
              <div className="text-base sm:text-lg font-semibold text-gray-900 dark:text-gray-100">
                {fmtVal(converted?.holdings ?? summary.totalHoldingsValue)}
              </div>
            </div>
            <div>
              <div className="text-xs sm:text-sm text-gray-500 dark:text-gray-400 flex items-center">
                {t('portfolioSummary.cashBalance')}
                <InfoTooltip placement="top" text={t('portfolioSummary.cashBalanceTooltip')} />
              </div>
              <div className="text-base sm:text-lg font-semibold text-gray-900 dark:text-gray-100">
                {fmtVal(converted?.cash ?? summary.totalCashValue)}
              </div>
            </div>
            <div>
              <div className="text-xs sm:text-sm text-gray-500 dark:text-gray-400 flex items-center">
                {t('portfolioSummary.totalGain')}
                <InfoTooltip placement="top" text={t('portfolioSummary.totalGainTooltip')} />
              </div>
              <div className={`text-base sm:text-lg font-semibold ${returnColorClass((converted?.portfolio ?? summary.totalPortfolioValue) - (converted?.netInvested ?? summary.totalNetInvested))}`}>
                {fmtVal((converted?.portfolio ?? summary.totalPortfolioValue) - (converted?.netInvested ?? summary.totalNetInvested))}
              </div>
            </div>
            <div>
              <div className="text-xs sm:text-sm text-gray-500 dark:text-gray-400 flex items-center">
                {t('portfolioSummary.netInvested')}
                <InfoTooltip placement="top" text={t('portfolioSummary.netInvestedTooltip')} />
              </div>
              <div className="text-base sm:text-lg font-semibold text-gray-900 dark:text-gray-100">
                {fmtVal(converted?.netInvested ?? summary.totalNetInvested)}
              </div>
            </div>
            <div>
              <div className="text-xs sm:text-sm text-gray-500 dark:text-gray-400 flex items-center">
                {t('portfolioSummary.costBasis')}
                <InfoTooltip placement="top" text={t('portfolioSummary.costBasisTooltip')} />
              </div>
              <div className="text-base sm:text-lg font-semibold text-gray-900 dark:text-gray-100">
                {fmtVal(converted?.costBasis ?? summary.totalCostBasis)}
              </div>
            </div>
            <div>
              <div className="text-xs sm:text-sm text-gray-500 dark:text-gray-400 flex items-center">
                {t('portfolioSummary.gainLoss')}
                <InfoTooltip placement="top" text={t('portfolioSummary.gainLossTooltip')} />
              </div>
              <div className={`text-base sm:text-lg font-semibold ${returnColorClass(gainLossVal)}`}>
                {fmtVal(gainLossVal)}
              </div>
            </div>
          </div>
        </div>

        {/* Returns Section */}
        <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
          <div className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-3">
            {t('portfolioSummary.returns')}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
            <div>
              <div className="text-xs sm:text-sm text-gray-500 dark:text-gray-400 flex items-center">
                {t('portfolioSummary.simpleReturn')}
                <InfoTooltip placement="top" text={t('portfolioSummary.simpleReturnTooltip')} />
              </div>
              <div className={`text-base sm:text-lg font-semibold ${returnColorClass(gainLossPercentVal)}`}>
                {formatPercent(gainLossPercentVal)}
              </div>
            </div>
            <div>
              <div className="text-xs sm:text-sm text-gray-500 dark:text-gray-400 flex items-center">
                {t('portfolioSummary.twr')}
                <span className="hidden sm:inline">&nbsp;{t('portfolioSummary.twrFull')}</span>
                <InfoTooltip placement="top" text={t('portfolioSummary.twrTooltip')} />
              </div>
              <div className={`text-base sm:text-lg font-semibold ${returnColorClass(twr)}`}>
                {twr != null ? formatPercent(twr) : (
                  <span className="text-gray-400 dark:text-gray-500 text-sm font-normal">{t('portfolioSummary.notAvailable')}</span>
                )}
              </div>
            </div>
            <div>
              <div className="text-xs sm:text-sm text-gray-500 dark:text-gray-400 flex items-center">
                {t('portfolioSummary.cagr')}
                <InfoTooltip placement="top" text={t('portfolioSummary.cagrTooltip')} />
              </div>
              <div className={`text-base sm:text-lg font-semibold ${returnColorClass(cagrVal)}`}>
                {cagrVal != null ? formatPercent(cagrVal) : (
                  <span className="text-gray-400 dark:text-gray-500 text-sm font-normal">{t('portfolioSummary.notAvailable')}</span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
