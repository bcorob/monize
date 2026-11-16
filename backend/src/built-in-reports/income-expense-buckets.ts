import {
  addDays,
  addMonths,
  addWeeks,
  endOfMonth,
  format,
  parseISO,
  startOfMonth,
  startOfWeek,
} from "date-fns";

/**
 * How Income vs Expenses divides a window into bars.
 *
 * The dashboard widget draws recent weeks and the report draws months, and both
 * read this endpoint -- so the granularity is a parameter of the question, not
 * something a caller re-derives from the answer. A client that bucketed the
 * rows itself would be deciding which transaction belongs to which bar, which
 * is half of deciding what the bar says.
 */
export type IncomeExpenseBucket = "month" | "week";

/** Day the user's week starts on: 0 = Sunday through 6 = Saturday. */
export type WeekStartsOn = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** One bar: its key, and the dates it covers inclusive. */
export interface IncomeExpensePeriod {
  /** `YYYY-MM` for a month, the week's first day as `YYYY-MM-DD` for a week. */
  period: string;
  periodStart: string;
  periodEnd: string;
}

const ISO = "yyyy-MM-dd";

/**
 * Days to add before `date_trunc('week', ...)` so a week starts on
 * `weekStartsOn`, and to subtract afterwards.
 *
 * PostgreSQL's week always starts on Monday (ISO). Shifting the date so the
 * user's chosen start day lands on a Monday, truncating, and shifting back is
 * the whole trick; it is here beside the enumeration so the SQL grouping and
 * the bars it fills cannot disagree about where a week begins.
 */
export function weekTruncOffsetDays(weekStartsOn: WeekStartsOn): number {
  return (8 - weekStartsOn) % 7;
}

/**
 * The SQL expression that buckets a transaction date, as a `YYYY-MM-DD` start
 * date. `offsetParam` is the 1-based placeholder holding
 * {@link weekTruncOffsetDays}; it is unused for month buckets.
 */
export function bucketStartSql(
  bucket: IncomeExpenseBucket,
  column: string,
  offsetParam: string,
): string {
  if (bucket === "month") {
    return `TO_CHAR(date_trunc('month', ${column}), 'YYYY-MM-DD')`;
  }
  // The cast is explicit because `make_interval(days => $n)` is the parameter's
  // only appearance, and PostgreSQL will not infer an integer from a named
  // argument on its own.
  return `TO_CHAR(date_trunc('week', ${column} + make_interval(days => ${offsetParam}::int)) - make_interval(days => ${offsetParam}::int), 'YYYY-MM-DD')`;
}

/**
 * Every bar between `startDate` and `endDate`, including the ones nothing
 * happened in.
 *
 * A bucket with no rows is a known zero -- nothing was earned or spent that
 * week -- so it is a bar of height zero and not a gap the chart closes up. The
 * caller therefore gets a complete, evenly spaced series rather than having to
 * work out which bars are missing.
 */
export function enumerateIncomeExpensePeriods(
  startDate: string,
  endDate: string,
  bucket: IncomeExpenseBucket,
  weekStartsOn: WeekStartsOn = 1,
): IncomeExpensePeriod[] {
  const end = parseISO(endDate);
  const periods: IncomeExpensePeriod[] = [];
  let cursor =
    bucket === "month"
      ? startOfMonth(parseISO(startDate))
      : startOfWeek(parseISO(startDate), { weekStartsOn });

  // A window is bounded by its own dates, so this terminates; the cap is a
  // guard against a caller passing an end before its start.
  while (cursor <= end && periods.length < 1000) {
    const periodEnd =
      bucket === "month" ? endOfMonth(cursor) : addDays(cursor, 6);
    periods.push({
      period:
        bucket === "month" ? format(cursor, "yyyy-MM") : format(cursor, ISO),
      periodStart: format(cursor, ISO),
      periodEnd: format(periodEnd, ISO),
    });
    cursor = bucket === "month" ? addMonths(cursor, 1) : addWeeks(cursor, 1);
  }

  return periods;
}

/** The key `enumerateIncomeExpensePeriods` gives the bucket starting on `start`. */
export function periodKeyForStart(
  start: string,
  bucket: IncomeExpenseBucket,
): string {
  return bucket === "month" ? start.slice(0, 7) : start;
}
