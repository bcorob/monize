import { validateSync } from "class-validator";

import {
  CALENDAR_RANGE_MAX_DAYS,
  IsCalendarRangeEnd,
  calendarRangeDays,
} from "./calendar-range.validator";

class Range {
  startDate: string;

  @IsCalendarRangeEnd("startDate")
  endDate: string;

  constructor(startDate: string, endDate: string) {
    this.startDate = startDate;
    this.endDate = endDate;
  }
}

class ShortRange {
  from: string;

  @IsCalendarRangeEnd("from", 7)
  to: string;

  constructor(from: string, to: string) {
    this.from = from;
    this.to = to;
  }
}

const isValid = (o: object) => validateSync(o).length === 0;

describe("calendarRangeDays", () => {
  it("counts both ends", () => {
    expect(calendarRangeDays("2026-06-01", "2026-06-01")).toBe(1);
    expect(calendarRangeDays("2026-06-01", "2026-06-02")).toBe(2);
  });

  it("counts across a month, a leap day and a year end", () => {
    expect(calendarRangeDays("2026-06-01", "2026-09-01")).toBe(93);
    expect(calendarRangeDays("2024-02-28", "2024-03-01")).toBe(3);
    expect(calendarRangeDays("2025-12-31", "2026-01-01")).toBe(2);
  });

  it("counts across a daylight-saving change, which a local-midnight walk would miscount", () => {
    // North American DST starts on 2026-03-08; both ends are UTC midnights here,
    // so the span is whole days whatever the server's zone.
    expect(calendarRangeDays("2026-03-07", "2026-03-09")).toBe(3);
  });
});

describe("IsCalendarRangeEnd", () => {
  it("accepts a range inside the cap", () => {
    expect(isValid(new Range("2026-06-01", "2026-06-30"))).toBe(true);
    expect(isValid(new Range("2026-06-01", "2026-06-01"))).toBe(true);
  });

  it(`accepts exactly ${CALENDAR_RANGE_MAX_DAYS} days and rejects one more`, () => {
    expect(isValid(new Range("2026-06-01", "2026-09-01"))).toBe(true);
    expect(isValid(new Range("2026-06-01", "2026-09-02"))).toBe(false);
  });

  it("rejects an end before its start", () => {
    expect(isValid(new Range("2026-06-30", "2026-06-01"))).toBe(false);
  });

  it("rejects a date that does not exist on either end", () => {
    expect(isValid(new Range("2026-06-01", "2026-06-31"))).toBe(false);
    expect(isValid(new Range("2026-02-30", "2026-03-01"))).toBe(false);
  });

  it("rejects a missing or non-string start", () => {
    expect(
      isValid(new Range(undefined as unknown as string, "2026-06-01")),
    ).toBe(false);
  });

  it("honours a caller-supplied cap", () => {
    expect(isValid(new ShortRange("2026-06-01", "2026-06-07"))).toBe(true);
    expect(isValid(new ShortRange("2026-06-01", "2026-06-08"))).toBe(false);
  });

  it("names the start property and the cap in its message", () => {
    const [error] = validateSync(new Range("2026-06-01", "2026-09-02"));
    expect(Object.values(error.constraints ?? {}).join(" ")).toContain(
      "startDate",
    );
    expect(Object.values(error.constraints ?? {}).join(" ")).toContain(
      String(CALENDAR_RANGE_MAX_DAYS),
    );
  });
});
