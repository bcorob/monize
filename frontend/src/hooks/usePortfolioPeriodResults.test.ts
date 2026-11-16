import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@/test/render';
import { usePortfolioPeriodResults } from './usePortfolioPeriodResults';
import { netWorthApi } from '@/lib/net-worth';
import type { PortfolioPeriodResults } from '@/types/net-worth';

vi.mock('@/lib/net-worth', () => ({
  netWorthApi: { getInvestmentsPeriodResults: vi.fn() },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

function results(currency = 'CAD'): PortfolioPeriodResults {
  return {
    currency,
    asOf: '2026-09-17',
    periods: {
      '1m': {
        currency,
        startDate: '2026-08-18',
        endDate: '2026-09-17',
        startValue: 10000,
        endValue: 10200,
        valueChange: 200,
        netExternalFlows: 0,
        knownFlowSubtotal: 0,
        investmentResult: 200,
        returnPercent: 2,
        returnMethod: 'simple',
        complete: true,
        reasons: [],
        missingRatePairs: [],
        unpricedSecurityIds: [],
        unknownCashAccountIds: [],
      },
    },
  };
}

const api = vi.mocked(netWorthApi.getInvestmentsPeriodResults);

describe('usePortfolioPeriodResults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.mockResolvedValue(results());
  });

  it('asks for the presets, the accounts and the currency it was given', async () => {
    const { result } = renderHook(() =>
      usePortfolioPeriodResults({
        periods: '1d,1m',
        accountIds: 'acc-1',
        displayCurrency: 'USD',
      }),
    );

    await waitFor(() => expect(result.current.results).not.toBeNull());
    expect(api).toHaveBeenCalledWith({
      periods: '1d,1m',
      accountIds: 'acc-1',
      displayCurrency: 'USD',
    });
  });

  it('asks again when the reload key is bumped', async () => {
    const { result, rerender } = renderHook(
      ({ reloadKey }: { reloadKey: number }) =>
        usePortfolioPeriodResults({ reloadKey }),
      { initialProps: { reloadKey: 0 } },
    );

    await waitFor(() => expect(result.current.results).not.toBeNull());
    rerender({ reloadKey: 1 });

    await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  });

  // A price refresh or a write moves the reload key; the card kept its rows
  // only until then and fell to its loading notice for the whole reload.
  it('keeps the previous answer while a reload of the same scope is in flight', async () => {
    const { result, rerender } = renderHook(
      ({ reloadKey }: { reloadKey: number }) =>
        usePortfolioPeriodResults({ reloadKey }),
      { initialProps: { reloadKey: 0 } },
    );
    await waitFor(() => expect(result.current.results).not.toBeNull());

    let release: (value: PortfolioPeriodResults) => void = () => {};
    api.mockReturnValueOnce(
      new Promise<PortfolioPeriodResults>((resolve) => {
        release = resolve;
      }),
    );
    rerender({ reloadKey: 1 });

    expect(result.current.status).toBe('ready');
    expect(result.current.results?.currency).toBe('CAD');
    release(results('USD'));
    await waitFor(() => expect(result.current.results?.currency).toBe('USD'));
  });

  it('reports a failed reload as failed, not as the previous answer', async () => {
    const { result, rerender } = renderHook(
      ({ reloadKey }: { reloadKey: number }) =>
        usePortfolioPeriodResults({ reloadKey }),
      { initialProps: { reloadKey: 0 } },
    );
    await waitFor(() => expect(result.current.results).not.toBeNull());

    api.mockRejectedValueOnce(new Error('timeout'));
    rerender({ reloadKey: 1 });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.results).toBeNull();
  });

  it('shows nothing under a key it has no answer for', async () => {
    const { result, rerender } = renderHook(
      ({ accountIds }: { accountIds?: string }) =>
        usePortfolioPeriodResults({ accountIds }),
      { initialProps: { accountIds: undefined as string | undefined } },
    );
    await waitFor(() => expect(result.current.results).not.toBeNull());

    // The previous scope's figures must not sit under the new scope's caption.
    let release: (value: PortfolioPeriodResults) => void = () => {};
    api.mockReturnValueOnce(
      new Promise<PortfolioPeriodResults>((resolve) => {
        release = resolve;
      }),
    );
    rerender({ accountIds: 'acc-9' });

    expect(result.current.results).toBeNull();
    release(results('USD'));
    await waitFor(() => expect(result.current.results?.currency).toBe('USD'));
  });

  /** A failed request is not a portfolio that earned nothing. */
  it('leaves every period unknown when the request fails', async () => {
    api.mockRejectedValueOnce(new Error('nope'));

    const { result } = renderHook(() => usePortfolioPeriodResults());

    await waitFor(() => expect(api).toHaveBeenCalled());
    expect(result.current.results).toBeNull();
  });

  // The page owns the request and hands its answer down (#1888).
  it('asks nothing when skipped', () => {
    const { result } = renderHook(() => usePortfolioPeriodResults({ skip: true }));

    expect(api).not.toHaveBeenCalled();
    expect(result.current.results).toBeNull();
  });
});
