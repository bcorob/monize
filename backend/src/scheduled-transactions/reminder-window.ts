import { addDaysYMD } from "../common/date-utils";

/**
 * The furthest ahead a bill reminder may look, in days.
 *
 * A ceiling rather than a preference: `reminder_days_before` reaches
 * `addDaysYMD`, and a value past `Date`'s range produces the literal string
 * "NaN-NaN-NaN". The occurrence expander compares window bounds as text, so that
 * string used to read as an unlimited window -- every one of a user's manual
 * bills came back due today, every day, each walked to the recurrence guard,
 * inside a cron every tenant shares.
 *
 * A year covers any reminder anyone needs (the longest real case is an annual
 * renewal, which wants notice measured in weeks). The DTO enforces the same
 * number, so a new row cannot exceed it; the clamp below exists for rows written
 * before the bound and for anything that reaches the column another way.
 */
export const MAX_REMINDER_DAYS_BEFORE = 366;

/**
 * The `through` bound of a reminder window: today plus this schedule's notice
 * period, clamped, with a null column meaning "due today only".
 *
 * The clamp is here rather than at the call sites because both halves of the
 * cron build the same window and only one of them was ever given the null case.
 */
export function reminderWindowThrough(
  todayStr: string,
  daysBefore: number | null | undefined,
): string {
  const days = Math.min(
    Math.max(Math.trunc(Number(daysBefore ?? 0)) || 0, 0),
    MAX_REMINDER_DAYS_BEFORE,
  );
  return addDaysYMD(todayStr, days);
}
