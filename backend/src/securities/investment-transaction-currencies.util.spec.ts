import {
  attachInvestmentRowCurrencies,
  investmentRowCurrencies,
} from "./investment-transaction-currencies.util";

describe("investmentRowCurrencies", () => {
  it("denominates price, commission and total in the security's currency", () => {
    expect(
      investmentRowCurrencies({
        security: { currencyCode: "EUR" },
        account: { currencyCode: "PLN" },
        fundingAccount: null,
      }),
    ).toEqual({
      amountCurrencyCode: "EUR",
      priceCurrencyCode: "EUR",
      commissionCurrencyCode: "EUR",
      settlementCurrencyCode: "PLN",
    });
  });

  it("takes the settlement currency from the funding account when one is named", () => {
    const codes = investmentRowCurrencies({
      security: { currencyCode: "USD" },
      account: { currencyCode: "PLN" },
      fundingAccount: { currencyCode: "EUR" },
    });
    expect(codes.settlementCurrencyCode).toBe("EUR");
    expect(codes.amountCurrencyCode).toBe("USD");
  });

  it("denominates a security-less row in the investment account's currency", () => {
    // What the write path did with it: `resolveSettlementCurrencyPair` takes
    // the `from` side of a security-less posting from the investment account,
    // so calling the same figure unknown here contradicted the stored row and
    // withheld the report's total over a cash INTEREST posting.
    expect(
      investmentRowCurrencies({
        security: null,
        account: { currencyCode: "USD" },
      }),
    ).toEqual({
      amountCurrencyCode: "USD",
      priceCurrencyCode: "USD",
      commissionCurrencyCode: "USD",
      settlementCurrencyCode: "USD",
    });
  });

  it("keeps a security-less row's amount in the investment account, not the funding account", () => {
    // The funding account is the `to` side of the pair; the amount is stored
    // on the `from` side.
    expect(
      investmentRowCurrencies({
        security: null,
        account: { currencyCode: "USD" },
        fundingAccount: { currencyCode: "PLN" },
      }),
    ).toEqual({
      amountCurrencyCode: "USD",
      priceCurrencyCode: "USD",
      commissionCurrencyCode: "USD",
      settlementCurrencyCode: "PLN",
    });
  });

  it("reports an unknown amount currency when neither a security nor the account is loaded", () => {
    expect(
      investmentRowCurrencies({ security: null }).amountCurrencyCode,
    ).toBeNull();
  });

  it("reports an unknown settlement currency when neither account is loaded", () => {
    expect(
      investmentRowCurrencies({ security: { currencyCode: "GBP" } })
        .settlementCurrencyCode,
    ).toBeNull();
  });

  it("stamps every row of a page", () => {
    const rows = [
      { security: { currencyCode: "EUR" }, account: { currencyCode: "PLN" } },
      { security: { currencyCode: "USD" }, account: { currencyCode: "PLN" } },
    ];
    attachInvestmentRowCurrencies(rows);
    expect(
      rows.map(
        (r) => (r as { amountCurrencyCode?: string }).amountCurrencyCode,
      ),
    ).toEqual(["EUR", "USD"]);
  });
});
