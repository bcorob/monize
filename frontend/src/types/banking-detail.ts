/**
 * Why a projected balance could not be worked out, as a closed set so the copy
 * can be actionable rather than "unavailable" (issue #1247).
 *
 *  - `unresolvedSettlementRate` -- a scheduled investment whose current
 *    settlement exchange rate is unknown. Fixable: refresh rates on the
 *    Currencies page, or check the security's and settlement account's currency.
 *  - `crossCurrencyTransfer` -- a scheduled transfer arriving from an account in
 *    another currency. The amount that lands here is resolved when it posts, so
 *    the projection cannot state it in advance.
 */
export type BalanceForecastGapReason =
  | 'unresolvedSettlementRate'
  | 'crossCurrencyTransfer';

/** One schedule the projection could not price, and why. */
export interface BalanceForecastGap {
  scheduledTransactionId: string;
  name: string;
  reason: BalanceForecastGapReason;
  fromCurrency: string | null;
  toCurrency: string | null;
}

/** A projected balance series from GET /accounts/:id/balance-forecast. */
export interface BalanceForecast {
  accountId: string;
  currencyCode: string;
  /**
   * When `complete` is false this holds only today's anchor: a running balance is
   * cumulative, so one occurrence nobody can price makes every point after it
   * wrong. Do not draw the forward line from it, and do not read its last point
   * as a projection -- that is today's balance wearing a projection's label.
   */
  points: Array<{ date: string; balance: number }>;
  /** False when any occurrence inside the horizon could not be priced. */
  complete: boolean;
  /** The schedules behind an incomplete forecast, so the UI can say which. */
  gaps: BalanceForecastGap[];
}
