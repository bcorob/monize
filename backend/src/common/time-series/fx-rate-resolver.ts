/**
 * The one door between the stored exchange-rate history and "the rate for this
 * date".
 *
 * Four resolvers used to answer this question -- the chart index, the posting
 * ladder, the intraday portfolio index and the investment report -- and they
 * disagreed on every part of it: whether a rate from *after* the valuation date
 * may be used, how old a carried-forward rate may be, whether an inverse
 * observation is consulted when a direct one exists, and whether the answer for
 * a date depends on how wide the surrounding window happened to be. One session
 * could therefore quote four different EUR rates.
 *
 * The rules this module holds, none of which a caller may restate:
 *
 *  - **Never look ahead.** In `historical` mode the answer is the most recent
 *    observation dated on or *before* the date being priced. An observation
 *    struck after that date did not exist when the date happened, so it is not
 *    evidence about it, however close it is.
 *  - **A carried-forward rate has a maximum age** (`FX_MAX_RATE_AGE_DAYS`).
 *    Beyond it the date's rate is unknown, not "the last one we have":
 *    `docs/time-series-contract.md` section 2.2 -- an exchange rate is a price,
 *    and a nine-month-old price does not describe today.
 *  - **The more recent admissible observation wins**, whichever direction it is
 *    stored in; a tie goes to the direct pair. An old direct row must not block
 *    a fresh inverse one, and the choice must not depend on map iteration order.
 *  - **Rate 1 only for equal codes**, and only without a lookup. A missing code
 *    is unknown, never 1 (INV-FX-001).
 *  - **A non-positive stored rate is absent**, not applicable: multiplying by 0
 *    reports a real holding as worthless.
 *  - **An unknown answer names its cause**, so a surface can tell "this pair was
 *    never observed" from "your history has a 285-day hole".
 *
 * `live` mode is the current-rate path: it may take the freshest observation
 * rather than one dated on or before the reference date, under the same age
 * bound. It is still not a licence to use a year-old rate.
 */
import { addDays, daysBetween } from "./price-boundary.util";

/** One stored observation of a pair, as stored (never pre-inverted). */
export interface DatedRate {
  date: string;
  rate: number;
}

/**
 * The observations stored for one direction of a pair, ascending or in any
 * order; the resolver decides which one applies rather than trusting position.
 */
export type FxObservationLookup = (
  from: string,
  to: string,
) => ReadonlyArray<DatedRate> | undefined;

/** Which question is being asked: a historical valuation, or "right now". */
export type FxRateMode = "historical" | "live";

/** Why an answer is unknown; one cause, one repair. */
export type FxRateGapReason =
  /** A currency code was empty, so there is no pair to look up. */
  | "unknown_currency"
  /** The valuation date was not a `YYYY-MM-DD` day, so it prices nothing. */
  | "invalid_date"
  /** Neither direction has ever been observed. */
  | "no_observation"
  /** Every observation is dated after the valuation date (the removed look-ahead). */
  | "only_after_date"
  /** The newest admissible observation is older than the age bound. */
  | "stale_observation";

/** What the resolver found, and how. */
export interface FxRateResolution {
  status: "resolved" | "same_currency" | "unknown";
  /** Multiply an amount in `from` by this to get `to`. `null` when unknown. */
  rate: number | null;
  /** The observation as stored, before any inversion. */
  observedRate: number | null;
  /** The date the chosen observation was struck on. */
  observedOn: string | null;
  direction: "direct" | "inverse" | "identity" | null;
  /** Whole days between the observation and the date it is standing in for. */
  ageDays: number | null;
  reason: FxRateGapReason | null;
}

/**
 * How stale a stored rate may be and still stand for a date.
 *
 * A calendar date is very often one the FX market was shut on: every weekend,
 * plus each side's public holidays, plus the stretches a provider simply did
 * not return. Carrying Friday's rate to Monday is the whole point of a
 * carry-forward, so the bound has to be comfortably longer than a long weekend
 * and the odd provider outage -- and short enough that it still describes the
 * date. Forty-five days is the window `getRateForDate` already fetched history
 * over, so the bound and the fetch agree by construction: anything the bound
 * accepts is inside the span the service tries to fill.
 *
 * The limit is the point. Without one, a pair last observed in September
 * answers a lookup for the following June with September's number, and the
 * resulting total is wrong by the year's currency move with nothing on the page
 * saying so.
 */
export const FX_MAX_RATE_AGE_DAYS = 45;

interface Candidate {
  date: string;
  observedRate: number;
  rate: number;
  direction: "direct" | "inverse";
  ageDays: number;
}

interface Rejections {
  sawAnyObservation: boolean;
  sawAfterDate: boolean;
  sawStale: boolean;
}

/**
 * One direction's observations, prepared once for lookups that do not scan.
 *
 * The scan this replaces was O(rows) per lookup, and every row cost two
 * `Date.parse` calls. A since-inception portfolio walk asks for a rate on each
 * of ~9,700 days against an index holding ~9,700 rows per direction, so the
 * pair alone cost 66 seconds of blocked event loop before a single holding was
 * multiplied by anything (issue #1409). The policy above is unchanged: what
 * changes is that the admissible observation is found by binary search instead
 * of by reading every row.
 *
 * `dates` is ascending, ties in source order, so the tie rule ("equal dates in
 * one direction are the same day's observation and the first is kept") is
 * position 0 of the run rather than a scan's first sighting. Only rows the scan
 * would have considered at all are kept -- a non-finite, zero or negative rate
 * is absent, and so is an empty date -- so `dates.length > 0` is exactly the
 * scan's `sawAnyObservation`.
 *
 * Keyed by the array the caller handed over, in a `WeakMap`: the rate index a
 * series builds lives for one request and its arrays are never mutated, so the
 * preparation is a per-array memo with no lifetime of its own. `sourceLength`
 * re-prepares an array that grew or shrank since.
 */
interface PreparedObservations {
  readonly sourceLength: number;
  readonly dates: string[];
  readonly rates: number[];
}

const preparedObservations = new WeakMap<object, PreparedObservations>();

function prepareObservations(
  rows: ReadonlyArray<DatedRate>,
): PreparedObservations {
  const cached = preparedObservations.get(rows);
  if (cached && cached.sourceLength === rows.length) return cached;

  const kept: Array<{ date: string; rate: number; at: number }> = [];
  rows.forEach((row, at) => {
    const rate = Number(row.rate);
    // Zero and negative are absent, not applicable -- the same reading
    // `convertWithRateLookup` gives them.
    if (!Number.isFinite(rate) || rate <= 0) return;
    const date = row.date?.slice(0, 10);
    if (!date) return;
    kept.push({ date, rate, at });
  });
  kept.sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.at - b.at,
  );

  const prepared: PreparedObservations = {
    sourceLength: rows.length,
    dates: kept.map((k) => k.date),
    rates: kept.map((k) => k.rate),
  };
  preparedObservations.set(rows, prepared);
  return prepared;
}

/** The last index whose date is on or before `date`, or -1. */
function lastIndexAtOrBefore(dates: string[], date: string): number {
  let low = 0;
  let high = dates.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (dates[mid] <= date) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/** The newest admissible observation in one stored direction, or null. */
function bestInDirection(
  rows: ReadonlyArray<DatedRate> | undefined,
  direction: "direct" | "inverse",
  onDate: string,
  mode: FxRateMode,
  maxAgeDays: number,
  seen: Rejections,
): Candidate | null {
  if (!rows || rows.length === 0) return null;

  const { dates, rates } = prepareObservations(rows);
  if (dates.length === 0) return null;
  seen.sawAnyObservation = true;

  // The age bound as calendar dates, computed once per direction rather than
  // as a `daysBetween` per row: `[oldest, newest]` is the window the scan
  // accepted, and a string comparison decides membership exactly as the
  // arithmetic did. `live` may take an observation from after the reference,
  // inside the same bound; `historical` may not take one at all.
  const oldest = shiftYMD(onDate, -maxAgeDays, "min");
  const newest = mode === "live" ? shiftYMD(onDate, maxAgeDays, "max") : onDate;

  // Why an unknown answer is unknown, from the ends of the sorted series: a
  // look-ahead rejection can only be the newest observation's problem, and a
  // staleness rejection only the oldest's.
  if (mode === "historical") {
    if (dates[dates.length - 1] > onDate) seen.sawAfterDate = true;
  } else if (dates[dates.length - 1] > newest) {
    seen.sawStale = true;
  }
  if (dates[0] < oldest) seen.sawStale = true;

  const at = lastIndexAtOrBefore(dates, newest);
  if (at < 0) return null;
  if (dates[at] < oldest) return null;

  // The first row of the chosen date's run, which is the row the scan kept:
  // equal dates in one direction are the same day's observation.
  let first = at;
  while (first > 0 && dates[first - 1] === dates[at]) first--;

  const date = dates[first];
  const observedRate = rates[first];
  return {
    date,
    observedRate,
    rate: direction === "direct" ? observedRate : 1 / observedRate,
    direction,
    ageDays: daysBetween(date, onDate),
  };
}

/**
 * `date` shifted by whole days, as a calendar date.
 *
 * A non-finite `maxAgeDays` is a caller asking for no age bound at all, and
 * there is no date to shift to: `unbounded` says which end of the calendar the
 * window opens onto, so that end admits every observation rather than becoming
 * `Invalid Date` and rejecting all of them.
 */
function shiftYMD(
  date: string,
  days: number,
  unbounded: "min" | "max",
): string {
  if (!Number.isFinite(days)) {
    return unbounded === "min" ? "0000-01-01" : "9999-12-31";
  }
  return addDays(date, days);
}

const UNKNOWN_SHAPE = {
  status: "unknown",
  rate: null,
  observedRate: null,
  observedOn: null,
  direction: null,
  ageDays: null,
} as const;

/**
 * The day a lookup prices, as `YYYY-MM-DD`, or `null` when the caller named no
 * day.
 *
 * A date in the future has no rate and will not until it arrives; today's is
 * the best available estimate, and it is what every "as of" surface shows. In
 * `live` mode the reference is today outright.
 *
 * `onDate` is declared `string`, and on the request path it is a query
 * parameter: Express parses a repeated key (`?date=x&date=y`) into an array, so
 * the declared type is a claim about the caller rather than a fact about the
 * value. Unchecked, `slice` on an array returns an array and every comparison
 * downstream silently compares coerced text -- CodeQL
 * `js/type-confusion-through-parameter-tampering`. A value that does not name a
 * day is refused here rather than coerced into one; the comparisons below are
 * lexicographic over `YYYY-MM-DD` and mean nothing for any other shape.
 */
export function fxReferenceDate(
  onDate: string,
  today: string,
  mode: FxRateMode,
): string | null {
  if (typeof onDate !== "string") return null;
  const requested = onDate.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requested)) return null;
  return mode === "live" ? today : requested > today ? today : requested;
}

/**
 * The rate that converts one unit of `from` into `to` on `onDate`.
 *
 * `lookup` is handed the pair in a stored direction and returns that
 * direction's observations; the resolver asks for both directions and picks
 * between them, so no caller repeats the direct/inverse decision.
 */
export function resolveFxRate(
  from: string,
  to: string,
  onDate: string,
  lookup: FxObservationLookup,
  options?: {
    mode?: FxRateMode;
    maxAgeDays?: number;
    /** Today, for clamping a future valuation date. Defaults to the UTC date. */
    today?: string;
  },
): FxRateResolution {
  const mode = options?.mode ?? "historical";
  const maxAgeDays = options?.maxAgeDays ?? FX_MAX_RATE_AGE_DAYS;

  // An empty code is not a pair. Returning 1 for it is the INV-FX-001 defect
  // wearing a different hat: a column headed in the base currency carrying a
  // foreign number.
  if (!from || !to) {
    return { ...UNKNOWN_SHAPE, reason: "unknown_currency" };
  }
  // The only branch that may produce 1, and it never consults the history.
  if (from === to) {
    return {
      status: "same_currency",
      rate: 1,
      observedRate: 1,
      observedOn: null,
      direction: "identity",
      ageDays: 0,
      reason: null,
    };
  }

  const today = options?.today ?? new Date().toISOString().slice(0, 10);
  const reference = fxReferenceDate(onDate, today, mode);
  if (reference === null) {
    return { ...UNKNOWN_SHAPE, reason: "invalid_date" };
  }

  const seen: Rejections = {
    sawAnyObservation: false,
    sawAfterDate: false,
    sawStale: false,
  };
  const direct = bestInDirection(
    lookup(from, to),
    "direct",
    reference,
    mode,
    maxAgeDays,
    seen,
  );
  const inverse = bestInDirection(
    lookup(to, from),
    "inverse",
    reference,
    mode,
    maxAgeDays,
    seen,
  );

  // The more recent admissible observation wins whichever way it is stored; a
  // tie goes to the direct pair, so the answer is the same on every run.
  const chosen =
    direct === null
      ? inverse
      : inverse === null
        ? direct
        : inverse.date > direct.date
          ? inverse
          : direct;

  if (chosen === null) {
    const reason: FxRateGapReason = seen.sawStale
      ? "stale_observation"
      : seen.sawAfterDate
        ? "only_after_date"
        : "no_observation";
    return { ...UNKNOWN_SHAPE, reason };
  }

  return {
    status: "resolved",
    rate: chosen.rate,
    observedRate: chosen.observedRate,
    observedOn: chosen.date,
    direction: chosen.direction,
    ageDays: chosen.ageDays,
    reason: null,
  };
}

/** One line a log or a payload can carry to explain a withheld figure. */
export function describeFxGap(
  pair: string,
  onDate: string,
  reason: FxRateGapReason,
  maxAgeDays: number = FX_MAX_RATE_AGE_DAYS,
): string {
  switch (reason) {
    case "unknown_currency":
      return `No currency pair to resolve for ${pair}; the affected figure is reported as unknown rather than converted 1:1`;
    case "invalid_date":
      return `No calendar date to resolve ${pair} on; the affected figure is reported as unknown rather than priced on a guessed day`;
    case "only_after_date":
      return `Every stored ${pair} rate is dated after ${onDate}; the affected figure is reported as unknown rather than valued at a rate from its future`;
    case "stale_observation":
      return `The newest stored ${pair} rate on or before ${onDate} is more than ${maxAgeDays} days old; the affected figure is reported as unknown rather than carried forward`;
    case "no_observation":
    default:
      return `No exchange rate available for ${pair} on or before ${onDate}; the affected figure is reported as unknown rather than converted 1:1`;
  }
}
