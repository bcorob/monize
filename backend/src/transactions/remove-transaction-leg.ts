import { EntityManager } from "typeorm";
import { deletionBalanceEffect } from "../common/deletion-balance.util";
import { Transaction } from "./entities/transaction.entity";
import { LockedTransactionRow } from "../common/db/locks";

/**
 * Removing a ledger row and reversing what it contributed to a balance, in one
 * place.
 *
 * The sequence is not obvious and every part of it is load-bearing:
 *
 * 1. **Delete conditionally, and read the result.** `manager.remove(entity)`
 *    deletes by primary key and reports nothing, so two concurrent removals each
 *    reversed the same amount while only one row went away. The reversal has to
 *    be gated on this request being the one that removed the row.
 * 2. **Derive the amount from the locked row, not from a snapshot.** The caller's
 *    copy may predate another writer's edit; reversing a stale amount leaves the
 *    ledger and `current_balance` permanently apart.
 * 3. **A VOID row contributed nothing, so there is nothing to reverse.**
 *    Subtracting its amount is a straight corruption of the balance.
 * 4. **A future-dated row is not in `current_balance` at all**, so it gets a
 *    recomputation rather than a delta.
 *
 * That sequence existed in three services and needed a fourth copy for split
 * removal, which is how the audit's FV4-002 double-reversal survived the pass
 * that fixed the other three. `derived-state-writers.guard.spec.ts` fails on a
 * balance reversal beside an unconditional `remove()`.
 */

/** The two balance operations a leg removal needs. */
export interface LegBalanceWriter {
  updateBalance(accountId: string, amount: number): Promise<unknown>;
  recalculateCurrentBalance(
    userId: string,
    accountId: string,
  ): Promise<unknown>;
}

/**
 * Delete one locked ledger row and reverse its balance contribution.
 *
 * Returns true when this call removed the row. False means somebody else already
 * did, and **nothing was reversed** -- the caller must not treat it as an error,
 * but must not double up on any other side effect it was about to perform either.
 */
export async function removeLockedTransactionLeg(
  m: EntityManager,
  leg: LockedTransactionRow,
  userId: string,
  balances: LegBalanceWriter,
): Promise<boolean> {
  const removed = await m.delete(Transaction, { id: leg.id, userId });
  if ((removed.affected ?? 0) === 0) {
    return false;
  }

  // The one deletion-reversal rule, from the shared helper, rather than a
  // third hand-written copy of it beside the two the helper replaced.
  const effect = deletionBalanceEffect(leg);
  if (effect.delta !== 0) {
    await balances.updateBalance(leg.accountId, effect.delta);
  }
  if (effect.needsRecalc) {
    await balances.recalculateCurrentBalance(userId, leg.accountId);
  }
  return true;
}
