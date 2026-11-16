/**
 * Folding a series' per-point diagnostics into the ranges a reader can act on.
 *
 * The server says, per point, which securities it could not price, which
 * currency pairs it could not convert and which cash accounts produced no
 * balance. A list of ninety dates is not a repair instruction; "AGGG, Jun 16-20"
 * is. So the causes are folded per key into runs of CONSECUTIVE POINTS -- of the
 * series as given, which is what "contiguous" means for a monthly series as much
 * as a daily one -- and each run keeps the first and last date it covers.
 *
 * Pure and layout-free on purpose: the component renders the names and the
 * dates, this decides what belongs together (#1389).
 */

/** One point of a series, reduced to what the fold reads. */
export interface IncompleteDataPoint {
  /** The point's own date, as the server keys it (YYYY-MM-DD). */
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

export interface IncompleteDataCauses {
  /** Securities with no usable price, by run. */
  prices: IncompleteDataRange[];
  /** Currency pairs with no rate, by run. */
  rates: IncompleteDataRange[];
  /** Cash accounts with no balance, by run. */
  cash: IncompleteDataRange[];
}

/** True when nothing at all was reported missing. */
export function hasIncompleteData(causes: IncompleteDataCauses): boolean {
  return (
    causes.prices.length > 0 ||
    causes.rates.length > 0 ||
    causes.cash.length > 0
  );
}

function foldOne(
  points: IncompleteDataPoint[],
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
      open.set(key, {
        start: point.date,
        end: point.date,
        lastIndex: index,
      });
    }
  });

  for (const [key, run] of open) {
    closed.push({ key, start: run.start, end: run.end });
  }

  // Earliest run first, then by key, so the list reads in the order the reader
  // scanned the chart rather than in map-insertion order.
  return closed.sort(
    (a, b) => a.start.localeCompare(b.start) || a.key.localeCompare(b.key),
  );
}

/**
 * The three causes of an incomplete window, each folded into its runs.
 *
 * `points` is the series in the order it is plotted; a point that reports
 * nothing missing still has to be passed, because it is what separates two runs
 * of the same cause.
 */
export function foldIncompleteData(
  points: IncompleteDataPoint[],
): IncompleteDataCauses {
  return {
    prices: foldOne(points, (p) => p.unpricedSecurityIds),
    rates: foldOne(points, (p) => p.missingRatePairs),
    cash: foldOne(points, (p) => p.unknownCashAccountIds),
  };
}
