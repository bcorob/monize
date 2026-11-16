import { EntityManager } from "typeorm";
import { lockAccountsForBalanceWrite } from "../common/db/locks";

/**
 * Advance `accounts.updated_at` on every account holding `securityId`, in the
 * caller's transaction, and return those account ids.
 *
 * A price write that moves no balance (a manual price, a bond-engine price)
 * leaves nothing for `NetWorthService.sweepStaleSnapshots` to find unless the
 * account row says it changed: that sweep recovers a lost post-commit recompute
 * from `updated_at > computed_at`. So the marker is written atomically with the
 * price, and the caller dispatches the debounced recompute for the returned
 * accounts after the commit (INV-CACHE-001).
 *
 * Account row locks are taken in ascending-id order before the UPDATE, as every
 * other account writer does (`common/db/locks.ts`), so two price writes over the
 * same holding accounts cannot deadlock (review MZ-1242, audit RV4-005). The
 * security is per-user, so every holder is an account of `userId`. The marker
 * is recovery and the debounce is latency.
 *
 * One residual window remains, and it is why this says "recovered from the
 * data" rather than "crash-durable": both `now()` here and the `accounts`
 * `updated_at` trigger stamp **transaction-start** time, not the instant of the
 * write. A concurrent recompute that begins after this transaction starts but
 * commits its (still-stale) snapshots before it can leave `computed_at` newer
 * than this marker, and then the sweep's `updated_at > computed_at` predicate
 * misses the account -- so if the post-commit debounce is also lost to a crash,
 * that snapshot waits for the next touch of the account instead of the sweep.
 * The account row lock taken below (`lockAccountsForBalanceWrite`) serializes
 * this write against such a recompute of the same account, which is what narrows
 * the window to the near-impossible; the snapshot self-heals on the account's
 * next change regardless. Making the marker unconditionally crash-durable would
 * mean stamping `clock_timestamp()`, which the shared `updated_at` trigger
 * clobbers back to transaction-start for every table -- out of proportion to a
 * window this small.
 */
export async function markHoldingAccountsDirty(
  manager: EntityManager,
  securityId: string,
  userId: string,
): Promise<string[]> {
  const rows: Array<{ account_id: string }> = await manager.query(
    `SELECT DISTINCT account_id FROM investment_transactions
      WHERE security_id = $1 AND status != 'VOID'`,
    [securityId],
  );
  const accountIds = (rows ?? []).map((r) => r.account_id);
  if (accountIds.length > 0) {
    await lockAccountsForBalanceWrite(manager, accountIds, userId);
    await manager.query(
      `UPDATE accounts SET updated_at = now()
        WHERE id = ANY($1::UUID[]) AND user_id = $2`,
      [accountIds, userId],
    );
  }
  return accountIds;
}
