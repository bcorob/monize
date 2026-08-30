import { usePreferencesStore } from '@/store/preferencesStore';
import { financialTodayYmd } from '@/lib/financial-today';

/**
 * Today's date (YYYY-MM-DD) in the user's configured timezone -- see
 * `financialTodayYmd` for why that, and not UTC, is the calendar a financial
 * decision is made against.
 *
 * Deliberately not memoized. The value is a primitive, so a `useMemo` that
 * depends on it still compares by value, and memoizing on the preference alone
 * would freeze the day for a tab left open across midnight -- which is the same
 * class of stale-boundary defect this hook exists to remove.
 */
export function useFinancialToday(): string {
  const timezonePref = usePreferencesStore((s) => s.preferences?.timezone);
  return financialTodayYmd(timezonePref);
}
