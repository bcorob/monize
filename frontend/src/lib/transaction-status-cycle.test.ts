import { describe, it, expect } from 'vitest';
import { TransactionStatus } from '@/types/transaction';
import {
  STATUS_CYCLE_ORDER,
  nextCycleStatus,
} from './transaction-status-cycle';

describe('transaction-status-cycle', () => {
  it('cycles UNRECONCILED -> CLEARED -> RECONCILED -> UNRECONCILED', () => {
    expect(nextCycleStatus(TransactionStatus.UNRECONCILED)).toBe(
      TransactionStatus.CLEARED,
    );
    expect(nextCycleStatus(TransactionStatus.CLEARED)).toBe(
      TransactionStatus.RECONCILED,
    );
    expect(nextCycleStatus(TransactionStatus.RECONCILED)).toBe(
      TransactionStatus.UNRECONCILED,
    );
  });

  it('returns null for VOID -- voiding is only reachable through the form', () => {
    expect(nextCycleStatus(TransactionStatus.VOID)).toBeNull();
  });

  it('never cycles into VOID', () => {
    expect(STATUS_CYCLE_ORDER).not.toContain(TransactionStatus.VOID);
    for (const status of STATUS_CYCLE_ORDER) {
      expect(nextCycleStatus(status)).not.toBe(TransactionStatus.VOID);
      expect(nextCycleStatus(status)).not.toBeNull();
    }
  });

  it('walking the cycle from UNRECONCILED visits every member exactly once before wrapping', () => {
    const visited: TransactionStatus[] = [];
    let current: TransactionStatus = TransactionStatus.UNRECONCILED;
    for (let i = 0; i < STATUS_CYCLE_ORDER.length; i++) {
      visited.push(current);
      const next = nextCycleStatus(current);
      expect(next).not.toBeNull();
      current = next!;
    }
    expect(visited).toEqual([...STATUS_CYCLE_ORDER]);
    // Wrapped back to the start.
    expect(current).toBe(TransactionStatus.UNRECONCILED);
  });
});
