import { termToExpiresOn } from "./warranty-expiry.util";

describe("termToExpiresOn", () => {
  it("adds years (example 1: 2026-10-01 plus two years)", () => {
    expect(termToExpiresOn("2026-10-01", { years: 2 })).toBe("2028-10-01");
  });

  it("adds months across a year end", () => {
    expect(termToExpiresOn("2026-11-15", { months: 3 })).toBe("2027-02-15");
  });

  it("adds days", () => {
    expect(termToExpiresOn("2026-10-21", { days: 90 })).toBe("2027-01-19");
  });

  it("combines years, months and days, months before days", () => {
    expect(
      termToExpiresOn("2026-01-31", { years: 1, months: 1, days: 1 }),
    ).toBe("2027-03-01");
  });

  describe("example 2: month-end clamping", () => {
    it("18 months from 2026-01-31 is 2027-07-31", () => {
      expect(termToExpiresOn("2026-01-31", { months: 18 })).toBe("2027-07-31");
    });

    it("1 month from 2026-01-31 is 2026-02-28", () => {
      expect(termToExpiresOn("2026-01-31", { months: 1 })).toBe("2026-02-28");
    });

    it("1 month from 2028-01-31 is the leap day", () => {
      expect(termToExpiresOn("2028-01-31", { months: 1 })).toBe("2028-02-29");
    });

    it("1 year from a leap day is 2029-02-28", () => {
      expect(termToExpiresOn("2028-02-29", { years: 1 })).toBe("2029-02-28");
    });
  });

  it("reads null and absent parts as zero", () => {
    expect(
      termToExpiresOn("2026-10-21", { years: null, months: 6, days: null }),
    ).toBe("2027-04-21");
  });

  it.each([
    [{}],
    [{ years: 0, months: 0, days: 0 }],
    [{ years: null, months: null, days: null }],
  ])("refuses a zero term: %j", (term) => {
    expect(() => termToExpiresOn("2026-10-21", term)).toThrow(RangeError);
  });

  it.each([[{ years: -1, months: 13 }], [{ days: -5 }], [{ months: 1.5 }]])(
    "refuses a negative or fractional part: %j",
    (term) => {
      expect(() => termToExpiresOn("2026-10-21", term)).toThrow(RangeError);
    },
  );
});
