import { describe, it, expect } from 'vitest';
import { classifyStaleRow } from './stale-reconciliation';
import { TransactionStatus } from '@/types/transaction';

const LAST_RECONCILED = '2026-06-30';
const OVERDUE_BEFORE = '2026-07-04';

describe('classifyStaleRow', () => {
  it('calls a row dated on the last reconciled date missed', () => {
    expect(
      classifyStaleRow(
        TransactionStatus.CLEARED,
        LAST_RECONCILED,
        LAST_RECONCILED,
        OVERDUE_BEFORE,
      ),
    ).toBe('missed');
  });

  it('prefers missed over overdue when a row satisfies both', () => {
    // Counting a row under both reasons would make the two lines in the
    // reminder add up to more than the badge.
    expect(
      classifyStaleRow(
        TransactionStatus.UNRECONCILED,
        '2026-01-01',
        LAST_RECONCILED,
        OVERDUE_BEFORE,
      ),
    ).toBe('missed');
  });

  it('calls a row after the statement but before the cutoff overdue', () => {
    expect(
      classifyStaleRow(
        TransactionStatus.UNRECONCILED,
        '2026-07-03',
        LAST_RECONCILED,
        OVERDUE_BEFORE,
      ),
    ).toBe('overdue');
  });

  it('leaves a row on the cutoff alone', () => {
    expect(
      classifyStaleRow(
        TransactionStatus.UNRECONCILED,
        OVERDUE_BEFORE,
        LAST_RECONCILED,
        OVERDUE_BEFORE,
      ),
    ).toBeNull();
  });

  it('marks nothing in an account that has never been reconciled', () => {
    // Reconciliation is opt-in. A user who has never reconciled must not be
    // told their whole history is overdue.
    expect(
      classifyStaleRow(
        TransactionStatus.UNRECONCILED,
        '2019-01-01',
        null,
        OVERDUE_BEFORE,
      ),
    ).toBeNull();
  });

  it.each([TransactionStatus.RECONCILED, TransactionStatus.VOID])(
    'marks nothing for a %s row',
    (status) => {
      expect(
        classifyStaleRow(status, '2019-01-01', LAST_RECONCILED, OVERDUE_BEFORE),
      ).toBeNull();
    },
  );

  it('compares dates as strings, so no timezone can move a boundary', () => {
    // A Date built from '2026-07-04' is midnight UTC; west of Greenwich that
    // is 3 July locally, which would flip this row's answer.
    expect(
      classifyStaleRow(
        TransactionStatus.UNRECONCILED,
        '2026-07-04',
        LAST_RECONCILED,
        '2026-07-04',
      ),
    ).toBeNull();
  });
});
