import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useStaleReconciliation } from './useStaleReconciliation';

const mockGetStale = vi.fn();
vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getStaleUnreconciled: (...args: unknown[]) => mockGetStale(...args),
  },
}));

const summary = {
  staleAfterDays: 45,
  overdueBefore: '2026-07-04',
  totalCount: 3,
  accounts: [
    {
      accountId: 'acc-1',
      accountName: 'Checking',
      currencyCode: 'USD',
      count: 3,
      oldestDate: '2026-01-15',
      lastReconciledDate: '2026-06-30',
      missedCount: 2,
      overdueCount: 1,
    },
  ],
};

describe('useStaleReconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStale.mockResolvedValue(summary);
  });

  it('is undefined before the answer arrives', async () => {
    const { result } = renderHook(() => useStaleReconciliation());
    expect(result.current).toBeUndefined();
    // The request is still in flight. Let it land here rather than committing
    // into whatever tree is mounted when the microtask finally runs.
    await waitFor(() => expect(result.current).toBeDefined());
  });

  it('indexes the last reconciled date by account', async () => {
    const { result } = renderHook(() => useStaleReconciliation());
    await waitFor(() => expect(result.current).toBeDefined());
    expect(result.current!.lastReconciledByAccount.get('acc-1')).toBe('2026-06-30');
    expect(result.current!.overdueBefore).toBe('2026-07-04');
  });

  it('leaves an account with nothing outstanding out of the map', async () => {
    const { result } = renderHook(() => useStaleReconciliation());
    await waitFor(() => expect(result.current).toBeDefined());
    expect(result.current!.lastReconciledByAccount.has('acc-2')).toBe(false);
  });

  it('stays undefined when the lookup fails', async () => {
    // A failed request is not a clean ledger. Returning an empty context would
    // silently stop the register highlighting anything, which is
    // indistinguishable from being up to date.
    mockGetStale.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useStaleReconciliation());
    await waitFor(() => expect(mockGetStale).toHaveBeenCalled());
    expect(result.current).toBeUndefined();
  });

  it('survives an API surface that throws synchronously', async () => {
    // The register mounts this hook, so a lookup that fails *before* returning
    // a promise -- an older client bundle without the method, a stubbed API in
    // a test -- would escape a `.catch()` on the result and take the whole page
    // down with it. Undefined is the same answer as any other failure.
    mockGetStale.mockImplementation(() => {
      throw new TypeError('transactionsApi.getStaleUnreconciled is not a function');
    });
    const { result } = renderHook(() => useStaleReconciliation());
    await waitFor(() => expect(mockGetStale).toHaveBeenCalled());
    expect(result.current).toBeUndefined();
  });

  it('asks once per mount', async () => {
    const { result, rerender } = renderHook(() => useStaleReconciliation());
    await waitFor(() => expect(result.current).toBeDefined());
    rerender();
    rerender();
    expect(mockGetStale).toHaveBeenCalledTimes(1);
  });
});
