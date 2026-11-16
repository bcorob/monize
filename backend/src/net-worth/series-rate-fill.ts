/**
 * Filling a series' own exchange-rate gaps from the provider, on the read path.
 *
 * The daily refresh writes today only, and `backfillHistoricalRates` skips a
 * pair the moment it holds any row at all, so a user who added a EUR holding in
 * June has no EUR->PLN observation for January through June and every point of
 * "Portfolio value over time" in that span reports the pair as missing. The
 * rates exist at the provider; nobody ever asked for them. This module is what
 * asks, on behalf of a series that has just discovered it cannot answer.
 *
 * Two rules shape it, and both are the reason it is a planner rather than a
 * loop over dates:
 *
 * - **A fetch unit is a calendar month, not a day.** One
 *   `ExchangeRateService.ensureRatesForDate` call fetches the whole calendar
 *   month around the date it is given, for the pair in either direction, so a
 *   400-point daily chart needs at most one call per (month, pair), not four
 *   hundred. Any date inside the month selects the same window; the planner
 *   picks the earliest one it saw so the unit is deterministic.
 * - **A fetch is bounded.** `MAX_FILL_MONTHS` months per request, newest first:
 *   a chart asked for "all time" over a twenty-year history must not turn one
 *   GET into two hundred provider calls. What the cap leaves out stays missing,
 *   and the report names it the same way it named everything else it could not
 *   convert -- the point of this module is to answer more questions, never to
 *   invent an answer (INV-FX-001, `docs/time-series-contract.md` section 2.2).
 *
 * The caller re-reads the rate index from the database afterwards rather than
 * patching what it holds in memory, so what the series converts with is exactly
 * what a second request would find: one source of truth, not two that agree
 * today. `accounts/account-balances-report.service.ts` `ratesForReport` is the
 * same shape for a point-in-time report.
 */

/**
 * Months fetched at most in one fill. Two years covers the window a person
 * actually reads a portfolio chart over; a wider request fills the newest two
 * years and reports the rest as still missing rather than opening an unbounded
 * number of provider calls inside one HTTP request.
 */
export const MAX_FILL_MONTHS = 24;

/** The per-point diagnostics every series in this layer already produces. */
export interface SeriesRateGap {
  /** The point's date, `YYYY-MM-DD` (a monthly point's month-first date). */
  readonly date: string;
  /** `"EUR->PLN"` for each pair this point could not convert. */
  readonly missingRatePairs: readonly string[];
}

/** One provider call: the pairs to fetch, and a date inside the month wanted. */
export interface RateFillUnit {
  /** `YYYY-MM`, the calendar month `ensureRatesForDate` will fetch. */
  readonly month: string;
  /** A date inside `month`; any one selects the same window. */
  readonly date: string;
  /** Distinct pairs, direction-deduplicated, sorted for a stable plan. */
  readonly pairs: ReadonlyArray<{ from: string; to: string }>;
}

/** Opt-out for a caller that must not reach the network (a cron, an LLM tool). */
export interface SeriesFetchOptions {
  /**
   * `false` keeps the read inside the database: the series reports whatever the
   * stored history can answer and nothing is fetched. Absent means fill.
   */
  fetchMissing?: boolean;
}

/** What the fill needs of `ExchangeRateService`, and nothing more. */
export interface SeriesRateFiller {
  ensureRatesForDate(
    pairs: ReadonlyArray<{ from: string; to: string }>,
    date: string,
  ): Promise<number>;
}

/** Only `warn` and `log` are used; the NestJS `Logger` satisfies it. */
export interface SeriesRateFillLogger {
  warn(message: string): void;
  log(message: string): void;
}

/**
 * A pair key that does not distinguish direction, because neither the fetch nor
 * the storage does: one provider call answers USD->CAD and CAD->USD alike and
 * the pair is stored once, so the two are one unit of work.
 */
function directionlessPairKey(from: string, to: string): string {
  return [from, to].sort().join("|");
}

/** `"EUR->PLN"` -> `{ from: "EUR", to: "PLN" }`; `null` for anything else. */
function parsePair(pair: string): { from: string; to: string } | null {
  const parts = pair.split("->");
  if (parts.length !== 2) return null;
  const from = parts[0].trim().toUpperCase();
  const to = parts[1].trim().toUpperCase();
  // A same-currency "pair" has no rate to fetch, and an empty side is not a
  // currency: either would spend a provider call on a question with no answer.
  if (!from || !to || from === to) return null;
  return { from, to };
}

/**
 * The minimal set of provider calls that could answer a series' gaps.
 *
 * Deduplicated by (month, directionless pair), capped at `maxMonths` keeping
 * the newest months, and returned oldest-first so a partially successful fill
 * leaves a contiguous recent span rather than a scatter.
 */
export function planSeriesRateFill(
  points: ReadonlyArray<SeriesRateGap>,
  maxMonths: number = MAX_FILL_MONTHS,
): RateFillUnit[] {
  const byMonth = new Map<
    string,
    { date: string; pairs: Map<string, { from: string; to: string }> }
  >();

  for (const point of points) {
    if (!point?.missingRatePairs?.length) continue;
    if (!/^\d{4}-\d{2}-\d{2}/.test(point.date ?? "")) continue;
    const month = point.date.slice(0, 7);

    let entry = byMonth.get(month);
    if (!entry) {
      entry = { date: point.date.slice(0, 10), pairs: new Map() };
      byMonth.set(month, entry);
    } else if (point.date.slice(0, 10) < entry.date) {
      // Deterministic regardless of the order the points arrive in.
      entry = { date: point.date.slice(0, 10), pairs: entry.pairs };
      byMonth.set(month, entry);
    }

    for (const raw of point.missingRatePairs) {
      const pair = parsePair(raw);
      if (!pair) continue;
      const key = directionlessPairKey(pair.from, pair.to);
      if (!entry.pairs.has(key)) entry.pairs.set(key, pair);
    }
  }

  const months = [...byMonth.entries()]
    .filter(([, entry]) => entry.pairs.size > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  // The newest months are the ones a reader is looking at; a range wider than
  // the cap fills those and leaves the older tail reported as still missing.
  const bounded = maxMonths > 0 ? months.slice(-maxMonths) : [];

  return bounded.map(([month, entry]) => ({
    month,
    date: entry.date,
    pairs: [...entry.pairs.values()].sort((a, b) =>
      `${a.from}->${a.to}`.localeCompare(`${b.from}->${b.to}`),
    ),
  }));
}

/**
 * Ask the provider for what the series could not answer, and report how many
 * observations were persisted.
 *
 * Best-effort by construction: this runs on a read path, so a provider failure
 * is logged and the series renders with the pair still missing rather than the
 * request failing. Returns 0 when there is nothing to do, when the caller opted
 * out, or when nothing was stored -- the caller re-reads the rate index only
 * for a non-zero count.
 *
 * Sequential, one unit at a time: `ensureRatesForDate` already fans its own
 * pairs out with the service's bounded concurrency, and a year of months fired
 * at once would burst the provider from inside a single HTTP request.
 */
export async function fillSeriesRates(
  filler: SeriesRateFiller | undefined,
  points: ReadonlyArray<SeriesRateGap>,
  options: SeriesFetchOptions | undefined,
  logger: SeriesRateFillLogger,
): Promise<number> {
  if (options?.fetchMissing === false) return 0;
  if (!filler) return 0;

  const units = planSeriesRateFill(points);
  if (units.length === 0) return 0;

  logger.log(
    `Series read is short of exchange rates; fetching ${units.length} month(s): ` +
      units
        .map(
          (u) =>
            `${u.month} (${u.pairs.map((p) => `${p.from}/${p.to}`).join(", ")})`,
        )
        .join("; "),
  );

  let stored = 0;
  for (const unit of units) {
    try {
      stored += await filler.ensureRatesForDate(unit.pairs, unit.date);
    } catch (error) {
      logger.warn(
        `Historical rate fill for ${unit.month} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return stored;
}

/**
 * A series, computed once from what the database holds, and -- when that was
 * not enough -- computed again from what the provider could add.
 *
 * Three properties this shape exists to keep:
 *
 * - **Demand-driven.** The plan comes from the points that actually failed to
 *     convert, so a currency whose accounts held zero over the window costs no
 *     provider call.
 * - **Re-read, never patched.** `compute` reloads the rate index from the
 *     database on its second run, so the series converts with what was just
 *     persisted rather than with an in-memory patch of the first read.
 * - **Best-effort.** A provider failure leaves the series exactly as the first
 *     computation produced it; the request never fails because of the fill.
 *
 * It runs outside any transaction: the callers' reads open and close one per
 * statement, so no provider call is made with a transaction held open.
 */
export async function computeWithRateFill<R>(
  filler: SeriesRateFiller | undefined,
  compute: () => Promise<R>,
  gapsOf: (result: R) => ReadonlyArray<SeriesRateGap>,
  options: SeriesFetchOptions | undefined,
  logger: SeriesRateFillLogger,
): Promise<R> {
  const result = await compute();
  const stored = await fillSeriesRates(filler, gapsOf(result), options, logger);
  if (stored === 0) return result;
  return compute();
}
