'use client';

import { useEffect, useState } from 'react';
import { netWorthApi } from '@/lib/net-worth';
import { createLogger } from '@/lib/logger';
import type { PortfolioPeriodResults } from '@/types/net-worth';

const logger = createLogger('usePortfolioPeriodResults');

interface UsePortfolioPeriodResultsOptions {
  /** Comma-separated presets, or undefined for every one the server knows. */
  periods?: string;
  /** Comma-separated account filter, as the page sends it to the chart. */
  accountIds?: string;
  /** Display currency override, as the page sends it to the chart. */
  displayCurrency?: string;
  /** Bumped by the surface when a write changed the rows behind the windows. */
  reloadKey?: number;
  /**
   * Ask nothing: the caller was handed the same answer by the page that owns
   * the request (`PortfolioPerformanceCard`'s `periodResults`).
   */
  skip?: boolean;
}

export interface UsePortfolioPeriodResultsValue {
  /**
   * What the server says the portfolio did over each window, or null while it
   * has not answered for THIS request -- a load in flight or a failed one.
   * While a reload of the same scope is in flight it is the previous answer.
   * Null is never a set of periods that did nothing: nothing here subtracts,
   * divides or falls back to zero.
   */
  results: PortfolioPeriodResults | null;
  /**
   * Whether `results` is null because the request is in flight, because it
   * failed, or not at all. The two nulls are different things to show: a
   * failed request is not a portfolio with nothing to report.
   */
  status: 'loading' | 'ready' | 'error';
}

/**
 * Every trailing period's result for one scope, in one request.
 *
 * The sibling of `usePortfolioPeriodResult` and keyed the same way: the payload
 * is kept WITH the key of the request that produced it, so an account or
 * currency switch cannot leave the previous scope's figures under the new
 * scope's caption, and a failed request leaves the figures unknown rather than
 * stale. The dates are not among the inputs because this route does not take
 * any: the server decides what today is and where each window opens, which is
 * what keeps every window to one valuation.
 */
export function usePortfolioPeriodResults({
  periods,
  accountIds,
  displayCurrency,
  reloadKey = 0,
  skip = false,
}: UsePortfolioPeriodResultsOptions = {}): UsePortfolioPeriodResultsValue {
  const scopeKey = JSON.stringify([
    periods ?? null,
    accountIds ?? null,
    displayCurrency ?? null,
  ]);
  const key = JSON.stringify([scopeKey, reloadKey]);
  const [state, setState] = useState<{
    key: string;
    scopeKey: string;
    results: PortfolioPeriodResults | null;
  } | null>(null);

  useEffect(() => {
    if (skip) return;
    let cancelled = false;
    netWorthApi
      .getInvestmentsPeriodResults({ periods, accountIds, displayCurrency })
      .then((results) => {
        if (!cancelled) setState({ key, scopeKey, results });
      })
      .catch((error) => {
        logger.error('Failed to load the period results:', error);
        if (!cancelled) setState({ key, scopeKey, results: null });
      });
    return () => {
      cancelled = true;
    };
  }, [key, scopeKey, periods, accountIds, displayCurrency, skip]);

  const answered = state?.key === key;
  // A reload of the same scope (a write or a price refresh moved `reloadKey`)
  // keeps the previous answer until the new one lands, as the page's other
  // sections do; dropping it emptied "Portfolio performance" to its loading
  // notice and fewer rows for the length of every reload. Another scope's
  // answer is never kept, and a failed reload still reads as failed.
  const previous =
    !answered && state?.scopeKey === scopeKey ? state.results : null;
  const results = answered ? state.results : previous;
  return {
    results,
    status: results !== null ? 'ready' : answered ? 'error' : 'loading',
  };
}
