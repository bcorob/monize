import { describe, it, expect } from 'vitest';
import { Transaction, TransactionStatus } from '@/types/transaction';
import {
  groupReconcileRows,
  sortReconcileRows,
  sumAmounts,
  transactionFlow,
} from './reconcile-rows';

/**
 * `decimal(20,4)` crosses the wire as a *string* -- `types/transaction.ts`
 * declares `amount: number` and the running app never sees one. Every fixture
 * here uses the shape the API sends, because a helper that coerces is
 * indistinguishable from one that does not when the fixture is already numeric.
 */
function row(overrides: Partial<Transaction> & { id: string }): Transaction {
  return {
    transactionDate: '2026-02-01',
    amount: '0.0000' as unknown as number,
    status: TransactionStatus.UNRECONCILED,
    payee: null,
    payeeName: null,
    category: null,
    ...overrides,
  } as Transaction;
}

describe('transactionFlow', () => {
  it('reads a decimal string, not just a number', () => {
    expect(transactionFlow('-67.9900' as unknown as number)).toBe('debit');
    expect(transactionFlow('67.9900' as unknown as number)).toBe('credit');
  });

  it('files exactly zero with the credits, like the amount colour does', () => {
    // The colour test beside it is `Number(amount) >= 0`. A grouping that
    // disagreed would print a green figure under "Money out".
    expect(transactionFlow(0)).toBe('credit');
  });
});

describe('sumAmounts', () => {
  it('sums decimal strings', () => {
    const total = sumAmounts([
      row({ id: 'a', amount: '-50.2500' as unknown as number }),
      row({ id: 'b', amount: '3000.0000' as unknown as number }),
    ]);
    expect(total).toBe(2949.75);
  });

  it('does not drift over many rows a float reduce would', () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point, and a statement is a long
    // list of exactly this kind of value.
    const rows = Array.from({ length: 10 }, (_, i) =>
      row({ id: `r${i}`, amount: '0.1000' as unknown as number }),
    );
    expect(sumAmounts(rows)).toBe(1);
  });

  it('is zero for no rows', () => {
    // An empty selection has moved nothing, which is a known zero rather than
    // an unknown: the difference figure beside it must stay a number.
    expect(sumAmounts([])).toBe(0);
  });
});

describe('sortReconcileRows', () => {
  const rows = [
    row({ id: 'c', transactionDate: '2026-02-10', amount: '-120.5000' as unknown as number, payeeName: 'Electric Co' }),
    row({ id: 'a', transactionDate: '2026-02-01', amount: '-50.2500' as unknown as number, payeeName: 'Grocery' }),
    row({ id: 'b', transactionDate: '2026-02-05', amount: '3000.0000' as unknown as number, payeeName: 'Salary' }),
  ];

  it('orders by date ascending', () => {
    expect(sortReconcileRows(rows, 'date', 'asc').map((r) => r.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('reverses on descending', () => {
    expect(sortReconcileRows(rows, 'date', 'desc').map((r) => r.id)).toEqual([
      'c',
      'b',
      'a',
    ]);
  });

  it('orders amounts numerically, not lexicographically', () => {
    // '-50.2500' < '-120.5000' as strings; as money it is the other way round.
    expect(sortReconcileRows(rows, 'amount', 'asc').map((r) => r.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('orders by payee, falling back to the free-text name', () => {
    const mixed = [
      row({ id: 'x', payee: { name: 'Zeta' } as Transaction['payee'] }),
      row({ id: 'y', payeeName: 'Alpha' }),
    ];
    expect(sortReconcileRows(mixed, 'payee', 'asc').map((r) => r.id)).toEqual([
      'y',
      'x',
    ]);
  });

  it('orders statuses by meaning rather than by spelling', () => {
    // Alphabetically CLEARED precedes UNRECONCILED, which would put settled
    // rows above the ones still needing attention.
    const byStatus = [
      row({ id: 'cleared', status: TransactionStatus.CLEARED }),
      row({ id: 'pending', status: TransactionStatus.UNRECONCILED }),
    ];
    expect(
      sortReconcileRows(byStatus, 'status', 'asc').map((r) => r.id),
    ).toEqual(['pending', 'cleared']);
  });

  it('breaks a tie deterministically instead of leaving input order', () => {
    // Rows written by one import share a created_at (PostgreSQL's
    // CURRENT_TIMESTAMP is transaction start time), so without a final
    // tiebreak the same day renders in whatever order the array arrived in and
    // a row appears to jump when the list is refetched after an edit.
    const sameDay = [
      row({ id: 'zzz', amount: '-10.0000' as unknown as number }),
      row({ id: 'aaa', amount: '-10.0000' as unknown as number }),
    ];
    expect(sortReconcileRows(sameDay, 'date', 'asc').map((r) => r.id)).toEqual([
      'aaa',
      'zzz',
    ]);
    expect(
      sortReconcileRows([...sameDay].reverse(), 'date', 'asc').map((r) => r.id),
    ).toEqual(['aaa', 'zzz']);
  });

  it('puts a credit before a debit on the same day', () => {
    const sameDay = [
      row({ id: 'debit', amount: '-10.0000' as unknown as number }),
      row({ id: 'credit', amount: '10.0000' as unknown as number }),
    ];
    expect(sortReconcileRows(sameDay, 'date', 'asc').map((r) => r.id)).toEqual([
      'credit',
      'debit',
    ]);
  });

  it('does not mutate the array it was given', () => {
    const original = [...rows];
    sortReconcileRows(rows, 'amount', 'desc');
    expect(rows).toEqual(original);
  });
});

describe('groupReconcileRows', () => {
  const rows = [
    row({ id: 'in', amount: '3000.0000' as unknown as number }),
    row({ id: 'out1', amount: '-50.2500' as unknown as number }),
    row({ id: 'out2', amount: '-120.5000' as unknown as number }),
  ];

  it('returns one unnamed group when grouping is off', () => {
    const groups = groupReconcileRows(rows, false);
    expect(groups).toHaveLength(1);
    expect(groups[0].flow).toBeNull();
    expect(groups[0].rows.map((r) => r.id)).toEqual(['in', 'out1', 'out2']);
    expect(groups[0].subtotal).toBe(2829.25);
  });

  it('splits into credits then debits, each with its own subtotal', () => {
    const groups = groupReconcileRows(rows, true);
    expect(groups.map((g) => g.flow)).toEqual(['credit', 'debit']);
    expect(groups[0].subtotal).toBe(3000);
    expect(groups[1].subtotal).toBe(-170.75);
  });

  it('preserves the order within each group', () => {
    const groups = groupReconcileRows(rows, true);
    expect(groups[1].rows.map((r) => r.id)).toEqual(['out1', 'out2']);
  });

  it('omits a group with no rows rather than drawing it empty', () => {
    // "Money out (0)" over a blank strip reads as a rendering fault.
    const groups = groupReconcileRows([rows[0]], true);
    expect(groups.map((g) => g.flow)).toEqual(['credit']);
  });

  it('returns no groups at all for no rows', () => {
    expect(groupReconcileRows([], true)).toEqual([]);
  });
});
