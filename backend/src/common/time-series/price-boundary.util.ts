/**
 * The one door between a stored price observation and a value-for-a-date.
 *
 * `docs/time-series-contract.md` section 2.1 is explicit that a named window
 * constant is not enough on its own: turning an observation into "the price on
 * this date" has to go through a shared helper that applies the window, and
 * every site that needs such a value has to use it. This module is that helper.
 * It lives under `common/` rather than beside its first caller because the GEM
 * signal, the GEM chart and the Security Performance comparison all ask the same
 * question, and three copies of a staleness bound is three chances to widen one.
 *
 * `strategies/gem-momentum.util.ts` re-exports these names for the call sites
 * that already imported them from there. That is a second *name*, not a second
 * implementation -- which is the distinction the rule cares about.
 */

/** A price point, as stored: an ISO date and its close. */
export interface PricePoint {
  date: string;
  close: number;
}

/** Whole days between two ISO dates. */
export function daysBetween(from: string, to: string): number {
  return (
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
    86_400_000
  );
}

/**
 * How stale a close may be and still stand for a boundary date.
 *
 * Every boundary that matters -- a momentum window's start, a period's first
 * day, a chart window's opening -- lands on a calendar date the market may well
 * have been shut on, so the close that prices it is a few days earlier. Two
 * weeks covers a weekend plus the longest exchange closures.
 *
 * The limit is the point. Without one, an instrument last quoted in March
 * answers a lookup for September and one for October with the same number: a
 * return of exactly zero, computed from one observation, indistinguishable from
 * a market that went nowhere.
 */
export const BOUNDARY_LAG_DAYS = 14;

/**
 * How far one role's exit close may trail the newest exit close of the other
 * roles in the same evaluation and still count as the same session.
 *
 * `BOUNDARY_LAG_DAYS` answers "is this close recent enough to stand for the
 * boundary at all"; it cannot tell a market shut on the boundary from a feed
 * that stopped twelve days before it. Across roles priced for one decision the
 * question is narrower: did they all close at the boundary's session? A long
 * weekend plus a holiday is four days; a gap wider than that while another
 * role holds the boundary's close is a feed gap, and a ranking that compares
 * one role's 30th with another's 18th compares two different sessions
 * (A26-M27).
 */
export const BOUNDARY_HOLIDAY_DAYS = 4;

/**
 * Days of prices to load *before* a window opens.
 *
 * The same span a boundary close may be old and still count, and necessarily
 * so: a series loaded from exactly the boundary does not contain the close that
 * prices it, because `price_date >= from` excludes it and a lookup can only
 * search backwards. Loading less than the rule accepts would discard prices the
 * rule would have used.
 */
export const PRICE_WINDOW_LEAD_DAYS = BOUNDARY_LAG_DAYS;

/** ISO date `days` before `date`. */
export function withLeadDays(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() - days);
  return shifted.toISOString().slice(0, 10);
}

/** ISO date `days` after `date`. */
export function addDays(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/**
 * The observation standing for `date`: the most recent one at or before it,
 * with the date it was struck on. Prices are expected sorted oldest-first; the
 * lookup is a binary search so a multi-year series can be probed once per
 * period without rescanning.
 *
 * Returns null when the series starts after `date` -- an unknown price, never a
 * substituted zero. **This function applies no age bound**: it is the raw
 * lookup that `closeAt` wraps, and a caller that needs a value for a reported
 * figure wants `closeAt`, not this.
 */
export function pointAsOf(
  prices: PricePoint[],
  date: string,
): PricePoint | null {
  let low = 0;
  let high = prices.length - 1;
  let found: PricePoint | null = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (prices[mid].date <= date) {
      found = prices[mid];
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/** The close `pointAsOf` would return, unbounded. See `closeAt` for the bound. */
export function priceAsOf(prices: PricePoint[], date: string): number | null {
  return pointAsOf(prices, date)?.close ?? null;
}

/**
 * The close standing for `date`, but only when it was struck within
 * `maxLagDays` (default `BOUNDARY_LAG_DAYS`). Null otherwise -- an unknown
 * price, never an old one wearing today's date.
 *
 * `maxLagDays` exists for series sampled weekly or monthly, where one bucket is
 * already longer than the daily bound and refusing on it would call every point
 * unknown. It is a deliberate widening per series, not per call site: pass the
 * sampling's bound once and use it throughout that series.
 */
export function closeAt(
  prices: PricePoint[],
  date: string,
  maxLagDays: number = BOUNDARY_LAG_DAYS,
): number | null {
  return observationAt(prices, date, maxLagDays)?.close ?? null;
}

/**
 * What `closeAt` returns, with the date it was struck on.
 *
 * A caller that has to tell "this boundary and the next resolved to the same
 * row" from "the instrument really did not move" needs the date as well as the
 * number -- `docs/time-series-contract.md` section 2.3. Sharing the
 * implementation with `closeAt` is what keeps that from becoming a second,
 * unbounded lookup.
 */
export function observationAt(
  prices: PricePoint[],
  date: string,
  maxLagDays: number = BOUNDARY_LAG_DAYS,
): PricePoint | null {
  const point = pointAsOf(prices, date);
  if (!point) return null;
  return daysBetween(point.date, date) <= maxLagDays ? point : null;
}
