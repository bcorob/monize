import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
// Import order matters: see the note at the top of
// holding-concurrent-trades.integration.spec.ts. InvestmentTransactionsService
// first, HoldingsService last.
import { InvestmentTransactionsService } from "@/securities/investment-transactions.service";
import { SecuritiesModule } from "@/securities/securities.module";
import { SecuritiesService } from "@/securities/securities.service";
import { settlePendingHistoryWrites } from "@/action-history/action-history.service";
import {
  Account,
  AccountSubType,
  AccountType,
} from "@/accounts/entities/account.entity";
import { InvestmentAction } from "@/securities/entities/investment-transaction.entity";
import { Holding } from "@/securities/entities/holding.entity";
import { withUserContext } from "@/common/db/with-context";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * A26-M23 (A26-S12-06), INV-HOLDING-001 -- a position built from purchases
 * under 0.0001 shares is a holding. The fold snapped every intermediate
 * position under 0.0001 to zero, so two BUYs of 0.00005 BTC at 60,000.00
 * (cash -6.00 posted) left no holding row at all.
 */
describe("fractional positions under 0.0001 shares (integration, A26-M23)", () => {
  let module: TestingModule;
  let investments: InvestmentTransactionsService;
  let dataSource: DataSource;
  let userId: string;
  let brokerageAccountId: string;
  let fundingAccountId: string;
  let securityId: string;

  beforeAll(async () => {
    module = await createIntegrationModule([SecuritiesModule]);
    investments = module.get(InvestmentTransactionsService);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await settlePendingHistoryWrites();
    await module.close();
  });

  beforeEach(async () => {
    await settlePendingHistoryWrites();
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
      openingBalance: 100000,
      currentBalance: 100000,
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
  });

  const trade = (
    action: InvestmentAction,
    quantity: number,
    price: number,
    date: string,
  ) =>
    withUserContext(userId, () =>
      investments.create(userId, {
        accountId: brokerageAccountId,
        action,
        transactionDate: date,
        securityId,
        fundingAccountId,
        quantity,
        price,
        commission: 0,
      } as any),
    );

  it("two buys of 0.00005 hold 0.0001", async () => {
    await trade(InvestmentAction.BUY, 0.00005, 60000, "2026-01-10");
    await trade(InvestmentAction.BUY, 0.00005, 60000, "2026-01-11");

    const holding = await dataSource.manager.findOne(Holding, {
      where: { accountId: brokerageAccountId, securityId },
    });
    expect(Number(holding?.quantity)).toBeCloseTo(0.0001, 8);
    expect(Number(holding?.averageCost)).toBeCloseTo(60000, 6);
  });
});
