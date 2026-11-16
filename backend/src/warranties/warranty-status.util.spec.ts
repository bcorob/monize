import { addDaysYMD } from "../common/date-utils";
import {
  WARRANTY_EXPIRING_WINDOW_DAYS,
  WARRANTY_STATUSES,
  WarrantyStatusBounds,
  warrantyStatus,
  warrantyStatusBounds,
} from "./warranty-status.util";

const TODAY = "2026-10-21";

describe("warrantyStatus (truth table A, WTY-002)", () => {
  it("answers lifetime with no daysLeft, whatever the date says", () => {
    expect(warrantyStatus(null, true, TODAY)).toEqual({
      status: "lifetime",
      daysLeft: null,
    });
    expect(warrantyStatus("2020-01-01", true, TODAY)).toEqual({
      status: "lifetime",
      daysLeft: null,
    });
  });

  it("answers active beyond the window", () => {
    expect(warrantyStatus(addDaysYMD(TODAY, 31), false, TODAY)).toEqual({
      status: "active",
      daysLeft: 31,
    });
  });

  it.each([1, 15, 30])("answers expiring with %i days left", (days) => {
    expect(warrantyStatus(addDaysYMD(TODAY, days), false, TODAY)).toEqual({
      status: "expiring",
      daysLeft: days,
    });
  });

  it("answers expiring, not expired, on the day it expires", () => {
    expect(warrantyStatus(TODAY, false, TODAY)).toEqual({
      status: "expiring",
      daysLeft: 0,
    });
  });

  it("answers expired with a negative daysLeft the day after", () => {
    expect(warrantyStatus(addDaysYMD(TODAY, -1), false, TODAY)).toEqual({
      status: "expired",
      daysLeft: -1,
    });
  });

  it("uses a 30-day window by default", () => {
    expect(WARRANTY_EXPIRING_WINDOW_DAYS).toBe(30);
    expect(warrantyStatus(addDaysYMD(TODAY, 30), false, TODAY).status).toBe(
      "expiring",
    );
    expect(warrantyStatus(addDaysYMD(TODAY, 10), false, TODAY, 7).status).toBe(
      "active",
    );
  });

  it("refuses a dated warranty with no date rather than inventing a status", () => {
    expect(() => warrantyStatus(null, false, TODAY)).toThrow(/expiresOn/);
  });

  describe("example 1: a laptop bought 2026-10-01 with a two-year term", () => {
    const expiresOn = "2028-10-01";

    it("is expiring with 29 days left on 2028-09-02", () => {
      expect(warrantyStatus(expiresOn, false, "2028-09-02")).toEqual({
        status: "expiring",
        daysLeft: 29,
      });
    });

    it("is expiring with 0 days left on 2028-10-01", () => {
      expect(warrantyStatus(expiresOn, false, "2028-10-01")).toEqual({
        status: "expiring",
        daysLeft: 0,
      });
    });

    it("is expired on 2028-10-02", () => {
      expect(warrantyStatus(expiresOn, false, "2028-10-02").status).toBe(
        "expired",
      );
    });
  });

  it("counts whole calendar days across a daylight-saving change", () => {
    // 2026-11-01 is the North American fall-back; calendar dates carry no
    // clock, so the count is the number of days, not hours / 24.
    expect(warrantyStatus("2026-11-02", false, "2026-10-31").daysLeft).toBe(2);
  });
});

describe("warrantyStatusBounds", () => {
  const inBounds = (
    expiresOn: string | null,
    isLifetime: boolean,
    bounds: WarrantyStatusBounds,
  ): boolean =>
    bounds.isLifetime === isLifetime &&
    (bounds.expiresFrom === null ||
      (expiresOn !== null && expiresOn >= bounds.expiresFrom)) &&
    (bounds.expiresTo === null ||
      (expiresOn !== null && expiresOn <= bounds.expiresTo));

  it("selects exactly the rows warrantyStatus gives each status, every day either side of each boundary", () => {
    for (const offset of Array.from({ length: 81 }, (_, i) => i - 40)) {
      const expiresOn = addDaysYMD(TODAY, offset);
      const { status } = warrantyStatus(expiresOn, false, TODAY);
      for (const candidate of WARRANTY_STATUSES) {
        expect([
          offset,
          candidate,
          inBounds(expiresOn, false, warrantyStatusBounds(candidate, TODAY)),
        ]).toEqual([offset, candidate, candidate === status]);
      }
    }
  });

  it("selects lifetime rows only for lifetime", () => {
    for (const candidate of WARRANTY_STATUSES) {
      expect(inBounds(null, true, warrantyStatusBounds(candidate, TODAY))).toBe(
        candidate === "lifetime",
      );
    }
  });

  it("follows a narrower window", () => {
    expect(warrantyStatusBounds("expiring", TODAY, 7)).toEqual({
      isLifetime: false,
      expiresFrom: TODAY,
      expiresTo: "2026-10-28",
    });
    expect(warrantyStatusBounds("active", TODAY, 7).expiresFrom).toBe(
      "2026-10-29",
    );
  });
});
