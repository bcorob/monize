export class CategoryTotal {
  name: string;
  total: number;
}

/**
 * Totals in {@link TaxSummaryResponse.currency}. Each is `null` when any row
 * could not be converted -- a missing rate makes a tax total unknowable, never
 * smaller. The `known*` fields carry the part that did convert and are never to
 * be shown under a "Total" caption while the field above is `null`.
 */
export class TaxTotals {
  income: number | null;
  expenses: number | null;
  deductible: number | null;
  knownIncome: number;
  knownExpenses: number;
  knownDeductible: number;
}

export class TaxSummaryResponse {
  incomeBySource: CategoryTotal[];
  deductibleExpenses: CategoryTotal[];
  allExpenses: CategoryTotal[];
  totals: TaxTotals;

  /**
   * Reporting currency every figure above is expressed in. The category lists
   * hold only the rows that converted when `missingCurrencies` is non-empty.
   */
  currency: string;

  /** Source currencies with no usable rate into {@link currency}. */
  missingCurrencies: string[];

  /** How many rows were left out because their currency had no rate. */
  excludedCount: number;
}
