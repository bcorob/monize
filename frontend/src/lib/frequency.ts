import { FrequencyType } from '@/types/scheduled-transaction';

/**
 * The one place the frontend knows how a recurrence frequency steps forward.
 *
 * Four call sites used to carry their own `switch (frequency)` -- the cash-flow
 * forecast, the occurrence picker, the bills calendar and the upcoming-bills
 * report. Every new frequency then had to be added in four places, and two of
 * them had silently drifted (neither handled `SEMIMONTHLY`, so a twice-monthly
 * schedule projected the same date over and over). Adding `EVERY2MONTHS` and
 * `SEMIANNUAL` folded them into this module; `frequency.guard.test.ts` fails if
 * a hand-rolled switch reappears.
 *
 * Mirrors `backend/src/common/recurrence.ts` (`calculateNextDueDate`), which is
 * the authority for stored next-due dates. Kept as a separate implementation
 * because this side steps `Date` objects in local time for calendar rendering,
 * where the backend steps `YYYY-MM-DD` strings; the specs on both sides assert
 * the same month-end clamping behaviour.
 */

/** Last day of the month containing `date`, as a day-of-month number. */
function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/**
 * Add `months`, clamping the day to the target month's length: Jan 31 + 1 month
 * is Feb 28 (or Feb 29), not Mar 3 as `setMonth` alone would give.
 */
function addMonthsClamped(date: Date, months: number): Date {
  const target = new Date(date.getTime());
  const day = target.getDate();
  target.setDate(1);
  target.setMonth(target.getMonth() + months);
  target.setDate(Math.min(day, daysInMonth(target.getFullYear(), target.getMonth())));
  return target;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * The next occurrence after `date` for `frequency`, as a new `Date` (the input
 * is never mutated). `ONCE` returns an equal date -- callers treat that as
 * "no further occurrences" and must stop, rather than looping forever.
 */
export function advanceByFrequency(date: Date, frequency: FrequencyType): Date {
  switch (frequency) {
    case 'DAILY':
      return addDays(date, 1);
    case 'WEEKLY':
      return addDays(date, 7);
    case 'BIWEEKLY':
      return addDays(date, 14);
    case 'EVERY4WEEKS':
      return addDays(date, 28);
    case 'SEMIMONTHLY': {
      // Twice a month: the 15th and the last day, alternating.
      const next = new Date(date.getTime());
      if (next.getDate() <= 15) {
        next.setMonth(next.getMonth() + 1, 0); // day 0 of next month = last of this one
      } else {
        next.setMonth(next.getMonth() + 1, 15);
      }
      return next;
    }
    case 'MONTHLY':
      return addMonthsClamped(date, 1);
    case 'EVERY2MONTHS':
      return addMonthsClamped(date, 2);
    case 'QUARTERLY':
      return addMonthsClamped(date, 3);
    case 'EVERY4MONTHS':
      return addMonthsClamped(date, 4);
    case 'SEMIANNUAL':
      return addMonthsClamped(date, 6);
    case 'YEARLY':
      return addMonthsClamped(date, 12);
    case 'EVERY2YEARS':
      return addMonthsClamped(date, 24);
    case 'ONCE':
      return new Date(date.getTime());
  }
}

/** True when a frequency produces at most one occurrence. */
export function isOneTime(frequency: FrequencyType): boolean {
  return frequency === 'ONCE';
}

/**
 * Occurrences per year, used to spread an amount over a comparable period.
 * `ONCE` is 0: a one-time entry has no recurring monthly cost.
 */
const OCCURRENCES_PER_YEAR: Record<FrequencyType, number> = {
  ONCE: 0,
  DAILY: 365.25,
  WEEKLY: 365.25 / 7,
  BIWEEKLY: 365.25 / 14,
  EVERY4WEEKS: 365.25 / 28,
  SEMIMONTHLY: 24,
  MONTHLY: 12,
  EVERY2MONTHS: 6,
  QUARTERLY: 4,
  EVERY4MONTHS: 3,
  SEMIANNUAL: 2,
  YEARLY: 1,
  EVERY2YEARS: 0.5,
};

/**
 * `amount` restated as a monthly figure, for summing schedules of mixed
 * frequencies into one "per month" total.
 */
export function monthlyEquivalent(amount: number, frequency: FrequencyType): number {
  const perYear = OCCURRENCES_PER_YEAR[frequency] ?? 0;
  return (amount * perYear) / 12;
}
