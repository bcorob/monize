import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StrictMode } from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useBrokerageFilterOptions } from './useBrokerageFilterOptions';
import { investmentsApi } from '@/lib/investments';

vi.mock('@/lib/investments', () => ({
  investmentsApi: { getRegisterFilterOptions: vi.fn() },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const getOptions = investmentsApi.getRegisterFilterOptions as ReturnType<typeof vi.fn>;

const OPTIONS = { actions: ['BUY', 'SELL'], symbols: ['VTI', 'XEQT'] };

describe('useBrokerageFilterOptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getOptions.mockResolvedValue(OPTIONS);
  });

  it('offers what the accounts on screen have traded', async () => {
    const { result } = renderHook(() => useBrokerageFilterOptions(['brok-1']));

    await waitFor(() => expect(result.current.actions).toEqual(['BUY', 'SELL']));
    expect(result.current.symbols).toEqual(['VTI', 'XEQT']);
    expect(getOptions).toHaveBeenCalledWith(['brok-1']);
  });

  it('still lands its options under a double-invoked effect', async () => {
    // React's development StrictMode mounts, unmounts and remounts, so a
    // cleanup flag that discards the response throws away the only request that
    // ever ran -- the second pass finds the key already claimed and starts
    // none. The picker then offers the full twenty-odd-action vocabulary for
    // the whole session, which is what dev showed while the tests were green.
    const { result } = renderHook(() => useBrokerageFilterOptions(['brok-1']), {
      wrapper: StrictMode,
    });

    await waitFor(() => expect(result.current.actions).toEqual(['BUY', 'SELL']));
  });

  it('asks again when the accounts change, and not on a bare re-render', async () => {
    const { rerender } = renderHook(
      ({ ids }: { ids: string[] }) => useBrokerageFilterOptions(ids),
      { initialProps: { ids: ['brok-1'] } },
    );
    await waitFor(() => expect(getOptions).toHaveBeenCalledTimes(1));

    rerender({ ids: ['brok-1'] });
    await act(async () => {});
    expect(getOptions).toHaveBeenCalledTimes(1);

    rerender({ ids: ['brok-1', 'brok-2'] });
    await waitFor(() => expect(getOptions).toHaveBeenCalledTimes(2));
  });

  it('drops an answer that a newer account selection has overtaken', async () => {
    // The first request resolves last; it describes a selection nobody is on.
    let resolveFirst!: (value: unknown) => void;
    getOptions.mockReturnValueOnce(new Promise((res) => { resolveFirst = res; }));
    getOptions.mockResolvedValue({ actions: ['SPLIT'], symbols: ['ZZZ'] });

    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) => useBrokerageFilterOptions(ids),
      { initialProps: { ids: ['brok-1'] } },
    );
    rerender({ ids: ['brok-2'] });
    await waitFor(() => expect(result.current.actions).toEqual(['SPLIT']));

    await act(async () => {
      resolveFirst(OPTIONS);
    });

    expect(result.current.actions).toEqual(['SPLIT']);
  });

  it('leaves a failed lookup retryable rather than reporting a traded-nothing account', async () => {
    getOptions.mockRejectedValueOnce(new Error('offline'));
    const { rerender } = renderHook(
      ({ ids }: { ids: string[] }) => useBrokerageFilterOptions(ids),
      { initialProps: { ids: ['brok-1'] } },
    );
    await waitFor(() => expect(getOptions).toHaveBeenCalledTimes(1));

    getOptions.mockResolvedValue(OPTIONS);
    rerender({ ids: ['brok-2'] });
    await waitFor(() => expect(getOptions).toHaveBeenCalledTimes(2));
  });
});
