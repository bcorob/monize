import { TransactionStatus } from '@/types/transaction';

/**
 * The register's click-to-cycle order. VOID is deliberately not in the cycle:
 * voiding reverses money (and, for investment transactions, shares), so it is
 * only reachable through the form, and a click on a VOID row returns null so
 * the caller can point the user there instead.
 *
 * Shared by the cash register and the investment register so the two cannot
 * drift on what a click means.
 */
export const STATUS_CYCLE_ORDER = [
  TransactionStatus.UNRECONCILED,
  TransactionStatus.CLEARED,
  TransactionStatus.RECONCILED,
] as const;

/**
 * How long the register lets a just-reconciled row be taken back, while
 * "Lock reconciled transactions" is on.
 *
 * The server decides -- it measures the window against the row's own
 * `updated_at` on the database clock, and refuses anything outside it. This
 * copy exists only so the toast can say how long the user has, and
 * `backend/src/transactions/reconciled-lock.util.spec.ts` fails if the two
 * numbers drift: a toast promising ten seconds over a server allowing five is
 * a promise broken on the user's next click.
 */
export const RECONCILED_UNDO_WINDOW_SECONDS = 10;

export function nextCycleStatus(
  status: TransactionStatus,
): TransactionStatus | null {
  if (status === TransactionStatus.VOID) return null;
  const currentIndex = STATUS_CYCLE_ORDER.indexOf(
    status as (typeof STATUS_CYCLE_ORDER)[number],
  );
  return STATUS_CYCLE_ORDER[(currentIndex + 1) % STATUS_CYCLE_ORDER.length];
}
