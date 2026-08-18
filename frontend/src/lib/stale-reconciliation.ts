import { TransactionStatus } from '@/types/transaction';

/**
 * When an unreconciled transaction counts as overdue, on the client.
 *
 * This is the reading half of the contract stated in
 * `backend/src/transactions/stale-reconciliation.ts`: reconciliation is opt-in
 * per account, so only an account with at least one reconciled transaction can
 * have overdue rows, and there are two ways a row is overdue.
 *
 * - `missed` -- dated on or before the account's last reconciled date, so the
 *   statement covering it was reconciled without it.
 * - `overdue` -- newer than that, but older than the window the *server*
 *   chose. The window is never restated here: every response that asks for a
 *   classification carries `overdueBefore` (and `staleAfterDays` for the copy),
 *   so the highlight in the reconcile table and the count in the header badge
 *   cannot drift apart or from the server's own totals.
 */

export type StaleUnreconciledReason = 'missed' | 'overdue';

/**
 * Statuses that can be overdue at all.
 *
 * A RECONCILED row is done, and a VOID row records something that did not
 * happen, so neither is outstanding. The status test lives inside
 * `classifyStaleRow` rather than beside each call so a third caller cannot
 * forget half of it -- the register and the reconcile table each had their own
 * reason to think they would never be handed one of these, and being right
 * today is not the same as the rule being enforced.
 */
function isOutstanding(status: TransactionStatus): boolean {
  return (
    status !== TransactionStatus.RECONCILED && status !== TransactionStatus.VOID
  );
}

/**
 * Classify one row. `lastReconciledDate` null means the account has never been
 * reconciled, which is not the same as "nothing is overdue by accident": the
 * user has not opted in, so nothing there is overdue at all.
 *
 * `missed` is decided first so the two reasons stay disjoint -- a row can
 * satisfy both comparisons and must be reported once.
 *
 * Dates are compared as YYYY-MM-DD strings, which sort lexicographically in
 * calendar order. No Date is constructed, so no timezone can move a boundary.
 */
export function classifyStaleRow(
  status: TransactionStatus,
  transactionDate: string,
  lastReconciledDate: string | null,
  overdueBefore: string,
): StaleUnreconciledReason | null {
  if (!isOutstanding(status)) return null;
  if (!lastReconciledDate) return null;
  if (transactionDate <= lastReconciledDate) return 'missed';
  if (transactionDate < overdueBefore) return 'overdue';
  return null;
}
