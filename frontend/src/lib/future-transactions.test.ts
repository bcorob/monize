import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  futureTransactionsStartDate,
  loadFutureTransactions,
  toFutureTransactions,
} from './future-transactions';
import type { Transaction } from '@/types/transaction';

const mockGetAll = vi.fn();
vi.mock('@/lib/transactions', () => ({
  transactionsApi: { getAll: (...a: unknown[]) => mockGetAll(...a) },
}));

const row = (overrides: Partial<Transaction>): Transaction =>
  ({
    id: 'tx-1',
    accountId: 'acc-1',
    payeeName: null,
    payee: null,
    description: null,
    amount: '-25.5000',
    status: 'UNRECONCILED',
    transactionDate: '2026-10-25T00:00:00.000Z',
    ...overrides,
  }) as unknown as Transaction;

describe('future-transactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts the day after today, in local time', () => {
    expect(futureTransactionsStartDate(new Date(2026, 11, 31, 23, 30))).toBe('2027-01-01');
  });

  it('drops VOID rows and names each row by payee, then description, then the fallback', () => {
    const result = toFutureTransactions(
      [
        row({ id: 'a', payeeName: 'Landlord' }),
        row({ id: 'b', payee: { name: 'Hydro' } as Transaction['payee'] }),
        row({ id: 'c', description: 'Gift' }),
        row({ id: 'd' }),
        row({ id: 'e', payeeName: 'Voided', status: 'VOID' as Transaction['status'] }),
      ],
      'Transaction',
    );
    expect(result.map((t) => [t.id, t.name])).toEqual([
      ['a', 'Landlord'],
      ['b', 'Hydro'],
      ['c', 'Gift'],
      ['d', 'Transaction'],
    ]);
    expect(result[0]).toEqual({
      id: 'a',
      accountId: 'acc-1',
      name: 'Landlord',
      amount: -25.5,
      date: '2026-10-25',
    });
  });

  it('loads up to 200 rows dated from tomorrow', async () => {
    mockGetAll.mockResolvedValue({ data: [row({ id: 'a', payeeName: 'Landlord' })] });
    const result = await loadFutureTransactions('Transaction');
    expect(mockGetAll).toHaveBeenCalledWith({
      startDate: futureTransactionsStartDate(),
      limit: 200,
    });
    expect(result).toHaveLength(1);
  });
});
