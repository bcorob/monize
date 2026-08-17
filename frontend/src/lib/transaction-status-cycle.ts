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

export function nextCycleStatus(
  status: TransactionStatus,
): TransactionStatus | null {
  if (status === TransactionStatus.VOID) return null;
  const currentIndex = STATUS_CYCLE_ORDER.indexOf(
    status as (typeof STATUS_CYCLE_ORDER)[number],
  );
  return STATUS_CYCLE_ORDER[(currentIndex + 1) % STATUS_CYCLE_ORDER.length];
}
