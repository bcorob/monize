/**
 * Which of a pair's two latest provider quotes is a rate worth storing.
 *
 * Yahoo's chart endpoint reports `meta.regularMarketPrice` rounded to the
 * instrument's `priceHint`, which is four decimals for every currency pair --
 * while the daily closes in the same response keep full precision. A pair whose
 * rate is small loses most of it: `IDRSGD=X` quotes `0.0001` against a close of
 * `0.00007156` (40% high), `VNDSGD=X` quotes `0.0`, and `JPYUSD=X` quotes
 * `0.0063` against `0.006336`. The response is a 200 either way, so the refresh
 * used to store the rounded figure as the day's rate. The reverse symbol has
 * the digits the rounding threw away -- `SGDIDR=X` quotes `13973.23` -- so a
 * quote below 1 is checked against its inverse, and the one with more
 * significant digits is the observation (issue #1604).
 */

/**
 * The smallest quoted rate stored when its inverse cannot be had. At four
 * decimals a quote of 0.1 or more carries four significant digits, so the
 * rounding is at most 0.05% of the rate; below it the error grows tenfold per
 * decade, and a figure that wrong is not a rate (INV-FX-001): the pair stays
 * unknown for the day rather than converting at it.
 */
export const MIN_PRECISE_QUOTED_RATE = 0.1;

/** One provider quote: `rate` is `from -> to`, `null` when nothing answered. */
export interface FxQuote {
  from: string;
  to: string;
  rate: number | null;
}

/** A quote that was chosen, in the orientation the provider quoted it. */
export interface FxQuoteObservation {
  from: string;
  to: string;
  rate: number;
}

/**
 * The quote to store, or why there is none: `unavailable` when neither symbol
 * answered with a positive rate, `imprecise` when one did but only at a
 * magnitude the provider's rounding has emptied of digits.
 */
export type FxQuoteChoice =
  | { observation: FxQuoteObservation; reason: null }
  | { observation: null; reason: "unavailable" | "imprecise" };

function usableRate(rate: number | null): rate is number {
  return rate !== null && Number.isFinite(rate) && rate > 0;
}

/**
 * Whether the inverse symbol has to be asked as well. A quote of 1 or more
 * already carries the most digits the pair can have at four decimals, so it is
 * taken as it stands; anything else -- no answer, zero, or a rate below 1 -- is
 * either a failure or the less precise side of the pair.
 */
export function quoteNeedsInverse(rate: number | null): boolean {
  return !usableRate(rate) || rate < 1;
}

/**
 * Choose between a pair's quote and its inverse's. Both are rounded to the same
 * number of decimals, so the larger rate is the one with more significant
 * digits; a tie goes to the quote asked first. The chosen quote is returned in
 * the orientation it was quoted in -- `canonicalRateRow` decides how it is
 * stored, and a caller wanting the other direction inverts it.
 */
export function chooseFxQuote(
  first: FxQuote,
  second: FxQuote | null,
): FxQuoteChoice {
  let best: FxQuoteObservation | null = null;
  for (const quote of [first, second]) {
    if (quote === null || !usableRate(quote.rate)) continue;
    if (best === null || quote.rate > best.rate) {
      best = { from: quote.from, to: quote.to, rate: quote.rate };
    }
  }
  if (best === null) return { observation: null, reason: "unavailable" };
  if (best.rate < MIN_PRECISE_QUOTED_RATE) {
    return { observation: null, reason: "imprecise" };
  }
  return { observation: best, reason: null };
}
