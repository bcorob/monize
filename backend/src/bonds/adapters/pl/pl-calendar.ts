import {
  addDays,
  dayOfWeek,
  formatYMD,
  parseYMD,
} from "../../domain/calendar-date";
import { BusinessDayCalendar } from "../../domain/business-day-calendar";

/** Easter Sunday by the anonymous Gregorian algorithm (Meeus/Jones/Butcher). */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return formatYMD(year, month, day);
}

/** Polish statutory public holidays of one year (6 Jan from 2011, 24 Dec from 2025). */
export function polishHolidays(year: number): ReadonlySet<string> {
  const easter = easterSunday(year);
  const fixed: Array<[number, number]> = [
    [1, 1],
    [5, 1],
    [5, 3],
    [8, 15],
    [11, 1],
    [11, 11],
    [12, 25],
    [12, 26],
  ];
  if (year >= 2011) fixed.push([1, 6]);
  if (year >= 2025) fixed.push([12, 24]);
  return new Set([
    ...fixed.map(([month, day]) => formatYMD(year, month, day)),
    easter,
    addDays(easter, 1),
    addDays(easter, 49),
    addDays(easter, 60),
  ]);
}

const holidayCache = new Map<number, ReadonlySet<string>>();

function holidaysOf(year: number): ReadonlySet<string> {
  let holidays = holidayCache.get(year);
  if (!holidays) {
    holidays = polishHolidays(year);
    holidayCache.set(year, holidays);
  }
  return holidays;
}

export function isPolishBusinessDay(date: string): boolean {
  const weekday = dayOfWeek(date);
  if (weekday === 0 || weekday === 6) return false;
  return !holidaysOf(parseYMD(date).year).has(date);
}

export const plCalendar: BusinessDayCalendar = {
  id: "PL",
  isBusinessDay: isPolishBusinessDay,
};
