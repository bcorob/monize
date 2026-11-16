/**
 * Ranges whose "Change" is measured from the close of the last trading day
 * *before* the window, rather than from the first point plotted.
 *
 * A 1D chart starts at today's open, a 1W chart at the first bar of the week
 * shown and an MTD chart at the first bar of the month -- so a change measured
 * from the first plotted point silently drops whatever the portfolio did
 * between the previous close and that point. Every other quote source reports
 * these three against the prior close, so this does too.
 *
 * The longer ranges (1M, 3M, YTD, 1Y, ...) keep measuring from their first
 * point: there the window boundary is an arbitrary calendar date rather than a
 * session boundary, and the first point already *is* the close of the day the
 * window opens on.
 */
export const PRIOR_CLOSE_BASELINE_RANGES = new Set(['1d', '1w', 'mtd']);

/**
 * Whether this chart measures its change from the prior trading day's close.
 *
 * A property of the range and nothing else. This was briefly also a user
 * preference (`portfolio_change_baseline`, migrations 152 and 153); it was
 * removed because the answer every quote source gives for a daily move is the
 * prior close, and offering the other one asked the user to adjudicate
 * something with a right answer.
 */
export function usesPriorCloseBaseline(range: string): boolean {
  return PRIOR_CLOSE_BASELINE_RANGES.has(range);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Shift a YYYY-MM-DD date by `days`, in UTC so it cannot drift a day. */
export function shiftIsoDate(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/** The calendar day before a YYYY-MM-DD date. */
export function previousCalendarDay(iso: string): string {
  return shiftIsoDate(iso, -1);
}

/**
 * The session a series' opening point is dated by, or null when the point's
 * own date already names it.
 *
 * A daily series is requested from the day the period is measured from
 * (`usePortfolioRangeWindow`'s `start`), and the series values every calendar
 * day from the latest close on or before it, so a window opening on a Sunday
 * carries Friday's close under Sunday's date. The caption under the chart
 * names the session (`startPriceDate`); a first point labelled with the
 * boundary names a day the market was shut, and the two disagree about where
 * the same series opens. The point is the fact the server stated -- one
 * value, one session -- so it is dated by that session. Only a DAILY point
 * dated on the period's own boundary qualifies, so `firstPointIso` must be
 * that boundary's YYYY-MM-DD exactly: an intraday bar on the same day is a
 * mid-session price, not the close, and the server dates an intraday series'
 * opening close itself; a monthly series' first bucket is a month, not a day.
 */
export function openingSessionDate(
  firstPointIso: string | undefined,
  periodResult: { startDate: string; startPriceDate?: string | null } | null,
): string | null {
  if (!periodResult?.startPriceDate) return null;
  if (periodResult.startPriceDate === periodResult.startDate) return null;
  if (firstPointIso !== periodResult.startDate) return null;
  return periodResult.startPriceDate;
}

/**
 * The series with its opening point relabelled for `session`, or the series
 * itself when there is no session to date it by. One place for the three
 * surfaces that draw a portfolio series, so the rule cannot drift between
 * them.
 */
export function relabelOpeningPoint<T>(
  points: T[],
  session: string | null,
  relabel: (point: T, session: string) => T,
): T[] {
  if (!session || points.length === 0) return points;
  const [first, ...rest] = points;
  return [relabel(first, session), ...rest];
}

/**
 * The date part of a chart point. Daily points already carry a YYYY-MM-DD
 * date; intraday points carry a full ISO timestamp, whose date half is taken
 * as-is (UTC), matching how the MTD range filters its own intraday points.
 * Returns null for anything that is not a date, so a caller treats the
 * baseline as unknown rather than guessing at one.
 */
export function isoDatePart(value: string | undefined): string | null {
  if (!value) return null;
  const date = value.slice(0, 10);
  return ISO_DATE.test(date) ? date : null;
}
