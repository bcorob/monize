import {
  parseTradeAction,
  parseTradeDate,
  parseTradeLines,
  parseTradeLinesTraced,
  parseTradeQuantity,
  resolveTradeAccount,
  tradeExecutedTotalUnits,
  tradeIsConsistent,
  tradeMayAutoApply,
} from "./parse-trade";
import { normalizeReceiptLines } from "./receipt-lines";
import { validateReceiptParserDefinition } from "./receipt-parser.validation";
import {
  WEALTHSIMPLE_BUY_BODY,
  WEALTHSIMPLE_RRSP_ACCOUNT_ID,
  WEALTHSIMPLE_TFSA_ACCOUNT_ID,
  WEALTHSIMPLE_TRADE_DEFINITION,
} from "./fixtures/wealthsimple-trade";
import {
  WEALTHSIMPLE_DIVIDEND_BODY,
  WEALTHSIMPLE_DIVIDEND_DEFINITION,
  WEALTHSIMPLE_DRIP_BODY,
} from "./fixtures/wealthsimple-dividend";
import type { ReceiptTradeDefinition } from "./receipt-parser.types";

const trade = WEALTHSIMPLE_TRADE_DEFINITION.trade as ReceiptTradeDefinition;
const lines = (body: string): string[] => normalizeReceiptLines(body);

describe("parseTradeLines", () => {
  /**
   * A26-L17 (INV-TRADE-001): a price-only email books the total its price AS
   * WRITTEN implies. The 4-decimal card price (1.2346) gave 12,346.0000 for
   * 10,000 x 1.23456789; the fact is 12,345.6789.
   */
  it.each([
    ["10000", "$1.23456789", 123_456_789],
    ["1000", "$26.320125", 263_201_250],
    // 75.9878 x 26.32005 = 2,000.0026953...; the audit's 2,000.0019 was a slip.
    ["75.9878", "$26.32005", 20_000_027],
  ])(
    "derives a price-only total from the price as written (%s shares at %s)",
    (shares, price, totalUnits) => {
      const body = WEALTHSIMPLE_BUY_BODY.replace("Total cost: $2,000.00\n", "")
        .replace("$26.32", price)
        .replace("Shares: 75.9878", `Shares: ${shares}`);
      const parsed = parseTradeLines(trade, lines(body));
      expect(parsed.total).toBeNull();
      expect(tradeExecutedTotalUnits(parsed)).toBe(totalUnits);
    },
  );

  it("reads a Wealthsimple fractional buy completely", () => {
    const parsed = parseTradeLines(trade, lines(WEALTHSIMPLE_BUY_BODY));
    expect(parsed).toEqual({
      action: "BUY",
      symbol: "XCNS",
      quantity: 75.9878,
      total: 20_000_000,
      price: 263_200,
      priceUnits8: "2632000000",
      commission: null,
      currency: null,
      currencySource: null,
      date: "2026-10-15",
      accountText: "RRSP",
      accountId: WEALTHSIMPLE_RRSP_ACCOUNT_ID,
      complete: true,
      consistent: true,
      reason: null,
    });
  });

  it("chooses the account by the printed account text", () => {
    const body = WEALTHSIMPLE_BUY_BODY.replace(
      "Account: RRSP",
      "Account: TFSA",
    );
    expect(parseTradeLines(trade, lines(body)).accountId).toBe(
      WEALTHSIMPLE_TFSA_ACCOUNT_ID,
    );
  });

  it("reads a sell", () => {
    const body = WEALTHSIMPLE_BUY_BODY.replace("Fractional Buy", "Sell");
    expect(parseTradeLines(trade, lines(body)).action).toBe("SELL");
  });

  it.each([
    ["trade_no_action", "Type: Fractional Buy", "Type: Transfer"],
    ["trade_no_symbol", "Symbol: XCNS", "Ticker: XCNS"],
    ["trade_no_quantity", "Shares: 75.9878", "Shares: many"],
    ["trade_no_account", "Account: RRSP", "Account: Margin"],
  ])("is incomplete with %s", (reason, from, to) => {
    const parsed = parseTradeLines(
      trade,
      lines(WEALTHSIMPLE_BUY_BODY.replace(from, to)),
    );
    expect(parsed.complete).toBe(false);
    expect(parsed.reason).toBe(reason);
  });

  it("is incomplete without an amount", () => {
    const body = WEALTHSIMPLE_BUY_BODY.replace(
      "Total cost: $2,000.00\n",
      "",
    ).replace("Average price: $26.32\n", "");
    expect(parseTradeLines(trade, lines(body)).reason).toBe("trade_no_amount");
  });

  it("reads a trade with only a total (no cross-check possible)", () => {
    const body = WEALTHSIMPLE_BUY_BODY.replace("Average price: $26.32\n", "");
    const parsed = parseTradeLines(trade, lines(body));
    expect(parsed.complete).toBe(true);
    expect(parsed.consistent).toBeNull();
  });

  it("flags a price that does not fit the total", () => {
    const body = WEALTHSIMPLE_BUY_BODY.replace("$26.32", "$31.00");
    const parsed = parseTradeLines(trade, lines(body));
    expect(parsed.complete).toBe(true);
    expect(parsed.consistent).toBe(false);
  });

  it("never books account text the rules do not know to the default account", () => {
    // A TFSA email under a profile that knows only RRSP: booking it to the
    // default would book it to the wrong account.
    const rrspOnly: ReceiptTradeDefinition = {
      ...trade,
      accountRules: [
        { match: "RRSP", accountId: WEALTHSIMPLE_RRSP_ACCOUNT_ID },
      ],
      defaultAccountId: WEALTHSIMPLE_RRSP_ACCOUNT_ID,
    };
    const body = WEALTHSIMPLE_BUY_BODY.replace(
      "Account: RRSP",
      "Account: TFSA",
    );
    const parsed = parseTradeLines(rrspOnly, lines(body));
    expect(parsed.accountId).toBeNull();
    expect(parsed.reason).toBe("trade_no_account");
  });

  it("uses the default account for an email that names none, and for a profile with no rules", () => {
    const withDefault: ReceiptTradeDefinition = {
      ...trade,
      defaultAccountId: WEALTHSIMPLE_TFSA_ACCOUNT_ID,
    };
    const noAccountLine = WEALTHSIMPLE_BUY_BODY.replace("Account: RRSP\n", "");
    expect(parseTradeLines(withDefault, lines(noAccountLine)).accountId).toBe(
      WEALTHSIMPLE_TFSA_ACCOUNT_ID,
    );
    const noRules: ReceiptTradeDefinition = {
      ...withDefault,
      accountRules: undefined,
    };
    expect(
      parseTradeLines(noRules, lines(WEALTHSIMPLE_BUY_BODY)).accountId,
    ).toBe(WEALTHSIMPLE_TFSA_ACCOUNT_ID);
  });

  it("reads a price with three or four decimals as a price, and cross-checks it exactly", () => {
    for (const price of ["$26.320", "$26.3200", "$26.32000000"]) {
      const parsed = parseTradeLines(
        trade,
        lines(WEALTHSIMPLE_BUY_BODY.replace("$26.32", price)),
      );
      expect(parsed.price).toBe(263_200);
      expect(parsed.consistent).toBe(true);
    }
    // A 4-decimal price 0.0001 too high is still within its own rounding plus
    // a cent; one 0.01 too high is not.
    const close = parseTradeLines(
      trade,
      lines(WEALTHSIMPLE_BUY_BODY.replace("$26.32", "$26.3201")),
    );
    expect(close.price).toBe(263_201);
    expect(close.consistent).toBe(true);
    const off = parseTradeLines(
      trade,
      lines(WEALTHSIMPLE_BUY_BODY.replace("$26.32", "$26.3300")),
    );
    expect(off.consistent).toBe(false);
  });

  it("reads the European convention, with the tolerance of the decimals actually written", () => {
    const body = WEALTHSIMPLE_BUY_BODY.replace("75.9878", "75,9878")
      .replace("$26.32", "26,32 $")
      .replace("$2,000.00", "2 000,00 $");
    const parsed = parseTradeLines(trade, lines(body));
    expect(parsed.quantity).toBe(75.9878);
    expect(parsed.price).toBe(263_200);
    expect(parsed.total).toBe(20_000_000);
    expect(parsed.consistent).toBe(true);
    // 76 shares at 26,00 is 1976, $24 short of 2.000,00: two written decimals
    // allow half a cent a share, not half a dollar.
    const wrong = WEALTHSIMPLE_BUY_BODY.replace("75.9878", "76")
      .replace("$26.32", "26,00 $")
      .replace("$2,000.00", "2.000,00 $");
    expect(parseTradeLines(trade, lines(wrong)).consistent).toBe(false);
  });

  it("reads a total printed as a debit as the total", () => {
    for (const total of [
      "-$2,000.00",
      "($2,000.00)",
      "$-2,000.00",
      "−2,000.00",
    ]) {
      const parsed = parseTradeLines(
        trade,
        lines(WEALTHSIMPLE_BUY_BODY.replace("$2,000.00", total)),
      );
      expect(parsed.total).toBe(20_000_000);
      expect(parsed.consistent).toBe(true);
    }
  });

  it("reads the currency an amount names, and none from a bare dollar sign", () => {
    expect(
      parseTradeLines(trade, lines(WEALTHSIMPLE_BUY_BODY)).currency,
    ).toBeNull();
    const usd = WEALTHSIMPLE_BUY_BODY.replace("$2,000.00", "$2,000.00 USD");
    expect(parseTradeLines(trade, lines(usd)).currency).toBe("USD");
    const eur = WEALTHSIMPLE_BUY_BODY.replace("$2,000.00", "€2,000.00");
    expect(parseTradeLines(trade, lines(eur)).currency).toBe("EUR");
  });

  it("is incomplete when a sell's price implies less than its commission", () => {
    const sell: ReceiptTradeDefinition = {
      ...trade,
      total: undefined,
      commission: ["Commission: {amount}"],
    };
    const body = WEALTHSIMPLE_BUY_BODY.replace("Fractional Buy", "Sell")
      .replace("Shares: 75.9878", "Shares: 0.01")
      .replace(
        "Average price: $26.32",
        "Average price: $1.00\nCommission: $9.99",
      );
    const parsed = parseTradeLines(sell, lines(body));
    expect(parsed.complete).toBe(false);
    expect(parsed.reason).toBe("trade_no_amount");
  });

  it("traces the lines that read each value", () => {
    const { trace } = parseTradeLinesTraced(
      trade,
      lines(WEALTHSIMPLE_BUY_BODY),
    );
    expect(trace.symbol?.line.text).toBe("Symbol: XCNS");
    expect(trace.quantity?.pattern).toBe("Shares: {quantity}");
    expect(trace.commission).toBeNull();
  });
});

describe("dividends", () => {
  const dividend =
    WEALTHSIMPLE_DIVIDEND_DEFINITION.trade as ReceiptTradeDefinition;

  it("reads a cash dividend completely without a share count or a price", () => {
    const parsed = parseTradeLines(dividend, lines(WEALTHSIMPLE_DIVIDEND_BODY));
    expect(parsed).toMatchObject({
      action: "DIVIDEND",
      symbol: "XEQT",
      quantity: null,
      total: 123_400,
      price: null,
      date: "2026-10-15",
      complete: true,
      consistent: null,
      reason: null,
    });
    expect(tradeExecutedTotalUnits(parsed)).toBe(123_400);
  });

  it("a complete cash dividend may auto-apply: there is nothing to cross-check", () => {
    const parsed = parseTradeLines(dividend, lines(WEALTHSIMPLE_DIVIDEND_BODY));
    expect(tradeMayAutoApply(parsed)).toBe(true);
  });

  it("a dividend whose shares times amount per share disagrees with its amount never auto-applies", () => {
    const body = WEALTHSIMPLE_DIVIDEND_BODY.replace(
      "Amount: $12.34",
      "Shares: 100\nPrice: $0.1234\nAmount: $123.40",
    );
    const parsed = parseTradeLines(dividend, lines(body));
    expect(parsed.complete).toBe(true);
    expect(parsed.consistent).toBe(false);
    expect(tradeMayAutoApply(parsed)).toBe(false);
  });

  it("a dividend stated per share with its shares proposes their product", () => {
    const body = WEALTHSIMPLE_DIVIDEND_BODY.replace(
      "Amount: $12.34",
      "Shares: 100\nPrice: $0.1234",
    );
    const parsed = parseTradeLines(dividend, lines(body));
    expect(parsed.complete).toBe(true);
    expect(tradeExecutedTotalUnits(parsed)).toBe(123_400);
  });

  it("a dividend stated per share without its shares has no amount", () => {
    const body = WEALTHSIMPLE_DIVIDEND_BODY.replace(
      "Amount: $12.34",
      "Price: $0.1234",
    );
    const parsed = parseTradeLines(dividend, lines(body));
    expect(parsed.complete).toBe(false);
    expect(parsed.reason).toBe("trade_no_amount");
  });

  it("reads a reinvested dividend with its shares and cross-checks it like a buy", () => {
    const parsed = parseTradeLines(dividend, lines(WEALTHSIMPLE_DRIP_BODY));
    expect(parsed).toMatchObject({
      action: "REINVEST",
      symbol: "XEQT",
      quantity: 0.3721,
      total: 123_400,
      complete: true,
      consistent: true,
    });
    expect(tradeMayAutoApply(parsed)).toBe(true);
  });

  it("a reinvestment needs its shares", () => {
    const body = WEALTHSIMPLE_DRIP_BODY.replace("Shares: 0.3721\n", "");
    expect(parseTradeLines(dividend, lines(body)).reason).toBe(
      "trade_no_quantity",
    );
  });

  it("a buy read by a profile with no quantity field is incomplete, not a dividend", () => {
    const { quantity: _quantity, ...noQuantity } = trade;
    const parsed = parseTradeLines(noQuantity, lines(WEALTHSIMPLE_BUY_BODY));
    expect(parsed.complete).toBe(false);
    expect(parsed.reason).toBe("trade_no_quantity");
  });

  it("a buy with nothing to cross-check still waits for a person", () => {
    const { price: _price, ...noPrice } = trade;
    const parsed = parseTradeLines(noPrice, lines(WEALTHSIMPLE_BUY_BODY));
    expect(parsed.complete).toBe(true);
    expect(parsed.consistent).toBeNull();
    expect(tradeMayAutoApply(parsed)).toBe(false);
  });

  it("takes a dividend's commission out of its amount, as a sell's", () => {
    expect(
      tradeIsConsistent({
        action: "DIVIDEND",
        quantityUnits: 100n * 100_000_000n,
        priceUnits8: 12_340_000n,
        priceDecimals: 4,
        totalUnits: 113_400,
        commissionUnits: 10_000,
      }),
    ).toBe(true);
    expect(
      tradeIsConsistent({
        action: "REINVEST",
        quantityUnits: 100n * 100_000_000n,
        priceUnits8: 12_340_000n,
        priceDecimals: 4,
        totalUnits: 133_400,
        commissionUnits: 10_000,
      }),
    ).toBe(true);
  });
});

describe("trade value readers", () => {
  it("reads share counts with up to 8 decimals", () => {
    expect(parseTradeQuantity("75.9878")?.value).toBe(75.9878);
    expect(parseTradeQuantity("1,250.5")?.value).toBe(1250.5);
    expect(parseTradeQuantity("0.00000001")?.units).toBe(1n);
  });

  it("reads share counts in either decimal convention, and a sign is only the direction", () => {
    expect(parseTradeQuantity("75,9878")?.value).toBe(75.9878);
    expect(parseTradeQuantity("1.234,5")?.value).toBe(1234.5);
    expect(parseTradeQuantity("1 234,5")?.value).toBe(1234.5);
    // A comma with exactly three digits after it groups thousands.
    expect(parseTradeQuantity("1,234")?.value).toBe(1234);
    expect(parseTradeQuantity("1.234")?.value).toBe(1.234);
    expect(parseTradeQuantity("-5")?.value).toBe(5);
  });

  it.each([
    "",
    "0",
    "1e3",
    "1.2.3",
    "12.123456789",
    "abc",
    "5 shares 3",
    ",,,1",
    "1,,2",
    "1,2,3",
    "2 x 3",
  ])("refuses the share count %p", (text) => {
    expect(parseTradeQuantity(text)).toBeNull();
  });

  it("reads the direction from the words", () => {
    expect(parseTradeAction("Achat fractionné")).toBe("BUY");
    expect(parseTradeAction("Vente")).toBe("SELL");
    expect(parseTradeAction("Fractional Buy")).toBe("BUY");
    expect(parseTradeAction("Market sell")).toBe("SELL");
    expect(parseTradeAction("Buy to cover sell")).toBeNull();
    expect(parseTradeAction("Transfer")).toBeNull();
  });

  it("reads a cash dividend, and a reinvestment before a dividend or a buy", () => {
    expect(parseTradeAction("Dividend")).toBe("DIVIDEND");
    expect(parseTradeAction("Cash distribution")).toBe("DIVIDEND");
    expect(parseTradeAction("Dividende")).toBe("DIVIDEND");
    expect(parseTradeAction("Dividend reinvested")).toBe("REINVEST");
    expect(parseTradeAction("DRIP buy")).toBe("REINVEST");
    expect(parseTradeAction("Réinvestissement de dividendes")).toBe("REINVEST");
    // A word that merely starts like one is not it.
    expect(parseTradeAction("Dividendary")).toBeNull();
    // A buy or a sell of a fund whose name holds a dividend word is that buy
    // or sell, never a dividend an approved buy profile starts to book.
    expect(
      parseTradeAction("Bought 10 shares of Vanguard High Dividend Yield ETF"),
    ).toBe("BUY");
    expect(parseTradeAction("Sold Monthly Distribution Fund")).toBe("SELL");
    expect(parseTradeAction("Dividend buy sell")).toBeNull();
  });

  it("reads the broker's local day and ignores the time", () => {
    expect(parseTradeDate("October 15, 2026 12:04 EDT")).toBe("2026-10-15");
    expect(parseTradeDate("Oct. 3rd 2026")).toBe("2026-10-03");
    expect(parseTradeDate("Dec 3, 2026")).toBe("2026-12-03");
    expect(parseTradeDate("2026-02-28 09:00")).toBe("2026-02-28");
    expect(parseTradeDate("February 30, 2026")).toBeNull();
    expect(parseTradeDate("no date here")).toBeNull();
  });

  it("reads ISO timestamps, day-first and French dates, and a numeric date only when it is certain", () => {
    expect(parseTradeDate("2026-10-15T12:04:00Z")).toBe("2026-10-15");
    expect(parseTradeDate("2026/10/15")).toBe("2026-10-15");
    expect(parseTradeDate("15 October 2026")).toBe("2026-10-15");
    expect(parseTradeDate("15 octobre 2026 12 h 04 HAE")).toBe("2026-10-15");
    expect(parseTradeDate("1er mai 2026")).toBe("2026-05-01");
    expect(parseTradeDate("10/15/2026")).toBe("2026-10-15");
    expect(parseTradeDate("15.10.2026")).toBe("2026-10-15");
    expect(parseTradeDate("05/05/2026")).toBe("2026-05-05");
    // May 6th or June 5th: not certain, so no day.
    expect(parseTradeDate("05/06/2026")).toBeNull();
  });

  it("allows the rounding of a written price and one cent, no more", () => {
    const base = {
      action: "BUY" as const,
      quantityUnits: 7_598_780_000n,
      priceUnits8: 2_632_000_000n,
      priceDecimals: 2,
      totalUnits: 20_000_000,
      commissionUnits: 0,
    };
    expect(tradeIsConsistent(base)).toBe(true);
    expect(tradeIsConsistent({ ...base, totalUnits: 20_500_000 })).toBe(false);
  });

  it("takes a buy's commission out of the total and a sell's into it", () => {
    // 10 shares at 10.00 is 100.00; commission 9.99.
    const shares = 1_000_000_000n;
    const common = {
      quantityUnits: shares,
      priceUnits8: 1_000_000_000n,
      priceDecimals: 2,
      commissionUnits: 99_900,
    };
    expect(
      tradeIsConsistent({ ...common, action: "BUY", totalUnits: 1_099_900 }),
    ).toBe(true);
    expect(
      tradeIsConsistent({ ...common, action: "BUY", totalUnits: 1_000_000 }),
    ).toBe(false);
    expect(
      tradeIsConsistent({ ...common, action: "SELL", totalUnits: 900_100 }),
    ).toBe(true);
  });

  it("falls back to the default account without an account text", () => {
    const account = (
      definition: Parameters<typeof resolveTradeAccount>[0],
      text: string | null,
    ) => resolveTradeAccount(definition, text, null).accountId;
    expect(
      account({ defaultAccountId: WEALTHSIMPLE_RRSP_ACCOUNT_ID }, null),
    ).toBe(WEALTHSIMPLE_RRSP_ACCOUNT_ID);
    expect(account({}, "RRSP")).toBeNull();
    expect(
      account(
        {
          accountRules: [
            { match: "RRSP", accountId: WEALTHSIMPLE_RRSP_ACCOUNT_ID },
          ],
          defaultAccountId: WEALTHSIMPLE_TFSA_ACCOUNT_ID,
        },
        "Margin",
      ),
    ).toBeNull();
  });
});

describe("choosing between accounts the broker prints alike, by currency", () => {
  const RRSP_USD = "33333333-3333-4333-8333-333333333333";
  const byCurrency: ReceiptTradeDefinition = {
    ...trade,
    accountRules: [
      { match: "RRSP", currency: "USD", accountId: RRSP_USD },
      {
        match: "RRSP",
        currency: "CAD",
        accountId: WEALTHSIMPLE_RRSP_ACCOUNT_ID,
      },
      { match: "TFSA", accountId: WEALTHSIMPLE_TFSA_ACCOUNT_ID },
    ],
  };

  it("takes the rule of the currency the amounts name", () => {
    const usd = WEALTHSIMPLE_BUY_BODY.replace(
      "Total cost: $2,000.00",
      "Total cost: US$2,000.00",
    );
    const parsed = parseTradeLines(byCurrency, lines(usd));
    expect(parsed).toMatchObject({
      accountId: RRSP_USD,
      currency: "USD",
      currencySource: "amount",
      complete: true,
    });
  });

  it("reads a dollar sign's country prefix as its currency", () => {
    for (const [text, code] of [
      ["US$2,000.00", "USD"],
      ["C$ 2,000.00", "CAD"],
      ["CDN$2,000.00", "CAD"],
      ["CA$2,000.00", "CAD"],
      ["$2,000.00 CAD", "CAD"],
    ]) {
      const body = WEALTHSIMPLE_BUY_BODY.replace("$2,000.00", text);
      expect(parseTradeLines(trade, lines(body)).currency).toBe(code);
    }
  });

  it("takes a currency marker's currency when the amounts name none", () => {
    const definition: ReceiptTradeDefinition = {
      ...byCurrency,
      currencyMarkers: [{ match: "*U.S. dollars*", currency: "USD" }],
    };
    const body = `${WEALTHSIMPLE_BUY_BODY}\nAmounts are in U.S. dollars.`;
    const traced = parseTradeLinesTraced(definition, lines(body));
    expect(traced.trade).toMatchObject({
      accountId: RRSP_USD,
      currency: "USD",
      currencySource: "marker",
    });
    expect(traced.trace.currency).toMatchObject({
      entry: 0,
      pattern: "*U.S. dollars*",
      line: { text: "Amounts are in U.S. dollars." },
    });
  });

  it("takes a multi-line currency marker only when its lines follow each other", () => {
    const definition: ReceiptTradeDefinition = {
      ...byCurrency,
      currencyMarkers: [{ match: "Currency\\nUSD", currency: "USD" }],
    };
    const traced = parseTradeLinesTraced(
      definition,
      lines(`${WEALTHSIMPLE_BUY_BODY}\nCurrency\nUSD`),
    );
    expect(traced.trade.currency).toBe("USD");
    expect(traced.trace.currency?.lines?.map((l) => l.text)).toEqual([
      "Currency",
      "USD",
    ]);
    expect(
      parseTradeLines(
        definition,
        lines(`${WEALTHSIMPLE_BUY_BODY}\nCurrency\nsee below\nUSD`),
      ).currency,
    ).toBeNull();
  });

  it("reads a field with a multi-line pattern", () => {
    const definition: ReceiptTradeDefinition = {
      ...trade,
      total: ["Average price: *\\nTotal cost: {amount}"],
    };
    expect(
      parseTradeLines(definition, lines(WEALTHSIMPLE_BUY_BODY)).total,
    ).toBe(20_000_000);
  });

  it("prefers the amounts' currency over a marker", () => {
    const definition: ReceiptTradeDefinition = {
      ...byCurrency,
      currencyMarkers: [{ match: "*Account*", currency: "USD" }],
    };
    const body = WEALTHSIMPLE_BUY_BODY.replace("$2,000.00", "CAD 2,000.00");
    expect(parseTradeLines(definition, lines(body))).toMatchObject({
      accountId: WEALTHSIMPLE_RRSP_ACCOUNT_ID,
      currency: "CAD",
      currencySource: "amount",
    });
  });

  it("falls back to the security's currency, and never guesses without one", () => {
    expect(
      parseTradeLines(byCurrency, lines(WEALTHSIMPLE_BUY_BODY), {
        securityCurrency: "cad",
      }),
    ).toMatchObject({
      accountId: WEALTHSIMPLE_RRSP_ACCOUNT_ID,
      currency: "CAD",
      currencySource: "security",
      complete: true,
    });
    expect(
      parseTradeLines(byCurrency, lines(WEALTHSIMPLE_BUY_BODY)),
    ).toMatchObject({
      accountId: null,
      currency: null,
      complete: false,
      reason: "trade_no_currency",
    });
  });

  it("skips a rule of another currency, and needs no currency for a rule of any", () => {
    expect(resolveTradeAccount(byCurrency, "RRSP", "EUR")).toEqual({
      accountId: null,
      needsCurrency: false,
    });
    expect(resolveTradeAccount(byCurrency, "TFSA", null)).toEqual({
      accountId: WEALTHSIMPLE_TFSA_ACCOUNT_ID,
      needsCurrency: false,
    });
  });

  it("matches a * rule when the email prints no account", () => {
    const rules = {
      accountRules: [
        { match: "*", currency: "USD", accountId: RRSP_USD },
        { match: "*", accountId: WEALTHSIMPLE_RRSP_ACCOUNT_ID },
      ],
    };
    expect(resolveTradeAccount(rules, null, "USD").accountId).toBe(RRSP_USD);
    expect(resolveTradeAccount(rules, null, "CAD").accountId).toBe(
      WEALTHSIMPLE_RRSP_ACCOUNT_ID,
    );
    expect(resolveTradeAccount(rules, null, null)).toEqual({
      accountId: null,
      needsCurrency: true,
    });
  });
});

describe("validating a trade profile", () => {
  const valid = (): Record<string, unknown> =>
    JSON.parse(JSON.stringify(WEALTHSIMPLE_TRADE_DEFINITION));
  const codes = (input: unknown): string[] => {
    const result = validateReceiptParserDefinition(input);
    return result.ok ? [] : result.errors.map((e) => `${e.path}:${e.code}`);
  };

  it("accepts the Wealthsimple profile unchanged", () => {
    const result = validateReceiptParserDefinition(valid());
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.definition).toEqual(WEALTHSIMPLE_TRADE_DEFINITION);
  });

  it("refuses a multi-line account rule: the account text is one text", () => {
    const input = valid();
    const section = input.trade as Record<string, unknown>;
    section.accountRules = [
      { match: "Account\\nRRSP", accountId: WEALTHSIMPLE_RRSP_ACCOUNT_ID },
    ];
    expect(codes(input)).toEqual([
      "trade.accountRules[0].match:line_break_not_allowed",
    ]);
  });

  it("refuses a receipt field beside the trade section", () => {
    expect(codes({ ...valid(), total: ["Total: {amount}"] })).toContain(
      "total:trade_conflict",
    );
  });

  it("requires action and symbol", () => {
    const input = valid();
    const section = input.trade as Record<string, unknown>;
    delete section.symbol;
    delete section.action;
    expect(codes(input)).toEqual(
      expect.arrayContaining(["trade.symbol:empty", "trade.action:empty"]),
    );
  });

  it("accepts a profile without quantity: a cash dividend states none", () => {
    const input = valid();
    delete (input.trade as Record<string, unknown>).quantity;
    expect(codes(input)).toEqual([]);
    expect(
      validateReceiptParserDefinition(
        JSON.parse(JSON.stringify(WEALTHSIMPLE_DIVIDEND_DEFINITION)),
      ).ok,
    ).toBe(true);
  });

  it("requires a total or a price", () => {
    const input = valid();
    const section = input.trade as Record<string, unknown>;
    delete section.total;
    delete section.price;
    expect(codes(input)).toContain("trade.total:trade_amount_missing");
  });

  it("requires a decidable account", () => {
    const input = valid();
    delete (input.trade as Record<string, unknown>).accountRules;
    expect(codes(input)).toContain(
      "trade.defaultAccountId:trade_account_missing",
    );
  });

  it("refuses account rules with a bad id, a capture or an unknown key", () => {
    const input = valid();
    (input.trade as Record<string, unknown>).accountRules = [
      { match: "R{x}", accountId: "nope", extra: 1 },
    ];
    expect(codes(input)).toEqual(
      expect.arrayContaining([
        "trade.accountRules[0].accountId:invalid_uuid",
        "trade.accountRules[0].extra:unknown_key",
      ]),
    );
  });

  it("accepts currency rules and markers without account entries", () => {
    const input = valid();
    const section = input.trade as Record<string, unknown>;
    delete section.account;
    section.accountRules = [
      { match: "*", currency: "USD", accountId: WEALTHSIMPLE_TFSA_ACCOUNT_ID },
    ];
    section.currencyMarkers = [{ match: "*US$*", currency: "USD" }];
    const result = validateReceiptParserDefinition(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.definition.trade?.accountRules?.[0].currency).toBe("USD");
      expect(result.definition.trade?.currencyMarkers).toEqual([
        { match: "*US$*", currency: "USD" },
      ]);
    }
  });

  it("refuses a malformed currency, a marker with a capture and too many markers", () => {
    const input = valid();
    const section = input.trade as Record<string, unknown>;
    section.accountRules = [
      {
        match: "RRSP",
        currency: "usd",
        accountId: WEALTHSIMPLE_TFSA_ACCOUNT_ID,
      },
    ];
    section.currencyMarkers = [
      { match: "*{x}*", currency: "USD" },
      { match: "*US$*", currency: "US", extra: true },
    ];
    expect(codes(input)).toEqual(
      expect.arrayContaining([
        "trade.accountRules[0].currency:invalid_currency",
        "trade.currencyMarkers[0].match:capture_not_allowed",
        "trade.currencyMarkers[1].currency:invalid_currency",
        "trade.currencyMarkers[1].extra:unknown_key",
      ]),
    );
    section.accountRules = [];
    section.currencyMarkers = Array.from({ length: 21 }, () => ({
      match: "*US$*",
      currency: "USD",
    }));
    expect(codes(input)).toContain("trade.currencyMarkers:too_many");
  });

  it("refuses the wrong capture in a field", () => {
    const input = valid();
    (input.trade as Record<string, unknown>).symbol = ["Symbol: {amount}"];
    expect(codes(input)).toEqual(
      expect.arrayContaining(["trade.symbol[0]:capture_not_allowed"]),
    );
  });
});
