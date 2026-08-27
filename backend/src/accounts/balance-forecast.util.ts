/**
 * Why an occurrence's amount could not be worked out, as a closed set so the
 * client can render actionable copy instead of parsing prose (issue #1247).
 *
 *  - `unresolvedSettlementRate` -- an investment-carrying schedule whose current
 *    settlement exchange rate is unknown, so what it will post is unknown.
 *  - `crossCurrencyTransfer` -- the schedule's amount is in the SOURCE account's
 *    currency and this projection is for the destination, whose currency differs.
 *    The arriving amount is resolved at posting time and no rate is applied here,
 *    so adding the source figure would be a foreign number on this balance.
 */
export type BalanceForecastGapReason =
  | "unresolvedSettlementRate"
  | "crossCurrencyTransfer";

/** One schedule the projection could not price, and why. */
export interface BalanceForecastGap {
  scheduledTransactionId: string;
  name: string;
  reason: BalanceForecastGapReason;
  /** The pair behind the gap, when there is one to name. */
  fromCurrency: string | null;
  toCurrency: string | null;
}

/**
 * One occurrence, as the projection consumes it.
 *
 * Expansion, override selection and pricing have all already happened -- they
 * belong to `ScheduledOccurrenceService`, the one place they happen (issue
 * #1247). What is left here is arithmetic: which side of a transfer this account
 * is on, and what the running balance does.
 */
export interface ForecastOccurrenceInput {
  scheduledTransactionId: string;
  name: string;
  /**
   * The account this occurrence's cash moves through -- for an investment
   * schedule the *settlement* account, not the brokerage. The caller resolves
   * it; this module only compares it against the account being charted.
   */
  accountId: string;
  transferAccountId: string | null;
  /** The date the occurrence falls on (an override's date when one moved it). */
  dueDate: string;
  /**
   * What this occurrence would post today, or `null` when that cannot be
   * determined. `null` is never the persisted snapshot: an occurrence nobody can
   * price makes the running balance after it unknown, so it is reported as a gap
   * and the caller withholds the series.
   */
  amount: number | null;
  /** Set when `amount` is null, so the caller can say why. */
  gapReason?: BalanceForecastGapReason;
  gapFromCurrency?: string | null;
  gapToCurrency?: string | null;
}

export interface ForecastPoint {
  date: string;
  balance: number;
}

function roundCents(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** Whether this occurrence moves money through `accountId` at all. */
function touchesAccount(
  o: ForecastOccurrenceInput,
  accountId: string,
): boolean {
  return o.accountId === accountId || o.transferAccountId === accountId;
}

/**
 * Signed effect `amount` has on `accountId` (a transfer's destination receives
 * the source's outflow, so it lands positive). One function, so a base
 * occurrence and an overridden one cannot pick up different sign conventions.
 */
function deltaFor(
  o: ForecastOccurrenceInput,
  accountId: string,
  amount: number,
): number {
  let delta = 0;
  if (o.accountId === accountId) delta += amount;
  if (o.transferAccountId === accountId) delta += Math.abs(amount);
  return delta;
}

/**
 * Accumulate the occurrences' deltas into a per-date map, merged with any
 * `actualByDate` (future-dated real transactions).
 *
 * Returns the gaps alongside the map: a schedule with an unknown amount whose
 * occurrences all fall outside the window never reaches this function, so "is
 * this forecast complete" is answered from the occurrences that actually landed
 * (issue #1247). The caller withholds the series when `gaps` is non-empty.
 */
export function accumulateForecastDeltas(
  occurrences: ForecastOccurrenceInput[],
  accountId: string,
  actualByDate: Map<string, number> = new Map(),
): { byDate: Map<string, number>; gaps: BalanceForecastGap[] } {
  const byDate = new Map(actualByDate);
  const gaps: BalanceForecastGap[] = [];
  const addGap = (o: ForecastOccurrenceInput) => {
    if (gaps.some((g) => g.scheduledTransactionId === o.scheduledTransactionId))
      return;
    gaps.push({
      scheduledTransactionId: o.scheduledTransactionId,
      name: o.name,
      reason: o.gapReason ?? "unresolvedSettlementRate",
      fromCurrency: o.gapFromCurrency ?? null,
      toCurrency: o.gapToCurrency ?? null,
    });
  };

  for (const occurrence of occurrences) {
    if (!touchesAccount(occurrence, accountId)) continue;
    if (occurrence.amount === null) {
      addGap(occurrence);
      continue;
    }
    const delta = deltaFor(occurrence, accountId, occurrence.amount);
    // A zero delta contributes nothing, and emitting it would add a flat point
    // to the series for a day on which nothing happens.
    if (delta !== 0) {
      byDate.set(
        occurrence.dueDate,
        roundCents((byDate.get(occurrence.dueDate) ?? 0) + delta),
      );
    }
  }
  return { byDate, gaps };
}

/**
 * Build a forecast balance series from `today` (anchored at `startBalance`)
 * through `horizon`, applying the per-date deltas. Emits a point at today plus
 * one at each date that carries a delta.
 */
export function buildForecastSeries(
  startBalance: number,
  today: string,
  horizon: string,
  deltaByDate: Map<string, number>,
): ForecastPoint[] {
  const dates = [...deltaByDate.keys()]
    .filter((d) => d > today && d <= horizon)
    .sort();
  let balance = roundCents(startBalance);
  const series: ForecastPoint[] = [{ date: today, balance }];
  for (const d of dates) {
    balance = roundCents(balance + (deltaByDate.get(d) ?? 0));
    series.push({ date: d, balance });
  }
  return series;
}
