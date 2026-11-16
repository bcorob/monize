import { useCallback } from 'react';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import type { ChartDatePattern } from '@/lib/utils';

/**
 * A `YYYY-MM` month key as a local `Date` on the first of that month, or `null`
 * when the string is not one.
 *
 * `parseLocalDate` cannot do this: it splits on `-` and reads the third part as
 * the day, so a month key gives it `undefined` and it returns an Invalid Date --
 * which `Intl.DateTimeFormat.format` throws a RangeError on. Inside a recharts
 * tooltip or tick formatter that throw blanks the whole report subtree, so the
 * parse is a decision the caller never has to remember to make.
 *
 * The month is range-checked rather than left to `Date` to normalise: month 13
 * would silently become January of the next year, so a malformed key would be
 * rendered as a plausible wrong month instead of being recognised as malformed.
 */
function monthKeyToDate(monthKey: string): Date | null {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return new Date(year, month - 1, 1);
}

/**
 * The formatter for a month marker on a chart: an axis tick, a tooltip heading,
 * a series label.
 *
 * A month reaches the client as a `YYYY-MM` key (`BudgetTrendPoint.monthKey`
 * and its siblings) because a server-rendered `Jan 2026` is English in every
 * locale and sorts alphabetically. Rendering that key needs one of two
 * different formatters, and the distinction is not cosmetic:
 *
 * - a table's month COLUMN uses `useDateFormat().formatMonth`, which follows
 *   the user's date-format preference (`2026-01`, `01/2026`, `Jan-2026`) so the
 *   column matches every other date in the table;
 * - a chart's month AXIS uses this hook, which localises the month NAME
 *   (`Jan 2026`, `Jan 2025`) the way every other chart in the app does
 *   (`useChartDateFormat`, `MonthlyComparisonReport`, `DividendIncomeReport`).
 *
 * Using the table formatter on an axis is what turned `Jan 2026` ticks into
 * `01/2026` for most preferences -- a numeric tick where a month name belongs.
 *
 * A key this cannot parse is returned unchanged rather than thrown on, which is
 * the same contract `formatMonth` has: recharts types a tooltip `label` as
 * optional, so `String(label)` can be the text `undefined`, and a formatter
 * that throws there takes the report down with it.
 */
export function useChartMonthFormat() {
  const formatChartDate = useChartDateFormat();

  return useCallback(
    (monthKey: string, pattern: ChartDatePattern = 'MMM yyyy'): string => {
      const date = monthKeyToDate(monthKey);
      return date === null ? monthKey : formatChartDate(date, pattern);
    },
    [formatChartDate],
  );
}
