import {
  computeInvestmentCashImpact,
  isInvestmentActionAllowedInSplit,
} from "./cash-impact.util";
import { InvestmentAction } from "./entities/investment-transaction.entity";

describe("computeInvestmentCashImpact", () => {
  it("returns negative for BUY (cash leaves)", () => {
    expect(computeInvestmentCashImpact(InvestmentAction.BUY, 75, 10, 0)).toBe(
      -750,
    );
  });

  it("includes commission in BUY total", () => {
    expect(
      computeInvestmentCashImpact(InvestmentAction.BUY, 100, 50, 9.99),
    ).toBe(-5009.99);
  });

  it("returns positive for SELL (cash arrives) net of commission", () => {
    expect(
      computeInvestmentCashImpact(InvestmentAction.SELL, 100, 50, 9.99),
    ).toBe(4990.01);
  });

  it.each([
    InvestmentAction.DIVIDEND,
    InvestmentAction.INTEREST,
    InvestmentAction.CAPITAL_GAIN,
    InvestmentAction.RETURN_OF_CAPITAL,
  ])(
    "treats %s with default qty=1 and uses price as the cash amount",
    (action) => {
      expect(computeInvestmentCashImpact(action, 0, 25.5, 0)).toBe(25.5);
      expect(computeInvestmentCashImpact(action, 1, 25.5, 0)).toBe(25.5);
    },
  );

  it("returns 0 for REINVEST (net-zero cash, holdings still update)", () => {
    expect(
      computeInvestmentCashImpact(InvestmentAction.REINVEST, 5, 10, 0),
    ).toBe(0);
  });

  it("returns 0 for share-only actions", () => {
    expect(
      computeInvestmentCashImpact(InvestmentAction.ADD_SHARES, 10, 0, 0),
    ).toBe(0);
    expect(
      computeInvestmentCashImpact(InvestmentAction.REMOVE_SHARES, 10, 0, 0),
    ).toBe(0);
    expect(
      computeInvestmentCashImpact(InvestmentAction.TRANSFER_IN, 10, 5, 0),
    ).toBe(0);
    expect(computeInvestmentCashImpact(InvestmentAction.SPLIT, 2, 0, 0)).toBe(
      0,
    );
  });
});

describe("isInvestmentActionAllowedInSplit", () => {
  it("allows cash-impacting actions", () => {
    [
      InvestmentAction.BUY,
      InvestmentAction.SELL,
      InvestmentAction.DIVIDEND,
      InvestmentAction.INTEREST,
      InvestmentAction.CAPITAL_GAIN,
      InvestmentAction.REINVEST,
      InvestmentAction.RETURN_OF_CAPITAL,
    ].forEach((a) => expect(isInvestmentActionAllowedInSplit(a)).toBe(true));
  });

  it("disallows share-only actions", () => {
    [
      InvestmentAction.ADD_SHARES,
      InvestmentAction.REMOVE_SHARES,
      InvestmentAction.TRANSFER_IN,
      InvestmentAction.TRANSFER_OUT,
      InvestmentAction.SPLIT,
    ].forEach((a) => expect(isInvestmentActionAllowedInSplit(a)).toBe(false));
  });
});
