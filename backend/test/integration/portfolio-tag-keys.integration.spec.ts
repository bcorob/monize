import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { SecuritiesModule } from "@/securities/securities.module";
import { PortfolioService } from "@/securities/portfolio.service";
import { portfolioSummaryMemo } from "@/securities/portfolio-summary-memo";
import {
  AccountSubType,
  AccountType,
} from "@/accounts/entities/account.entity";
import { withUserContext } from "@/common/db/with-context";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * `GET /portfolio/tag-keys` used to value the whole portfolio and read the tag
 * names off the allocation it produced -- 2868 ms of a 6.8 s page open for a
 * list of strings. It now asks the database which tags the held securities
 * carry.
 *
 * The unit spec can only assert the text of the statement, because the
 * `|quantity| >= 0.0001` predicate that decides "held" is evaluated by
 * PostgreSQL. Here it is evaluated for real, against the two fixtures that
 * decide whether the answer is the same as before: a security sold out of the
 * scope whose tag must NOT appear, and an untagged holding that must not invent
 * one.
 */
describe("portfolio tag keys without a valuation (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let portfolio: PortfolioService;
  let userId: string;
  let brokerageId: string;

  beforeAll(async () => {
    module = await createIntegrationModule([SecuritiesModule]);
    dataSource = module.get(DataSource);
    portfolio = module.get(PortfolioService);
  });

  afterAll(async () => {
    await module.close();
  });

  const seedSecurity = async (symbol: string): Promise<string> => {
    const [row] = await dataSource.query(
      `INSERT INTO securities (user_id, symbol, name, currency_code, skip_price_updates)
       VALUES ($1, $2, $2, 'USD', true) RETURNING id`,
      [userId, symbol],
    );
    return row.id;
  };

  const seedTag = async (name: string): Promise<string> => {
    const [row] = await dataSource.query(
      `INSERT INTO tags (user_id, name) VALUES ($1, $2) RETURNING id`,
      [userId, name],
    );
    return row.id;
  };

  const tagSecurity = async (
    securityId: string,
    tagId: string,
  ): Promise<void> => {
    await dataSource.query(
      `INSERT INTO security_tags (security_id, tag_id) VALUES ($1, $2)`,
      [securityId, tagId],
    );
  };

  const seedHolding = async (
    securityId: string,
    quantity: number,
  ): Promise<void> => {
    await dataSource.query(
      `INSERT INTO holdings (account_id, security_id, quantity, average_cost)
       VALUES ($1, $2, $3, 10)`,
      [brokerageId, securityId, quantity],
    );
  };

  beforeEach(async () => {
    portfolioSummaryMemo.clearAll();
    await cleanTables(dataSource, [
      "security_tags",
      "tags",
      "holdings",
      "investment_transactions",
      "security_prices",
      "securities",
      "accounts",
      "users",
    ]);
    const user = await createTestUserDirect(dataSource);
    userId = user.id;
    const brokerage = await createTestAccount(dataSource, userId, {
      name: "Brokerage",
      accountType: AccountType.INVESTMENT,
      accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
      currencyCode: "USD",
      openingBalance: 0,
      currentBalance: 0,
    } as never);
    brokerageId = brokerage.id;
  });

  const tagSummary = () =>
    withUserContext(userId, () => portfolio.getPortfolioTagSummary(userId));

  it("lists the keys of the held securities' tags and ignores a sold-out one", async () => {
    const held = await seedSecurity("AAA");
    const soldOut = await seedSecurity("BBB");
    await seedHolding(held, 10);
    // Sold out of every account in the scope: the row survives with a zero
    // quantity, and its tag must not reach the answer.
    await seedHolding(soldOut, 0);

    await tagSecurity(held, await seedTag("country:canada"));
    await tagSecurity(held, await seedTag("Core"));
    await tagSecurity(soldOut, await seedTag("sector:energy"));

    await expect(tagSummary()).resolves.toEqual({
      keys: ["country"],
      hasTaggedHoldings: true,
    });
  });

  it("reports no tags for an untagged holding", async () => {
    await seedHolding(await seedSecurity("CCC"), 5);

    await expect(tagSummary()).resolves.toEqual({
      keys: [],
      hasTaggedHoldings: false,
    });
  });

  it("does not value the portfolio to answer", async () => {
    const held = await seedSecurity("DDD");
    await seedHolding(held, 3);
    await tagSecurity(held, await seedTag("sector:tech"));
    const summarySpy = jest.spyOn(portfolio, "getPortfolioSummary");

    await expect(tagSummary()).resolves.toEqual({
      keys: ["sector"],
      hasTaggedHoldings: true,
    });
    // No price row exists for the holding, so the valuation-based path would
    // have dropped the slice and returned no keys at all.
    expect(summarySpy).not.toHaveBeenCalled();
    summarySpy.mockRestore();
  });
});
