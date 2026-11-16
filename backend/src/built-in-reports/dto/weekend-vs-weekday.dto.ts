export class DaySpending {
  dayOfWeek: number; // 0=Sun, 6=Sat
  total: number;
  count: number;
}

export class CategoryWeekendWeekday {
  categoryId: string | null;
  categoryName: string;
  weekendTotal: number;
  weekdayTotal: number;
}

export class WeekendWeekdaySummary {
  /**
   * Spending on weekends and on weekdays, or `null` when any row could not be
   * converted into {@link WeekendVsWeekdayResponse.currency} -- a missing rate
   * makes the total unknowable, never smaller. The `known*` fields carry the
   * part that did convert.
   */
  weekendTotal: number | null;
  weekdayTotal: number | null;
  knownWeekendTotal: number;
  knownWeekdayTotal: number;
  /** Transactions that converted; an excluded row is in no count either. */
  weekendCount: number;
  weekdayCount: number;
}

export class WeekendVsWeekdayResponse {
  summary: WeekendWeekdaySummary;
  /** Per-day and per-category figures are only the rows that converted. */
  byDay: DaySpending[];
  byCategory: CategoryWeekendWeekday[];

  /** Reporting currency every figure above is expressed in. */
  currency: string;

  /**
   * Source currencies with no usable rate into {@link currency}, so their rows
   * are in none of the figures above. Empty when the report is complete.
   */
  missingCurrencies: string[];

  /** How many aggregate rows were left out, by any cause. */
  excludedCount: number;
}
