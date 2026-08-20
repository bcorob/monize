import {
  ACCRUED_INTEREST_ACTIONS,
  disposalCashAmount,
  isAccruedInterestCompanion,
  proceedsExcludingAccruedInterest,
  supportsAccruedInterest,
} from "./accrued-interest.util";
import { InvestmentAction } from "./entities/investment-transaction.entity";

describe("accrued interest util", () => {
  describe("ACCRUED_INTEREST_ACTIONS", () => {
    it("is REDEEM alone", () => {
      expect([...ACCRUED_INTEREST_ACTIONS]).toEqual([InvestmentAction.REDEEM]);
    });

    it("does not extend to SELL, whose base action REDEEM shares", () => {
      // REDEEM normalizes to SELL through `baseInvestmentAction`, so a guard
      // written against the base would let accrued interest onto every sale.
      expect(supportsAccruedInterest(InvestmentAction.SELL)).toBe(false);
      expect(supportsAccruedInterest(InvestmentAction.REDEEM)).toBe(true);
      expect(supportsAccruedInterest(InvestmentAction.INTEREST)).toBe(false);
    });
  });

  describe("disposalCashAmount", () => {
    it("adds the accrued interest to the proceeds (spec section 3)", () => {
      expect(disposalCashAmount(9975, 87.5)).toBe(10062.5);
    });

    it("treats absent interest as none, not unknown", () => {
      expect(disposalCashAmount(9975, null)).toBe(9975);
      expect(disposalCashAmount(9975, undefined)).toBe(9975);
      expect(disposalCashAmount(9975, 0)).toBe(9975);
    });

    it("accepts the decimal strings the driver returns", () => {
      expect(disposalCashAmount("9975.0000", "87.5000")).toBe(10062.5);
    });

    it("rounds the sum, not only its operands", () => {
      // Two values that are each exactly representable to 4dp, whose sum in
      // binary floating point is not.
      expect(disposalCashAmount(0.1234, 0.2345)).toBe(0.3579);
      expect(disposalCashAmount(1005.1234, 87.5678)).toBe(1092.6912);
    });
  });

  describe("proceedsExcludingAccruedInterest", () => {
    it("recovers the proceeds from Money's gross cash figure", () => {
      expect(proceedsExcludingAccruedInterest(10062.5, 87.5)).toBe(9975);
    });

    it("round-trips with disposalCashAmount", () => {
      const gross = 10062.5;
      const interest = 87.5;
      expect(
        disposalCashAmount(
          proceedsExcludingAccruedInterest(gross, interest),
          interest,
        ),
      ).toBe(gross);
    });

    it("rounds the difference of two 4dp decimals", () => {
      expect(proceedsExcludingAccruedInterest(1092.6912, 87.5678)).toBe(
        1005.1234,
      );
    });
  });

  describe("isAccruedInterestCompanion", () => {
    const redemption = { id: "redeem-1", action: InvestmentAction.REDEEM };

    it("recognizes a linked INTEREST row pointing at a redemption", () => {
      expect(
        isAccruedInterestCompanion(
          {
            id: "int-1",
            action: InvestmentAction.INTEREST,
            linkedTransactionId: "redeem-1",
          },
          redemption,
        ),
      ).toBe(true);
    });

    it("rejects a free-standing interest payment", () => {
      expect(
        isAccruedInterestCompanion(
          {
            id: "int-1",
            action: InvestmentAction.INTEREST,
            linkedTransactionId: null,
          },
          redemption,
        ),
      ).toBe(false);
    });

    it("rejects a transfer leg, the other user of linkedTransactionId", () => {
      expect(
        isAccruedInterestCompanion(
          {
            id: "out-1",
            action: InvestmentAction.TRANSFER_OUT,
            linkedTransactionId: "in-1",
          },
          { id: "in-1", action: InvestmentAction.TRANSFER_IN },
        ),
      ).toBe(false);
    });

    it("rejects an INTEREST row linked to something that is not a redemption", () => {
      expect(
        isAccruedInterestCompanion(
          {
            id: "int-1",
            action: InvestmentAction.INTEREST,
            linkedTransactionId: "sell-1",
          },
          { id: "sell-1", action: InvestmentAction.SELL },
        ),
      ).toBe(false);
    });

    it("rejects a link that points at a different row", () => {
      expect(
        isAccruedInterestCompanion(
          {
            id: "int-1",
            action: InvestmentAction.INTEREST,
            linkedTransactionId: "redeem-2",
          },
          redemption,
        ),
      ).toBe(false);
    });
  });
});
