/**
 * The account boundary a tagged transfer is judged against under the default
 * "All Accounts" (`docs/specs/report-tag-key-breakdown.md` section 10.8.1).
 *
 * An empty account selection sends no `accountIds`, so the server counted both
 * legs of every tagged transfer, while selecting every account the picker
 * offers counted only what came in from outside them. The picker offers the
 * non-investment accounts, a notion the server deliberately cannot spell
 * (INV-REPORT-001), so the client names that boundary itself as
 * `transferScopeAccountIds`. It bounds the tagged flows only: income and
 * expenses stay the unfiltered report's.
 */

/** The server's cap on an id list (`@ArrayMaxSize(200)`). */
export const MAX_TRANSFER_SCOPE_IDS = 200;

export interface TransferScope {
  /** The offered accounts are not known yet: a flow figure now would be the unbounded one. */
  pending: boolean;
  /** The boundary to send as `transferScopeAccountIds`; absent = none. */
  accountIds?: string[];
}

const NONE: TransferScope = { pending: false };
const PENDING: TransferScope = { pending: true };

/**
 * @param selectedIds the report's account selection; non-empty means
 *   `accountIds` already carries the boundary.
 * @param offeredIds the ids the picker offers, or null while they load. A
 *   failed load is passed as an empty list: no boundary, today's behaviour.
 */
export function transferScopeFor(
  selectedIds: readonly string[],
  offeredIds: readonly string[] | null,
): TransferScope {
  if (selectedIds.length > 0) return NONE;
  if (offeredIds === null) return PENDING;
  // Over the cap the request would be refused, so the boundary is left off and
  // the report reads as it did before the boundary existed.
  if (offeredIds.length === 0 || offeredIds.length > MAX_TRANSFER_SCOPE_IDS) {
    return NONE;
  }
  return { pending: false, accountIds: [...offeredIds] };
}

/** Stable key of a scope, for a fetch's dependency list. */
export function transferScopeKey(scope: TransferScope): string {
  if (scope.pending) return 'pending';
  return scope.accountIds ? scope.accountIds.join(',') : '';
}
