import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { InvestmentTransactionsService } from "@/securities/investment-transactions.service";
import { PortfolioCalculationService } from "@/securities/portfolio-calculation.service";
import { SecuritiesModule } from "@/securities/securities.module";
import { SecuritiesService } from "@/securities/securities.service";
import { HoldingsService } from "@/securities/holdings.service";
import {
  Account,
  AccountSubType,
  AccountType,
} from "@/accounts/entities/account.entity";
import {
  InvestmentTransaction,
  InvestmentAction,
} from "@/securities/entities/investment-transaction.entity";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { withUserContext } from "@/common/db/with-context";
import { createTestAccount } from "../helpers/test-factories";

/**
 * A26-M22 and A26-M21: what a security transfer carries is the basis the
 * source position held at the transfer's own date, read from the ledger under
 * the lock -- not today's stored average, and not a figure the client sends --
 * and every replay (holdings, realized gains, capital gains, cost-basis lots)
 * gives a transferred-in lot that same basis in the holding account's currency.
 */
describe("Security transfer basis (integration)", () => {
  let module: TestingModule;
  let service: InvestmentTransactionsService;
  let holdingsService: HoldingsService;
  let portfolioCalculation: PortfolioCalculationService;
  let dataSource: DataSource;
  let userId: string;
  let brokerageA: string;
  let brokerageB: string;
  let securityId: string;

  const holdingOf = (accountId: string) =>
    withUserContext(userId, () =>
      holdingsService.findByAccountAndSecurity(accountId, securityId),
    );

  const makeBrokerage = async (name: string) => {
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
  };

  const buy = (
    accountId: string,
    transactionDate: string,
    quantity: number,
    price: number,
    exchangeRate?: number,
  ) =>
    withUserContext(userId, () =>
      service.create(userId, {
        accountId,
        action: InvestmentAction.BUY,
        transactionDate,
        securityId,
        quantity,
        price,
        commission: 0,
        ...(exchangeRate === undefined ? {} : { exchangeRate }),
      } as any),
    );

  const transfer = (transactionDate: string, quantity: number) =>
    withUserContext(userId, () =>
      service.transferSecurity(userId, {
        fromAccountId: brokerageA,
        toAccountId: brokerageB,
        securityId,
        transactionDate,
        quantity,
        costPerShare: 1,
      }),
    );

  beforeAll(async () => {
    module = await createIntegrationModule([SecuritiesModule]);
    service = module.get(InvestmentTransactionsService);
    holdingsService = module.get(HoldingsService);
    portfolioCalculation = module.get(PortfolioCalculationService);
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
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES ('CAD', 'Canadian Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );

    const user = await createTestUserDirect(dataSource);
    userId = user.id;
    brokerageA = await makeBrokerage("Brokerage A");
    brokerageB = await makeBrokerage("Brokerage B");

    const securitiesService = module.get(SecuritiesService);
    const security = await withUserContext(userId, () =>
      securitiesService.create(userId, {
        symbol: "ACME",
        name: "Acme Corp",
        securityType: "STOCK" as any,
        currencyCode: "USD",
      } as any),
    );
    securityId = security.id;
  });

  describe("the basis is the source's at the transfer's date (A26-M22)", () => {
    /** BUY 10 @ 100 in January, BUY 10 @ 200 in March: stored average 150. */
    async function twoBuysThenBackDatedTransfer() {
      await buy(brokerageA, "2026-01-10", 10, 100);
      await buy(brokerageA, "2026-03-10", 10, 200);
      return transfer("2026-02-10", 10);
    }

    it("moves the 100 lot, not today's 150 average", async () => {
      const { transferOut, transferIn } = await twoBuysThenBackDatedTransfer();

      const a = await holdingOf(brokerageA);
      const b = await holdingOf(brokerageB);
      expect(Number(a?.quantity)).toBe(10);
      expect(Number(a?.averageCost)).toBeCloseTo(200, 6);
      expect(Number(b?.quantity)).toBe(10);
      expect(Number(b?.averageCost)).toBeCloseTo(100, 6);

      // 3,000 in total: the transfer neither creates nor destroys cost.
      const total =
        Number(a?.quantity) * Number(a?.averageCost) +
        Number(b?.quantity) * Number(b?.averageCost);
      expect(total).toBeCloseTo(3000, 4);

      // Both legs carry the same per-share figure.
      expect(Number(transferOut.price)).toBeCloseTo(100, 6);
      expect(Number(transferIn.price)).toBeCloseTo(100, 6);
    });

    it("follows the basis when the date is edited past both buys", async () => {
      const { transferOut } = await twoBuysThenBackDatedTransfer();

      await withUserContext(userId, () =>
        service.update(userId, transferOut.id, {
          transactionDate: "2026-03-20",
        }),
      );

      const a = await holdingOf(brokerageA);
      const b = await holdingOf(brokerageB);
      expect(Number(b?.quantity)).toBe(10);
      expect(Number(b?.averageCost)).toBeCloseTo(150, 6);
      expect(Number(a?.quantity)).toBe(10);
      expect(Number(a?.averageCost)).toBeCloseTo(150, 6);

      const legs = await dataSource.manager.find(InvestmentTransaction, {
        where: { userId },
      });
      for (const leg of legs.filter((l) => l.linkedTransactionId)) {
        expect(Number(leg.price)).toBeCloseTo(150, 6);
      }
    });

    it("ignores a price the client sends for a transfer leg", async () => {
      const { transferOut, transferIn } = await twoBuysThenBackDatedTransfer();

      await withUserContext(userId, () =>
        service.update(userId, transferOut.id, { price: 999 }),
      );
      await withUserContext(userId, () =>
        service.update(userId, transferIn.id, { price: 999 }),
      );

      const a = await holdingOf(brokerageA);
      const b = await holdingOf(brokerageB);
      expect(Number(a?.averageCost)).toBeCloseTo(200, 6);
      expect(Number(b?.averageCost)).toBeCloseTo(100, 6);

      const out = await dataSource.manager.findOneOrFail(
        InvestmentTransaction,
        {
          where: { id: transferOut.id },
        },
      );
      const into = await dataSource.manager.findOneOrFail(
        InvestmentTransaction,
        { where: { id: transferIn.id } },
      );
      expect(Number(out.price)).toBeCloseTo(100, 6);
      expect(Number(into.price)).toBeCloseTo(100, 6);
    });
  });

  describe("a transferred-in lot keeps its account-currency basis (A26-M21)", () => {
    async function cadAccountsUsdSecurityTransferredThenSold() {
      await dataSource.manager.update(Account, brokerageA, {
        currencyCode: "CAD",
      });
      await dataSource.manager.update(Account, brokerageB, {
        currencyCode: "CAD",
      });
      // 10 @ USD 100 at 1.37: CAD 1,370.00.
      await buy(brokerageA, "2026-01-10", 10, 100, 1.37);
      await transfer("2026-02-10", 10);
    }

    const sellInB = () =>
      withUserContext(userId, () =>
        service.create(userId, {
          accountId: brokerageB,
          action: InvestmentAction.SELL,
          transactionDate: "2026-03-10",
          securityId,
          quantity: 10,
          price: 140,
          commission: 0,
          exchangeRate: 1.37,
        } as any),
      );

    it("reports the sale against CAD 1,370, not the carried USD figure at rate 1", async () => {
      await cadAccountsUsdSecurityTransferredThenSold();

      const lots = await withUserContext(userId, () =>
        portfolioCalculation.calculateCostBasisLotsInAccountCurrency(userId, [
          brokerageA,
          brokerageB,
        ]),
      );
      expect(lots.get(`${brokerageB}:${securityId}`)?.costBasis).toBeCloseTo(
        1370,
        4,
      );

      await sellInB();

      const gains = await withUserContext(userId, () =>
        portfolioCalculation.calculateRealizedGains(userId, {}),
      );
      expect(gains).toHaveLength(1);
      // 10 x 140 x 1.37 = 1,918.00 of proceeds against 1,370.00 of cost.
      expect(gains[0].costBasis).toBeCloseTo(1370, 2);
      expect(gains[0].realizedGain).toBeCloseTo(548, 2);
    });

    it("keeps the carried basis when only the destination account is asked about", async () => {
      await cadAccountsUsdSecurityTransferredThenSold();
      await sellInB();

      const gains = await withUserContext(userId, () =>
        portfolioCalculation.calculateRealizedGains(userId, {
          accountIds: [brokerageB],
        }),
      );
      expect(gains).toHaveLength(1);
      expect(gains[0].accountId).toBe(brokerageB);
      expect(gains[0].realizedGain).toBeCloseTo(548, 2);
    });

    it("reports the same realized gain in the capital-gains-by-month replay", async () => {
      await cadAccountsUsdSecurityTransferredThenSold();
      await sellInB();

      for (const accountIds of [undefined, [brokerageB]]) {
        const entries = await withUserContext(userId, () =>
          portfolioCalculation.calculateCapitalGainsByMonth(userId, {
            startDate: "2026-01-01",
            endDate: "2026-04-30",
            ...(accountIds ? { accountIds } : {}),
          }),
        );
        const saleMonth = entries.find(
          (e) => e.accountId === brokerageB && e.month === "2026-03",
        );
        expect(saleMonth?.realizedGain).toBeCloseTo(548, 2);
        if (accountIds) {
          expect(entries.every((e) => e.accountId === brokerageB)).toBe(true);
        }
      }
    });
  });
});
