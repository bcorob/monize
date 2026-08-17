import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useLoanProjection } from './useLoanProjection';
import type { Account } from '@/types/account';
import type { Transaction } from '@/types/transaction';

const getAllPages = vi.fn();
const getAll = vi.fn();
vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getAll: (...args: unknown[]) => getAll(...args),
    getAllPages: (...args: unknown[]) => getAllPages(...args),
  },
}));

const getRateChanges = vi.fn();
vi.mock('@/lib/loan-rate-changes', () => ({
  loanRateChangesApi: {
    getAll: (...args: unknown[]) => getRateChanges(...args),
  },
}));

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'mtg-1',
    accountType: 'MORTGAGE',
    name: 'Home Mortgage',
    currencyCode: 'CAD',
    openingBalance: -300000,
    currentBalance: -250000,
    interestRate: 5,
    paymentAmount: 1800,
    paymentFrequency: 'MONTHLY',
    isCanadianMortgage: false,
    isVariableRate: false,
    interestCategoryId: null,
    sourceAccountId: null,
    ...overrides,
  } as Account;
}

/** A repayment posted against the loan account (positive on a debt account). */
function payment(id: string, date: string, amount: number): Transaction {
  return { id, transactionDate: date, amount } as Transaction;
}

function pageOf(data: Transaction[]) {
  return { data, pagination: { hasMore: false } };
}

beforeEach(() => {
  vi.clearAllMocks();
  getAll.mockResolvedValue(pageOf([]));
  getAllPages.mockResolvedValue([]);
  getRateChanges.mockResolvedValue([]);
});

describe('useLoanProjection', () => {
  it('is idle and fetches nothing for an account type that does not amortize', () => {
    const { result } = renderHook(() =>
      useLoanProjection(makeAccount({ accountType: 'CHEQUING' })),
    );
    expect(result.current.status).toBe('idle');
    expect(result.current.currentPayment).toBeNull();
    expect(result.current.payoffDate).toBeNull();
    expect(result.current.remainingInterest).toBeNull();
    expect(getAll).not.toHaveBeenCalled();
    expect(getRateChanges).not.toHaveBeenCalled();
  });

  it('starts as loading with every figure unknown', async () => {
    const { result } = renderHook(() => useLoanProjection(makeAccount()));
    expect(result.current.status).toBe('loading');
    expect(result.current.currentPayment).toBeNull();
    expect(result.current.payoffDate).toBeNull();
    expect(result.current.remainingInterest).toBeNull();
    // Drain the in-flight load so its state update lands inside the test.
    await waitFor(() => expect(result.current.status).toBe('ready'));
  });

  it('derives the payment, payoff date and remaining interest from the history', async () => {
    getAll.mockResolvedValue(
      pageOf([
        payment('t1', '2026-05-15', 1800),
        payment('t2', '2026-06-15', 1800),
        payment('t3', '2026-07-15', 1800),
      ]),
    );
    const { result } = renderHook(() => useLoanProjection(makeAccount()));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.currentPayment).toBeGreaterThan(0);
    expect(result.current.payoffDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.current.remainingInterest).toBeGreaterThan(0);
    expect(result.current.isSettled).toBe(false);
  });

  // A failed history load is not an empty history: projecting from no payments
  // at all would put a plausible payoff date on screen with nothing behind it.
  it('reports a failed load as unknown rather than as an empty history', async () => {
    getAll.mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useLoanProjection(makeAccount()));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.currentPayment).toBeNull();
    expect(result.current.payoffDate).toBeNull();
    expect(result.current.remainingInterest).toBeNull();
  });

  it('reports a failed rate-history load as unknown too', async () => {
    getRateChanges.mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useLoanProjection(makeAccount()));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.remainingInterest).toBeNull();
  });

  it('reports a settled mortgage as paid off with no interest remaining', async () => {
    const { result } = renderHook(() =>
      useLoanProjection(makeAccount({ currentBalance: 0 })),
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.isSettled).toBe(true);
    expect(result.current.remainingInterest).toBe(0);
    expect(result.current.payoffDate).toBeNull();
  });

  // The payload is stamped with the account it answers for, so the previously
  // selected loan's figures never stand in for the newly selected one.
  it('does not show the previous account answer under a newly selected account', async () => {
    getAll.mockResolvedValue(pageOf([payment('t1', '2026-06-15', 1800)]));
    const { result, rerender } = renderHook(
      ({ account }: { account: Account }) => useLoanProjection(account),
      { initialProps: { account: makeAccount() } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    // Never resolve the second account's history: its figures must be unknown,
    // not the first account's.
    getAll.mockReturnValue(new Promise(() => {}));
    rerender({ account: makeAccount({ id: 'mtg-2', currentBalance: -99000 }) });

    expect(result.current.status).toBe('loading');
    expect(result.current.payoffDate).toBeNull();
    expect(result.current.remainingInterest).toBeNull();
  });

  it('refetches when the refresh key is bumped', async () => {
    const { result, rerender } = renderHook(
      ({ refreshKey }: { refreshKey: number }) =>
        useLoanProjection(makeAccount(), refreshKey),
      { initialProps: { refreshKey: 0 } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(getAll).toHaveBeenCalledTimes(1);

    rerender({ refreshKey: 1 });
    await waitFor(() => expect(getAll).toHaveBeenCalledTimes(2));
  });
});
