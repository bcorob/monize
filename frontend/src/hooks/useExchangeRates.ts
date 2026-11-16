import { useState, useEffect, useCallback, useMemo } from 'react';
import { exchangeRatesApi, ExchangeRate } from '@/lib/exchange-rates';
import { usePreferencesStore } from '@/store/preferencesStore';
import { createLogger } from '@/lib/logger';
import { preferredCurrency } from '@/lib/default-currency';
import { isFxRateStale } from '@/lib/fx-rate-age';
import { useFinancialToday } from '@/hooks/useFinancialToday';

const logger = createLogger('ExchangeRates');

/**
 * Currency conversion for the client.
 *
 * **A missing rate returns `null`, not the amount.** `convert` used to hand back
 * the unconverted figure, and every caller then formatted it under the target
 * currency's symbol: a 100.00 USD balance with no USD->EUR rate was rendered as
 * "100.00 EUR" and summed into Assets, Liabilities and Net Worth. The error is
 * silent, unbounded, scales with each unconverted account, and can reverse the
 * sign of a trend. An unavailable rate is not a rate of one; it is a value the
 * total cannot include.
 *
 * Callers that aggregate must therefore decide what to do with `null` -- report
 * the total as partial, or exclude it and say so. `sumConverted`
 * (`lib/currency-total.ts`) is the shared way to do that.
 */
export function useExchangeRates() {
  const [rates, setRates] = useState<ExchangeRate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  /**
   * The rate table could not be fetched.
   *
   * Distinct from an empty one, because the two mean opposite things to a
   * caller. With no rates loaded every cross-currency `convert` returns `null`,
   * and a surface reading only that reports "no exchange rate for CAD -- add one
   * on Currencies": correct when the table really is missing that pair, and a
   * wrong instruction while the request is still in flight or after it failed,
   * pointing the reader at a rate that already exists. `docs` calls this out as
   * a class: a failed lookup is not an empty dataset.
   */
  const [hasFailed, setHasFailed] = useState(false);
  const defaultCurrency = preferredCurrency(
    usePreferencesStore((state) => state.preferences?.defaultCurrency),
  );
  const todayYmd = useFinancialToday();

  const refresh = useCallback(() => {
    // Every state write here follows the `await`. Keeping them in this inner
    // function rather than in `refresh` itself is what lets the mount effect
    // call `refresh` without being read as a synchronous setState.
    const fetchRates = async () => {
      try {
        const data = await exchangeRatesApi.getLatestRates();
        setRates(data);
        setHasFailed(false);
      } catch (error) {
        logger.error('Failed to load exchange rates:', error);
        setHasFailed(true);
      } finally {
        setIsLoading(false);
      }
    };
    return fetchRates();
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Build a lookup map: "USD->CAD" => 1.365. A row older than
  // `FX_MAX_RATE_AGE_DAYS` is left out (INV-FX-001): the pair is then unknown.
  // `rates` keeps every row, the stored fact.
  const rateMap = useMemo(() => buildOrientedRateMap(rates, todayYmd), [rates, todayYmd]);

  /**
   * Convert `amount` into `toCurrency` (default: the user's display currency),
   * or `null` when no rate for the pair is known.
   *
   * Same currency is 1:1 by definition and returns the amount unchanged -- that
   * is a known rate, not a fallback.
   */
  const convert = useCallback(
    (amount: number, fromCurrency: string, toCurrency?: string): number | null => {
      const target = toCurrency || defaultCurrency;
      if (fromCurrency === target) return amount;

      // Direct rate
      const directRate = rateMap.get(`${fromCurrency}->${target}`);
      if (directRate) return amount * directRate;

      // Inverse rate
      const inverseRate = rateMap.get(`${target}->${fromCurrency}`);
      if (inverseRate && inverseRate !== 0) return amount / inverseRate;

      // No rate available. Log the pair so it is diagnosable, but do not
      // manufacture a figure -- and stay quiet while the request is still in
      // flight, when "missing" only means "not yet".
      if (!isLoading) {
        logger.warn(`No exchange rate for ${fromCurrency}->${target}`);
      }
      return null;
    },
    [rateMap, defaultCurrency, isLoading],
  );

  const convertToDefault = useCallback(
    (amount: number, fromCurrency: string): number | null => {
      return convert(amount, fromCurrency, defaultCurrency);
    },
    [convert, defaultCurrency],
  );

  const getRate = useCallback(
    (fromCurrency: string, toCurrency?: string): number | null => {
      const target = toCurrency || defaultCurrency;
      if (fromCurrency === target) return 1;
      const direct = rateMap.get(`${fromCurrency}->${target}`);
      if (direct) return direct;
      const inverse = rateMap.get(`${target}->${fromCurrency}`);
      if (inverse && inverse !== 0) return 1 / inverse;
      return null;
    },
    [rateMap, defaultCurrency],
  );

  return {
    rates,
    rateMap,
    isLoading,
    /**
     * True when the rate table is not available to be consulted -- still
     * loading, or the fetch failed. A caller reporting a missing PAIR has to
     * check this first: while it holds, "no rate for X" is a statement about
     * this request, not about the user's rates.
     */
    ratesUnavailable: isLoading || hasFailed,
    ratesFailed: hasFailed,
    convert,
    convertToDefault,
    getRate,
    refresh,
    defaultCurrency,
  };
}

/**
 * Rate lookup map, one orientation per pair.
 *
 * When both `A->B` and `B->A` are stored, the row with the newer `rateDate`
 * wins and the other key is left out, so `convert` cannot reach the old row
 * through "direct first" (INV-FX-003: a pre-1.17 deployment holds a frozen
 * mirror row). A date tie keeps both, so the direct key answers.
 * With `todayYmd`, a row older than `FX_MAX_RATE_AGE_DAYS` is dropped first
 * (INV-FX-001); without it no age bound applies (historical maps).
 */
function buildOrientedRateMap(rates: ExchangeRate[], todayYmd?: string): Map<string, number> {
  const rows = new Map<string, ExchangeRate>();
  rates.forEach((r) => {
    if (todayYmd !== undefined && isFxRateStale(r.rateDate, todayYmd)) return;
    const key = `${r.fromCurrency}->${r.toCurrency}`;
    const inverse = rows.get(`${r.toCurrency}->${r.fromCurrency}`);
    if (inverse) {
      // Newer wins; on a tie both stay and a lookup finds the direct key.
      const mine = r.rateDate.slice(0, 10);
      const theirs = inverse.rateDate.slice(0, 10);
      if (mine > theirs) rows.delete(`${r.toCurrency}->${r.fromCurrency}`);
      else if (mine < theirs) return;
    }
    const same = rows.get(key);
    if (same && same.rateDate.slice(0, 10) >= r.rateDate.slice(0, 10)) return;
    rows.set(key, r);
  });
  const map = new Map<string, number>();
  rows.forEach((r, key) => map.set(key, Number(r.rate)));
  return map;
}

/**
 * Build a rate map from an array of ExchangeRate objects.
 * Used for historical rate lookups in the NetWorthReport, so no age bound.
 */
export function buildRateMap(rates: ExchangeRate[]): Map<string, number> {
  return buildOrientedRateMap(rates);
}

/**
 * Convert an amount using a rate map (for historical rate lookups), or `null`
 * when the pair is not in it. Same reasoning as `convert` above: an unconverted
 * amount labelled with the target currency is a wrong number, not a partial one.
 */
export function convertWithRateMap(
  amount: number,
  fromCurrency: string,
  toCurrency: string,
  rateMap: Map<string, number>,
): number | null {
  if (fromCurrency === toCurrency) return amount;

  const directRate = rateMap.get(`${fromCurrency}->${toCurrency}`);
  if (directRate) return amount * directRate;

  const inverseRate = rateMap.get(`${toCurrency}->${fromCurrency}`);
  if (inverseRate && inverseRate !== 0) return amount / inverseRate;

  return null;
}
