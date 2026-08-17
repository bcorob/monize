import {
  FREQUENCY_CYCLE_DAYS,
  FrequencyType,
  calculateNextDueDate,
  ensureYMD,
} from "./recurrence";

describe("calculateNextDueDate", () => {
  it("returns same date for ONCE", () => {
    expect(calculateNextDueDate("2026-05-10", "ONCE")).toBe("2026-05-10");
  });

  it("advances by 1 day for DAILY", () => {
    expect(calculateNextDueDate("2026-05-10", "DAILY")).toBe("2026-05-11");
  });

  it("advances 7 days for WEEKLY", () => {
    expect(calculateNextDueDate("2026-05-10", "WEEKLY")).toBe("2026-05-17");
  });

  it("advances 14 days for BIWEEKLY", () => {
    expect(calculateNextDueDate("2026-05-10", "BIWEEKLY")).toBe("2026-05-24");
  });

  it("advances 28 days for EVERY4WEEKS", () => {
    expect(calculateNextDueDate("2026-05-10", "EVERY4WEEKS")).toBe(
      "2026-06-07",
    );
  });

  it("rolls month boundary correctly for DAILY", () => {
    expect(calculateNextDueDate("2026-05-31", "DAILY")).toBe("2026-06-01");
  });

  describe("MONTHLY", () => {
    it("simple advance", () => {
      expect(calculateNextDueDate("2026-05-10", "MONTHLY")).toBe("2026-06-10");
    });

    it("clamps May 31 to June 30 (not July 1)", () => {
      expect(calculateNextDueDate("2026-05-31", "MONTHLY")).toBe("2026-06-30");
    });

    it("clamps Jan 31 to Feb 28 in non-leap year", () => {
      expect(calculateNextDueDate("2025-01-31", "MONTHLY")).toBe("2025-02-28");
    });

    it("clamps Jan 31 to Feb 29 in leap year", () => {
      expect(calculateNextDueDate("2024-01-31", "MONTHLY")).toBe("2024-02-29");
    });

    it("rolls year boundary", () => {
      expect(calculateNextDueDate("2026-12-15", "MONTHLY")).toBe("2027-01-15");
    });
  });

  describe("QUARTERLY", () => {
    it("advances 3 months", () => {
      expect(calculateNextDueDate("2026-05-10", "QUARTERLY")).toBe(
        "2026-08-10",
      );
    });

    it("clamps Nov 30 + 3mo to Feb 28 in non-leap year", () => {
      expect(calculateNextDueDate("2024-11-30", "QUARTERLY")).toBe(
        "2025-02-28",
      );
    });
  });

  describe("YEARLY", () => {
    it("advances 1 year", () => {
      expect(calculateNextDueDate("2026-05-10", "YEARLY")).toBe("2027-05-10");
    });

    it("clamps Feb 29 leap to Feb 28", () => {
      expect(calculateNextDueDate("2024-02-29", "YEARLY")).toBe("2025-02-28");
    });
  });

  describe("SEMIMONTHLY", () => {
    // Pay schedule: 15th and last day of each month, alternating.
    it("advances from 1st (<=15) to end of current month", () => {
      expect(calculateNextDueDate("2026-05-01", "SEMIMONTHLY")).toBe(
        "2026-05-31",
      );
    });

    it("advances from 15th (<=15) to end of current month", () => {
      expect(calculateNextDueDate("2026-05-15", "SEMIMONTHLY")).toBe(
        "2026-05-31",
      );
    });

    it("advances from end of month to 15th of next month", () => {
      expect(calculateNextDueDate("2026-05-31", "SEMIMONTHLY")).toBe(
        "2026-06-15",
      );
    });

    it("advances from end of Feb non-leap to 15th of March", () => {
      expect(calculateNextDueDate("2025-02-28", "SEMIMONTHLY")).toBe(
        "2025-03-15",
      );
    });
  });

  describe("EVERY2MONTHS", () => {
    it("advances 2 months", () => {
      expect(calculateNextDueDate("2026-05-10", "EVERY2MONTHS")).toBe(
        "2026-07-10",
      );
    });

    it("clamps to the shorter target month", () => {
      expect(calculateNextDueDate("2026-12-31", "EVERY2MONTHS")).toBe(
        "2027-02-28",
      );
    });

    it("clamps into a leap February", () => {
      expect(calculateNextDueDate("2023-12-31", "EVERY2MONTHS")).toBe(
        "2024-02-29",
      );
    });

    it("crosses the year boundary", () => {
      expect(calculateNextDueDate("2026-11-15", "EVERY2MONTHS")).toBe(
        "2027-01-15",
      );
    });

    it("is not every two weeks (the PR #192 mis-mapping)", () => {
      expect(calculateNextDueDate("2026-05-10", "EVERY2MONTHS")).not.toBe(
        calculateNextDueDate("2026-05-10", "BIWEEKLY"),
      );
    });

    it("lands on the same day six steps later, a year on", () => {
      let d = "2026-01-15";
      for (let i = 0; i < 6; i++) d = calculateNextDueDate(d, "EVERY2MONTHS");
      expect(d).toBe("2027-01-15");
    });
  });

  describe("SEMIANNUAL", () => {
    it("advances 6 months", () => {
      expect(calculateNextDueDate("2026-05-10", "SEMIANNUAL")).toBe(
        "2026-11-10",
      );
    });

    it("crosses the year boundary", () => {
      expect(calculateNextDueDate("2026-11-10", "SEMIANNUAL")).toBe(
        "2027-05-10",
      );
    });

    it("clamps Aug 31 to the end of February", () => {
      expect(calculateNextDueDate("2026-08-31", "SEMIANNUAL")).toBe(
        "2027-02-28",
      );
    });

    it("clamps Aug 31 into a leap February", () => {
      expect(calculateNextDueDate("2023-08-31", "SEMIANNUAL")).toBe(
        "2024-02-29",
      );
    });

    it("is not yearly (the PR #192 mis-mapping)", () => {
      expect(calculateNextDueDate("2026-05-10", "SEMIANNUAL")).not.toBe(
        calculateNextDueDate("2026-05-10", "YEARLY"),
      );
    });

    it("lands on the same day two steps later, a year on", () => {
      const first = calculateNextDueDate("2026-03-31", "SEMIANNUAL");
      expect(calculateNextDueDate(first, "SEMIANNUAL")).toBe("2027-03-30");
    });
  });

  describe("EVERY4MONTHS", () => {
    it("advances 4 months", () => {
      expect(calculateNextDueDate("2026-05-10", "EVERY4MONTHS")).toBe(
        "2026-09-10",
      );
    });

    it("crosses the year boundary", () => {
      expect(calculateNextDueDate("2026-11-10", "EVERY4MONTHS")).toBe(
        "2027-03-10",
      );
    });

    it("clamps Oct 31 to the end of February", () => {
      expect(calculateNextDueDate("2026-10-31", "EVERY4MONTHS")).toBe(
        "2027-02-28",
      );
    });

    it("is neither quarterly nor semiannual", () => {
      // The two it used to be downgraded to, from either side.
      expect(calculateNextDueDate("2026-05-10", "EVERY4MONTHS")).not.toBe(
        calculateNextDueDate("2026-05-10", "QUARTERLY"),
      );
      expect(calculateNextDueDate("2026-05-10", "EVERY4MONTHS")).not.toBe(
        calculateNextDueDate("2026-05-10", "SEMIANNUAL"),
      );
    });

    it("lands on the same day three steps later, a year on", () => {
      let d = "2026-01-15";
      for (let i = 0; i < 3; i++) d = calculateNextDueDate(d, "EVERY4MONTHS");
      expect(d).toBe("2027-01-15");
    });
  });

  describe("EVERY2YEARS", () => {
    it("advances 2 years", () => {
      expect(calculateNextDueDate("2026-05-10", "EVERY2YEARS")).toBe(
        "2028-05-10",
      );
    });

    it("clamps Feb 29 to Feb 28 two years on", () => {
      expect(calculateNextDueDate("2024-02-29", "EVERY2YEARS")).toBe(
        "2026-02-28",
      );
    });

    it("keeps Feb 29 when the target year is also a leap year", () => {
      // 2024 -> 2028 is the case a naive "add 730 days" gets wrong.
      expect(calculateNextDueDate("2024-02-29", "EVERY2YEARS")).not.toBe(
        "2026-03-01",
      );
      expect(
        calculateNextDueDate(
          calculateNextDueDate("2024-02-29", "EVERY2YEARS"),
          "EVERY2YEARS",
        ),
      ).toBe("2028-02-28");
    });

    it("is not yearly, which is what it used to be downgraded to", () => {
      expect(calculateNextDueDate("2026-05-10", "EVERY2YEARS")).not.toBe(
        calculateNextDueDate("2026-05-10", "YEARLY"),
      );
    });
  });

  it("throws on invalid date string", () => {
    expect(() => calculateNextDueDate("not-a-date", "DAILY")).toThrow();
  });

  it("steps every frequency forward, and only ONCE stands still", () => {
    // A frequency added to the type but not to the switch falls to `default`,
    // which returns the same date -- so a schedule on it never advances and
    // `rollForward` in the bill mapper spins to its step cap. The compiler
    // cannot see that: `default` makes the switch exhaustive by construction.
    for (const frequency of Object.keys(
      FREQUENCY_CYCLE_DAYS,
    ) as FrequencyType[]) {
      const next = calculateNextDueDate("2026-05-10", frequency);
      if (frequency === "ONCE") {
        expect(next).toBe("2026-05-10");
      } else {
        expect(next > "2026-05-10").toBe(true);
      }
    }
  });
});

describe("FREQUENCY_CYCLE_DAYS", () => {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  it("matches how far calculateNextDueDate actually steps", () => {
    // The table is matched against day counts by both `.mny` readers, so a
    // wrong entry silently mis-reads a whole class of bill. Averaged over four
    // years the stepping and the table have to agree to within a day, which is
    // enough to separate every pair in the list -- the closest is 28 vs 30.44.
    for (const [frequency, cycle] of Object.entries(FREQUENCY_CYCLE_DAYS)) {
      if (frequency === "ONCE") continue;
      const steps = Math.max(4, Math.ceil((4 * 365.25) / cycle));
      let date = "2024-01-15";
      for (let i = 0; i < steps; i++) {
        date = calculateNextDueDate(date, frequency as FrequencyType);
      }
      const spanned =
        (Date.parse(`${date}T00:00:00Z`) - Date.parse("2024-01-15T00:00:00Z")) /
        MS_PER_DAY;
      expect(Math.abs(spanned / steps - cycle)).toBeLessThan(1);
    }
  });

  it("gives ONCE no cycle, so nothing can match a gap to it", () => {
    expect(FREQUENCY_CYCLE_DAYS.ONCE).toBe(0);
  });
});

describe("ensureYMD", () => {
  it("returns YMD strings as-is", () => {
    expect(ensureYMD("2026-05-10")).toBe("2026-05-10");
  });

  it("strips time component from ISO strings", () => {
    expect(ensureYMD("2026-05-10T00:00:00.000Z")).toBe("2026-05-10");
  });

  it("converts Date objects using UTC components", () => {
    const d = new Date(Date.UTC(2026, 4, 10));
    expect(ensureYMD(d)).toBe("2026-05-10");
  });
});
