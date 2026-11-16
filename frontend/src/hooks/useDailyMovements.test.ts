import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@/test/render';
import { dailyMovementsKey, useDailyMovements } from './useDailyMovements';
import type { DailyMovementsResponse } from '@/types/investment';

const mockGetDailyMovements = vi.fn();
vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getDailyMovements: (...args: unknown[]) => mockGetDailyMovements(...args),
  },
}));

const TODAY = '2026-06-15';

function response(overrides: Partial<DailyMovementsResponse> = {}): DailyMovementsResponse {
  return {
    currencyCode: 'CAD',
    today: TODAY,
    days: [
      {
        date: '2026-06-11',
        isTradingDay: true,
        movement: 200,
        movementPercent: 0.2,
        complete: true,
        reasons: [],
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetDailyMovements.mockResolvedValue(response());
});

describe('dailyMovementsKey', () => {
  it('is one key for one question, whatever order the scope arrived in', () => {
    expect(dailyMovementsKey('2026-06-01', '2026-06-30', ['b', 'a'], undefined)).toBe(
      dailyMovementsKey('2026-06-01', '2026-06-30', ['a', 'b'], undefined),
    );
  });
});

describe('useDailyMovements', () => {
  it('stops the range at today: nothing after it is evaluated', async () => {
    renderHook(() =>
      useDailyMovements({
        startDate: '2026-05-31',
        endDate: '2026-07-04',
        today: TODAY,
        accountIds: ['brokerage-1'],
        enabled: true,
      }),
    );

    await waitFor(() => expect(mockGetDailyMovements).toHaveBeenCalled());
    expect(mockGetDailyMovements).toHaveBeenCalledWith({
      startDate: '2026-05-31',
      endDate: TODAY,
      accountIds: 'brokerage-1',
      displayCurrency: undefined,
    });
  });

  it('asks nothing for a grid that lies entirely after today', async () => {
    const { result } = renderHook(() =>
      useDailyMovements({
        startDate: '2026-07-01',
        endDate: '2026-08-01',
        today: TODAY,
        accountIds: ['brokerage-1'],
        enabled: true,
      }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockGetDailyMovements).not.toHaveBeenCalled();
    expect(result.current.byDay.size).toBe(0);
  });

  it('asks nothing while the layer is off', async () => {
    const { result } = renderHook(() =>
      useDailyMovements({
        startDate: '2026-05-31',
        endDate: '2026-06-30',
        today: TODAY,
        accountIds: [],
        enabled: false,
      }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockGetDailyMovements).not.toHaveBeenCalled();
  });

  it('keys the days by date and carries the reporting currency', async () => {
    const { result } = renderHook(() =>
      useDailyMovements({
        startDate: '2026-05-31',
        endDate: '2026-06-30',
        today: TODAY,
        accountIds: ['brokerage-1'],
        enabled: true,
      }),
    );

    await waitFor(() => expect(result.current.currencyCode).toBe('CAD'));
    expect(result.current.byDay.get('2026-06-11')?.movementPercent).toBe(0.2);
  });

  it('keeps a failed load a failure rather than a month of blank days', async () => {
    mockGetDailyMovements.mockRejectedValue(new Error('offline'));

    const { result } = renderHook(() =>
      useDailyMovements({
        startDate: '2026-05-31',
        endDate: '2026-06-30',
        today: TODAY,
        accountIds: ['brokerage-1'],
        enabled: true,
      }),
    );

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.byDay.size).toBe(0);
    expect(result.current.currencyCode).toBeNull();
  });
});
