import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
// The securities module graph is circular: InvestmentTransactionsService depends
// on HoldingsService directly, which reaches AccountsService via forwardRef.
// InvestmentTransactionsService must be evaluated (and with it the securities
// graph) before HoldingsService is imported, or Nest cannot resolve
// InvestmentTransactionsService's HoldingsService constructor argument
// ("argument at index [3] is undefined"). Keeping this import first -- the order
// the passing investment-transactions integration spec uses -- and importing
// HoldingsService last is what makes the graph build.
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
import { HoldingsService } from "@/securities/holdings.service";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { withUserContext } from "@/common/db/with-context";
import { withScopedDb } from "@/common/db/scoped-db";
import { createTestAccount } from "../helpers/test-factories";

/**
 * INV-HOLDING-001 -- two-connection proof (audit P4-006), through the real
 * investment ledger.
 *
 * The invariant is that `holdings.quantity` and `average_cost` equal a
 * deterministic replay of `investment_transactions`. So both the operations that
 * race AND the expectation must come from that ledger, not from the test's own
 * arithmetic:
 *
 *   - the two racing trades are real `InvestmentTransactionsService.create`
 *     BUYs, which persist an `investment_transactions` row and drive the holding
 *     through the production path (processTransactionEffects -> updateHolding ->
 *     createOrUpdate -> lockHoldingScope -> read-modify-write);
 *   - after both commit, the expected quantity and average cost are computed by
 *     replaying the *persisted* rows with the same blend `createOrUpdate` uses,
 *     and compared against the stored `Holding`.
 *
 * That makes the test bite on more than a lost update. If the ledger->holding
 * propagation were removed, or a BUY's quantity sign inverted, or its cost passed
 * wrong, the persisted ledger would still replay to 30 shares at 200 while the
 * holding would not -- and the assertion is holding-vs-replay, so it fails.
 *
 * Mechanism under test: `lockHoldingScope` (`backend/src/common/db/locks.ts`), an
 * advisory lock keyed by account that createOrUpdate takes before reading the
 * quantity it will write back. The unique key on (account_id, security_id) blocks
 * a second insert and the row lock serializes the physical writes, but neither
 * stops the second request writing a quantity it derived from the value it read
 * *before* waiting.
 *
 * ---------------------------------------------------------------------------
 * The interleaving is forced, not hoped for. A plain `Promise.all` loses an
 * update only on the unlucky scheduling, so with the lock removed the test would
 * be flaky-green rather than reliably red. A test-held row lock on the holding
 * pins the ordering so both arrangements are deterministic:
 *
 *   - A barrier transaction takes `SELECT ... FOR UPDATE` on the holding row and
 *     is held open. Each trade's holding UPDATE (the first write `create` makes)
 *     blocks on it, while `findByAccountAndSecurity` (a plain SELECT) reads free.
 *   - WITHOUT the mechanism: both trades read the same starting quantity, compute
 *     their totals, and park on the barrier at their writes. Releasing it lets one
 *     commit and the other overwrite with a stale-derived total -- a lost update.
 *   - WITH the mechanism: the first trade takes the advisory lock, reads, and
 *     parks on the barrier; the second blocks at `lockHoldingScope` *before it can
 *     read*. Releasing the barrier lets the first commit and release the advisory
 *     lock; only then does the second read the fresh quantity and add its delta.
 *
 * The two BUYs fund from different cash accounts and settle on different dates, so
 * the only row they contend on is the holding -- no funding-account balance row and
 * no per-date security_prices row serializes them ahead of the holding write and
 * masks the race.
 *
 * The prices are chosen so every intermediate blend is exact in either order
 * (10@100 then +10@200 then +10@300 gives 30 shares at a 200.0000 average, and so
 * does any permutation), so the replay expectation carries no rounding ambiguity.
 */
describe("concurrent trades on one holding (integration, INV-HOLDING-001)", () => {
  let module: TestingModule;
  let investments: InvestmentTransactionsService;
  let holdings: HoldingsService;
  let dataSource: DataSource;
  let userId: string;
  let brokerageAccountId: string;
  let fundingSeedId: string;
  let fundingAId: string;
  let fundingBId: string;
  let securityId: string;
  let holdingId: string;

  // Every trade is a plain BUY (commission 0), so cost basis is the weighted
  // average of price by quantity, and the replay is unambiguous.
  const SEED = { qty: 10, price: 100, date: "2026-01-15" };
  const TRADE_1 = { qty: 10, price: 200, date: "2026-01-16" };
  const TRADE_2 = { qty: 10, price: 300, date: "2026-01-17" };

  beforeAll(async () => {
    module = await createIntegrationModule([SecuritiesModule]);
    investments = module.get(InvestmentTransactionsService);
    holdings = module.get(HoldingsService);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  async function makeBrokerage(name: string): Promise<string> {
    const account = await createTestAccount(dataSource, userId, {
      name,
      openingBalance: 0,
      currentBalance: 0,
    });
    await dataSource.manager.update(Account, account.id, {
      accountType: AccountType.INVESTMENT,
      accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
    });
    return account.id;
  }

  async function makeFunding(name: string): Promise<string> {
    const account = await createTestAccount(dataSource, userId, {
      name,
      openingBalance: 1000000,
      currentBalance: 1000000,
    });
    return account.id;
  }

  async function buy(
    fundingAccountId: string,
    trade: { qty: number; price: number; date: string },
  ): Promise<void> {
    await withUserContext(userId, () =>
      investments.create(userId, {
        accountId: brokerageAccountId,
        action: InvestmentAction.BUY,
        transactionDate: trade.date,
        securityId,
        fundingAccountId,
        quantity: trade.qty,
        price: trade.price,
        commission: 0,
      } as any),
    );
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

    brokerageAccountId = await makeBrokerage("Brokerage");
    fundingSeedId = await makeFunding("Funding Seed");
    fundingAId = await makeFunding("Funding A");
    fundingBId = await makeFunding("Funding B");

    const securitiesService = module.get(SecuritiesService);
    const security = await withUserContext(userId, () =>
      securitiesService.create(userId, {
        symbol: "AAPL",
        name: "Apple Inc.",
        securityType: "STOCK" as any,
        currencyCode: "USD",
      } as any),
    );
    securityId = security.id;

    // Seed the starting position through a real BUY, so the holding row the
    // barrier locks exists before the race and is itself a ledger row.
    await buy(fundingSeedId, SEED);

    const seeded = await withUserContext(userId, () =>
      holdings.findByAccountAndSecurity(brokerageAccountId, securityId),
    );
    if (!seeded) throw new Error("seed BUY did not create a holding");
    holdingId = seeded.id;
  });

  /**
   * Poll until at least `expected` backends in this database are blocked waiting
   * on a lock. Condition-driven: both trades are guaranteed to park (on the
   * barrier row lock without the mechanism, or one on the barrier and one on the
   * advisory lock with it), so this resolves once they have. The attempt cap is a
   * safety net against a wiring mistake, never the timing source.
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

  /**
   * Replay the persisted investment ledger for this holding with the same blend
   * `HoldingsService.createOrUpdate` applies to a BUY. Independent of the stored
   * holding and of the test's own constants: it reads back whatever `create`
   * actually wrote to `investment_transactions`.
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
      // This fixture is BUYs only; a non-BUY would need the full reducer.
      if (row.action !== InvestmentAction.BUY) {
        throw new Error(
          `replay fixture saw an unexpected action: ${row.action}`,
        );
      }
      const qty = Number(row.quantity);
      const price = Number(row.price);
      const newQuantity = quantity + qty;
      if (qty > 0) {
        if (quantity <= 0 && newQuantity > 0) {
          avgCost = price;
        } else if (quantity > 0 && newQuantity > 0) {
          avgCost = (quantity * avgCost + qty * price) / newQuantity;
        }
      }
      quantity = newQuantity;
    }
    return { quantity, avgCost };
  }

  it("does not lose an update: stored holding equals a replay of the persisted ledger", async () => {
    let releaseBarrier!: () => void;
    const barrierCanRelease = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    let signalBarrierHeld!: () => void;
    const barrierHeld = new Promise<void>((resolve) => {
      signalBarrierHeld = resolve;
    });

    // Hold a row lock on the holding so both trades block at their write, after
    // reading. This is the barrier that makes the interleaving deterministic; it
    // is not the mechanism under test.
    const barrierDone = withUserContext(userId, () =>
      withScopedDb(dataSource, async (m) => {
        await m.query(`SELECT id FROM holdings WHERE id = $1 FOR UPDATE`, [
          holdingId,
        ]);
        signalBarrierHeld();
        await barrierCanRelease;
      }),
    );

    await barrierHeld;

    // Two concurrent real BUYs, each on its own connection/transaction, through
    // the production create path. Distinct funding accounts and dates so the only
    // contended row is the holding.
    const trade1 = buy(fundingAId, TRADE_1);
    const trade2 = buy(fundingBId, TRADE_2);

    // Wait until both trades have parked (both on the barrier without the lock;
    // one on the barrier and one on the advisory lock with it), then release.
    await waitForBlockedBackends(2);
    releaseBarrier();

    await Promise.all([barrierDone, trade1, trade2]);

    // The invariant: the stored holding equals a deterministic replay of the
    // persisted ledger. Compute the expectation from the ledger, not the inputs.
    const expected = await replayLedger();
    const holding = await dataSource.manager.findOneOrFail(Holding, {
      where: { id: holdingId },
    });
    expect(Number(holding.quantity)).toBe(expected.quantity);
    expect(Number(holding.averageCost)).toBeCloseTo(expected.avgCost, 6);

    // Sanity: the ledger really holds all three BUYs, so the lost-update gap the
    // invariant is about (30 vs 20 shares) is the one under test. These numbers
    // come from the fixture, independent of both the holding and the replay.
    expect(expected.quantity).toBe(SEED.qty + TRADE_1.qty + TRADE_2.qty); // 30
    expect(expected.avgCost).toBeCloseTo(200, 6);
  });
});
