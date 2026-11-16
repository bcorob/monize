import {
  addDays,
  addMonthsClamped,
  compareYMD,
  dayOfWeek,
  daysBetween,
  daysInMonth,
  firstOfMonth,
  isValidYMD,
  monthKeyBefore,
  enumerateMonthKeys,
  parseYMD,
} from "./calendar-date";

describe("calendar-date", () => {
  it("validates dates strictly", () => {
    expect(isValidYMD("2028-02-29")).toBe(true);
    expect(isValidYMD("2027-02-29")).toBe(false);
    expect(isValidYMD("2027-13-01")).toBe(false);
    expect(isValidYMD("2027-00-10")).toBe(false);
    expect(isValidYMD("2027-1-10")).toBe(false);
    expect(isValidYMD(20270101)).toBe(false);
    expect(() => parseYMD("nope")).toThrow(RangeError);
    expect(parseYMD("2026-10-05")).toEqual({ year: 2026, month: 10, day: 5 });
  });

  it("knows month lengths", () => {
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2027, 2)).toBe(28);
    expect(daysInMonth(2026, 11)).toBe(30);
  });

  it("counts actual days, start inclusive and end exclusive", () => {
    expect(daysBetween("2026-10-15", "2027-04-15")).toBe(182);
    expect(daysBetween("2027-10-15", "2028-10-15")).toBe(366);
    expect(daysBetween("2026-10-01", "2027-10-01")).toBe(365);
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2);
    expect(daysBetween("2026-10-02", "2026-10-01")).toBe(-1);
  });

  it("compares dates", () => {
    expect(compareYMD("2026-01-01", "2026-01-02")).toBe(-1);
    expect(compareYMD("2026-01-02", "2026-01-01")).toBe(1);
    expect(compareYMD("2026-01-01", "2026-01-01")).toBe(0);
    expect(compareYMD("2025-12-31", "2026-01-01")).toBe(-1);
    expect(compareYMD("2026-10-09", "2026-09-30")).toBe(1);
  });

  it("adds days across month and year ends", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-03-01", -1)).toBe("2027-02-28");
    expect(() => addDays("bad", 1)).toThrow(RangeError);
  });

  it("clamps the day of month from the anchor, not the previous result", () => {
    expect(addMonthsClamped("2026-10-31", 1)).toBe("2026-11-30");
    expect(addMonthsClamped("2026-10-31", 4)).toBe("2027-02-28");
    expect(addMonthsClamped("2026-10-31", 5)).toBe("2027-03-31");
    expect(addMonthsClamped("2028-02-29", 12)).toBe("2029-02-28");
    expect(addMonthsClamped("2026-10-15", 24)).toBe("2028-10-15");
    expect(addMonthsClamped("2026-12-15", 1)).toBe("2027-01-15");
    expect(addMonthsClamped("2026-01-31", 0)).toBe("2026-01-31");
  });

  it("gives the weekday in UTC", () => {
    expect(dayOfWeek("2026-11-01")).toBe(0);
    expect(dayOfWeek("2026-10-31")).toBe(6);
    expect(dayOfWeek("2026-10-30")).toBe(5);
  });

  it("derives month helpers", () => {
    expect(firstOfMonth("2026-11-30")).toBe("2026-11-01");
    expect(monthKeyBefore("2027-10-15", 2)).toBe("2027-08");
    expect(monthKeyBefore("2027-01-15", 2)).toBe("2026-11");
    expect(monthKeyBefore("2027-03-15", 2)).toBe("2027-01");
  });

  it("lists the months between two month keys, inclusive", () => {
    expect(enumerateMonthKeys("2025-11", "2026-02")).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
    expect(enumerateMonthKeys("2026-10", "2026-10")).toEqual(["2026-10"]);
    expect(enumerateMonthKeys("2026-10", "2026-09")).toEqual([]);
  });
});
