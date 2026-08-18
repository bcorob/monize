import { Transaction, TransactionStatus } from '@/types/transaction';
import { compareValues, type SortDirection } from '@/hooks/useSortableTable';

/** Every column the reconcile table can be ordered by. */
export type ReconcileSortField =
  | 'date'
  | 'payee'
  | 'category'
  | 'amount'
  | 'status';

/**
 * Which side of the ledger a row is on.
 *
 * `>= 0` is a credit, which is the same predicate the amount cell colours
 * itself with. Writing it once is the point: a grouping that disagreed with the
 * colour beside it would put a green figure under "Payments" for every row at
 * exactly zero.
 */
export type ReconcileFlow = 'credit' | 'debit';

export function transactionFlow(amount: number | string): ReconcileFlow {
  return Number(amount) >= 0 ? 'credit' : 'debit';
}

/**
 * Sum amounts in integer units of the storage precision.
 *
 * `decimal(20,4)` crosses the wire as a string, so every value is coerced
 * before it is scaled, and the accumulation happens in integers so summing
 * fifty rows cannot drift a cent (the root `CLAUDE.md` financial-math rule).
 */
export function sumAmounts(rows: readonly Transaction[]): number {
  const scaled = rows.reduce(
    (sum, row) => sum + Math.round(Number(row.amount) * 10000),
    0,
  );
  return scaled / 10000;
}

/** Rank for the status column, so the sort is by meaning rather than by spelling. */
const STATUS_RANK: Record<TransactionStatus, number> = {
  [TransactionStatus.UNRECONCILED]: 0,
  [TransactionStatus.CLEARED]: 1,
  [TransactionStatus.RECONCILED]: 2,
  [TransactionStatus.VOID]: 3,
};

function sortValue(row: Transaction, field: ReconcileSortField): unknown {
  switch (field) {
    case 'date':
      return row.transactionDate;
    case 'payee':
      return row.payee?.name || row.payeeName || '';
    case 'category':
      return row.category?.name || '';
    case 'amount':
      return Number(row.amount);
    case 'status':
      return STATUS_RANK[row.status] ?? 0;
  }
}

/**
 * Order the rows by one column.
 *
 * Two rows the chosen column cannot separate fall back to date, then to the
 * larger amount, then to the id. The last one is what makes the order
 * *deterministic*: a same-day import writes every row with one `created_at`
 * (PostgreSQL's `CURRENT_TIMESTAMP` is transaction start time), so without a
 * final tiebreak the rows a re-render produces are whatever order the array
 * arrived in, and a row can appear to jump when the list is refetched after an
 * edit. Credits before debits within a day mirrors the register's own rule, so
 * the two screens list the same day the same way.
 *
 * The tiebreak runs in the sort's own direction, like every other key: the
 * point is stability, not a claim about a running balance, which this table
 * does not show.
 */
export function sortReconcileRows(
  rows: readonly Transaction[],
  field: ReconcileSortField,
  direction: SortDirection,
): Transaction[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const primary = compareValues(sortValue(a, field), sortValue(b, field));
    if (primary !== 0) return primary * sign;
    const byDate = compareValues(a.transactionDate, b.transactionDate);
    if (byDate !== 0) return byDate * sign;
    const byAmount = Number(b.amount) - Number(a.amount);
    if (byAmount !== 0) return byAmount * sign;
    return compareValues(a.id, b.id) * sign;
  });
}

/** One rendered section of the table. `flow` is null when grouping is off. */
export interface ReconcileGroup {
  flow: ReconcileFlow | null;
  rows: Transaction[];
  /** Sum of every row in this group, in the account's currency. */
  subtotal: number;
}

/**
 * Split the ordered rows into the sections to render.
 *
 * Grouping off is one unnamed group holding everything, so the table renders
 * one code path either way. Credits lead when grouping is on -- money in before
 * money out, which is how a statement reads.
 *
 * A group with no rows is omitted rather than drawn empty: "Payments (0)" over
 * a blank strip reads as a rendering fault, and the absence already says it.
 */
export function groupReconcileRows(
  rows: readonly Transaction[],
  groupByFlow: boolean,
): ReconcileGroup[] {
  if (!groupByFlow) {
    return [{ flow: null, rows: [...rows], subtotal: sumAmounts(rows) }];
  }
  const groups: ReconcileGroup[] = [];
  for (const flow of ['credit', 'debit'] as const) {
    const inFlow = rows.filter((row) => transactionFlow(row.amount) === flow);
    if (inFlow.length === 0) continue;
    groups.push({ flow, rows: inFlow, subtotal: sumAmounts(inFlow) });
  }
  return groups;
}
