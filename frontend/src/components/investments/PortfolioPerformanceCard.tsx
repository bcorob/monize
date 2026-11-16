'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import {
  usePortfolioPeriodResults,
  type UsePortfolioPeriodResultsValue,
} from '@/hooks/usePortfolioPeriodResults';
import { PerformancePeriodsCard } from '@/components/ui/PerformancePeriodsCard';
import { withheldPeriodCause } from './portfolio-period-result';
import {
  BASE_PORTFOLIO_PERIOD_PRESETS,
  PORTFOLIO_PERIOD_PRESETS,
} from '@/types/net-worth';
import type {
  PortfolioPeriodPreset,
  PortfolioPeriodResult,
} from '@/types/net-worth';

interface PortfolioPerformanceCardProps {
  /** The page's account filter, as it goes to the chart beside this card. */
  accountIds?: string[];
  /** Report in this currency instead of the reader's preferred one. */
  displayCurrency?: string | null;
  /** Bumped by the page after a write, so the figures follow the ledger. */
  reloadKey?: number;
  /**
   * The batch answer, when the page asked for it once on behalf of this card
   * and the value chart beside it (#1888). Absent, the card asks for itself.
   */
  periodResults?: UsePortfolioPeriodResultsValue;
}

/**
 * What the portfolio earned over each trailing period, deposits taken out.
 *
 * Every figure comes from `GET /net-worth/investments-period-results` and
 * nothing here subtracts or divides: a change derived from the value series
 * counts the reader's own contributions as performance, which is the defect
 * INV-PORTRESULT-001 exists to stop (issue #1392).
 *
 * What it reports is the INVESTED part: `investmentReturnPercent`, the
 * server's time-weighted return over the securities alone, and
 * `investmentPnl` beneath it. Cash held in an investment account is not an
 * investment, so it is in neither figure and in neither the numerator nor the
 * base of the percentage: paying it in or out moves nothing here
 * (INV-PORTRESULT-002, `docs/specs/portfolio-period-result.md` section 10).
 * The account-level `investmentResult` and `returnPercent` still travel on the
 * same payload; they answer what the ACCOUNT did, which this card does not ask.
 *
 * A period the server could not report reads "n/a", the same answer the
 * security card gives for a window its history does not cover, and for the same
 * reason: a zero would be a claim that nothing happened. A request that has not
 * answered yet, or failed, leaves every period unknown rather than zero.
 *
 * WHICH windows there are is the server's answer too. The long ones (2Y, 5Y,
 * 10Y) come back only where the portfolio's history reaches them, and the
 * all-time row only where it has ever held anything, so this card lists the
 * windows it was sent rather than a fixed six. A row nobody can ever fill in
 * is not an "n/a" worth printing: unlike a window withheld for a missing
 * price, there is nothing to add. Until the server answers, the base windows
 * stand in, so the list grows into its full length instead of shrinking out of
 * a longer one.
 */
export function PortfolioPerformanceCard({
  accountIds,
  displayCurrency,
  reloadKey,
  periodResults,
}: PortfolioPerformanceCardProps) {
  const t = useTranslations('investments');
  const { formatCurrency, formatSignedPercent, defaultCurrency } =
    useNumberFormat();
  const own = usePortfolioPeriodResults({
    periods: PORTFOLIO_PERIOD_PRESETS.join(','),
    accountIds:
      accountIds && accountIds.length > 0 ? accountIds.join(',') : undefined,
    displayCurrency: displayCurrency ?? undefined,
    reloadKey,
    skip: periodResults !== undefined,
  });
  const { results, status } = periodResults ?? own;

  /**
   * The windows on screen: what the server reported, in the canonical order,
   * or the base windows while it has not answered.
   */
  const presets = useMemo<readonly PortfolioPeriodPreset[]>(() => {
    if (!results) return BASE_PORTFOLIO_PERIOD_PRESETS;
    return PORTFOLIO_PERIOD_PRESETS.filter(
      (preset) => results.periods?.[preset] !== undefined,
    );
  }, [results]);

  const entries = useMemo(() => {
    const currency = results?.currency;
    // The chart's convention for a figure reported in a currency that is not
    // the reader's own: the code is named, so nobody reads it as their money.
    const money = (value: number) => {
      const amount = formatCurrency(value, currency);
      const signed = `${value >= 0 ? '+' : ''}${amount}`;
      return currency && currency !== defaultCurrency
        ? `${signed} ${currency}`
        : signed;
    };

    return presets.map((preset) => {
      const period = results?.periods?.[preset];
      // Each figure is judged on its own: a period whose money is known and
      // whose ratio is not (a portfolio that started the window at nothing)
      // still has an amount worth reading.
      const percent = period?.investmentReturnPercent ?? null;
      const result = period?.investmentPnl ?? null;
      return {
        period: preset,
        label: t(`portfolioPerformance.periods.${preset}` as Parameters<typeof t>[0]),
        primary: percent === null ? null : formatSignedPercent(percent),
        primaryValue: percent,
        secondary: result === null ? null : money(result),
        secondaryValue: result,
      };
    });
  }, [
    presets,
    results,
    t,
    formatCurrency,
    formatSignedPercent,
    defaultCurrency,
  ]);

  // Why a figure is missing, said once under the list. A request that has
  // not answered, or failed, is named as such; a period the server withheld
  // for a cause the reader can repair names that cause. Only a portfolio
  // whose scope produced no valued day at all falls to the empty message.
  const notice = useMemo(() => {
    if (status === 'loading') return t('portfolioPerformance.loading');
    if (status === 'error') return t('portfolioPerformance.loadFailed');
    const withheld = presets
      .map((preset) => results?.periods?.[preset])
      .filter(
        (period): period is PortfolioPeriodResult =>
          !!period && (period.investmentPnl ?? null) === null,
      );
    // The cause of a withheld INVESTED figure is `investedReasons`; a backend
    // that does not send them yet has withheld for no reason it named, and the
    // list's own "n/a" is then the whole answer.
    const cause = withheldPeriodCause(
      withheld.map((period) => period.investedReasons ?? []),
    );
    return cause === null
      ? undefined
      : t(`portfolioPerformance.reasons.${cause}` as Parameters<typeof t>[0]);
  }, [presets, status, results, t]);

  return (
    <PerformancePeriodsCard
      title={t('portfolioPerformance.title')}
      subtitle={t('portfolioPerformance.subtitle')}
      entries={entries}
      unavailableLabel={t('portfolioPerformance.unavailable')}
      emptyMessage={t('portfolioPerformance.empty')}
      notice={notice}
      data-testid="portfolio-performance"
    />
  );
}
