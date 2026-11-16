import { roundMoney } from './format';

/**
 * What a whole position in one security is worth right now: the shares held
 * across every account times the security's most recent close.
 *
 * The figure is in the **security's own currency** -- both inputs are quoted
 * there, so nothing is converted and no exchange rate can be missing. A caller
 * that shows it beside amounts in another currency has to name the currency
 * (`withCurrencyCode`), because a bare symbol does not.
 *
 * The two answers this deliberately keeps apart:
 *
 * - **Zero shares is zero.** A security in the catalog that nobody holds is
 *   worth nothing whatever its price does, and no price is needed to say so.
 *   That is a measurement, not a gap, so it is not `null`.
 * - **Shares with no usable price is unknown.** `null`, never `0` and never the
 *   share count passed through: a holding whose price never arrived is a value
 *   nobody knows, and rendering it as zero states that the position is
 *   worthless. "Usable" is `usableClose`'s rule -- a positive finite number;
 *   0, a negative and NaN are all "no price".
 *
 * Shares and price are read defensively because both cross the wire: a decimal
 * column arrives as a string from some endpoints, and an older backend sends no
 * price field at all.
 */
export function securityPositionValue(
  shares: number | string | null | undefined,
  lastPrice: number | string | null | undefined,
): number | null {
  const quantity = Number(shares);
  // A share count that will not read as a number is treated as none held, which
  // is what the Shares column beside it already prints for the same input.
  if (!Number.isFinite(quantity) || quantity === 0) return 0;

  const price = Number(lastPrice);
  if (!Number.isFinite(price) || price <= 0) return null;

  return roundMoney(quantity * price);
}

/**
 * Order two position values, unknown last.
 *
 * `null` is not a small number, so it does not belong at either end of an
 * ascending sort: a security whose price never arrived would head the list and
 * read as the cheapest thing held. It sinks in both directions instead, the way
 * the portfolio's own holdings sort treats an unpriced row.
 *
 * `direction` applies to the two known values only, and is why the caller passes
 * it in rather than negating the result.
 */
export function compareSecurityValues(
  a: number | null,
  b: number | null,
  direction: 'asc' | 'desc',
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return direction === 'asc' ? a - b : b - a;
}
