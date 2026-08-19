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
 *
 * With one bounded exception, which is what `RECONCILED_UNDO_WINDOW_SECONDS`
 * below is for: a reconcile made seconds ago is a click, not settled history.
 */

/**
 * How long a row that has just become RECONCILED may still be taken back.
 *
 * A click on the register's status cell cycles to RECONCILED, and with the
 * strict lock on the very next click was refused -- so a misclick was permanent
 * and the way out was a trip to Settings to disable the lock for the whole
 * ledger. Ten seconds is long enough to notice the cell you did not mean to
 * press and short enough that nothing anybody would call history is inside it.
 *
 * The window is a property of the **row**, not of the page the click came from:
 * "the user just did this" is a fact the transaction itself carries, and keying
 * it off which surface sent the request would be keying a promise off a
 * transport detail. The clock is the database's, on the row's `updated_at` --
 * one clock decides, rather than the server's and the client's agreeing.
 *
 * `frontend/src/lib/transaction-status-cycle.ts` carries the same number for
 * its copy; `reconciled-lock.util.spec.ts` fails if the two drift.
 */
export const RECONCILED_UNDO_WINDOW_SECONDS = 10;

/**
 * Whether `next` takes a RECONCILED row back to an unreconciled state -- the
 * only transition the undo window opens.
 *
 * Not VOID: voiding moves money and reverses shares, and a window that exists
 * so a misclick can be taken back must not become a ten-second door into every
 * alteration the lock refuses. Not an edit either -- this is asked on the
 * status path alone.
 */
export function isReconciledUndo(
  current: string | null,
  next: string | null,
): boolean {
  return (
    current === TransactionStatus.RECONCILED &&
    (next === TransactionStatus.UNRECONCILED ||
      next === TransactionStatus.CLEARED)
  );
}

/**
 * Whether this row became RECONCILED recently enough to still be undone.
 *
 * Asked of the database inside the caller's transaction, against `updated_at`
 * and `clock_timestamp()`, so the same clock stamps the reconcile and measures
 * the window. A row that is gone answers `false`: an absent row is not a fresh
 * one, and the caller's own `NotFound` handling covers it.
 *
 * `updated_at` is when the row last changed, which for a row the lock is
 * holding *is* when it became reconciled -- every later write is refused. The
 * one gap is a user who edits a reconciled row with the lock off and turns the
 * lock on within ten seconds; their own just-touched row is undoable for the
 * remainder of the window, which is the same permission they had a moment
 * before.
 */
export async function isWithinReconciledUndoWindow(
  manager: EntityManager,
  transactionId: string,
): Promise<boolean> {
  const rows: { within_undo_window: boolean }[] = await manager.query(
    `SELECT clock_timestamp() - updated_at <= make_interval(secs => $2)
              AS within_undo_window
       FROM transactions
      WHERE id = $1`,
    [transactionId, RECONCILED_UNDO_WINDOW_SECONDS],
  );
  return rows[0]?.within_undo_window === true;
}

/** The refusal itself, so every path that refuses says the same thing. */
export function reconciledLockedError(): ConflictException {
  return new ConflictException(
    tr(
      "errors.transactions.reconciledLocked",
      "This transaction is reconciled and locked. Turn off 'Lock reconciled transactions' in Settings to change it.",
    ),
  );
}

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

/** What a caller may ask the lock to make an exception for. */
export interface ReconciledLockOptions {
  /**
   * The id of the single row being changed, when the caller is performing a
   * **status transition** and wants the undo window of
   * `RECONCILED_UNDO_WINDOW_SECONDS` honoured.
   *
   * Passing it means the assertion returns rather than throwing for a row that
   * became reconciled moments ago -- so the caller then **must** refuse
   * anything that is not an undo (`isReconciledUndo`) itself, because at that
   * point only the caller knows which transition it is about to make.
   * `reconciled-lock.guard.spec.ts` fails on a call site that asks for the
   * window and does not.
   */
  undoWindowFor?: string;
}

/** What the assertion learned, for a caller that opened the undo window. */
export interface ReconciledLockVerdict {
  /**
   * True when the row is locked *and* fresh enough to be taken back -- the one
   * state in which the caller is responsible for the second half of the rule.
   * False whenever the lock did not apply at all, so it can never be read as
   * "the lock is off".
   */
  undoWindowOpen: boolean;
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
  options: ReconciledLockOptions = {},
): Promise<ReconciledLockVerdict> {
  const closed = { undoWindowOpen: false };
  const hasReconciled = rows.some(
    (row) => row?.status === TransactionStatus.RECONCILED,
  );
  if (!hasReconciled) return closed;
  if (!(await isReconciledLockEnabled(manager, userId))) return closed;

  if (
    options.undoWindowFor &&
    (await isWithinReconciledUndoWindow(manager, options.undoWindowFor))
  ) {
    return { undoWindowOpen: true };
  }

  throw reconciledLockedError();
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
