/**
 * The two share-price conversions the scheduled-investment dialogs share: given
 * a price, derive the total from a quantity, or the quantity from a total. Kept
 * in one place so the post dialog and the override editor cannot drift on the
 * rounding scale or the signed commission -- only on *which* of the two they
 * choose to run, which is a per-surface decision (see each call site) and is
 * deliberately not encoded here.
 *
 * `sign` is +1 for a buy-side action and -1 for a SELL, matching how the
 * commission moves the cash total (a buy costs price + commission; a sell nets
 * price - commission).
 */

/**
 * The latest usable market close from a security-price response, or null. Only a
 * positive, finite close is a price: 0, negative, NaN and an empty response are
 * all "no price". NaN in particular slips past a `!= null` check and, since
 * NaN !== NaN, would make a market-price latch re-fire every render. Kept in one
 * place so the three scheduled-investment surfaces cannot drift on what counts as
 * a quote (they all set marketPrice from this, and gate the fill/placeholder/hint
 * on its result).
 */
export function usableClose(
  prices: ReadonlyArray<{ closePrice: number | string; priceDate?: string | null }>,
): { price: number; date: string | null } | null {
  const latest = prices[0];
  if (!latest) return null;
  const price = Number(latest.closePrice);
  if (!Number.isFinite(price) || price <= 0) return null;
  return { price, date: latest.priceDate ?? null };
}

/**
 * Round to money precision (4dp, `decimal(20,4)`) -- the scale a total and a
 * balance are stored at. Kept here beside the fold so the two conversions and
 * their call sites round money one way. (Plain `Math.round`, matching the fold;
 * `lib/format.ts`'s `roundToDecimals` applies an epsilon nudge and is a different
 * strategy on the boundary -- do not swap one for the other.)
 */
export function roundMoney(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Round a share price to its stored/display precision (6dp). */
export function roundPrice(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** Total cash for `quantity` shares at `price`, commission folded in, at money precision. */
export function totalFromQuantity(
  quantity: number,
  price: number,
  sign: number,
  commission: number,
): number {
  return roundMoney(quantity * price + sign * commission);
}

/**
 * Shares that `total` buys at `price` once the commission is backed out, never
 * negative, at share precision (8dp). A non-positive price yields 0 rather than
 * a division blow-up; callers gate on `price > 0` before offering it, so this is
 * belt and braces.
 */
export function quantityFromTotal(
  total: number,
  price: number,
  sign: number,
  commission: number,
): number {
  if (!(price > 0)) return 0;
  const cost = total - sign * commission;
  const qty = Math.max(0, cost / price);
  return Math.round(qty * 100_000_000) / 100_000_000;
}
