import { BadRequestException } from "@nestjs/common";
import { roundMoney } from "../common/round.util";
import { addMonthsClamped } from "../common/recurrence";
import { getPeriodicRate } from "./mortgage-amortization.util";
import {
  MortgageMethodTerms,
  assertMortgageMethodTerms,
  calendarPaymentNumber,
  constantLinearPrincipal,
  linearResidueBound,
  methodPrincipal,
  missingMethodTerms,
  nonAnnuityInstallment,
  remainingScheduledPayments,
  scheduledPaymentCount,
  scheduledPaymentDate,
} from "./mortgage-installment.util";
import { MortgageType, PrepaymentMode } from "./mortgage-type.util";

/**
 * docs/specs/mortgage-types.md, section 7: EUR 300,000 over 360 monthly
 * payments from 2024-01-01, 2.00% until 4.00% from 2027-01-01, repayments of
 * 20,000 on 2025-07-01 and 15,000 on 2026-01-01. A repayment dated on a due
 * date is in that installment's debt.
 */
const TERMS: MortgageMethodTerms = {
  originalPrincipal: 300000,
  openingBalance: -300000,
  amortizationMonths: 360,
  paymentStartDate: "2024-01-01",
  paymentFrequency: "MONTHLY",
};

const REPAYMENTS: Array<[string, number]> = [
  ["2025-07-01", 20000],
  ["2026-01-01", 15000],
];

const annualRateOn = (d: string): number => (d >= "2027-01-01" ? 4 : 2);

interface Row {
  due: string;
  debt: number;
  principal: number;
  interest: number;
}

/**
 * The schedule the engine posts: each due date is priced from the debt left
 * by the postings before it (at storage precision) and the repayments dated on
 * or before it, the way `resolveInstallment` prices from `datedLoanDebt`.
 */
function simulate(type: MortgageType, mode: PrepaymentMode | null): Row[] {
  const terms = { ...TERMS, prepaymentMode: mode };
  const rows: Row[] = [];
  let debt = 300000;
  const pending = [...REPAYMENTS];
  for (let n = 0; n < 400 && debt > 0.01; n++) {
    const due = addMonthsClamped("2024-01-01", n);
    while (pending.length > 0 && pending[0][0] <= due) {
      debt = roundMoney(debt - pending.shift()![1]);
    }
    const installment = nonAnnuityInstallment(
      type,
      terms,
      due,
      debt,
      getPeriodicRate(annualRateOn(due), 12, type),
    );
    if (!installment) throw new Error(`unpriced on ${due}`);
    rows.push({ due, debt, ...installment });
    debt = roundMoney(debt - installment.principal);
  }
  return rows;
}

const at = (rows: Row[], due: string): Row => {
  const row = rows.find((r) => r.due === due);
  if (!row) throw new Error(`no row on ${due}`);
  return row;
};

const lifetimeInterest = (rows: Row[]): number =>
  roundMoney(rows.reduce((sum, r) => sum + r.interest, 0));

describe("the calendar (spec section 2)", () => {
  it("counts N from the amortization and the cadence", () => {
    expect(scheduledPaymentCount(TERMS)).toBe(360);
    expect(
      scheduledPaymentCount({ ...TERMS, paymentFrequency: "BIWEEKLY" }),
    ).toBe(780);
  });

  it("has no N without the amortization or a known cadence", () => {
    expect(
      scheduledPaymentCount({ ...TERMS, amortizationMonths: null }),
    ).toBeNull();
    expect(
      scheduledPaymentCount({ ...TERMS, paymentFrequency: "FORTNIGHTLY" }),
    ).toBeNull();
    expect(scheduledPaymentCount({ ...TERMS, paymentFrequency: null })).toBe(
      null,
    );
  });

  it("dates payment n on the scheduler's calendar", () => {
    expect(scheduledPaymentDate(TERMS, 1)).toBe("2024-01-01");
    expect(scheduledPaymentDate(TERMS, 19)).toBe("2025-07-01");
    expect(scheduledPaymentDate(TERMS, 360)).toBe("2053-12-01");
    expect(scheduledPaymentDate({ ...TERMS, paymentStartDate: null }, 1)).toBe(
      null,
    );
  });

  it.each([
    ["2023-12-31", 0],
    ["2024-01-01", 1],
    ["2025-07-01", 19],
    // A date off the calendar (a due date the user moved) counts the dates
    // on or before it.
    ["2025-07-10", 19],
    ["2026-01-01", 25],
    ["2027-01-01", 37],
    ["2053-12-01", 360],
    ["2060-01-01", 361],
  ])("k(%s) is %d", (d, k) => {
    expect(calendarPaymentNumber(TERMS, d)).toBe(k);
  });

  it.each([
    ["2024-01-01", 360],
    ["2025-07-01", 342],
    ["2026-01-01", 336],
    ["2027-01-01", 324],
    ["2053-12-01", 1],
    ["2054-01-01", 0],
    // Before the first payment the debt is spread over the whole schedule.
    ["2023-06-01", 360],
  ])("remaining(%s) is %d", (d, remaining) => {
    expect(remainingScheduledPayments(TERMS, d)).toBe(remaining);
  });

  it("has no calendar without a start date", () => {
    expect(
      remainingScheduledPayments(
        { ...TERMS, paymentStartDate: null },
        "2025-07-01",
      ),
    ).toBeNull();
  });
});

describe("constantLinearPrincipal", () => {
  it("is P / N at storage precision", () => {
    expect(constantLinearPrincipal(TERMS)).toBe(833.3333);
  });

  it("falls back to the opening balance when original_principal is null", () => {
    expect(constantLinearPrincipal({ ...TERMS, originalPrincipal: null })).toBe(
      833.3333,
    );
  });

  it("is unknown when there is no principal to divide", () => {
    expect(
      constantLinearPrincipal({
        ...TERMS,
        originalPrincipal: null,
        openingBalance: 0,
      }),
    ).toBeNull();
    expect(
      constantLinearPrincipal({ ...TERMS, amortizationMonths: null }),
    ).toBeNull();
  });
});

describe("methodPrincipal (spec table 4.3)", () => {
  const base = {
    constantPrincipal: 833.3333,
    count: 360,
  };

  it("SHORTEN_TERM: the constant principal", () => {
    expect(
      methodPrincipal({
        ...base,
        method: "LINEAR",
        mode: "SHORTEN_TERM",
        debt: 265000.0006,
        remaining: 342,
      }),
    ).toBe(833.3333);
  });

  it("SHORTEN_TERM: the final installment absorbs a leftover within the bound", () => {
    expect(linearResidueBound(360)).toBe(1.8);
    expect(
      methodPrincipal({
        ...base,
        method: "LINEAR",
        mode: "SHORTEN_TERM",
        debt: 833.3439,
        remaining: 43,
      }),
    ).toBe(833.3439);
    expect(
      methodPrincipal({
        ...base,
        method: "LINEAR",
        mode: "SHORTEN_TERM",
        debt: 835.1333,
        remaining: 43,
      }),
    ).toBe(835.1333);
  });

  it("SHORTEN_TERM: a leftover above the bound is a real last payment", () => {
    expect(
      methodPrincipal({
        ...base,
        method: "LINEAR",
        mode: "SHORTEN_TERM",
        debt: 835.1334,
        remaining: 43,
      }),
    ).toBe(833.3333);
  });

  it("LOWER_INSTALLMENT: debt over the remaining payments, the whole debt on the last", () => {
    expect(
      methodPrincipal({
        ...base,
        method: "LINEAR",
        mode: "LOWER_INSTALLMENT",
        debt: 265000.0006,
        remaining: 342,
      }),
    ).toBe(774.8538);
    expect(
      methodPrincipal({
        ...base,
        method: "LINEAR",
        mode: "LOWER_INSTALLMENT",
        debt: 730.2109,
        remaining: 1,
      }),
    ).toBe(730.2109);
  });

  it("INTEREST_ONLY: nothing until the bullet", () => {
    expect(
      methodPrincipal({
        ...base,
        method: "INTEREST_ONLY",
        mode: "SHORTEN_TERM",
        debt: 265000,
        remaining: 2,
      }),
    ).toBe(0);
    expect(
      methodPrincipal({
        ...base,
        method: "INTEREST_ONLY",
        mode: "SHORTEN_TERM",
        debt: 265000,
        remaining: 1,
      }),
    ).toBe(265000);
  });

  it.each([
    ["LINEAR", "SHORTEN_TERM"],
    ["LINEAR", "LOWER_INSTALLMENT"],
    ["INTEREST_ONLY", "SHORTEN_TERM"],
  ] as const)(
    "%s %s: past the term end the whole debt is principal",
    (method, mode) => {
      expect(
        methodPrincipal({
          ...base,
          method,
          mode,
          debt: 50000,
          remaining: 0,
        }),
      ).toBe(50000);
    },
  );

  it("a retired debt has no principal", () => {
    expect(
      methodPrincipal({
        ...base,
        method: "LINEAR",
        mode: "SHORTEN_TERM",
        debt: 0,
        remaining: 10,
      }),
    ).toBe(0);
  });
});

describe("the worked example, row by row (spec section 7)", () => {
  it("7.1 LINEAR, SHORTEN_TERM", () => {
    const rows = simulate("LINEAR", null);
    const expected: Array<[string, number, number, number]> = [
      ["2024-01-01", 300000.0, 833.3333, 500.0],
      ["2024-02-01", 299166.6667, 833.3333, 498.6111],
      ["2025-07-01", 265000.0006, 833.3333, 441.6667],
      ["2026-01-01", 245000.0008, 833.3333, 408.3333],
      ["2026-12-01", 235833.3345, 833.3333, 393.0556],
      ["2027-01-01", 235000.0012, 833.3333, 783.3333],
      ["2050-06-01", 833.3439, 833.3439, 2.7778],
    ];
    for (const [due, debt, principal, interest] of expected) {
      expect(at(rows, due)).toEqual({ due, debt, principal, interest });
    }
    expect(roundMoney(at(rows, "2024-01-01").interest + 833.3333)).toBe(
      1333.3333,
    );
    expect(
      roundMoney(
        at(rows, "2027-01-01").principal + at(rows, "2027-01-01").interest,
      ),
    ).toBe(1616.6666);
    // 318 payments, the last on 2050-06-01, and no 0.0106 payment after it.
    expect(rows).toHaveLength(318);
    expect(rows[rows.length - 1].due).toBe("2050-06-01");
    expect(rows.some((r) => r.due === "2050-07-01")).toBe(false);
    expect(lifetimeInterest(rows)).toBe(127066.6723);
  });

  it("7.2 the same ledger recorded at statement cents", () => {
    // Eighteen postings of 833.33, then the 20,000 repayment.
    const debt = roundMoney(300000 - 18 * 833.33 - 20000);
    expect(debt).toBe(265000.06);
    const installment = nonAnnuityInstallment(
      "LINEAR",
      TERMS,
      "2025-07-01",
      debt,
      getPeriodicRate(2, 12, "LINEAR"),
    );
    expect(installment).toEqual({ principal: 833.3333, interest: 441.6668 });
  });

  it("7.3 LINEAR, LOWER_INSTALLMENT", () => {
    const rows = simulate("LINEAR", "LOWER_INSTALLMENT");
    const expected: Array<[string, number, number, number]> = [
      ["2024-01-01", 300000.0, 833.3333, 500.0],
      ["2025-07-01", 265000.0006, 774.8538, 441.6667],
      ["2026-01-01", 245350.8778, 730.2109, 408.9181],
      ["2027-01-01", 236588.347, 730.2109, 788.6278],
      ["2053-12-01", 730.2109, 730.2109, 2.434],
    ];
    for (const [due, debt, principal, interest] of expected) {
      expect(at(rows, due)).toEqual({ due, debt, principal, interest });
    }
    expect(rows).toHaveLength(360);
    expect(rows[rows.length - 1].due).toBe("2053-12-01");
    expect(lifetimeInterest(rows)).toBe(144396.8448);
  });

  it("7.4 INTEREST_ONLY", () => {
    const rows = simulate("INTEREST_ONLY", null);
    const expected: Array<[string, number, number, number]> = [
      ["2024-01-01", 300000.0, 0, 500.0],
      ["2025-07-01", 280000.0, 0, 466.6667],
      ["2026-01-01", 265000.0, 0, 441.6667],
      ["2027-01-01", 265000.0, 0, 883.3333],
      ["2053-12-01", 265000.0, 265000.0, 883.3333],
    ];
    for (const [due, debt, principal, interest] of expected) {
      expect(at(rows, due)).toEqual({ due, debt, principal, interest });
    }
    expect(rows).toHaveLength(360);
  });
});

describe("missing terms (spec section 8)", () => {
  it("names nothing for an annuity type", () => {
    expect(missingMethodTerms("ANNUITY", {})).toEqual([]);
    expect(missingMethodTerms("CANADIAN_FIXED", {})).toEqual([]);
    expect(() => assertMortgageMethodTerms("ANNUITY", {})).not.toThrow();
  });

  it("names every missing term of a non-annuity type", () => {
    expect(missingMethodTerms("LINEAR", {})).toEqual([
      "amortizationMonths",
      "paymentStartDate",
      "paymentFrequency",
      "originalPrincipal",
    ]);
    expect(missingMethodTerms("INTEREST_ONLY", {})).toEqual([
      "amortizationMonths",
      "paymentStartDate",
      "paymentFrequency",
    ]);
  });

  it("needs a principal only for SHORTEN_TERM", () => {
    const noPrincipal = { ...TERMS, originalPrincipal: 0, openingBalance: 0 };
    expect(missingMethodTerms("LINEAR", noPrincipal)).toEqual([
      "originalPrincipal",
    ]);
    expect(
      missingMethodTerms("LINEAR", {
        ...noPrincipal,
        prepaymentMode: "LOWER_INSTALLMENT",
      }),
    ).toEqual([]);
  });

  it("refuses a missing amortization with a 400 naming the field", () => {
    expect(() =>
      assertMortgageMethodTerms("LINEAR", {
        ...TERMS,
        amortizationMonths: null,
      }),
    ).toThrow(
      new BadRequestException("A LINEAR mortgage requires amortizationMonths"),
    );
  });

  it.each(["ACCELERATED_BIWEEKLY", "ACCELERATED_WEEKLY"])(
    "refuses %s for both new methods",
    (frequency) => {
      for (const type of ["LINEAR", "INTEREST_ONLY"] as const) {
        expect(() =>
          assertMortgageMethodTerms(type, {
            ...TERMS,
            paymentFrequency: frequency,
          }),
        ).toThrow(BadRequestException);
      }
    },
  );

  it("declines to price an installment without its terms", () => {
    expect(
      nonAnnuityInstallment(
        "LINEAR",
        { ...TERMS, amortizationMonths: null },
        "2025-07-01",
        265000,
        0.002,
      ),
    ).toBeNull();
    expect(
      nonAnnuityInstallment("ANNUITY", TERMS, "2025-07-01", 265000, 0.002),
    ).toBeNull();
  });
});
