import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@/test/render';
import { dailyBalanceTotalsKey, useDailyBalanceTotals } from './useDailyBalanceTotals';
import type { DailyBalanceTotalsResponse } from '@/types/account';

const mockGetDailyBalanceTotals = vi.fn();
vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getDailyBalanceTotals: (...args: unknown[]) => mockGetDailyBalanceTotals(...args),
  },
}));

function response(
  overrides: Partial<DailyBalanceTotalsResponse> = {},
): DailyBalanceTotalsResponse {
  return {
    startDate: '2026-05-31',
    endDate: '2026-07-04',
    today: '2026-06-15',
    currencyCode: 'CAD',
    days: [
      {
        date: '2026-06-15',
        total: 2600,
        knownSubtotal: 2600,
        isProjected: false,
        missingRatePairs: [],
      },
    ],
    forecast: { complete: true, gaps: [], unforecastableAccountIds: [] },
    scopeEmpty: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetDailyBalanceTotals.mockResolvedValue(response());
});

describe('dailyBalanceTotalsKey', () => {
  it('is one key for one question, whatever order the scope arrived in', () => {
    expect(dailyBalanceTotalsKey('2026-06-01', '2026-06-30', ['b', 'a'], 'CAD')).toBe(
      dailyBalanceTotalsKey('2026-06-01', '2026-06-30', ['a', 'b'], 'CAD'),
    );
  });

  it('separates two display currencies: the totals are reported in them', () => {
    expect(dailyBalanceTotalsKey('2026-06-01', '2026-06-30', ['a'], 'CAD')).not.toBe(
      dailyBalanceTotalsKey('2026-06-01', '2026-06-30', ['a'], 'USD'),
    );
  });
});

describe('useDailyBalanceTotals', () => {
  it('asks for the grid range with the scope as CSV ids', async () => {
    renderHook(() =>
      useDailyBalanceTotals({
        startDate: '2026-05-31',
        endDate: '2026-07-04',
        accountIds: ['chequing-1', 'savings-1'],
        enabled: true,
      }),
    );

    await waitFor(() => expect(mockGetDailyBalanceTotals).toHaveBeenCalled());
    expect(mockGetDailyBalanceTotals).toHaveBeenCalledWith({
      startDate: '2026-05-31',
      endDate: '2026-07-04',
      accountIds: 'chequing-1,savings-1',
      displayCurrency: undefined,
    });
  });

  it('sends no ids for an empty scope, which the endpoint reads as every active account', async () => {
    renderHook(() =>
      useDailyBalanceTotals({
        startDate: '2026-05-31',
        endDate: '2026-07-04',
        accountIds: [],
        enabled: true,
      }),
    );

    await waitFor(() => expect(mockGetDailyBalanceTotals).toHaveBeenCalled());
    expect(mockGetDailyBalanceTotals.mock.calls[0][0].accountIds).toBeUndefined();
  });

  it('asks nothing while the layer is off', async () => {
    const { result } = renderHook(() =>
      useDailyBalanceTotals({
        startDate: '2026-05-31',
        endDate: '2026-07-04',
        accountIds: ['chequing-1'],
        enabled: false,
      }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockGetDailyBalanceTotals).not.toHaveBeenCalled();
    expect(result.current.data).toBeNull();
    expect(result.current.byDay.size).toBe(0);
  });

  it('keys the days by date so a cell can read its own', async () => {
    renderHook(() =>
      useDailyBalanceTotals({
        startDate: '2026-05-31',
        endDate: '2026-07-04',
        accountIds: ['chequing-1'],
        enabled: true,
      }),
    );

    await waitFor(() => expect(mockGetDailyBalanceTotals).toHaveBeenCalled());
    const { result } = renderHook(() =>
      useDailyBalanceTotals({
        startDate: '2026-05-31',
        endDate: '2026-07-04',
        accountIds: ['chequing-1'],
        enabled: true,
      }),
    );
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.byDay.get('2026-06-15')?.total).toBe(2600);
  });

  it('marks the payload stale while the month it was asked for is no longer on screen', async () => {
    let resolveSecond: ((value: DailyBalanceTotalsResponse) => void) | undefined;
    mockGetDailyBalanceTotals
      .mockResolvedValueOnce(response())
      .mockImplementationOnce(
        () => new Promise<DailyBalanceTotalsResponse>((resolve) => { resolveSecond = resolve; }),
      );

    const { result, rerender } = renderHook(
      (props: { startDate: string; endDate: string }) =>
        useDailyBalanceTotals({
          startDate: props.startDate,
          endDate: props.endDate,
          accountIds: ['chequing-1'],
          enabled: true,
        }),
      { initialProps: { startDate: '2026-05-31', endDate: '2026-07-04' } },
    );

    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.isStale).toBe(false);

    rerender({ startDate: '2026-06-28', endDate: '2026-08-01' });
    await waitFor(() => expect(result.current.isStale).toBe(true));
    expect(resolveSecond).toBeDefined();
  });

  it('keeps a failed load a failure rather than an empty month', async () => {
    mockGetDailyBalanceTotals.mockRejectedValue(new Error('nope'));

    const { result } = renderHook(() =>
      useDailyBalanceTotals({
        startDate: '2026-05-31',
        endDate: '2026-07-04',
        accountIds: ['chequing-1'],
        enabled: true,
      }),
    );

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.data).toBeNull();
    expect(result.current.byDay.size).toBe(0);
  });

  it('asks again when the page reports a write, without changing the question', async () => {
    const { rerender } = renderHook(
      (props: { refreshKey: number }) =>
        useDailyBalanceTotals({
          startDate: '2026-05-31',
          endDate: '2026-07-04',
          accountIds: ['chequing-1'],
          enabled: true,
          refreshKey: props.refreshKey,
        }),
      { initialProps: { refreshKey: 0 } },
    );

    await waitFor(() => expect(mockGetDailyBalanceTotals).toHaveBeenCalledTimes(1));
    rerender({ refreshKey: 1 });
    await waitFor(() => expect(mockGetDailyBalanceTotals).toHaveBeenCalledTimes(2));
  });
});
