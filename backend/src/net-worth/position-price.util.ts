import { pointAsOf, PricePoint } from "../common/time-series/price-boundary.util";

export { PricePoint } from "../common/time-series/price-boundary.util";

/**
 * The raw close valuing a held position on `date`, from the accepted price
 * store, with a legacy transaction-derived fallback.
 *
 * **`skipPriceUpdates` does not appear here, and must not.** That flag governs
 * whether Monize fetches external provider prices for a security; it says
 * nothing about which stored observations are eligible to value a position.
 * Valuing a skip-flagged security from its transaction prices while ignoring a
 * manually entered `security_prices` row is issue #1242: a 401(k) whose latest
 * accepted close was $120 kept reporting $61 on every historical chart.
 *
 * `stored` is the accepted price store (`security_prices.close_price`): provider
 * quotes, imports, manual corrections, and transaction-derived observations all
 * land there, one row per `(security_id, price_date)` with source precedence
 * (manual/provider over transaction-derived) already applied at write time
 * (`SecurityPriceService`). So whenever `stored` can answer for `date` it is
 * authoritative, and same-day precedence is whatever `security_prices` recorded
 * -- there is deliberately no second precedence rule reimplemented here.
 *
 * `txFallback` is a legacy compatibility source: transaction-derived prices read
 * directly from `investment_transactions` (same-day trades averaged, as
 * `upsertTransactionPrice` writes them). Every accepted transaction observation
 * is normally mirrored into `security_prices` (`upsertTransactionPrice` on every
 * investment-transaction mutation, `backfillTransactionPrices` on import), so it
 * only carries anything for data that predates that mirroring and was never
 * rewritten -- chiefly a backup taken before transaction-derived
 * `security_prices` existed and restored without a price backfill.
 *
 * The two are **merged chronologically**, not switched per security: the newest
 * observation at or before `date` from either source wins, and on an equal date
 * the accepted store wins (its source precedence was resolved at write time).
 * Switching per security -- "use tx only if the store is empty" -- was wrong: a
 * security with a single *future* stored observation (a manual price added after
 * a legacy restore) would suppress the legacy transaction history it needs to
 * value earlier dates, and report those positions as $0 (review MZ-1242-R1).
 *
 * Neither source is read past `date`: `pointAsOf` returns the most recent
 * observation at or before it, so a future close never values an earlier day.
 * Both series must be sorted oldest-first (as loaded `ORDER BY ... price_date`).
 *
 * Uses raw `close_price`, never `adjusted_close`: adjusted prices belong to
 * return-series calculations, not point-in-time position market value.
 */
export function positionCloseAsOf(
  stored: PricePoint[] | undefined,
  txFallback: PricePoint[] | undefined,
  date: string,
): number | null {
  const storedPoint =
    stored && stored.length > 0 ? pointAsOf(stored, date) : null;
  const txPoint =
    txFallback && txFallback.length > 0 ? pointAsOf(txFallback, date) : null;

  if (!storedPoint) return txPoint?.close ?? null;
  if (!txPoint) return storedPoint.close;

  // Equal date: the accepted store owns same-day precedence. Otherwise the
  // more recent observation stands for the date.
  if (storedPoint.date >= txPoint.date) return storedPoint.close;
  return txPoint.close;
}
