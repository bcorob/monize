/**
 * Folding a series' per-point diagnostics into the ranges a reader can act on.
 *
 * The valuation says, per point, which securities it could not price, which
 * currency pairs it could not convert and which cash accounts produced no
 * balance. A list of ninety dates is not a repair instruction; "AGGG, Jun 16-20"
 * is. So the causes are folded per key into runs of CONSECUTIVE POINTS -- of the
 * series as given, which is what "contiguous" means for a monthly series as much
 * as a daily one -- and each run keeps the first and last date it covers.
 *
 * The client already folds this way for the chart and the report
 * (`frontend/src/lib/incomplete-data-ranges.ts`); the portfolio summary has no
 * points on the client, so the same fold runs here, once, over the series the
 * period result was decided from (#1392). Two implementations of one fold would
 * be two answers to "which days are missing", so the cases in
 * `incomplete-data-ranges.util.spec.ts` are the client's own, ported.
 *
 * Pure and layout-free on purpose: the caller resolves the names, this decides
 * what belongs together.
 */

/** One point of a series, reduced to what the fold reads. */
export interface IncompleteDataPoint {
  /** The point's own date (YYYY-MM-DD). */
  date: string;
  /** Securities held at this point that nothing could price. */
  unpricedSecurityIds?: string[];
  /** `"USD->PLN"` for each pair this point could not convert. */
  missingRatePairs?: string[];
  /** Cash accounts in scope that produced no balance for this point. */
  unknownCashAccountIds?: string[];
}

/** One cause, over the run of points it affected. */
export interface IncompleteDataRange {
  /** A security id, a `"USD->PLN"` pair, or an account id. */
  key: string;
  /** First date of the run. */
  start: string;
  /** Last date of the run; equal to `start` for a single point. */
  end: string;
}

/**
 * The three causes of an incomplete window, each folded into its runs, with a
 * flag per cause saying whether older runs were dropped to keep the payload
 * bounded.
 */
export interface IncompleteDataRanges {
  /** Securities with no usable price, by run. */
  prices: IncompleteDataRange[];
  /** Currency pairs with no rate, by run. */
  rates: IncompleteDataRange[];
  /** Cash accounts with no balance, by run. */
  cash: IncompleteDataRange[];
  /** Per cause: true when runs older than the ones listed were dropped. */
  truncated: { prices: boolean; rates: boolean; cash: boolean };
}

/**
 * How many runs one cause may carry.
 *
 * A years-long gap across fifty securities is thousands of runs, and every
 * period response would carry them. The newest are kept because they are the
 * ones a reader can still act on, and `truncated` says the list is a tail rather
 * than the whole of it -- a silently shortened list would be the same dead end
 * as no list at all.
 */
export const MAX_INCOMPLETE_RANGES_PER_CAUSE = 50;

/** The answer for a window with nothing missing, or none to fold. */
export const EMPTY_INCOMPLETE_RANGES: IncompleteDataRanges = {
  prices: [],
  rates: [],
  cash: [],
  truncated: { prices: false, rates: false, cash: false },
};

function foldOne(
  points: readonly IncompleteDataPoint[],
  read: (point: IncompleteDataPoint) => string[] | undefined,
): IncompleteDataRange[] {
  // Per key: the run being extended, and the index of the point that last
  // extended it. A gap of one point closes the run, which is the whole point --
  // two separate outages are two repairs.
  const open = new Map<
    string,
    { start: string; end: string; lastIndex: number }
  >();
  const closed: IncompleteDataRange[] = [];

  points.forEach((point, index) => {
    for (const key of read(point) ?? []) {
      const run = open.get(key);
      if (run && run.lastIndex === index - 1) {
        open.set(key, { start: run.start, end: point.date, lastIndex: index });
        continue;
      }
      if (run) closed.push({ key, start: run.start, end: run.end });
      open.set(key, { start: point.date, end: point.date, lastIndex: index });
    }
  });

  for (const [key, run] of open) {
    closed.push({ key, start: run.start, end: run.end });
  }

  // Earliest run first, then by key, so the list reads in the order the reader
  // scanned the series rather than in map-insertion order.
  return closed.sort(
    (a, b) => a.start.localeCompare(b.start) || a.key.localeCompare(b.key),
  );
}

/** The newest `limit` runs, still in ascending order, and whether any were cut. */
function bounded(
  ranges: IncompleteDataRange[],
  limit: number,
): { ranges: IncompleteDataRange[]; truncated: boolean } {
  if (ranges.length <= limit) return { ranges, truncated: false };
  return { ranges: ranges.slice(ranges.length - limit), truncated: true };
}

/**
 * The three causes of an incomplete window, each folded into its runs.
 *
 * `points` is the series in the order it was valued; a point that reports
 * nothing missing still has to be passed, because it is what separates two runs
 * of the same cause.
 */
export function foldIncompleteData(
  points: readonly IncompleteDataPoint[],
  limit: number = MAX_INCOMPLETE_RANGES_PER_CAUSE,
): IncompleteDataRanges {
  const prices = bounded(
    foldOne(points, (p) => p.unpricedSecurityIds),
    limit,
  );
  const rates = bounded(
    foldOne(points, (p) => p.missingRatePairs),
    limit,
  );
  const cash = bounded(
    foldOne(points, (p) => p.unknownCashAccountIds),
    limit,
  );
  return {
    prices: prices.ranges,
    rates: rates.ranges,
    cash: cash.ranges,
    truncated: {
      prices: prices.truncated,
      rates: rates.truncated,
      cash: cash.truncated,
    },
  };
}

/**
 * The same points, with the securities a DAY'S FLOW could not be valued at
 * folded into each point's own unpriced list.
 *
 * A share-moving leg is valued at the day's accepted close, so a leg nothing
 * priced is a missing price exactly as a held position's is -- and it is the
 * same repair, on the same screen. Merging it here rather than teaching
 * `foldIncompleteData` about flows keeps one fold over one shape: the ranges a
 * reader is shown, and the reasons the figures were withheld for, cannot then
 * name different securities.
 *
 * Returns the points unchanged, by identity, when no day has one -- which is
 * every window with no external share transfer in it.
 */
export function withFlowUnpricedSecurities<T extends IncompleteDataPoint>(
  points: readonly T[],
  flowsByDay: ReadonlyMap<string, { unpricedSecurityIds?: string[] }>,
): readonly IncompleteDataPoint[] {
  let touched = false;
  const merged = points.map((point) => {
    const extra = flowsByDay.get(point.date)?.unpricedSecurityIds ?? [];
    if (extra.length === 0) return point;
    touched = true;
    return {
      ...point,
      unpricedSecurityIds: [
        ...new Set([...(point.unpricedSecurityIds ?? []), ...extra]),
      ].sort(),
    };
  });
  return touched ? merged : points;
}

/** True when nothing at all was reported missing. */
export function hasIncompleteData(ranges: IncompleteDataRanges): boolean {
  return (
    ranges.prices.length > 0 ||
    ranges.rates.length > 0 ||
    ranges.cash.length > 0
  );
}
