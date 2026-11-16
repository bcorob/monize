import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import * as locks from "@/common/db/locks";
import { TransactionsService } from "@/transactions/transactions.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionStatus } from "@/transactions/entities/transaction.entity";
import { Account } from "@/accounts/entities/account.entity";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { withUserContext } from "@/common/db/with-context";
import { createTestAccount } from "../helpers/test-factories";
import { raceTwo } from "../helpers/race";

/**
 * A26-M09 (A26-S07-03): whether a row crosses the VOID boundary, and so whether
 * its counterpart moves with it, is decided on the row's status. Deciding it on
 * a read taken before the row lock lets a concurrent edit that commits in
 * between flip the status the decision was made on:
 *
 *   (a) a VOID transfer pair; request 1 bulk-voids leg A while request 2
 *       un-voids the pair (CLEARED). Request 1 expanded on "A is already VOID,
 *       nothing crosses", then locked A, found it CLEARED, and voided A alone:
 *       chequing 5,000.00, savings 2,100.00, the pair split across the boundary.
 *   (b) `addSplit` on a parent another request voids: the new counterpart was
 *       written with the caller's snapshot status (UNRECONCILED) and credited
 *       savings 30.00 that the VOID parent never sent.
 *
 * Each racer runs on its own connection. Racer 1 is parked at its first row
 * lock call -- in the unfixed code that is after the unlocked status read, in
 * the fixed code before any status is read -- and racer 2 runs to its commit
 * in that gap.
 */
describe("VOID crossings decided under the row lock (integration)", () => {
  jest.setTimeout(60000);

  let module: TestingModule;
  let service: TransactionsService;
  let dataSource: DataSource;
  let userId: string;
  let chequingId: string;
  let savingsId: string;

  beforeAll(async () => {
    module = await createIntegrationModule([TransactionsModule]);
    service = module.get(TransactionsService);
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
      "monthly_account_balances",
      "users",
    ]);
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
  });

  // Only this suite's own spies: `restoreAllMocks` would also undo the
  // harness's `triggerDebouncedRecalc` stub and leave real debounce timers.
  const spies: jest.SpyInstance[] = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
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

  async function statusOf(id: string): Promise<string> {
    const [row] = await dataSource.query(
      `SELECT status FROM transactions WHERE id = $1`,
      [id],
    );
    return row.status;
  }

  /**
   * Parks the next call of `method` until `release`, and reports when it is
   * parked. Only the first call is held; later calls (the other racer's) run
   * straight through.
   */
  function parkFirstCall<T extends object>(object: T, method: string) {
    let signalParked!: () => void;
    const parked = new Promise<void>((resolve) => {
      signalParked = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = (
      object as Record<string, (...args: unknown[]) => unknown>
    )[method].bind(object);
    const spy = jest.spyOn(object, method as never);
    spies.push(spy);
    spy.mockImplementationOnce((async (...args: unknown[]) => {
      signalParked();
      await released;
      return original(...args);
    }) as never);
    return { parked, release };
  }

  it("(a) bulk VOID and a concurrent un-void of the pair leave both legs on one side", async () => {
    const { fromTransaction, toTransaction } = await withUserContext(
      userId,
      () =>
        service.createTransfer(userId, {
          fromAccountId: chequingId,
          toAccountId: savingsId,
          transactionDate: "2026-01-15",
          amount: 100,
          fromCurrencyCode: "USD",
          status: TransactionStatus.VOID,
        } as never),
    );
    expect(await balanceOf(chequingId)).toBe(5000);
    expect(await balanceOf(savingsId)).toBe(2000);

    const hold = parkFirstCall(locks, "lockTransactionRows");
    const outcome = await raceTwo(
      dataSource,
      () =>
        withUserContext(userId, () =>
          service.bulkUpdate(userId, {
            mode: "ids",
            transactionIds: [fromTransaction.id],
            status: TransactionStatus.VOID,
          } as never),
        ),
      async () => {
        await hold.parked;
        try {
          await withUserContext(userId, () =>
            service.updateTransfer(userId, fromTransaction.id, {
              status: TransactionStatus.CLEARED,
            }),
          );
        } finally {
          hold.release();
        }
      },
    );

    expect(outcome.reasons).toEqual([]);
    // Request 1 ran after request 2's un-void, so it voids the pair it locked.
    expect(await statusOf(fromTransaction.id)).toBe(TransactionStatus.VOID);
    expect(await statusOf(toTransaction.id)).toBe(TransactionStatus.VOID);
    expect(await balanceOf(chequingId)).toBe(5000);
    expect(await balanceOf(savingsId)).toBe(2000);
    for (const id of [chequingId, savingsId]) {
      expect(await balanceOf(id)).toBe(await ledgerOf(id));
    }
  });

  it("(b) addSplit on a parent voided under it writes a VOID counterpart that moves nothing", async () => {
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
      } as never),
    );
    await withUserContext(userId, () =>
      service.addSplit(userId, parent.id, {
        amount: -60,
        categoryId: category.id,
      } as never),
    );
    expect(await balanceOf(chequingId)).toBe(4900);

    const hold = parkFirstCall(locks, "lockTransactionRow");
    const outcome = await raceTwo(
      dataSource,
      () =>
        withUserContext(userId, () =>
          service.addSplit(userId, parent.id, {
            amount: -30,
            transferAccountId: savingsId,
          } as never),
        ),
      async () => {
        await hold.parked;
        try {
          await withUserContext(userId, () =>
            service.updateStatus(userId, parent.id, TransactionStatus.VOID),
          );
        } finally {
          hold.release();
        }
      },
    );

    expect(outcome.reasons).toEqual([]);
    expect(await statusOf(parent.id)).toBe(TransactionStatus.VOID);
    const legs: { status: string }[] = await dataSource.query(
      `SELECT status FROM transactions WHERE account_id = $1`,
      [savingsId],
    );
    expect(legs).toEqual([{ status: TransactionStatus.VOID }]);
    expect(await balanceOf(savingsId)).toBe(2000);
    for (const id of [chequingId, savingsId]) {
      expect(await balanceOf(id)).toBe(await ledgerOf(id));
    }
  });

  it("(c) a split replacement on a parent voided under it recreates VOID counterparts", async () => {
    const parent = await withUserContext(userId, () =>
      service.create(userId, {
        accountId: chequingId,
        transactionDate: "2026-01-15",
        amount: -100,
        currencyCode: "USD",
      } as never),
    );

    const hold = parkFirstCall(locks, "lockTransactionRow");
    const outcome = await raceTwo(
      dataSource,
      () =>
        withUserContext(userId, () =>
          service.updateSplits(userId, parent.id, [
            { amount: -70, transferAccountId: savingsId },
            { amount: -30, transferAccountId: savingsId },
          ] as never),
        ),
      async () => {
        await hold.parked;
        try {
          await withUserContext(userId, () =>
            service.updateStatus(userId, parent.id, TransactionStatus.VOID),
          );
        } finally {
          hold.release();
        }
      },
    );

    expect(outcome.reasons).toEqual([]);
    expect(await statusOf(parent.id)).toBe(TransactionStatus.VOID);
    const legs: { status: string }[] = await dataSource.query(
      `SELECT status FROM transactions WHERE account_id = $1`,
      [savingsId],
    );
    expect(legs.map((l) => l.status)).toEqual([
      TransactionStatus.VOID,
      TransactionStatus.VOID,
    ]);
    expect(await balanceOf(savingsId)).toBe(2000);
    for (const id of [chequingId, savingsId]) {
      expect(await balanceOf(id)).toBe(await ledgerOf(id));
    }
  });
});
