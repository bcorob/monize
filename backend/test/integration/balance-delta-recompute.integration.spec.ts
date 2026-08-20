import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { AccountsService } from "@/accounts/accounts.service";
import { AccountsModule } from "@/accounts/accounts.module";
import { Account } from "@/accounts/entities/account.entity";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { withUserContext } from "@/common/db/with-context";
import { withScopedDb } from "@/common/db/scoped-db";
import { createTestAccount } from "../helpers/test-factories";

/**
 * INV-BALANCE-001 -- two-connection proof (audit P4-005).
 *
 * Mechanism under test: `lockAccountsForBalanceWrite`
 * (`backend/src/common/db/locks.ts`), a `SELECT ... FOR UPDATE` that
 * `AccountsService.recalculateCurrentBalance` takes as the *first* statement of
 * its transaction, before it reads the ledger it will write back.
 *
 * The invariant: a balance delta committing concurrently with an absolute
 * recompute must NOT be silently discarded. `current_balance` after both is
 * `opening_balance + SUM(every non-void, non-child ledger row)` -- the delta's
 * new row included.
 *
 * Why the two protocols do not compose unaided: under READ COMMITTED the
 * recompute's ledger `SELECT` and its account `UPDATE` are separate statement
 * snapshots. A delta (a new transaction plus `current_balance += amount`) that
 * commits between them is overwritten by an absolute total that never saw its
 * ledger row -- the money moved, then un-moved itself, with both writers
 * reporting success.
 *
 * ---------------------------------------------------------------------------
 * The interleaving is forced, not hoped for. `Promise.all` alone reproduces a
 * lost update only on the unlucky scheduling, so removing the lock would leave
 * the test flaky-green rather than reliably red. Instead the delta transaction
 * grabs the account row lock (via its `current_balance += d` UPDATE) and is held
 * open while the recompute runs, so the ordering is pinned:
 *
 *   1. Delta: `UPDATE accounts SET current_balance += d` -- takes & holds the
 *      account row lock. Its ledger row is NOT inserted yet.
 *   2. Recompute starts. WITHOUT the lock its ledger `SELECT` runs immediately
 *      and reads the *stale* sum (the delta row does not exist), then its
 *      `UPDATE accounts` blocks on the delta's row lock. WITH the lock its very
 *      first statement (`FOR UPDATE`) blocks -- before it can read the ledger.
 *   3. Once the recompute backend is observed blocked, the delta inserts the
 *      ledger row backing its `+d` and commits, releasing the row lock.
 *   4. WITHOUT the lock the recompute now writes its stale total (opening + S),
 *      silently discarding `d`. WITH the lock the recompute only now acquires
 *      `FOR UPDATE`, reads the ledger on a fresh snapshot that includes the
 *      delta row, and writes opening + S + d.
 *
 * So with the mechanism present the final balance reflects BOTH writers in
 * either scheduling; with it neutralized this exact ordering deterministically
 * loses `d`.
 */
describe("balance delta vs. absolute recompute (integration, INV-BALANCE-001)", () => {
  let module: TestingModule;
  let service: AccountsService;
  let dataSource: DataSource;
  let userId: string;
  let accountId: string;

  const OPENING = 1000;
  // Seeded ledger rows summing to S = 300, so the seeded current_balance is
  // opening + S = 1300 and consistent before the race.
  const SEED_ROWS = [500, -200];
  const S = SEED_ROWS.reduce((sum, amount) => sum + amount, 0);
  // The concurrent atomic delta (a new transaction of +250).
  const DELTA = 250;
  const EXPECTED_FINAL = OPENING + S + DELTA; // 1550

  beforeAll(async () => {
    module = await createIntegrationModule([AccountsModule]);
    service = module.get(AccountsService);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "action_history",
      "transaction_splits",
      "transactions",
      "accounts",
      "categories",
      "payees",
      "scheduled_transaction_splits",
      "scheduled_transaction_overrides",
      "scheduled_transactions",
      "investment_transactions",
      "monthly_account_balances",
      "users",
    ]);

    const user = await createTestUserDirect(dataSource);
    userId = user.id;

    const account = await createTestAccount(dataSource, userId, {
      name: "Chequing",
      openingBalance: OPENING,
      currentBalance: OPENING + S,
    });
    accountId = account.id;

    // Seed the ledger rows the recompute will sum. Raw SQL so their amounts and
    // dates are exactly the fixture, not whatever a service would allocate.
    for (const amount of SEED_ROWS) {
      await dataSource.query(
        `INSERT INTO transactions
           (id, user_id, account_id, transaction_date, amount, currency_code,
            exchange_rate, is_split, is_transfer, status)
         VALUES (gen_random_uuid(), $1, $2, DATE '2026-01-15', $3, 'USD', 1,
                 false, false, 'UNRECONCILED')`,
        [userId, accountId, amount],
      );
    }
  });

  /**
   * Poll until at least `expected` backends in this database are blocked waiting
   * on a lock. Condition-driven (not a fixed sleep): the recompute is guaranteed
   * to block on the delta's held row lock in both the with-lock and without-lock
   * arrangements, so this always resolves once it has parked there. The attempt
   * cap is only a safety net against a wiring mistake, never the timing source.
   */
  async function waitForBlockedBackends(expected: number): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const rows: { c: number }[] = await dataSource.query(
        `SELECT count(*)::int AS c
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND state = 'active'
            AND wait_event_type = 'Lock'`,
      );
      if (rows[0].c >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(
      `Timed out waiting for ${expected} lock-blocked backend(s); the race was ` +
        "never set up, so the test would prove nothing.",
    );
  }

  it("keeps the delta: final balance reflects BOTH the recompute and the concurrent delta", async () => {
    let releaseDelta!: () => void;
    const deltaCanFinish = new Promise<void>((resolve) => {
      releaseDelta = resolve;
    });
    let signalLockHeld!: () => void;
    const deltaHoldsLock = new Promise<void>((resolve) => {
      signalLockHeld = resolve;
    });

    // (a) The atomic delta path, held open across the recompute. This is the
    // `updateBalance` SQL verbatim -- lock, re-check is_closed, apply the delta --
    // followed by the ledger row that backs it, all in one transaction.
    const deltaDone = withUserContext(userId, () =>
      withScopedDb(dataSource, async (m) => {
        await m.query(
          `UPDATE accounts
              SET current_balance = ROUND(CAST(current_balance AS numeric) + $1, 4)
            WHERE id = $2 AND is_closed = false`,
          [DELTA, accountId],
        );
        signalLockHeld();
        // Hold the account row lock (and withhold the ledger row) until the
        // recompute has read the stale ledger and parked on the balance write.
        await deltaCanFinish;
        await m.query(
          `INSERT INTO transactions
             (id, user_id, account_id, transaction_date, amount, currency_code,
              exchange_rate, is_split, is_transfer, status)
           VALUES (gen_random_uuid(), $1, $2, DATE '2026-01-15', $3, 'USD', 1,
                   false, false, 'UNRECONCILED')`,
          [userId, accountId, DELTA],
        );
        // Returning here commits the withScopedDb transaction, releasing the
        // row lock the recompute is waiting on.
      }),
    );

    await deltaHoldsLock;

    // (b) The absolute recompute, on its own connection/transaction.
    const recomputeDone = withUserContext(userId, () =>
      service.recalculateCurrentBalance(userId, accountId),
    );

    // Let the recompute reach its blocking point (FOR UPDATE with the lock, or
    // the balance UPDATE without it), then let the delta finish and commit.
    await waitForBlockedBackends(1);
    releaseDelta();

    await Promise.all([deltaDone, recomputeDone]);

    // The stored balance must equal opening + every ledger row, delta included.
    const account = await dataSource.manager.findOneOrFail(Account, {
      where: { id: accountId },
    });
    expect(Number(account.currentBalance)).toBe(EXPECTED_FINAL);

    // And it must equal an independent re-sum of the ledger -- the delta row is
    // really there; the balance is not merely a lucky number.
    const [{ balance }]: { balance: string }[] = await dataSource.query(
      `SELECT COALESCE(a.opening_balance, 0) + COALESCE(SUM(t.amount), 0) AS balance
         FROM accounts a
         LEFT JOIN transactions t ON t.account_id = a.id
           AND (t.status IS NULL OR t.status != 'VOID')
           AND t.parent_transaction_id IS NULL
        WHERE a.id = $1
        GROUP BY a.id, a.opening_balance`,
      [accountId],
    );
    expect(Number(balance)).toBe(EXPECTED_FINAL);
  });
});
