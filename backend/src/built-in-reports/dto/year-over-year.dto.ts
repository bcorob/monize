export class YearMonthData {
  month: number; // 1-12
  income: number;
  expenses: number;
  savings: number;
}

/**
 * One year's totals, in {@link YearOverYearResponse.currency}.
 *
 * A total is `null` when any row of THAT year could not be converted -- a
 * missing rate makes it unknowable, never smaller. The `known*` fields carry the
 * part that did convert and are never to be shown under a "Total" caption while
 * the field above is `null`. Another year's gap does not blank this one.
 */
export class YearTotals {
  income: number | null;
  expenses: number | null;
  savings: number | null;
  knownIncome: number;
  knownExpenses: number;
  knownSavings: number;
}

export class YearData {
  year: number;
  months: YearMonthData[];
  totals: YearTotals;
}

export class YearOverYearResponse {
  /**
   * Each year's months are only the part that converted when
   * `missingCurrencies` is non-empty.
   */
  data: YearData[];

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
