import { createLogger } from '@/lib/logger';
import { LAST_TRANSACTION_CURRENCY_KEY } from '@/lib/lastTransactionCurrency';
import {
  LAST_TRANSACTION_DATE_KEY,
  LAST_INVESTMENT_TRANSACTION_DATE_KEY,
} from '@/lib/lastTransactionDate';

const logger = createLogger('IdentitySessionStorage');

/**
 * sessionStorage prefix for cached intraday portfolio responses. Per-tab, so
 * the data persists during a navigation but not across browser sessions. The
 * key carries the identity (`buildIntradayCacheKey`); this prefix is what
 * `clearAllIntradayCache` sweeps.
 */
export const INTRADAY_CACHE_PREFIX = 'monize-intraday|';

/**
 * Fixed sessionStorage keys that remember a value from one account's data (an
 * entry date, an entry currency). sessionStorage survives a reload, so a
 * sign-out or a context switch has to drop them (INV-SHARE-003).
 */
export const IDENTITY_SCOPED_SESSION_KEYS: readonly string[] = [
  LAST_TRANSACTION_DATE_KEY,
  LAST_INVESTMENT_TRANSACTION_DATE_KEY,
  LAST_TRANSACTION_CURRENCY_KEY,
];

export function clearAllIntradayCache(): void {
  if (typeof window === 'undefined') return;
  try {
    const ss = window.sessionStorage;
    const keys: string[] = [];
    for (let i = 0; i < ss.length; i++) {
      const k = ss.key(i);
      if (k && k.startsWith(INTRADAY_CACHE_PREFIX)) keys.push(k);
    }
    keys.forEach((k) => ss.removeItem(k));
  } catch (error) {
    logger.warn('Failed to clear intraday cache:', error);
  }
}

/**
 * Drop every sessionStorage entry that carries one identity's data. Called by
 * `logout()` and before the reload of a delegate context switch, the two moments
 * the tab's identity changes while sessionStorage survives.
 */
export function clearIdentityScopedSessionStorage(): void {
  clearAllIntradayCache();
  if (typeof window === 'undefined') return;
  try {
    IDENTITY_SCOPED_SESSION_KEYS.forEach((k) =>
      window.sessionStorage.removeItem(k),
    );
  } catch (error) {
    logger.warn('Failed to clear identity-scoped session storage:', error);
  }
}
