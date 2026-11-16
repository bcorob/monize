/**
 * Whether a quote provider may price this security.
 *
 * A security linked to a bond instrument (`bondProgramId`) is priced by the
 * bond engine only (`bonds/bond-price.service.ts`): Yahoo and MSN are not a
 * source of retail bond terms or values, and a provider quote written beside the
 * engine's would be a second answer to one question. This is the single
 * predicate every path that asks a provider for a quote, a bar, a window or an
 * intraday series consults (INV-BOND-005); `provider-priced.guard.spec.ts` fails
 * when one of them stops.
 *
 * Read by shape, not by entity, so a raw row or a partial selection works too.
 * An absent `bondProgramId` (a row from a deployment that predates the
 * column) is "not linked".
 */
export function isPricedByQuoteProvider(security: {
  readonly bondProgramId?: string | null;
}): boolean {
  return !security.bondProgramId;
}
