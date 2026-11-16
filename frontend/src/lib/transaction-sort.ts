import type { SortState } from '@/hooks/useSortableTable';

/**
 * Which column the transaction register is sorted by.
 *
 * This list is the browser's half of a contract: the server declares the same
 * one in `backend/src/transactions/register-order.ts`, and
 * `register-sort.contract.spec.ts` fails when the two differ. A field here
 * that the server does not accept is a 400 behind a column header; a field the
 * server accepts and this list omits is a column nobody can sort by.
 */
export const TRANSACTION_SORT_FIELDS = [
  'date',
  'account',
  'payee',
  'category',
  'description',
  'refNumber',
  'amount',
  'status',
] as const;

export type TransactionSortField = (typeof TRANSACTION_SORT_FIELDS)[number];

export type TransactionSort = SortState<TransactionSortField>;

/**
 * Where the register's sort is remembered. Browser-local, like the row density
 * and the table/calendar view: which way a screen is sorted is a fact about
 * the screen, not about the account, so a laptop and a desktop need not agree.
 */
export const TRANSACTION_SORT_STORAGE_KEY = 'transactions.register.sort';

export const DEFAULT_TRANSACTION_SORT: TransactionSort = {
  field: 'date',
  direction: 'desc',
};

/**
 * What clicking a column header does.
 *
 * The same column reverses. A new column starts in the direction that column
 * is read in: a register is read newest first, everything else A to Z.
 */
export function nextTransactionSort(
  previous: TransactionSort,
  field: TransactionSortField,
): TransactionSort {
  if (previous.field === field) {
    return { field, direction: previous.direction === 'asc' ? 'desc' : 'asc' };
  }
  return { field, direction: field === 'date' ? 'desc' : 'asc' };
}

/**
 * The sortable fields the phone card does not show. The card carries date,
 * payee, amount, balance, category, status and account, and leaves out
 * description and ref #, so the phone sort strip offers no chip for either.
 */
export const PHONE_CARD_OMITTED_SORT_FIELDS: ReadonlySet<TransactionSortField> = new Set([
  'description',
  'refNumber',
]);

/**
 * The sort actually in force, which is not always the one that was stored.
 *
 * On a single account's page the Account column is not rendered at all, so a
 * stored `account` sort would leave the register ordered by a column with no
 * header to click and no way back. It falls back to the default for this
 * request and this header row only -- storage is left alone, so widening the
 * filter to several accounts brings the account sort back.
 *
 * A column the reader has hidden (`useHiddenColumns('transactions')`, the
 * cross-device preference) is the same shape: its header is absent from the
 * DOM at every width, the phone strip omits its chip, and a register ordered
 * by it would also withhold the running balance with nothing on screen to
 * sort by date again. So a remembered sort on a hidden field falls back the
 * same way, storage untouched -- showing the column again restores the
 * remembered sort on the next render.
 *
 * The phone card (a phone at Normal density, `useRegisterPhoneCard`) is the
 * same shape for the fields it does not show, `PHONE_CARD_OMITTED_SORT_FIELDS`:
 * the card has no column for them and the strip no chip, so a sort remembered
 * from the tier table falls back while the card is drawn, storage untouched --
 * switching back to Compact or a wider window restores it.
 *
 * A remembered value the server would refuse falls back the same way. Browser
 * storage outlives the code that wrote it: a field this build dropped, a
 * hand-edited entry or one from a future build all come back verbatim, and
 * sent as-is each is a 400 on every register read -- with no way out but
 * clearing site data, because the headers that could change it never render.
 */
export function resolveRegisterSort(
  sort: TransactionSort,
  isSingleAccountView: boolean,
  hiddenColumns: ReadonlySet<string>,
  phoneCard: boolean,
): TransactionSort {
  const usable =
    !!sort &&
    (TRANSACTION_SORT_FIELDS as readonly string[]).includes(sort.field) &&
    (sort.direction === 'asc' || sort.direction === 'desc');
  if (!usable) {
    return DEFAULT_TRANSACTION_SORT;
  }
  if (sort.field === 'account' && isSingleAccountView) {
    return DEFAULT_TRANSACTION_SORT;
  }
  if (hiddenColumns.has(sort.field)) {
    return DEFAULT_TRANSACTION_SORT;
  }
  if (phoneCard && PHONE_CARD_OMITTED_SORT_FIELDS.has(sort.field)) {
    return DEFAULT_TRANSACTION_SORT;
  }
  return sort;
}

/**
 * Whether the register is in date order, which is the only order a running
 * balance means anything in.
 *
 * `undefined` is a register that offers no sorting at all (every surface but
 * the Transactions page), and those are date-ordered by the server's default.
 */
export function isSortedByDate(sort: TransactionSort | undefined): boolean {
  return sort === undefined || sort.field === 'date';
}
