/**
 * Converting the Account Balances report's figures into one currency, at the
 * rates that stood on the date the figures were measured (issue #1198).
 *
 * The rates arrive in the same payload as the balances, because they belong to
 * the same instant. Converting a 2019 balance with a live rate map answers a
 * different question from the one the report asked -- and nothing on screen
 * would say which of the two the number is. `useExchangeRates` stays the right
 * tool for a surface reporting *now*; this is the tool for a surface reporting
 * a date the user chose.
 */

/**
 * Convert `amount` from `fromCurrency` into the report's display currency, or
 * `null` when no rate for that pair stood on the report's date.
 *
 * `null` is the whole contract, exactly as it is for `useExchangeRates.convert`:
 * a caller must render it as unknown or exclude it from a total and say so
 * (`sumConverted` / `PartialTotal`), never fall back to the unconverted amount.
 */
export type AsOfConverter = (
  amount: number,
  fromCurrency: string,
) => number | null;

/**
 * Build the converter from the server's as-of rate table.
 *
 * `displayRates` maps a currency to its multiplier into `displayCurrency`; the
 * server omits any currency it could not resolve a rate for on that date, so an
 * absent entry means unknown. A rate that is present but not a usable positive
 * number is treated the same way -- zero would report a real balance as
 * worthless, and the sign of a negative one is nobody's rate.
 */
export function asOfConverter(
  displayCurrency: string,
  displayRates: Record<string, number>,
): AsOfConverter {
  return (amount, fromCurrency) => {
    // Same currency is 1:1 by definition -- a known rate, not a fallback, and
    // it must stay distinguishable from the missing case.
    if (fromCurrency === displayCurrency) return amount;

    const rate = displayRates[fromCurrency];
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
      return null;
    }
    return amount * rate;
  };
}
