import {
  anniversaryInYear,
  deductionPeriod,
  resetReminderDueFor,
  subtractMonths,
} from "./payroll-deduction-period";

/** docs/specs/payroll-deductions.md, truth tables B and C. */
describe("payroll deduction periods", () => {
  describe("deductionPeriod", () => {
    it.each([
      ["2026-10-26", "2026-01-01", "2026-12-31", "2027-01-01"],
      ["2027-01-01", "2027-01-01", "2027-12-31", "2028-01-01"],
      ["2025-12-31", "2025-01-01", "2025-12-31", "2026-01-01"],
    ])(
      "anchored on 1 January, as of %s",
      (asOf, periodStart, periodEnd, nextResetOn) => {
        expect(deductionPeriod("2026-01-01", asOf)).toEqual({
          periodStart,
          periodEnd,
          nextResetOn,
        });
      },
    );

    it("takes the previous anniversary when the day is before this year's", () => {
      expect(deductionPeriod("2026-04-06", "2027-03-31")).toEqual({
        periodStart: "2026-04-06",
        periodEnd: "2027-04-05",
        nextResetOn: "2027-04-06",
      });
    });

    it("clamps a leap-day anchor to 28 February in a common year", () => {
      expect(deductionPeriod("2024-02-29", "2025-06-01")).toEqual({
        periodStart: "2025-02-28",
        periodEnd: "2026-02-27",
        nextResetOn: "2026-02-28",
      });
      expect(anniversaryInYear("2024-02-29", 2028)).toBe("2028-02-29");
    });

    it("ignores the anchor's year: a future anchor still names a current period", () => {
      expect(deductionPeriod("2030-01-01", "2026-05-05").periodStart).toBe(
        "2026-01-01",
      );
    });
  });

  describe("subtractMonths", () => {
    it("steps back across a year boundary and clamps the day", () => {
      expect(subtractMonths("2027-01-01", 2)).toBe("2026-11-01");
      expect(subtractMonths("2026-03-31", 1)).toBe("2026-02-28");
      expect(subtractMonths("2026-01-15", 13)).toBe("2024-12-15");
    });
  });

  describe("resetReminderDueFor", () => {
    it.each([
      ["2026-10-31", null],
      ["2026-11-01", "2027-01-01"],
      ["2026-12-31", "2027-01-01"],
      ["2027-01-01", null],
      ["2027-10-31", null],
      ["2027-11-01", "2028-01-01"],
    ])("on %s owes %s", (today, expected) => {
      expect(resetReminderDueFor("2026-01-01", today)).toBe(expected);
    });
  });
});
