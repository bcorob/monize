/**
 * Convert `amount` from one currency to another using a caller-supplied rate
 * lookup. Tries the direct pair first, then falls back to the inverse pair
 * (the reciprocal of the reverse rate). Returns `null` when neither rate is
 * available so the caller decides how to handle a missing rate: carry it as
 * unknown, name the pair, withhold the total. Returning the amount unconverted
 * is not an option for a caller either (INV-FX-001).
 *
 * Only `from === to` answers the amount untouched. An empty code on either side
 * names no currency, so it is unknown, not "the same currency".
 *
 * This is the single source of truth for the "direct then inverse" conversion
 * decision. Callers differ only in where rates come from -- a flat map of the
 * latest rates, or a date-indexed history resolved as-of a given date -- which
 * they express through the `getRate` function. Keeping the decision here means
 * reports and net worth can never diverge on how a pair is converted.
 */
export function convertWithRateLookup(
  amount: number,
  from: string,
  to: string,
  getRate: (from: string, to: string) => number | undefined,
): number | null {
  if (!from || !to) {
    return null;
  }
  if (from === to) {
    return amount;
  }

  // A rate must be strictly positive to be a rate at all. Zero and negatives
  // are treated as absent rather than applied: multiplying by 0 would report a
  // real holding as worthless, and the inverse branch already had to guard
  // against dividing by it.
  const direct = getRate(from, to);
  if (direct != null && direct > 0) {
    return amount * direct;
  }

  const inverse = getRate(to, from);
  if (inverse != null && inverse > 0) {
    return amount / inverse;
  }

  return null;
}
