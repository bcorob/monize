import { EMPTY_CALENDAR_REGISTRY, registerCalendar } from "./calendar-registry";
import { nthBusinessDayBefore } from "./business-day-calendar";
import { dayOfWeek } from "./calendar-date";

const weekdays = {
  id: "TEST",
  isBusinessDay: (ymd: string) => ![0, 6].includes(dayOfWeek(ymd)),
};

describe("nthBusinessDayBefore", () => {
  it("counts strictly before the date over a weekend", () => {
    expect(nthBusinessDayBefore(weekdays, "2026-11-02", 1)).toBe("2026-10-30");
    expect(nthBusinessDayBefore(weekdays, "2026-10-30", 5)).toBe("2026-10-23");
  });

  it("refuses a non-positive count", () => {
    expect(() => nthBusinessDayBefore(weekdays, "2026-11-02", 0)).toThrow(
      RangeError,
    );
  });
});

describe("calendar registry", () => {
  it("registers without mutating and refuses a duplicate", () => {
    const registry = registerCalendar(EMPTY_CALENDAR_REGISTRY, weekdays);
    expect(registry.get("TEST")).toBe(weekdays);
    expect(registry.get("OTHER")).toBeUndefined();
    expect(EMPTY_CALENDAR_REGISTRY.size).toBe(0);
    expect(() => registerCalendar(registry, weekdays)).toThrow();
  });
});
