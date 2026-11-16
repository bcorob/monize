import { RateIndex } from "../common/time-series/rate-index.util";
import { REINVESTED_INCOME_ACTIONS } from "../securities/investment-replay.util";
import {
  ShareLegClose,
  foldInvestedFlows,
  investedCapitalFlowSql,
  loadInvestedCapitalFlowRows,
  shareLegSecurityIds,
} from "./invested-capital-flow.util";

const logger = { warn: jest.fn() };

/** One stored observation, in the shape `resolveFxRate` reads through the index. */
function index(pair: string, date: string, rate: number): RateIndex {
  return new Map([[pair, [{ date, rate }]]]);
}

describe("investedCapitalFlowSql", () => {
  const sql = investedCapitalFlowSql();

  it("binds every placeholder it names, and names no other", () => {
    // PostgreSQL refuses at PARSE when a statement carries a parameter it never
    // references ("could not determine data type of parameter $n"), which no
    // mocked-query spec can see -- the lesson the mixed-split count taught.
    const named = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));

    expect([...new Set(named)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns each reinvestment as its own row, so its own price values it", () => {
    // Grouped with another reinvest of the same security and day, MAX(price)
    // would value both at one of their prices.
    expect(sql).toContain("CASE WHEN it.action = ANY($5) THEN it.id END");
  });

  it("reads rows as effects: a VOID investment row moved no value", () => {
    expect(sql).toContain("it.status != 'VOID'");
  });

  it("bounds the window exclusively below and inclusively above", () => {
    // IV(b) is a close and already holds everything dated b.
    expect(sql).toContain("it.transaction_date > $2");
    expect(sql).toContain("it.transaction_date <= $3");
  });

  it("records each row in its security's own currency", () => {
    // `total_amount` is stored in the security's currency, so the day's rate is
    // applied from there and never from the account's.
    expect(sql).toContain("COALESCE(s.currency_code, a.currency_code)");
  });

  it("renders the day with TO_CHAR, never ::TEXT", () => {
    // The caller keys a per-day map on this string; a DATE rendered through the
    // session's DateStyle is not obliged to be YYYY-MM-DD.
    expect(sql).toContain("TO_CHAR(it.transaction_date, 'YYYY-MM-DD')");
  });
});

describe("loadInvestedCapitalFlowRows", () => {
  it("passes the user, the window and the scope, in that order", async () => {
    const query = jest.fn(async () => []);

    await loadInvestedCapitalFlowRows(query, {
      userId: "user-1",
      afterDate: "2026-01-02",
      throughDate: "2026-06-01",
      accountIds: ["acct-1", "acct-2"],
    });

    expect(query).toHaveBeenCalledWith(investedCapitalFlowSql(), [
      "user-1",
      "2026-01-02",
      "2026-06-01",
      ["acct-1", "acct-2"],
      REINVESTED_INCOME_ACTIONS,
    ]);
  });

  it("asks nothing of an empty scope: nothing is in it, so it totals nothing", async () => {
    const query = jest.fn(async () => []);

    await expect(
      loadInvestedCapitalFlowRows(query, {
        userId: "user-1",
        afterDate: "2026-01-02",
        throughDate: "2026-06-01",
        accountIds: [],
      }),
    ).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("coerces the driver's numeric strings at this boundary", async () => {
    const query = jest.fn(async () => [
      {
        date: "2026-02-02",
        currency: "USD",
        action: "BUY",
        security_id: "sec-1",
        total: "8000.0000",
        quantity: "80.00000000",
        price: "100.0000000000",
        commission: "9.9900",
      },
      {
        date: "2026-02-03",
        currency: "USD",
        action: "SPLIT",
        security_id: "sec-1",
        total: "0.0000",
        quantity: "2.00000000",
        price: null,
        commission: null,
      },
    ]);

    await expect(
      loadInvestedCapitalFlowRows(query, {
        userId: "user-1",
        afterDate: "2026-01-02",
        throughDate: "2026-06-01",
        accountIds: ["acct-1"],
      }),
    ).resolves.toEqual([
      {
        date: "2026-02-02",
        currency: "USD",
        action: "BUY",
        securityId: "sec-1",
        total: 8000,
        quantity: 80,
        price: 100,
        commission: 9.99,
      },
      {
        date: "2026-02-03",
        currency: "USD",
        action: "SPLIT",
        securityId: "sec-1",
        total: 0,
        quantity: 2,
        price: null,
        commission: 0,
      },
    ]);
  });
});

describe("foldInvestedFlows", () => {
  const row = (partial: Partial<Parameters<typeof rowOf>[0]> = {}) =>
    rowOf({
      date: "2026-02-02",
      currency: "CAD",
      action: "BUY",
      securityId: "sec-1",
      total: 8000,
      quantity: 80,
      price: 100,
      commission: 0,
      ...partial,
    });

  function rowOf(r: {
    date: string;
    currency: string;
    action: string;
    securityId: string | null;
    total: number;
    quantity: number;
    price: number | null;
    commission: number;
  }) {
    return r;
  }

  /** Every security priced at `close` on every day, unless a case says otherwise. */
  const closeAt =
    (close: number | null): ShareLegClose =>
    () =>
      close;

  it("splits capital from income by the shared action constant", () => {
    const { byDay } = foldInvestedFlows(
      [
        row(),
        row({ action: "SELL", total: 9000 }),
        row({ action: "DIVIDEND", total: 100 }),
      ],
      "CAD",
      new Map(),
      logger,
      closeAt(100),
    );

    expect(byDay.get("2026-02-02")).toEqual({
      capitalIn: 8000,
      capitalOut: 9000,
      income: 100,
      reinvestedIncome: 0,
      complete: true,
      missingPairs: [],
      unpricedSecurityIds: [],
    });
  });

  it("counts a split as nothing: a ratio moves no value", () => {
    const { byDay } = foldInvestedFlows(
      [row({ action: "SPLIT", total: 0, quantity: 2 })],
      "CAD",
      new Map(),
      logger,
      closeAt(100),
    );

    expect(byDay.size).toBe(0);
  });

  it("keeps a reinvestment apart from capital and income, at its own price, not the close", () => {
    // Discussion #1670. A reinvested distribution is income the invested part
    // put straight back into shares. The surface adds it to both the income
    // and the capital figure; the TWR chain reads neither, because its shares
    // are already in IV. Valued at the cost its shares entered the basis at:
    // a reinvest created in the app stores no total.
    const close = jest.fn(() => 100);
    const { byDay } = foldInvestedFlows(
      [
        row({ action: "REINVEST", total: 0, quantity: 5, price: 20 }),
        row({
          action: "REINVEST_INTEREST",
          total: 0,
          quantity: 1,
          price: 9,
          commission: 1,
        }),
        // An imported reinvest keeps the file's total, which is the fact.
        row({
          action: "REINVEST_CAPITAL_GAIN_LONG",
          total: 50.5,
          quantity: 2,
          price: 25,
        }),
      ],
      "CAD",
      new Map(),
      logger,
      close,
    );

    expect(byDay.get("2026-02-02")).toEqual({
      capitalIn: 0,
      capitalOut: 0,
      income: 0,
      reinvestedIncome: 160.5,
      complete: true,
      missingPairs: [],
      unpricedSecurityIds: [],
    });
    expect(close).not.toHaveBeenCalled();
  });

  it("leaves out a legacy reinvest with neither a total nor a price, as the basis does", () => {
    const { byDay } = foldInvestedFlows(
      [row({ action: "REINVEST", total: 0, quantity: 5, price: null })],
      "CAD",
      new Map(),
      logger,
      closeAt(100),
    );

    expect(byDay.size).toBe(0);
  });

  it("converts a reinvestment at its own day's rate, and names a missing one", () => {
    const { byDay } = foldInvestedFlows(
      [
        row({
          action: "REINVEST",
          currency: "USD",
          total: 0,
          quantity: 4,
          price: 25,
        }),
        row({
          date: "2026-03-02",
          action: "REINVEST",
          currency: "EUR",
          total: 0,
          quantity: 4,
          price: 25,
        }),
      ],
      "CAD",
      index("USD->CAD", "2026-02-02", 1.25),
      logger,
      closeAt(100),
    );

    expect(byDay.get("2026-02-02")?.reinvestedIncome).toBe(125);
    expect(byDay.get("2026-03-02")).toMatchObject({
      reinvestedIncome: 0,
      complete: false,
      missingPairs: ["EUR->CAD"],
    });
  });

  it("values a share-moving leg at the day's close, not at the basis it carries", () => {
    // `IV` moves by market value, so a leg valued at anything else leaves the
    // difference in the P&L as a gain nobody made. 30 shares at the day's 100
    // is 3,000, whatever cost the transfer was recorded at.
    const { byDay } = foldInvestedFlows(
      [row({ action: "TRANSFER_IN", total: 999_999, quantity: 30 })],
      "CAD",
      new Map(),
      logger,
      closeAt(100),
    );

    expect(byDay.get("2026-02-02")?.capitalIn).toBe(3000);
  });

  it("withholds the day, naming the security, when nothing priced the leg", () => {
    // Never zero: the shares are in `IV`, and free capital reads as a gain.
    const { byDay } = foldInvestedFlows(
      [row({ action: "TRANSFER_IN", total: 0, quantity: 30 })],
      "CAD",
      new Map(),
      logger,
      closeAt(null),
    );

    expect(byDay.get("2026-02-02")).toMatchObject({
      capitalIn: 0,
      complete: false,
      unpricedSecurityIds: ["sec-1"],
    });
  });

  it("asks for no close where the action carries its own total", () => {
    const close = jest.fn(() => 100);

    foldInvestedFlows([row()], "CAD", new Map(), logger, close);

    expect(close).not.toHaveBeenCalled();
  });

  it("converts each day at the rate of its own day", () => {
    const rates: RateIndex = new Map([
      [
        "USD->CAD",
        [
          { date: "2026-02-02", rate: 1.25 },
          { date: "2026-03-02", rate: 1.5 },
        ],
      ],
    ]);

    const { byDay } = foldInvestedFlows(
      [
        row({ currency: "USD", total: 1000 }),
        row({ date: "2026-03-02", currency: "USD", total: 1000 }),
      ],
      "CAD",
      rates,
      logger,
      closeAt(100),
    );

    expect(byDay.get("2026-02-02")?.capitalIn).toBe(1250);
    expect(byDay.get("2026-03-02")?.capitalIn).toBe(1500);
  });

  it("marks the day incomplete, and names the pair, when a rate is missing", () => {
    // Never 1, never the unconverted amount: the day is unknown, which
    // withholds the period rather than shrinking it.
    const { byDay, gaps } = foldInvestedFlows(
      [row({ currency: "EUR", total: 1000 })],
      "CAD",
      index("USD->CAD", "2026-02-02", 1.25),
      logger,
      closeAt(100),
    );

    expect(byDay.get("2026-02-02")).toMatchObject({
      capitalIn: 0,
      complete: false,
      missingPairs: ["EUR->CAD"],
    });
    expect(gaps).toEqual([
      { date: "2026-02-02", missingRatePairs: ["EUR->CAD"] },
    ]);
  });
});

describe("shareLegSecurityIds", () => {
  const base = {
    date: "2026-02-02",
    currency: "CAD",
    total: 0,
    quantity: 5,
    price: null,
    commission: 0,
  };

  it("asks for closes only for share-moving legs without a total", () => {
    expect(
      shareLegSecurityIds([
        { ...base, action: "TRANSFER_IN", securityId: "sec-leg" },
        { ...base, action: "BUY", securityId: "sec-buy", total: 100 },
        { ...base, action: "SPLIT", securityId: "sec-split" },
        // Valued from its own price, so it needs no close.
        { ...base, action: "REINVEST", securityId: "sec-drip", price: 20 },
      ]),
    ).toEqual(["sec-leg"]);
  });
});
