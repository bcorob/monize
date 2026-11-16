/**
 * The period's external cash flow, folded into the reporting currency.
 *
 * Each day-currency subtotal is converted at the rate that stood on ITS OWN day
 * -- a deposit made in January is January's money, not today's -- through the
 * one date-aware resolver (`resolveFxRate`, reached here via the bulk
 * `RateIndex` so a year of flows costs one query rather than one per day).
 * `FxAggregate` is what keeps "could not convert" distinguishable from
 * "converted to zero": a subtotal it could not convert makes the whole flow
 * incomplete, which withholds the result rather than shrinking it
 * (INV-PORTRESULT-003L).
 *
 * The index is built separately from the fold so the batch route can build ONE
 * index for its widest window and fold each preset's slice against it. The
 * index holds enough rows that a date resolves the same whatever window was
 * asked for (`rate-index.util.ts`), so a preset's figures do not depend on how
 * much history was loaded beside them.
 */
import { FxAggregate } from "../common/fx-aggregate";
import {
  RateIndex,
  RateIndexLogger,
  RateIndexQuery,
  buildRateIndex,
  convertAtDate,
} from "../common/time-series/rate-index.util";
import { PeriodFlow } from "./portfolio-period-result.util";
import { SeriesRateGap } from "./series-rate-fill";

/** One per-day, per-currency flow subtotal, as its loader returns it. */
export interface FlowSubtotalRow {
  date: string | null;
  currency: string;
  amount: number;
}

/** Every rate any of these rows could need, in one query. */
export async function buildFlowRateIndex(
  query: RateIndexQuery,
  // Only the currency is read, so the invested part's capital and income rows
  // build the SAME index as the external-flow ones: one window, one set of
  // rates, and no day that resolves differently depending on which fold asked.
  rows: ReadonlyArray<{ currency: string }>,
  currency: string,
  start: string,
  end: string,
): Promise<RateIndex> {
  const currencies = new Set<string>();
  for (const row of rows) {
    if (row.currency !== currency) currencies.add(row.currency);
  }
  return buildRateIndex(query, currencies, currency, start, end);
}

/**
 * A folded flow plus the per-day gaps behind `missingPairs`. The gaps are what
 * the read-path fill (`series-rate-fill.ts`) plans a provider fetch from: a
 * fill is planned per calendar month, so "January could not convert EUR" is
 * what makes the January window the one that gets fetched. They are not part
 * of the period's answer.
 */
export interface FoldedFlow extends PeriodFlow {
  gaps: SeriesRateGap[];
}

/** The net flow in `currency`, or the subtotal that did convert with its gaps. */
export function foldFlowSubtotals(
  rows: readonly FlowSubtotalRow[],
  currency: string,
  rateIndex: RateIndex,
  logger: RateIndexLogger,
): FoldedFlow {
  const aggregate = new FxAggregate();
  const gaps: SeriesRateGap[] = [];
  for (const row of rows) {
    if (row.amount === 0) continue;
    if (row.currency === currency) {
      aggregate.addConverted(row.amount);
      continue;
    }
    // A row with no date cannot be priced at its own date; this loader is
    // asked for per-day subtotals, so that is a shape it does not return.
    if (!row.date) {
      aggregate.addUnknown();
      continue;
    }
    const converted = convertAtDate(
      row.amount,
      row.currency,
      currency,
      row.date,
      rateIndex,
      logger,
    );
    if (converted === null) {
      gaps.push({
        date: row.date,
        missingRatePairs: [`${row.currency}->${currency}`],
      });
    }
    aggregate.add(converted, row.currency, currency);
  }

  return {
    complete: aggregate.isComplete,
    value: aggregate.knownSubtotal,
    missingPairs: aggregate.missingPairs,
    gaps,
  };
}
