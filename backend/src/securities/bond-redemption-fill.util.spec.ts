import { applyRedemptionSplit } from "./bond-redemption-fill.util";

/** The cases of `docs/specs/bond-redemption-interest.md` 3.1, per bond, times `q`. */
const EDO0423_AT_MATURITY = {
  principal: 1000,
  deduction: 0,
  interest: 470.5,
  principalReturned: 1000,
  payout: 1470.5,
};
// COI early redemption in period 2: accrued 1.20, flat fee 2.00, no floor.
const COI_EARLY = {
  principal: 100,
  deduction: 2,
  interest: 0,
  principalReturned: 99.2,
  payout: 99.2,
};

const nothing = {
  quantity: 10,
  price: null,
  totalAmount: undefined,
  commission: 0,
  accruedInterest: 0,
};

describe("applyRedemptionSplit (INV-BOND-009)", () => {
  it("fills price 100.00 and accrued interest 470.50 for 10 x EDO0423 at maturity", () => {
    const filled = applyRedemptionSplit(EDO0423_AT_MATURITY, nothing);
    expect(filled.price).toBe(100);
    expect(filled.accruedInterest).toBe(470.5);
    expect(filled.totalAmount).toBeUndefined();
    // price x q + interest is the payout, exactly.
    expect(filled.price! * 10 + filled.accruedInterest).toBe(1470.5);
    expect(filled.split).toEqual({
      principal: 1000,
      interest: 470.5,
      deduction: 0,
      payout: 1470.5,
      outcome: "filled",
    });
  });

  it("books a deduction larger than the interest as a price below the principal and no interest (COI early)", () => {
    const filled = applyRedemptionSplit(COI_EARLY, {
      ...nothing,
      quantity: 1,
    });
    expect(filled.price).toBe(99.2);
    expect(filled.accruedInterest).toBe(0);
    expect(filled.split).toMatchObject({ deduction: 2, outcome: "filled" });
  });

  it("splits a price that is the whole payout per bond, or a total equal to it", () => {
    const byPrice = applyRedemptionSplit(EDO0423_AT_MATURITY, {
      ...nothing,
      price: 147.05,
    });
    expect(byPrice).toMatchObject({ price: 100, accruedInterest: 470.5 });

    const byTotal = applyRedemptionSplit(EDO0423_AT_MATURITY, {
      ...nothing,
      totalAmount: 1470.5,
    });
    expect(byTotal).toMatchObject({
      price: 100,
      accruedInterest: 470.5,
      totalAmount: undefined,
    });
  });

  it("fills only the price when the interest was given", () => {
    const filled = applyRedemptionSplit(EDO0423_AT_MATURITY, {
      ...nothing,
      accruedInterest: 470.5,
    });
    expect(filled).toMatchObject({ price: 100, accruedInterest: 470.5 });
    expect(filled.split.outcome).toBe("filled");
  });

  it("keeps what the caller stated and says whether it agrees with the split", () => {
    const agrees = applyRedemptionSplit(EDO0423_AT_MATURITY, {
      ...nothing,
      price: 100,
      accruedInterest: 470.5,
    });
    expect(agrees.split.outcome).toBe("matches");

    // Within a cent of rounding is not a difference.
    const rounding = applyRedemptionSplit(EDO0423_AT_MATURITY, {
      ...nothing,
      price: 100,
      accruedInterest: 470.51,
    });
    expect(rounding.split.outcome).toBe("matches");

    const differs = applyRedemptionSplit(EDO0423_AT_MATURITY, {
      ...nothing,
      price: 100,
      accruedInterest: 400,
    });
    expect(differs).toMatchObject({ price: 100, accruedInterest: 400 });
    expect(differs.split.outcome).toBe("differs");

    // A price that is neither the payout nor given with its interest.
    const principalOnly = applyRedemptionSplit(EDO0423_AT_MATURITY, {
      ...nothing,
      price: 100,
    });
    expect(principalOnly).toMatchObject({ price: 100, accruedInterest: 0 });
    expect(principalOnly.split.outcome).toBe("differs");
  });
});
