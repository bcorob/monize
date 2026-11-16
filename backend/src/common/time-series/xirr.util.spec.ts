import {
  XIRR_DAYS_PER_YEAR,
  XirrFlow,
  totalOverDays,
  xirrAnnualRate,
} from "./xirr.util";

/** Currency units to the integer ten-thousandths the solver takes. */
const minor = (amount: number): number => Math.round(amount * 10000);

const flow = (dayOffset: number, amount: number): XirrFlow => ({
  dayOffset,
  amountMinor: minor(amount),
});

/** The rate as a percentage, at the six decimals the spec's cases quote. */
const percent = (rate: number | null): number | null =>
  rate === null ? null : Math.round(rate * 100 * 1e6) / 1e6;

describe("xirrAnnualRate", () => {
  describe("a single in/out pair", () => {
    // The closed form the solver is held to: one payment in, one back, so the
    // rate is the ratio annualised over the days between them and nothing else.
    it.each([
      [365, 1000, 1100],
      [730, 1000, 1100],
      [1095, 5000, 4000],
      [200, 8000, 8000.5],
    ])("over %i days matches (out/in)^(365/days) - 1", (days, paid, back) => {
      const expected = Math.pow(back / paid, XIRR_DAYS_PER_YEAR / days) - 1;
      const rate = xirrAnnualRate([flow(0, -paid), flow(days, back)]);
      expect(rate).not.toBeNull();
      expect(rate as number).toBeCloseTo(expected, 10);
    });

    it("is exactly the price move over one year", () => {
      expect(percent(xirrAnnualRate([flow(0, -1000), flow(365, 1100)]))).toBe(
        10,
      );
    });
  });

  // `docs/specs/portfolio-period-result.md` section 11.7, case by case: the
  // numbers a reader can check by hand, and the ones that separate a
  // money-weighted figure from a time-weighted one.
  describe("the spec's worked cases", () => {
    it("case 2: one purchase, +10% over two years, annualises to 4.880885%", () => {
      expect(percent(xirrAnnualRate([flow(0, -1000), flow(730, 1100)]))).toBe(
        4.880885,
      );
    });

    it("case 3: a second purchase before the rise beats the TWR's 4.880885%", () => {
      const rate = xirrAnnualRate([
        flow(0, -1000),
        flow(365, -1000),
        flow(730, 2200),
      ]);
      expect(percent(rate)).toBe(6.524758);
      expect(percent(totalOverDays(rate, 730))).toBe(13.475242);
    });

    it("case 4: a dividend halfway is worth more than the TWR's 1%", () => {
      const rate = xirrAnnualRate([
        flow(0, -1000),
        flow(365, 10),
        flow(730, 1000),
      ]);
      expect(percent(rate)).toBe(0.50125);
      expect(percent(totalOverDays(rate, 730))).toBe(1.005012);
    });

    it("case 6: a full sale inside the window is measured from the sale", () => {
      const rate = xirrAnnualRate([
        flow(0, -8000),
        flow(365, 9000),
        flow(730, 0),
      ]);
      expect(percent(rate)).toBe(12.5);
      // The total field extrapolates the rate over a year that held nothing,
      // which is why its caption may never read as what the reader made.
      expect(percent(totalOverDays(rate, 730))).toBe(26.5625);
    });

    it("case 8: a 1% week is a 68% year, which is why the caller withholds it", () => {
      expect(percent(xirrAnnualRate([flow(0, -1000), flow(7, 1010)]))).toBe(
        68.007541,
      );
    });
  });

  describe("schedules with no single rate", () => {
    it("refuses an empty schedule", () => {
      expect(xirrAnnualRate([])).toBeNull();
    });

    it("refuses a single flow", () => {
      expect(xirrAnnualRate([flow(0, -1000)])).toBeNull();
    });

    it("refuses an all-zero schedule rather than reporting 0%", () => {
      expect(
        xirrAnnualRate([flow(0, 0), flow(30, 0), flow(365, 0)]),
      ).toBeNull();
    });

    it("refuses a schedule with no sign change", () => {
      expect(
        xirrAnnualRate([flow(0, -1000), flow(180, -500), flow(365, -200)]),
      ).toBeNull();
      expect(
        xirrAnnualRate([flow(0, 1000), flow(180, 500), flow(365, 200)]),
      ).toBeNull();
    });

    it("refuses several roots rather than the first one found", () => {
      // -1000, +2500, -1600: two sign changes in the amounts AND two in the
      // cumulative sum. Both roots are real; printing either would make the
      // figure depend on which end the search started from.
      expect(
        xirrAnnualRate([flow(0, -1000), flow(365, 2500), flow(730, -1600)]),
      ).toBeNull();
    });

    it("solves a losing portfolio that had a dividend and a sale on the way", () => {
      // Monthly purchases, one dividend, one sale, and a final value below what
      // went in: the amounts change sign three times and the cumulative flow
      // never turns positive, so neither counting condition admits it -- yet
      // its NPV falls steadily with the rate and the (negative) rate that
      // clears it is the only one. The regression: this schedule, the shape of
      // any regular-contribution plan in a drawdown, read as "undefined".
      const flows = [flow(0, -59726)];
      for (let month = 1; month < 40; month++)
        flows.push(flow(month * 30, -500));
      flows.push(flow(20 * 30, 120), flow(35 * 30, 3060), flow(40 * 30, 73186));

      const rate = xirrAnnualRate(flows);

      expect(rate).not.toBeNull();
      expect(rate!).toBeLessThan(0);
      expect(rate!).toBeGreaterThan(-0.1);
      const npv = flows.reduce(
        (sum, f) =>
          sum + f.amountMinor / 10000 / Math.pow(1 + rate!, f.dayOffset / 365),
        0,
      );
      expect(Math.abs(npv)).toBeLessThan(1e-6);
    });

    it("still refuses two genuine rates inside the bracket", () => {
      // -1000, +2300, -1320 clears at both 10% and 20% a year: the slope turns
      // between them, so the monotonic licence does not apply either.
      expect(
        xirrAnnualRate([flow(0, -1000), flow(365, 2300), flow(730, -1320)]),
      ).toBeNull();
    });

    it("refuses a rate outside the reportable bracket", () => {
      // A hundred-thousand-fold return in a year is a data defect, not a rate.
      expect(xirrAnnualRate([flow(0, -1), flow(365, 100000)])).toBeNull();
    });

    it("solves a schedule Norstrom's criterion admits", () => {
      // Two sign changes in the amounts, one in the cumulative sum: money
      // invested to date never turns positive twice, so the rate is unique.
      const rate = xirrAnnualRate([
        flow(0, -1000),
        flow(365, 500),
        flow(730, -100),
        flow(1095, 800),
      ]);
      expect(rate).not.toBeNull();
      // The answer is the root, checked by the definition rather than by a
      // second implementation: the NPV at it is zero.
      let npv = 0;
      for (const [days, amount] of [
        [0, -1000],
        [365, 500],
        [730, -100],
        [1095, 800],
      ] as const) {
        npv += amount / Math.pow(1 + (rate as number), days / 365);
      }
      expect(npv).toBeCloseTo(0, 8);
    });
  });

  describe("the schedule it is given", () => {
    it("folds several flows on one day into one", () => {
      const split = xirrAnnualRate([
        flow(0, -600),
        flow(0, -400),
        flow(365, 1100),
      ]);
      expect(percent(split)).toBe(10);
    });

    it("does not depend on the order the flows arrive in", () => {
      const ordered = xirrAnnualRate([
        flow(0, -1000),
        flow(365, -1000),
        flow(730, 2200),
      ]);
      const shuffled = xirrAnnualRate([
        flow(730, 2200),
        flow(0, -1000),
        flow(365, -1000),
      ]);
      expect(shuffled).toBe(ordered);
    });

    it("refuses a non-finite amount instead of solving over NaN", () => {
      expect(
        xirrAnnualRate([
          { dayOffset: 0, amountMinor: Number.NaN },
          flow(365, 1100),
        ]),
      ).toBeNull();
    });
  });
});

describe("totalOverDays", () => {
  it("carries a null rate through", () => {
    expect(totalOverDays(null, 365)).toBeNull();
  });

  it("is the rate itself over exactly a year", () => {
    expect(totalOverDays(0.1, 365)).toBeCloseTo(0.1, 12);
  });

  it("compounds over a longer window", () => {
    expect(totalOverDays(0.1, 730)).toBeCloseTo(0.21, 12);
  });

  it("is zero over a zero-length window", () => {
    expect(totalOverDays(0.1, 0)).toBe(0);
  });

  it("refuses a negative window", () => {
    expect(totalOverDays(0.1, -1)).toBeNull();
  });
});
