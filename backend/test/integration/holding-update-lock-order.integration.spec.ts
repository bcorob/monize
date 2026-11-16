import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
// Import order matters: see the note at the top of
// holding-concurrent-trades.integration.spec.ts. InvestmentTransactionsService
// first, HoldingsService last.
import { InvestmentTransactionsService } from "@/securities/investment-transactions.service";
import { SecuritiesModule } from "@/securities/securities.module";
import { SecuritiesService } from "@/securities/securities.service";
import {
  Account,
  AccountSubType,
  AccountType,
} from "@/accounts/entities/account.entity";
import { Holding } from "@/securities/entities/holding.entity";
import { InvestmentAction } from "@/securities/entities/investment-transaction.entity";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { withUserContext } from "@/common/db/with-context";
import { createTestAccount } from "../helpers/test-factories";
import { createBarrier, waitForLockWaiters } from "../helpers/race";

type CreateOptions = NonNullable<
  Parameters<InvestmentTransactionsService["create"]>[2]
>;

/**
 * INV-HOLDING-001 / lock ordering (audit A26-M42, mutation M10) -- the
 * advisory-before-rows order of `InvestmentTransactionsService.update`,
 * proved with two real connections.
 *
 * The rule (`common/db/locks.ts`, `docs/concurrency-and-idempotency.md`) is
 * that an investment write takes `lockHoldingScope` (a Postgres advisory lock
 * keyed by brokerage account) as the FIRST statement of its transaction and
 * row locks after it. `create()` does, and so does `update()`. `update()` also
 * re-takes the lock inside `rebuildScopesFromTransactions`, which is why
 * deleting the opening call leaves every other suite green: the rebuild still
 * serializes the holding. What the opening call buys is the ORDER. Without it
 * `update()` row-locks the funding account's balance (it deletes the cash
 * transaction the row owned, then recreates it, both atomic balance UPDATEs)
 * BEFORE it asks for the advisory lock, while `create()` holds the advisory lock
 * and asks for that same balance row next. Two requests each holding what the
 * other wants is a `40P01` for one of them.
 *
 * How the interleaving is forced, not hoped for:
 *
 *   1. A `create()` of a BUY runs with a `beforeWrite` hook (it runs after the
 *      holdings lock and before anything is written). The hook parks on a
 *      barrier whose second party is the test, so the create holds the advisory
 *      lock and has written nothing.
 *   2. Only then does `update()` of another BUY start, in the same brokerage
 *      account and funded from the same account.
 *   3. The test waits (`waitForLockWaiters`) until the update is blocked on a
 *      lock. WITH the opening lock that is the advisory lock, before the update
 *      has touched a row. WITHOUT it that is the advisory lock taken by the
 *      rebuild, after the update has already row-locked the funding balance.
 *   4. The test arrives at the barrier, letting the create write. Baseline: it
 *      commits, releasing the advisory lock, and the update then runs against a
 *      ledger holding both rows. Mutated: the create waits for the funding
 *      balance row the update holds and the update waits for the advisory lock
 *      the create holds; Postgres aborts one of them with 40P01.
 *
 * Both outcomes are reached on every run: no sleep decides the order, and the
 * two blocking points are the ones the claim is about.
 *
 * Asserted: both requests fulfil; the stored holding equals a replay of the
 * persisted ledger; the funding account's balance equals its opening balance
 * plus the sum of its transactions.
 *
 * Mutation caught: deleting the `lockHoldingScope(manager, [accountId,
 * updateDto.accountId]...)` call at the head of `update()`.
 */
describe("update() lock order against a concurrent create (integration, INV-HOLDING-001)", () => {
  let module: TestingModule;
  let investments: InvestmentTransactionsService;
  let dataSource: DataSource;
  let userId: string;
  let brokerageAccountId: string;
  let fundingAccountId: string;
  let securityId: string;
  let editedId: string;

  const OPENING_BALANCE = 1000000;
  const SEED = { qty: 10, price: 100, date: "2026-01-15" };
  const EDITED = { qty: 10, price: 200, date: "2026-01-16" };
  const EDITED_NEW_PRICE = 250;
  const CONCURRENT = { qty: 10, price: 300, date: "2026-01-17" };

  beforeAll(async () => {
    module = await createIntegrationModule([SecuritiesModule]);
    investments = module.get(InvestmentTransactionsService);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  async function buy(
    trade: { qty: number; price: number; date: string },
    options: CreateOptions = {},
  ): Promise<string> {
    const created = await withUserContext(userId, () =>
      investments.create(
        userId,
        {
          accountId: brokerageAccountId,
          action: InvestmentAction.BUY,
          transactionDate: trade.date,
          securityId,
          fundingAccountId,
          quantity: trade.qty,
          price: trade.price,
          commission: 0,
        } as any,
        options,
      ),
    );
    return created.id;
  }

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "action_history",
      "holdings",
      "securities",
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
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places)
       VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );

    const user = await createTestUserDirect(dataSource);
    userId = user.id;

    const brokerage = await createTestAccount(dataSource, userId, {
      name: "Brokerage",
      openingBalance: 0,
      currentBalance: 0,
    });
    await dataSource.manager.update(Account, brokerage.id, {
      accountType: AccountType.INVESTMENT,
      accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
    });
    brokerageAccountId = brokerage.id;

    // One funding account for every trade: the row both racers write.
    const funding = await createTestAccount(dataSource, userId, {
      name: "Funding",
      openingBalance: OPENING_BALANCE,
      currentBalance: OPENING_BALANCE,
    });
    fundingAccountId = funding.id;

    const security = await withUserContext(userId, () =>
      module.get(SecuritiesService).create(userId, {
        symbol: "AAPL",
        name: "Apple Inc.",
        securityType: "STOCK" as any,
        currencyCode: "USD",
      } as any),
    );
    securityId = security.id;

    await buy(SEED);
    editedId = await buy(EDITED);
  });

  /**
   * Replay the persisted investment ledger (BUYs only in this fixture),
   * independent of the stored holding and of the test's own constants.
   */
  async function replayLedger(): Promise<{
    quantity: number;
    avgCost: number;
  }> {
    const rows: { quantity: string; price: string | null; action: string }[] =
      await dataSource.query(
        `SELECT quantity, price, action
           FROM investment_transactions
          WHERE account_id = $1 AND security_id = $2
          ORDER BY transaction_date ASC, id ASC`,
        [brokerageAccountId, securityId],
      );
    let quantity = 0;
    let avgCost = 0;
    for (const row of rows) {
      if (row.action !== InvestmentAction.BUY) {
        throw new Error(
          `replay fixture saw an unexpected action: ${row.action}`,
        );
      }
      const qty = Number(row.quantity);
      const price = Number(row.price);
      const newQuantity = quantity + qty;
      avgCost =
        quantity > 0 ? (quantity * avgCost + qty * price) / newQuantity : price;
      quantity = newQuantity;
    }
    return { quantity, avgCost };
  }

  it("takes the holdings lock before any row lock, so a concurrent create and update both commit", async () => {
    const barrier = createBarrier(2);
    let createHoldsLock!: () => void;
    const createHoldsLockSignal = new Promise<void>((resolve) => {
      createHoldsLock = resolve;
    });

    // Racer 1: parks inside its transaction after taking the advisory lock and
    // before writing anything.
    const creating = buy(CONCURRENT, {
      beforeWrite: async () => {
        createHoldsLock();
        await barrier.arrive();
      },
    });
    creating.catch(() => undefined);
    await Promise.race([
      createHoldsLockSignal,
      creating.then(() => {
        throw new Error("create finished without reaching its beforeWrite");
      }),
    ]);

    // Racer 2: edits the price of the other BUY, same brokerage, same funding.
    let updateSettled = false;
    const updating = withUserContext(userId, () =>
      investments.update(userId, editedId, { price: EDITED_NEW_PRICE } as any),
    ).finally(() => {
      updateSettled = true;
    });
    updating.catch(() => undefined);

    try {
      // The update parks on a lock: the advisory one at baseline (before it has
      // written a row); under M10 the one its rebuild takes, with the funding
      // balance already row-locked.
      await waitForLockWaiters(dataSource, 1, { stop: () => updateSettled });
    } finally {
      await barrier.arrive();
    }

    const [created, updated] = await Promise.allSettled([creating, updating]);

    // A 40P01 for either request is the lock-order inversion.
    expect({
      create: created.status === "rejected" ? String(created.reason) : "ok",
      update: updated.status === "rejected" ? String(updated.reason) : "ok",
    }).toEqual({ create: "ok", update: "ok" });

    // The holding equals a replay of the persisted ledger.
    const expected = await replayLedger();
    const holding = await dataSource.manager.findOneOrFail(Holding, {
      where: { accountId: brokerageAccountId, securityId },
    });
    expect(Number(holding.quantity)).toBe(expected.quantity);
    expect(Number(holding.averageCost)).toBeCloseTo(expected.avgCost, 6);
    // Fixture sanity, independent of the replay: 10@100, 10@250, 10@300.
    expect(expected.quantity).toBe(SEED.qty + EDITED.qty + CONCURRENT.qty);
    expect(expected.avgCost).toBeCloseTo((100 + EDITED_NEW_PRICE + 300) / 3, 6);

    // The funding balance equals its opening balance plus its transactions.
    const [{ balance, ledger }]: { balance: string; ledger: string }[] =
      await dataSource.query(
        `SELECT a.current_balance AS balance,
                COALESCE((SELECT SUM(t.amount) FROM transactions t
                           WHERE t.account_id = a.id), 0) AS ledger
           FROM accounts a WHERE a.id = $1`,
        [fundingAccountId],
      );
    expect(Number(balance)).toBeCloseTo(OPENING_BALANCE + Number(ledger), 4);
    // Three BUYs of 10 shares at the final prices came out of the account.
    expect(Number(ledger)).toBeCloseTo(
      -(10 * 100 + 10 * EDITED_NEW_PRICE + 10 * 300),
      4,
    );
  });
});
