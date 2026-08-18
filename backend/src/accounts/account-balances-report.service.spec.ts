import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { AccountBalancesReportService } from "./account-balances-report.service";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { UserPreference } from "../users/entities/user-preference.entity";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

// The market date is clamped against today, so today has to be a fixture --
// otherwise "is this date in the future" is a question about the day the suite
// happens to run on.
jest.mock("../common/date-utils", () => ({
  todayYMD: jest.fn(() => "2026-08-18"),
}));

/**
 * Point-in-time balances, per `docs/specs/account-balances-as-of.md` section 8.
 *
 * The queries are dispatched by what they select rather than by call order:
 * the prices and the security currencies are fetched concurrently, so an
 * ordered `mockResolvedValueOnce` chain would be asserting the scheduler.
 */
interface Fixture {
  accounts?: any[];
  balances?: Array<{ id: string; balance: string }>;
  investmentTransactions?: any[];
  prices?: Array<{
    security_id: string;
    price_date: string;
    close_price: string;
  }>;
  securities?: Array<{ id: string; currency_code: string }>;
  rates?: Array<{
    from_currency: string;
    to_currency: string;
    rate_date: string;
    rate: string;
  }>;
}

describe("AccountBalancesReportService", () => {
  let service: AccountBalancesReportService;
  let query: jest.Mock;
  let preferencesRepo: { findOne: jest.Mock };

  const program = (fixture: Fixture) => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM accounts\n") && sql.includes("account_sub_type")) {
        return fixture.accounts ?? [];
      }
      if (
        sql.includes("opening_balance") &&
        sql.includes("LEFT JOIN transactions")
      ) {
        return fixture.balances ?? [];
      }
      if (sql.includes("FROM investment_transactions")) {
        return fixture.investmentTransactions ?? [];
      }
      if (sql.includes("FROM security_prices")) {
        return fixture.prices ?? [];
      }
      if (sql.includes("FROM securities")) {
        return fixture.securities ?? [];
      }
      if (sql.includes("FROM exchange_rates")) {
        return fixture.rates ?? [];
      }
      throw new Error(`unexpected query: ${sql}`);
    });
  };

  beforeEach(async () => {
    preferencesRepo = {
      findOne: jest.fn().mockResolvedValue({ defaultCurrency: "CAD" }),
    };
    const mocks = createScopedDbMocks([[UserPreference, preferencesRepo]]);
    query = mocks.manager.query;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountBalancesReportService,
        { provide: DataSource, useValue: mocks.dataSource },
      ],
    }).compile();

    service = module.get(AccountBalancesReportService);
  });

  const cheque = {
    id: "acc-1",
    currency_code: "CAD",
    account_type: "CHEQUING",
    account_sub_type: null,
  };
  const brokerage = {
    id: "acc-b",
    currency_code: "CAD",
    account_type: "INVESTMENT",
    account_sub_type: "INVESTMENT_BROKERAGE",
  };

  // An empty answer still has a reporting currency; leaving it out would make
  // the client guess which currency its zeroes are in.
  it("returns nothing at all when the caller has no accounts", async () => {
    program({ accounts: [] });
    const result = await service.getBalancesAsOf("user-1", "2026-03-01");
    expect(result).toEqual({
      asOfDate: "2026-03-01",
      displayCurrency: "CAD",
      displayRates: { CAD: 1 },
      accounts: [],
    });
  });

  describe("presenting every account in one currency", () => {
    const usdSavings = {
      id: "acc-usd",
      currency_code: "USD",
      account_type: "SAVINGS",
      account_sub_type: null,
    };

    // A point-in-time report converts at that point in time: asked what an
    // account held in 2019, "what it was worth then" is the question, and
    // today's rate answers a different one.
    it("resolves each account currency at the rate stored for the date", async () => {
      program({
        accounts: [cheque, usdSavings],
        balances: [
          { id: "acc-1", balance: "100" },
          { id: "acc-usd", balance: "50" },
        ],
        rates: [
          {
            from_currency: "USD",
            to_currency: "CAD",
            rate_date: "2026-02-27",
            rate: "1.35",
          },
        ],
      });
      const result = await service.getBalancesAsOf("user-1", "2026-03-01");
      expect(result.displayCurrency).toBe("CAD");
      expect(result.displayRates).toEqual({ CAD: 1, USD: 1.35 });
    });

    // Same currency is 1:1 by definition, and it has to stay distinguishable
    // from the missing case -- which is why the map carries it explicitly.
    it("carries the display currency at 1", async () => {
      program({
        accounts: [cheque],
        balances: [{ id: "acc-1", balance: "1" }],
      });
      const result = await service.getBalancesAsOf("user-1", "2026-03-01");
      expect(result.displayRates).toEqual({ CAD: 1 });
    });

    // Omitted, never 1. A currency given a fallback rate is an account
    // presented at a number nobody quoted.
    it("omits a currency with no accepted rate rather than defaulting it", async () => {
      program({
        accounts: [cheque, usdSavings],
        balances: [
          { id: "acc-1", balance: "100" },
          { id: "acc-usd", balance: "50" },
        ],
        rates: [],
      });
      const result = await service.getBalancesAsOf("user-1", "2026-03-01");
      expect(result.displayRates).toEqual({ CAD: 1 });
      expect(result.displayRates.USD).toBeUndefined();
    });

    it("resolves a pair stored only in the reverse direction", async () => {
      program({
        accounts: [cheque, usdSavings],
        balances: [
          { id: "acc-1", balance: "100" },
          { id: "acc-usd", balance: "50" },
        ],
        rates: [
          {
            from_currency: "CAD",
            to_currency: "USD",
            rate_date: "2026-02-27",
            rate: "0.8",
          },
        ],
      });
      const result = await service.getBalancesAsOf("user-1", "2026-03-01");
      expect(result.displayRates.USD).toBeCloseTo(1.25, 10);
    });

    it("falls back to USD when the user has stated no reporting currency", async () => {
      preferencesRepo.findOne.mockResolvedValue(null);
      program({
        accounts: [cheque],
        balances: [{ id: "acc-1", balance: "1" }],
      });
      const result = await service.getBalancesAsOf("user-1", "2026-03-01");
      expect(result.displayCurrency).toBe("USD");
    });
  });

  // The ledger runs ahead of the market: a transaction can be dated next year,
  // a close cannot. Without the clamp `closeAt` refuses its own inputs -- a
  // report dated a year out finds today's close 365 days stale and calls every
  // position unpriced.
  describe("a date in the future", () => {
    it("sums the ledger to the requested date but reads the market at today", async () => {
      program({
        accounts: [brokerage],
        balances: [{ id: "acc-b", balance: "0" }],
        investmentTransactions: [
          {
            account_id: "acc-b",
            security_id: "sec-1",
            action: "BUY",
            quantity: "10",
          },
        ],
        prices: [
          { security_id: "sec-1", price_date: "2026-08-17", close_price: "22" },
        ],
        securities: [{ id: "sec-1", currency_code: "CAD" }],
      });
      const result = await service.getBalancesAsOf("user-1", "2027-06-30");

      // The ledger is asked about the future date...
      const ledgerCall = query.mock.calls.find(([sql]: [string]) =>
        sql.includes("LEFT JOIN transactions"),
      );
      expect(ledgerCall[1][1]).toBe("2027-06-30");
      const replayCall = query.mock.calls.find(([sql]: [string]) =>
        sql.includes("FROM investment_transactions"),
      );
      expect(replayCall[1][1]).toBe("2027-06-30");

      // ...and the market about today.
      const priceCall = query.mock.calls.find(([sql]: [string]) =>
        sql.includes("FROM security_prices"),
      );
      expect(priceCall[1][1]).toBe("2026-08-18");
      expect(priceCall[1][2]).toBe("2026-08-04");
      const rateCall = query.mock.calls.find(([sql]: [string]) =>
        sql.includes("FROM exchange_rates"),
      );
      expect(rateCall[1]).toEqual(["2026-08-18", "2026-08-04"]);

      // The position is held at the latest close, not called unpriced.
      expect(result.accounts[0]).toMatchObject({
        marketValue: 220,
        valuationComplete: true,
      });
    });

    it("still converts for presentation on a far-future date", async () => {
      program({
        accounts: [
          {
            id: "acc-usd",
            currency_code: "USD",
            account_type: "SAVINGS",
            account_sub_type: null,
          },
        ],
        balances: [{ id: "acc-usd", balance: "50" }],
        rates: [
          {
            from_currency: "USD",
            to_currency: "CAD",
            rate_date: "2026-08-17",
            rate: "1.35",
          },
        ],
      });
      const result = await service.getBalancesAsOf("user-1", "2030-01-01");
      expect(result.displayRates).toEqual({ CAD: 1, USD: 1.35 });
    });
  });

  it("echoes the date it measured, so the payload carries its own request key", async () => {
    program({
      accounts: [cheque],
      balances: [{ id: "acc-1", balance: "150" }],
    });
    const result = await service.getBalancesAsOf("user-1", "2026-03-01");
    expect(result.asOfDate).toBe("2026-03-01");
  });

  // The ledger sum is the one `recalculateCurrentBalance` uses with the
  // caller's date in place of today; the SQL predicate is the claim.
  it("sums the ledger with the caller's date, excluding void and split-child rows", async () => {
    program({
      accounts: [cheque],
      balances: [{ id: "acc-1", balance: "150" }],
    });
    await service.getBalancesAsOf("user-1", "2026-03-01");

    const ledgerCall = query.mock.calls.find(([sql]: [string]) =>
      sql.includes("LEFT JOIN transactions"),
    );
    expect(ledgerCall[0]).toContain("t.status != 'VOID'");
    expect(ledgerCall[0]).toContain("t.parent_transaction_id IS NULL");
    expect(ledgerCall[0]).toContain("t.transaction_date <= $2");
    expect(ledgerCall[1]).toEqual(["user-1", "2026-03-01", [], null]);
  });

  it("reports the ledger balance in the account's own currency", async () => {
    program({
      accounts: [cheque],
      balances: [{ id: "acc-1", balance: "175.5000" }],
    });
    const result = await service.getBalancesAsOf("user-1", "2026-06-30");
    expect(result.accounts[0]).toMatchObject({
      accountId: "acc-1",
      currencyCode: "CAD",
      balance: 175.5,
    });
  });

  // A ledger sum over rows the database holds is always known, and an account
  // with nothing before the date sits at its opening balance -- the query
  // returns that, and a row the query did not answer for is 0, not null.
  it("never reports an unknown ledger balance", async () => {
    program({ accounts: [cheque], balances: [] });
    const result = await service.getBalancesAsOf("user-1", "2026-06-30");
    expect(result.accounts[0].balance).toBe(0);
  });

  it("does not report a market value for an account that holds no securities", async () => {
    program({ accounts: [cheque], balances: [{ id: "acc-1", balance: "10" }] });
    const result = await service.getBalancesAsOf("user-1", "2026-06-30");
    expect(result.accounts[0]).toMatchObject({
      marketValue: null,
      knownMarketValueSubtotal: 0,
      // "Does not apply" is not "could not be worked out".
      valuationComplete: true,
      pricesComplete: true,
      fxComplete: true,
    });
    // No holdings accounts, so no replay and no price lookup at all.
    expect(
      query.mock.calls.some(([sql]: [string]) =>
        sql.includes("investment_transactions"),
      ),
    ).toBe(false);
  });

  it("values a holding at the last close on or before the date", async () => {
    program({
      accounts: [brokerage],
      balances: [{ id: "acc-b", balance: "0" }],
      investmentTransactions: [
        {
          account_id: "acc-b",
          security_id: "sec-1",
          action: "BUY",
          quantity: "10",
        },
      ],
      prices: [
        { security_id: "sec-1", price_date: "2026-02-27", close_price: "22" },
      ],
      securities: [{ id: "sec-1", currency_code: "CAD" }],
    });
    const result = await service.getBalancesAsOf("user-1", "2026-03-01");
    expect(result.accounts[0]).toMatchObject({
      marketValue: 220,
      knownMarketValueSubtotal: 220,
      valuationComplete: true,
    });

    const priceCall = query.mock.calls.find(([sql]: [string]) =>
      sql.includes("FROM security_prices"),
    );
    expect(priceCall[0]).toContain("price_date <= $2");
    expect(priceCall[1][1]).toBe("2026-03-01");
    // Bounded below as well, so the query loads exactly the window `closeAt`
    // will accept -- the read and the door agree on one staleness rule.
    expect(priceCall[0]).toContain("price_date >= $3");
    expect(priceCall[1][2]).toBe("2026-02-15");
  });

  // `docs/time-series-contract.md` section 2.1: an instrument last quoted
  // months ago has no price *for* this date, and answering with the old close
  // would report it as having gone nowhere since.
  it("treats a close older than the boundary window as no price for the date", async () => {
    program({
      accounts: [brokerage],
      balances: [{ id: "acc-b", balance: "0" }],
      investmentTransactions: [
        {
          account_id: "acc-b",
          security_id: "sec-1",
          action: "BUY",
          quantity: "10",
        },
      ],
      prices: [
        { security_id: "sec-1", price_date: "2025-01-02", close_price: "22" },
      ],
      securities: [{ id: "sec-1", currency_code: "CAD" }],
    });
    const result = await service.getBalancesAsOf("user-1", "2026-03-01");
    expect(result.accounts[0]).toMatchObject({
      marketValue: null,
      unpricedHoldingsCount: 1,
      pricesComplete: false,
    });
  });

  // A close a few days old is what prices a boundary the market was shut on.
  it("carries a close forward across a weekend", async () => {
    program({
      accounts: [brokerage],
      balances: [{ id: "acc-b", balance: "0" }],
      investmentTransactions: [
        {
          account_id: "acc-b",
          security_id: "sec-1",
          action: "BUY",
          quantity: "10",
        },
      ],
      prices: [
        { security_id: "sec-1", price_date: "2026-02-27", close_price: "22" },
      ],
      securities: [{ id: "sec-1", currency_code: "CAD" }],
    });
    const result = await service.getBalancesAsOf("user-1", "2026-03-01");
    expect(result.accounts[0].marketValue).toBe(220);
  });

  it("takes the latest close in the window, not the first", async () => {
    program({
      accounts: [brokerage],
      balances: [{ id: "acc-b", balance: "0" }],
      investmentTransactions: [
        {
          account_id: "acc-b",
          security_id: "sec-1",
          action: "BUY",
          quantity: "10",
        },
      ],
      prices: [
        { security_id: "sec-1", price_date: "2026-02-20", close_price: "18" },
        { security_id: "sec-1", price_date: "2026-02-27", close_price: "22" },
      ],
      securities: [{ id: "sec-1", currency_code: "CAD" }],
    });
    const result = await service.getBalancesAsOf("user-1", "2026-03-01");
    expect(result.accounts[0].marketValue).toBe(220);
  });

  // A SPLIT's quantity is a ratio, and every replay in the codebase folds it
  // through `applyActionToQuantity` for exactly this reason.
  it("multiplies by a split ratio and honours ADD_SHARES / REMOVE_SHARES", async () => {
    program({
      accounts: [brokerage],
      balances: [{ id: "acc-b", balance: "0" }],
      investmentTransactions: [
        {
          account_id: "acc-b",
          security_id: "sec-1",
          action: "BUY",
          quantity: "10",
        },
        {
          account_id: "acc-b",
          security_id: "sec-1",
          action: "SPLIT",
          quantity: "2",
        },
        {
          account_id: "acc-b",
          security_id: "sec-1",
          action: "ADD_SHARES",
          quantity: "5",
        },
        {
          account_id: "acc-b",
          security_id: "sec-1",
          action: "REMOVE_SHARES",
          quantity: "3",
        },
      ],
      prices: [
        { security_id: "sec-1", price_date: "2026-02-27", close_price: "10" },
      ],
      securities: [{ id: "sec-1", currency_code: "CAD" }],
    });
    const result = await service.getBalancesAsOf("user-1", "2026-03-01");
    // 10 shares, doubled to 20, +5, -3 = 22 at 10 = 220.
    expect(result.accounts[0].marketValue).toBe(220);
  });

  it("excludes void investment rows and rows after the date in SQL", async () => {
    program({
      accounts: [brokerage],
      balances: [{ id: "acc-b", balance: "0" }],
      investmentTransactions: [],
    });
    await service.getBalancesAsOf("user-1", "2026-03-01");
    const replayCall = query.mock.calls.find(([sql]: [string]) =>
      sql.includes("FROM investment_transactions"),
    );
    expect(replayCall[0]).toContain("status != 'VOID'");
    expect(replayCall[0]).toContain("transaction_date <= $2");
    expect(replayCall[1][1]).toBe("2026-03-01");
  });

  // A total whose components are not all known is null; the part that is known
  // travels beside it under a name that says what it is.
  it("withholds the total when a held position has no price at the date", async () => {
    program({
      accounts: [brokerage],
      balances: [{ id: "acc-b", balance: "0" }],
      investmentTransactions: [
        {
          account_id: "acc-b",
          security_id: "sec-1",
          action: "BUY",
          quantity: "10",
        },
        {
          account_id: "acc-b",
          security_id: "sec-2",
          action: "BUY",
          quantity: "4",
        },
      ],
      prices: [
        { security_id: "sec-1", price_date: "2026-02-27", close_price: "22" },
      ],
      securities: [
        { id: "sec-1", currency_code: "CAD" },
        { id: "sec-2", currency_code: "CAD" },
      ],
    });
    const result = await service.getBalancesAsOf("user-1", "2026-03-01");
    expect(result.accounts[0]).toMatchObject({
      marketValue: null,
      knownMarketValueSubtotal: 220,
      unpricedHoldingsCount: 1,
      pricesComplete: false,
      fxComplete: true,
      valuationComplete: false,
    });
  });

  it("withholds the total and names the pair when a position cannot be converted", async () => {
    program({
      accounts: [brokerage],
      balances: [{ id: "acc-b", balance: "0" }],
      investmentTransactions: [
        {
          account_id: "acc-b",
          security_id: "sec-1",
          action: "BUY",
          quantity: "10",
        },
      ],
      prices: [
        { security_id: "sec-1", price_date: "2026-02-27", close_price: "20" },
      ],
      securities: [{ id: "sec-1", currency_code: "USD" }],
      rates: [],
    });
    const result = await service.getBalancesAsOf("user-1", "2026-03-01");
    expect(result.accounts[0]).toMatchObject({
      marketValue: null,
      knownMarketValueSubtotal: 0,
      unpricedHoldingsCount: 0,
      missingRatePairs: ["USD->CAD"],
      fxComplete: false,
      pricesComplete: true,
      valuationComplete: false,
    });
  });

  it("converts a foreign-currency position at the rate stored for the date", async () => {
    program({
      accounts: [brokerage],
      balances: [{ id: "acc-b", balance: "0" }],
      investmentTransactions: [
        {
          account_id: "acc-b",
          security_id: "sec-1",
          action: "BUY",
          quantity: "10",
        },
      ],
      prices: [
        { security_id: "sec-1", price_date: "2026-02-27", close_price: "20" },
      ],
      securities: [{ id: "sec-1", currency_code: "USD" }],
      rates: [
        {
          from_currency: "USD",
          to_currency: "CAD",
          rate_date: "2026-02-27",
          rate: "1.35",
        },
      ],
    });
    const result = await service.getBalancesAsOf("user-1", "2026-03-01");
    expect(result.accounts[0].marketValue).toBe(270);

    const rateCall = query.mock.calls.find(([sql]: [string]) =>
      sql.includes("FROM exchange_rates"),
    );
    expect(rateCall[0]).toContain("rate_date <= $1");
    expect(rateCall[0]).toContain("rate_date >= $2");
    expect(rateCall[1]).toEqual(["2026-03-01", "2026-02-15"]);
  });

  // A rate is an observation on a date exactly as a close is: one long out of
  // date is not the rate for this date, and converting at it would be an
  // exchange rate from another era wearing today's.
  it("treats a rate older than the boundary window as no rate for the date", async () => {
    program({
      accounts: [brokerage],
      balances: [{ id: "acc-b", balance: "0" }],
      investmentTransactions: [
        {
          account_id: "acc-b",
          security_id: "sec-1",
          action: "BUY",
          quantity: "10",
        },
      ],
      prices: [
        { security_id: "sec-1", price_date: "2026-02-27", close_price: "20" },
      ],
      securities: [{ id: "sec-1", currency_code: "USD" }],
      rates: [
        {
          from_currency: "USD",
          to_currency: "CAD",
          rate_date: "2024-05-01",
          rate: "1.35",
        },
      ],
    });
    const result = await service.getBalancesAsOf("user-1", "2026-03-01");
    expect(result.accounts[0]).toMatchObject({
      marketValue: null,
      missingRatePairs: ["USD->CAD"],
      fxComplete: false,
    });
  });

  // An empty portfolio is worth zero. Reporting that as unknown tells the user
  // a settled question could not be worked out.
  it("reports a holdings account with no positions as worth zero", async () => {
    program({
      accounts: [brokerage],
      balances: [{ id: "acc-b", balance: "0" }],
      investmentTransactions: [],
    });
    const result = await service.getBalancesAsOf("user-1", "2026-03-01");
    expect(result.accounts[0]).toMatchObject({
      marketValue: 0,
      knownMarketValueSubtotal: 0,
      valuationComplete: true,
    });
  });

  it("treats a position sold down to nothing as no position, not an unpriced one", async () => {
    program({
      accounts: [brokerage],
      balances: [{ id: "acc-b", balance: "0" }],
      investmentTransactions: [
        {
          account_id: "acc-b",
          security_id: "sec-1",
          action: "BUY",
          quantity: "10",
        },
        {
          account_id: "acc-b",
          security_id: "sec-1",
          action: "SELL",
          quantity: "10",
        },
      ],
      prices: [],
      securities: [],
    });
    const result = await service.getBalancesAsOf("user-1", "2026-03-01");
    expect(result.accounts[0]).toMatchObject({
      marketValue: 0,
      unpricedHoldingsCount: 0,
      valuationComplete: true,
    });
  });

  // The cash sleeve of a linked pair is an ordinary ledger account: valuing it
  // as a holdings account is the double-count the pairing exists to avoid.
  it("does not value an INVESTMENT_CASH sleeve as a holdings account", async () => {
    program({
      accounts: [
        {
          id: "acc-c",
          currency_code: "CAD",
          account_type: "INVESTMENT",
          account_sub_type: "INVESTMENT_CASH",
        },
      ],
      balances: [{ id: "acc-c", balance: "5000" }],
    });
    const result = await service.getBalancesAsOf("user-1", "2026-03-01");
    expect(result.accounts[0]).toMatchObject({
      balance: 5000,
      marketValue: null,
    });
    expect(
      query.mock.calls.some(([sql]: [string]) =>
        sql.includes("investment_transactions"),
      ),
    ).toBe(false);
  });

  it("values a standalone investment account, which carries its own holdings", async () => {
    program({
      accounts: [
        {
          id: "acc-s",
          currency_code: "CAD",
          account_type: "INVESTMENT",
          account_sub_type: null,
        },
      ],
      balances: [{ id: "acc-s", balance: "100" }],
      investmentTransactions: [
        {
          account_id: "acc-s",
          security_id: "sec-1",
          action: "BUY",
          quantity: "2",
        },
      ],
      prices: [
        { security_id: "sec-1", price_date: "2026-02-27", close_price: "50" },
      ],
      securities: [{ id: "sec-1", currency_code: "CAD" }],
    });
    const result = await service.getBalancesAsOf("user-1", "2026-03-01");
    expect(result.accounts[0]).toMatchObject({
      balance: 100,
      marketValue: 100,
    });
  });

  // An empty restriction means "no accounts". Falling through to the owner's
  // whole list would hand a delegate granted nothing every balance there is.
  it("answers an empty restriction with nothing, reading no account", async () => {
    program({ accounts: [cheque], balances: [{ id: "acc-1", balance: "1" }] });
    const result = await service.getBalancesAsOf(
      "user-1",
      "2026-03-01",
      [],
      [],
    );
    expect(result).toEqual({
      asOfDate: "2026-03-01",
      displayCurrency: "CAD",
      displayRates: { CAD: 1 },
      accounts: [],
    });
    // The caller's own preference is not an account: no balance, holding or
    // price query may run for a grant that names nothing.
    expect(query).not.toHaveBeenCalled();
  });

  it("restricts both reads to the accounts a delegate may see", async () => {
    program({ accounts: [cheque], balances: [{ id: "acc-1", balance: "1" }] });
    await service.getBalancesAsOf("user-1", "2026-03-01", [], ["acc-1"]);

    const accountsCall = query.mock.calls.find(
      ([sql]: [string]) =>
        sql.includes("FROM accounts\n") && sql.includes("account_sub_type"),
    );
    expect(accountsCall[1][2]).toEqual(["acc-1"]);
    const ledgerCall = query.mock.calls.find(([sql]: [string]) =>
      sql.includes("LEFT JOIN transactions"),
    );
    expect(ledgerCall[1][3]).toEqual(["acc-1"]);
  });

  it("widens the ownership predicate to the authorized joint accounts only", async () => {
    program({ accounts: [cheque], balances: [{ id: "acc-1", balance: "1" }] });
    await service.getBalancesAsOf("user-1", "2026-03-01", ["joint-1"]);

    for (const [sql, params] of query.mock.calls) {
      if (!sql.includes("FROM accounts")) continue;
      expect(sql).toContain("id = ANY(");
      expect(params).toContain("user-1");
      expect(params).toContainEqual(["joint-1"]);
    }
  });
});
