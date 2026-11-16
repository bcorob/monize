/**
 * The money-weighted return of a dated cash-flow schedule, written once.
 *
 * The XIRR: the annual rate `r` at which every flow, discounted from its own
 * date on actual days over 365, sums to zero. Its one caller today is the
 * invested part's `investmentMoneyWeightedReturnPercent`
 * (`backend/src/net-worth/invested-period-result.util.ts`,
 * `docs/specs/portfolio-period-result.md` section 11), beside the
 * time-weighted figure `twr-chain.util.ts` chains; a later money-weighted
 * figure joins this file rather than restating the arithmetic, for the reason
 * the summary's second TWR was removed with #1392.
 *
 * Pure: no ambient date, no rounding policy, no currency. The caller folds its
 * money into integer ten-thousandths (AGENTS.md, Financial math) and decides
 * what a `null` means at its own surface.
 */

/** One dated flow of a schedule, from the investor's point of view. */
export interface XirrFlow {
  /** Whole days from the schedule's own baseline; the baseline is 0. */
  dayOffset: number;
  /**
   * The signed amount in integer ten-thousandths: negative is money the
   * investor put in, positive is money that came back.
   */
  amountMinor: number;
}

/** Days a year, the XIRR convention: actual days over 365, leap years included. */
export const XIRR_DAYS_PER_YEAR = 365;

/**
 * The bracket a rate is searched in. Below -100% a discount factor is undefined
 * (and at it, infinite); above 1000% a year the schedule is a data defect
 * rather than a return, and reporting one would be a plausible number nobody
 * can tell from a real one.
 */
const RATE_LOW = -0.999999;
const RATE_HIGH = 10;

/** Bisection halves the bracket every step, so this is a ceiling, not a budget. */
const MAX_ITERATIONS = 200;

/** On the NPV, in currency units: the flows are ten-thousandths of one. */
const NPV_TOLERANCE = 1e-10;

/** The bracket's own width, below which further halving buys nothing. */
const RATE_TOLERANCE = 1e-12;

/** The net present value of the schedule at `rate`, in currency units. */
function netPresentValue(flows: readonly XirrFlow[], rate: number): number {
  let sum = 0;
  for (const flow of flows) {
    sum +=
      flow.amountMinor /
      10000 /
      Math.pow(1 + rate, flow.dayOffset / XIRR_DAYS_PER_YEAR);
  }
  return sum;
}

/** Sign changes in a sequence, zeros skipped: a zero is no information. */
function signChanges(values: readonly number[]): number {
  let changes = 0;
  let previous = 0;
  for (const value of values) {
    if (value === 0) continue;
    const sign = value > 0 ? 1 : -1;
    if (previous !== 0 && sign !== previous) changes += 1;
    previous = sign;
  }
  return changes;
}

/**
 * Whether this schedule has at most ONE rate, on either sufficient condition.
 *
 * A polynomial in `1 / (1 + r)` can have several roots, and "the IRR" of such a
 * schedule is whichever one the search happened to reach -- a figure that
 * changes with the end the bisection started from. Rather than print one, the
 * solver refuses, so the two conditions below are the whole licence to answer:
 *
 * 1. the amounts in date order change sign exactly once: every payment in
 *    before every payment out, a simple investment, whose NPV is strictly
 *    decreasing in `r` and therefore crosses zero at most once;
 * 2. the CUMULATIVE amounts in date order change sign exactly once: Norstrom's
 *    criterion, which admits a schedule that dips back in (a purchase after a
 *    sale) while the money invested to date never turns positive twice.
 *
 * 3. failing both counts, the NPV crosses zero exactly once across the
 *    bracket (`npvCrossesOnce`): a portfolio that lost money with a dividend
 *    or a sale along the way meets neither count and still has one rate.
 *
 * None is necessary for a unique rate; each is sufficient, and a schedule
 * meeting none is reported as undefined rather than guessed at.
 */
function hasSingleRate(flows: readonly XirrFlow[]): boolean {
  const amounts = flows.map((flow) => flow.amountMinor);
  if (signChanges(amounts) === 1) return true;

  const cumulative: number[] = [];
  let running = 0;
  for (const amount of amounts) {
    running += amount;
    cumulative.push(running);
  }
  if (signChanges(cumulative) === 1) return true;

  return npvCrossesOnce(flows);
}

/** Sampling density of the crossing count; log-spaced in `1 + rate`. */
const NPV_SAMPLES = 1024;

/**
 * The third licence: the NPV crosses zero exactly once across the reportable
 * bracket, read off a dense sample of it.
 *
 * Neither counting condition admits a portfolio that LOST money and had a
 * dividend or a sale along the way: its cumulative flows never turn positive
 * (zero sign changes) while its amounts change sign several times, yet the
 * negative rate that clears it is the only one. Nor is the NPV monotonic over
 * the whole bracket for such a schedule (it falls through zero, then rises
 * back towards the day-zero flow), so a slope test refuses it too. What can
 * be checked is the crossing itself: the NPV is sampled at `NPV_SAMPLES`
 * points log-spaced in `1 + rate`, and a sign that changes exactly once is
 * one root in the bracket. A schedule with two genuine roots inside it
 * (-1000, +2300, -1320 clears at both 10% and 20%) shows two crossings and is
 * refused. This is a numerical reading, so the sample is dense: two roots
 * closer together than a sample step would read as none or as one, which is
 * the same answer for a pair of rates a reader could not tell apart.
 */
function npvCrossesOnce(flows: readonly XirrFlow[]): boolean {
  const logLow = Math.log(1 + RATE_LOW);
  const logHigh = Math.log(1 + RATE_HIGH);
  const values: number[] = [];
  for (let i = 0; i <= NPV_SAMPLES; i++) {
    const rate = Math.exp(logLow + ((logHigh - logLow) * i) / NPV_SAMPLES) - 1;
    const value = netPresentValue(flows, rate);
    if (Number.isFinite(value)) values.push(value);
  }
  return signChanges(values) === 1;
}

/**
 * The annual money-weighted rate of a schedule, as a fraction (0.1 is 10%), or
 * `null` when the schedule defines no single rate.
 *
 * `null` is "unknown", never zero and never a fallback figure. It is returned
 * for a schedule with fewer than two dated flows or none but zeros (nothing to
 * solve), one with no sign change (only purchases, or only proceeds: no rate
 * exists), one whose NPV keeps one sign across the whole bracket (the root, if
 * there is one, is outside the range a return may be reported over), and one
 * with several roots (see `hasSingleRate`).
 *
 * Flows are folded per `dayOffset` first, so a caller may pass a day's
 * purchase and its dividend as two entries without changing the answer.
 */
export function xirrAnnualRate(flows: readonly XirrFlow[]): number | null {
  if (flows.length === 0) return null;

  const byDay = new Map<number, number>();
  for (const flow of flows) {
    if (
      !Number.isFinite(flow.amountMinor) ||
      !Number.isFinite(flow.dayOffset)
    ) {
      return null;
    }
    byDay.set(
      flow.dayOffset,
      (byDay.get(flow.dayOffset) ?? 0) + flow.amountMinor,
    );
  }

  const folded: XirrFlow[] = [...byDay.entries()]
    .map(([dayOffset, amountMinor]) => ({ dayOffset, amountMinor }))
    .sort((a, b) => a.dayOffset - b.dayOffset);

  if (folded.length < 2) return null;
  if (folded.every((flow) => flow.amountMinor === 0)) return null;
  if (!hasSingleRate(folded)) return null;

  let low = RATE_LOW;
  let high = RATE_HIGH;
  let atLow = netPresentValue(folded, low);
  const atHigh = netPresentValue(folded, high);
  if (!Number.isFinite(atLow) || !Number.isFinite(atHigh)) return null;
  if (atLow === 0) return low;
  if (atHigh === 0) return high;
  // One sign across the bracket: no crossing to find inside it. A schedule of
  // purchases only lands here too, which is the same answer for a better
  // reason -- it has no rate at all.
  if (atLow > 0 === atHigh > 0) return null;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const middle = (low + high) / 2;
    const value = netPresentValue(folded, middle);
    if (Math.abs(value) <= NPV_TOLERANCE || high - low < RATE_TOLERANCE) {
      return middle;
    }
    if (value > 0 === atLow > 0) {
      low = middle;
      atLow = value;
    } else {
      high = middle;
    }
  }

  return (low + high) / 2;
}

/**
 * The same rate expressed over `days` rather than over a year:
 * `(1 + r)^(days/365) - 1`, as a fraction.
 *
 * An EXTRAPOLATION of the rate, not a realised total -- a schedule whose money
 * came back after a year of a two-year window compounds its rate over a year
 * that held nothing -- so a caller captions it as a rate over the window and
 * never as what the reader made (`docs/specs/portfolio-period-result.md`
 * section 11.3). `null` in, `null` out.
 */
export function totalOverDays(
  annualRate: number | null,
  days: number,
): number | null {
  if (annualRate === null) return null;
  if (!(days >= 0)) return null;
  return Math.pow(1 + annualRate, days / XIRR_DAYS_PER_YEAR) - 1;
}
