import { InvestmentAction } from "./entities/investment-transaction.entity";
import {
  actionCarriesTotal,
  deriveInvestmentTotal,
  derivePriceFromTotal,
  resolveInvestmentAmounts,
} from "./investment-amount.util";

describe("investment-amount.util", () => {
  describe("deriveInvestmentTotal", () => {
    it("adds an acquisition's commission and subtracts a disposal's", () => {
      expect(
        deriveInvestmentTotal({
          action: InvestmentAction.BUY,
          quantity: 10,
          price: 100,
          commission: 5,
        }),
      ).toBe(1005);
      expect(
        deriveInvestmentTotal({
          action: InvestmentAction.SELL,
          quantity: 10,
          price: 100,
          commission: 5,
        }),
      ).toBe(995);
    });

    it("treats an income action's absent quantity as one unit", () => {
      expect(
        deriveInvestmentTotal({
          action: InvestmentAction.DIVIDEND,
          price: 50,
        }),
      ).toBe(50);
    });

    it("carries no total for the share-only actions", () => {
      expect(
        deriveInvestmentTotal({
          action: InvestmentAction.ADD_SHARES,
          quantity: 10,
          price: 100,
        }),
      ).toBe(0);
      expect(actionCarriesTotal(InvestmentAction.ADD_SHARES)).toBe(false);
      expect(actionCarriesTotal(InvestmentAction.REDEEM)).toBe(true);
    });
  });

  describe("derivePriceFromTotal", () => {
    // The statement's figure: 141 shares realised 820.9081, which is not
    // 141 x 5.82 (= 820.62). The price is what the total says it was.
    it("divides a disposal's total, commission put back in, at ten decimals", () => {
      expect(
        derivePriceFromTotal({
          action: InvestmentAction.SELL,
          totalAmount: 820.9081,
          quantity: 141,
          commission: 0,
        }),
      ).toBe(5.8220432624);
      expect(
        derivePriceFromTotal({
          action: InvestmentAction.SELL,
          totalAmount: 820.9081,
          quantity: 141,
          commission: 1.41,
        }),
      ).toBe(5.8320432624);
    });

    it("takes an acquisition's commission out before dividing", () => {
      expect(
        derivePriceFromTotal({
          action: InvestmentAction.BUY,
          totalAmount: 1005,
          quantity: 10,
          commission: 5,
        }),
      ).toBe(100);
    });

    it("refuses without shares to divide by, and for an action with no total", () => {
      expect(
        derivePriceFromTotal({
          action: InvestmentAction.BUY,
          totalAmount: 100,
          quantity: 0,
        }),
      ).toBeNull();
      expect(
        derivePriceFromTotal({
          action: InvestmentAction.SPLIT,
          totalAmount: 100,
          quantity: 2,
        }),
      ).toBeNull();
    });
  });

  describe("resolveInvestmentAmounts", () => {
    it("stores a supplied total as given and derives the price from it", () => {
      expect(
        resolveInvestmentAmounts({
          action: InvestmentAction.SELL,
          quantity: 141,
          price: 5.82,
          commission: 0,
          totalAmount: 820.91,
        }),
      ).toEqual({ totalAmount: 820.91, price: 5.8220567376 });
    });

    it("keeps a supplied price that already implies the supplied total", () => {
      expect(
        resolveInvestmentAmounts({
          action: InvestmentAction.BUY,
          quantity: 10,
          price: 100.5,
          commission: 5,
          totalAmount: 1010,
        }),
      ).toEqual({ totalAmount: 1010, price: 100.5 });
    });

    it("derives the total from the price when no total is supplied", () => {
      expect(
        resolveInvestmentAmounts({
          action: InvestmentAction.BUY,
          quantity: 8,
          price: 5.8319625,
          commission: 0,
        }),
      ).toEqual({ totalAmount: 46.6557, price: 5.8319625 });
    });

    it("ignores a total supplied for an action that carries none", () => {
      expect(
        resolveInvestmentAmounts({
          action: InvestmentAction.ADD_SHARES,
          quantity: 10,
          price: 3,
          totalAmount: 30,
        }),
      ).toEqual({ totalAmount: 0, price: 3 });
    });

    it("keeps the supplied price when the total cannot be divided", () => {
      expect(
        resolveInvestmentAmounts({
          action: InvestmentAction.BUY,
          quantity: 0,
          price: 12,
          totalAmount: 25,
        }),
      ).toEqual({ totalAmount: 25, price: 12 });
    });
  });
});
