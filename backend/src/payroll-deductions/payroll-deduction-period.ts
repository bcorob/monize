import { addDaysYMD } from "../common/date-utils";
import { daysInMonth } from "../common/recurrence";

/**
 * The calendar arithmetic of a rule's reset (docs/specs/payroll-deductions.md
 * decision 4 and truth tables B and C), as pure functions over `YYYY-MM-DD`
 * strings. Nothing here reads a clock: the caller passes the day it is asking
 * about, so the posting, the read model and the cron all answer alike.
 */

/** How long before a reset the reminder window opens, in calendar months. */
export const RESET_REMINDER_MONTHS = 2;

export interface DeductionPeriod {
  /** First day of the period that contains the asked-about day. */
  periodStart: string;
  /** Last day of that period. */
  periodEnd: string;
  /** The day the count starts again, the day after `periodEnd`. */
  nextResetOn: string;
}

function parts(ymd: string): [number, number, number] {
  const [y, m, d] = ymd.split("-").map(Number);
  return [y, m, d];
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * The anniversary of `resetDate`'s month and day in `year`. A 29 February
 * clamps to the 28th in a common year, so a rule anchored on a leap day still
 * resets every year.
 */
export function anniversaryInYear(resetDate: string, year: number): string {
  const [, month, day] = parts(resetDate);
  const clamped = Math.min(day, daysInMonth(year, month));
  return `${year}-${pad(month)}-${pad(clamped)}`;
}

/** The period containing `asOf` for a rule anchored on `resetDate`. */
export function deductionPeriod(
  resetDate: string,
  asOf: string,
): DeductionPeriod {
  const [year] = parts(asOf);
  const thisYear = anniversaryInYear(resetDate, year);
  const periodStart =
    thisYear <= asOf ? thisYear : anniversaryInYear(resetDate, year - 1);
  const [startYear] = parts(periodStart);
  const nextResetOn = anniversaryInYear(resetDate, startYear + 1);
  return { periodStart, periodEnd: addDaysYMD(nextResetOn, -1), nextResetOn };
}

/** `ymd` moved back by `months` calendar months, the day clamped to the month. */
export function subtractMonths(ymd: string, months: number): string {
  const [year, month, day] = parts(ymd);
  const index = year * 12 + (month - 1) - months;
  const targetYear = Math.floor(index / 12);
  const targetMonth = (index % 12) + 1;
  return `${targetYear}-${pad(targetMonth)}-${pad(Math.min(day, daysInMonth(targetYear, targetMonth)))}`;
}

/**
 * The reset a reminder is owed for on `today`, or `null` outside the window:
 * from `RESET_REMINDER_MONTHS` calendar months before the next reset up to the
 * day before it. The day of the reset itself starts a new period, whose own
 * window opens months later.
 */
export function resetReminderDueFor(
  resetDate: string,
  today: string,
): string | null {
  const { nextResetOn } = deductionPeriod(resetDate, today);
  const opensOn = subtractMonths(nextResetOn, RESET_REMINDER_MONTHS);
  return today >= opensOn && today < nextResetOn ? nextResetOn : null;
}
