/**
 * What a security's "daily change" is, decided in one place.
 *
 * Every surface that shows a day-over-day move -- Top Movers, the favourite
 * securities widget -- reads the two most recent rows of `security_prices` and
 * subtracts one from the other. Two stored closes are not a daily move on their
 * own. They are a daily move only while
 *
 *  1. they are **adjacent sessions**: a weekly-priced fund, or a sparsely
 *     priced holding such as a GIC, would otherwise report the same months-long
 *     delta as its "daily" change forever, and
 *  2. the newer of them is the session the **reader** is in: when no price row
 *     lands for a security (its provider skipped the symbol, its exchange was
 *     shut while others traded, that one fetch failed), the two most recent
 *     rows become the previous session's and the one before it, and the widget
 *     serves the previous session's move as today's -- every day, until a new
 *     price arrives.
 *
 * Only (1) used to be checked, and only from the wrong end: the gap between the
 * two stored closes says nothing about how old the newer one is, so two rows a
 * day apart passed it a year later. A pair failing either test is a real move
 * of some other period, and a caller cannot repair it by labelling it more
 * carefully -- there is no daily figure in it to show.
 */

/** A stored close and the session it is for. */
export interface PricePoint {
  price: number;
  /** A `date` column, which reaches a caller as a string or as a `Date`. */
  date: string | Date;
}

/** A day-over-day move, and the session it belongs to. */
export interface DailyPriceChange {
  currentPrice: number;
  previousPrice: number;
  dailyChange: number;
  dailyChangePercent: number;
  /**
   * The calendar day of the newer close. Carried to the surfaces so a figure
   * from Friday shown on a Saturday says which session it is, rather than
   * sitting under a bare "daily change" caption that claims today.
   */
  priceDate: string;
}

/**
 * Gap between the two closes, in days, at or above which their delta is not a
 * daily move. A daily-priced security spans 1-4 days (weekends and holidays);
 * a weekly-priced fund spans exactly 7.
 */
export const DAILY_PRICE_GAP_EXCLUSION_DAYS = 7;

/**
 * Age of the newer close, in days, at or above which it is no longer the
 * current session. Four days is the longest a live feed goes quiet for a
 * reason that is not staleness -- a Thursday close read on the Monday of a
 * Good Friday weekend -- so five is where a feed has stopped rather than
 * paused. A close dated ahead of the reader's own day (an Asian session
 * printing while a North American reader is still on the previous date) is
 * current, not stale.
 */
export const DAILY_PRICE_STALE_AFTER_DAYS = 5;

/**
 * The calendar day of a `date` column, as YYYY-MM-DD. `pg` hands one back as a
 * string or as a local-midnight `Date` depending on the parsers installed, and
 * a day count that silently depended on which would be wrong by a day for
 * readers far enough from UTC.
 */
export function priceDateYmd(value: string | Date): string {
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

/** Whole days from `from` to `to`, both YYYY-MM-DD. NaN if either is unreadable. */
function daysBetween(from: string, to: string): number {
  const parse = (ymd: string): number => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
    if (!match) return Number.NaN;
    return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  };
  const a = parse(from);
  const b = parse(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.NaN;
  return Math.round((b - a) / 86_400_000);
}

/**
 * The daily move a pair of closes describes, or `null` when the pair describes
 * no daily move at all.
 *
 * `points` is newest first, as the `rn <= 2` queries return them. `today` is
 * the reader's own calendar day (`todayYMD()`), which is what decides whether
 * the newer close is the current session.
 */
export function resolveDailyPriceChange(
  points: readonly PricePoint[] | undefined,
  today: string,
): DailyPriceChange | null {
  if (!points || points.length < 2) return null;

  const [current, previous] = points;
  const currentPrice = Number(current.price);
  const previousPrice = Number(previous.price);
  // A percentage off a zero base is not a number anyone can read, and a close
  // that will not parse is not a price.
  if (!Number.isFinite(currentPrice) || !Number.isFinite(previousPrice)) {
    return null;
  }
  if (previousPrice === 0) return null;

  const priceDate = priceDateYmd(current.date);
  const gapDays = daysBetween(priceDateYmd(previous.date), priceDate);
  if (!Number.isFinite(gapDays) || gapDays >= DAILY_PRICE_GAP_EXCLUSION_DAYS) {
    return null;
  }

  const ageDays = daysBetween(priceDate, today);
  if (!Number.isFinite(ageDays) || ageDays >= DAILY_PRICE_STALE_AFTER_DAYS) {
    return null;
  }

  const dailyChange = currentPrice - previousPrice;
  return {
    currentPrice,
    previousPrice,
    dailyChange,
    dailyChangePercent: (dailyChange / previousPrice) * 100,
    priceDate,
  };
}

/**
 * The rows of a movers board that belong to the session the board is showing:
 * the newest session any of them has.
 *
 * `resolveDailyPriceChange` asks whether one security's pair of closes is a
 * daily move at all, and it asks against a fixed age, which cannot separate a
 * market that was shut from a feed that skipped one symbol -- both leave the
 * same day-old close behind, and the shut market is the ordinary case the age
 * rule has to let through, or every board would empty out on a weekend. What
 * separates them is the rest of the portfolio: when the other holdings priced
 * today and this one did not, its last move is an earlier session's, and an
 * earlier session's move is not a mover today. Ranked beside them it takes a
 * place on the board for a day that is over, and keeps it every morning until
 * a new price arrives.
 *
 * So the session is read from the rows rather than from the reader's day: over
 * a weekend nothing has a close for today, every row is Friday's, and the board
 * is Friday's under its own date. A holding whose own market was shut is off
 * the board until it prices again -- it has no figure for the session being
 * ranked. This is a rule about a ranked list of one day's moves, not about a
 * per-security readout: a watchlist prints each security's own dated change.
 *
 * `priceDate` is `YYYY-MM-DD` (`priceDateYmd`), where ordering by string is
 * ordering by day.
 */
export function keepNewestSession<T extends { priceDate: string }>(
  changes: readonly T[],
): T[] {
  let newest: string | null = null;
  for (const change of changes) {
    if (newest === null || change.priceDate > newest) newest = change.priceDate;
  }
  if (newest === null) return [];
  return changes.filter((change) => change.priceDate === newest);
}
