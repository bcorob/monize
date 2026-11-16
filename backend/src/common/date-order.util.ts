/**
 * Rows in the order an import inserts them and runs its rules over them: by
 * calendar date ascending, and within a date in the order the source listed
 * them, so a row's `created_at` spacing still follows the file. Every import
 * path (QIF, OFX, CSV, Money, bank sync) orders through this one helper, for
 * every user, so a rule that settles loan installments folds forward through
 * time (`docs/specs/loan-installment-settlement.md` decision 7, INV-RULE-005).
 *
 * `position` is the row's place in the source, 1-based: an import's messages
 * and savepoints name the row by it, whatever order it is processed in.
 */
export interface DateOrderedRow<T> {
  readonly row: T;
  readonly position: number;
}

/**
 * Stable: two rows of one date keep their source order. Dates are compared as
 * `YYYY-MM-DD` strings, which sort in calendar order.
 */
export function orderByDateStable<T>(
  rows: readonly T[],
  dateOf: (row: T) => string,
): DateOrderedRow<T>[] {
  return rows
    .map((row, index) => ({ row, position: index + 1 }))
    .sort((a, b) => {
      const dateA = dateOf(a.row);
      const dateB = dateOf(b.row);
      if (dateA < dateB) return -1;
      if (dateA > dateB) return 1;
      return a.position - b.position;
    });
}
