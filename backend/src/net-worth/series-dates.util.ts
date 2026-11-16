import { addDaysYMD, getMonthEndYMD } from "@/common/date-utils";

/**
 * The calendar days of `[start, end]` inclusive, as `YYYY-MM-DD` strings.
 *
 * A time series keyed by calendar date is iterated on the strings themselves.
 * The shape this replaces -- `new Date(start + "T00:00:00")` stepped with
 * `setDate` and read back with `toISOString().substring(0, 10)` -- mixes a
 * LOCAL-midnight instant with UTC components, so in any process east of
 * Greenwich every key came out one day early: a window of 2026-06-01..06-03
 * produced 05-31, 06-01, 06-02. The keys the database returns are real calendar
 * dates, so the first requested day matched nothing and its cash read as zero,
 * while the last requested day was never emitted at all.
 *
 * `addDaysYMD` does the stepping in UTC on a value that carries no time and no
 * zone, so a DST boundary is a boundary of the day names, not of the instants
 * between them. The result is identical in every process timezone.
 *
 * A reversed window (`start > end`) yields no days rather than looping.
 */
export function enumerateDaysYMD(start: string, end: string): string[] {
  const days: string[] = [];
  for (let day = start; day <= end; day = addDaysYMD(day, 1)) {
    days.push(day);
  }
  return days;
}

/**
 * The days a month-grained portfolio series is sampled on: `start`, every
 * calendar month-end strictly between the two, and `end`, ascending and
 * without repeats.
 *
 * A long-range chart draws one point a month, but its two boundaries are the
 * closes its figures are measured between, so they are sampled on the window's
 * own first and last days rather than on the month-ends around them. Every
 * point is a day of the same daily valuation; nothing is spliced onto a stored
 * month-end snapshot (`docs/time-series-contract.md` section 2.7).
 *
 * A reversed window yields no days; `start === end` yields that one day.
 */
export function monthEndSampleDates(start: string, end: string): string[] {
  if (start > end) return [];
  const days = [start];
  let year = Number(start.slice(0, 4));
  let month = Number(start.slice(5, 7));
  for (;;) {
    const monthEnd = getMonthEndYMD(year, month);
    if (monthEnd >= end) break;
    if (monthEnd > start) days.push(monthEnd);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  if (end > start) days.push(end);
  return days;
}
