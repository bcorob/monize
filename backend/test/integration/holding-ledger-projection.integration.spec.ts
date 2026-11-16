import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
// The securities module graph is circular; see the comment in
// holding-concurrent-trades.integration.spec.ts for why this import order is
// what makes the graph build.
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
import { createTestAccount } from "../helpers/test-factories";

/**
 * INV-HOLDING-001 -- the stored holding is a projection of the ledger, through
 * the real service and a real database (issue #1388).
 *
 * The concurrency half of the invariant has its own spec
 * (holding-concurrent-trades.integration.spec.ts). This one is about ORDER: a
 * holding maintained as an accumulator is a function of the order rows were
 * ENTERED in, and the ledger is a function of the dates they carry. The two
 * disagree the moment a trade is back-dated, which is the ordinary case -- a
 * statement reconciled a month late, an import, a corrected date.
 *
 * The reproduction from the issue, entered in this order:
 *
 *   1. BUY  100 @ 10.00  dated 2026-01-01
 *   2. BUY  100 @ 20.00  dated 2026-03-01
 *   3. SELL  50 @ 12.00  dated 2026-02-01   <- entered LAST, dated in between
 *
 * Replayed by date the sale relieves basis at 10.00 (the only lot it could have
 * come from), leaving 150 shares carrying 2,500: 16.6667 a share. Blended in
 * insertion order the two purchases average to 15.00 before the sale arrives,
 * the sale relieves 750, and 150 shares carry 2,250: 15.0000 a share -- the
 * figure the holdings page showed while `POST /holdings/rebuild` said 16.6667.
 *
 * Every expectation here is computed by replaying the PERSISTED ledger rather
 * than from the fixture's arithmetic, so the test bites on any divergence
 * between what the service stored and what the ledger says, not only on the one
 * number the issue reported.
 */
describe("holding is a ledger projection (integration, INV-HOLDING-001)", () => {
  let module: TestingModule;
  let investments: InvestmentTransactionsService;
  let holdings: HoldingsService;
  let dataSource: DataSource;
  let userId: string;
  let brokerageAccountId: string;
  let fundingAccountId: string;
  let securityId: string;

  const FIRST_BUY = { qty: 100, price: 10, date: "2026-01-01" };
  const SECOND_BUY = { qty: 100, price: 20, date: "2026-03-01" };
  const BACKDATED_SELL = { qty: 50, price: 12, date: "2026-02-01" };

  beforeAll(async () => {
    module = await createIntegrationModule([SecuritiesModule]);
    investments = module.get(InvestmentTransactionsService);
    holdings = module.get(HoldingsService);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  async function trade(
    action: InvestmentAction,
    row: { qty: number; price: number; date: string },
  ): Promise<string> {
    const created = await withUserContext(userId, () =>
      investments.create(userId, {
        accountId: brokerageAccountId,
        action,
        transactionDate: row.date,
        securityId,
        fundingAccountId,
        quantity: row.qty,
        price: row.price,
        commission: 0,
      } as any),
    );
    return created.id;
  }

  /**
   * Replay the PERSISTED ledger in the canonical order and with the canonical
   * basis treatment: a purchase adds what it cost, a disposal relieves basis at
   * the position's average for the shares it actually took. Deliberately a
   * second implementation rather than a call into the service -- an expectation
   * computed by the code under test proves nothing.
   */
  async function replayLedger(): Promise<{
    quantity: number;
    averageCost: number;
  }> {
    const rows: { quantity: string; price: string | null; action: string }[] =
      await dataSource.query(
        `SELECT quantity, price, action
           FROM investment_transactions
          WHERE account_id = $1 AND security_id = $2 AND status <> 'VOID'
          ORDER BY transaction_date ASC, created_at ASC, id ASC`,
        [brokerageAccountId, securityId],
      );

    let quantity = 0;
    let totalCost = 0;
    for (const row of rows) {
      const qty = Number(row.quantity);
      const price = Number(row.price);
      if (row.action === InvestmentAction.BUY) {
        totalCost += qty * price;
        quantity += qty;
      } else if (row.action === InvestmentAction.SELL) {
        if (quantity > 0) {
          const relieved = Math.min(qty, quantity);
          totalCost -= relieved * (totalCost / quantity);
        }
        quantity -= qty;
      } else {
        throw new Error(
          `replay fixture saw an unexpected action: ${row.action}`,
        );
      }
    }
    return {
      quantity,
      averageCost: quantity > 0 ? totalCost / quantity : 0,
    };
  }

  async function storedHolding(): Promise<Holding> {
    return dataSource.manager.findOneOrFail(Holding, {
      where: { accountId: brokerageAccountId, securityId },
    });
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

    const funding = await createTestAccount(dataSource, userId, {
      name: "Funding",
      openingBalance: 1000000,
      currentBalance: 1000000,
    });
    fundingAccountId = funding.id;

    const securitiesService = module.get(SecuritiesService);
    const security = await withUserContext(userId, () =>
      securitiesService.create(userId, {
        symbol: "AAA",
        name: "Triple A Corp",
        securityType: "STOCK" as any,
        currencyCode: "USD",
      } as any),
    );
    securityId = security.id;
  });

  it("stores the replayed average cost when a sale is entered after a later purchase", async () => {
    await trade(InvestmentAction.BUY, FIRST_BUY);
    await trade(InvestmentAction.BUY, SECOND_BUY);
    await trade(InvestmentAction.SELL, BACKDATED_SELL);

    const expected = await replayLedger();
    const holding = await storedHolding();

    expect(Number(holding.quantity)).toBeCloseTo(expected.quantity, 6);
    expect(Number(holding.averageCost)).toBeCloseTo(expected.averageCost, 4);

    // Independent of the replay: the issue's own numbers, and the figure the
    // accumulator produced, which must not be what is stored.
    expect(expected.quantity).toBe(150);
    expect(Number(holding.averageCost)).toBeCloseTo(16.6667, 4);
    expect(Number(holding.averageCost)).not.toBeCloseTo(15, 2);
  });

  it("stores the same figure whatever order the three rows were entered in", async () => {
    // Same three rows, entered in date order this time. A projection gives one
    // answer; an accumulator gives two.
    await trade(InvestmentAction.BUY, FIRST_BUY);
    await trade(InvestmentAction.SELL, BACKDATED_SELL);
    await trade(InvestmentAction.BUY, SECOND_BUY);

    const expected = await replayLedger();
    const holding = await storedHolding();

    expect(Number(holding.quantity)).toBeCloseTo(expected.quantity, 6);
    expect(Number(holding.averageCost)).toBeCloseTo(16.6667, 4);
  });

  it("re-converges when the back-dated sale is deleted", async () => {
    await trade(InvestmentAction.BUY, FIRST_BUY);
    await trade(InvestmentAction.BUY, SECOND_BUY);
    const sellId = await trade(InvestmentAction.SELL, BACKDATED_SELL);

    await withUserContext(userId, () => investments.remove(userId, sellId));

    const expected = await replayLedger();
    const holding = await storedHolding();

    expect(Number(holding.quantity)).toBeCloseTo(expected.quantity, 6);
    expect(Number(holding.averageCost)).toBeCloseTo(expected.averageCost, 4);
    // 200 shares, 3,000 of basis: a delta applied to the previous 16.6667 could
    // not have arrived here.
    expect(expected.quantity).toBe(200);
    expect(Number(holding.averageCost)).toBeCloseTo(15, 4);
  });

  it("re-converges when the back-dated sale is edited", async () => {
    await trade(InvestmentAction.BUY, FIRST_BUY);
    await trade(InvestmentAction.BUY, SECOND_BUY);
    const sellId = await trade(InvestmentAction.SELL, BACKDATED_SELL);

    await withUserContext(userId, () =>
      investments.update(userId, sellId, { quantity: 80 } as any),
    );

    const expected = await replayLedger();
    const holding = await storedHolding();

    expect(Number(holding.quantity)).toBeCloseTo(expected.quantity, 6);
    expect(Number(holding.averageCost)).toBeCloseTo(expected.averageCost, 4);
    expect(expected.quantity).toBe(120);
  });

  it("agrees with the full rebuild, which is the repair for rows written before this rule", async () => {
    await trade(InvestmentAction.BUY, FIRST_BUY);
    await trade(InvestmentAction.BUY, SECOND_BUY);
    await trade(InvestmentAction.SELL, BACKDATED_SELL);

    const beforeRebuild = await storedHolding();
    await withUserContext(userId, () =>
      holdings.rebuildFromTransactions(userId),
    );
    const afterRebuild = await storedHolding();

    expect(Number(afterRebuild.quantity)).toBeCloseTo(
      Number(beforeRebuild.quantity),
      6,
    );
    expect(Number(afterRebuild.averageCost)).toBeCloseTo(
      Number(beforeRebuild.averageCost),
      4,
    );
  });
});
