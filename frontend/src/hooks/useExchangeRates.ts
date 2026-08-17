import { useState, useEffect, useCallback, useMemo } from 'react';
import { exchangeRatesApi, ExchangeRate } from '@/lib/exchange-rates';
import { usePreferencesStore } from '@/store/preferencesStore';
import { createLogger } from '@/lib/logger';

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
  const defaultCurrency =
    usePreferencesStore((state) => state.preferences?.defaultCurrency) || 'CAD';

  const refresh = useCallback(async () => {
    try {
      const data = await exchangeRatesApi.getLatestRates();
      setRates(data);
    } catch (error) {
      logger.error('Failed to load exchange rates:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Build a lookup map: "USD->CAD" => 1.365
  const rateMap = useMemo(() => {
    const map = new Map<string, number>();
    rates.forEach((r) => {
      map.set(`${r.fromCurrency}->${r.toCurrency}`, Number(r.rate));
    });
    return map;
  }, [rates]);

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
    convert,
    convertToDefault,
    getRate,
    refresh,
    defaultCurrency,
  };
}

/**
 * Build a rate map from an array of ExchangeRate objects.
 * Used for historical rate lookups in the NetWorthReport.
 */
export function buildRateMap(rates: ExchangeRate[]): Map<string, number> {
  const map = new Map<string, number>();
  rates.forEach((r) => {
    map.set(`${r.fromCurrency}->${r.toCurrency}`, Number(r.rate));
  });
  return map;
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
