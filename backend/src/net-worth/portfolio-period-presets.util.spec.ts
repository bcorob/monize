import {
  presetEarliestDate,
  presetWindowStart,
} from "./portfolio-period-presets.util";

describe("presetWindowStart", () => {
  /**
   * YTD is measured from the close of the previous year's last trading
   * session. Opening on 1 January measured from a holiday; the daily series
   * values 31 December from the latest close on or before it, so a weekend
   * year-end still carries the last session's close.
   */
  it("opens YTD on 31 December of the previous year", () => {
    expect(presetWindowStart("ytd", "2026-09-26")).toBe("2025-12-31");
    expect(presetWindowStart("ytd", "2026-01-01")).toBe("2025-12-31");
    expect(presetWindowStart("ytd", "2026-12-31")).toBe("2025-12-31");
  });

  it("loads YTD from the day it opens, not a day earlier", () => {
    expect(presetEarliestDate("ytd", "2026-09-26")).toBe("2025-12-31");
  });

  it("leaves the other presets' arithmetic alone", () => {
    expect(presetWindowStart("1d", "2026-09-26")).toBe("2026-09-26");
    expect(presetWindowStart("1w", "2026-09-26")).toBe("2026-09-19");
    expect(presetWindowStart("1y", "2026-09-26")).toBe("2025-09-26");
    expect(presetWindowStart("all", "2026-09-26")).toBeNull();
  });
});

/**
 * The day each range is measured from, on Monday 28 September 2026. The
 * client's chart window (`portfolio-range-window.test.ts`) pins the same
 * table for the same day: a chart opens its series on the close its figures
 * are measured from, so the two files must not drift apart (issue #1461).
 */
describe("presetEarliestDate", () => {
  it("is the day the chart window opens on, for every preset the chart offers", () => {
    const today = "2026-09-28";
    expect(presetEarliestDate("1w", today)).toBe("2026-09-20");
    expect(presetEarliestDate("1m", today)).toBe("2026-08-29");
    expect(presetEarliestDate("3m", today)).toBe("2026-06-30");
    expect(presetEarliestDate("ytd", today)).toBe("2025-12-31");
    expect(presetEarliestDate("1y", today)).toBe("2025-09-28");
    expect(presetEarliestDate("2y", today)).toBe("2024-09-28");
    expect(presetEarliestDate("5y", today)).toBe("2021-09-28");
  });

  it("steps a leap-day anniversary back to 28 February", () => {
    expect(presetEarliestDate("1y", "2028-02-29")).toBe("2027-02-28");
    expect(presetEarliestDate("5y", "2028-02-29")).toBe("2023-02-28");
  });
});
