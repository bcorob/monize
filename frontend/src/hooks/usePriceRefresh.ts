'use client';

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { investmentsApi } from '@/lib/investments';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';

const logger = createLogger('PriceRefresh');
const REFRESH_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

// Module-level state — persists across component mounts within the same SPA session
let lastRefreshTimestamp = 0;
let refreshInProgress = false;

export function isMarketHours(): boolean {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    weekday: 'short',
  }).formatToParts(now);

  const weekday = parts.find((p) => p.type === 'weekday')?.value;
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);

  if (weekday === 'Sat' || weekday === 'Sun') return false;

  const timeInMinutes = hour * 60 + minute;
  return timeInMinutes >= 570 && timeInMinutes < 960; // 9:30 AM - 4:00 PM
}

export function getRefreshInProgress(): boolean {
  return refreshInProgress;
}

export function setRefreshInProgress(value: boolean): void {
  refreshInProgress = value;
  if (value) {
    lastRefreshTimestamp = Date.now();
  }
}

interface UsePriceRefreshOptions {
  onRefreshComplete?: (lastUpdated?: string) => Promise<void> | void;
}

interface UsePriceRefreshReturn {
  isRefreshing: boolean;
  /**
   * Manually refresh quote prices.
   *
   * @param scopeSecurityIds When provided, only securities whose ID is in
   *   this list are refreshed (intersected with the usual eligibility
   *   filter). The page passes the IDs of the holdings currently shown so
   *   the Refresh button only re-fetches what the user is looking at,
   *   instead of every active security in their catalog.
   */
  triggerManualRefresh: (scopeSecurityIds?: string[]) => Promise<void>;
  triggerAutoRefresh: () => void;
}

export function usePriceRefresh({ onRefreshComplete }: UsePriceRefreshOptions = {}): UsePriceRefreshReturn {
  const t = useTranslations('securities');
  const [isRefreshing, setIsRefreshing] = useState(false);

  const doRefresh = useCallback(
    async (silent: boolean, scopeSecurityIds?: string[]) => {
      if (refreshInProgress) return;
      refreshInProgress = true;
      setIsRefreshing(true);
      try {
        // Refresh prices for every active security in the user's catalog
        // unless the caller has narrowed the scope (e.g. the Investments
        // page passes the IDs of the holdings currently visible).
        //
        // Eligibility mirrors the backend's isRefreshEligible(): only a
        // security without skipPriceUpdates is fetched. The flag is the user's
        // "disable price updates" switch, and a provider override or MSN
        // Instrument ID saved beside it does not turn it back on (picking a new
        // one clears the flag server-side when the security is saved).
        const securities = await investmentsApi.getSecurities(false);
        const scopeSet = scopeSecurityIds
          ? new Set(scopeSecurityIds)
          : null;
        const securityIds = securities
          .filter(
            (s) =>
              s.isActive &&
              !s.skipPriceUpdates &&
              (scopeSet === null || scopeSet.has(s.id)),
          )
          .map((s) => s.id);
        if (securityIds.length === 0) {
          if (!silent) toast.success(t('priceRefresh.noneToUpdate'));
          return;
        }
        const result = await investmentsApi.refreshSelectedPrices(securityIds);
        lastRefreshTimestamp = Date.now();
        if (!silent) {
          if (result.failed > 0) {
            const failures = result.results.filter((r) => !r.success);
            const symbolList = failures.map((r) => r.symbol).join(', ');
            // The server already says *why* it refused, translated, and a
            // currency mismatch is repaired by editing the security rather
            // than by refreshing again: a count of failures alone sends the
            // reader nowhere. Distinct, because one refusal usually covers
            // every symbol in a group.
            const reasons = [
              ...new Set(failures.map((r) => r.error).filter((e): e is string => !!e)),
            ];
            const symbols = symbolList ? ` (${symbolList})` : '';
            toast.error(
              reasons.length > 0
                ? t('priceRefresh.partialFailureWithReasons', {
                    updated: result.updated,
                    failed: result.failed,
                    symbols,
                    reasons: reasons.join('\n'),
                  })
                : t('priceRefresh.partialFailure', {
                    updated: result.updated,
                    failed: result.failed,
                    symbols,
                  }),
              { duration: 8000 },
            );
          } else {
            toast.success(t('priceRefresh.updated', { count: result.updated }));
          }
        }
        // Only when something actually changed. `onRefreshComplete` reloads the
        // page's data -- on the Investments page a portfolio summary and a
        // transaction page, seconds of server work -- and a refresh that
        // updated nothing (market closed, every quote refused, nothing
        // eligible) leaves every one of those answers exactly as it was. The
        // user saw the page "reload" for no reason at t=5.6 s of a 6.8 s page
        // open. `updated` is the server's own count of rows it wrote.
        if (result.updated > 0) {
          await onRefreshComplete?.(result.lastUpdated);
        }
      } catch (error) {
        logger.error('Failed to refresh prices:', error);
        if (!silent) toast.error(getErrorMessage(error, t('priceRefresh.failed')));
      } finally {
        refreshInProgress = false;
        setIsRefreshing(false);
      }
    },
    [onRefreshComplete, t],
  );

  const triggerManualRefresh = useCallback(
    async (scopeSecurityIds?: string[]) => {
      await doRefresh(false, scopeSecurityIds);
    },
    [doRefresh],
  );

  const triggerAutoRefresh = useCallback(() => {
    if (!isMarketHours()) {
      logger.info('Skipping auto-refresh: outside market hours');
      return;
    }
    if (Date.now() - lastRefreshTimestamp < REFRESH_COOLDOWN_MS) {
      logger.info('Skipping auto-refresh: cooldown active');
      return;
    }
    if (refreshInProgress) {
      logger.info('Skipping auto-refresh: refresh already in progress');
      return;
    }
    doRefresh(true);
  }, [doRefresh]);

  return { isRefreshing, triggerManualRefresh, triggerAutoRefresh };
}
