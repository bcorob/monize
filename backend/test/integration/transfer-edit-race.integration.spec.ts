import { TestingModule } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { TransactionsService } from "@/transactions/transactions.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionTransferService } from "@/transactions/transaction-transfer.service";
import { TransactionStatus } from "@/transactions/entities/transaction.entity";
import { Account } from "@/accounts/entities/account.entity";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { withUserContext } from "@/common/db/with-context";
import { createTestAccount } from "../helpers/test-factories";
import { createBarrier, pauseBefore, raceTwo } from "../helpers/race";

/**
 * A26-H03 (A26-S07-01) and A26-M11 (A26-S07-05).
 *
 * Two transfer edit branches derived both balance deltas from rows read
 * before their transaction: the split-transfer leg and the connected
 * cross-owner pair. Two identical edits (a double click, a retry, two tabs)
 * each reversed the same old amount, so each account moved twice while the
 * ledger moved once:
 *
 *   (a) chequing 5,000.00 holds a split parent -100.00 (category -60.00,
 *       transfer -40.00 to savings 2,000.00); two PATCH .../transfer
 *       {amount: 50}: chequing stored 4,880.00 vs ledger 4,890.00, savings
 *       2,060.00 vs 2,050.00.
 *   (b) Bob (edit grant on Alice's chequing) moved 500.00 from his savings to
 *       Alice's chequing; two {amount: 600}: Bob's savings 1,300.00 vs
 *       1,400.00, Alice's chequing 5,700.00 vs 5,600.00.
 *
 * Both racers read their snapshot and meet at a barrier placed before any
 * lock (`assertCategoryOwned`, called by every branch before its
 * transaction), so neither has written when the other reads.
 *
 * The same branches skipped the strict reconciled lock; the last block pins
 * the refusal on each with nothing written.
 */
describe("Transfer edits lock both legs (integration)", () => {
  jest.setTimeout(60000);

  let module: TestingModule;
  let service: TransactionsService;
  let transferService: TransactionTransferService;
  let dataSource: DataSource;

  beforeAll(async () => {
    module = await createIntegrationModule([TransactionsModule]);
    service = module.get(TransactionsService);
    transferService = module.get(TransactionTransferService);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  const spies: jest.SpyInstance[] = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "action_history",
      "transaction_splits",
      "transactions",
      "account_delegate_grants",
      "account_delegates",
      "accounts",
      "categories",
      "user_preferences",
      "monthly_account_balances",
      "users",
    ]);
  });

  async function balanceOf(accountId: string): Promise<number> {
    const account = await dataSource.manager.findOne(Account, {
      where: { id: accountId },
    });
    return Number(account!.currentBalance);
  }

  async function ledgerOf(accountId: string): Promise<number> {
    const [row] = await dataSource.query(
      `SELECT (a.opening_balance + COALESCE(SUM(t.amount)
                 FILTER (WHERE t.status IS DISTINCT FROM 'VOID'), 0))::float8 AS v
         FROM accounts a
         LEFT JOIN transactions t ON t.account_id = a.id
        WHERE a.id = $1
        GROUP BY a.opening_balance`,
      [accountId],
    );
    return Number(row.v);
  }

  async function expectStoredEqualsLedger(ids: string[]): Promise<void> {
    for (const id of ids) {
      expect({ id, stored: await balanceOf(id) }).toEqual({
        id,
        stored: await ledgerOf(id),
      });
    }
  }

  function parkBeforeLocks() {
    const barrier = createBarrier(2);
    spies.push(
      pauseBefore(transferService, "assertCategoryOwned" as never, barrier),
    );
    return barrier;
  }

  async function lockReconciled(userId: string): Promise<void> {
    await dataSource.query(
      `INSERT INTO user_preferences (user_id, lock_reconciled_transactions)
       VALUES ($1, true)
       ON CONFLICT (user_id) DO UPDATE SET lock_reconciled_transactions = true`,
      [userId],
    );
  }

  async function reconcile(id: string): Promise<void> {
    await dataSource.query(
      `UPDATE transactions SET status = 'RECONCILED' WHERE id = $1`,
      [id],
    );
  }

  describe("split-transfer leg", () => {
    let userId: string;
    let chequingId: string;
    let savingsId: string;
    let parentId: string;
    let legId: string;

    beforeEach(async () => {
      userId = (await createTestUserDirect(dataSource)).id;
      chequingId = (
        await createTestAccount(dataSource, userId, {
          name: "Chequing",
          openingBalance: 5000,
          currentBalance: 5000,
        })
      ).id;
      savingsId = (
        await createTestAccount(dataSource, userId, {
          name: "Savings",
          openingBalance: 2000,
          currentBalance: 2000,
        })
      ).id;
      const [category] = await dataSource.query(
        `INSERT INTO categories (user_id, name) VALUES ($1, 'Groceries') RETURNING id`,
        [userId],
      );
      const parent = await withUserContext(userId, () =>
        service.create(userId, {
          accountId: chequingId,
          transactionDate: "2026-01-15",
          amount: -100,
          currencyCode: "USD",
          splits: [
            { amount: -60, categoryId: category.id },
            { amount: -40, transferAccountId: savingsId },
          ],
        } as never),
      );
      parentId = parent.id;
      const [leg] = await dataSource.query(
        `SELECT id FROM transactions WHERE account_id = $1`,
        [savingsId],
      );
      legId = leg.id;
      expect(await balanceOf(chequingId)).toBe(4900);
      expect(await balanceOf(savingsId)).toBe(2040);
    });

    const edit = (amount: number) => () =>
      withUserContext(userId, () =>
        service.updateTransfer(userId, legId, { amount }),
      );

    it.each([
      ["the same value", 50, 50],
      ["different values", 50, 55],
    ])(
      "two concurrent edits with %s keep stored = ledger",
      async (_label, first, second) => {
        parkBeforeLocks();

        const outcome = await raceTwo(dataSource, edit(first), edit(second));

        await expectStoredEqualsLedger([chequingId, savingsId]);
        expect(outcome.fulfilled).toBe(1);
        expect(outcome.reasons[0]).toBeInstanceOf(ConflictException);
      },
    );

    it("refuses an edit of a reconciled leg under the strict lock, writing nothing", async () => {
      await lockReconciled(userId);
      await reconcile(legId);

      await expect(edit(55)()).rejects.toBeInstanceOf(ConflictException);

      const [leg] = await dataSource.query(
        `SELECT amount::float8 AS amount FROM transactions WHERE id = $1`,
        [legId],
      );
      expect(leg.amount).toBe(40);
      expect(await balanceOf(chequingId)).toBe(4900);
      expect(await balanceOf(savingsId)).toBe(2040);
    });

    it("refuses deleting a reconciled leg under the strict lock, writing nothing", async () => {
      await lockReconciled(userId);
      await reconcile(legId);

      await expect(
        withUserContext(userId, () => service.removeTransfer(userId, legId)),
      ).rejects.toBeInstanceOf(ConflictException);

      const [{ n }] = await dataSource.query(
        `SELECT count(*)::int AS n FROM transactions WHERE id = ANY($1)`,
        [[legId, parentId]],
      );
      expect(n).toBe(2);
      expect(await balanceOf(chequingId)).toBe(4900);
      expect(await balanceOf(savingsId)).toBe(2040);
    });

    it("refuses deleting a leg whose parent is reconciled, writing nothing", async () => {
      await lockReconciled(userId);
      await reconcile(parentId);

      await expect(
        withUserContext(userId, () => service.removeTransfer(userId, legId)),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(await balanceOf(savingsId)).toBe(2040);
    });
  });

  describe("connected cross-owner transfer", () => {
    let aliceId: string;
    let bobId: string;
    let aliceChequingId: string;
    let bobSavingsId: string;
    let bobLegId: string;
    let aliceLegId: string;

    const actorBob = () => ({ effectiveUserId: bobId, realUserId: bobId });

    beforeEach(async () => {
      aliceId = (await createTestUserDirect(dataSource)).id;
      bobId = (await createTestUserDirect(dataSource)).id;
      aliceChequingId = (
        await createTestAccount(dataSource, aliceId, {
          name: "Alice Chequing",
          openingBalance: 5000,
          currentBalance: 5000,
        })
      ).id;
      bobSavingsId = (
        await createTestAccount(dataSource, bobId, {
          name: "Bob Savings",
          openingBalance: 2000,
          currentBalance: 2000,
        })
      ).id;
      const [delegation] = await dataSource.query(
        `INSERT INTO account_delegates (owner_user_id, delegate_user_id, status)
         VALUES ($1, $2, 'active') RETURNING id`,
        [aliceId, bobId],
      );
      await dataSource.query(
        `INSERT INTO account_delegate_grants
           (delegation_id, account_id, can_read, can_create, can_edit, can_delete)
         VALUES ($1, $2, true, true, true, true)`,
        [delegation.id, aliceChequingId],
      );
      const { fromTransaction, toTransaction } = await withUserContext(
        bobId,
        () =>
          service.createTransfer(
            bobId,
            {
              fromAccountId: bobSavingsId,
              toAccountId: aliceChequingId,
              transactionDate: "2026-01-15",
              amount: 500,
              fromCurrencyCode: "USD",
            },
            actorBob(),
          ),
      );
      bobLegId = fromTransaction.id;
      aliceLegId = toTransaction.id;
      expect(await balanceOf(bobSavingsId)).toBe(1500);
      expect(await balanceOf(aliceChequingId)).toBe(5500);
    });

    const edit = (amount: number) => () =>
      withUserContext(bobId, () =>
        service.updateTransfer(bobId, bobLegId, { amount }, actorBob()),
      );

    it.each([
      ["the same value", 600, 600],
      ["different values", 600, 650],
    ])(
      "two concurrent edits with %s keep stored = ledger on both owners' accounts",
      async (_label, first, second) => {
        parkBeforeLocks();

        const outcome = await raceTwo(dataSource, edit(first), edit(second));

        await expectStoredEqualsLedger([bobSavingsId, aliceChequingId]);
        expect(outcome.fulfilled).toBe(1);
        expect(outcome.reasons[0]).toBeInstanceOf(ConflictException);
      },
    );

    it("refuses an edit of the acting owner's reconciled leg, writing nothing", async () => {
      await lockReconciled(bobId);
      await reconcile(bobLegId);

      await expect(edit(650)()).rejects.toBeInstanceOf(ConflictException);
      expect(await balanceOf(bobSavingsId)).toBe(1500);
      expect(await balanceOf(aliceChequingId)).toBe(5500);
    });

    it("refuses an edit when the counterpart is reconciled under its owner's lock", async () => {
      await lockReconciled(aliceId);
      await reconcile(aliceLegId);

      await expect(edit(650)()).rejects.toBeInstanceOf(ConflictException);
      expect(await balanceOf(bobSavingsId)).toBe(1500);
      expect(await balanceOf(aliceChequingId)).toBe(5500);
    });

    it("refuses deleting the pair when a leg is reconciled, writing nothing", async () => {
      await lockReconciled(bobId);
      await reconcile(bobLegId);

      await expect(
        withUserContext(bobId, () =>
          service.removeTransfer(bobId, bobLegId, actorBob()),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      const [{ n }] = await dataSource.query(
        `SELECT count(*)::int AS n FROM transactions WHERE id = ANY($1)`,
        [[bobLegId, aliceLegId]],
      );
      expect(n).toBe(2);
    });

    it("refuses a frozen-leg edit of a reconciled own leg, writing nothing", async () => {
      // Unshare: the counterpart becomes unreadable, the own leg is frozen.
      await dataSource.query(
        `DELETE FROM account_delegates WHERE owner_user_id = $1`,
        [aliceId],
      );
      await lockReconciled(bobId);
      await reconcile(bobLegId);

      await expect(
        withUserContext(bobId, () =>
          service.updateTransfer(
            bobId,
            bobLegId,
            { description: "renamed" },
            actorBob(),
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      const [leg] = await dataSource.query(
        `SELECT description FROM transactions WHERE id = $1`,
        [bobLegId],
      );
      expect(leg.description).not.toBe("renamed");
    });
  });

  it("a status-only edit of a split leg is not refused by the concurrency check", async () => {
    // Sanity: the compare is against what the request was built on, so an
    // edit with nothing concurrent goes through.
    const userId = (await createTestUserDirect(dataSource)).id;
    const a = (await createTestAccount(dataSource, userId, { name: "A" })).id;
    const b = (await createTestAccount(dataSource, userId, { name: "B" })).id;
    await withUserContext(userId, () =>
      service.create(userId, {
        accountId: a,
        transactionDate: "2026-01-15",
        amount: -10,
        currencyCode: "USD",
        splits: [
          { amount: -6, transferAccountId: b },
          { amount: -4, transferAccountId: b },
        ],
      } as never),
    );
    const [leg] = await dataSource.query(
      `SELECT id FROM transactions WHERE account_id = $1 LIMIT 1`,
      [b],
    );
    await withUserContext(userId, () =>
      service.updateTransfer(userId, leg.id, {
        status: TransactionStatus.CLEARED,
      }),
    );
    const [row] = await dataSource.query(
      `SELECT status FROM transactions WHERE id = $1`,
      [leg.id],
    );
    expect(row.status).toBe(TransactionStatus.CLEARED);
  });
});
