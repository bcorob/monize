import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TRANSACTION_SORT,
  TRANSACTION_SORT_FIELDS,
  isSortedByDate,
  nextTransactionSort,
  resolveRegisterSort,
} from './transaction-sort';
import type { TransactionSort } from './transaction-sort';

describe('nextTransactionSort', () => {
  it('reverses the column that is already sorted', () => {
    expect(
      nextTransactionSort({ field: 'date', direction: 'desc' }, 'date'),
    ).toEqual({
      field: 'date',
      direction: 'asc',
    });
    expect(
      nextTransactionSort({ field: 'date', direction: 'asc' }, 'date'),
    ).toEqual({
      field: 'date',
      direction: 'desc',
    });
    expect(
      nextTransactionSort({ field: 'payee', direction: 'asc' }, 'payee'),
    ).toEqual({
      field: 'payee',
      direction: 'desc',
    });
  });

  it('starts a new column in the direction that column is read', () => {
    // A register is read newest first; a name column is read A to Z.
    expect(
      nextTransactionSort({ field: 'payee', direction: 'asc' }, 'date'),
    ).toEqual({
      field: 'date',
      direction: 'desc',
    });
    expect(
      nextTransactionSort({ field: 'date', direction: 'desc' }, 'payee'),
    ).toEqual({
      field: 'payee',
      direction: 'asc',
    });
    expect(
      nextTransactionSort({ field: 'payee', direction: 'desc' }, 'category'),
    ).toEqual({
      field: 'category',
      direction: 'asc',
    });
  });

  it('starts every column somewhere', () => {
    for (const field of TRANSACTION_SORT_FIELDS) {
      const next = nextTransactionSort(DEFAULT_TRANSACTION_SORT, field);
      expect(next.field).toBe(field);
      expect(['asc', 'desc']).toContain(next.direction);
    }
  });
});

describe('resolveRegisterSort', () => {
  const nothingHidden: ReadonlySet<string> = new Set();

  it('drops an account sort where there is no Account column to click', () => {
    // The column is not rendered on a single account's page, so a stored
    // account sort would order the register by a header nobody can reach.
    const stored: TransactionSort = { field: 'account', direction: 'asc' };
    expect(resolveRegisterSort(stored, true, nothingHidden, false)).toEqual(
      DEFAULT_TRANSACTION_SORT,
    );
    // Storage is untouched, so widening the filter brings it back.
    expect(resolveRegisterSort(stored, false, nothingHidden, false)).toBe(stored);
  });

  it('leaves every other field alone on either kind of page', () => {
    for (const field of TRANSACTION_SORT_FIELDS.filter(
      (f) => f !== 'account',
    )) {
      const sort: TransactionSort = { field, direction: 'asc' };
      expect(resolveRegisterSort(sort, true, nothingHidden, false)).toBe(sort);
      expect(resolveRegisterSort(sort, false, nothingHidden, false)).toBe(sort);
    }
  });

  it('drops a sort on a column the reader has hidden, storage untouched', () => {
    // A hidden column has no header at any width and no chip on a phone, so
    // a register ordered by it would also withhold the running balance with
    // nothing on screen to sort by date again. The same shape as the Account
    // rule: the fallback is for this render only, and showing the column
    // again restores the remembered sort.
    for (const field of ['description', 'refNumber', 'status'] as const) {
      const stored: TransactionSort = { field, direction: 'asc' };
      const hidden = new Set<string>([field]);
      expect(resolveRegisterSort(stored, false, hidden, false)).toEqual(
        DEFAULT_TRANSACTION_SORT,
      );
      expect(resolveRegisterSort(stored, true, hidden, false)).toEqual(
        DEFAULT_TRANSACTION_SORT,
      );
      expect(resolveRegisterSort(stored, false, nothingHidden, false)).toBe(stored);
    }
    // A hidden column the sort is not on changes nothing.
    const byPayee: TransactionSort = { field: 'payee', direction: 'asc' };
    expect(
      resolveRegisterSort(byPayee, false, new Set(['status', 'tags']), false),
    ).toBe(byPayee);
  });

  it('drops a description or ref # sort while the phone card is drawn, storage untouched', () => {
    // The card shows neither column and the phone strip offers no chip for
    // them, so a sort remembered from the tier table (Compact, or a wider
    // window) would order the card by a field the reader cannot see. The
    // fallback is for this render only: back at the tier table, it returns.
    for (const field of ['description', 'refNumber'] as const) {
      const stored: TransactionSort = { field, direction: 'asc' };
      expect(resolveRegisterSort(stored, false, nothingHidden, true)).toEqual(
        DEFAULT_TRANSACTION_SORT,
      );
      expect(resolveRegisterSort(stored, false, nothingHidden, false)).toBe(stored);
    }
    // Every field the card does show keeps its sort.
    for (const field of TRANSACTION_SORT_FIELDS.filter(
      (f) => f !== 'description' && f !== 'refNumber',
    )) {
      const sort: TransactionSort = { field, direction: 'asc' };
      expect(resolveRegisterSort(sort, false, nothingHidden, true)).toBe(sort);
    }
  });

  it('refuses a remembered value the server would refuse', () => {
    // Browser storage outlives the code that wrote it. Sent verbatim, each of
    // these is a 400 on every register read, and the headers that could change
    // it never render -- so the page has no way out but clearing site data.
    const cases = [
      { field: 'runningBalance', direction: 'asc' },
      { field: 'date', direction: 'descending' },
      { field: '', direction: 'asc' },
      undefined,
      null,
    ];
    for (const stored of cases) {
      expect(resolveRegisterSort(stored as never, false, nothingHidden, false)).toEqual(
        DEFAULT_TRANSACTION_SORT,
      );
      expect(resolveRegisterSort(stored as never, true, nothingHidden, false)).toEqual(
        DEFAULT_TRANSACTION_SORT,
      );
    }
  });
});

describe('isSortedByDate', () => {
  it('is true for a register that offers no sorting at all', () => {
    // Every surface but the Transactions page renders plain headers and takes
    // the server's default order, which is by date.
    expect(isSortedByDate(undefined)).toBe(true);
  });

  it('is true in either date direction and false for every other column', () => {
    expect(isSortedByDate({ field: 'date', direction: 'asc' })).toBe(true);
    expect(isSortedByDate({ field: 'date', direction: 'desc' })).toBe(true);
    for (const field of TRANSACTION_SORT_FIELDS.filter((f) => f !== 'date')) {
      expect(isSortedByDate({ field, direction: 'asc' })).toBe(false);
    }
  });
});
