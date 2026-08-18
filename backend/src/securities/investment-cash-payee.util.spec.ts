import { InvestmentAction } from "./entities/investment-transaction.entity";
import {
  formatInvestmentActionLabel,
  formatInvestmentCashPayeeName,
} from "./investment-cash-payee.util";

/**
 * Exact strings, not `stringContaining`. The three producers of this label had
 * drifted into two different formats and one absence, and every assertion any
 * of them carried was a `toContain` -- which is why swapping a hard-coded `$`
 * for the row's real currency broke nothing anywhere.
 */
describe("formatInvestmentCashPayeeName", () => {
  const buy = {
    action: InvestmentAction.BUY,
    symbol: "VOO",
    quantity: 10,
    price: 150,
    totalAmount: 1500,
  };

  it("labels a buy with the symbol, quantity and unit price", () => {
    expect(formatInvestmentCashPayeeName({ ...buy, currencyCode: "USD" })).toBe(
      "Buy: VOO 10 @ $150.00",
    );
  });

  it("quotes the price in the currency it was given, not a hard-coded dollar", () => {
    expect(formatInvestmentCashPayeeName({ ...buy, currencyCode: "EUR" })).toBe(
      "Buy: VOO 10 @ €150.00",
    );
    expect(formatInvestmentCashPayeeName({ ...buy, currencyCode: "CAD" })).toBe(
      "Buy: VOO 10 @ CA$150.00",
    );
  });

  it("renders the figures bare rather than throwing when the code is unusable", () => {
    // A `.mny` account can carry an empty currency code, and `Intl` answers a
    // malformed one with a RangeError -- aborting an import over a label.
    for (const currencyCode of ["", null, undefined, "US"]) {
      expect(formatInvestmentCashPayeeName({ ...buy, currencyCode })).toBe(
        "Buy: VOO 10 @ 150.00",
      );
    }
  });

  it("drops a quantity's trailing zeros but keeps its stored 4dp", () => {
    expect(
      formatInvestmentCashPayeeName({
        ...buy,
        quantity: 10.5,
        currencyCode: "USD",
      }),
    ).toBe("Buy: VOO 10.5 @ $150.00");
    expect(
      formatInvestmentCashPayeeName({
        ...buy,
        quantity: 0.19855,
        currencyCode: "USD",
      }),
    ).toBe("Buy: VOO 0.1986 @ $150.00");
  });

  it("shows sub-cent unit prices to 4dp", () => {
    expect(
      formatInvestmentCashPayeeName({
        ...buy,
        price: 0.0125,
        currencyCode: "USD",
      }),
    ).toBe("Buy: VOO 10 @ $0.0125");
  });

  it("groups thousands", () => {
    expect(
      formatInvestmentCashPayeeName({
        ...buy,
        price: 12345.6,
        currencyCode: "USD",
      }),
    ).toBe("Buy: VOO 10 @ $12,345.60");
  });

  it("keeps the raw action's own name while following its base action's shape", () => {
    // REDEEM's base is SELL, so it reads like a sell without being called one.
    expect(
      formatInvestmentCashPayeeName({
        ...buy,
        action: InvestmentAction.REDEEM,
        currencyCode: "USD",
      }),
    ).toBe("Redeem: VOO 10 @ $150.00");
    expect(
      formatInvestmentCashPayeeName({
        action: InvestmentAction.CAPITAL_GAIN_LONG,
        symbol: "VOO",
        quantity: null,
        price: null,
        totalAmount: 42,
        currencyCode: "USD",
      }),
    ).toBe("Capital Gain Long: VOO $42.00");
  });

  it("describes an income action with its total", () => {
    expect(
      formatInvestmentCashPayeeName({
        action: InvestmentAction.DIVIDEND,
        symbol: "VOO",
        quantity: null,
        price: null,
        totalAmount: 42.5,
        currencyCode: "USD",
      }),
    ).toBe("Dividend: VOO $42.50");
  });

  it("omits the symbol from an interest line, which has no security", () => {
    expect(
      formatInvestmentCashPayeeName({
        action: InvestmentAction.INTEREST,
        symbol: null,
        quantity: null,
        price: null,
        totalAmount: 3.21,
        currencyCode: "USD",
      }),
    ).toBe("Interest: $3.21");
  });

  it("says Unknown for a trade or income line with no resolvable security", () => {
    expect(
      formatInvestmentCashPayeeName({
        ...buy,
        symbol: null,
        currencyCode: "USD",
      }),
    ).toBe("Buy: Unknown 10 @ $150.00");
  });

  it("leaves no double space when an other-action line has no symbol", () => {
    expect(
      formatInvestmentCashPayeeName({
        action: InvestmentAction.TRANSFER_IN,
        symbol: null,
        quantity: null,
        price: null,
        totalAmount: 8,
        currencyCode: "USD",
      }),
    ).toBe("Transfer In: $8.00");
    expect(
      formatInvestmentCashPayeeName({
        action: InvestmentAction.TRANSFER_IN,
        symbol: "VOO",
        quantity: null,
        price: null,
        totalAmount: 8,
        currencyCode: "USD",
      }),
    ).toBe("Transfer In: VOO $8.00");
  });

  it("describes the size of the activity, never its direction", () => {
    // The register's amount column carries the sign. A cash leg reading
    // "Buy: VOO 10 @ $-150.00" describes nothing that happened.
    expect(
      formatInvestmentCashPayeeName({
        ...buy,
        price: -150,
        totalAmount: -1500,
        currencyCode: "USD",
      }),
    ).toBe("Buy: VOO 10 @ $150.00");
    expect(
      formatInvestmentCashPayeeName({
        action: InvestmentAction.DIVIDEND,
        symbol: "VOO",
        quantity: null,
        price: null,
        totalAmount: -42.5,
        currencyCode: "USD",
      }),
    ).toBe("Dividend: VOO $42.50");
  });

  it("survives the nulls a partially recorded row can carry", () => {
    expect(
      formatInvestmentCashPayeeName({
        action: InvestmentAction.BUY,
        symbol: null,
        quantity: null,
        price: null,
        totalAmount: 0,
        currencyCode: "USD",
      }),
    ).toBe("Buy: Unknown 0 @ $0.00");
  });
});

describe("formatInvestmentActionLabel", () => {
  it("title-cases a snake_case action", () => {
    expect(formatInvestmentActionLabel(InvestmentAction.CAPITAL_GAIN)).toBe(
      "Capital Gain",
    );
    expect(
      formatInvestmentActionLabel(InvestmentAction.REINVEST_CAPITAL_GAIN_SHORT),
    ).toBe("Reinvest Capital Gain Short");
  });
});
