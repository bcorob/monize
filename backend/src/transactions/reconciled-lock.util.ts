import { ConflictException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { UserPreference } from "../users/entities/user-preference.entity";
import { TransactionStatus } from "./entities/transaction.entity";
import { tr } from "../i18n/translate";

/**
 * The strict reconciled lock.
 *
 * Microsoft Money prompts before an edit to a reconciled transaction and then
 * lets it through, and `TransactionForm` already does that. This is the other
 * half the user asked for: while `user_preferences.lock_reconciled_transactions`
 * is on, a RECONCILED row may not be altered at all.
 *
 * Two things follow from calling it a lock rather than a warning:
 *
 * 1. **It is enforced on the server, inside the mutation's own transaction,
 *    against the locked row.** A dialogue the client raises is a courtesy --
 *    the AI assistant, the MCP tools, the bulk routes and a hand-written
 *    request all reach the same writes without ever seeing it. And a check that
 *    ran before the transaction opened would be a claim about a status another
 *    request may already have changed; `docs/financial-calculation-contract.md`
 *    section 7 is the rule that a refusal must happen before anything is
 *    written, under the same lock as the write.
 * 2. **A status change away from RECONCILED is an alteration too.** Leaving
 *    unreconcile open would make the lock one extra click rather than a lock,
 *    and it is the click a user reaching for "edit anyway" would find first.
 *    The way through is the Settings toggle, which is a deliberate decision
 *    about the whole ledger rather than an accident on one row.
 */

/** Read the effective user's strict-lock preference inside the caller's transaction. */
export async function isReconciledLockEnabled(
  manager: EntityManager,
  userId: string,
): Promise<boolean> {
  const prefs = await manager.getRepository(UserPreference).findOne({
    where: { userId },
    select: { userId: true, lockReconciledTransactions: true },
  });
  return prefs?.lockReconciledTransactions === true;
}

/** The subset of a locked transaction row this guard reads. */
export interface ReconciledLockCandidate {
  readonly status: string | null;
}

/**
 * Refuse the caller's write when any of `rows` is RECONCILED and the effective
 * user has the strict lock on.
 *
 * Call it inside the mutation's `withScopedDb` callback, after the rows are
 * locked and before anything is written. A row that is not reconciled costs
 * nothing: the preference is read only when at least one candidate is
 * RECONCILED.
 */
export async function assertReconciledRowsMutable(
  manager: EntityManager,
  userId: string,
  rows: readonly ReconciledLockCandidate[],
): Promise<void> {
  const hasReconciled = rows.some(
    (row) => row?.status === TransactionStatus.RECONCILED,
  );
  if (!hasReconciled) return;
  if (!(await isReconciledLockEnabled(manager, userId))) return;

  throw new ConflictException(
    tr(
      "errors.transactions.reconciledLocked",
      "This transaction is reconciled and locked. Turn off 'Lock reconciled transactions' in Settings to change it.",
    ),
  );
}

/**
 * The id-list form, for a batch that does not hydrate every row it writes.
 *
 * Runs the same refusal as `assertReconciledRowsMutable` from a single
 * `SELECT`, so a bulk update or bulk delete cannot be the one door into a
 * locked row. Call it inside the batch's transaction, before its first write.
 */
export async function assertReconciledIdsMutable(
  manager: EntityManager,
  userId: string,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const rows: { status: string | null }[] = await manager.query(
    `SELECT status FROM transactions
      WHERE id = ANY($1::uuid[]) AND user_id = $2 AND status = $3
      LIMIT 1`,
    [[...new Set(ids)], userId, TransactionStatus.RECONCILED],
  );
  await assertReconciledRowsMutable(manager, userId, rows);
}
