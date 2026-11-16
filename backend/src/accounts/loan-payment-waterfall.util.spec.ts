import {
  allocateLoanPayment,
  bookLoanAllocation,
} from "./loan-payment-waterfall.util";

describe("allocateLoanPayment", () => {
  it("passes an ordinary installment through unchanged", () => {
    const result = allocateLoanPayment({
      paymentAmount: 1000,
      extraPrincipal: 300,
      interest: 200,
      principal: 500,
      currentBalance: 100000,
    });
    expect(result).toEqual({
      principal: 500,
      interest: 200,
      extraPrincipal: 300,
      total: 1000,
      unpaidInterest: 0,
    });
  });

  it("applies the payment interest-first across the whole installment, extra included", () => {
    // 1,000 payment with 300 extra against 800 of accrued interest: the extra
    // instruction has no principal to reduce until the interest is met
    // (recheck DR3-01).
    const result = allocateLoanPayment({
      paymentAmount: 1000,
      extraPrincipal: 300,
      interest: 800,
      principal: 0,
      currentBalance: 100000,
    });
    expect(result.interest).toBe(800);
    expect(result.principal).toBe(0);
    expect(result.extraPrincipal).toBe(200);
    expect(result.total).toBe(1000);
  });

  it("bounds interest by the whole installment so a child cannot exceed the parent", () => {
    // 5,000 accrued against a 1,000 payment previously wrote an interest child
    // of -5,000 under a parent of -1,000 (recheck RR2-006).
    const result = allocateLoanPayment({
      paymentAmount: 1000,
      extraPrincipal: 0,
      interest: 5000,
      principal: 0,
      currentBalance: 100000,
    });
    expect(result).toEqual({
      principal: 0,
      interest: 1000,
      extraPrincipal: 0,
      total: 1000,
      unpaidInterest: 4000,
    });
  });

  describe("an installment below the accrued interest (A26-S15-04, R3)", () => {
    // LOAN 400,000.00 at 6 % monthly: 2,000.00 accrues against a 1,500.00 bill.
    const r3 = {
      paymentAmount: 1500,
      extraPrincipal: 0,
      interest: 2000,
      principal: 0,
      currentBalance: 400000,
    };

    it("by default keeps the cap and reports the shortfall it did not book", () => {
      expect(allocateLoanPayment(r3)).toEqual({
        principal: 0,
        interest: 1500,
        extraPrincipal: 0,
        total: 1500,
        unpaidInterest: 500,
      });
    });

    it("capitalizes the shortfall as a negative principal", () => {
      expect(
        allocateLoanPayment({ ...r3, capitalizeUnpaidInterest: true }),
      ).toEqual({
        principal: -500,
        interest: 2000,
        extraPrincipal: 0,
        total: 1500,
        unpaidInterest: 500,
      });
    });

    it("counts the standing extra as part of the installment and sheds it", () => {
      // 1,500 with 200 extra (base 1,300): the whole installment is below the
      // 2,000 of interest, so the extra goes too.
      expect(
        allocateLoanPayment({
          ...r3,
          extraPrincipal: 200,
          capitalizeUnpaidInterest: true,
        }),
      ).toEqual({
        principal: -500,
        interest: 2000,
        extraPrincipal: 0,
        total: 1500,
        unpaidInterest: 500,
      });
    });

    it("books no shortfall when the installment exactly covers the interest", () => {
      expect(
        allocateLoanPayment({
          ...r3,
          interest: 1500,
          capitalizeUnpaidInterest: true,
        }),
      ).toEqual({
        principal: 0,
        interest: 1500,
        extraPrincipal: 0,
        total: 1500,
        unpaidInterest: 0,
      });
    });

    it("sheds the extra, not the principal, when only the base payment falls short", () => {
      // Interest 1,400 against base 1,300 + extra 200: covered by the whole
      // installment, so unchanged and nothing is capitalized.
      expect(
        allocateLoanPayment({
          ...r3,
          interest: 1400,
          extraPrincipal: 200,
          capitalizeUnpaidInterest: true,
        }),
      ).toEqual({
        principal: 0,
        interest: 1400,
        extraPrincipal: 100,
        total: 1500,
        unpaidInterest: 0,
      });
    });

    it("rounds the shortfall to 4dp", () => {
      const result = allocateLoanPayment({
        ...r3,
        interest: 2000.00004,
        capitalizeUnpaidInterest: true,
      });
      expect(result.unpaidInterest).toBe(500);
      expect(result.principal + result.interest).toBe(result.total);
    });

    it("has nothing to capitalize against a zero installment", () => {
      expect(
        allocateLoanPayment({
          ...r3,
          paymentAmount: 0,
          capitalizeUnpaidInterest: true,
        }),
      ).toMatchObject({ principal: 0, interest: 0, total: 0 });
    });
  });

  it("clamps regular and extra principal together against the balance (FR-009)", () => {
    // 500 remaining against 400 amortized principal plus a 300 standing extra:
    // the extra absorbs the shortfall, so 400 + 100 retires the debt exactly.
    const result = allocateLoanPayment({
      paymentAmount: 700,
      extraPrincipal: 300,
      interest: 10,
      principal: 400,
      currentBalance: 500,
    });
    expect(result.principal).toBe(400);
    expect(result.extraPrincipal).toBe(100);
    expect(result.total).toBe(510);
  });

  it("shrinks the final installment with the debt (audit P5-008)", () => {
    const result = allocateLoanPayment({
      paymentAmount: 1000,
      extraPrincipal: 0,
      interest: 1,
      principal: 999,
      currentBalance: 50,
    });
    expect(result.principal).toBe(50);
    expect(result.interest).toBe(1);
    expect(result.total).toBe(51);
  });

  it("does not clamp interest by the balance", () => {
    // Interest accrued on the debt and is owed independently of how much
    // principal is left to retire.
    const result = allocateLoanPayment({
      paymentAmount: 1000,
      extraPrincipal: 0,
      interest: 80,
      principal: 920,
      currentBalance: 30,
    });
    expect(result.interest).toBe(80);
    expect(result.principal).toBe(30);
    expect(result.total).toBe(110);
  });

  it("applies no balance clamp when the balance is unknown", () => {
    const result = allocateLoanPayment({
      paymentAmount: 1000,
      extraPrincipal: 200,
      interest: 100,
      principal: 700,
      currentBalance: null,
    });
    expect(result).toEqual({
      principal: 700,
      interest: 100,
      extraPrincipal: 200,
      total: 1000,
      unpaidInterest: 0,
    });
  });

  it("treats negative inputs as zero rather than crediting the borrower", () => {
    const result = allocateLoanPayment({
      paymentAmount: 1000,
      extraPrincipal: -5,
      interest: -10,
      principal: -20,
      currentBalance: 100000,
    });
    expect(result).toEqual({
      principal: 0,
      interest: 0,
      extraPrincipal: 0,
      total: 0,
      unpaidInterest: 0,
    });
  });

  it("rounds each part and the total to 4dp", () => {
    const result = allocateLoanPayment({
      paymentAmount: 100.00005,
      extraPrincipal: 0,
      interest: 33.33333,
      principal: 66.66667,
      currentBalance: 1000,
    });
    expect(result.interest).toBe(33.3333);
    expect(result.principal).toBe(66.6667);
    expect(result.total).toBe(100);
  });
});

describe("bookLoanAllocation", () => {
  it("rounds total and interest to the unit and lets principal take the rest (issue #1581)", () => {
    expect(
      bookLoanAllocation(
        {
          principal: 864.5833,
          interest: 306.0625,
          extraPrincipal: 0,
          total: 1170.6458,
          unpaidInterest: 0,
        },
        2,
      ),
    ).toEqual({
      principal: 864.59,
      interest: 306.06,
      extraPrincipal: 0,
      total: 1170.65,
      unpaidInterest: 0,
    });
  });

  it("books whole units for a zero-decimal currency", () => {
    expect(
      bookLoanAllocation(
        {
          principal: 1000.4,
          interest: 500.4,
          extraPrincipal: 0,
          total: 1500.8,
          unpaidInterest: 0,
        },
        0,
      ),
    ).toEqual({
      principal: 1001,
      interest: 500,
      extraPrincipal: 0,
      total: 1501,
      unpaidInterest: 0,
    });
  });

  it("lets the extra take the rounding when principal is zero, so no line turns negative", () => {
    // Interest-only with a standing extra: 100.01 + 50.01 rounded is 150.02
    // against a 150.01 bill; principal cannot give up the cent it does not have.
    expect(
      bookLoanAllocation(
        {
          principal: 0,
          interest: 100.005,
          extraPrincipal: 50.005,
          total: 150.01,
          unpaidInterest: 0,
        },
        2,
      ),
    ).toEqual({
      principal: 0,
      interest: 100.01,
      extraPrincipal: 50,
      total: 150.01,
      unpaidInterest: 0,
    });
  });

  it("leaves an installment already in cents unchanged", () => {
    const allocation = {
      principal: 507.5,
      interest: 992.5,
      extraPrincipal: 100,
      total: 1600,
      unpaidInterest: 0,
    };
    expect(bookLoanAllocation(allocation, 2)).toEqual(allocation);
  });

  describe("a capitalized shortfall (A26-S15-04)", () => {
    const capitalized = {
      principal: -500,
      interest: 2000,
      extraPrincipal: 0,
      total: 1500,
      unpaidInterest: 500,
    };

    it("keeps the negative principal on the principal line", () => {
      expect(bookLoanAllocation(capitalized, 2, 400000)).toEqual(capitalized);
    });

    it("absorbs the unit rounding on the negative principal and reports its magnitude", () => {
      // 2,000.005 rounds to 2,000.01 against a 1,500.00 bill: the principal
      // line takes the cent, never the (zero) extra.
      expect(
        bookLoanAllocation(
          {
            principal: -500.005,
            interest: 2000.005,
            extraPrincipal: 0,
            total: 1500,
            unpaidInterest: 500.005,
          },
          2,
          400000,
        ),
      ).toEqual({
        principal: -500.01,
        interest: 2000.01,
        extraPrincipal: 0,
        total: 1500,
        unpaidInterest: 500.01,
      });
    });

    it("carries a shortfall the default cap did not book", () => {
      expect(
        bookLoanAllocation(
          {
            principal: 0,
            interest: 1500,
            extraPrincipal: 0,
            total: 1500,
            unpaidInterest: 500,
          },
          2,
          400000,
        ),
      ).toMatchObject({ principal: 0, interest: 1500, unpaidInterest: 500 });
    });
  });

  describe("never retires more than the debt", () => {
    it("cuts a final installment on a 4dp ledger down to the unit, never into credit", () => {
      // A ledger posted at 4dp before #1581 owes 833.3449. Rounding would
      // book 833.35 of principal and leave the loan 0.0051 in credit.
      const booked = bookLoanAllocation(
        {
          principal: 833.3449,
          interest: 2.7749,
          extraPrincipal: 0,
          total: 836.1198,
          unpaidInterest: 0,
        },
        2,
        833.3449,
      );
      expect(booked).toEqual({
        principal: 833.34,
        interest: 2.77,
        extraPrincipal: 0,
        total: 836.11,
        unpaidInterest: 0,
      });
      // The residue is under one cent: the next occurrence reads it as
      // paid off (`debt <= 0.01`).
      expect(833.3449 - booked.principal).toBeLessThan(0.01);
      expect(booked.principal).toBeLessThanOrEqual(833.3449);
    });

    it("retires a ledger booked in cents exactly", () => {
      expect(
        bookLoanAllocation(
          {
            principal: 833.34,
            interest: 2.7778,
            extraPrincipal: 0,
            total: 836.1178,
            unpaidInterest: 0,
          },
          2,
          833.34,
        ),
      ).toEqual({
        principal: 833.34,
        interest: 2.78,
        extraPrincipal: 0,
        total: 836.12,
        unpaidInterest: 0,
      });
    });

    it("cuts principal and extra together when both retire the debt", () => {
      const booked = bookLoanAllocation(
        {
          principal: 800.0049,
          interest: 2.0049,
          extraPrincipal: 33.34,
          total: 835.3498,
          unpaidInterest: 0,
        },
        2,
        833.3449,
      );
      expect(booked.principal + booked.extraPrincipal).toBeLessThanOrEqual(
        833.3449,
      );
      expect(booked).toEqual({
        principal: 800,
        interest: 2,
        extraPrincipal: 33.34,
        total: 835.34,
        unpaidInterest: 0,
      });
    });
  });
});
