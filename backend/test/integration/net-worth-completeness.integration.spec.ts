import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { AccountsModule } from "@/accounts/accounts.module";
import { AccountsService } from "@/accounts/accounts.service";
import { NetWorthService } from "@/net-worth/net-worth.service";
import { withUserContext } from "@/common/db/with-context";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * The accounts summary and the LLM / MCP account shape against real PostgreSQL
 * (`docs/financial-calculation-contract.md` section 1, audit A26-S13-04).
 *
 * The user reports in USD. A USD chequing account holds 1,000.00 and an
 * account in a custom currency `ZZZ`, with no rate into USD, holds
 * 1,000,000.00. The monthly snapshot sums only what converted, so the latest
 * month is a subtotal of 1,000.00: reporting it as the net worth states a
 * figure short by the whole unconvertible account.
 */
describe("Net worth completeness (integration)", () => {
  jest.setTimeout(60000);

  let module: TestingModule;
  let dataSource: DataSource;
  let accounts: AccountsService;
  let netWorth: NetWorthService;
  let userId: string;

  beforeAll(async () => {
    module = await createIntegrationModule([AccountsModule]);
    dataSource = module.get(DataSource);
    accounts = module.get(AccountsService);
    netWorth = module.get(NetWorthService, { strict: false });
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "exchange_rates",
      "monthly_account_balances",
      "accounts",
      "user_preferences",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES
         ('USD', 'US Dollar', '$', 2),
         ('ZZZ', 'Unrated Test Currency', 'Z', 2)
       ON CONFLICT DO NOTHING`,
    );

    userId = (await createTestUserDirect(dataSource)).id;
    await dataSource.query(
      `INSERT INTO user_preferences (user_id, default_currency) VALUES ($1, 'USD')`,
      [userId],
    );
    await createTestAccount(dataSource, userId, {
      name: "Chequing USD",
      accountType: "CHEQUING",
      currencyCode: "USD",
      openingBalance: 1000,
      currentBalance: 1000,
    });
    await createTestAccount(dataSource, userId, {
      name: "Konto ZZZ",
      accountType: "CHEQUING",
      currencyCode: "ZZZ",
      openingBalance: 1000000,
      currentBalance: 1000000,
    });
    await withUserContext(userId, () =>
      netWorth.recalculateAllAccounts(userId),
    );
  });

  it("does not report a subtotal as net worth (financial contract section 1)", async () => {
    const summary = await withUserContext(userId, () =>
      accounts.getSummary(userId),
    );

    expect(summary.netWorth).toBeNull();
    expect(summary.totalAssets).toBeNull();
    // No liability is short of a rate, so liabilities are a total.
    expect(summary.totalLiabilities).toBe(0);
    expect(summary.knownNetWorthSubtotal).toBe(1000);
    expect(summary.knownAssetsSubtotal).toBe(1000);
    expect(summary.fxComplete).toBe(false);
    expect(summary.pricesComplete).toBe(true);
    expect(summary.valuationComplete).toBe(false);
    expect(summary.missingRatePairs).toEqual(["ZZZ->USD"]);
  });

  it("carries the same totals and flags in the LLM account shape", async () => {
    const llm = await withUserContext(userId, () =>
      accounts.getLlmAccounts(userId),
    );

    expect(llm.defaultCurrency).toBe("USD");
    expect(llm.netWorth).toBeNull();
    expect(llm.totalAssets).toBeNull();
    expect(llm.totalLiabilities).toBe(0);
    expect(llm.knownNetWorthSubtotal).toBe(1000);
    expect(llm.fxComplete).toBe(false);
    expect(llm.valuationComplete).toBe(false);
    expect(llm.missingRatePairs).toEqual(["ZZZ->USD"]);
    const zzz = llm.accounts.find((a) => a.name === "Konto ZZZ")!;
    expect(zzz.balance).toBe(1000000);
    expect(zzz.balanceInDefaultCurrency).toBeNull();
  });

  it("reports a complete net worth once the rate exists", async () => {
    // ZZZ->USD 0.001 is stored in the canonical orientation (USD sorts before
    // ZZZ), as `canonicalRateRow` writes it: USD->ZZZ 1000.
    await dataSource.query(
      `INSERT INTO exchange_rates (from_currency, to_currency, rate_date, rate, source)
       VALUES ('USD', 'ZZZ', CURRENT_DATE, 1000, 'test')`,
    );

    const summary = await withUserContext(userId, () =>
      accounts.getSummary(userId),
    );

    expect(summary.fxComplete).toBe(true);
    expect(summary.valuationComplete).toBe(true);
    expect(summary.missingRatePairs).toEqual([]);
    expect(summary.netWorth).toBe(2000);
    expect(summary.totalAssets).toBe(2000);
    expect(summary.knownNetWorthSubtotal).toBe(2000);
  });
});
