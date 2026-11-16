import { daysBetweenYmd } from '@/lib/bank-sync-link-defaults';

/**
 * The oldest stored exchange rate the client converts at, in whole days.
 *
 * Mirrors the backend's `FX_MAX_RATE_AGE_DAYS`
 * (`backend/src/common/time-series/fx-rate-resolver.ts`, INV-FX-001) and is held
 * to it by `fx-rate-age.contract.test.ts`. A rate older than this is unknown,
 * not a rate: the client shows "no rate" rather than converting at it.
 */
export const FX_MAX_RATE_AGE_DAYS = 45;

/**
 * True when `rateDate` (`YYYY-MM-DD`) is more than `FX_MAX_RATE_AGE_DAYS` before
 * `todayYmd` (the user's financial today, `useFinancialToday()`). A rate dated
 * after today is not stale. An unreadable date is stale: it cannot be shown to
 * be inside the bound.
 */
export function isFxRateStale(rateDate: string, todayYmd: string): boolean {
  const age = daysBetweenYmd(rateDate.slice(0, 10), todayYmd);
  if (age === null) return true;
  return age > FX_MAX_RATE_AGE_DAYS;
}
