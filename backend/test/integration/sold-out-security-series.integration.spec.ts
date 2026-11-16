import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { NetWorthModule } from "@/net-worth/net-worth.module";
import { NetWorthService } from "@/net-worth/net-worth.service";
import {
  AccountSubType,
  AccountType,
} from "@/accounts/entities/account.entity";
import { Security } from "@/securities/entities/security.entity";
import { SecurityPrice } from "@/securities/entities/security-price.entity";
import {
  InvestmentAction,
  InvestmentTransaction,
} from "@/securities/entities/investment-transaction.entity";
import { TransactionStatus } from "@/transactions/entities/transaction-status.enum";
import { withUserContext } from "@/common/db/with-context";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * The reporter's scenario for #1389: a security bought, held, and sold out
 * completely, then a different one bought. "Portfolio value over time" read ~0
 * over the first security's whole holding period, as if the series were a
 * backcast of what is held today.
 *
 * The replay is the thing under test and the real SQL is the point: the unit
 * spec mocks `manager.query`, so it can only assert the text of the statements
 * the service sends. Here PostgreSQL answers them, so what the ledger replay,
 * the stored-price loader and the transaction-price fallback actually produce
 * for a position that no longer exists is observable.
 */
describe("sold-out securities in the daily investment series (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let netWorth: NetWorthService;
  let userId: string;
  let brokerageId: string;
  let securityA: Security;
  let securityB: Security;

  const START = "2026-01-01";
  const END = "2026-03-10";
  const BUY_A = "2026-01-05";
  const SELL_A = "2026-02-10";
  const BUY_B = "2026-03-05";

  beforeAll(async () => {
    module = await createIntegrationModule([NetWorthModule]);
    dataSource = module.get(DataSource);
    netWorth = module.get(NetWorthService);
  });

  afterAll(async () => {
    await module.close();
  });

  const point = <T extends { date: string }>(series: T[], date: string): T => {
    const found = series.find((p) => p.date === date);
    if (!found) throw new Error(`no series point for ${date}`);
    return found;
  };

  const storePrice = async (
    securityId: string,
    priceDate: string,
    close: number,
  ) => {
    await dataSource.manager.save(
      dataSource.manager.create(SecurityPrice, {
        securityId,
        priceDate,
        closePrice: close,
        source: "manual",
      } as never),
    );
  };

  const trade = async (
    securityId: string,
    action: InvestmentAction,
    transactionDate: string,
    quantity: number,
    price: number | null,
  ) => {
    await dataSource.manager.save(
      dataSource.manager.create(InvestmentTransaction, {
        userId,
        accountId: brokerageId,
        securityId,
        action,
        transactionDate,
        quantity,
        price,
        commission: 0,
        totalAmount: price === null ? 0 : quantity * price,
        exchangeRate: 1,
        status: TransactionStatus.UNRECONCILED,
      } as never),
    );
  };

  beforeEach(async () => {
    await cleanTables(dataSource, [
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

    securityA = await dataSource.manager.save(
      dataSource.manager.create(Security, {
        userId,
        symbol: "AAA",
        name: "Alpha Fund",
        currencyCode: "USD",
        isActive: true,
      } as never),
    );
    securityB = await dataSource.manager.save(
      dataSource.manager.create(Security, {
        userId,
        symbol: "BBB",
        name: "Beta Fund",
        currencyCode: "USD",
        isActive: true,
      } as never),
    );
  });

  const series = () =>
    withUserContext(userId, () =>
      netWorth.getDailyInvestments(userId, START, END, [brokerageId], "USD"),
    );

  it("values a fully sold security while it was held, with stored closes", async () => {
    await trade(securityA.id, InvestmentAction.BUY, BUY_A, 10, 100);
    await trade(securityA.id, InvestmentAction.SELL, SELL_A, 10, 110);
    await trade(securityB.id, InvestmentAction.BUY, BUY_B, 5, 200);
    await storePrice(securityA.id, BUY_A, 100);
    await storePrice(securityA.id, "2026-01-20", 105);
    await storePrice(securityA.id, SELL_A, 110);
    await storePrice(securityB.id, BUY_B, 200);
    await storePrice(securityB.id, "2026-03-09", 210);

    const points = await series();

    expect(point(points, "2026-01-04").value).toBe(0);
    expect(point(points, BUY_A).value).toBe(1000);
    expect(point(points, "2026-01-20").value).toBe(1050);
    expect(point(points, "2026-02-09").value).toBe(1050);
    // Sold out: the position leaves the portfolio, so zero is the measured
    // answer for the days after the sale, not a missing price.
    expect(point(points, SELL_A).value).toBe(0);
    expect(point(points, "2026-03-04").value).toBe(0);
    expect(point(points, BUY_B).value).toBe(1000);
    expect(point(points, "2026-03-09").value).toBe(1050);
    expect(points.every((p) => p.pricesComplete)).toBe(true);
    expect(points.every((p) => p.unpricedSecurityIds.length === 0)).toBe(true);
  });

  it("values a sold-out security from its transaction price when no close is stored", async () => {
    await trade(securityA.id, InvestmentAction.BUY, BUY_A, 10, 100);
    await trade(securityA.id, InvestmentAction.SELL, SELL_A, 10, 110);
    await trade(securityB.id, InvestmentAction.BUY, BUY_B, 5, 200);

    const points = await series();

    expect(point(points, BUY_A).value).toBe(1000);
    expect(point(points, "2026-01-20").value).toBe(1000);
    expect(point(points, "2026-02-09").value).toBe(1000);
    expect(point(points, BUY_B).value).toBe(1000);
    expect(points.every((p) => p.pricesComplete)).toBe(true);
  });

  it("flags the holding period when nothing can price the sold-out security", async () => {
    await trade(securityA.id, InvestmentAction.BUY, BUY_A, 10, null);
    await trade(securityA.id, InvestmentAction.SELL, SELL_A, 10, null);
    await trade(securityB.id, InvestmentAction.BUY, BUY_B, 5, 200);

    const points = await series();

    const held = point(points, "2026-01-20");
    expect(held.pricesComplete).toBe(false);
    expect(held.unpricedSecurityIds).toEqual([securityA.id]);
    // Before the buy and after the sale A is not held, so nothing is missing.
    expect(point(points, "2026-01-04").pricesComplete).toBe(true);
    expect(point(points, SELL_A).pricesComplete).toBe(true);
    expect(point(points, BUY_B).pricesComplete).toBe(true);

    // The mechanism behind the reported zeros: `value` is the subtotal of what
    // WAS priced, so a held-but-unpriced position leaves a point that reads as
    // a measured zero to anything that does not check the flag first.
    expect(held.value).toBe(0);
  });

  it("withholds an unconvertible holding from the subtotal and names the pair", async () => {
    await trade(securityA.id, InvestmentAction.BUY, BUY_A, 10, 100);
    await trade(securityA.id, InvestmentAction.SELL, SELL_A, 10, 110);
    await storePrice(securityA.id, BUY_A, 100);

    // No USD->PLN rate exists anywhere, so the holding converts to nothing.
    const points = await withUserContext(userId, () =>
      netWorth.getDailyInvestments(userId, START, END, [brokerageId], "PLN"),
    );

    const held = point(points, "2026-01-20");
    expect(held.fxComplete).toBe(false);
    expect(held.missingRatePairs).toEqual(["USD->PLN"]);
    // Priced, but unconvertible: the same zero-looking point, a different repair.
    expect(held.pricesComplete).toBe(true);
    expect(held.value).toBe(0);
  });
});
