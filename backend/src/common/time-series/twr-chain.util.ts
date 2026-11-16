/**
 * The arithmetic of a chained, time-weighted return, written once.
 *
 * One measure chains sub-period factors: the period result's
 * `investmentReturnPercent` (`investedPeriodResult`,
 * `backend/src/net-worth/invested-period-result.util.ts`), chained daily over
 * a window whose every day is valued date-correctly. The portfolio summary's
 * `timeWeightedReturn` is that same measure asked since the portfolio's first
 * transaction, not a second one: the older implementation that valued its
 * boundaries from stored closes alone was removed with #1392, because two
 * spellings of "chain the factors and subtract one" are two returns wearing
 * one caption -- the `docs/specs/portfolio-period-result.md` section 10.2 rule.
 * This file stays the one home of the arithmetic so a later chained figure
 * joins it rather than restating it.
 */

/**
 * One sub-period's growth factor, or `null` when the sub-period has no return
 * to report.
 *
 * `base` is what was at risk when the sub-period opened -- for a daily chain,
 * the previous close plus the capital paid in at the start of the day. `ending`
 * is what it came to: the close, plus what was taken out at the end of the day
 * and whatever it distributed.
 *
 * `null` means "this sub-period contributes nothing", not "zero return":
 *
 *  - a non-positive base is a sub-period with no capital at risk, and a ratio
 *    over it has no meaning (over a negative one it reverses its own sign);
 *  - a negative ending value is not a factor either -- a position cannot be
 *    worth less than nothing, so such a figure is a defect upstream and is not
 *    laundered into a return here.
 *
 * The caller decides what a contributed-nothing sub-period means for its chain;
 * a daily chain treats it as factor 1, because a day nothing was invested is a
 * day nothing was earned or lost.
 */
export function subPeriodFactor(base: number, ending: number): number | null {
  if (!(base > 0)) return null;
  if (!(ending >= 0)) return null;
  return ending / base;
}

/**
 * The chained return of a list of sub-period factors, as a percentage.
 *
 * `null` for an empty chain: no sub-period was measurable, which is unknown
 * rather than zero. A caller that knows its own zero -- a window in which
 * nothing was ever invested and nothing was earned -- reports that zero itself
 * rather than reading it out of an empty product.
 */
export function chainTwrPercent(factors: readonly number[]): number | null {
  if (factors.length === 0) return null;
  let product = 1;
  for (const factor of factors) product *= factor;
  return (product - 1) * 100;
}
