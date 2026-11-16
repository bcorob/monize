import {
  easterSunday,
  isPolishBusinessDay,
  plCalendar,
  polishHolidays,
} from "./pl-calendar";
import { nthBusinessDayBefore } from "../../domain/business-day-calendar";

describe("Polish business days", () => {
  it("computes Easter Sunday", () => {
    expect(easterSunday(2026)).toBe("2026-04-05");
    expect(easterSunday(2027)).toBe("2027-03-28");
    expect(easterSunday(2025)).toBe("2025-04-20");
    expect(easterSunday(2024)).toBe("2024-03-31");
  });

  it("lists the statutory holidays of 2026", () => {
    const holidays = polishHolidays(2026);
    for (const day of [
      "2026-01-01",
      "2026-01-06",
      "2026-04-05",
      "2026-04-06",
      "2026-05-01",
      "2026-05-03",
      "2026-05-24",
      "2026-06-04",
      "2026-08-15",
      "2026-11-01",
      "2026-11-11",
      "2026-12-24",
      "2026-12-25",
      "2026-12-26",
    ]) {
      expect(holidays.has(day)).toBe(true);
    }
    expect(holidays.size).toBe(14);
  });

  it("lists the statutory holidays of 2027, Easter in March", () => {
    const holidays = polishHolidays(2027);
    expect([...holidays].sort()).toEqual([
      "2027-01-01",
      "2027-01-06",
      "2027-03-28",
      "2027-03-29",
      "2027-05-01",
      "2027-05-03",
      "2027-05-16",
      "2027-05-27",
      "2027-08-15",
      "2027-11-01",
      "2027-11-11",
      "2027-12-24",
      "2027-12-25",
      "2027-12-26",
    ]);
  });

  it("applies the 24 December and 6 January start years", () => {
    expect(polishHolidays(2024).has("2024-12-24")).toBe(false);
    expect(polishHolidays(2025).has("2025-12-24")).toBe(true);
    expect(polishHolidays(2010).has("2010-01-06")).toBe(false);
    expect(polishHolidays(2011).has("2011-01-06")).toBe(true);
  });

  it("excludes weekends and holidays, includes ordinary days", () => {
    expect(isPolishBusinessDay("2026-10-30")).toBe(true);
    expect(isPolishBusinessDay("2026-10-31")).toBe(false);
    expect(isPolishBusinessDay("2026-11-01")).toBe(false);
    expect(isPolishBusinessDay("2026-12-24")).toBe(false);
    expect(isPolishBusinessDay("2026-12-23")).toBe(true);
    expect(isPolishBusinessDay("2026-06-04")).toBe(false);
    expect(isPolishBusinessDay("2026-06-05")).toBe(true);
  });

  it("E14: period starting in November 2026 observes on 2026-10-19", () => {
    expect(nthBusinessDayBefore(plCalendar, "2026-11-01", 10)).toBe(
      "2026-10-19",
    );
  });

  it("E15: period starting in January 2027 observes on 2026-12-16", () => {
    expect(nthBusinessDayBefore(plCalendar, "2027-01-01", 10)).toBe(
      "2026-12-16",
    );
  });

  it("counts strictly before the date, even for a business day", () => {
    expect(nthBusinessDayBefore(plCalendar, "2026-10-30", 1)).toBe(
      "2026-10-29",
    );
    expect(nthBusinessDayBefore(plCalendar, "2026-11-02", 1)).toBe(
      "2026-10-30",
    );
  });

  it("is registered under the id PL", () => {
    expect(plCalendar.id).toBe("PL");
    expect(plCalendar.isBusinessDay("2026-10-30")).toBe(true);
  });
});
