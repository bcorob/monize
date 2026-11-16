import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { TransactionAnalyticsService } from "@/transactions/transaction-analytics.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import {
  Transaction,
  TransactionStatus,
} from "@/transactions/entities/transaction.entity";
import { withUserContext } from "@/common/db/with-context";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
} from "../helpers/test-factories";

/**
 * The AI assistant's and the MCP server's transaction rollups against real
 * PostgreSQL (INV-FX-001, "convert before summing", audit A26-S17-01).
 *
 * The user reports in PLN. August holds 400.00 PLN of groceries; September
 * holds 4,000.00 PLN and 1,000.00 USD. With USD->PLN 3.65 the September figure
 * is 7,650.00 PLN and the change is +7,250.00 -- not 5,000.00 and +4,600.00,
 * which is what adding 1,000 USD to 4,000 PLN as bare numbers answered.
 *
 * The rate is stored in the canonical orientation (`PLN` sorts before `USD`),
 * the way `canonicalRateRow` writes it; the resolver reads either direction.
 */
describe("LLM analytics currency (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let service: TransactionAnalyticsService;

  let userId: string;
  let plnAccountId: string;
  let usdAccountId: string;
  let groceriesId: string;

  const AUG = { start: "2026-08-01", end: "2026-08-31" };
  const SEP = { start: "2026-09-01", end: "2026-09-30" };

  beforeAll(async () => {
    module = await createIntegrationModule([TransactionsModule]);
    dataSource = module.get(DataSource);
    service = module.get(TransactionAnalyticsService);
  });

  afterAll(async () => {
    await module.close();
  });

  async function insertTransaction(
    overrides: Partial<Transaction>,
  ): Promise<Transaction> {
    return dataSource.manager.save(
      dataSource.manager.create(Transaction, {
        userId,
        accountId: plnAccountId,
        categoryId: groceriesId,
        transactionDate: "2026-09-10",
        amount: -1,
        currencyCode: "PLN",
        status: TransactionStatus.UNRECONCILED,
        isTransfer: false,
        isSplit: false,
        ...overrides,
      } as Partial<Transaction>),
    );
  }

  async function insertUsdPlnRate(): Promise<void> {
    // PLN->USD 0.2739726027 is USD->PLN 3.65.
    await dataSource.query(
      `INSERT INTO exchange_rates (from_currency, to_currency, rate_date, rate, source)
       VALUES ('PLN', 'USD', '2026-09-12'::DATE, 0.2739726027, 'test')`,
    );
  }

  const compare = (direction?: "expenses" | "income" | "both") =>
    withUserContext(userId, () =>
      service.getLlmPeriodComparison(userId, {
        period1Start: AUG.start,
        period1End: AUG.end,
        period2Start: SEP.start,
        period2End: SEP.end,
        direction,
      }),
    );

  const list = (groupBy?: "category") =>
    withUserContext(userId, () =>
      service.getLlmListTransactions(userId, {
        startDate: SEP.start,
        endDate: SEP.end,
        groupBy,
      }),
    );

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "exchange_rates",
      "transaction_splits",
      "transactions",
      "accounts",
      "categories",
      "user_preferences",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES
         ('PLN', 'Polish Zloty', 'zl', 2),
         ('USD', 'US Dollar', '$', 2)
       ON CONFLICT DO NOTHING`,
    );

    userId = (await createTestUserDirect(dataSource)).id;
    await dataSource.query(
      `INSERT INTO user_preferences (user_id, default_currency) VALUES ($1, 'PLN')`,
      [userId],
    );
    plnAccountId = (
      await createTestAccount(dataSource, userId, {
        name: "Konto PLN",
        accountType: "CHEQUING",
        currencyCode: "PLN",
      })
    ).id;
    usdAccountId = (
      await createTestAccount(dataSource, userId, {
        name: "Konto USD",
        accountType: "CHEQUING",
        currencyCode: "USD",
      })
    ).id;
    groceriesId = (
      await createTestCategory(dataSource, userId, { name: "Groceries" })
    ).id;

    await insertTransaction({ amount: -400, transactionDate: "2026-08-10" });
    await insertTransaction({ amount: -4000, transactionDate: "2026-09-10" });
    await insertTransaction({
      accountId: usdAccountId,
      currencyCode: "USD",
      amount: -1000,
      transactionDate: "2026-09-15",
    });
  });

  describe("with USD->PLN 3.65 stored", () => {
    beforeEach(insertUsdPlnRate);

    it("compares two periods in one currency", async () => {
      const result = await compare();

      expect(result.totalsCurrency).toBe("PLN");
      expect(result.fxComplete).toBe(true);
      expect(result.missingRatePairs).toEqual([]);
      expect(result.period1.total).toBe(400);
      expect(result.period2.total).toBe(7650);
      expect(result.totalChange).toBe(7250);
      expect(result.totalChangePercent).toBe(1812.5);
      expect(result.comparison).toHaveLength(1);
      expect(result.comparison[0]).toMatchObject({
        label: "Groceries",
        period1Amount: 400,
        period2Amount: 7650,
        change: 7250,
      });
    });

    it("nets a refund in the same category (a category's cost is its signed sum)", async () => {
      await insertTransaction({ amount: 500, transactionDate: "2026-09-20" });

      const result = await compare();

      expect(result.period2.total).toBe(7150);
      expect(result.totalChange).toBe(6750);
    });

    it("lists transactions with totals in the reporting currency", async () => {
      const result = await list();

      expect(result.totalsCurrency).toBe("PLN");
      expect(result.fxComplete).toBe(true);
      expect(result.missingRatePairs).toEqual([]);
      expect(result.totalExpenses).toBe(7650);
      expect(result.totalIncome).toBe(0);
      expect(result.netCashFlow).toBe(-7650);
      expect(result.transactionCount).toBe(2);
      // The unconverted view stays available, labelled by currency.
      expect(result.byCurrency?.PLN.totalExpenses).toBe(4000);
      expect(result.byCurrency?.USD.totalExpenses).toBe(1000);
    });

    it("converts each group of a breakdown", async () => {
      const result = await list("category");

      expect(result.breakdown).toEqual([
        expect.objectContaining({ category: "Groceries", total: 7650 }),
      ]);
    });
  });

  describe("with no USD->PLN rate", () => {
    it("withholds the period totals and names the pair", async () => {
      const result = await compare();

      expect(result.totalsCurrency).toBe("PLN");
      expect(result.fxComplete).toBe(false);
      expect(result.missingRatePairs).toEqual(["USD->PLN"]);
      expect(result.period1.total).toBe(400);
      expect(result.period2.total).toBeNull();
      expect(result.period2.knownSubtotal).toBe(4000);
      expect(result.totalChange).toBeNull();
      expect(result.totalChangePercent).toBeNull();
    });

    it("withholds the list totals and keeps the converted part", async () => {
      const result = await list();

      expect(result.fxComplete).toBe(false);
      expect(result.missingRatePairs).toEqual(["USD->PLN"]);
      expect(result.totalExpenses).toBeNull();
      expect(result.totalIncome).toBeNull();
      expect(result.netCashFlow).toBeNull();
      expect(result.knownExpensesSubtotal).toBe(4000);
      expect(result.transactionCount).toBe(2);
      expect(result.byCurrency?.USD.totalExpenses).toBe(1000);
    });
  });
});
