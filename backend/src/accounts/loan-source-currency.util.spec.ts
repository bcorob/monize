import { BadRequestException } from "@nestjs/common";
import { assertLoanSourceCurrency } from "./loan-source-currency.util";

describe("assertLoanSourceCurrency", () => {
  it("accepts a payment account in the loan's currency", () => {
    expect(() => assertLoanSourceCurrency("EUR", "EUR")).not.toThrow();
  });

  it("compares the codes case-insensitively", () => {
    expect(() => assertLoanSourceCurrency("eur", "EUR")).not.toThrow();
  });

  it("refuses a payment account in another currency, naming both", () => {
    expect(() => assertLoanSourceCurrency("PLN", "EUR")).toThrow(
      new BadRequestException(
        "The payment account is in PLN and the loan in EUR. Choose an account in EUR.",
      ),
    );
  });
});
