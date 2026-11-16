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
import { InvestmentAction } from "@/securities/entities/investment-transaction.entity";
import { LockScope } from "@/common/db/locks";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { withUserContext } from "@/common/db/with-context";
import { createTestAccount } from "../helpers/test-factories";
import { raceTwo } from "../helpers/race";

/**
 * A26-L19 (A26-S12-07), INV-HOLDING-001 -- the security-transfer edit takes
 * the holdings lock before it validates or writes, and decides from both legs
 * as they are under their row locks.
 *
 * X holds 10 and has moved 5 to the destination. A SELL of the 5 left and an
 * edit raising the transfer to 10 are each fine alone and together oversell
 * X by 5. The gate holds X's holdings lock while both start. Unfixed, the
 * edit takes no lock until its closing rebuild: it validates the oversell
 * without seeing the SELL (still parked) and parks only at the rebuild, and
 * the SELL, released first, validates without seeing the edit. Both commit
 * and X's history goes to -5. Fixed, the edit parks on the lock before
 * anything, and whichever runs second sees the other and is refused.
 */
describe("security-transfer edit racing a SELL (integration, A26-L19)", () => {
  let module: TestingModule;
  let investments: InvestmentTransactionsService;
  let dataSource: DataSource;
  let userId: string;
  let brokerageAccountId: string;
  let destinationAccountId: string;
  let fundingAccountId: string;
  let securityId: string;
  let transferOutId: string;

  const OPENING_BALANCE = 100000;

  beforeAll(async () => {
    module = await createIntegrationModule([SecuritiesModule]);
    investments = module.get(InvestmentTransactionsService);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

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

    const destination = await createTestAccount(dataSource, userId, {
      name: "Destination",
      openingBalance: 0,
      currentBalance: 0,
    });
    await dataSource.manager.update(Account, destination.id, {
      accountType: AccountType.INVESTMENT,
      accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
    });
    destinationAccountId = destination.id;

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

    // X holds 10, and 5 of them moved to the destination on 2026-01-20.
    await withUserContext(userId, () =>
      investments.create(userId, {
        accountId: brokerageAccountId,
        action: InvestmentAction.BUY,
        transactionDate: "2026-01-15",
        securityId,
        fundingAccountId,
        quantity: 10,
        price: 100,
        commission: 0,
      } as any),
    );
    const moved = await withUserContext(userId, () =>
      investments.transferSecurity(userId, {
        fromAccountId: brokerageAccountId,
        toAccountId: destinationAccountId,
        securityId,
        transactionDate: "2026-01-20",
        quantity: 5,
        costPerShare: 100,
      }),
    );
    transferOutId = moved.transferOut.id;
  });

  const gate = () => ({
    sql: "SELECT pg_advisory_xact_lock($1::int, hashtext($2))",
    params: [LockScope.Holdings, brokerageAccountId],
  });

  const sell = () =>
    withUserContext(userId, () =>
      investments.create(userId, {
        accountId: brokerageAccountId,
        action: InvestmentAction.SELL,
        transactionDate: "2026-02-01",
        securityId,
        fundingAccountId,
        quantity: 5,
        price: 120,
        commission: 0,
      } as any),
    );
  const raiseTransfer = () =>
    withUserContext(userId, () =>
      investments.update(userId, transferOutId, { quantity: 10 } as any),
    );

  /** The lowest running share count X's ledger ever reaches. */
  async function lowestRunningQuantity(): Promise<number> {
    const rows: { action: string; quantity: string }[] = await dataSource.query(
      `SELECT action, quantity FROM investment_transactions
        WHERE account_id = $1 AND security_id = $2 AND status <> 'VOID'
        ORDER BY transaction_date, created_at, id`,
      [brokerageAccountId, securityId],
    );
    let running = 0;
    let lowest = 0;
    for (const row of rows) {
      const q = Number(row.quantity);
      running += row.action === "BUY" ? q : -q;
      lowest = Math.min(lowest, running);
    }
    return lowest;
  }

  it("never lets the pair oversell X: the second writer sees the first", async () => {
    const outcome = await raceTwo(dataSource, sell, raiseTransfer, {
      gate: gate(),
    });

    expect(await lowestRunningQuantity()).toBe(0);
    expect(outcome.fulfilled).toBe(1);
  });
});
