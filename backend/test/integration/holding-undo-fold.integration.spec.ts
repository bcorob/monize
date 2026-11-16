import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
// Import order matters: see the note at the top of
// holding-concurrent-trades.integration.spec.ts. InvestmentTransactionsService
// first, HoldingsService last.
import { InvestmentTransactionsService } from "@/securities/investment-transactions.service";
import { SecuritiesModule } from "@/securities/securities.module";
import { SecuritiesService } from "@/securities/securities.service";
import {
  ActionHistoryService,
  settlePendingHistoryWrites,
} from "@/action-history/action-history.service";
import {
  Account,
  AccountSubType,
  AccountType,
} from "@/accounts/entities/account.entity";
import { InvestmentAction } from "@/securities/entities/investment-transaction.entity";
import { HoldingsService } from "@/securities/holdings.service";
import { withScopedDb } from "@/common/db/scoped-db";
import { withUserContext } from "@/common/db/with-context";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * A26-L21 (A26-S12-10), INV-HOLDING-001 -- undo and redo re-derive a holding
 * through the same fold every other ledger write uses.
 *
 * The undo path kept its own copy of the fold: it read every non-VOID row, so
 * a DIVIDEND entered with a quantity added its total to the basis, and it
 * stored the average at 6 decimals where the canonical writers store the
 * column's 10. BUY 100 @ 10.00 and BUY 200 @ 11.00 (average 10.6666666667),
 * a DIVIDEND of 100 x 0.50, then any undo on the account: the copy stored
 * (3,200.00 + 50.00) / 300 = 10.833333, and the boot drift report flagged it.
 */
describe("undo re-derives holdings through the canonical fold (integration, A26-L21)", () => {
  let module: TestingModule;
  let investments: InvestmentTransactionsService;
  let history: ActionHistoryService;
  let holdings: HoldingsService;
  let dataSource: DataSource;
  let userId: string;
  let brokerageAccountId: string;
  let fundingAccountId: string;
  let securityId: string;

  beforeAll(async () => {
    module = await createIntegrationModule([SecuritiesModule]);
    investments = module.get(InvestmentTransactionsService);
    history = module.get(ActionHistoryService, { strict: false });
    holdings = module.get(HoldingsService, { strict: false });
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

  it("an undo after a DIVIDEND with a quantity stores the canonical average", async () => {
    await trade(InvestmentAction.BUY, 100, 10, "2026-01-10");
    await trade(InvestmentAction.BUY, 200, 11, "2026-01-11");
    await trade(InvestmentAction.DIVIDEND, 100, 0.5, "2026-01-12");
    // A share-only row, so its undo removes no cash row.
    await trade(InvestmentAction.ADD_SHARES, 1, 0, "2026-01-13");
    await settlePendingHistoryWrites();

    // Undoes the ADD_SHARES, which re-derives the account's holdings.
    await withUserContext(userId, () => history.undo(userId));

    const [row]: { quantity: string; average_cost: string }[] =
      await dataSource.query(
        `SELECT quantity, average_cost FROM holdings
          WHERE account_id = $1 AND security_id = $2`,
        [brokerageAccountId, securityId],
      );
    expect(Number(row.quantity)).toBe(300);
    expect(Number(row.average_cost)).toBeCloseTo(3200 / 300, 10);

    const drift = await withUserContext(userId, () =>
      withScopedDb(dataSource, (m) =>
        holdings.findLedgerDiscrepancies(userId, m, "2026-12-31"),
      ),
    );
    expect(drift).toEqual([]);
  });
});
