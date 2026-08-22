import * as fs from "fs";
import * as path from "path";
import { NetWorthService } from "./net-worth.service";
import { MonthlyAccountBalance } from "./entities/monthly-account-balance.entity";
import {
  Account,
  AccountType,
  AccountSubType,
} from "../accounts/entities/account.entity";
import {
  InvestmentTransaction,
  InvestmentAction,
} from "../securities/entities/investment-transaction.entity";
import { SecurityPrice } from "../securities/entities/security-price.entity";
import { Security } from "../securities/entities/security.entity";
import { ExchangeRate } from "../currencies/entities/exchange-rate.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import {
  createScopedDbMocks,
  DataSourceMock,
} from "../test-helpers/scoped-db-testing";
import { lockAccountsForBalanceWrite } from "../common/db/locks";

jest.mock("../common/db/scoped-db", () => {
  const helpers = jest.requireActual("../test-helpers/scoped-db-testing");
  return {
    ...helpers.scopedDbMockModule(),
    // triggerDebouncedRecalc schedules its timer through this; in unit tests
    // there is no ambient manager to escape, so it just runs the callback.
    runOutsideActiveScopedManager: (fn: () => unknown) => fn(),
  };
});

// The real lock issues a `SELECT ... FOR UPDATE` through the manager, which the
// query router below would route to `reportQuery` and shift every assertion.
// See test-helpers/locks-testing.
jest.mock("../common/db/locks", () =>
  jest.requireActual("../test-helpers/locks-testing").locksMockModule(),
);

const lockAccounts = lockAccountsForBalanceWrite as jest.MockedFunction<
  typeof lockAccountsForBalanceWrite
>;

describe("NetWorthService", () => {
  let service: NetWorthService;
  let mabRepository: Record<string, jest.Mock>;
  let accountRepository: Record<string, jest.Mock>;
  let invTxRepository: Record<string, jest.Mock>;
  let priceRepository: Record<string, jest.Mock>;
  let securityRepository: Record<string, jest.Mock>;
  let rateRepository: Record<string, jest.Mock>;
  let prefRepository: Record<string, jest.Mock>;
  let dataSource: DataSourceMock;
  // Both the reporting reads and the snapshot delete+insert block now run
  // through the scoped transaction's `manager.query`. Routing them to two
  // mocks by statement keeps each test's read fixtures independent of the
  // write assertions -- the split the spec had when reads used
  // `reportQuery` and writes used `queryRunner.query`.
  let reportQuery: jest.Mock;
  let snapshotQuery: jest.Mock;

  /**
   * How many snapshot rebuild blocks ran. Each recalculated account issues
   * exactly one `DELETE FROM monthly_account_balances` to open its rebuild, so
   * counting those replaces the old `createQueryRunner` call count.
   */
  const snapshotWriteBlocks = (): number =>
    snapshotQuery.mock.calls.filter(([sql]: [string]) =>
      /^\s*DELETE/i.test(sql),
    ).length;

  const mockRegularAccount: Account = {
    id: "account-1",
    userId: "user-1",
    name: "Checking",
    accountType: AccountType.CHEQUING,
    accountSubType: null,
    currencyCode: "USD",
    openingBalance: 1000,
    currentBalance: 1500,
    isClosed: false,
    closedDate: null,
    linkedAccountId: null,
    linkedAccount: null,
    linkedLoanAccountId: null,
    linkedLoanAccount: null,
    description: null,
    accountNumber: null,
    institution: null,
    institutionId: null,
    institutionRef: null,
    creditLimit: null,
    interestRate: null,
    isFavourite: false,
    favouriteSortOrder: 0,
    excludeFromNetWorth: false,
    statementDueDay: null,
    statementSettlementDay: null,
    paymentAmount: null,
    extraPaymentAmount: null,
    paymentFrequency: null,
    paymentStartDate: null,
    sourceAccountId: null,
    sourceAccount: null,
    principalCategoryId: null,
    principalCategory: null,
    interestCategoryId: null,
    interestCategory: null,
    interestBookingMode: "AUTO",
    overpaymentCategoryId: null,
    overpaymentCategory: null,
    overpaymentMemo: null,
    overpaymentPayeeId: null,
    overpaymentPayee: null,
    fxFeePercent: null,
    assetCategoryId: null,
    assetCategory: null,
    dateAcquired: null,
    isCanadianMortgage: false,
    isVariableRate: false,
    termMonths: null,
    termEndDate: null,
    amortizationMonths: null,
    originalPrincipal: null,
    scheduledTransactionId: null,
    scheduledTransaction: null,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    transactions: [],
  } as Account;

  const mockBrokerageAccount: Account = {
    ...mockRegularAccount,
    id: "brokerage-1",
    name: "Brokerage",
    accountType: AccountType.INVESTMENT,
    accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
    openingBalance: 0,
  };

  const mockCreditCardAccount: Account = {
    ...mockRegularAccount,
    id: "cc-1",
    name: "Credit Card",
    accountType: AccountType.CREDIT_CARD,
    currentBalance: -500,
  };

  const mockAssetAccount: Account = {
    ...mockRegularAccount,
    id: "asset-1",
    name: "House",
    accountType: AccountType.ASSET,
    dateAcquired: new Date("2023-06-15"),
  };

  beforeEach(async () => {
    // Module-level mock, so it survives between tests unless reset.
    lockAccounts.mockReset();
    lockAccounts.mockResolvedValue(undefined);

    mabRepository = {
      count: jest.fn().mockResolvedValue(0),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn(),
    };

    accountRepository = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
    };

    invTxRepository = {
      find: jest.fn().mockResolvedValue([]),
    };

    priceRepository = {};

    securityRepository = {
      findByIds: jest.fn().mockResolvedValue([]),
    };

    rateRepository = {};

    prefRepository = {
      findOne: jest.fn().mockResolvedValue(null),
    };

    reportQuery = jest.fn().mockResolvedValue([]);
    snapshotQuery = jest.fn().mockResolvedValue(undefined);

    const mocks = createScopedDbMocks([
      [MonthlyAccountBalance, mabRepository],
      [Account, accountRepository],
      [InvestmentTransaction, invTxRepository],
      [SecurityPrice, priceRepository],
      [Security, securityRepository],
      [ExchangeRate, rateRepository],
      [UserPreference, prefRepository],
    ]);
    dataSource = mocks.dataSource;
    mocks.manager.query.mockImplementation((sql: string, params?: unknown[]) =>
      /monthly_account_balances/.test(sql) && /^\s*(DELETE|INSERT)/i.test(sql)
        ? snapshotQuery(sql, params)
        : reportQuery(sql, params),
    );

    service = new NetWorthService(dataSource as never);
  });

  describe("recalculateAccount -- serialization", () => {
    it("locks the account before reading anything the snapshots derive from", async () => {
      // The regression: the monthly sums were read in one autocommit
      // transaction and written in another. Under READ COMMITTED those are two
      // statement snapshots, so a transaction committing between them produced
      // snapshots that did not include it -- permanently, until something else
      // triggered a recalc.
      const order: string[] = [];
      lockAccounts.mockImplementation(async () => {
        order.push("lock");
      });
      accountRepository.findOne.mockImplementation(async () => {
        order.push("read-account");
        return { ...mockRegularAccount };
      });
      reportQuery.mockImplementation(async () => {
        order.push("read-ledger");
        return [{ earliest: "2024-01-01" }];
      });
      snapshotQuery.mockImplementation(async () => {
        order.push("write");
      });

      await service.recalculateAccount("user-1", "acc-1");

      expect(order[0]).toBe("lock");
      expect(order.indexOf("read-ledger")).toBeGreaterThan(0);
      expect(order.indexOf("write")).toBeGreaterThan(
        order.indexOf("read-ledger"),
      );
      // Owner-scoped: the balance-write lock carries the caller's userId so it
      // can never land on an account that is not theirs (maintainer review,
      // PR #1095).
      expect(lockAccounts).toHaveBeenCalledWith(
        expect.anything(),
        ["acc-1"],
        "user-1",
      );
    });
  });

  describe("sweepStaleSnapshots", () => {
    // withUserContext validates the id, so the sweep's rows carry real UUIDs --
    // a garbage owner id would raise 22P02 on every policied statement under
    // enforcement, which is why it is checked at the wrap site.
    const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    /** The sweep's discovery query, distinguished from the recalc's own reads. */
    function serveStale(rows: Array<{ user_id: string; account_id: string }>) {
      reportQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("JOIN (")) return rows;
        if (sql.includes("MIN(transaction_date)")) {
          return [{ earliest: "2024-01-01" }];
        }
        return [{ month: "2024-01-01", balance: 1000 }];
      });
    }

    it("finds accounts whose snapshots fell behind their own row", async () => {
      // The durability answer for a debounce timer that lives in process memory:
      // derive the staleness from the data, because the crash that loses the
      // timer would lose a queue entry just as easily (DR-04-03).
      serveStale([]);

      await service.sweepStaleSnapshots();

      const [sql, params] = reportQuery.mock.calls[0];
      expect(sql).toContain("FROM accounts");
      expect(sql).toContain("MAX(updated_at)");
      // The change is newer than the snapshot AND older than the grace measured
      // from NOW() -- not a distance from the old snapshot, which would never
      // recover a change made within the grace of its snapshot (MZ-1242-R5).
      expect(sql).toContain("a.updated_at > s.computed_at");
      expect(sql).toContain("a.updated_at <= NOW() -");
      expect(sql).not.toMatch(/s\.computed_at\s*\+/);
      // Bounded, so a broken deployment cannot exhaust the pool in one pass.
      expect(sql).toContain("LIMIT $2");
      expect(params[1]).toBeGreaterThan(0);
    });

    it("recomputes each stale account as its owner", async () => {
      serveStale([
        { user_id: ownerA, account_id: "acc-1" },
        { user_id: ownerB, account_id: "acc-2" },
      ]);
      accountRepository.findOne.mockImplementation(
        async ({ where }: { where: { id: string } }) => ({
          ...mockRegularAccount,
          id: where.id,
        }),
      );

      await service.sweepStaleSnapshots();

      expect(lockAccounts.mock.calls.map((call) => call[1])).toEqual([
        ["acc-1"],
        ["acc-2"],
      ]);
    });

    it("keeps going when one account's recompute fails", async () => {
      serveStale([
        { user_id: ownerA, account_id: "acc-1" },
        { user_id: ownerA, account_id: "acc-2" },
      ]);
      accountRepository.findOne.mockImplementation(
        async ({ where }: { where: { id: string } }) => {
          if (where.id === "acc-1") throw new Error("DB down");
          return { ...mockRegularAccount, id: where.id };
        },
      );

      await expect(service.sweepStaleSnapshots()).resolves.toBeUndefined();
      expect(snapshotWriteBlocks()).toBe(1);
    });

    it("does nothing when every snapshot is current", async () => {
      serveStale([]);

      await service.sweepStaleSnapshots();

      expect(lockAccounts).not.toHaveBeenCalled();
      expect(snapshotWriteBlocks()).toBe(0);
    });

    it("does not throw when its own discovery query fails", async () => {
      // A cron handler that rejects takes the process down with an unhandled
      // rejection.
      reportQuery.mockRejectedValue(new Error("DB down"));

      await expect(service.sweepStaleSnapshots()).resolves.toBeUndefined();
    });
  });

  describe("recalculateAccount", () => {
    it("returns early when account is not found", async () => {
      accountRepository.findOne.mockResolvedValue(null);

      await service.recalculateAccount("user-1", "nonexistent");

      expect(reportQuery).not.toHaveBeenCalled();
      expect(snapshotWriteBlocks()).toBe(0);
    });

    it("delegates to recalculateRegularAccount for non-brokerage accounts", async () => {
      accountRepository.findOne.mockResolvedValue({ ...mockRegularAccount });
      reportQuery
        .mockResolvedValueOnce([{ earliest: "2024-01-15" }])
        .mockResolvedValueOnce([{ month: "2024-01-01", balance: 1000 }]);

      await service.recalculateAccount("user-1", "account-1");

      expect(dataSource.transaction).toHaveBeenCalled();
      expect(snapshotWriteBlocks()).toBe(1);
    });

    it("delegates to recalculateBrokerageAccount for brokerage accounts", async () => {
      accountRepository.findOne.mockResolvedValue({ ...mockBrokerageAccount });
      // earliest regular tx
      reportQuery
        .mockResolvedValueOnce([{ earliest: "2024-03-01" }])
        // earliest inv tx
        .mockResolvedValueOnce([{ inv_earliest: "2024-02-15" }])
        // cost rows
        .mockResolvedValueOnce([{ month: "2024-02-01", balance: 0 }]);

      invTxRepository.find.mockResolvedValue([]);

      await service.recalculateAccount("user-1", "brokerage-1");

      expect(dataSource.transaction).toHaveBeenCalled();
      expect(snapshotWriteBlocks()).toBe(1);
    });

    describe("regular account recalculation", () => {
      it("uses opening balance with cumulative transaction sums", async () => {
        accountRepository.findOne.mockResolvedValue({
          ...mockRegularAccount,
          openingBalance: 500,
        });
        reportQuery
          .mockResolvedValueOnce([{ earliest: "2024-01-10" }])
          .mockResolvedValueOnce([
            { month: "2024-01-01", balance: 600 },
            { month: "2024-02-01", balance: 800 },
          ]);

        await service.recalculateAccount("user-1", "account-1");

        // Verify delete old balances
        expect(snapshotQuery).toHaveBeenCalledWith(
          "DELETE FROM monthly_account_balances WHERE account_id = $1",
          ["account-1"],
        );
        // Verify insert for each month
        expect(snapshotQuery).toHaveBeenCalledTimes(3); // 1 delete + 2 inserts
      });

      it("uses createdAt as start date when no earliest transaction exists", async () => {
        const account = {
          ...mockRegularAccount,
          createdAt: new Date("2024-06-01"),
        };
        accountRepository.findOne.mockResolvedValue(account);
        reportQuery
          .mockResolvedValueOnce([{ earliest: null }])
          .mockResolvedValueOnce([{ month: "2024-06-01", balance: 1000 }]);

        await service.recalculateAccount("user-1", "account-1");

        // The second query (cost rows) should use account.createdAt substring as startDate
        const secondQueryCall = reportQuery.mock.calls[1];
        expect(secondQueryCall[1]).toContain("2024-06-01");
      });

      it("zeroes balance for ASSET months before dateAcquired", async () => {
        const assetAccount = {
          ...mockAssetAccount,
          openingBalance: 250000,
        };
        accountRepository.findOne.mockResolvedValue(assetAccount);
        reportQuery
          .mockResolvedValueOnce([{ earliest: "2023-01-01" }])
          .mockResolvedValueOnce([
            { month: "2023-01-01", balance: 250000 },
            { month: "2023-06-01", balance: 250000 },
            { month: "2023-07-01", balance: 250500 },
          ]);

        await service.recalculateAccount("user-1", "asset-1");

        const insertCalls = snapshotQuery.mock.calls.filter(
          (call: any[]) =>
            typeof call[0] === "string" && call[0].includes("INSERT"),
        );

        // Months before 2023-06 should have balance zeroed
        // 2023-01-01 -> monthYM "2023-01" < dateAcquiredYM "2023-06" => balance=0
        expect(insertCalls[0][1][3]).toBe(0);
        // 2023-06-01 -> monthYM "2023-06" === dateAcquiredYM "2023-06" => balance stays
        expect(insertCalls[1][1][3]).toBe(250000);
        // 2023-07-01 -> monthYM "2023-07" > "2023-06" => balance stays
        expect(insertCalls[2][1][3]).toBe(250500);
      });

      it("uses dateAcquired as start date for ASSET with no transactions", async () => {
        const assetAccount = {
          ...mockAssetAccount,
          dateAcquired: new Date("2023-06-15"),
        };
        accountRepository.findOne.mockResolvedValue(assetAccount);
        reportQuery
          .mockResolvedValueOnce([{ earliest: null }])
          .mockResolvedValueOnce([]);

        await service.recalculateAccount("user-1", "asset-1");

        const costQuery = reportQuery.mock.calls[1];
        expect(costQuery[1][2]).toBe("2023-06-15");
      });

      it("uses dateAcquired as start date for ASSET when it is earlier than first tx", async () => {
        const assetAccount = {
          ...mockAssetAccount,
          dateAcquired: new Date("2022-03-01"),
        };
        accountRepository.findOne.mockResolvedValue(assetAccount);
        reportQuery
          .mockResolvedValueOnce([{ earliest: "2023-01-01" }])
          .mockResolvedValueOnce([]);

        await service.recalculateAccount("user-1", "asset-1");

        // The startDate passed to the cost query should be the earlier dateAcquired
        const costQuery = reportQuery.mock.calls[1];
        expect(costQuery[1][2]).toBe("2022-03-01");
      });

      it("propagates a snapshot write failure out of the transaction", async () => {
        accountRepository.findOne.mockResolvedValue({ ...mockRegularAccount });
        reportQuery
          .mockResolvedValueOnce([{ earliest: "2024-01-01" }])
          .mockResolvedValueOnce([{ month: "2024-01-01", balance: 1000 }]);

        snapshotQuery
          .mockResolvedValueOnce(undefined) // DELETE succeeds
          .mockRejectedValueOnce(new Error("DB error")); // INSERT fails

        await expect(
          service.recalculateAccount("user-1", "account-1"),
        ).rejects.toThrow("DB error");

        // The delete+insert pair share one scoped transaction, which rolls
        // back when the callback throws.
        expect(dataSource.transaction).toHaveBeenCalled();
        expect(snapshotWriteBlocks()).toBe(1);
      });

      it("surfaces a failing DELETE instead of writing partial snapshots", async () => {
        accountRepository.findOne.mockResolvedValue({ ...mockRegularAccount });
        reportQuery
          .mockResolvedValueOnce([{ earliest: "2024-01-01" }])
          .mockResolvedValueOnce([{ month: "2024-01-01", balance: 1000 }]);

        snapshotQuery.mockRejectedValue(new Error("Fatal"));

        await expect(
          service.recalculateAccount("user-1", "account-1"),
        ).rejects.toThrow("Fatal");

        expect(snapshotQuery).toHaveBeenCalledTimes(1);
      });
    });

    describe("brokerage account recalculation", () => {
      it("computes market value from holdings and prices", async () => {
        accountRepository.findOne.mockResolvedValue({
          ...mockBrokerageAccount,
        });
        reportQuery
          .mockResolvedValueOnce([{ earliest: null }])
          .mockResolvedValueOnce([{ inv_earliest: "2024-01-15" }])
          .mockResolvedValueOnce([
            { month: "2024-01-01", balance: 0 },
            { month: "2024-02-01", balance: 0 },
          ])
          // loadSecurityPrices query
          .mockResolvedValueOnce([
            {
              security_id: "sec-1",
              price_date: "2024-01-20",
              close_price: 150,
            },
            {
              security_id: "sec-1",
              price_date: "2024-02-10",
              close_price: 160,
            },
          ]);

        const mockSecurity: Partial<Security> = {
          id: "sec-1",
          symbol: "AAPL",
          skipPriceUpdates: false,
        };

        invTxRepository.find.mockResolvedValue([
          {
            securityId: "sec-1",
            action: InvestmentAction.BUY,
            quantity: 10,
            transactionDate: "2024-01-15",
          },
        ]);
        securityRepository.findByIds.mockResolvedValue([mockSecurity]);

        await service.recalculateAccount("user-1", "brokerage-1");

        // Verify market_value was inserted
        const insertCalls = snapshotQuery.mock.calls.filter(
          (call: any[]) =>
            typeof call[0] === "string" && call[0].includes("INSERT"),
        );
        expect(insertCalls.length).toBe(2);
        // Month 2024-01: 10 shares * 150 = 1500
        expect(insertCalls[0][1][4]).toBe(1500);
        // Month 2024-02: 10 shares * 160 = 1600
        expect(insertCalls[1][1][4]).toBe(1600);
      });

      it("handles BUY, SELL, REINVEST, TRANSFER_IN, TRANSFER_OUT, SPLIT actions", async () => {
        accountRepository.findOne.mockResolvedValue({
          ...mockBrokerageAccount,
        });
        reportQuery
          .mockResolvedValueOnce([{ earliest: null }])
          .mockResolvedValueOnce([{ inv_earliest: "2024-01-01" }])
          .mockResolvedValueOnce([
            { month: "2024-01-01", balance: 0 },
            { month: "2024-02-01", balance: 0 },
            { month: "2024-03-01", balance: 0 },
          ])
          // market prices
          .mockResolvedValueOnce([
            {
              security_id: "sec-1",
              price_date: "2024-01-15",
              close_price: 100,
            },
            {
              security_id: "sec-1",
              price_date: "2024-02-15",
              close_price: 100,
            },
            {
              security_id: "sec-1",
              price_date: "2024-03-15",
              close_price: 100,
            },
          ]);

        const mockSecurity: Partial<Security> = {
          id: "sec-1",
          symbol: "TEST",
          skipPriceUpdates: false,
        };

        invTxRepository.find.mockResolvedValue([
          {
            securityId: "sec-1",
            action: InvestmentAction.BUY,
            quantity: 100,
            transactionDate: "2024-01-05",
          },
          {
            securityId: "sec-1",
            action: InvestmentAction.REINVEST,
            quantity: 5,
            transactionDate: "2024-01-20",
          },
          {
            securityId: "sec-1",
            action: InvestmentAction.SELL,
            quantity: 20,
            transactionDate: "2024-02-10",
          },
          {
            securityId: "sec-1",
            action: InvestmentAction.TRANSFER_IN,
            quantity: 10,
            transactionDate: "2024-02-15",
          },
          {
            securityId: "sec-1",
            action: InvestmentAction.TRANSFER_OUT,
            quantity: 5,
            transactionDate: "2024-03-01",
          },
          {
            securityId: "sec-1",
            action: InvestmentAction.SPLIT,
            quantity: 2,
            transactionDate: "2024-03-05",
          },
        ]);
        securityRepository.findByIds.mockResolvedValue([mockSecurity]);

        await service.recalculateAccount("user-1", "brokerage-1");

        const insertCalls = snapshotQuery.mock.calls.filter(
          (call: any[]) =>
            typeof call[0] === "string" && call[0].includes("INSERT"),
        );
        // Month 1 (Jan): BUY 100 + REINVEST 5 = 105 shares * 100 = 10500
        expect(insertCalls[0][1][4]).toBe(10500);
        // Month 2 (Feb): 105 - SELL 20 + TRANSFER_IN 10 = 95 shares * 100 = 9500
        expect(insertCalls[1][1][4]).toBe(9500);
        // Month 3 (Mar): 95 - TRANSFER_OUT 5 = 90, then a 2-for-1 SPLIT
        // MULTIPLIES the position: 90 * 2 = 180 shares * 100 = 18000.
        //
        // This expectation previously read "+ SPLIT 90 = 180" with a fixture
        // quantity of 90 -- additive semantics that happened to land on the
        // same number, which is why the wrong reducer stayed green. A split's
        // quantity is a ratio (audit P5-011); under the old code a ratio of 2
        // here would have produced 92 shares and 9200.
        expect(insertCalls[2][1][4]).toBe(18000);
      });

      it("multiplies by the split ratio rather than adding it (P5-011)", async () => {
        // A separate case with a fixture that cannot be satisfied by both
        // readings: 10 shares and a 2-for-1 split is 20 shares (2000 at 100),
        // never 12 (1200).
        accountRepository.findOne.mockResolvedValue({
          ...mockBrokerageAccount,
        });
        reportQuery
          .mockResolvedValueOnce([{ earliest: null }])
          .mockResolvedValueOnce([{ inv_earliest: "2024-01-01" }])
          .mockResolvedValueOnce([{ month: "2024-01-01", balance: 0 }])
          .mockResolvedValueOnce([
            {
              security_id: "sec-1",
              price_date: "2024-01-15",
              close_price: 100,
            },
          ])
          .mockResolvedValue([]);

        const mockSecurity: Partial<Security> = {
          id: "sec-1",
          symbol: "TEST",
          skipPriceUpdates: false,
        };

        invTxRepository.find.mockResolvedValue([
          {
            securityId: "sec-1",
            action: InvestmentAction.BUY,
            quantity: 10,
            transactionDate: "2024-01-05",
          },
          {
            securityId: "sec-1",
            action: InvestmentAction.SPLIT,
            quantity: 2,
            transactionDate: "2024-01-10",
          },
        ]);
        securityRepository.findByIds.mockResolvedValue([mockSecurity]);

        await service.recalculateAccount("user-1", "brokerage-1");

        const insertCalls = snapshotQuery.mock.calls.filter(
          (call: any[]) =>
            typeof call[0] === "string" && call[0].includes("INSERT"),
        );
        expect(insertCalls[0][1][4]).toBe(2000);
      });

      it("includes ADD_SHARES and REMOVE_SHARES in the replay", async () => {
        // These two actions were absent from all three historical reducers, so
        // shares booked without a purchase never reached a net-worth chart at
        // all -- the position read as 0 while the holdings page showed 15.
        accountRepository.findOne.mockResolvedValue({
          ...mockBrokerageAccount,
        });
        reportQuery
          .mockResolvedValueOnce([{ earliest: null }])
          .mockResolvedValueOnce([{ inv_earliest: "2024-01-01" }])
          .mockResolvedValueOnce([{ month: "2024-01-01", balance: 0 }])
          .mockResolvedValueOnce([
            {
              security_id: "sec-1",
              price_date: "2024-01-15",
              close_price: 100,
            },
          ])
          .mockResolvedValue([]);

        const mockSecurity: Partial<Security> = {
          id: "sec-1",
          symbol: "TEST",
          skipPriceUpdates: false,
        };

        invTxRepository.find.mockResolvedValue([
          {
            securityId: "sec-1",
            action: InvestmentAction.ADD_SHARES,
            quantity: 20,
            transactionDate: "2024-01-05",
          },
          {
            securityId: "sec-1",
            action: InvestmentAction.REMOVE_SHARES,
            quantity: 5,
            transactionDate: "2024-01-06",
          },
        ]);
        securityRepository.findByIds.mockResolvedValue([mockSecurity]);

        await service.recalculateAccount("user-1", "brokerage-1");

        const insertCalls = snapshotQuery.mock.calls.filter(
          (call: any[]) =>
            typeof call[0] === "string" && call[0].includes("INSERT"),
        );
        expect(insertCalls[0][1][4]).toBe(1500);
      });

      // Issue #1242. The old test here asserted the opposite -- that a
      // skipPriceUpdates security was valued from its transaction price and the
      // accepted security_prices rows were ignored -- which encoded the bug as
      // expected behaviour. skipPriceUpdates governs external price FETCHING,
      // not which stored prices may value a position. The persisted monthly
      // market_value must use the latest accepted close in security_prices.
      it("values a skipPriceUpdates security from its accepted stored price, not its transaction price (#1242)", async () => {
        accountRepository.findOne.mockResolvedValue({
          ...mockBrokerageAccount,
        });
        reportQuery.mockImplementation(async (sql: string) => {
          if (/as earliest/.test(sql)) return [{ earliest: null }];
          if (/inv_earliest/.test(sql)) return [{ inv_earliest: "2026-08-01" }];
          if (/monthly_tx_sums/.test(sql))
            return [{ month: "2026-08-01", balance: -6660 }];
          if (/FROM security_prices/.test(sql))
            return [
              // A transaction-derived observation (source 'buy', $61) and a
              // later manual correction ($120), both accepted rows in
              // security_prices. The manual is the latest close on or before
              // month end, so it wins -- and the raw-transaction fallback is
              // never consulted because the store can answer.
              { security_id: "sec-1", price_date: "2026-08-01", close_price: "61" },
              {
                security_id: "sec-1",
                price_date: "2026-08-20",
                close_price: "120",
              },
            ];
          return [];
        });

        const skipSecurity: Partial<Security> = {
          id: "sec-1",
          symbol: "BMT-DEMO",
          skipPriceUpdates: true,
          currencyCode: "USD",
        };

        invTxRepository.find.mockResolvedValue([
          {
            securityId: "sec-1",
            action: InvestmentAction.BUY,
            quantity: 120,
            transactionDate: "2026-08-01",
          },
        ]);
        securityRepository.findByIds.mockResolvedValue([skipSecurity]);

        await service.recalculateAccount("user-1", "brokerage-1");

        const insertCalls = snapshotQuery.mock.calls.filter(
          (call: any[]) =>
            typeof call[0] === "string" && call[0].includes("INSERT"),
        );
        // 120 shares * $120 accepted close = $14,400. The pre-fix code valued
        // the skip security from its $61 transaction price -> $7,320.
        expect(insertCalls[insertCalls.length - 1][1][4]).toBe(14400);
      });

      // Issue #1242 legacy compatibility: a security with no security_prices
      // rows at all (e.g. a backup taken before transaction-derived prices were
      // written to security_prices, restored without a backfill) still values
      // from its raw investment_transactions prices. The flag under test is not
      // skipPriceUpdates -- this holds for any security absent from the store.
      it("falls back to raw transaction prices only when security_prices has no row (#1242 legacy)", async () => {
        accountRepository.findOne.mockResolvedValue({
          ...mockBrokerageAccount,
        });
        reportQuery.mockImplementation(async (sql: string) => {
          if (/as earliest/.test(sql)) return [{ earliest: null }];
          if (/inv_earliest/.test(sql)) return [{ inv_earliest: "2024-01-01" }];
          if (/monthly_tx_sums/.test(sql))
            return [{ month: "2024-01-01", balance: -1000 }];
          // No accepted stored prices for this security.
          if (/FROM security_prices/.test(sql)) return [];
          // Legacy transaction-derived fallback (loadTxPriceSeries).
          if (/investment_transactions/.test(sql) && /action = ANY/.test(sql))
            return [
              {
                security_id: "sec-legacy",
                transaction_date: "2024-01-10",
                price: "50",
              },
            ];
          return [];
        });

        const legacySecurity: Partial<Security> = {
          id: "sec-legacy",
          symbol: "PRIV",
          skipPriceUpdates: true,
          currencyCode: "USD",
        };
        invTxRepository.find.mockResolvedValue([
          {
            securityId: "sec-legacy",
            action: InvestmentAction.BUY,
            quantity: 20,
            transactionDate: "2024-01-05",
          },
        ]);
        securityRepository.findByIds.mockResolvedValue([legacySecurity]);

        await service.recalculateAccount("user-1", "brokerage-1");

        const insertCalls = snapshotQuery.mock.calls.filter(
          (call: any[]) =>
            typeof call[0] === "string" && call[0].includes("INSERT"),
        );
        // 20 shares * $50 transaction fallback = $1,000.
        expect(insertCalls[insertCalls.length - 1][1][4]).toBe(1000);
      });

      it("handles no investment transactions gracefully", async () => {
        accountRepository.findOne.mockResolvedValue({
          ...mockBrokerageAccount,
        });
        reportQuery
          .mockResolvedValueOnce([{ earliest: null }])
          .mockResolvedValueOnce([{ inv_earliest: null }])
          .mockResolvedValueOnce([{ month: "2024-01-01", balance: 0 }]);

        invTxRepository.find.mockResolvedValue([]);

        await service.recalculateAccount("user-1", "brokerage-1");

        // Market value should be 0 (null) when no holdings
        const insertCalls = snapshotQuery.mock.calls.filter(
          (call: any[]) =>
            typeof call[0] === "string" && call[0].includes("INSERT"),
        );
        expect(insertCalls[0][1][4]).toBe(0);
      });

      it("skips holdings with negligible quantity", async () => {
        accountRepository.findOne.mockResolvedValue({
          ...mockBrokerageAccount,
        });
        reportQuery
          .mockResolvedValueOnce([{ earliest: null }])
          .mockResolvedValueOnce([{ inv_earliest: "2024-01-01" }])
          .mockResolvedValueOnce([{ month: "2024-01-01", balance: 0 }])
          // market prices
          .mockResolvedValueOnce([
            {
              security_id: "sec-1",
              price_date: "2024-01-15",
              close_price: 100,
            },
          ]);

        const mockSecurity: Partial<Security> = {
          id: "sec-1",
          symbol: "TEST",
          skipPriceUpdates: false,
        };

        // Buy and immediately sell same quantity => qty ~ 0
        invTxRepository.find.mockResolvedValue([
          {
            securityId: "sec-1",
            action: InvestmentAction.BUY,
            quantity: 10,
            transactionDate: "2024-01-05",
          },
          {
            securityId: "sec-1",
            action: InvestmentAction.SELL,
            quantity: 10,
            transactionDate: "2024-01-10",
          },
        ]);
        securityRepository.findByIds.mockResolvedValue([mockSecurity]);

        await service.recalculateAccount("user-1", "brokerage-1");

        const insertCalls = snapshotQuery.mock.calls.filter(
          (call: any[]) =>
            typeof call[0] === "string" && call[0].includes("INSERT"),
        );
        // Market value should be 0 since qty is negligible
        expect(insertCalls[0][1][4]).toBe(0);
      });

      it("stores market value in account currency for USD security held in a CAD account", async () => {
        // Scenario: CAD brokerage holding 100 shares of a USD-denominated
        // security priced at $25.675 USD, with a USD->CAD rate of 1.35 at
        // month end. Stored market_value must be in CAD (account currency)
        // so that getMonthlyInvestments can correctly convert it to the
        // user's display currency.
        accountRepository.findOne.mockResolvedValue({
          ...mockBrokerageAccount,
          currencyCode: "CAD",
        });
        reportQuery
          .mockResolvedValueOnce([{ earliest: null }])
          .mockResolvedValueOnce([{ inv_earliest: "2025-02-01" }])
          .mockResolvedValueOnce([{ month: "2025-02-01", balance: 0 }])
          // loadStoredPriceSeries query
          .mockResolvedValueOnce([
            {
              security_id: "sec-usd",
              price_date: "2025-02-28",
              close_price: 25.675,
            },
          ])
          // loadTxPriceSeries fallback (no legacy transaction prices needed)
          .mockResolvedValueOnce([])
          // buildRateIndex query (USD -> CAD)
          .mockResolvedValueOnce([
            {
              from_currency: "USD",
              to_currency: "CAD",
              rate: "1.35",
              rate_date: "2025-02-28",
            },
          ]);

        invTxRepository.find.mockResolvedValue([
          {
            securityId: "sec-usd",
            action: InvestmentAction.BUY,
            quantity: 100,
            transactionDate: "2025-02-01",
          },
        ]);
        securityRepository.findByIds.mockResolvedValue([
          {
            id: "sec-usd",
            symbol: "FOO",
            skipPriceUpdates: false,
            currencyCode: "USD",
          } as Partial<Security>,
        ]);

        await service.recalculateAccount("user-1", "brokerage-1");

        const insertCalls = snapshotQuery.mock.calls.filter(
          (call: any[]) =>
            typeof call[0] === "string" && call[0].includes("INSERT"),
        );
        // 100 shares * $25.675 USD = $2,567.50 USD
        // $2,567.50 USD * 1.35 = $3,466.125 CAD
        expect(insertCalls[0][1][4]).toBeCloseTo(3466.125, 4);
      });

      it("rolls back on error during brokerage recalculation", async () => {
        accountRepository.findOne.mockResolvedValue({
          ...mockBrokerageAccount,
        });
        reportQuery
          .mockResolvedValueOnce([{ earliest: null }])
          .mockResolvedValueOnce([{ inv_earliest: null }])
          .mockResolvedValueOnce([{ month: "2024-01-01", balance: 0 }]);

        invTxRepository.find.mockResolvedValue([]);

        snapshotQuery
          .mockResolvedValueOnce(undefined) // DELETE succeeds
          .mockRejectedValueOnce(new Error("Insert failed")); // INSERT fails

        await expect(
          service.recalculateAccount("user-1", "brokerage-1"),
        ).rejects.toThrow("Insert failed");

        expect(dataSource.transaction).toHaveBeenCalled();
        expect(snapshotWriteBlocks()).toBe(1);
      });
    });
  });

  describe("recalculateAllAccounts", () => {
    /**
     * The per-account path re-reads the account inside its own locked
     * transaction, so `find` (the fan-out list) and `findOne` (the locked
     * re-read) both have to answer. Routing the second from the first keeps the
     * two consistent without each test restating the list.
     */
    function serveLockedReads(): void {
      accountRepository.findOne.mockImplementation(
        async ({ where }: { where: { id: string } }) =>
          (await accountRepository.find()).find(
            (a: Account) => a.id === where.id,
          ) ?? null,
      );
    }

    it("recalculates all accounts for a user", async () => {
      serveLockedReads();
      accountRepository.find.mockResolvedValue([
        { ...mockRegularAccount },
        { ...mockCreditCardAccount },
      ]);

      // Each regular account recalculation needs: earliest query + cost rows query
      reportQuery
        // Account 1
        .mockResolvedValueOnce([{ earliest: "2024-01-01" }])
        .mockResolvedValueOnce([{ month: "2024-01-01", balance: 1000 }])
        // Account 2
        .mockResolvedValueOnce([{ earliest: "2024-01-01" }])
        .mockResolvedValueOnce([{ month: "2024-01-01", balance: -500 }]);

      await service.recalculateAllAccounts("user-1");

      expect(accountRepository.find).toHaveBeenCalledWith({
        where: { userId: "user-1" },
      });
      // one snapshot rebuild per account
      expect(snapshotWriteBlocks()).toBe(2);
    });

    it("continues processing when one account fails", async () => {
      serveLockedReads();
      accountRepository.find.mockResolvedValue([
        { ...mockRegularAccount, id: "acc-1" },
        { ...mockRegularAccount, id: "acc-2" },
      ]);

      reportQuery
        // Account 1 - earliest fails
        .mockRejectedValueOnce(new Error("DB down"))
        // Account 2 - works fine
        .mockResolvedValueOnce([{ earliest: "2024-01-01" }])
        .mockResolvedValueOnce([{ month: "2024-01-01", balance: 500 }]);

      // Should NOT throw
      await service.recalculateAllAccounts("user-1");

      // Still attempted both accounts
      expect(snapshotWriteBlocks()).toBe(1);
    });

    it("handles empty accounts list", async () => {
      accountRepository.find.mockResolvedValue([]);

      await service.recalculateAllAccounts("user-1");

      expect(reportQuery).not.toHaveBeenCalled();
      expect(snapshotWriteBlocks()).toBe(0);
    });

    it("processes brokerage accounts differently from regular accounts", async () => {
      serveLockedReads();
      accountRepository.find.mockResolvedValue([
        { ...mockRegularAccount },
        { ...mockBrokerageAccount },
      ]);

      reportQuery
        // Regular account
        .mockResolvedValueOnce([{ earliest: "2024-01-01" }])
        .mockResolvedValueOnce([{ month: "2024-01-01", balance: 1000 }])
        // Brokerage account
        .mockResolvedValueOnce([{ earliest: null }])
        .mockResolvedValueOnce([{ inv_earliest: null }])
        .mockResolvedValueOnce([{ month: "2024-01-01", balance: 0 }]);

      invTxRepository.find.mockResolvedValue([]);

      await service.recalculateAllAccounts("user-1");

      expect(snapshotWriteBlocks()).toBe(2);
    });
  });

  describe("triggerDebouncedRecalc", () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("schedules a recalc after the debounce window", () => {
      const spy = jest
        .spyOn(service, "recalculateAccount")
        .mockResolvedValue(undefined);

      service.triggerDebouncedRecalc("acc-1", "user-1");

      expect(spy).not.toHaveBeenCalled();
      jest.advanceTimersByTime(2000);
      expect(spy).toHaveBeenCalledWith("user-1", "acc-1");
      spy.mockRestore();
    });

    it("debounces repeated triggers and only fires once", () => {
      const spy = jest
        .spyOn(service, "recalculateAccount")
        .mockResolvedValue(undefined);

      service.triggerDebouncedRecalc("acc-1", "user-1");
      jest.advanceTimersByTime(1000);
      service.triggerDebouncedRecalc("acc-1", "user-1");
      jest.advanceTimersByTime(1000);
      // Still within debounce window relative to the second call
      expect(spy).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1000);
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it("logs a warning when the scheduled recalc rejects", async () => {
      const spy = jest
        .spyOn(service, "recalculateAccount")
        .mockRejectedValue(new Error("boom"));
      const warnSpy = jest
        .spyOn((service as any).logger, "warn")
        .mockImplementation(() => undefined);

      service.triggerDebouncedRecalc("acc-1", "user-1");
      jest.advanceTimersByTime(2000);
      // Allow the rejected promise's catch handler to run.
      await Promise.resolve();
      await Promise.resolve();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("acc-1"));
      spy.mockRestore();
      warnSpy.mockRestore();
    });
  });

  describe("getLlmHistory", () => {
    it("delegates to getMonthlyNetWorth with the provided range", async () => {
      const spy = jest
        .spyOn(service, "getMonthlyNetWorth")
        .mockResolvedValue([]);

      await service.getLlmHistory("user-1", "2024-01-01", "2024-12-31");

      expect(spy).toHaveBeenCalledWith("user-1", "2024-01-01", "2024-12-31");
      spy.mockRestore();
    });

    it("falls back to a 12-month default range when none is provided", async () => {
      const spy = jest
        .spyOn(service, "getMonthlyNetWorth")
        .mockResolvedValue([]);

      await service.getLlmHistory("user-1");

      const [, start, end] = spy.mock.calls[0];
      // Default range is roughly the last year through today.
      expect(start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(start! < end!).toBe(true);
      spy.mockRestore();
    });
  });

  describe("recalculateAllInvestmentSnapshots", () => {
    it("recalculates each brokerage / standalone investment account", async () => {
      const qb: any = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest
          .fn()
          .mockResolvedValue([{ ...mockBrokerageAccount, userId: "user-1" }]),
      };
      accountRepository.createQueryBuilder = jest.fn().mockReturnValue(qb);

      reportQuery
        .mockResolvedValueOnce([{ earliest: null }])
        .mockResolvedValueOnce([{ inv_earliest: null }])
        .mockResolvedValueOnce([{ month: "2024-01-01", balance: 0 }]);
      invTxRepository.find.mockResolvedValue([]);

      await service.recalculateAllInvestmentSnapshots();

      expect(qb.getMany).toHaveBeenCalled();
      expect(snapshotWriteBlocks()).toBe(1);
    });

    it("continues when one account fails", async () => {
      const qb: any = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([
          { ...mockBrokerageAccount, id: "b-1", userId: "user-1" },
          { ...mockBrokerageAccount, id: "b-2", userId: "user-1" },
        ]),
      };
      accountRepository.createQueryBuilder = jest.fn().mockReturnValue(qb);

      reportQuery
        // First account: earliest call rejects
        .mockRejectedValueOnce(new Error("db down"))
        // Second account: succeeds
        .mockResolvedValueOnce([{ earliest: null }])
        .mockResolvedValueOnce([{ inv_earliest: null }])
        .mockResolvedValueOnce([{ month: "2024-01-01", balance: 0 }]);
      invTxRepository.find.mockResolvedValue([]);

      await expect(
        service.recalculateAllInvestmentSnapshots(),
      ).resolves.toBeUndefined();
      expect(snapshotWriteBlocks()).toBe(1);
    });
  });

  describe("ensurePopulated", () => {
    it("recalculates all accounts when mab count is zero", async () => {
      mabRepository.count.mockResolvedValue(0);
      accountRepository.find.mockResolvedValue([]);

      await service.ensurePopulated("user-1");

      expect(mabRepository.count).toHaveBeenCalledWith({
        where: { userId: "user-1" },
      });
      expect(accountRepository.find).toHaveBeenCalledWith({
        where: { userId: "user-1" },
      });
    });

    it("does not recalculate when all accounts have a current-month snapshot", async () => {
      mabRepository.count.mockResolvedValue(10);
      accountRepository.find.mockResolvedValue([{ id: "account-1" }]);
      mabRepository.find.mockResolvedValue([{ accountId: "account-1" }]);

      await service.ensurePopulated("user-1");

      expect(accountRepository.findOne).not.toHaveBeenCalled();
      expect(snapshotWriteBlocks()).toBe(0);
    });

    it("refreshes only accounts missing a current-month snapshot", async () => {
      mabRepository.count.mockResolvedValue(10);
      accountRepository.find.mockResolvedValue([
        { id: "account-1" },
        { id: "account-2" },
        { id: "account-3" },
      ]);
      // account-1 has a current-month row; the other two are stale.
      mabRepository.find.mockResolvedValue([{ accountId: "account-1" }]);
      // recalculateAccount loads each account; pretend they were deleted
      // so the recalc returns early and we just verify the lookups happened.
      accountRepository.findOne.mockResolvedValue(null);

      await service.ensurePopulated("user-1");

      expect(accountRepository.findOne).toHaveBeenCalledTimes(2);
      expect(accountRepository.findOne).toHaveBeenCalledWith({
        where: { id: "account-2", userId: "user-1" },
      });
      expect(accountRepository.findOne).toHaveBeenCalledWith({
        where: { id: "account-3", userId: "user-1" },
      });
    });

    it("does not query for stale accounts when mab is empty (delegates to full recalc)", async () => {
      mabRepository.count.mockResolvedValue(0);
      accountRepository.find.mockResolvedValue([]);

      await service.ensurePopulated("user-1");

      expect(mabRepository.find).not.toHaveBeenCalled();
    });

    it("returns early without querying MAB when the user has no accounts", async () => {
      mabRepository.count.mockResolvedValue(10);
      accountRepository.find.mockResolvedValue([]);

      await service.ensurePopulated("user-1");

      expect(mabRepository.find).not.toHaveBeenCalled();
      expect(accountRepository.findOne).not.toHaveBeenCalled();
    });

    it("logs a warning and continues when a stale-account refresh fails", async () => {
      mabRepository.count.mockResolvedValue(10);
      accountRepository.find.mockResolvedValue([
        { id: "account-1" },
        { id: "account-2" },
      ]);
      mabRepository.find.mockResolvedValue([]);
      // First lookup throws, second returns null so its recalc no-ops.
      accountRepository.findOne
        .mockRejectedValueOnce(new Error("db down"))
        .mockResolvedValueOnce(null);
      const warnSpy = jest
        .spyOn((service as any).logger, "warn")
        .mockImplementation(() => undefined);

      await expect(service.ensurePopulated("user-1")).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("account-1"),
      );
      warnSpy.mockRestore();
    });
  });

  describe("getMonthlyNetWorth with a joint scope (N1)", () => {
    const OWNER = "aaaaaaaa-1111-4111-8111-111111111111";
    const jointScope = {
      accounts: [{ accountId: "joint-1", ownerUserId: OWNER }],
    };

    beforeEach(() => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({ defaultCurrency: "USD" });
      // The joint account's current month is already populated -> no refresh.
      mabRepository.find.mockResolvedValue([{ accountId: "joint-1" }]);
    });

    it("passes the joint ids into the snapshot predicate", async () => {
      reportQuery.mockResolvedValueOnce([]);
      await service.getMonthlyNetWorth(
        "user-1",
        "2024-01-01",
        "2024-06-30",
        jointScope,
      );
      const queryArgs = reportQuery.mock.calls[0];
      expect(queryArgs[1]).toEqual([
        "user-1",
        "2024-01-01",
        "2024-06-30",
        ["joint-1"],
      ]);
      expect(queryArgs[0]).toContain("mab.account_id = ANY($4::UUID[])");
      // The owner-side exclusion flag stays confined to the own-rows arm.
      expect(queryArgs[0]).toContain(
        "(mab.user_id = $1 AND a.exclude_from_net_worth = false)",
      );
    });

    it("sums joint rows into the grantee's totals", async () => {
      reportQuery
        .mockResolvedValueOnce([
          {
            month: "2024-01-01",
            balance: 5000,
            market_value: null,
            account_id: "own-1",
            account_type: AccountType.CHEQUING,
            account_sub_type: null,
            currency_code: "USD",
          },
          {
            month: "2024-01-01",
            balance: 3000,
            market_value: null,
            account_id: "joint-1",
            account_type: AccountType.CHEQUING,
            account_sub_type: null,
            currency_code: "USD",
          },
        ])
        .mockResolvedValueOnce([]);

      const result = await service.getMonthlyNetWorth(
        "user-1",
        undefined,
        undefined,
        jointScope,
      );
      expect(result[0].assets).toBe(8000);
      expect(result[0].netWorth).toBe(8000);
    });

    it("refreshes a stale joint month under the OWNER's identity", async () => {
      // No populated current-month row for the joint account.
      mabRepository.find.mockResolvedValue([]);
      const recalc = jest
        .spyOn(service, "recalculateAccount")
        .mockResolvedValue(undefined as never);
      reportQuery.mockResolvedValueOnce([]);

      await service.getMonthlyNetWorth(
        "user-1",
        undefined,
        undefined,
        jointScope,
      );

      expect(recalc).toHaveBeenCalledWith(OWNER, "joint-1");
    });
  });

  describe("getLatestNetWorth with a joint scope (N1)", () => {
    it("widens the latest-month probe by the joint ids", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({ defaultCurrency: "USD" });
      mabRepository.find.mockResolvedValue([{ accountId: "joint-1" }]);
      reportQuery
        .mockResolvedValueOnce([{ month: "2024-02-01" }])
        .mockResolvedValueOnce([]);

      const OWNER = "aaaaaaaa-1111-4111-8111-111111111111";
      await service.getLatestNetWorth("user-1", {
        accounts: [{ accountId: "joint-1", ownerUserId: OWNER }],
      });

      const [sql, params] = reportQuery.mock.calls[0];
      expect(sql).toContain("account_id = ANY($2::UUID[])");
      expect(params).toEqual(["user-1", ["joint-1"]]);
    });
  });

  describe("getMonthlyNetWorth", () => {
    it("returns empty array when no snapshots exist", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });
      reportQuery.mockResolvedValueOnce([]);

      const result = await service.getMonthlyNetWorth("user-1");

      expect(result).toEqual([]);
    });

    it("separates assets and liabilities correctly", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      reportQuery
        .mockResolvedValueOnce([
          {
            month: "2024-01-01",
            balance: 5000,
            market_value: null,
            account_id: "checking",
            account_type: AccountType.CHEQUING,
            account_sub_type: null,
            currency_code: "USD",
          },
          {
            month: "2024-01-01",
            balance: 2000,
            market_value: null,
            account_id: "savings",
            account_type: AccountType.SAVINGS,
            account_sub_type: null,
            currency_code: "USD",
          },
          {
            month: "2024-01-01",
            balance: -1500,
            market_value: null,
            account_id: "cc",
            account_type: AccountType.CREDIT_CARD,
            account_sub_type: null,
            currency_code: "USD",
          },
          {
            month: "2024-01-01",
            balance: -200000,
            market_value: null,
            account_id: "mortgage",
            account_type: AccountType.MORTGAGE,
            account_sub_type: null,
            currency_code: "USD",
          },
        ])
        // buildRateIndex (no foreign currencies)
        .mockResolvedValueOnce([]);

      const result = await service.getMonthlyNetWorth("user-1");

      expect(result).toHaveLength(1);
      expect(result[0].month).toBe("2024-01-01");
      expect(result[0].assets).toBe(7000); // 5000 + 2000
      expect(result[0].liabilities).toBe(201500); // abs(-1500) + abs(-200000)
      expect(result[0].netWorth).toBe(7000 - 201500);
    });

    it("uses market_value for INVESTMENT_BROKERAGE accounts", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      reportQuery.mockResolvedValueOnce([
        {
          month: "2024-01-01",
          balance: 10000,
          market_value: 15000,
          account_id: "brokerage",
          account_type: AccountType.INVESTMENT,
          account_sub_type: "INVESTMENT_BROKERAGE",
          currency_code: "USD",
        },
      ]);

      const result = await service.getMonthlyNetWorth("user-1");

      expect(result).toHaveLength(1);
      // Should use market_value (15000), not balance (10000)
      expect(result[0].assets).toBe(15000);
    });

    it("falls back to balance when market_value is null for brokerage", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      reportQuery.mockResolvedValueOnce([
        {
          month: "2024-01-01",
          balance: 10000,
          market_value: null,
          account_id: "brokerage",
          account_type: AccountType.INVESTMENT,
          account_sub_type: "INVESTMENT_BROKERAGE",
          currency_code: "USD",
        },
      ]);

      const result = await service.getMonthlyNetWorth("user-1");

      expect(result[0].assets).toBe(10000);
    });

    it("applies date range filters", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });
      reportQuery.mockResolvedValueOnce([]);

      await service.getMonthlyNetWorth("user-1", "2024-01-01", "2024-06-30");

      const queryArgs = reportQuery.mock.calls[0];
      // The trailing empty array is the joint-account widening (N1): empty
      // for every caller without a joint scope, keeping this query's result
      // byte-identical to the pre-joint behavior.
      expect(queryArgs[1]).toEqual(["user-1", "2024-01-01", "2024-06-30", []]);
    });

    it("uses default date range when none specified", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue(null);
      reportQuery.mockResolvedValueOnce([]);

      await service.getMonthlyNetWorth("user-1");

      const queryArgs = reportQuery.mock.calls[0];
      expect(queryArgs[1][0]).toBe("user-1");
      expect(queryArgs[1][1]).toBe("1990-01-01");
      // end date should be today
      expect(queryArgs[1][2]).toBe(new Date().toISOString().slice(0, 10));
    });

    it("defaults to USD when user has no preference", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue(null);
      reportQuery.mockResolvedValueOnce([
        {
          month: "2024-01-01",
          balance: 1000,
          market_value: null,
          account_id: "a1",
          account_type: AccountType.CHEQUING,
          account_sub_type: null,
          currency_code: "USD",
        },
      ]);

      const result = await service.getMonthlyNetWorth("user-1");

      // No currency conversion needed (USD to USD), so no rate query
      expect(result[0].assets).toBe(1000);
    });

    it("converts foreign currency amounts using exchange rates", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      reportQuery
        .mockResolvedValueOnce([
          {
            month: "2024-01-01",
            balance: 1000,
            market_value: null,
            account_id: "cad-account",
            account_type: AccountType.CHEQUING,
            account_sub_type: null,
            currency_code: "CAD",
          },
        ])
        // buildRateIndex returns rates
        .mockResolvedValueOnce([
          {
            from_currency: "CAD",
            to_currency: "USD",
            rate: 0.75,
            rate_date: "2024-01-15",
          },
        ]);

      const result = await service.getMonthlyNetWorth("user-1");

      // 1000 CAD * 0.75 = 750 USD
      expect(result[0].assets).toBe(750);
    });

    it("uses reverse exchange rate when direct rate not available", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      reportQuery
        .mockResolvedValueOnce([
          {
            month: "2024-01-01",
            balance: 1000,
            market_value: null,
            account_id: "eur-account",
            account_type: AccountType.CHEQUING,
            account_sub_type: null,
            currency_code: "EUR",
          },
        ])
        // buildRateIndex returns reverse rate only
        .mockResolvedValueOnce([
          {
            from_currency: "USD",
            to_currency: "EUR",
            rate: 0.92,
            rate_date: "2024-01-15",
          },
        ]);

      const result = await service.getMonthlyNetWorth("user-1");

      // 1000 EUR / 0.92 = ~1087
      expect(result[0].assets).toBe(Math.round(1000 / 0.92));
    });

    it("returns amount unconverted when no rate exists", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      reportQuery
        .mockResolvedValueOnce([
          {
            month: "2024-01-01",
            balance: 1000,
            market_value: null,
            account_id: "jpy-account",
            account_type: AccountType.CHEQUING,
            account_sub_type: null,
            currency_code: "JPY",
          },
        ])
        // no rates returned
        .mockResolvedValueOnce([]);

      const result = await service.getMonthlyNetWorth("user-1");

      // A missing rate is reported as a gap, NOT applied as 1:1 (audit P5-009).
      //
      // This assertion previously read `expect(result[0].assets).toBe(1000)`
      // under the name "returns amount unconverted when no rate exists" -- it
      // documented the defect as intended behaviour, which is why the defect
      // survived. 1,000 JPY is roughly 7 USD; reporting it as 1,000 USD
      // overstated the month by two orders of magnitude.
      expect(result[0].fxComplete).toBe(false);
      expect(result[0].missingRatePairs).toEqual(["JPY->USD"]);
      // The unconvertible component is excluded from the subtotal rather than
      // entered at face value.
      expect(result[0].assets).toBe(0);
    });

    it("a zero balance in an unrated currency is a settled zero, not a gap", async () => {
      // An emptied account holds zero in any currency, so it needs no rate.
      // Asking for one flagged every month incomplete for as long as the empty
      // account existed -- reporting a question that was never open as one that
      // could not be answered ("zero needs no rate", root CLAUDE.md).
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      reportQuery
        .mockResolvedValueOnce([
          {
            month: "2024-01-01",
            balance: 0,
            market_value: null,
            account_id: "jpy-account",
            account_type: AccountType.CHEQUING,
            account_sub_type: null,
            currency_code: "JPY",
          },
        ])
        // no rates returned
        .mockResolvedValueOnce([]);

      const result = await service.getMonthlyNetWorth("user-1");

      expect(result[0].fxComplete).toBe(true);
      expect(result[0].missingRatePairs).toEqual([]);
      expect(result[0].assets).toBe(0);
    });

    it("aggregates multiple accounts in the same month", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      reportQuery.mockResolvedValueOnce([
        {
          month: "2024-01-01",
          balance: 3000,
          market_value: null,
          account_id: "a1",
          account_type: AccountType.CHEQUING,
          account_sub_type: null,
          currency_code: "USD",
        },
        {
          month: "2024-01-01",
          balance: 2000,
          market_value: null,
          account_id: "a2",
          account_type: AccountType.SAVINGS,
          account_sub_type: null,
          currency_code: "USD",
        },
        {
          month: "2024-02-01",
          balance: 3500,
          market_value: null,
          account_id: "a1",
          account_type: AccountType.CHEQUING,
          account_sub_type: null,
          currency_code: "USD",
        },
      ]);

      const result = await service.getMonthlyNetWorth("user-1");

      expect(result).toHaveLength(2);
      expect(result[0].month).toBe("2024-01-01");
      expect(result[0].assets).toBe(5000);
      expect(result[1].month).toBe("2024-02-01");
      expect(result[1].assets).toBe(3500);
    });

    it("sorts results by month", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      // Return out of order
      reportQuery.mockResolvedValueOnce([
        {
          month: "2024-03-01",
          balance: 3000,
          market_value: null,
          account_id: "a1",
          account_type: AccountType.CHEQUING,
          account_sub_type: null,
          currency_code: "USD",
        },
        {
          month: "2024-01-01",
          balance: 1000,
          market_value: null,
          account_id: "a1",
          account_type: AccountType.CHEQUING,
          account_sub_type: null,
          currency_code: "USD",
        },
        {
          month: "2024-02-01",
          balance: 2000,
          market_value: null,
          account_id: "a1",
          account_type: AccountType.CHEQUING,
          account_sub_type: null,
          currency_code: "USD",
        },
      ]);

      const result = await service.getMonthlyNetWorth("user-1");

      expect(result[0].month).toBe("2024-01-01");
      expect(result[1].month).toBe("2024-02-01");
      expect(result[2].month).toBe("2024-03-01");
    });

    it("rounds values to whole numbers", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      reportQuery.mockResolvedValueOnce([
        {
          month: "2024-01-01",
          balance: 1000.567,
          market_value: null,
          account_id: "a1",
          account_type: AccountType.CHEQUING,
          account_sub_type: null,
          currency_code: "USD",
        },
      ]);

      const result = await service.getMonthlyNetWorth("user-1");

      expect(result[0].assets).toBe(1001);
      expect(Number.isInteger(result[0].assets)).toBe(true);
      expect(Number.isInteger(result[0].liabilities)).toBe(true);
      expect(Number.isInteger(result[0].netWorth)).toBe(true);
    });

    it("classifies all liability types correctly", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      const liabilityTypes = [
        AccountType.CREDIT_CARD,
        AccountType.LOAN,
        AccountType.MORTGAGE,
        AccountType.LINE_OF_CREDIT,
      ];

      const snapshots = liabilityTypes.map((type, i) => ({
        month: "2024-01-01",
        balance: -1000,
        market_value: null,
        account_id: `liability-${i}`,
        account_type: type,
        account_sub_type: null,
        currency_code: "USD",
      }));

      reportQuery.mockResolvedValueOnce(snapshots);

      const result = await service.getMonthlyNetWorth("user-1");

      expect(result[0].assets).toBe(0);
      expect(result[0].liabilities).toBe(4000); // 4 * abs(-1000)
    });

    it("calls ensurePopulated before fetching data", async () => {
      mabRepository.count.mockResolvedValue(0);
      accountRepository.find.mockResolvedValue([]);
      prefRepository.findOne.mockResolvedValue(null);
      reportQuery.mockResolvedValueOnce([]);

      await service.getMonthlyNetWorth("user-1");

      // ensurePopulated checks mab count
      expect(mabRepository.count).toHaveBeenCalledWith({
        where: { userId: "user-1" },
      });
    });

    it("includes INVESTMENT_CASH balance in net worth without double-counting", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      // Simulate a brokerage + linked cash account pair
      reportQuery.mockResolvedValueOnce([
        {
          month: "2024-01-01",
          balance: 0,
          market_value: 50000,
          account_id: "brokerage-1",
          account_type: AccountType.INVESTMENT,
          account_sub_type: "INVESTMENT_BROKERAGE",
          currency_code: "USD",
        },
        {
          month: "2024-01-01",
          balance: 5000,
          market_value: null,
          account_id: "cash-1",
          account_type: AccountType.INVESTMENT,
          account_sub_type: "INVESTMENT_CASH",
          currency_code: "USD",
        },
      ]);

      const result = await service.getMonthlyNetWorth("user-1");

      // Brokerage uses market_value (50000), cash account uses balance (5000)
      // Total assets = 50000 + 5000 = 55000 (no double-counting)
      expect(result[0].assets).toBe(55000);
      expect(result[0].netWorth).toBe(55000);
    });

    it("includes both market value and cash balance for standalone INVESTMENT accounts", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({ defaultCurrency: "USD" });

      reportQuery.mockResolvedValueOnce([
        {
          month: "2024-01-01",
          balance: 2500,
          market_value: 30000,
          account_id: "standalone-1",
          account_type: AccountType.INVESTMENT,
          account_sub_type: null,
          currency_code: "USD",
        },
      ]);

      const result = await service.getMonthlyNetWorth("user-1");

      expect(result[0].assets).toBe(32500);
    });
  });

  describe("getLatestNetWorth", () => {
    it("returns only the latest month's totals", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({ defaultCurrency: "USD" });
      reportQuery
        // MAX(month) lookup
        .mockResolvedValueOnce([{ month: "2024-03-01" }])
        // snapshots bounded to that single month
        .mockResolvedValueOnce([
          {
            month: "2024-03-01",
            balance: 5000,
            market_value: null,
            account_id: "checking",
            account_type: AccountType.CHEQUING,
            account_sub_type: null,
            currency_code: "USD",
          },
          {
            month: "2024-03-01",
            balance: -1500,
            market_value: null,
            account_id: "cc",
            account_type: AccountType.CREDIT_CARD,
            account_sub_type: null,
            currency_code: "USD",
          },
        ])
        // buildRateIndex (no foreign currencies)
        .mockResolvedValueOnce([]);

      const result = await service.getLatestNetWorth("user-1");

      expect(result).toEqual({
        assets: 5000,
        liabilities: 1500,
        netWorth: 3500,
      });
      // The month range is bounded to the latest month so the snapshot query
      // does not replay the whole history.
      const snapshotCall = reportQuery.mock.calls[1];
      expect(snapshotCall[1]).toEqual([
        "user-1",
        "2024-03-01",
        "2024-03-01",
        [],
      ]);
    });

    it("returns null when there are no snapshots", async () => {
      mabRepository.count.mockResolvedValue(5);
      reportQuery.mockResolvedValueOnce([{ month: null }]);

      const result = await service.getLatestNetWorth("user-1");

      expect(result).toBeNull();
    });
  });

  describe("getMonthlyInvestments", () => {
    it("returns empty array when no snapshots exist", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });
      reportQuery.mockResolvedValueOnce([]);

      const result = await service.getMonthlyInvestments("user-1");

      expect(result).toEqual([]);
    });

    it("returns investment values aggregated by month", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      reportQuery
        .mockResolvedValueOnce([
          {
            month: "2024-01-01",
            balance: 5000,
            market_value: 8000,
            account_id: "inv-1",
            account_sub_type: "INVESTMENT_BROKERAGE",
            currency_code: "USD",
          },
          {
            month: "2024-01-01",
            balance: 2000,
            market_value: null,
            account_id: "inv-cash",
            account_sub_type: "INVESTMENT_CASH",
            currency_code: "USD",
          },
        ])
        // firstMonthRows lookup: account's first ever month is earlier than
        // the snapshot, so no cost-basis adjustment kicks in.
        .mockResolvedValueOnce([
          { account_id: "inv-1", first_month: "2023-01-01" },
        ]);

      const result = await service.getMonthlyInvestments("user-1");

      expect(result).toHaveLength(1);
      // Brokerage uses market_value (8000), cash uses balance (2000)
      expect(result[0].value).toBe(10000);
    });

    it("filters by specific accountIds when provided", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      // Linked account resolution query
      reportQuery
        .mockResolvedValueOnce([
          { id: "inv-1", linked_account_id: "inv-cash-1" },
          { id: "inv-cash-1", linked_account_id: "inv-1" },
        ])
        // Main snapshots query
        .mockResolvedValueOnce([
          {
            month: "2024-01-01",
            balance: 5000,
            market_value: 8000,
            account_id: "inv-1",
            account_sub_type: "INVESTMENT_BROKERAGE",
            currency_code: "USD",
          },
        ])
        // firstMonthRows lookup: snapshot is not the account's first month
        .mockResolvedValueOnce([
          { account_id: "inv-1", first_month: "2023-01-01" },
        ]);

      const result = await service.getMonthlyInvestments(
        "user-1",
        undefined,
        undefined,
        ["inv-1"],
      );

      expect(result).toHaveLength(1);
      expect(result[0].value).toBe(8000);
    });

    it("uses date range filters", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });
      reportQuery.mockResolvedValueOnce([]);

      await service.getMonthlyInvestments("user-1", "2024-01-01", "2024-12-31");

      const queryArgs = reportQuery.mock.calls[0];
      expect(queryArgs[1]).toContain("2024-01-01");
      expect(queryArgs[1]).toContain("2024-12-31");
    });

    it("converts foreign currency investment values", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      reportQuery
        .mockResolvedValueOnce([
          {
            month: "2024-01-01",
            balance: 1000,
            market_value: 1500,
            account_id: "cad-inv",
            account_sub_type: "INVESTMENT_BROKERAGE",
            currency_code: "CAD",
          },
        ])
        // firstMonthRows lookup: snapshot is not the account's first month
        .mockResolvedValueOnce([
          { account_id: "cad-inv", first_month: "2023-01-01" },
        ])
        // exchange rates
        .mockResolvedValueOnce([
          {
            from_currency: "CAD",
            to_currency: "USD",
            rate: 0.75,
            rate_date: "2024-01-20",
          },
        ]);

      const result = await service.getMonthlyInvestments("user-1");

      // 1500 CAD * 0.75 = 1125 USD
      expect(result[0].value).toBe(1125);
    });

    it("sorts results by month", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      reportQuery.mockResolvedValueOnce([
        {
          month: "2024-03-01",
          balance: 3000,
          market_value: null,
          account_id: "inv-1",
          account_sub_type: "INVESTMENT_CASH",
          currency_code: "USD",
        },
        {
          month: "2024-01-01",
          balance: 1000,
          market_value: null,
          account_id: "inv-1",
          account_sub_type: "INVESTMENT_CASH",
          currency_code: "USD",
        },
      ]);

      const result = await service.getMonthlyInvestments("user-1");

      expect(result[0].month).toBe("2024-01-01");
      expect(result[1].month).toBe("2024-03-01");
    });

    it("rounds values to whole numbers", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      reportQuery.mockResolvedValueOnce([
        {
          month: "2024-01-01",
          balance: 1234.567,
          market_value: null,
          account_id: "inv-1",
          account_sub_type: "INVESTMENT_CASH",
          currency_code: "USD",
        },
      ]);

      const result = await service.getMonthlyInvestments("user-1");

      expect(result[0].value).toBe(1235);
      expect(Number.isInteger(result[0].value)).toBe(true);
    });

    it("defaults to filtering INVESTMENT_CASH and INVESTMENT_BROKERAGE sub types when no accountIds", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });
      reportQuery.mockResolvedValueOnce([]);

      await service.getMonthlyInvestments("user-1");

      const queryStr = reportQuery.mock.calls[0][0];
      expect(queryStr).toContain("INVESTMENT_CASH");
      expect(queryStr).toContain("INVESTMENT_BROKERAGE");
    });

    it("resolves linked account pairs when filtering by accountIds", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      // First call resolves linked accounts for inv-1
      reportQuery
        .mockResolvedValueOnce([
          { id: "inv-1", linked_account_id: "inv-cash-1" },
          { id: "inv-cash-1", linked_account_id: "inv-1" },
        ])
        // Second call resolves linked accounts for inv-2
        .mockResolvedValueOnce([{ id: "inv-2", linked_account_id: null }])
        // Main snapshots query
        .mockResolvedValueOnce([
          {
            month: "2024-01-01",
            balance: 5000,
            market_value: 8000,
            account_id: "inv-1",
            account_sub_type: "INVESTMENT_BROKERAGE",
            currency_code: "USD",
          },
          {
            month: "2024-01-01",
            balance: 1000,
            market_value: null,
            account_id: "inv-cash-1",
            account_sub_type: "INVESTMENT_CASH",
            currency_code: "USD",
          },
        ])
        // firstMonthRows lookup: snapshot is not the account's first month
        .mockResolvedValueOnce([
          { account_id: "inv-1", first_month: "2023-01-01" },
        ]);

      await service.getMonthlyInvestments("user-1", undefined, undefined, [
        "inv-1",
        "inv-2",
      ]);

      // The snapshot query should include all resolved IDs
      const mainQueryCall = reportQuery.mock.calls[2];
      expect(mainQueryCall[0]).toContain("IN");
    });

    it("calls ensurePopulated before fetching data", async () => {
      mabRepository.count.mockResolvedValue(0);
      accountRepository.find.mockResolvedValue([]);
      prefRepository.findOne.mockResolvedValue(null);
      reportQuery.mockResolvedValueOnce([]);

      await service.getMonthlyInvestments("user-1");

      expect(mabRepository.count).toHaveBeenCalledWith({
        where: { userId: "user-1" },
      });
    });

    it("returns empty array when accountIds resolve to no accounts", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({ defaultCurrency: "USD" });
      // Linked account resolution returns empty
      reportQuery.mockResolvedValueOnce([]);

      const result = await service.getMonthlyInvestments(
        "user-1",
        undefined,
        undefined,
        ["unknown-id"],
      );

      expect(result).toEqual([]);
    });

    it("includes both market value and cash balance for standalone INVESTMENT accounts", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({ defaultCurrency: "USD" });

      reportQuery
        .mockResolvedValueOnce([
          {
            month: "2024-01-01",
            balance: 1500,
            market_value: 20000,
            account_id: "standalone-1",
            account_type: AccountType.INVESTMENT,
            account_sub_type: null,
            currency_code: "USD",
          },
        ])
        // firstMonthRows lookup: snapshot is not the account's first month
        .mockResolvedValueOnce([
          { account_id: "standalone-1", first_month: "2023-01-01" },
        ]);

      const result = await service.getMonthlyInvestments("user-1");

      expect(result[0].value).toBe(21500);
    });

    it("uses cost basis for first active month brokerage snapshot", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({ defaultCurrency: "USD" });

      reportQuery
        // snapshots
        .mockResolvedValueOnce([
          {
            month: "2024-03-01",
            balance: 0,
            market_value: 11000,
            account_id: "brokerage-new",
            account_type: AccountType.INVESTMENT,
            account_sub_type: "INVESTMENT_BROKERAGE",
            currency_code: "USD",
          },
          {
            month: "2024-04-01",
            balance: 0,
            market_value: 12000,
            account_id: "brokerage-new",
            account_type: AccountType.INVESTMENT,
            account_sub_type: "INVESTMENT_BROKERAGE",
            currency_code: "USD",
          },
        ])
        // firstMonthRows: 2024-03-01 IS this account's first active month
        .mockResolvedValueOnce([
          { account_id: "brokerage-new", first_month: "2024-03-01" },
        ])
        // txRows: a buy and a sell in March
        .mockResolvedValueOnce([
          {
            account_id: "brokerage-new",
            action: "BUY",
            quantity: 100,
            price: 100,
            transaction_date: "2024-03-05",
            security_currency: "USD",
          },
          {
            account_id: "brokerage-new",
            action: "SELL",
            quantity: 10,
            price: 105,
            transaction_date: "2024-03-20",
            security_currency: "USD",
          },
        ]);

      const result = await service.getMonthlyInvestments(
        "user-1",
        "2024-03-01",
        "2024-04-30",
      );

      expect(result).toHaveLength(2);
      // Cost basis for first month: 100*100 (BUY) - 10*105 (SELL) = 10000 - 1050 = 8950
      // (replaces market_value of 11000)
      expect(result[0]).toMatchObject({ month: "2024-03-01", value: 8950 });
      // Second month uses market_value as before
      expect(result[1]).toMatchObject({ month: "2024-04-01", value: 12000 });
    });

    it("marks the month incomplete when a first-month cost-basis component cannot convert", async () => {
      // A EUR-denominated buy seeds the first month of a USD account with no
      // EUR->USD rate stored. The seed used to skip the component silently, so
      // the month shipped an understated value under fxComplete: true -- the
      // "flag that does not cover every total" shape the completeness contract
      // forbids. The gap must ride the seed's aggregate into the month.
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({ defaultCurrency: "USD" });

      reportQuery
        // snapshots
        .mockResolvedValueOnce([
          {
            month: "2024-03-01",
            balance: 0,
            market_value: 11000,
            account_id: "brokerage-new",
            account_type: AccountType.INVESTMENT,
            account_sub_type: "INVESTMENT_BROKERAGE",
            currency_code: "USD",
          },
        ])
        // firstMonthRows: 2024-03-01 IS this account's first active month
        .mockResolvedValueOnce([
          { account_id: "brokerage-new", first_month: "2024-03-01" },
        ])
        // txRows: a buy denominated in EUR
        .mockResolvedValueOnce([
          {
            account_id: "brokerage-new",
            action: "BUY",
            quantity: 100,
            price: 100,
            transaction_date: "2024-03-05",
            security_currency: "EUR",
          },
        ])
        // rate index for the seed's EUR: nothing stored
        .mockResolvedValueOnce([]);

      const result = await service.getMonthlyInvestments(
        "user-1",
        "2024-03-01",
        "2024-03-31",
      );

      expect(result).toHaveLength(1);
      expect(result[0].fxComplete).toBe(false);
      expect(result[0].missingRatePairs).toContain("EUR->USD");
    });

    it("does not adjust when snapshot month is after the account's first active month", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({ defaultCurrency: "USD" });

      reportQuery
        .mockResolvedValueOnce([
          {
            month: "2024-03-01",
            balance: 0,
            market_value: 11000,
            account_id: "brokerage-existing",
            account_type: AccountType.INVESTMENT,
            account_sub_type: "INVESTMENT_BROKERAGE",
            currency_code: "USD",
          },
        ])
        // firstMonthRows: account opened earlier than the requested period
        .mockResolvedValueOnce([
          { account_id: "brokerage-existing", first_month: "2020-01-01" },
        ]);

      const result = await service.getMonthlyInvestments(
        "user-1",
        "2024-03-01",
        "2024-03-31",
      );

      expect(result).toHaveLength(1);
      // No adjustment: market_value used as-is
      expect(result[0].value).toBe(11000);
    });

    it("includes cash balance alongside cost basis for standalone accounts in first active month", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({ defaultCurrency: "USD" });

      reportQuery
        .mockResolvedValueOnce([
          {
            month: "2024-03-01",
            balance: 1500,
            market_value: 20000,
            account_id: "standalone-new",
            account_type: AccountType.INVESTMENT,
            account_sub_type: null,
            currency_code: "USD",
          },
        ])
        .mockResolvedValueOnce([
          { account_id: "standalone-new", first_month: "2024-03-01" },
        ])
        .mockResolvedValueOnce([
          {
            account_id: "standalone-new",
            action: "BUY",
            quantity: 50,
            price: 200,
            transaction_date: "2024-03-10",
            security_currency: "USD",
          },
        ]);

      const result = await service.getMonthlyInvestments(
        "user-1",
        "2024-03-01",
        "2024-03-31",
      );

      // Cost basis 50*200 = 10000, plus standalone cash balance 1500 = 11500
      expect(result[0].value).toBe(11500);
    });

    it("converts first-month cost basis through security currency", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({ defaultCurrency: "USD" });

      reportQuery
        .mockResolvedValueOnce([
          {
            month: "2024-03-01",
            balance: 0,
            market_value: 9000,
            account_id: "brokerage-cad",
            account_type: AccountType.INVESTMENT,
            account_sub_type: "INVESTMENT_BROKERAGE",
            currency_code: "CAD",
          },
        ])
        .mockResolvedValueOnce([
          { account_id: "brokerage-cad", first_month: "2024-03-01" },
        ])
        .mockResolvedValueOnce([
          {
            account_id: "brokerage-cad",
            action: "BUY",
            quantity: 40,
            price: 250,
            transaction_date: "2024-03-15",
            security_currency: "CAD",
          },
        ])
        // exchange rates for cost-basis conversion (CAD -> USD)
        .mockResolvedValueOnce([
          {
            from_currency: "CAD",
            to_currency: "USD",
            rate: 0.75,
            rate_date: "2024-03-20",
          },
        ])
        // exchange rates for main snapshot conversion
        .mockResolvedValueOnce([
          {
            from_currency: "CAD",
            to_currency: "USD",
            rate: 0.75,
            rate_date: "2024-03-20",
          },
        ]);

      const result = await service.getMonthlyInvestments(
        "user-1",
        "2024-03-01",
        "2024-03-31",
      );

      // 40 * 250 = 10000 CAD * 0.75 = 7500 USD
      expect(result[0].value).toBe(7500);
    });
  });

  /**
   * A YTD chart opens on the first *trading* day of the year, which
   * `getDailyInvestments` cannot report: it values every calendar day at the
   * latest close at or before it, so 1 January carries December's close and a
   * market holiday is indistinguishable from a flat session. `security_prices`
   * rows exist only for days a price was struck, which is why the question is
   * answerable here.
   */
  describe("getFirstPricedDay", () => {
    it("returns the earliest priced day on or after the date", async () => {
      reportQuery.mockResolvedValueOnce([{ date: "2026-01-02" }]);

      const result = await service.getFirstPricedDay("user-1", "2026-01-01");

      expect(result).toEqual({ date: "2026-01-02" });
      const [sql, params] = reportQuery.mock.calls[0];
      expect(sql).toContain("MIN(sp.price_date)");
      expect(sql).toContain("FROM security_prices sp");
      expect(params).toEqual(["user-1", "2026-01-01"]);
    });

    /**
     * Unknown, never a substituted date: the caller keeps the calendar
     * boundary it already had rather than a chart claiming a trading day
     * nobody observed.
     */
    it("returns null when nothing in scope was priced", async () => {
      reportQuery.mockResolvedValueOnce([{ date: null }]);

      expect(await service.getFirstPricedDay("user-1", "2026-01-01")).toEqual({
        date: null,
      });
    });

    it("returns null when the aggregate produced no row at all", async () => {
      reportQuery.mockResolvedValueOnce([]);

      expect(await service.getFirstPricedDay("user-1", "2026-01-01")).toEqual({
        date: null,
      });
    });

    it("restricts to the requested accounts, parameterized", async () => {
      reportQuery.mockResolvedValueOnce([{ date: "2026-01-05" }]);

      await service.getFirstPricedDay("user-1", "2026-01-01", [
        "acct-1",
        "acct-2",
      ]);

      const [sql, params] = reportQuery.mock.calls[0];
      expect(sql).toContain("AND a.id IN ($3, $4)");
      expect(params).toEqual(["user-1", "2026-01-01", "acct-1", "acct-2"]);
    });

    /**
     * A security sold years ago still has prices, and its later prices are not
     * this portfolio's trading days. The holdings filter is on the transaction
     * date so the answer describes what the scope actually held.
     */
    it("only considers securities transacted on or before the date", async () => {
      reportQuery.mockResolvedValueOnce([{ date: "2026-01-02" }]);

      await service.getFirstPricedDay("user-1", "2026-01-01");

      expect(reportQuery.mock.calls[0][0]).toContain(
        "it.transaction_date <= $2::DATE",
      );
    });
  });

  describe("getDailyInvestments", () => {
    it("returns empty array when no accounts match", async () => {
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });
      // accounts query returns empty
      reportQuery.mockResolvedValueOnce([]);

      const result = await service.getDailyInvestments(
        "user-1",
        "2025-03-01",
        "2025-03-04",
      );

      expect(result).toEqual([]);
    });

    it("returns daily values for brokerage accounts with security prices", async () => {
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      // accounts query
      reportQuery.mockResolvedValueOnce([
        {
          id: "brok-1",
          account_type: "INVESTMENT",
          account_sub_type: "INVESTMENT_BROKERAGE",
          currency_code: "USD",
          opening_balance: 0,
        },
      ]);

      // investment transactions query
      reportQuery.mockResolvedValueOnce([
        {
          account_id: "brok-1",
          security_id: "sec-1",
          action: "BUY",
          quantity: "10",
          transaction_date: "2025-02-01",
        },
      ]);

      // securities
      securityRepository.findByIds.mockResolvedValue([
        { id: "sec-1", skipPriceUpdates: false },
      ]);

      // security prices query (includes a price from the prior trading day so
      // a first chart point with no same-day close can still fall back to it)
      reportQuery.mockResolvedValueOnce([
        {
          security_id: "sec-1",
          price_date: "2025-02-28",
          close_price: "99.00",
        },
        {
          security_id: "sec-1",
          price_date: "2025-03-01",
          close_price: "100.00",
        },
        {
          security_id: "sec-1",
          price_date: "2025-03-02",
          close_price: "102.00",
        },
        {
          security_id: "sec-1",
          price_date: "2025-03-03",
          close_price: "101.00",
        },
      ]);

      const result = await service.getDailyInvestments(
        "user-1",
        "2025-03-01",
        "2025-03-03",
      );

      // Each point uses that day's close (end-of-day convention): 03-01 ->
      // 03-01, 03-02 -> 03-02, 03-03 -> 03-03. This lines the daily series up
      // with the month-end-valued monthly snapshots.
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({
        date: "2025-03-01",
        value: 1000,
        fxComplete: true,
        missingRatePairs: [],
      });
      expect(result[1]).toMatchObject({ date: "2025-03-02", value: 1020 });
      expect(result[2]).toMatchObject({ date: "2025-03-03", value: 1010 });
    });

    it("includes cash balances from INVESTMENT_CASH accounts", async () => {
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      // accounts query: only a cash account
      reportQuery.mockResolvedValueOnce([
        {
          id: "cash-1",
          account_type: "INVESTMENT",
          account_sub_type: "INVESTMENT_CASH",
          currency_code: "USD",
          opening_balance: 5000,
        },
      ]);

      // no investment transactions (no brokerage accounts)

      // securities (empty)
      securityRepository.findByIds.mockResolvedValue([]);

      // cash balances CTE query
      reportQuery.mockResolvedValueOnce([
        { date: "2025-03-01", balance: "5000", account_id: "cash-1" },
        { date: "2025-03-02", balance: "5100", account_id: "cash-1" },
      ]);

      const result = await service.getDailyInvestments(
        "user-1",
        "2025-03-01",
        "2025-03-02",
      );

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ date: "2025-03-01", value: 5000 });
      expect(result[1]).toMatchObject({ date: "2025-03-02", value: 5100 });
    });

    it("resolves linked account pairs when accountIds provided", async () => {
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      // Linked account resolution
      reportQuery.mockResolvedValueOnce([
        { id: "brok-1", linked_account_id: "cash-1" },
        { id: "cash-1", linked_account_id: "brok-1" },
      ]);

      // accounts query with resolved IDs
      reportQuery.mockResolvedValueOnce([
        {
          id: "brok-1",
          account_type: "INVESTMENT",
          account_sub_type: "INVESTMENT_BROKERAGE",
          currency_code: "USD",
          opening_balance: 0,
        },
        {
          id: "cash-1",
          account_type: "INVESTMENT",
          account_sub_type: "INVESTMENT_CASH",
          currency_code: "USD",
          opening_balance: 1000,
        },
      ]);

      // investment transactions
      reportQuery.mockResolvedValueOnce([]);
      // securities
      securityRepository.findByIds.mockResolvedValue([]);
      // cash balances
      reportQuery.mockResolvedValueOnce([
        { date: "2025-03-01", balance: "1000", account_id: "cash-1" },
      ]);

      const result = await service.getDailyInvestments(
        "user-1",
        "2025-03-01",
        "2025-03-01",
        ["brok-1"],
      );

      expect(result).toHaveLength(1);
      expect(result[0].value).toBe(1000);
    });

    it("converts foreign currency brokerage values to default currency", async () => {
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      // accounts query: CAD brokerage
      reportQuery.mockResolvedValueOnce([
        {
          id: "brok-cad",
          account_type: "INVESTMENT",
          account_sub_type: "INVESTMENT_BROKERAGE",
          currency_code: "CAD",
          opening_balance: 0,
        },
      ]);

      // investment transactions
      reportQuery.mockResolvedValueOnce([
        {
          account_id: "brok-cad",
          security_id: "sec-1",
          action: "BUY",
          quantity: "10",
          transaction_date: "2025-02-01",
        },
      ]);

      // securities (CAD-denominated security)
      securityRepository.findByIds.mockResolvedValue([
        { id: "sec-1", skipPriceUpdates: false, currencyCode: "CAD" },
      ]);

      // security prices (previous trading day's close)
      reportQuery.mockResolvedValueOnce([
        {
          security_id: "sec-1",
          price_date: "2025-02-28",
          close_price: "100.00",
        },
      ]);

      // loadTxPriceSeries fallback (no legacy transaction prices)
      reportQuery.mockResolvedValueOnce([]);

      // exchange rates (buildRateIndex)
      reportQuery.mockResolvedValueOnce([
        {
          from_currency: "CAD",
          to_currency: "USD",
          rate: "0.75",
          rate_date: "2025-02-28",
        },
      ]);

      const result = await service.getDailyInvestments(
        "user-1",
        "2025-03-01",
        "2025-03-01",
      );

      // 10 shares * $100 CAD = $1000 CAD * 0.75 = $750 USD
      expect(result).toHaveLength(1);
      expect(result[0].value).toBe(750);
    });

    it("converts foreign currency cash balances to default currency", async () => {
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      // accounts query: CAD brokerage + CAD cash
      reportQuery.mockResolvedValueOnce([
        {
          id: "brok-cad",
          account_type: "INVESTMENT",
          account_sub_type: "INVESTMENT_BROKERAGE",
          currency_code: "CAD",
          opening_balance: 0,
        },
        {
          id: "cash-cad",
          account_type: "INVESTMENT",
          account_sub_type: "INVESTMENT_CASH",
          currency_code: "CAD",
          opening_balance: 5000,
        },
      ]);

      // investment transactions
      reportQuery.mockResolvedValueOnce([
        {
          account_id: "brok-cad",
          security_id: "sec-1",
          action: "BUY",
          quantity: "10",
          transaction_date: "2025-02-01",
        },
      ]);

      // securities (CAD-denominated security)
      securityRepository.findByIds.mockResolvedValue([
        { id: "sec-1", skipPriceUpdates: false, currencyCode: "CAD" },
      ]);

      // security prices (previous trading day's close)
      reportQuery.mockResolvedValueOnce([
        {
          security_id: "sec-1",
          price_date: "2025-02-28",
          close_price: "100.00",
        },
      ]);

      // loadTxPriceSeries fallback (no legacy transaction prices)
      reportQuery.mockResolvedValueOnce([]);

      // cash balances CTE
      reportQuery.mockResolvedValueOnce([
        { date: "2025-03-01", balance: "5000", account_id: "cash-cad" },
      ]);

      // exchange rates (buildRateIndex)
      reportQuery.mockResolvedValueOnce([
        {
          from_currency: "CAD",
          to_currency: "USD",
          rate: "0.75",
          rate_date: "2025-02-28",
        },
      ]);

      const result = await service.getDailyInvestments(
        "user-1",
        "2025-03-01",
        "2025-03-01",
      );

      // Securities: 10 * $100 CAD = $1000 CAD * 0.75 = $750 USD
      // Cash: $5000 CAD * 0.75 = $3750 USD
      // Total: $4500 USD
      expect(result).toHaveLength(1);
      expect(result[0].value).toBe(4500);
    });

    it("includes standalone investment account securities with currency conversion", async () => {
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      // accounts query: standalone EUR investment account (no sub_type)
      reportQuery.mockResolvedValueOnce([
        {
          id: "inv-eur",
          account_type: "INVESTMENT",
          account_sub_type: null,
          currency_code: "EUR",
          opening_balance: 1000,
        },
      ]);

      // investment transactions (standalone accounts have investment transactions)
      reportQuery.mockResolvedValueOnce([
        {
          account_id: "inv-eur",
          security_id: "sec-eur",
          action: "BUY",
          quantity: "20",
          transaction_date: "2025-01-15",
        },
      ]);

      // securities (EUR-denominated security)
      securityRepository.findByIds.mockResolvedValue([
        { id: "sec-eur", skipPriceUpdates: false, currencyCode: "EUR" },
      ]);

      // security prices (previous trading day's close)
      reportQuery.mockResolvedValueOnce([
        {
          security_id: "sec-eur",
          price_date: "2025-02-28",
          close_price: "50.00",
        },
      ]);

      // loadTxPriceSeries fallback (no legacy transaction prices)
      reportQuery.mockResolvedValueOnce([]);

      // cash balances CTE (standalone accounts also appear in cashIds)
      reportQuery.mockResolvedValueOnce([
        { date: "2025-03-01", balance: "1000", account_id: "inv-eur" },
      ]);

      // exchange rates (buildRateIndex)
      reportQuery.mockResolvedValueOnce([
        {
          from_currency: "EUR",
          to_currency: "USD",
          rate: "1.10",
          rate_date: "2025-02-28",
        },
      ]);

      const result = await service.getDailyInvestments(
        "user-1",
        "2025-03-01",
        "2025-03-01",
      );

      // Securities: 20 * 50 EUR = 1000 EUR * 1.10 = 1100 USD
      // Cash: 1000 EUR * 1.10 = 1100 USD
      // Total: 2200 USD
      expect(result).toHaveLength(1);
      expect(result[0].value).toBe(2200);
    });

    it("converts multiple accounts with different currencies to default currency", async () => {
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "CAD",
      });

      // accounts query: CAD brokerage + USD brokerage
      reportQuery.mockResolvedValueOnce([
        {
          id: "brok-cad",
          account_type: "INVESTMENT",
          account_sub_type: "INVESTMENT_BROKERAGE",
          currency_code: "CAD",
          opening_balance: 0,
        },
        {
          id: "brok-usd",
          account_type: "INVESTMENT",
          account_sub_type: "INVESTMENT_BROKERAGE",
          currency_code: "USD",
          opening_balance: 0,
        },
      ]);

      // investment transactions for both accounts
      reportQuery.mockResolvedValueOnce([
        {
          account_id: "brok-cad",
          security_id: "sec-cad",
          action: "BUY",
          quantity: "100",
          transaction_date: "2025-02-01",
        },
        {
          account_id: "brok-usd",
          security_id: "sec-usd",
          action: "BUY",
          quantity: "50",
          transaction_date: "2025-02-01",
        },
      ]);

      // securities (each denominated in its respective account's currency)
      securityRepository.findByIds.mockResolvedValue([
        { id: "sec-cad", skipPriceUpdates: false, currencyCode: "CAD" },
        { id: "sec-usd", skipPriceUpdates: false, currencyCode: "USD" },
      ]);

      // security prices (previous trading day's close)
      reportQuery.mockResolvedValueOnce([
        {
          security_id: "sec-cad",
          price_date: "2025-02-28",
          close_price: "50.00",
        },
        {
          security_id: "sec-usd",
          price_date: "2025-02-28",
          close_price: "100.00",
        },
      ]);

      // loadTxPriceSeries fallback (no legacy transaction prices)
      reportQuery.mockResolvedValueOnce([]);

      // exchange rates (buildRateIndex): USD->CAD rate
      reportQuery.mockResolvedValueOnce([
        {
          from_currency: "USD",
          to_currency: "CAD",
          rate: "1.37",
          rate_date: "2025-02-28",
        },
      ]);

      const result = await service.getDailyInvestments(
        "user-1",
        "2025-03-01",
        "2025-03-01",
      );

      // CAD brokerage: 100 * $50 CAD = $5000 CAD (no conversion needed)
      // USD brokerage: 50 * $100 USD = $5000 USD * 1.37 = $6850 CAD
      // Total: $11850 CAD
      expect(result).toHaveLength(1);
      expect(result[0].value).toBe(11850);
    });

    it("handles SELL and TRANSFER_OUT actions in daily holdings replay", async () => {
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      // accounts query
      reportQuery.mockResolvedValueOnce([
        {
          id: "brok-1",
          account_type: "INVESTMENT",
          account_sub_type: "INVESTMENT_BROKERAGE",
          currency_code: "USD",
          opening_balance: 0,
        },
      ]);

      // BUY 100, SELL 30, TRANSFER_OUT 20 = 50 shares, then a 2-for-1 SPLIT
      // MULTIPLIES that to 100 shares.
      //
      // The fixture previously carried a SPLIT quantity of 50 and relied on it
      // being ADDED to 50 to reach 100 -- additive semantics that made the
      // wrong reducer look right (audit P5-011). A split's quantity is a ratio.
      reportQuery.mockResolvedValueOnce([
        {
          account_id: "brok-1",
          security_id: "sec-1",
          action: "BUY",
          quantity: "100",
          transaction_date: "2025-01-01",
        },
        {
          account_id: "brok-1",
          security_id: "sec-1",
          action: "SELL",
          quantity: "30",
          transaction_date: "2025-02-01",
        },
        {
          account_id: "brok-1",
          security_id: "sec-1",
          action: "TRANSFER_OUT",
          quantity: "20",
          transaction_date: "2025-02-15",
        },
        {
          account_id: "brok-1",
          security_id: "sec-1",
          action: "SPLIT",
          quantity: "2",
          transaction_date: "2025-02-20",
        },
      ]);

      // securities
      securityRepository.findByIds.mockResolvedValue([
        { id: "sec-1", skipPriceUpdates: false },
      ]);

      // security prices (previous trading day's close)
      reportQuery.mockResolvedValueOnce([
        {
          security_id: "sec-1",
          price_date: "2025-02-28",
          close_price: "10.00",
        },
      ]);

      const result = await service.getDailyInvestments(
        "user-1",
        "2025-03-01",
        "2025-03-01",
      );

      // 100 - 30 - 20 + 50 = 100 shares * $10 = $1000
      expect(result).toHaveLength(1);
      expect(result[0].value).toBe(1000);
    });

    // Issue #1242, daily aggregate -- the exact reproduction. The old test
    // asserted a skipPriceUpdates security was valued from its $61-era
    // transaction price and its later accepted manual close ignored, encoding
    // the bug. It must use the accepted security_prices close instead.
    it("values a skipPriceUpdates security from its accepted stored price in daily mode (#1242)", async () => {
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      // accounts query
      reportQuery.mockResolvedValueOnce([
        {
          id: "brok-1",
          account_type: "INVESTMENT",
          account_sub_type: "INVESTMENT_BROKERAGE",
          currency_code: "USD",
          opening_balance: 0,
        },
      ]);

      // investment transactions (120 shares held)
      reportQuery.mockResolvedValueOnce([
        {
          account_id: "brok-1",
          security_id: "sec-skip",
          action: "BUY",
          quantity: "120",
          transaction_date: "2024-01-15",
        },
      ]);

      // The security has skipPriceUpdates set -- which no longer excludes it
      // from accepted stored-price lookup.
      securityRepository.findByIds.mockResolvedValue([
        { id: "sec-skip", skipPriceUpdates: true, currencyCode: "USD" },
      ]);

      // Accepted stored prices (security_prices): the $61 transaction-derived
      // observation from 2024 and the later manual $120 correction. Since the
      // store answers, the raw-transaction fallback is not queried.
      reportQuery.mockResolvedValueOnce([
        {
          security_id: "sec-skip",
          price_date: "2024-01-15",
          close_price: "61",
        },
        {
          security_id: "sec-skip",
          price_date: "2026-08-20",
          close_price: "120",
        },
      ]);

      const result = await service.getDailyInvestments(
        "user-1",
        "2026-08-21",
        "2026-08-21",
      );

      // 120 shares * $120 accepted close = $14,400 -- not 120 * $61 = $7,320.
      expect(result).toHaveLength(1);
      expect(result[0].value).toBe(14400);
    });

    // Issue #1242, daily as-of boundary: each day is valued at the latest
    // accepted close on or before it, and a future observation never leaks
    // back to an earlier day.
    it("values each day at the latest accepted close on or before it, never a future one (#1242)", async () => {
      prefRepository.findOne.mockResolvedValue({ defaultCurrency: "USD" });

      reportQuery.mockResolvedValueOnce([
        {
          id: "brok-1",
          account_type: "INVESTMENT",
          account_sub_type: "INVESTMENT_BROKERAGE",
          currency_code: "USD",
          opening_balance: 0,
        },
      ]);
      reportQuery.mockResolvedValueOnce([
        {
          account_id: "brok-1",
          security_id: "sec-skip",
          action: "BUY",
          quantity: "1",
          transaction_date: "2026-07-01",
        },
      ]);
      securityRepository.findByIds.mockResolvedValue([
        { id: "sec-skip", skipPriceUpdates: true, currencyCode: "USD" },
      ]);
      reportQuery.mockResolvedValueOnce([
        {
          security_id: "sec-skip",
          price_date: "2026-07-31",
          close_price: "100",
        },
        {
          security_id: "sec-skip",
          price_date: "2026-08-20",
          close_price: "120",
        },
      ]);

      const result = await service.getDailyInvestments(
        "user-1",
        "2026-08-01",
        "2026-08-21",
      );

      const valueOn = (date: string) =>
        result.find((p) => p.date === date)?.value;
      // 2026-08-01 predates the 2026-08-20 row, so it uses the 2026-07-31 $100.
      expect(valueOn("2026-08-01")).toBe(100);
      expect(valueOn("2026-08-20")).toBe(120);
      expect(valueOn("2026-08-21")).toBe(120);
    });

    // Issue #1242 MZ-1242-R1: a legacy restore leaves the holding with only a
    // FUTURE accepted stored price ($80 on 2025-03-01) while its earlier
    // history lives only in investment_transactions ($50 on 2024-01-15).
    // Keying the fallback off "does a stored row exist" reported the earlier
    // dates as $0; the chronological merge values them from the legacy history
    // and switches to the stored price once it is the newer observation.
    it("merges legacy transaction history under a later stored price (#1242)", async () => {
      prefRepository.findOne.mockResolvedValue({ defaultCurrency: "USD" });

      reportQuery.mockResolvedValueOnce([
        {
          id: "brok-1",
          account_type: "INVESTMENT",
          account_sub_type: "INVESTMENT_BROKERAGE",
          currency_code: "USD",
          opening_balance: 0,
        },
      ]);
      reportQuery.mockResolvedValueOnce([
        {
          account_id: "brok-1",
          security_id: "sec-legacy",
          action: "BUY",
          quantity: "100",
          transaction_date: "2024-01-15",
        },
      ]);
      securityRepository.findByIds.mockResolvedValue([
        { id: "sec-legacy", skipPriceUpdates: true, currencyCode: "USD" },
      ]);
      // loadStoredPriceSeries: only a future manual price falls in the window.
      reportQuery.mockResolvedValueOnce([
        {
          security_id: "sec-legacy",
          price_date: "2025-03-01",
          close_price: "80",
        },
      ]);
      // loadTxPriceSeries: the pre-window boundary carries the legacy $50.
      reportQuery.mockResolvedValueOnce([
        {
          security_id: "sec-legacy",
          transaction_date: "2024-01-15",
          price: "50",
        },
      ]);

      const result = await service.getDailyInvestments(
        "user-1",
        "2024-12-31",
        "2025-03-01",
      );

      const valueOn = (date: string) =>
        result.find((p) => p.date === date)?.value;
      // Before the stored price exists: 100 * $50 legacy = $5,000 (not $0).
      expect(valueOn("2024-12-31")).toBe(5000);
      // Once the stored price is the newer observation: 100 * $80 = $8,000.
      expect(valueOn("2025-03-01")).toBe(8000);
    });

    // MZ-1242-R7/R8/R10: the legacy transaction fallback query is bounded to
    // the window plus one boundary date (not a lifetime aggregate CTE), rounds
    // the same-day average to 6dp to match upsertTransactionPrice, and filters
    // on `price IS NOT NULL` -- not `price > 0`, which would drop a zero-price
    // disposal the canonical writer keeps.
    it("bounds, 6dp-rounds and null-filters the legacy transaction fallback query (#1242 R7/R8/R10)", async () => {
      prefRepository.findOne.mockResolvedValue({ defaultCurrency: "USD" });

      const seenSql: string[] = [];
      reportQuery.mockImplementation(async (sql: string) => {
        seenSql.push(sql);
        if (/FROM accounts a/.test(sql)) {
          return [
            {
              id: "brok-1",
              account_type: "INVESTMENT",
              account_sub_type: "INVESTMENT_BROKERAGE",
              currency_code: "USD",
              opening_balance: 0,
            },
          ];
        }
        // The holdings-replay read (no aggregate) needs one held security so the
        // valuation series -- including the fallback -- is loaded.
        if (
          /FROM\s+investment_transactions/.test(sql) &&
          !/boundary_dates/.test(sql)
        ) {
          return [
            {
              account_id: "brok-1",
              security_id: "sec-1",
              action: "BUY",
              quantity: "10",
              transaction_date: "2024-01-15",
            },
          ];
        }
        return [];
      });
      securityRepository.findByIds.mockResolvedValue([
        { id: "sec-1", skipPriceUpdates: false, currencyCode: "USD" },
      ]);

      await service.getDailyInvestments("user-1", "2026-08-15", "2026-08-22");

      const txSql = seenSql.find((s) => /boundary_dates/.test(s));
      expect(txSql).toBeDefined();
      // R8: same-day average rounded to the canonical 6 decimals.
      expect(txSql).toContain("ROUND(AVG(price::numeric), 6)");
      // R7: bounded -- a pre-window boundary date plus the in-window rows, no
      // unbounded all-time aggregate.
      expect(txSql).toContain("transaction_date < $3::DATE");
      expect(txSql).toContain("transaction_date >= $3::DATE");
      expect(txSql).toContain("transaction_date <= $4::DATE");
      expect(txSql).not.toMatch(/WITH\s+agg\s+AS/);
      // R10: matches the canonical writer's filter; a zero-price disposal is
      // kept, not excluded by `price > 0`.
      expect(txSql).toContain("price IS NOT NULL");
      expect(txSql).not.toMatch(/price\s*>\s*0/);
    });

    it("returns empty when accountIds resolve to no accounts", async () => {
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      // Linked account resolution returns empty
      reportQuery.mockResolvedValueOnce([]);

      const result = await service.getDailyInvestments(
        "user-1",
        "2025-03-01",
        "2025-03-01",
        ["nonexistent"],
      );

      expect(result).toEqual([]);
    });

    it("converts a USD security held in a CAD account to the default currency using the security's native currency", async () => {
      // Scenario: user has a CAD brokerage account holding a USD-denominated
      // security. Prices in security_prices are stored in USD, so they must
      // be converted from USD -> CAD (the default), not CAD -> CAD.
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "CAD",
      });

      // accounts query: CAD brokerage
      reportQuery.mockResolvedValueOnce([
        {
          id: "brok-cad",
          account_type: "INVESTMENT",
          account_sub_type: "INVESTMENT_BROKERAGE",
          currency_code: "CAD",
          opening_balance: 50000,
        },
      ]);

      // investment transactions: 100 shares @ $27.16 USD
      reportQuery.mockResolvedValueOnce([
        {
          account_id: "brok-cad",
          security_id: "sec-usd",
          action: "BUY",
          quantity: "100",
          transaction_date: "2025-02-01",
        },
      ]);

      // securities (USD-denominated)
      securityRepository.findByIds.mockResolvedValue([
        { id: "sec-usd", skipPriceUpdates: false, currencyCode: "USD" },
      ]);

      // security prices (previous trading day's close, in USD)
      reportQuery.mockResolvedValueOnce([
        {
          security_id: "sec-usd",
          price_date: "2025-02-28",
          close_price: "25.675",
        },
      ]);

      // loadTxPriceSeries fallback (no legacy transaction prices)
      reportQuery.mockResolvedValueOnce([]);

      // exchange rates (USD -> CAD)
      reportQuery.mockResolvedValueOnce([
        {
          from_currency: "USD",
          to_currency: "CAD",
          rate: "1.35",
          rate_date: "2025-02-28",
        },
      ]);

      const result = await service.getDailyInvestments(
        "user-1",
        "2025-03-01",
        "2025-03-01",
      );

      // 100 shares * $25.675 USD = $2,567.50 USD
      // $2,567.50 USD * 1.35 = $3,466.125 CAD -> rounded to 3466
      expect(result).toHaveLength(1);
      expect(result[0].value).toBe(3466);
    });

    // Same defect as issue #1081 on the total series: omitting startDate used
    // to enumerate a point per day back to 1990.
    it("starts at the scope's earliest activity when no startDate is given", async () => {
      prefRepository.findOne.mockResolvedValue({ defaultCurrency: "USD" });

      // accounts
      reportQuery.mockResolvedValueOnce([
        {
          id: "brok-1",
          account_type: "INVESTMENT",
          account_sub_type: "INVESTMENT_BROKERAGE",
          currency_code: "USD",
          opening_balance: 0,
        },
      ]);
      // inception
      reportQuery.mockResolvedValueOnce([{ earliest: "2025-03-01" }]);
      // investment transactions
      reportQuery.mockResolvedValueOnce([
        {
          account_id: "brok-1",
          security_id: "sec-1",
          action: "BUY",
          quantity: "10",
          transaction_date: "2025-03-01",
        },
      ]);
      securityRepository.findByIds.mockResolvedValue([
        { id: "sec-1", skipPriceUpdates: false },
      ]);
      // prices
      reportQuery.mockResolvedValueOnce([
        { security_id: "sec-1", price_date: "2025-03-01", close_price: "100" },
      ]);

      const result = await service.getDailyInvestments(
        "user-1",
        undefined,
        "2025-03-03",
      );

      expect(result.map((p) => p.date)).toEqual([
        "2025-03-01",
        "2025-03-02",
        "2025-03-03",
      ]);
    });
  });

  describe("getInvestmentBreakdown", () => {
    it("returns an empty breakdown when no accounts match", async () => {
      prefRepository.findOne.mockResolvedValue({ defaultCurrency: "USD" });
      // accounts query returns empty
      reportQuery.mockResolvedValueOnce([]);

      const result = await service.getInvestmentBreakdown("user-1", {
        granularity: "monthly",
      });

      expect(result).toEqual({
        granularity: "monthly",
        currency: "USD",
        // Nothing to convert is complete, not unknown.
        fxComplete: true,
        missingRatePairs: [],
        series: [],
        points: [],
      });
    });

    it("builds a monthly per-security breakdown with a cash band", async () => {
      prefRepository.findOne.mockResolvedValue({ defaultCurrency: "USD" });

      // accounts: one brokerage + one cash account
      reportQuery.mockResolvedValueOnce([
        {
          id: "brok-1",
          account_type: "INVESTMENT",
          account_sub_type: "INVESTMENT_BROKERAGE",
          currency_code: "USD",
          opening_balance: 0,
        },
        {
          id: "cash-1",
          account_type: "INVESTMENT",
          account_sub_type: "INVESTMENT_CASH",
          currency_code: "USD",
          opening_balance: 5000,
        },
      ]);

      // investment transactions
      reportQuery.mockResolvedValueOnce([
        {
          account_id: "brok-1",
          security_id: "sec-1",
          action: "BUY",
          quantity: "10",
          transaction_date: "2024-05-15",
        },
      ]);

      securityRepository.findByIds.mockResolvedValue([
        {
          id: "sec-1",
          symbol: "AAPL",
          name: "Apple Inc.",
          currencyCode: "USD",
          skipPriceUpdates: false,
        },
      ]);

      // month-end security prices (loadStoredPriceSeries)
      reportQuery.mockResolvedValueOnce([
        { security_id: "sec-1", price_date: "2024-05-31", close_price: "100" },
        { security_id: "sec-1", price_date: "2024-06-28", close_price: "110" },
      ]);

      // loadTxPriceSeries fallback (no legacy transaction prices)
      reportQuery.mockResolvedValueOnce([]);

      // monthly cash balances
      reportQuery.mockResolvedValueOnce([
        { account_id: "cash-1", month: "2024-05-01", balance: "5000" },
        { account_id: "cash-1", month: "2024-06-01", balance: "5000" },
      ]);

      const result = await service.getInvestmentBreakdown("user-1", {
        granularity: "monthly",
        startDate: "2024-05-01",
        endDate: "2024-06-30",
      });

      expect(result.currency).toBe("USD");
      expect(result.series).toEqual([
        { key: "sec-1", type: "security", symbol: "AAPL", name: "Apple Inc." },
        { key: "cash", type: "cash", symbol: null, name: "" },
      ]);
      expect(result.points).toHaveLength(2);
      expect(result.points[0]).toEqual({
        date: "2024-05-01",
        total: 6000,
        values: { "sec-1": 1000, cash: 5000 },
      });
      expect(result.points[1]).toEqual({
        date: "2024-06-01",
        total: 6100,
        values: { "sec-1": 1100, cash: 5000 },
      });
    });

    it("values each daily point at the latest close on or before the date", async () => {
      prefRepository.findOne.mockResolvedValue({ defaultCurrency: "USD" });

      reportQuery.mockResolvedValueOnce([
        {
          id: "brok-1",
          account_type: "INVESTMENT",
          account_sub_type: "INVESTMENT_BROKERAGE",
          currency_code: "USD",
          opening_balance: 0,
        },
      ]);
      reportQuery.mockResolvedValueOnce([
        {
          account_id: "brok-1",
          security_id: "sec-1",
          action: "BUY",
          quantity: "10",
          transaction_date: "2025-02-01",
        },
      ]);
      securityRepository.findByIds.mockResolvedValue([
        {
          id: "sec-1",
          symbol: "MSFT",
          name: "Microsoft",
          currencyCode: "USD",
          skipPriceUpdates: false,
        },
      ]);
      reportQuery.mockResolvedValueOnce([
        { security_id: "sec-1", price_date: "2025-02-28", close_price: "99" },
        { security_id: "sec-1", price_date: "2025-03-01", close_price: "100" },
      ]);

      const result = await service.getInvestmentBreakdown("user-1", {
        granularity: "daily",
        startDate: "2025-03-01",
        endDate: "2025-03-02",
      });

      expect(result.series).toEqual([
        { key: "sec-1", type: "security", symbol: "MSFT", name: "Microsoft" },
      ]);
      expect(result.points).toEqual([
        { date: "2025-03-01", total: 1000, values: { "sec-1": 1000 } },
        { date: "2025-03-02", total: 1000, values: { "sec-1": 1000 } },
      ]);
    });

    // Issue #1242, by-security daily: a skipPriceUpdates security's band uses
    // its accepted stored close, and the point total equals the sum of the
    // security components.
    it("values a skipPriceUpdates security's daily band from its accepted stored price (#1242)", async () => {
      prefRepository.findOne.mockResolvedValue({ defaultCurrency: "USD" });

      reportQuery.mockResolvedValueOnce([
        {
          id: "brok-1",
          account_type: "INVESTMENT",
          account_sub_type: "INVESTMENT_BROKERAGE",
          currency_code: "USD",
          opening_balance: 0,
        },
      ]);
      reportQuery.mockResolvedValueOnce([
        {
          account_id: "brok-1",
          security_id: "sec-skip",
          action: "BUY",
          quantity: "120",
          transaction_date: "2024-01-15",
        },
      ]);
      securityRepository.findByIds.mockResolvedValue([
        {
          id: "sec-skip",
          symbol: "BMT-DEMO",
          name: "Broad Market Tracker",
          currencyCode: "USD",
          skipPriceUpdates: true,
        },
      ]);
      reportQuery.mockResolvedValueOnce([
        {
          security_id: "sec-skip",
          price_date: "2026-08-20",
          close_price: "120",
        },
      ]);

      const result = await service.getInvestmentBreakdown("user-1", {
        granularity: "daily",
        startDate: "2026-08-21",
        endDate: "2026-08-21",
      });

      expect(result.points).toHaveLength(1);
      // 120 * $120 = $14,400 -- the band and the point total agree.
      expect(result.points[0].values["sec-skip"]).toBe(14400);
      expect(result.points[0].total).toBe(14400);
    });

    // Issue #1242, by-security monthly: same invariant at the month-end
    // sampling boundary.
    it("values a skipPriceUpdates security's monthly band from its accepted stored price (#1242)", async () => {
      prefRepository.findOne.mockResolvedValue({ defaultCurrency: "USD" });

      reportQuery.mockResolvedValueOnce([
        {
          id: "brok-1",
          account_type: "INVESTMENT",
          account_sub_type: "INVESTMENT_BROKERAGE",
          currency_code: "USD",
          opening_balance: 0,
        },
      ]);
      reportQuery.mockResolvedValueOnce([
        {
          account_id: "brok-1",
          security_id: "sec-skip",
          action: "BUY",
          quantity: "120",
          transaction_date: "2024-01-15",
        },
      ]);
      securityRepository.findByIds.mockResolvedValue([
        {
          id: "sec-skip",
          symbol: "BMT-DEMO",
          name: "Broad Market Tracker",
          currencyCode: "USD",
          skipPriceUpdates: true,
        },
      ]);
      // Full accepted series; the monthly sampler takes the latest close on or
      // before each month end.
      reportQuery.mockResolvedValueOnce([
        {
          security_id: "sec-skip",
          price_date: "2026-07-31",
          close_price: "100",
        },
        {
          security_id: "sec-skip",
          price_date: "2026-08-20",
          close_price: "120",
        },
      ]);

      const result = await service.getInvestmentBreakdown("user-1", {
        granularity: "monthly",
        startDate: "2026-07-01",
        endDate: "2026-08-31",
      });

      const july = result.points.find((p) => p.date === "2026-07-01");
      const august = result.points.find((p) => p.date === "2026-08-01");
      // July month-end (2026-07-31) -> $100; August month-end -> $120.
      expect(july?.values["sec-skip"]).toBe(12000);
      expect(july?.total).toBe(12000);
      expect(august?.values["sec-skip"]).toBe(14400);
      expect(august?.total).toBe(14400);
    });

    it("rolls securities beyond the limit into a single 'other' band", async () => {
      prefRepository.findOne.mockResolvedValue({ defaultCurrency: "USD" });

      reportQuery.mockResolvedValueOnce([
        {
          id: "brok-1",
          account_type: "INVESTMENT",
          account_sub_type: "INVESTMENT_BROKERAGE",
          currency_code: "USD",
          opening_balance: 0,
        },
      ]);
      reportQuery.mockResolvedValueOnce([
        {
          account_id: "brok-1",
          security_id: "sec-1",
          action: "BUY",
          quantity: "10",
          transaction_date: "2024-05-15",
        },
        {
          account_id: "brok-1",
          security_id: "sec-2",
          action: "BUY",
          quantity: "5",
          transaction_date: "2024-05-15",
        },
      ]);
      securityRepository.findByIds.mockResolvedValue([
        {
          id: "sec-1",
          symbol: "AAA",
          name: "Alpha",
          currencyCode: "USD",
          skipPriceUpdates: false,
        },
        {
          id: "sec-2",
          symbol: "BBB",
          name: "Beta",
          currencyCode: "USD",
          skipPriceUpdates: false,
        },
      ]);
      reportQuery.mockResolvedValueOnce([
        { security_id: "sec-1", price_date: "2024-05-31", close_price: "100" },
        { security_id: "sec-2", price_date: "2024-05-31", close_price: "50" },
      ]);

      const result = await service.getInvestmentBreakdown("user-1", {
        granularity: "monthly",
        startDate: "2024-05-01",
        endDate: "2024-05-31",
        limit: 1,
      });

      // sec-1 (peak 1000) keeps its band; sec-2 (peak 250) rolls into "other".
      expect(result.series).toEqual([
        { key: "sec-1", type: "security", symbol: "AAA", name: "Alpha" },
        { key: "other", type: "other", symbol: null, name: "" },
      ]);
      expect(result.points).toEqual([
        {
          date: "2024-05-01",
          total: 1250,
          values: { "sec-1": 1000, other: 250 },
        },
      ]);
    });

    // Issue #1081: "all time" sent no startDate, which defaulted to a fixed
    // 1990 epoch. The per-security series enumerates every sample between
    // start and end, so the chart opened with three decades of empty months
    // and flattened the real data against the x-axis.
    describe('"all time" (no startDate)', () => {
      it("starts at the scope's earliest activity, not a fixed epoch", async () => {
        prefRepository.findOne.mockResolvedValue({ defaultCurrency: "USD" });

        // accounts
        reportQuery.mockResolvedValueOnce([
          {
            id: "brok-1",
            account_type: "INVESTMENT",
            account_sub_type: "INVESTMENT_BROKERAGE",
            currency_code: "USD",
            opening_balance: 0,
          },
        ]);
        // inception: earliest transaction across the scope
        reportQuery.mockResolvedValueOnce([{ earliest: "2025-01-01" }]);
        // investment transactions
        reportQuery.mockResolvedValueOnce([
          {
            account_id: "brok-1",
            security_id: "sec-1",
            action: "BUY",
            quantity: "10",
            transaction_date: "2025-01-10",
          },
        ]);
        securityRepository.findByIds.mockResolvedValue([
          {
            id: "sec-1",
            symbol: "AAPL",
            name: "Apple Inc.",
            currencyCode: "USD",
            skipPriceUpdates: false,
          },
        ]);
        // month-end prices
        reportQuery.mockResolvedValueOnce([
          {
            security_id: "sec-1",
            price_date: "2025-01-31",
            close_price: "100",
          },
        ]);

        const result = await service.getInvestmentBreakdown("user-1", {
          granularity: "monthly",
          endDate: "2025-03-31",
        });

        expect(result.points.map((p) => p.date)).toEqual([
          "2025-01-01",
          "2025-02-01",
          "2025-03-01",
        ]);

        // The inception lookup is scoped to the resolved accounts, and every
        // downstream query inherits its date rather than the epoch.
        const inceptionCall = reportQuery.mock.calls.find(([sql]: [string]) =>
          /first_inv/.test(sql),
        );
        expect(inceptionCall[1]).toEqual([["brok-1"]]);
        const priceCall = reportQuery.mock.calls.find(([sql]: [string]) =>
          /FROM security_prices/.test(sql),
        );
        expect(JSON.stringify(priceCall[1])).not.toContain("1990");
      });

      it("falls back to the account creation date when there is no activity", async () => {
        prefRepository.findOne.mockResolvedValue({ defaultCurrency: "USD" });

        reportQuery.mockResolvedValueOnce([
          {
            id: "cash-1",
            account_type: "INVESTMENT",
            account_sub_type: "INVESTMENT_CASH",
            currency_code: "USD",
            opening_balance: 250,
          },
        ]);
        // No transactions anywhere, so the SQL COALESCEs to created_at.
        reportQuery.mockResolvedValueOnce([{ earliest: "2025-02-01" }]);
        // monthly cash balances (no brokerage ids, so no investment tx query)
        reportQuery.mockResolvedValueOnce([
          { account_id: "cash-1", month: "2025-02-01", balance: "250" },
          { account_id: "cash-1", month: "2025-03-01", balance: "250" },
        ]);

        const result = await service.getInvestmentBreakdown("user-1", {
          granularity: "monthly",
          endDate: "2025-03-31",
        });

        expect(result.points.map((p) => p.date)).toEqual([
          "2025-02-01",
          "2025-03-01",
        ]);
      });

      // The inception lookup can come back with nothing to say -- a row whose
      // aggregate is NULL, or no row at all. Neither is licence to reach for a
      // made-up start: fall back to the window end, which yields the single
      // point "today" rather than an invented history.
      it.each([
        ["a NULL aggregate", [{ earliest: null }]],
        ["no rows at all", []],
      ])(
        "falls back to the window end on %s",
        async (_label, inceptionRows) => {
          prefRepository.findOne.mockResolvedValue({ defaultCurrency: "USD" });

          reportQuery.mockResolvedValueOnce([
            {
              id: "cash-1",
              account_type: "INVESTMENT",
              account_sub_type: "INVESTMENT_CASH",
              currency_code: "USD",
              opening_balance: 0,
            },
          ]);
          reportQuery.mockResolvedValueOnce(inceptionRows);
          reportQuery.mockResolvedValueOnce([]);

          const result = await service.getInvestmentBreakdown("user-1", {
            granularity: "monthly",
            endDate: "2025-03-31",
          });

          expect(result.points.map((p) => p.date)).toEqual(["2025-03-01"]);
        },
      );

      it("clamps an inception later than the window end to a single point", async () => {
        prefRepository.findOne.mockResolvedValue({ defaultCurrency: "USD" });

        reportQuery.mockResolvedValueOnce([
          {
            id: "cash-1",
            account_type: "INVESTMENT",
            account_sub_type: "INVESTMENT_CASH",
            currency_code: "USD",
            opening_balance: 0,
          },
        ]);
        // Account created after the requested end date.
        reportQuery.mockResolvedValueOnce([{ earliest: "2025-06-01" }]);
        reportQuery.mockResolvedValueOnce([]);

        const result = await service.getInvestmentBreakdown("user-1", {
          granularity: "monthly",
          endDate: "2025-03-31",
        });

        expect(result.points.map((p) => p.date)).toEqual(["2025-03-01"]);
      });

      it("skips the inception lookup when a startDate is supplied", async () => {
        prefRepository.findOne.mockResolvedValue({ defaultCurrency: "USD" });

        reportQuery.mockResolvedValueOnce([
          {
            id: "cash-1",
            account_type: "INVESTMENT",
            account_sub_type: "INVESTMENT_CASH",
            currency_code: "USD",
            opening_balance: 0,
          },
        ]);
        reportQuery.mockResolvedValueOnce([]);

        await service.getInvestmentBreakdown("user-1", {
          granularity: "monthly",
          startDate: "2025-03-01",
          endDate: "2025-03-31",
        });

        expect(
          reportQuery.mock.calls.some(([sql]: [string]) =>
            /first_inv/.test(sql),
          ),
        ).toBe(false);
      });
    });
  });

  /**
   * A fixed-epoch fallback is only safe where the query's own rows bound the
   * output. `getMonthlyNetWorth` and `getMonthlyInvestments` read stored
   * `monthly_account_balances` rows, which start at each account's own
   * inception, so an over-wide window selects nothing extra. A method that
   * *enumerates* its sample points from the window instead -- the daily and
   * per-security replays -- turns the same fallback into three decades of
   * empty chart, which is what issue #1081 reported. Prose did not stop it
   * being written twice, so the allowlist is the rule.
   */
  describe("no new fixed-epoch window default", () => {
    it("only the snapshot-bounded readers fall back to a hardcoded start date", () => {
      const source = fs.readFileSync(
        path.join(__dirname, "net-worth.service.ts"),
        "utf8",
      );
      const lines = source.split("\n");

      // Every method opened in the file, so an offending line can name the
      // method it sits in rather than a line number nobody can act on.
      const owners: string[] = [];
      let current = "(file scope)";
      for (const line of lines) {
        const declared =
          /^\s{2}(?:private |public |protected )?(?:async )?([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(
            line,
          );
        if (declared) current = declared[1];
        owners.push(current);
      }

      const ALLOWED = new Set(["getMonthlyNetWorth", "getMonthlyInvestments"]);
      const offenders = lines
        .map((line, i) => ({ line, owner: owners[i] }))
        .filter(({ line }) => /\|\|\s*"\d{4}-\d{2}-\d{2}"/.test(line))
        .filter(({ owner }) => !ALLOWED.has(owner))
        .map(({ line, owner }) => `${owner}: ${line.trim()}`);

      expect(offenders).toEqual([]);
    });
  });
});
